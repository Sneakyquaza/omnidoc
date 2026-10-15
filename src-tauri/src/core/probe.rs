//! Sonde de fichier : métadonnées + 8 Kio de tête pour la détection de format.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::core::limits::PROBE_HEAD_BYTES;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct FileProbe {
    pub path: PathBuf,
    /// Extension en minuscules, sans point ("tar.gz" pour les archives tar compressées).
    pub ext: String,
    pub size: u64,
    pub head: Vec<u8>,
    pub mime: Option<String>,
    pub is_text: bool,
}

const COMPOUND_EXTS: &[&str] = &["tar.gz", "tar.bz2", "tar.xz", "tar.zst"];

fn extension_of(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    for compound in COMPOUND_EXTS {
        if name.len() > compound.len() + 1 && name.ends_with(&format!(".{compound}")) {
            return (*compound).to_string();
        }
    }
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Heuristique « texte » : BOM UTF-16, UTF-8 valide (coupure finale tolérée) sans NUL,
/// ou moins de 1 % d'octets de contrôle (hors \t \n \r \f).
fn looks_like_text(head: &[u8]) -> bool {
    if head.is_empty() {
        return true;
    }
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    let utf8_ok = match std::str::from_utf8(head) {
        Ok(_) => true,
        // Séquence multi-octets coupée par la fin du buffer : acceptable.
        Err(e) => e.error_len().is_none(),
    };
    if utf8_ok && !head.contains(&0) {
        return true;
    }
    let controls = head
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0C))
        .count();
    controls * 100 < head.len()
}

impl FileProbe {
    pub fn from_path(path: &Path) -> Result<Self> {
        let size = std::fs::metadata(path)?.len();
        let mut head = Vec::new();
        File::open(path)?
            .take(PROBE_HEAD_BYTES as u64)
            .read_to_end(&mut head)?;
        Ok(Self::build(path.to_path_buf(), size, head))
    }

    /// Construit une sonde depuis des octets en mémoire (tests).
    pub fn from_bytes(name: &str, bytes: &[u8]) -> Self {
        let head = bytes[..bytes.len().min(PROBE_HEAD_BYTES)].to_vec();
        Self::build(PathBuf::from(name), bytes.len() as u64, head)
    }

    fn build(path: PathBuf, size: u64, head: Vec<u8>) -> Self {
        let ext = extension_of(&path);
        let mime = infer::get(&head).map(|t| t.mime_type().to_string());
        let is_text = looks_like_text(&head);
        FileProbe {
            path,
            ext,
            size,
            head,
            mime,
            is_text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_lowercase_and_compound() {
        assert_eq!(FileProbe::from_bytes("A.DOCX", b"").ext, "docx");
        assert_eq!(FileProbe::from_bytes("x/backup.TAR.GZ", b"").ext, "tar.gz");
        assert_eq!(FileProbe::from_bytes("a.gz", b"").ext, "gz");
        assert_eq!(FileProbe::from_bytes("Makefile", b"").ext, "");
        assert_eq!(FileProbe::from_bytes(".bashrc", b"").ext, "");
    }

    #[test]
    fn text_heuristic() {
        assert!(FileProbe::from_bytes("a", "héllo\n".as_bytes()).is_text);
        // UTF-8 coupé au milieu d'un caractère
        let cut = &"éé".as_bytes()[..3];
        assert!(FileProbe::from_bytes("a", cut).is_text);
        assert!(FileProbe::from_bytes("a", &[0xFF, 0xFE, b'a', 0]).is_text);
        assert!(!FileProbe::from_bytes("a", &[0, 1, 2, 3, 0xFF, 0x80, 0, 0]).is_text);
    }

    #[test]
    fn mime_from_magic_and_head_limit() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend(vec![0u8; 20_000]);
        let p = FileProbe::from_bytes("x.png", &png);
        assert_eq!(p.mime.as_deref(), Some("image/png"));
        assert_eq!(p.head.len(), PROBE_HEAD_BYTES);
        assert_eq!(p.size, png.len() as u64);
    }

    #[test]
    fn from_path_reads_head() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.TXT");
        std::fs::write(&f, "bonjour").unwrap();
        let p = FileProbe::from_path(&f).unwrap();
        assert_eq!((p.ext.as_str(), p.size, p.is_text), ("txt", 7, true));
        assert!(FileProbe::from_path(&dir.path().join("absent")).is_err());
    }
}
