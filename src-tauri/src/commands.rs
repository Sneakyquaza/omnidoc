//! Commandes Tauri : fines, elles délèguent au cœur. Travail lourd en `spawn_blocking`.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use crate::core::handler::Capabilities;
use crate::core::limits::{MAX_OPEN_BYTES, MAX_RANGE_LEN};
use crate::core::model::DocumentModel;
use crate::core::probe::FileProbe;
use crate::core::recovery::{self, RecoveryEntry};
use crate::core::registry::{Detected, HandlerInfo, Registry};
use crate::core::watch::FileWatcher;
use crate::error::{AppError, Result};
use crate::external::{self, ExternalTool};

pub struct AppState {
    pub registry: Arc<Registry>,
    pub watcher: Arc<FileWatcher>,
    pub backups_dir: PathBuf,
    pub recovery_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub doc_id: String,
    pub path: String,
    pub handler_id: String,
    pub model: DocumentModel,
    pub capabilities: Capabilities,
    pub detected: Detected,
    /// Clés i18n `warnings.*`.
    pub warnings: Vec<String>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::External(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn detect_file(state: State<'_, AppState>, path: String) -> Result<Detected> {
    let registry = Arc::clone(&state.registry);
    blocking(move || registry.detect(&FileProbe::from_path(Path::new(&path))?)).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_document(
    state: State<'_, AppState>,
    path: String,
    forced_handler: Option<String>,
) -> Result<OpenedDocument> {
    let registry = Arc::clone(&state.registry);
    blocking(move || {
        let probe = FileProbe::from_path(Path::new(&path))?;
        let detected = registry.detect(&probe)?;
        let mut warnings = Vec::new();
        let mut handler_id = match &forced_handler {
            Some(id) => id.clone(),
            None => detected.handler_id.clone(),
        };
        if forced_handler.is_none() && detected.signature_mismatch {
            warnings.push("warnings.signatureMismatch".to_string());
        }
        if probe.size > MAX_OPEN_BYTES && handler_id != "binary" {
            if forced_handler.is_some() {
                return Err(AppError::TooLarge);
            }
            // Détection automatique : repli sur l'hexa par plages.
            handler_id = "binary".to_string();
            warnings.push("warnings.tooLargeHex".to_string());
        }
        let handler = registry.get(&handler_id).ok_or(AppError::NotFound)?;
        let model = handler.open(Path::new(&path))?;
        Ok(OpenedDocument {
            doc_id: uuid::Uuid::new_v4().to_string(),
            path,
            handler_id,
            model,
            capabilities: handler.capabilities(),
            detected,
            warnings,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_document(
    state: State<'_, AppState>,
    path: String,
    handler_id: String,
    model: DocumentModel,
) -> Result<()> {
    let registry = Arc::clone(&state.registry);
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let handler = registry.get(&handler_id).ok_or(AppError::NotFound)?;
        let path = Path::new(&path);
        watcher.mark_self_write(path);
        let res = handler.save(&model, path);
        watcher.mark_self_write(path);
        res
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn export_document(
    state: State<'_, AppState>,
    model: DocumentModel,
    source_handler_id: String,
    target_handler_id: String,
    dest_path: String,
) -> Result<()> {
    let registry = Arc::clone(&state.registry);
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let dest = Path::new(&dest_path);
        watcher.mark_self_write(dest);
        let res = registry.export(&model, &source_handler_id, &target_handler_id, dest);
        watcher.mark_self_write(dest);
        res
    })
    .await
}

/// Octets bruts du fichier (réponse binaire, hors JSON).
#[tauri::command]
pub async fn read_bytes(path: String) -> Result<Response> {
    blocking(move || {
        if std::fs::metadata(&path)?.len() > MAX_OPEN_BYTES {
            return Err(AppError::TooLarge);
        }
        Ok(Response::new(std::fs::read(&path)?))
    })
    .await
}

/// Plage d'octets (`len` plafonné à 1 Mio) ; renvoie moins d'octets en fin de fichier.
#[tauri::command]
pub async fn read_range(path: String, offset: u64, len: u32) -> Result<Response> {
    blocking(move || {
        let len = len.min(MAX_RANGE_LEN) as u64;
        let mut file = std::fs::File::open(&path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut buf = Vec::new();
        file.take(len).read_to_end(&mut buf)?;
        Ok(Response::new(buf))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_handlers(state: State<'_, AppState>) -> Result<Vec<HandlerInfo>> {
    Ok(state.registry.list())
}

#[tauri::command]
#[specta::specta]
pub async fn recovery_store(
    state: State<'_, AppState>,
    doc_id: String,
    path: String,
    model: DocumentModel,
) -> Result<()> {
    let dir = state.recovery_dir.clone();
    blocking(move || recovery::store(&dir, &doc_id, &path, &model)).await
}

#[tauri::command]
#[specta::specta]
pub async fn recovery_list(state: State<'_, AppState>) -> Result<Vec<RecoveryEntry>> {
    let dir = state.recovery_dir.clone();
    blocking(move || recovery::list(&dir)).await
}

#[tauri::command]
#[specta::specta]
pub async fn recovery_take(state: State<'_, AppState>, doc_id: String) -> Result<RecoveryEntry> {
    let dir = state.recovery_dir.clone();
    blocking(move || recovery::take(&dir, &doc_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn recovery_discard(state: State<'_, AppState>, doc_id: String) -> Result<()> {
    let dir = state.recovery_dir.clone();
    blocking(move || recovery::discard(&dir, &doc_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn watch_file(state: State<'_, AppState>, path: String) -> Result<()> {
    state.watcher.watch(Path::new(&path))
}

#[tauri::command]
#[specta::specta]
pub async fn unwatch_file(state: State<'_, AppState>, path: String) -> Result<()> {
    state.watcher.unwatch(Path::new(&path))
}

/// Autorise le protocole `asset:` à servir ce fichier (lecture média/PDF/image).
#[tauri::command]
#[specta::specta]
pub async fn allow_asset(app: AppHandle, path: String) -> Result<()> {
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| AppError::External(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn external_tools() -> Result<Vec<ExternalTool>> {
    blocking(|| Ok(external::find_tools())).await
}

fn paths_from_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter(|a| !a.is_empty() && !a.starts_with('-'))
        .collect()
}

/// Fichiers passés en argument au lancement (flags ignorés).
#[tauri::command]
#[specta::specta]
pub async fn startup_paths() -> Result<Vec<String>> {
    Ok(paths_from_args(std::env::args().skip(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_args_ignore_flags() {
        let args = ["--foo", "a.txt", "-x", "", "/b/c.md"].map(String::from);
        assert_eq!(paths_from_args(args.into_iter()), vec!["a.txt", "/b/c.md"]);
    }
}
