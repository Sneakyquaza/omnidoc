//! Écriture atomique + sauvegarde de l'original (une fois par chemin et par session).

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::error::{AppError, Result};

static BACKED_UP: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static BACKUP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Dossier de sauvegarde utilisé par `write` (défini une fois au démarrage).
pub fn set_backup_dir(dir: PathBuf) {
    let _ = BACKUP_DIR.set(dir);
}

/// Écriture atomique avec le dossier de sauvegarde de l'application.
pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic(path, bytes, BACKUP_DIR.get().map(|p| p.as_path()))
}

fn backup_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Copie l'original dans `backup_dir` si ce chemin n'a pas déjà été sauvegardé durant la session.
fn backup_original(path: &Path, backup_dir: &Path) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let key = backup_key(path);
    let mut guard = BACKED_UP.lock().unwrap_or_else(|e| e.into_inner());
    let done = guard.get_or_insert_with(HashSet::new);
    if done.contains(&key) {
        return Ok(());
    }
    std::fs::create_dir_all(backup_dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    // Empreinte courte du chemin canonique : deux `n.txt` de dossiers différents ne collisionnent pas.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    let tag = hasher.finish() as u32;
    let mut n = 0u32;
    loop {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let dest = backup_dir.join(format!("{stamp}-{tag:08x}{suffix}-{name}"));
        // `create_new` : ne jamais écraser une sauvegarde existante.
        let mut out = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let mut src = std::fs::File::open(path)?;
        std::io::copy(&mut src, &mut out)?;
        break;
    }
    done.insert(key);
    Ok(())
}

/// Si `path` est un lien symbolique, renvoie sa cible canonique (le lien est conservé à
/// l'écriture) ; sinon `path` tel quel.
fn resolve_target(path: &Path) -> PathBuf {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
        }
        _ => path.to_path_buf(),
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8], backup_dir: Option<&Path>) -> Result<()> {
    let path = resolve_target(path);
    let path = path.as_path();
    if let Some(dir) = backup_dir {
        backup_original(path, dir)?;
    }
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        tmp.as_file().set_permissions(meta.permissions())?;
    }
    crate::core::watch::note_app_write(path);
    tmp.persist(path).map_err(|e| AppError::Io(e.error))?;
    crate::core::watch::note_app_write(path);
    Ok(())
}

/// Remplace `path` par le fichier temporaire `temp_path` (même volume, de préférence le même
/// dossier) via un rename atomique, avec sauvegarde de l'original. `temp_path` est supprimé
/// en cas d'échec.
pub fn replace_with(path: &Path, temp_path: &Path) -> Result<()> {
    let res = replace_with_in(path, temp_path, BACKUP_DIR.get().map(|p| p.as_path()));
    if res.is_err() {
        let _ = std::fs::remove_file(temp_path);
    }
    res
}

fn replace_with_in(path: &Path, temp_path: &Path, backup_dir: Option<&Path>) -> Result<()> {
    let path = resolve_target(path);
    let path = path.as_path();
    if let Some(dir) = backup_dir {
        backup_original(path, dir)?;
    }
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        std::fs::set_permissions(temp_path, meta.permissions())?;
    }
    crate::core::watch::note_app_write(path);
    std::fs::rename(temp_path, path)?;
    crate::core::watch::note_app_write(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_with_swaps_content() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        let t = dir.path().join("a.tmp");
        std::fs::write(&f, "old").unwrap();
        std::fs::write(&t, "new").unwrap();
        replace_with_in(&f, &t, None).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"new");
        assert!(!t.exists());
    }

    #[cfg(unix)]
    #[test]
    fn writing_through_symlink_keeps_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        std::fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"new", None).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
        let t = dir.path().join("t.tmp");
        std::fs::write(&t, "third").unwrap();
        replace_with_in(&link, &t, None).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&real).unwrap(), b"third");
    }

    #[test]
    fn backups_of_same_name_do_not_collide() {
        let d1 = tempfile::tempdir().unwrap();
        let d2 = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        for (d, c) in [(&d1, "un"), (&d2, "deux")] {
            let f = d.path().join("n.txt");
            std::fs::write(&f, c).unwrap();
            write_atomic(&f, b"x", Some(backups.path())).unwrap();
        }
        let list = names(backups.path());
        assert_eq!(list.len(), 2);
        let mut contents: Vec<_> = list
            .iter()
            .map(|n| std::fs::read_to_string(backups.path().join(n)).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, vec!["deux", "un"]);
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn writes_and_rewrites_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        write_atomic(&f, b"one", None).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"one");
        write_atomic(&f, b"two", None).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");
        assert_eq!(names(dir.path()), vec!["a.txt"]);
    }

    #[test]
    fn backup_is_made_once_per_path() {
        let dir = tempfile::tempdir().unwrap();
        let backups = tempfile::tempdir().unwrap();
        let f = dir.path().join("doc.txt");
        // Fichier absent : pas de sauvegarde
        write_atomic(&f, b"v1", Some(backups.path())).unwrap();
        assert!(names(backups.path()).is_empty());
        // 1re réécriture : sauvegarde de v1
        write_atomic(&f, b"v2", Some(backups.path())).unwrap();
        let list = names(backups.path());
        assert_eq!(list.len(), 1);
        assert!(list[0].ends_with("-doc.txt"));
        assert_eq!(std::fs::read(backups.path().join(&list[0])).unwrap(), b"v1");
        // 2e réécriture : pas de nouvelle sauvegarde
        write_atomic(&f, b"v3", Some(backups.path())).unwrap();
        assert_eq!(names(backups.path()).len(), 1);
        assert_eq!(std::fs::read(&f).unwrap(), b"v3");
    }

    #[test]
    fn failure_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        // Cible = dossier existant : le rename échoue, rien ne doit rester.
        let target = dir.path().join("sub");
        std::fs::create_dir(&target).unwrap();
        assert!(write_atomic(&target, b"data", None).is_err());
        assert_eq!(names(dir.path()), vec!["sub"]);
        // Dossier parent inexistant
        assert!(write_atomic(&dir.path().join("no/dir/f"), b"x", None).is_err());
        // L'original reste intact si l'écriture échoue
        let f = dir.path().join("keep.txt");
        std::fs::write(&f, "orig").unwrap();
        assert!(write_atomic(&f.join("child"), b"x", None).is_err());
        assert_eq!(std::fs::read(&f).unwrap(), b"orig");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("run.sh");
        std::fs::write(&f, "a").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o750)).unwrap();
        write_atomic(&f, b"b", None).unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o750);
    }
}
