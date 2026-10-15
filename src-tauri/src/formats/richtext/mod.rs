//! Famille « traitement de texte » : docx, odt, markdown (riche), html, rtf.
//! Tous les formats lisent/écrivent le JSON TipTap via l'arbre de `tree`.

use std::io::{Cursor, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use zip::ZipArchive;

use crate::core::atomic;
use crate::core::limits::{
    MAX_ARCHIVE_ENTRIES, MAX_COMPRESSION_RATIO, MAX_OPEN_BYTES, MAX_UNCOMPRESSED_BYTES,
};
use crate::core::model::{DocumentModel, RichDoc};
use crate::error::{AppError, Result};

pub mod docx;
pub mod html;
pub mod markdown;
pub mod odt;
pub mod rtf;
pub mod tree;
pub mod util;
pub mod xml;

/// Taille max d'une partie XML décompressée.
const MAX_XML_PART: u64 = 256 * 1024 * 1024;
/// Taille max d'une image embarquée.
const MAX_MEDIA_PART: u64 = 64 * 1024 * 1024;
/// Délai max d'une conversion LibreOffice.
const SOFFICE_TIMEOUT: Duration = Duration::from_secs(180);

pub(crate) fn rich_of(doc: &DocumentModel) -> Result<&RichDoc> {
    match doc {
        DocumentModel::RichText(r) => Ok(r),
        _ => Err(AppError::Unsupported),
    }
}

pub(crate) fn read_limited(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    Ok(std::fs::read(path)?)
}

pub(crate) type Zip<'a> = ZipArchive<Cursor<&'a [u8]>>;

pub(crate) fn open_zip(bytes: &[u8]) -> Result<Zip<'_>> {
    let archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| AppError::Corrupt(format!("archive invalide : {e}")))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::Limit("trop d'entrées dans l'archive".into()));
    }
    Ok(archive)
}

/// Lit une entrée (`None` si absente), avec garde-fous de taille et de ratio.
pub(crate) fn zip_read(archive: &mut Zip<'_>, name: &str, max: u64) -> Result<Option<Vec<u8>>> {
    let mut f = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(AppError::Corrupt(format!("entrée {name} : {e}"))),
    };
    let size = f.size();
    if size > max || size > MAX_UNCOMPRESSED_BYTES {
        return Err(AppError::Limit(format!("entrée {name} trop volumineuse")));
    }
    let comp = f.compressed_size().max(1);
    if size > 1024 * 1024 && size / comp > MAX_COMPRESSION_RATIO {
        return Err(AppError::Limit(format!("ratio de compression de {name}")));
    }
    let mut out = Vec::with_capacity(size.min(16 * 1024 * 1024) as usize);
    f.by_ref()
        .take(max + 1)
        .read_to_end(&mut out)
        .map_err(|e| AppError::Corrupt(format!("lecture de {name} : {e}")))?;
    if out.len() as u64 > max {
        return Err(AppError::Limit(format!("entrée {name} trop volumineuse")));
    }
    Ok(Some(out))
}

pub(crate) fn zip_read_xml(archive: &mut Zip<'_>, name: &str) -> Result<Option<xml::Element>> {
    match zip_read(archive, name, MAX_XML_PART)? {
        Some(b) => Ok(Some(xml::parse(&b)?)),
        None => Ok(None),
    }
}

pub(crate) fn zip_read_media(archive: &mut Zip<'_>, name: &str) -> Result<Option<Vec<u8>>> {
    zip_read(archive, name, MAX_MEDIA_PART)
}

/// Résout un chemin relatif (`../media/a.png`, `Pictures/a.png`) depuis un répertoire de base.
pub(crate) fn resolve_path(base_dir: &str, target: &str) -> String {
    let target = target.trim_start_matches("./");
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Écrit `doc` dans le format `target` (id de handler de la famille) ou en PDF.
pub fn export_rich(rich: &RichDoc, target: &str, path: &Path) -> Result<()> {
    let bytes = match target {
        "docx" => docx::serialize(rich)?,
        "odt" => odt::serialize(rich)?,
        "markdown-rich" => markdown::serialize(rich)?,
        "html" => html::serialize(rich)?,
        "pdf" => return export_pdf(rich, path),
        _ => return Err(AppError::Unsupported),
    };
    atomic::write(path, &bytes)
}

fn find_soffice() -> Option<std::path::PathBuf> {
    let tools = crate::external::find_tools();
    ["soffice", "libreoffice"].iter().find_map(|n| {
        tools
            .iter()
            .find(|t| t.name == *n)
            .map(|t| std::path::PathBuf::from(&t.path))
    })
}

/// Export PDF via LibreOffice (`soffice --headless`) depuis un DOCX temporaire.
pub fn export_pdf(rich: &RichDoc, path: &Path) -> Result<()> {
    let soffice = find_soffice().ok_or_else(|| {
        AppError::External("LibreOffice (soffice) est introuvable pour l'export PDF".into())
    })?;
    export_pdf_with(&soffice, rich, path)
}

pub(crate) fn export_pdf_with(soffice: &Path, rich: &RichDoc, path: &Path) -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let src = tmp.path().join("document.docx");
    std::fs::write(&src, docx::serialize(rich)?)?;
    let outdir = tmp.path().join("out");
    std::fs::create_dir_all(&outdir)?;
    let profile = tmp.path().join("profile");
    let mut child = Command::new(soffice)
        .arg("--headless")
        .arg("--norestore")
        .arg(format!(
            "-env:UserInstallation=file://{}",
            profile.display()
        ))
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&outdir)
        .arg(&src)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::External(format!("lancement de soffice : {e}")))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None if start.elapsed() > SOFFICE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::External("délai dépassé pour soffice".into()));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    if !status.success() {
        return Err(AppError::External(format!("soffice a échoué ({status})")));
    }
    let pdf = std::fs::read(outdir.join("document.pdf"))
        .map_err(|_| AppError::External("soffice n'a produit aucun PDF".into()))?;
    atomic::write(path, &pdf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(resolve_path("word", "media/a.png"), "word/media/a.png");
        assert_eq!(resolve_path("word", "../x/a.png"), "x/a.png");
        assert_eq!(resolve_path("word", "/x/a.png"), "x/a.png");
    }

    #[test]
    fn pdf_export_without_soffice_is_external_error() {
        let rich = RichDoc {
            doc: serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]}),
            meta: Default::default(),
            lossy: vec![],
        };
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("no-such-soffice");
        let r = export_pdf_with(&fake, &rich, &dir.path().join("o.pdf"));
        assert!(matches!(r, Err(AppError::External(_))));
    }
}
