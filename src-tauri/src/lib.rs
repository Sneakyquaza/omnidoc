pub mod commands;
pub mod core;
pub mod error;
pub mod external;
pub mod external_convert;
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

#[derive(Clone, Serialize)]
struct OpenPaths {
    paths: Vec<String>,
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
            commands::convert_external,
            commands::startup_paths,
            formats::text::text_encodings,
            formats::text::text_reopen_with_encoding,
            formats::image::image_preview_png,
            formats::image::image_save,
            formats::image::image_strip_metadata,
            formats::image::image_convert,
            formats::svg::svg_render_png,
            formats::pdf::pdf_merge,
            formats::pdf::pdf_split,
            formats::pdf::pdf_extract,
            formats::pdf::pdf_delete_pages,
            formats::pdf::pdf_rotate,
            formats::pdf::pdf_reorder,
            formats::pdf::pdf_annotate,
            formats::pdf::pdf_list_annotations,
            formats::sheet::csv::sheet_export_csv,
            formats::sqlite::db_rows,
            formats::sqlite::db_query,
            formats::sqlite::db_export_csv,
            formats::sqlite::db_schema,
            formats::archive::archive_extract,
            formats::archive::archive_read_entry,
            formats::archive::archive_add,
            formats::archive::archive_remove,
            formats::archive::archive_rename,
            formats::archive::archive_create,
            formats::archive::archive_convert,
            formats::media::media_cover,
            formats::media::media_set_cover,
            formats::media::media_trim,
            formats::media::media_convert,
            formats::media::media_ffmpeg_available,
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

    let mut app_builder = tauri::Builder::default();
    // Doit être le premier plugin : une 2ᵉ instance transmet ses arguments à la première.
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = commands::resolve_paths(argv.into_iter().skip(1), &cwd);
            if !paths.is_empty() {
                let _ = app.emit("open-paths", OpenPaths { paths });
            }
            focus_main_window(app);
        }));
    }

    let result = app_builder
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
            formats::archive::cleanup_entries();
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
        .build(tauri::generate_context!());

    match result {
        Ok(app) => app.run(|_handle, _event| {
            // macOS : ouverture de fichiers par le Finder (double-clic, « Ouvrir avec »).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    let _ = _handle.emit("open-paths", OpenPaths { paths });
                    focus_main_window(_handle);
                }
            }
        }),
        Err(e) => {
            eprintln!("erreur au lancement de l'application : {e}");
            std::process::exit(1);
        }
    }
}

/// Remet la fenêtre principale au premier plan.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.webview_windows().into_values().next() {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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
