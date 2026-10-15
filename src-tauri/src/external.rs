//! Détection des outils externes optionnels (recherche dans le PATH, jamais de shell).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTool {
    pub name: String,
    pub path: String,
}

const TOOLS: &[&str] = &["soffice", "libreoffice", "pandoc", "ffmpeg"];

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let candidates: &[String] = &[name.to_string(), format!("{name}.exe")];
    dirs.iter()
        .flat_map(|d| candidates.iter().map(move |c| d.join(c)))
        .find(|p| is_executable(p))
}

fn find_tools_in(dirs: &[PathBuf]) -> Vec<ExternalTool> {
    TOOLS
        .iter()
        .filter_map(|name| {
            find_in(dirs, name).map(|p| ExternalTool {
                name: (*name).to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

pub fn find_tools() -> Vec<ExternalTool> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_tools_in(&dirs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finds_executables_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("pandoc");
        std::fs::write(&ok, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o755)).unwrap();
        let not_exec = dir.path().join("ffmpeg");
        std::fs::write(&not_exec, "x").unwrap();
        std::fs::set_permissions(&not_exec, std::fs::Permissions::from_mode(0o644)).unwrap();
        let tools = find_tools_in(&[dir.path().to_path_buf()]);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "pandoc");
    }
}
