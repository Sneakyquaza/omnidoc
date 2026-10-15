//! Repli universel : tout fichier s'ouvre en hexadécimal, en lecture seule.

use std::path::Path;

use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::model::{BinaryDoc, DocumentModel, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::Result;

pub struct BinaryHandler;

impl FormatHandler for BinaryHandler {
    fn id(&self) -> &'static str {
        "binary"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Binary
    }

    fn extensions(&self) -> &'static [&'static str] {
        &[]
    }

    fn label_key(&self) -> &'static str {
        "formats.binary"
    }

    fn detect(&self, _probe: &FileProbe) -> Option<Confidence> {
        Some(Confidence(1))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let size = std::fs::metadata(path)?.len();
        Ok(DocumentModel::Binary(BinaryDoc { size }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_everything_and_opens() {
        let h = BinaryHandler;
        let probe = FileProbe::from_bytes("x.bin", &[1, 2, 3]);
        assert_eq!(h.detect(&probe), Some(Confidence(1)));
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, [0u8; 10]).unwrap();
        match h.open(&f).unwrap() {
            DocumentModel::Binary(b) => assert_eq!(b.size, 10),
            _ => panic!("modèle inattendu"),
        }
        assert!(matches!(
            h.save(&h.open(&f).unwrap(), &f),
            Err(crate::error::AppError::ReadOnly)
        ));
    }
}
