//! Audio/vidéo : métadonnées via `lofty` (lecture, tags, pochette) ; découpe/conversion via ffmpeg.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::picture::{Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem};
use tauri::State;

use crate::commands::AppState;
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::model::{DocumentModel, KeyValue, MediaDoc, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::external;

const EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aiff", "mp4", "m4v", "webm", "mkv",
    "mov", "avi",
];

/// Taille max d'une image de pochette importée.
const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;
/// Durée max d'une commande ffmpeg.
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Clés normalisées du modèle ↔ clés lofty.
const NORMALIZED: &[(&str, ItemKey)] = &[
    ("title", ItemKey::TrackTitle),
    ("artist", ItemKey::TrackArtist),
    ("album", ItemKey::AlbumTitle),
    ("albumArtist", ItemKey::AlbumArtist),
    ("year", ItemKey::RecordingDate),
    ("track", ItemKey::TrackNumber),
    ("trackTotal", ItemKey::TrackTotal),
    ("disc", ItemKey::DiscNumber),
    ("genre", ItemKey::Genre),
    ("comment", ItemKey::Comment),
    ("composer", ItemKey::Composer),
    ("lyrics", ItemKey::Lyrics),
];

fn normalized_name(key: &ItemKey) -> Option<&'static str> {
    NORMALIZED.iter().find(|(_, k)| k == key).map(|(n, _)| *n)
}

pub struct MediaHandler;

fn lofty_err(e: impl std::fmt::Display) -> AppError {
    AppError::Corrupt(e.to_string())
}

fn mime_of(probe_mime: Option<&str>, ext: &str) -> String {
    if let Some(m) = probe_mime.filter(|m| m.starts_with("audio/") || m.starts_with("video/")) {
        return m.to_string();
    }
    match ext {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "aiff" => "audio/aiff",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Tag principal du fichier, sinon le premier.
fn main_tag(file: &TaggedFile) -> Option<&Tag> {
    file.primary_tag().or_else(|| file.first_tag())
}

/// Paires (clé lofty, clé du modèle, valeur) des items texte d'un tag.
fn read_pairs(tag: &Tag) -> Vec<(ItemKey, String, String)> {
    tag.items()
        .filter_map(|item| {
            let ItemValue::Text(value) = item.value() else {
                return None;
            };
            let key = item.key();
            let name = match normalized_name(&key) {
                Some(n) => n.to_string(),
                None => key.map_key(tag.tag_type())?.to_string(),
            };
            Some((key, name, value.clone()))
        })
        .collect()
}

fn resolve_key(tag: &Tag, name: &str) -> Option<ItemKey> {
    NORMALIZED
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| *k)
        .or_else(|| ItemKey::from_key(tag.tag_type(), name))
}

/// Équivalent de `lofty::read_from_path`, sans lecture des propriétés pour l'AAC (ADTS) : lofty 0.25
/// boucle indéfiniment dans `aac::read::find_next_frame` sur certains flux corrompus (trouvé au fuzzing).
fn read_tagged(path: &Path) -> std::result::Result<TaggedFile, String> {
    let mut probe = Probe::open(path).map_err(|e| e.to_string())?;
    if probe.file_type().is_none() {
        probe = probe.guess_file_type().map_err(|e| e.to_string())?;
    }
    if probe.file_type() == Some(FileType::Aac) {
        probe = probe.options(ParseOptions::new().read_properties(false));
    }
    probe.read().map_err(|e| e.to_string())
}

fn probe_file(path: &Path) -> Result<Option<TaggedFile>> {
    // Format inconnu de lofty (webm, mkv, avi…) ou illisible : ouverture sans métadonnées.
    Ok(read_tagged(path).ok())
}

fn writable(file: &TaggedFile) -> bool {
    let tt = main_tag(file)
        .map(|t| t.tag_type())
        .unwrap_or_else(|| file.primary_tag_type());
    file.file_type().tag_support(tt).is_writable()
}

/// Applique `f` sur une copie temporaire du fichier, enregistre les tags dessus puis remplace
/// l'original de façon atomique (lofty écrit sur place).
fn edit_tags(path: &Path, f: impl FnOnce(&mut Tag) -> Result<()>) -> Result<()> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    // Même extension que l'original : lofty s'en sert pour identifier le format.
    let suffix = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let tmp = tempfile::Builder::new()
        .prefix(".omnidoc-")
        .suffix(&suffix)
        .tempfile_in(parent)?;
    std::fs::copy(path, tmp.path())?;
    let mut file = read_tagged(tmp.path()).map_err(lofty_err)?;
    if !writable(&file) {
        return Err(AppError::ReadOnly);
    }
    let tt = main_tag(&file)
        .map(|t| t.tag_type())
        .unwrap_or_else(|| file.primary_tag_type());
    if file.tag(tt).is_none() {
        file.insert_tag(Tag::new(tt));
    }
    let tag = file.tag_mut(tt).ok_or(AppError::Unsupported)?;
    f(tag)?;
    file.save_to_path(tmp.path(), WriteOptions::default())
        .map_err(lofty_err)?;
    atomic::replace_with(path, tmp.path())
}

