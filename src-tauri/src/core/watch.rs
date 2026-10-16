//! Surveillance des modifications externes (`notify`) → événement `file-changed`.
//! On surveille le dossier parent : l'écriture atomique remplace l'inode du fichier.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::{AppError, Result};

/// Fenêtre pendant laquelle les événements suivant une écriture de l'app sont ignorés.
pub const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

/// Empreinte légère d'un fichier (taille + date de modification) ; `None` si absent.
type Fingerprint = Option<(u64, std::time::SystemTime)>;

fn fingerprint(path: &Path) -> Fingerprint {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// Écritures de l'application sur un chemin : horodatage, nombre de notifications (avant/après
/// l'écriture) et empreintes observées. Un événement n'est ignoré que dans la fenêtre ET si
/// l'état actuel du fichier est celui écrit par l'application (sinon c'est une vraie modification
/// externe survenue pendant la fenêtre).
#[derive(Default)]
struct Mark {
    at: Option<Instant>,
    count: u32,
    fps: Vec<Fingerprint>,
}

impl Mark {
    fn record(&mut self, path: &Path, now: Instant) {
        self.at = Some(now);
        self.count += 1;
        let fp = fingerprint(path);
        if !self.fps.contains(&fp) {
            self.fps.push(fp);
        }
    }

    fn expired(&self, now: Instant) -> bool {
        self.at
            .is_none_or(|t| now.saturating_duration_since(t) > SELF_WRITE_WINDOW)
    }

    /// Vrai si l'événement sur `path` provient de l'application.
    fn covers(&self, path: &Path) -> bool {
        // Écriture en cours (notification « avant » sans « après ») : on ignore.
        self.count % 2 == 1 || self.fps.contains(&fingerprint(path))
    }
}

type Marks = HashMap<PathBuf, Mark>;

fn note(map: &mut Marks, path: &Path, now: Instant) {
    let key = normalize(path);
    let mark = map.entry(key).or_default();
    if mark.expired(now) {
        *mark = Mark::default();
    }
    mark.record(path, now);
}

/// Écritures faites par l'application hors `save_document` (commandes `image_save`, `pdf_*`,
/// `archive_*`…) : enregistrées par `core::atomic` pour que le watcher les ignore aussi.
static APP_WRITES: Mutex<Option<Marks>> = Mutex::new(None);

/// À appeler lors d'une écriture de l'application sur `path` (sans accès au `FileWatcher`).
pub fn note_app_write(path: &Path) {
    note(
        lock(&APP_WRITES).get_or_insert_with(HashMap::new),
        path,
        Instant::now(),
    );
}

fn is_recent_app_write(path: &Path, now: Instant) -> bool {
    let mut guard = lock(&APP_WRITES);
    let Some(map) = guard.as_mut() else {
        return false;
    };
    map.retain(|_, m| !m.expired(now));
    map.get(path).is_some_and(|m| m.covers(path))
}

#[derive(Default)]
struct Shared {
    files: HashSet<PathBuf>,
    self_writes: Marks,
}

impl Shared {
    /// Renvoie le fichier surveillé concerné par un événement, sauf écriture de l'app.
    fn filter(&mut self, event_path: &Path, now: Instant) -> Option<PathBuf> {
        let path = normalize(event_path);
        if !self.files.contains(&path) {
            return None;
        }
        self.self_writes.retain(|_, m| !m.expired(now));
        if self.self_writes.get(&path).is_some_and(|m| m.covers(&path))
            || is_recent_app_write(&path, now)
        {
            return None;
        }
        Some(path)
    }
}

/// Chemin comparable : dossier parent canonique + nom (le fichier peut ne plus exister).
fn normalize(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
            std::fs::canonicalize(parent)
                .unwrap_or_else(|_| parent.to_path_buf())
                .join(name)
        }
        _ => path.to_path_buf(),
    }
}

