//! Archives : zip, tar, tar.gz, gz, 7z. Écriture (zip/tar/tar.gz) = réécriture complète dans un
//! fichier temporaire puis remplacement atomique. Les modifications passent par des commandes
//! dédiées (`archive_*`) : le modèle `ArchiveDoc` n'embarque pas le contenu.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use crate::commands::AppState;
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::{MAX_ARCHIVE_ENTRIES, MAX_DEPTH, MAX_OPEN_BYTES};
use crate::core::model::{ArchiveDoc, ArchiveEntry, DocumentModel, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub mod safety;
mod sevenz;
mod tar;
mod zip;

use safety::{io_to_app, join_under, normalize_entry_path, Budget};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fmt {
    Zip,
    Tar,
    TarGz,
    Gz,
    SevenZ,
}

impl Fmt {
    pub const ALL: [Fmt; 5] = [Fmt::Zip, Fmt::Tar, Fmt::TarGz, Fmt::Gz, Fmt::SevenZ];

    pub fn id(self) -> &'static str {
        match self {
            Fmt::Zip => "zip",
            Fmt::Tar => "tar",
            Fmt::TarGz => "tar.gz",
            Fmt::Gz => "gz",
            Fmt::SevenZ => "7z",
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Fmt::Zip => &["zip", "jar", "apk", "cbz", "war"],
            Fmt::Tar => &["tar"],
            Fmt::TarGz => &["tar.gz", "tgz"],
            Fmt::Gz => &["gz"],
            Fmt::SevenZ => &["7z"],
        }
    }

    fn label_key(self) -> &'static str {
        match self {
            Fmt::Zip => "formats.zip",
            Fmt::Tar => "formats.tar",
            Fmt::TarGz => "formats.tarGz",
            Fmt::Gz => "formats.gz",
            Fmt::SevenZ => "formats.sevenZ",
        }
    }

    pub fn writable(self) -> bool {
        matches!(self, Fmt::Zip | Fmt::Tar | Fmt::TarGz)
    }

    fn from_id(id: &str) -> Option<Fmt> {
        Fmt::ALL.into_iter().find(|f| f.id() == id)
    }

    fn detect(self, probe: &FileProbe) -> Option<Confidence> {
        let head = &probe.head;
        let ext_ok = self.extensions().contains(&probe.ext.as_str());
        let is_gzip = head.starts_with(&[0x1F, 0x8B]);
        let confidence = match self {
            Fmt::Zip => {
                let magic = head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06");
                match (magic, ext_ok) {
                    (true, true) => 90,
                    (true, false) => 50,
                    (false, true) => 60,
                    _ => return None,
                }
            }
            Fmt::Tar => {
                let magic = head.get(257..262) == Some(b"ustar");
                match (magic, ext_ok) {
                    (true, _) => 90,
                    (false, true) => 60,
                    _ => return None,
                }
            }
            Fmt::TarGz => match (is_gzip, ext_ok || tar::gz_contains_tar(head)) {
                (true, true) => 90,
                (false, true) => 60,
                _ => return None,
            },
            Fmt::Gz => match (is_gzip, ext_ok, tar::gz_contains_tar(head)) {
                (true, true, false) => 90,
                (true, _, _) => 50,
                (false, true, _) => 60,
                _ => return None,
            },
            Fmt::SevenZ => {
                let magic = head.starts_with(&[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C]);
                match (magic, ext_ok) {
                    (true, _) => 90,
                    (false, true) => 60,
                    _ => return None,
                }
            }
        };
        Some(Confidence(confidence))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Hardlink,
}

/// Entrée d'archive normalisée, commune à tous les formats.
#[derive(Debug, Clone)]
pub struct Item {
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    pub compressed: Option<u64>,
    /// Secondes epoch (UTC).
    pub mtime: Option<i64>,
    pub mode: Option<u32>,
    pub uid: u64,
    pub gid: u64,
    pub link: Option<String>,
}

pub enum Flow {
    Continue,
    Stop,
}

pub type Visitor<'a> = dyn FnMut(&Item, &mut dyn Read) -> Result<Flow> + 'a;

/// Parcourt les entrées sûres d'une archive. Avec `want_data`, le lecteur fourni donne le contenu
/// décompressé (borné par ratio/taille) ; sinon il est vide. Les chemins dangereux sont ignorés.
pub fn visit(path: &Path, fmt: Fmt, want_data: bool, f: &mut Visitor) -> Result<()> {
    match fmt {
        Fmt::Zip => zip::visit(path, want_data, f),
        Fmt::Tar => tar::visit(path, false, want_data, f),
        Fmt::TarGz => tar::visit(path, true, want_data, f),
        Fmt::Gz => tar::visit_gz(path, want_data, f),
        Fmt::SevenZ => sevenz::visit(path, want_data, f),
    }
}