fn apply_tags(tag: &mut Tag, tags: &[KeyValue]) {
    // Efface d'abord tout ce que `open` exposait, puis réinsère le contenu du modèle.
    let mut known: Vec<ItemKey> = read_pairs(tag).into_iter().map(|(k, _, _)| k).collect();
    known.dedup();
    for k in known {
        tag.remove_key(k);
    }
    for kv in tags {
        if kv.value.is_empty() {
            continue;
        }
        if let Some(key) = resolve_key(tag, &kv.key) {
            tag.push(TagItem::new(key, ItemValue::Text(kv.value.clone())));
        }
    }
}

impl FormatHandler for MediaHandler {
    fn id(&self) -> &'static str {
        "media"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Media
    }

    fn extensions(&self) -> &'static [&'static str] {
        EXTENSIONS
    }

    fn label_key(&self) -> &'static str {
        "formats.media"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let by_magic = probe
            .mime
            .as_deref()
            .is_some_and(|m| m.starts_with("audio/") || m.starts_with("video/"));
        if by_magic {
            Some(Confidence(90))
        } else if EXTENSIONS.contains(&probe.ext.as_str()) {
            Some(Confidence(60))
        } else {
            None
        }
    }

    /// `write` : les tags ne sont écrits que pour les formats connus de lofty ; `save` renvoie
    /// `ReadOnly` pour les autres (webm, mkv, avi…).
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: vec![],
            fidelity: Fidelity::Partial,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let mut head = Vec::new();
        std::fs::File::open(path)?
            .take(crate::core::limits::PROBE_HEAD_BYTES as u64)
            .read_to_end(&mut head)?;
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mime = mime_of(infer::get(&head).map(|t| t.mime_type()), &ext);
        let Some(file) = probe_file(path)? else {
            return Ok(DocumentModel::Media(MediaDoc {
                mime,
                duration_ms: None,
                tags: vec![],
                pictures: 0,
            }));
        };
        let (tags, pictures) = match main_tag(&file) {
            Some(tag) => (
                read_pairs(tag)
                    .into_iter()
                    .map(|(_, key, value)| KeyValue { key, value })
                    .collect(),
                tag.picture_count(),
            ),
            None => (vec![], 0),
        };
        let duration_ms = u64::try_from(file.properties().duration().as_millis()).ok();
        Ok(DocumentModel::Media(MediaDoc {
            mime,
            duration_ms,
            tags,
            pictures,
        }))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        let DocumentModel::Media(media) = doc else {
            return Err(AppError::Unsupported);
        };
        if probe_file(path)?.is_none() {
            return Err(AppError::ReadOnly);
        }
        edit_tags(path, |tag| {
            apply_tags(tag, &media.tags);
            Ok(())
        })
    }
}

// --- Commandes ---

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::Internal)?
}

