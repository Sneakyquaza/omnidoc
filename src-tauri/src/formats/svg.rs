//! SVG : dimensions via `usvg`, rendu PNG via `resvg`. Aucun script exécuté, aucune ressource
//! externe chargée (ni fichiers ni réseau) ; le front affiche le fichier via `<img>`.

use std::path::Path;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, ImageDoc, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

const MAX_RENDER_SIDE: f32 = 16_384.0;

pub struct SvgHandler;

fn options() -> usvg::Options<'static> {
    let mut opt = usvg::Options {
        resources_dir: None,
        ..Default::default()
    };
    // Pas de chargement de fichiers locaux via <image href="...">.
    opt.image_href_resolver.resolve_string = Box::new(|_, _| None);
    opt.fontdb_mut().load_system_fonts();
    opt
}

fn load_tree(path: &Path) -> Result<usvg::Tree> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    let data = std::fs::read(path)?;
    usvg::Tree::from_data(&data, &options()).map_err(|e| AppError::Corrupt(e.to_string()))
}

pub fn render_png(path: &Path, dest: &Path, scale: f32) -> Result<()> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(AppError::Limit("échelle invalide".into()));
    }
    let tree = load_tree(path)?;
    let size = tree.size();
    let (w, h) = (
        (size.width() * scale).ceil(),
        (size.height() * scale).ceil(),
    );
    if w < 1.0 || h < 1.0 || w > MAX_RENDER_SIDE || h > MAX_RENDER_SIDE {
        return Err(AppError::Limit("dimensions de rendu hors limites".into()));
    }
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w as u32, h as u32)
        .ok_or_else(|| AppError::Limit("dimensions de rendu hors limites".into()))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap
        .encode_png()
        .map_err(|e| AppError::Corrupt(e.to_string()))?;
    atomic::write(dest, &png)
}

impl FormatHandler for SvgHandler {
    fn id(&self) -> &'static str {
        "svg"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Image
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["svg"]
    }

    fn label_key(&self) -> &'static str {
        "formats.svg"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let has_tag = probe.head.windows(4).any(|w| w == b"<svg");
        if has_tag {
            Some(Confidence(75))
        } else if probe.ext == "svg" {
            Some(Confidence(70))
        } else {
            None
        }
    }

    /// Lecture seule (aperçu/rendu) ; l'édition du source se fait via le handler texte.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let tree = load_tree(path)?;
        let size = tree.size();
        Ok(DocumentModel::Image(ImageDoc {
            width: size.width().ceil() as u32,
            height: size.height().ceil() as u32,
            format: "svg".to_string(),
            has_alpha: true,
            exif: vec![],
        }))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn svg_render_png(path: String, dest: String, scale: f32) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        render_png(Path::new(&path), Path::new(&dest), scale)
    })
    .await
    .map_err(|e| AppError::External(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f00"/><script>alert(1)</script></svg>"##;

    #[test]
    fn dimensions_render_and_detect() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.svg");
        std::fs::write(&p, SVG).unwrap();
        match SvgHandler.open(&p).unwrap() {
            DocumentModel::Image(d) => {
                assert_eq!((d.width, d.height), (40, 20));
                assert_eq!(d.format, "svg");
                assert!(d.exif.is_empty());
            }
            _ => panic!("modèle inattendu"),
        }
        let out = dir.path().join("a.png");
        render_png(&p, &out, 2.0).unwrap();
        let img = image::open(&out).unwrap();
        assert_eq!((img.width(), img.height()), (80, 40));
        assert_eq!(img.to_rgba8().get_pixel(5, 5).0, [255, 0, 0, 255]);
        assert!(render_png(&p, &out, 0.0).is_err());
        assert!(render_png(&p, &out, 1.0e6).is_err());

        let probe = FileProbe::from_path(&p).unwrap();
        assert_eq!(SvgHandler.detect(&probe), Some(Confidence(75)));
        assert_eq!(
            SvgHandler.detect(&FileProbe::from_bytes("x.svg", b"zz")),
            Some(Confidence(70))
        );
        assert_eq!(
            SvgHandler.detect(&FileProbe::from_bytes("x.txt", b"zz")),
            None
        );
    }

    #[test]
    fn garbage_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.svg");
        std::fs::write(&p, &SVG.as_bytes()[..30]).unwrap();
        assert!(SvgHandler.open(&p).is_err());
        std::fs::write(&p, [0xFFu8, 0xFE, 0, 1, 2]).unwrap();
        assert!(SvgHandler.open(&p).is_err());
    }
}