// --- Sorties (écriture) ---

pub struct StreamMeta {
    pub size: u64,
    pub mode: Option<u32>,
    pub mtime: Option<i64>,
    pub uid: u64,
    pub gid: u64,
}

pub trait Sink {
    fn dir(&mut self, name: &str, meta: &StreamMeta) -> Result<()>;
    fn stream(&mut self, name: &str, meta: &StreamMeta, data: &mut dyn Read) -> Result<()>;
    fn link(&mut self, name: &str, target: &str, hard: bool) -> Result<()>;
}

/// Fichier ou dossier du disque à ajouter.
pub struct NewEntry {
    pub name: String,
    pub src: PathBuf,
    pub is_dir: bool,
}

pub enum Action {
    Keep,
    Drop,
    Rename(String),
}

fn disk_meta(meta: &std::fs::Metadata, is_dir: bool) -> StreamMeta {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let mode = None;
    StreamMeta {
        size: if is_dir { 0 } else { meta.len() },
        mode,
        mtime,
        uid: 0,
        gid: 0,
    }
}

fn apply_adds(sink: &mut dyn Sink, adds: &[NewEntry]) -> Result<()> {
    for add in adds {
        let meta = std::fs::metadata(&add.src)?;
        let m = disk_meta(&meta, add.is_dir);
        if add.is_dir {
            sink.dir(&add.name, &m)?;
        } else {
            let mut r = BufReader::new(File::open(&add.src)?);
            sink.stream(&add.name, &m, &mut r)?;
        }
    }
    Ok(())
}

/// Vrai si `path` est remplacé par un ajout : même nom, ou descendant d'un nom ajouté.
fn skipped(skip: &HashSet<&str>, path: &str) -> bool {
    skip.contains(path)
        || path
            .match_indices('/')
            .any(|(i, _)| skip.contains(&path[..i]))
}

/// Recopie (décompresse puis recompresse) les entrées d'une archive vers `sink`.
fn copy_into(
    sink: &mut dyn Sink,
    src: &Path,
    src_fmt: Fmt,
    decide: &mut dyn FnMut(&str) -> Action,
    skip: &HashSet<&str>,
) -> Result<()> {
    visit(src, src_fmt, true, &mut |it, rd| {
        if skipped(skip, &it.path) {
            return Ok(Flow::Continue);
        }
        let name = match decide(&it.path) {
            Action::Drop => return Ok(Flow::Continue),
            Action::Keep => it.path.clone(),
            Action::Rename(to) => to,
        };
        let m = StreamMeta {
            size: it.size,
            mode: it.mode,
            mtime: it.mtime,
            uid: it.uid,
            gid: it.gid,
        };
        match it.kind {
            Kind::Dir => sink.dir(&name, &m)?,
            Kind::File => sink.stream(&name, &m, rd)?,
            Kind::Symlink | Kind::Hardlink => {
                if let Some(target) = &it.link {
                    sink.link(&name, target, it.kind == Kind::Hardlink)?;
                }
            }
        }
        Ok(Flow::Continue)
    })
}

/// Écrit une nouvelle archive `out_fmt` à `dest` (atomiquement) : entrées de `old` filtrées par
/// `decide`, puis `adds` (qui remplacent les entrées de même nom).
fn rewrite(
    old: Option<(&Path, Fmt)>,
    dest: &Path,
    out_fmt: Fmt,
    decide: &mut dyn FnMut(&str) -> Action,
    adds: &[NewEntry],
) -> Result<()> {
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let tmp = tempfile::NamedTempFile::new_in(parent)?;
    let skip: HashSet<&str> = adds.iter().map(|a| a.name.as_str()).collect();
    let file = tmp.as_file();
    match out_fmt {
        Fmt::Zip => {
            let mut sink = zip::ZipSink::new(file);
            match old {
                Some((p, Fmt::Zip)) => sink.raw_rewrite(p, decide, &skip)?,
                Some((p, f)) => copy_into(&mut sink, p, f, decide, &skip)?,
                None => {}
            }
            apply_adds(&mut sink, adds)?;
            sink.finish()?;
        }
        Fmt::Tar | Fmt::TarGz => {
            let mut sink = tar::TarSink::new(file, out_fmt == Fmt::TarGz);
            match old {
                Some((p, Fmt::Tar)) => sink.raw_rewrite(p, false, decide, &skip)?,
                Some((p, Fmt::TarGz)) => sink.raw_rewrite(p, true, decide, &skip)?,
                Some((p, f)) => copy_into(&mut sink, p, f, decide, &skip)?,
                None => {}
            }
            apply_adds(&mut sink, adds)?;
            sink.finish()?;
        }
        _ => return Err(AppError::ReadOnly),
    }
    file.sync_all()?;
    atomic::replace_with(dest, tmp.path())
}

