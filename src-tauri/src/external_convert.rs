//! Conversions déléguées à des moteurs externes (LibreOffice, pandoc) : jamais de shell,
//! arguments séparés, sortie dans un dossier temporaire puis copie atomique.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::core::atomic;
use crate::error::{AppError, Result};
use crate::external;

/// Durée maximale d'une conversion avant arrêt forcé du moteur.
pub const CONVERT_TIMEOUT: Duration = Duration::from_secs(180);

const LIBREOFFICE_TARGETS: &[&str] = &[
    "pdf", "docx", "odt", "rtf", "xlsx", "ods", "csv", "pptx", "odp",
];
const PANDOC_TARGETS: &[&str] = &["md", "html", "docx", "odt", "epub"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    LibreOffice,
    Pandoc,
}

fn engine_of(tool: &str) -> Option<Engine> {
    match tool {
        "soffice" | "libreoffice" => Some(Engine::LibreOffice),
        "pandoc" => Some(Engine::Pandoc),
        _ => None,
    }
}

/// Arguments du moteur (fonction pure). `profile_dir` : profil LibreOffice temporaire.
fn build_args(
    engine: Engine,
    src: &Path,
    out_dir: &Path,
    profile_dir: &Path,
    target_ext: &str,
) -> Vec<OsString> {
    match engine {
        Engine::LibreOffice => {
            let mut profile = OsString::from("-env:UserInstallation=file://");
            let p = profile_dir.to_string_lossy().replace('\\', "/");
            if !p.starts_with('/') {
                profile.push("/");
            }
            profile.push(p);
            vec![
                profile,
                "--headless".into(),
                "--convert-to".into(),
                target_ext.into(),
                "--outdir".into(),
                out_dir.into(),
                src.into(),
            ]
        }
        Engine::Pandoc => {
            let mut args: Vec<OsString> = vec!["-o".into()];
            args.push(output_path(src, out_dir, target_ext).into());
            if matches!(target_ext, "html" | "epub") {
                args.push("--standalone".into());
            }
            // `--` : une entrée ne peut jamais être prise pour une option.
            args.push("--".into());
            args.push(src.into());
            args
        }
    }
}

/// Fichier produit par le moteur dans le dossier de sortie.
fn output_path(src: &Path, out_dir: &Path, target_ext: &str) -> PathBuf {
    let mut out = out_dir.join(src.file_stem().unwrap_or_default());
    out.set_extension(target_ext);
    out
}

/// Lance la commande et la tue au-delà de `timeout`.
fn run_with_timeout(mut cmd: Command, timeout: Duration, stderr_file: &Path) -> Result<()> {
    let err = std::fs::File::create(stderr_file)?;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| AppError::External(e.to_string()))?;
    let start = Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let detail = std::fs::read_to_string(stderr_file).unwrap_or_default();
                let detail = detail.trim();
                return Err(AppError::External(if detail.is_empty() {
                    format!("code de sortie {status}")
                } else {
                    detail.chars().take(500).collect()
                }));
            }
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::External("délai dépassé".to_string()));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Chemin absolu canonique (le fichier peut ne pas exister : on canonicalise son dossier).
fn absolute(p: &Path) -> Result<PathBuf> {
    let full = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let name = p.file_name().ok_or(AppError::NotFound)?;
            let parent = match p.parent() {
                Some(d) if !d.as_os_str().is_empty() => d,
                _ => Path::new("."),
            };
            parent.canonicalize()?.join(name)
        }
    };
    // Windows : le préfixe verbatim `\\?\` n'est pas compris par tous les moteurs.
    #[cfg(windows)]
    if let Some(stripped) = full.to_string_lossy().strip_prefix(r"\\?\") {
        return Ok(PathBuf::from(stripped));
    }
    Ok(full)
}

/// Convertit `src` vers `dest` avec l'outil détecté `tool` (`soffice`, `libreoffice`, `pandoc`).
pub fn convert(tool: &str, src: &Path, dest: &Path, target_ext: &str) -> Result<()> {
    let engine = engine_of(tool)
        .ok_or_else(|| AppError::External(format!("outil non autorisé : {tool}")))?;
    let allowed = match engine {
        Engine::LibreOffice => LIBREOFFICE_TARGETS,
        Engine::Pandoc => PANDOC_TARGETS,
    };
    let target_ext = target_ext.to_ascii_lowercase();
    if !allowed.contains(&target_ext.as_str()) {
        return Err(AppError::External(format!(
            "format de sortie non supporté : {target_ext}"
        )));
    }
    if !src.is_file() {
        return Err(AppError::NotFound);
    }
    // Chemin absolu canonique : jamais lu comme une option par le moteur, et comparable à `dest`.
    let src = &absolute(src)?;
    if absolute(dest).is_ok_and(|d| d == *src) {
        return Err(AppError::External(
            "la destination est le fichier source".to_string(),
        ));
    }
    let exe = external::find_tools()
        .into_iter()
        .find(|t| t.name == tool)
        .ok_or_else(|| AppError::External(format!("outil introuvable : {tool}")))?;

    let work = tempfile::tempdir()?;
    let out_dir = work.path().join("out");
    let profile_dir = work.path().join("profile");
    std::fs::create_dir_all(&out_dir)?;
    let mut cmd = Command::new(&exe.path);
    cmd.args(build_args(engine, src, &out_dir, &profile_dir, &target_ext));
    run_with_timeout(cmd, CONVERT_TIMEOUT, &work.path().join("stderr.txt"))?;

    let produced = output_path(src, &out_dir, &target_ext);
    let bytes = std::fs::read(&produced)
        .map_err(|_| AppError::External("aucun fichier produit par le moteur".to_string()))?;
    atomic::write(dest, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strs(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn libreoffice_args() {
        let args = build_args(
            Engine::LibreOffice,
            Path::new("/d/a b.docx"),
            Path::new("/t/out"),
            Path::new("/t/profile"),
            "pdf",
        );
        assert_eq!(
            strs(&args),
            [
                "-env:UserInstallation=file:///t/profile",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                "/t/out",
                "/d/a b.docx"
            ]
        );
    }

    #[test]
    fn pandoc_args() {
        let args = build_args(
            Engine::Pandoc,
            Path::new("/d/note.md"),
            Path::new("/t/out"),
            Path::new("/t/profile"),
            "epub",
        );
        assert_eq!(
            strs(&args),
            ["-o", "/t/out/note.epub", "--standalone", "--", "/d/note.md"]
        );
    }

    #[test]
    fn unknown_tool_refused() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.docx");
        std::fs::write(&src, "x").unwrap();
        let err = convert("sh", &src, &dir.path().join("o.pdf"), "pdf").unwrap_err();
        assert!(matches!(err, AppError::External(_)));
    }

    #[test]
    fn unsupported_target_refused() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.docx");
        std::fs::write(&src, "x").unwrap();
        let err = convert("pandoc", &src, &dir.path().join("o.exe"), "exe").unwrap_err();
        assert!(matches!(err, AppError::External(_)));
    }

    #[test]
    fn same_source_and_dest_refused() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.md");
        std::fs::write(&src, "x").unwrap();
        // `pandoc` peut être absent : le refus intervient avant la recherche de l'outil.
        let err = convert("pandoc", &src, &dir.path().join("./a.md"), "md").unwrap_err();
        assert!(
            matches!(&err, AppError::External(m) if m.contains("source")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "x");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_process() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = Instant::now();
        let res = run_with_timeout(cmd, Duration::from_millis(200), &dir.path().join("e"));
        assert!(matches!(res, Err(AppError::External(_))));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