fn cover_data_uri(path: &Path) -> Result<Option<String>> {
    let Some(file) = probe_file(path)? else {
        return Ok(None);
    };
    let Some(pic) = main_tag(&file).and_then(|t| t.pictures().first()) else {
        return Ok(None);
    };
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .or_else(|| infer::get(pic.data()).map(|t| t.mime_type().to_string()))
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Data URI (`data:<mime>;base64,…`) de la première pochette, ou `null`.
#[tauri::command]
#[specta::specta]
pub async fn media_cover(path: String) -> Result<Option<String>> {
    blocking(move || cover_data_uri(Path::new(&path))).await
}

/// Remplace la pochette avant par l'image `image_path`, ou supprime toutes les pochettes si `null`.
#[tauri::command]
#[specta::specta]
pub async fn media_set_cover(
    state: State<'_, AppState>,
    path: String,
    image_path: Option<String>,
) -> Result<()> {
    let watcher = Arc::clone(&state.watcher);
    blocking(move || {
        let picture = match &image_path {
            Some(img) => {
                if std::fs::metadata(img)?.len() > MAX_COVER_BYTES {
                    return Err(AppError::TooLarge);
                }
                let mut file = std::fs::File::open(img)?;
                let mut pic = Picture::from_reader(&mut file).map_err(lofty_err)?;
                pic.set_pic_type(PictureType::CoverFront);
                Some(pic)
            }
            None => None,
        };
        let p = Path::new(&path);
        watcher.mark_self_write(p);
        let res = edit_tags(p, |tag| {
            match picture {
                Some(pic) => {
                    tag.remove_picture_type(PictureType::CoverFront);
                    tag.push_picture(pic);
                }
                None => {
                    while tag.picture_count() > 0 {
                        tag.remove_picture(0);
                    }
                }
            }
            Ok(())
        });
        watcher.mark_self_write(p);
        res
    })
    .await
}

fn ffmpeg_path() -> Result<String> {
    external::find_tools()
        .into_iter()
        .find(|t| t.name == "ffmpeg")
        .map(|t| t.path)
        .ok_or_else(|| AppError::External("ffmpeg".into()))
}

/// Refuse les playlists / scripts de concaténation (HLS, concat, SDP…) qui référencent d'autres
/// ressources : détectés par extension et par signature.
fn reject_playlist(input: &Path) -> Result<()> {
    let ext = input
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut head = [0u8; 16];
    let n = File::open(input)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    let head = &head[..n];
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    if matches!(
        ext.as_str(),
        "m3u" | "m3u8" | "ffconcat" | "sdp" | "pls" | "mpd"
    ) || head.starts_with(b"#EXTM3U")
        || head.starts_with(b"ffconcat")
        || head.starts_with(b"v=0")
    {
        return Err(AppError::Unsupported);
    }
    Ok(())
}

/// Lance ffmpeg (args séparés, sans shell) vers un fichier temporaire de même extension que
/// `dest`, puis remplace `dest` de façon atomique.
fn run_ffmpeg(
    pre_input: &[String],
    input: &Path,
    post_input: &[String],
    dest: &Path,
    suffix: &str,
) -> Result<()> {
    reject_playlist(input)?;
    let ffmpeg = ffmpeg_path()?;
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let tmp = tempfile::Builder::new()
        .prefix(".omnidoc-")
        .suffix(suffix)
        .tempfile_in(parent)?;
    let mut cmd = Command::new(ffmpeg);
    // `-y` ne concerne que notre fichier temporaire, jamais la destination réelle.
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
        .args(pre_input)
        // Pas de réseau ni de protocoles annexes (`concat:`, `subfile:`…) via un fichier piégé.
        .args(["-protocol_whitelist", "file"])
        .arg("-i")
        .arg(input)
        .args(post_input)
        .arg(tmp.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::External(format!("ffmpeg: {e}")))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None if start.elapsed() > FFMPEG_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::External("ffmpeg: timeout".into()));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(s) = child.stderr.take() {
            let _ = s.take(4096).read_to_string(&mut err);
        }
        let last = err.lines().last().unwrap_or("").trim().to_string();
        return Err(AppError::External(format!("ffmpeg: {last}")));
    }
    atomic::replace_with(dest, tmp.path())
}

fn seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// Extrait [start_ms, end_ms] sans réencodage (`-c copy`) vers `dest`.
#[tauri::command]
#[specta::specta]
pub async fn media_trim(path: String, start_ms: u64, end_ms: u64, dest: String) -> Result<()> {
    if end_ms <= start_ms {
        return Err(AppError::Unsupported);
    }
    blocking(move || {
        let pre = vec!["-ss".to_string(), seconds(start_ms)];
        let post = vec![
            "-t".to_string(),
            seconds(end_ms - start_ms),
            "-c".to_string(),
            "copy".to_string(),
        ];
        let dest = Path::new(&dest);
        let suffix = dest
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        run_ffmpeg(&pre, Path::new(&path), &post, dest, &suffix)
    })
    .await
}

/// Convertit vers `format` (extension de sortie : "mp3", "ogg", "flac", "wav", "mp4"…).
#[tauri::command]
#[specta::specta]
pub async fn media_convert(path: String, dest: String, format: String) -> Result<()> {
    if format.is_empty() || format.len() > 8 || !format.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Unsupported);
    }
    blocking(move || {
        // Le conteneur de sortie est choisi par l'extension du fichier temporaire.
        run_ffmpeg(
            &[],
            Path::new(&path),
            &[],
            Path::new(&dest),
            &format!(".{format}"),
        )
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn media_ffmpeg_available() -> bool {
    external::find_tools().iter().any(|t| t.name == "ffmpeg")
}

#[cfg(test)]
mod tests;