// --- Opérations ---

fn iso(t: Option<i64>) -> Option<String> {
    chrono::DateTime::from_timestamp(t?, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

pub fn list(path: &Path, fmt: Fmt) -> Result<Vec<ArchiveEntry>> {
    let mut out = Vec::new();
    visit(path, fmt, false, &mut |it, _| {
        out.push(ArchiveEntry {
            path: it.path.clone(),
            size: it.size,
            compressed_size: it.compressed,
            is_dir: it.kind == Kind::Dir,
            modified: iso(it.mtime),
        });
        Ok(Flow::Continue)
    })?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn detect_fmt(path: &Path) -> Result<Fmt> {
    let probe = FileProbe::from_path(path)?;
    Fmt::ALL
        .into_iter()
        .filter_map(|f| f.detect(&probe).map(|c| (f, c)))
        .max_by_key(|(_, c)| *c)
        .map(|(f, _)| f)
        .ok_or(AppError::Unsupported)
}

fn writable_fmt(path: &Path) -> Result<Fmt> {
    let fmt = detect_fmt(path)?;
    if fmt.writable() {
        Ok(fmt)
    } else {
        Err(AppError::ReadOnly)
    }
}

fn is_within(path: &str, sel: &str) -> bool {
    path == sel
        || path
            .strip_prefix(sel)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Premier nom libre : `name`, puis `name (1).ext`, `name (2).ext`…
fn create_unique(target: &Path) -> Result<(File, PathBuf)> {
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 0..10_000u32 {
        let candidate = if n == 0 {
            target.to_path_buf()
        } else {
            target.with_file_name(format!("{stem} ({n}){ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => return Ok((f, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Limit("archive.names".into()))
}

fn ensure_inside(dir: &Path, root: &Path) -> Result<()> {
    if std::fs::canonicalize(dir)?.starts_with(root) {
        Ok(())
    } else {
        Err(AppError::Corrupt("path outside destination".into()))
    }
}

pub fn extract(path: &Path, entries: Option<Vec<String>>, dest_dir: &Path) -> Result<u32> {
    let fmt = detect_fmt(path)?;
    let sel: Option<Vec<String>> =
        entries.map(|v| v.iter().filter_map(|e| normalize_entry_path(e)).collect());
    std::fs::create_dir_all(dest_dir)?;
    let root = std::fs::canonicalize(dest_dir)?;
    let mut count = 0u32;
    let mut budget = Budget::default();
    visit(path, fmt, true, &mut |it, rd| {
        if let Some(sel) = &sel {
            if !sel.iter().any(|s| is_within(&it.path, s)) {
                return Ok(Flow::Continue);
            }
        }
        // Les liens ne sont jamais créés (évite toute évasion de la destination).
        if matches!(it.kind, Kind::Symlink | Kind::Hardlink) {
            return Ok(Flow::Continue);
        }
        let Some(target) = join_under(&root, &it.path) else {
            return Ok(Flow::Continue);
        };
        if it.kind == Kind::Dir {
            std::fs::create_dir_all(&target)?;
            ensure_inside(&target, &root)?;
            return Ok(Flow::Continue);
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
            ensure_inside(parent, &root)?;
        }
        let (file, written_path) = create_unique(&target)?;
        let mut w = std::io::BufWriter::new(file);
        let res = std::io::copy(rd, &mut w)
            .and_then(|n| w.flush().map(|_| n))
            .map_err(io_to_app)
            .and_then(|n| budget.add_bytes(n));
        if let Err(e) = res {
            drop(w);
            let _ = std::fs::remove_file(&written_path);
            return Err(e);
        }
        count += 1;
        Ok(Flow::Continue)
    })?;
    Ok(count)
}

/// Supprime les copies temporaires de `read_entry` plus vieilles que `max_age` (les onglets de
/// la session courante, plus récents, ne sont pas touchés).
pub fn cleanup_entries_in(root: &Path, max_age: std::time::Duration) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if !old {
            continue;
        }
        let dir = e.path();
        // Fichiers en lecture seule : on lève la protection (Windows) avant suppression.
        if let Ok(files) = std::fs::read_dir(&dir) {
            for f in files.flatten() {
                if let Ok(m) = f.metadata() {
                    let mut p = m.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    p.set_readonly(false);
                    let _ = std::fs::set_permissions(f.path(), p);
                }
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Au démarrage : purge les copies de plus de 12 h.
pub fn cleanup_entries() {
    cleanup_entries_in(
        &std::env::temp_dir().join("omnidoc-entries"),
        std::time::Duration::from_secs(12 * 3600),
    );
}

pub fn read_entry(path: &Path, entry: &str) -> Result<String> {
    let fmt = detect_fmt(path)?;
    let wanted = normalize_entry_path(entry).ok_or(AppError::NotFound)?;
    let mut found: Option<PathBuf> = None;
    visit(path, fmt, true, &mut |it, rd| {
        if it.path != wanted {
            return Ok(Flow::Continue);
        }
        if it.kind != Kind::File {
            return Err(AppError::Unsupported);
        }
        if it.size > MAX_OPEN_BYTES {
            return Err(AppError::TooLarge);
        }
        let name = wanted.rsplit('/').next().unwrap_or("entry");
        let dir = std::env::temp_dir()
            .join("omnidoc-entries")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir)?;
        let out = dir.join(name);
        let mut file = File::create(&out)?;
        let n = std::io::copy(&mut rd.take(MAX_OPEN_BYTES + 1), &mut file).map_err(io_to_app)?;
        if n > MAX_OPEN_BYTES {
            drop(file);
            let _ = std::fs::remove_file(&out);
            return Err(AppError::TooLarge);
        }
        file.flush()?;
        drop(file);
        let mut perms = std::fs::metadata(&out)?.permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&out, perms)?;
        found = Some(out);
        Ok(Flow::Stop)
    })?;
    found
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or(AppError::NotFound)
}

fn collect_adds(files: &[String], prefix: &str) -> Result<Vec<NewEntry>> {
    let prefix = if prefix.trim_matches('/').is_empty() {
        String::new()
    } else {
        normalize_entry_path(prefix).ok_or(AppError::Unsupported)?
    };
    let mut out = Vec::new();
    for f in files {
        let src = Path::new(f);
        let base = src.file_name().ok_or(AppError::Unsupported)?;
        let base = base.to_string_lossy();
        let name = if prefix.is_empty() {
            base.into_owned()
        } else {
            format!("{prefix}/{base}")
        };
        walk(src, name, 0, &mut out)?;
    }
    Ok(out)
}

fn walk(src: &Path, name: String, depth: usize, out: &mut Vec<NewEntry>) -> Result<()> {
    if depth > MAX_DEPTH || out.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::Limit("archive.entries".into()));
    }
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    let Some(name) = normalize_entry_path(&name) else {
        return Ok(());
    };
    if meta.is_dir() {
        out.push(NewEntry {
            name: name.clone(),
            src: src.to_path_buf(),
            is_dir: true,
        });
        let mut children: Vec<_> = std::fs::read_dir(src)?.collect::<std::io::Result<_>>()?;
        children.sort_by_key(|c| c.file_name());
        for c in children {
            let child = format!("{name}/{}", c.file_name().to_string_lossy());
            walk(&c.path(), child, depth + 1, out)?;
        }
    } else if meta.is_file() {
        out.push(NewEntry {
            name,
            src: src.to_path_buf(),
            is_dir: false,
        });
    }
    Ok(())
}

pub fn add(path: &Path, files: &[String], prefix: &str) -> Result<()> {
    let fmt = writable_fmt(path)?;
    let adds = collect_adds(files, prefix)?;
    rewrite(Some((path, fmt)), path, fmt, &mut |_| Action::Keep, &adds)
}

pub fn remove(path: &Path, entries: &[String]) -> Result<()> {
    let fmt = writable_fmt(path)?;
    let sel: Vec<String> = entries
        .iter()
        .filter_map(|e| normalize_entry_path(e))
        .collect();
    rewrite(
        Some((path, fmt)),
        path,
        fmt,
        &mut |p| {
            if sel.iter().any(|s| is_within(p, s)) {
                Action::Drop
            } else {
                Action::Keep
            }
        },
        &[],
    )
}

pub fn rename(path: &Path, from: &str, to: &str) -> Result<()> {
    let fmt = writable_fmt(path)?;
    let from = normalize_entry_path(from).ok_or(AppError::NotFound)?;
    let to = normalize_entry_path(to).ok_or(AppError::Unsupported)?;
    if is_within(&to, &from) {
        return Err(AppError::Unsupported);
    }
    let existing = list(path, fmt)?;
    if !existing.iter().any(|e| is_within(&e.path, &from)) {
        return Err(AppError::NotFound);
    }
    if existing.iter().any(|e| e.path == to) {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
    }
    rewrite(
        Some((path, fmt)),
        path,
        fmt,
        &mut |p| match p.strip_prefix(from.as_str()) {
            Some("") => Action::Rename(to.clone()),
            Some(rest) if rest.starts_with('/') => Action::Rename(format!("{to}{rest}")),
            _ => Action::Keep,
        },
        &[],
    )
}

pub fn create(dest: &Path, files: &[String], format: &str) -> Result<()> {
    let fmt = Fmt::from_id(format)
        .filter(|f| f.writable())
        .ok_or(AppError::Unsupported)?;
    let adds = collect_adds(files, "")?;
    rewrite(None, dest, fmt, &mut |_| Action::Keep, &adds)
}

/// Conversion d'une archive lisible vers zip / tar / tar.gz (les liens ne sont pas convertis en zip).
pub fn convert(path: &Path, dest: &Path, format: &str) -> Result<()> {
    let target = Fmt::from_id(format)
        .filter(|f| f.writable())
        .ok_or(AppError::Unsupported)?;
    let src = detect_fmt(path)?;
    rewrite(Some((path, src)), dest, target, &mut |_| Action::Keep, &[])
}

// --- Handler ---

pub struct ArchiveHandler {
    fmt: Fmt,
}

impl ArchiveHandler {
    pub fn new(fmt: Fmt) -> Self {
        Self { fmt }
    }
}

/// Un handler par format d'archive.
pub fn handlers() -> Vec<Box<dyn FormatHandler>> {
    Fmt::ALL
        .into_iter()
        .map(|f| Box::new(ArchiveHandler::new(f)) as Box<dyn FormatHandler>)
        .collect()
}

impl FormatHandler for ArchiveHandler {
    fn id(&self) -> &'static str {
        self.fmt.id()
    }

    fn model(&self) -> ModelKind {
        ModelKind::Archive
    }

    fn extensions(&self) -> &'static [&'static str] {
        self.fmt.extensions()
    }

    fn label_key(&self) -> &'static str {
        self.fmt.label_key()
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        self.fmt.detect(probe)
    }

    /// `write` reste faux : l'édition passe par les commandes `archive_*` (pas par `save`).
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: if self.fmt.writable() {
                Fidelity::Full
            } else {
                Fidelity::ReadOnly
            },
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Archive(ArchiveDoc {
            format: self.fmt.id().to_string(),
            entries: list(path, self.fmt)?,
            writable: self.fmt.writable(),
        }))
    }
}

// --- Commandes ---

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::Internal)?
}

