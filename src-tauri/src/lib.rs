pub mod commands;
pub mod core;
pub mod error;
pub mod external;
pub mod formats;

use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_specta::{collect_commands, Builder};

use crate::commands::AppState;
use crate::core::registry::Registry;
use crate::core::watch::FileWatcher;

#[derive(Clone, Serialize)]
struct FileChanged {
    path: String,
}

/// Chemin du fichier de bindings TypeScript généré.
const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/bindings.ts");

fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::detect_file,
            commands::open_document,
            commands::save_document,
            commands::export_document,
            commands::list_handlers,
            commands::recovery_store,
            commands::recovery_list,
            commands::recovery_take,
            commands::recovery_discard,
            commands::watch_file,
            commands::unwatch_file,
            commands::allow_asset,
            commands::external_tools,
            commands::startup_paths,
            formats::sheet::csv::sheet_export_csv,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .dangerously_cast_bigints_to_number()
}

fn export_bindings(builder: &Builder<tauri::Wry>) -> Result<(), specta_typescript::Error> {
    builder.export(
        specta_typescript::Typescript::default().header("// @ts-nocheck\n/* eslint-disable */"),
        BINDINGS_PATH,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings(&builder) {
        eprintln!("export des bindings TypeScript impossible : {e}");
    }

    let typed = builder.invoke_handler();
    let raw: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![commands::read_bytes, commands::read_range];

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(move |invoke| {
            // `read_bytes` / `read_range` renvoient des octets bruts : hors bindings typés.
            match invoke.message.command() {
                "read_bytes" | "read_range" => raw(invoke),
                _ => typed(invoke),
            }
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let backups_dir = data.join("backups");
            let recovery_dir = data.join("recovery");
            std::fs::create_dir_all(&backups_dir)?;
            std::fs::create_dir_all(&recovery_dir)?;
            core::atomic::set_backup_dir(backups_dir.clone());

            let handle = app.handle().clone();
            let watcher = FileWatcher::new(move |path| {
                let _ = handle.emit(
                    "file-changed",
                    FileChanged {
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            })?;
            app.manage(AppState {
                registry: Arc::new(Registry::new()),
                watcher: Arc::new(watcher),
                backups_dir,
                recovery_dir,
            });
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("erreur au lancement de l'application : {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings() {
        let builder = super::specta_builder();
        super::export_bindings(&builder).expect("export des bindings TypeScript");
    }
}
