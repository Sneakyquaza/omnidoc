//! Registre des handlers : détection, accès par id, export.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::handler::{Capabilities, FormatHandler};
use crate::core::model::{DocumentModel, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub struct Registry {
    handlers: Vec<Box<dyn FormatHandler>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub handler_id: String,
    pub model: ModelKind,
    pub mime: Option<String>,
    pub label_key: String,
    pub confidence: u8,
    /// Autres handlers ayant répondu, du plus au moins confiant.
    pub alternatives: Vec<String>,
    /// L'extension ne correspond pas à la signature du contenu.
    pub signature_mismatch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HandlerInfo {
    pub id: String,
    pub model: ModelKind,
    pub extensions: Vec<String>,
    pub capabilities: Capabilities,
    pub label_key: String,
}

/// Extensions admises pour une signature donnée (conteneurs, alias).
fn extension_matches_signature(ext: &str, sig_ext: &str) -> bool {
    if ext.is_empty() || ext == sig_ext {
        return true;
    }
    let group: &[&str] = match sig_ext {
        "jpg" => &["jpg", "jpeg", "jpe", "jfif"],
        "tif" => &["tif", "tiff"],
        "zip" => &[
            "zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "odg", "epub", "jar", "apk", "xpi",
            "cbz", "whl", "ora", "3mf", "kra", "docm", "xlsm", "pptm",
        ],
        "gz" => &["gz", "tgz", "tar.gz"],
        "mp4" => &["mp4", "m4a", "m4v", "mov", "3gp", "m4b"],
        "ogg" => &["ogg", "oga", "ogv", "ogx", "opus"],
        "mkv" => &["mkv", "webm", "mka"],
        "doc" => &["doc", "xls", "ppt", "msi", "msg"],
        "xml" => &["xml", "svg", "xhtml", "rss", "plist"],
        _ => return false,
    };
    group.contains(&ext)
}

impl Registry {
    pub fn new() -> Self {
        Self::with_handlers(crate::formats::all_handlers())
    }

    pub fn with_handlers(handlers: Vec<Box<dyn FormatHandler>>) -> Self {
        Registry { handlers }
    }

    pub fn get(&self, id: &str) -> Option<&dyn FormatHandler> {
        self.handlers
            .iter()
            .find(|h| h.id() == id)
            .map(|h| h.as_ref())
    }

    pub fn list(&self) -> Vec<HandlerInfo> {
        self.handlers
            .iter()
            .map(|h| HandlerInfo {
                id: h.id().to_string(),
                model: h.model(),
                extensions: h.extensions().iter().map(|e| (*e).to_string()).collect(),
                capabilities: h.capabilities(),
                label_key: h.label_key().to_string(),
            })
            .collect()
    }

    /// Interroge tous les handlers et retient le plus confiant.
    /// Échoue (`NotFound`) seulement si aucun handler ne répond (registre sans repli).
    pub fn detect(&self, probe: &FileProbe) -> Result<Detected> {
        let mut answers: Vec<(&dyn FormatHandler, u8)> = self
            .handlers
            .iter()
            .filter_map(|h| h.detect(probe).map(|c| (h.as_ref(), c.0)))
            .collect();
        answers.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.id().cmp(b.0.id())));
        let Some((best, confidence)) = answers.first().copied() else {
            return Err(AppError::NotFound);
        };
        let signature_mismatch = infer::get(&probe.head)
            .map(|t| !extension_matches_signature(&probe.ext, t.extension()))
            .unwrap_or(false);
        Ok(Detected {
            handler_id: best.id().to_string(),
            model: best.model(),
            mime: probe.mime.clone(),
            label_key: best.label_key().to_string(),
            confidence,
            alternatives: answers[1..]
                .iter()
                .map(|(h, _)| h.id().to_string())
                .collect(),
            signature_mismatch,
        })
    }

    /// Exporte `doc` (issu du handler `source_id`) vers le format `target_id`.
    /// Cible de même modèle et écrivable → son `save` ; sinon `export` du handler source.
    pub fn export(
        &self,
        doc: &DocumentModel,
        source_id: &str,
        target_id: &str,
        path: &Path,
    ) -> Result<()> {
        let target = self.get(target_id).ok_or(AppError::NotFound)?;
        if target.model() == doc.kind() && target.capabilities().write {
            return target.save(doc, path);
        }
        let source = self.get(source_id).ok_or(AppError::NotFound)?;
        source.export(doc, target_id, path)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::handler::{Confidence, Fidelity};
    use crate::core::model::BinaryDoc;
    use std::sync::Mutex;

    struct Fake {
        id: &'static str,
        model: ModelKind,
        ext: &'static str,
        conf: u8,
        write: bool,
        saved: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(
            id: &'static str,
            model: ModelKind,
            ext: &'static str,
            conf: u8,
            write: bool,
        ) -> Self {
            Fake {
                id,
                model,
                ext,
                conf,
                write,
                saved: Mutex::new(vec![]),
            }
        }
    }

    impl FormatHandler for Fake {
        fn id(&self) -> &'static str {
            self.id
        }
        fn model(&self) -> ModelKind {
            self.model
        }
        fn extensions(&self) -> &'static [&'static str] {
            &[]
        }
        fn label_key(&self) -> &'static str {
            "formats.fake"
        }
        fn detect(&self, p: &FileProbe) -> Option<Confidence> {
            (p.ext == self.ext).then_some(Confidence(self.conf))
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                read: true,
                write: self.write,
                export_to: vec![],
                fidelity: Fidelity::Full,
            }
        }
        fn open(&self, _: &Path) -> Result<DocumentModel> {
            Ok(DocumentModel::Binary(BinaryDoc { size: 0 }))
        }
        fn save(&self, _: &DocumentModel, _: &Path) -> Result<()> {
            if self.write {
                self.saved.lock().unwrap().push("saved".into());
                Ok(())
            } else {
                Err(AppError::ReadOnly)
            }
        }
        fn export(&self, _: &DocumentModel, target: &str, _: &Path) -> Result<()> {
            if target == "special" {
                Ok(())
            } else {
                Err(AppError::Unsupported)
            }
        }
    }

    fn registry() -> Registry {
        Registry::with_handlers(vec![
            Box::new(Fake::new("b", ModelKind::Text, "txt", 60, true)),
            Box::new(Fake::new("a", ModelKind::Text, "txt", 60, true)),
            Box::new(Fake::new("c", ModelKind::Binary, "txt", 30, false)),
            Box::new(Fake::new("w", ModelKind::Sheet, "csv", 60, true)),
            Box::new(Fake::new("fallback", ModelKind::Binary, "", 1, false)),
        ])
    }

    #[test]
    fn real_registry_falls_back_to_binary() {
        let r = Registry::new();
        let d = r
            .detect(&FileProbe::from_bytes("x.zzz", &[0u8, 1, 2, 3, 0xFF]))
            .unwrap();
        assert_eq!(d.handler_id, "binary");
        assert_eq!(d.model, ModelKind::Binary);
        assert_eq!(d.confidence, 1);
        assert!(!d.signature_mismatch);
    }

    #[test]
    fn detect_sorts_by_confidence_then_id() {
        let d = registry()
            .detect(&FileProbe::from_bytes("f.txt", b"hello"))
            .unwrap();
        assert_eq!(d.handler_id, "a");
        assert_eq!(d.alternatives, vec!["b", "c"]);
        assert_eq!(d.label_key, "formats.fake");
    }

    #[test]
    fn detect_flags_signature_mismatch() {
        let pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
        let d = Registry::new()
            .detect(&FileProbe::from_bytes("image.png", pdf))
            .unwrap();
        assert!(d.signature_mismatch);
        assert_eq!(d.mime.as_deref(), Some("application/pdf"));
        let d = Registry::new()
            .detect(&FileProbe::from_bytes("doc.pdf", pdf))
            .unwrap();
        assert!(!d.signature_mismatch);
    }

    #[test]
    fn get_and_list() {
        let r = registry();
        assert!(r.get("w").is_some());
        assert!(r.get("nope").is_none());
        assert_eq!(r.list().len(), 5);
    }

    #[test]
    fn export_prefers_target_save_then_source_export() {
        let r = registry();
        let doc = DocumentModel::Text(crate::core::model::TextDoc {
            text: String::new(),
            encoding: "UTF-8".into(),
            bom: false,
            line_ending: crate::core::model::LineEnding::Lf,
            language: String::new(),
        });
        let p = Path::new("/tmp/x");
        // cible de même modèle et écrivable
        assert!(r.export(&doc, "c", "a", p).is_ok());
        // cible d'un autre modèle : délégué à la source
        assert!(matches!(
            r.export(&doc, "a", "w", p),
            Err(AppError::Unsupported)
        ));
        assert!(r.export(&doc, "a", "special", p).is_err()); // cible inconnue
        assert!(matches!(
            r.export(&doc, "zz", "c", p),
            Err(AppError::NotFound)
        ));
    }
}
