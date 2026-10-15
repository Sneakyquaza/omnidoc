//! Autosave de récupération : un JSON par document dans `<app_data>/recovery/`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::atomic::write_atomic;
use crate::core::model::DocumentModel;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub doc_id: String,
    /// Chemin d'origine (vide pour un document jamais enregistré).
    pub path: String,
    pub model: DocumentModel,
    /// Horodatage RFC 3339.
    pub saved_at: String,
}

fn entry_path(dir: &Path, doc_id: &str) -> Result<PathBuf> {
    let valid = !doc_id.is_empty()
        && doc_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::Corrupt(
            "identifiant de récupération invalide".into(),
        ));
    }
    Ok(dir.join(format!("{doc_id}.json")))
}

pub fn store(dir: &Path, doc_id: &str, path: &str, model: &DocumentModel) -> Result<()> {
    let target = entry_path(dir, doc_id)?;
    std::fs::create_dir_all(dir)?;
    let entry = RecoveryEntry {
        doc_id: doc_id.to_string(),
        path: path.to_string(),
        model: model.clone(),
        saved_at: chrono::Local::now().to_rfc3339(),
    };
    let json = serde_json::to_vec(&entry).map_err(|e| AppError::Corrupt(e.to_string()))?;
    write_atomic(&target, &json, None)
}

fn read_entry(file: &Path) -> Result<RecoveryEntry> {
    let bytes = std::fs::read(file)?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::Corrupt(e.to_string()))
}

/// Entrées lisibles, les plus récentes d'abord ; les fichiers illisibles sont ignorés.
pub fn list(dir: &Path) -> Result<Vec<RecoveryEntry>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let mut out: Vec<RecoveryEntry> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| read_entry(&p).ok())
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

/// Lit puis supprime l'entrée.
pub fn take(dir: &Path, doc_id: &str) -> Result<RecoveryEntry> {
    let file = entry_path(dir, doc_id)?;
    if !file.is_file() {
        return Err(AppError::NotFound);
    }
    let entry = read_entry(&file)?;
    std::fs::remove_file(&file)?;
    Ok(entry)
}

pub fn discard(dir: &Path, doc_id: &str) -> Result<()> {
    let file = entry_path(dir, doc_id)?;
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::{BinaryDoc, ModelKind};

    fn doc(size: u64) -> DocumentModel {
        DocumentModel::Binary(BinaryDoc { size })
    }

    #[test]
    fn store_list_take_discard() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("recovery");
        assert!(list(&dir).unwrap().is_empty());
        store(&dir, "doc-1", "/a/b.txt", &doc(1)).unwrap();
        store(&dir, "doc-1", "/a/b.txt", &doc(2)).unwrap(); // écrasement
        store(&dir, "doc_2", "", &doc(3)).unwrap();
        assert_eq!(list(&dir).unwrap().len(), 2);

        let e = take(&dir, "doc-1").unwrap();
        assert_eq!(e.path, "/a/b.txt");
        assert_eq!(e.model.kind(), ModelKind::Binary);
        assert!(matches!(take(&dir, "doc-1"), Err(AppError::NotFound)));

        discard(&dir, "doc_2").unwrap();
        discard(&dir, "doc_2").unwrap(); // idempotent
        assert!(list(&dir).unwrap().is_empty());
    }

    #[test]
    fn rejects_unsafe_ids_and_skips_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(store(tmp.path(), "../evil", "", &doc(1)).is_err());
        assert!(take(tmp.path(), "").is_err());
        std::fs::write(tmp.path().join("bad.json"), "{not json").unwrap();
        assert!(list(tmp.path()).unwrap().is_empty());
    }
}