pub struct FileWatcher {
    watcher: Mutex<RecommendedWatcher>,
    shared: Arc<Mutex<Shared>>,
    dirs: Mutex<HashMap<PathBuf, usize>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl FileWatcher {
    /// `on_change` reçoit le chemin d'un fichier surveillé modifié par un tiers.
    pub fn new(on_change: impl Fn(&Path) + Send + 'static) -> Result<Self> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let cb_shared = Arc::clone(&shared);
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                return;
            }
            let now = Instant::now();
            for p in &event.paths {
                let hit = lock(&cb_shared).filter(p, now);
                if let Some(path) = hit {
                    on_change(&path);
                }
            }
        })
        .map_err(|e| AppError::External(e.to_string()))?;
        Ok(FileWatcher {
            watcher: Mutex::new(watcher),
            shared,
            dirs: Mutex::new(HashMap::new()),
        })
    }

    pub fn watch(&self, path: &Path) -> Result<()> {
        let path = normalize(path);
        let Some(parent) = path.parent().map(Path::to_path_buf) else {
            return Err(AppError::NotFound);
        };
        if !lock(&self.shared).files.insert(path) {
            return Ok(());
        }
        let mut dirs = lock(&self.dirs);
        let count = dirs.entry(parent.clone()).or_insert(0);
        if *count == 0 {
            lock(&self.watcher)
                .watch(&parent, RecursiveMode::NonRecursive)
                .map_err(|e| AppError::External(e.to_string()))?;
        }
        *count += 1;
        Ok(())
    }

    pub fn unwatch(&self, path: &Path) -> Result<()> {
        let path = normalize(path);
        if !lock(&self.shared).files.remove(&path) {
            return Ok(());
        }
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        let mut dirs = lock(&self.dirs);
        if let Some(count) = dirs.get_mut(parent) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                dirs.remove(parent);
                // Le dossier a pu disparaître : erreur sans importance.
                let _ = lock(&self.watcher).unwatch(parent);
            }
        }
        Ok(())
    }

    /// À appeler lors d'une écriture de l'application sur `path`.
    pub fn mark_self_write(&self, path: &Path) {
        note(&mut lock(&self.shared).self_writes, path, Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn filter_ignores_unwatched_and_self_writes() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        let mut s = Shared::default();
        let now = Instant::now();
        assert!(s.filter(&f, now).is_none()); // non surveillé
        s.files.insert(normalize(&f));
        assert!(s.filter(&f, now).is_some());
        note(&mut s.self_writes, &f, now);
        note(&mut s.self_writes, &f, now);
        assert!(s.filter(&f, now + Duration::from_millis(500)).is_none());
        // fenêtre expirée
        assert!(s.filter(&f, now + Duration::from_secs(3)).is_some());
        assert!(s.self_writes.is_empty());
    }

    #[test]
    fn external_change_inside_window_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("c.txt");
        let mut s = Shared::default();
        s.files.insert(normalize(&f));
        std::fs::write(&f, "app").unwrap();
        let now = Instant::now();
        note(&mut s.self_writes, &f, now);
        note(&mut s.self_writes, &f, now);
        assert!(s.filter(&f, now).is_none());
        // modification externe (taille différente) dans la fenêtre
        std::fs::write(&f, "externe plus long").unwrap();
        assert!(s.filter(&f, now).is_some());
    }

    #[test]
    fn filter_ignores_app_writes_from_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("b.txt");
        let mut s = Shared::default();
        s.files.insert(normalize(&f));
        crate::core::atomic::write_atomic(&f, b"x", None).unwrap();
        assert!(s.filter(&f, Instant::now()).is_none());
        assert!(s
            .filter(&f, Instant::now() + SELF_WRITE_WINDOW * 2)
            .is_some());
    }

    #[test]
    fn watch_unwatch_refcount() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _rx) = mpsc::channel::<PathBuf>();
        let tx = Mutex::new(tx);
        let w = FileWatcher::new(move |p| {
            let _ = lock(&tx).send(p.to_path_buf());
        })
        .unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        w.watch(&a).unwrap();
        w.watch(&b).unwrap();
        w.watch(&a).unwrap(); // doublon sans effet
        assert_eq!(lock(&w.dirs).values().copied().sum::<usize>(), 2);
        w.unwatch(&a).unwrap();
        w.unwatch(&b).unwrap();
        assert!(lock(&w.dirs).is_empty());
        assert!(lock(&w.shared).files.is_empty());
    }
}