#[tauri::command]
#[specta::specta]
pub async fn archive_extract(
    path: String,
    entries: Option<Vec<String>>,
    dest_dir: String,
) -> Result<u32> {
    blocking(move || extract(Path::new(&path), entries, Path::new(&dest_dir))).await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_read_entry(path: String, entry: String) -> Result<String> {
    blocking(move || read_entry(Path::new(&path), &entry)).await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_add(
    state: State<'_, AppState>,
    path: String,
    files: Vec<String>,
    prefix: String,
) -> Result<()> {
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let p = Path::new(&path);
        watcher.mark_self_write(p);
        let res = add(p, &files, &prefix);
        watcher.mark_self_write(p);
        res
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_remove(
    state: State<'_, AppState>,
    path: String,
    entries: Vec<String>,
) -> Result<()> {
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let p = Path::new(&path);
        watcher.mark_self_write(p);
        let res = remove(p, &entries);
        watcher.mark_self_write(p);
        res
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_rename(
    state: State<'_, AppState>,
    path: String,
    from: String,
    to: String,
) -> Result<()> {
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let p = Path::new(&path);
        watcher.mark_self_write(p);
        let res = rename(p, &from, &to);
        watcher.mark_self_write(p);
        res
    })
    .await
}

/// `format` : "zip" | "tar" | "tar.gz".
#[tauri::command]
#[specta::specta]
pub async fn archive_create(dest: String, files: Vec<String>, format: String) -> Result<()> {
    blocking(move || create(Path::new(&dest), &files, &format)).await
}

/// Convertit une archive (tout format lisible) en "zip" | "tar" | "tar.gz".
#[tauri::command]
#[specta::specta]
pub async fn archive_convert(path: String, dest: String, format: String) -> Result<()> {
    blocking(move || convert(Path::new(&path), Path::new(&dest), &format)).await
}

#[cfg(test)]
mod tests;
