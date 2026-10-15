//! Contrat d'un format : un format = un `FormatHandler`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::model::{DocumentModel, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

/// Confiance de détection 0..=100 : magic bytes 90, extension 60, heuristique 30, repli 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Confidence(pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Fidelity {
    Full,
    Partial,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub read: bool,
    pub write: bool,
    /// Identifiants de handlers cibles d'export.
    pub export_to: Vec<String>,
    pub fidelity: Fidelity,
}

pub trait FormatHandler: Send + Sync {
    /// Identifiant stable : "docx", "csv", "zip"…
    fn id(&self) -> &'static str;
    /// Modèle produit.
    fn model(&self) -> ModelKind;
    /// Extensions (dialogues, « Nouveau »).
    fn extensions(&self) -> &'static [&'static str];
    /// Clé i18n du libellé (ex. "formats.binary").
    fn label_key(&self) -> &'static str;
    fn detect(&self, probe: &FileProbe) -> Option<Confidence>;
    fn capabilities(&self) -> Capabilities;
    fn open(&self, path: &Path) -> Result<DocumentModel>;
    /// Doit écrire via `core::atomic`.
    fn save(&self, _doc: &DocumentModel, _path: &Path) -> Result<()> {
        Err(AppError::ReadOnly)
    }
    /// Conversion croisée vers `target` (id d'un autre handler).
    fn export(&self, _doc: &DocumentModel, _target: &str, _path: &Path) -> Result<()> {
        Err(AppError::Unsupported)
    }
}
