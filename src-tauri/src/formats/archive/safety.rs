//! Sécurité des archives : normalisation des chemins d'entrée, limites (nombre d'entrées,
//! taille décompressée, ratio) vérifiées en flux pendant la décompression.

use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use crate::core::limits::{MAX_ARCHIVE_ENTRIES, MAX_COMPRESSION_RATIO, MAX_UNCOMPRESSED_BYTES};
use crate::error::{AppError, Result};

/// Marge ajoutée au ratio (petits fichiers très compressibles).
const RATIO_GRACE_BYTES: u64 = 64 * 1024;

/// Normalise un chemin d'entrée : séparateur `/`, sans `.`, sans `/` final.
/// Retourne `None` si le chemin est dangereux ou vide : `..`, absolu, `\`, préfixe `C:`, NUL.
pub fn normalize_entry_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') || raw.starts_with('/') {
        return None;
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Un lien (symbolique ou dur) est sûr s'il reste dans la destination une fois résolu.
/// Les liens ne sont de toute façon jamais créés à l'extraction.
pub fn link_target_is_inside(entry_path: &str, target: &str) -> bool {
    if target.starts_with('/') || target.contains('\\') {
        return false;
    }
    let mut depth: i64 = entry_path.split('/').count() as i64 - 1;
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => depth -= 1,
            _ => depth += 1,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

/// Chemin de destination pour une entrée normalisée, garanti sous `dest`.
pub fn join_under(dest: &Path, normalized: &str) -> Option<PathBuf> {
    let mut out = dest.to_path_buf();
    for comp in Path::new(normalized).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            _ => return None,
        }
    }
    Some(out)
}

/// Compteur de ressources d'une archive.
#[derive(Default)]
pub struct Budget {
    entries: usize,
    bytes: u64,
}

impl Budget {
    pub fn entry(&mut self) -> Result<()> {
        self.entries += 1;
        if self.entries > MAX_ARCHIVE_ENTRIES {
            return Err(AppError::Limit("archive.entries".into()));
        }
        Ok(())
    }

    pub fn add_bytes(&mut self, n: u64) -> Result<()> {
        self.bytes = self.bytes.saturating_add(n);
        if self.bytes > MAX_UNCOMPRESSED_BYTES {
            return Err(AppError::Limit("archive.bytes".into()));
        }
        Ok(())
    }

    pub fn remaining_bytes(&self) -> u64 {
        MAX_UNCOMPRESSED_BYTES.saturating_sub(self.bytes)
    }
}

/// Taille décompressée max autorisée pour `compressed` octets compressés.
pub fn max_for_compressed(compressed: u64) -> u64 {
    compressed
        .max(1)
        .saturating_mul(MAX_COMPRESSION_RATIO)
        .saturating_add(RATIO_GRACE_BYTES)
        .min(MAX_UNCOMPRESSED_BYTES)
}

#[derive(Debug)]
struct LimitHit(&'static str);

impl std::fmt::Display for LimitHit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LimitHit {}

/// Reader compteur : échoue dès que plus de `max` octets décompressés ont été lus.
pub struct LimitedReader<R> {
    inner: R,
    read: u64,
    max: u64,
}

impl<R> LimitedReader<R> {
    pub fn new(inner: R, max: u64) -> Self {
        Self {
            inner,
            read: 0,
            max,
        }
    }

    pub fn bytes_read(&self) -> u64 {
        self.read
    }
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read = self.read.saturating_add(n as u64);
        if self.read > self.max {
            return Err(io::Error::other(LimitHit("archive.ratio")));
        }
        Ok(n)
    }
}

/// Convertit une erreur d'E/S en `AppError`, en reconnaissant un dépassement de limite.
pub fn io_to_app(e: io::Error) -> AppError {
    match e.get_ref().and_then(|i| i.downcast_ref::<LimitHit>()) {
        Some(hit) => AppError::Limit(hit.0.to_string()),
        None => AppError::Io(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_rejects() {
        assert_eq!(normalize_entry_path("a/b.txt").as_deref(), Some("a/b.txt"));
        assert_eq!(normalize_entry_path("./a//b/").as_deref(), Some("a/b"));
        for bad in [
            "../x",
            "a/../../x",
            "a/..",
            "/etc/passwd",
            "C:/x",
            "c:x",
            "a\\b",
            "",
            "./",
            "a\0b",
        ] {
            assert_eq!(normalize_entry_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn link_targets() {
        assert!(link_target_is_inside("a/b", "c"));
        assert!(link_target_is_inside("a/b", "../a/c"));
        assert!(!link_target_is_inside("a/b", "../../etc/passwd"));
        assert!(!link_target_is_inside("a", "/etc/passwd"));
        assert!(!link_target_is_inside("a", ".."));
    }

    #[test]
    fn join_stays_under_dest() {
        let d = Path::new("/tmp/dest");
        assert_eq!(join_under(d, "a/b"), Some(PathBuf::from("/tmp/dest/a/b")));
        assert_eq!(join_under(d, "../b"), None);
    }

    #[test]
    fn limited_reader_trips_on_ratio() {
        let mut r = LimitedReader::new(io::repeat(0), max_for_compressed(10));
        let err = io::copy(&mut r, &mut io::sink()).unwrap_err();
        assert!(matches!(io_to_app(err), AppError::Limit(_)));
        let mut ok = LimitedReader::new(io::repeat(0).take(1000), 2000);
        assert_eq!(io::copy(&mut ok, &mut io::sink()).unwrap(), 1000);
    }

    #[test]
    fn budget_limits_entries() {
        let mut b = Budget::default();
        for _ in 0..MAX_ARCHIVE_ENTRIES {
            b.entry().unwrap();
        }
        assert!(b.entry().is_err());
        assert!(Budget::default()
            .add_bytes(MAX_UNCOMPRESSED_BYTES + 1)
            .is_err());
    }
}
