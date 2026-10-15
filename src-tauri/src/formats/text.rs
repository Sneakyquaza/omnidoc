//! Texte et code : un seul handler pour txt/log et ~50 extensions de code ou de données,
//! plus le handler Markdown (même modèle, langage "markdown", export HTML).

use std::path::Path;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, LineEnding, ModelKind, TextDoc};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

/// (extension, langage, confiance). html/htm/xml restent sous les handlers spécialisés, svg à 30.
const EXT_TABLE: &[(&str, &str, u8)] = &[
    ("txt", "plaintext", 60),
    ("log", "plaintext", 60),
    ("py", "python", 60),
    ("rs", "rust", 60),
    ("js", "javascript", 60),
    ("mjs", "javascript", 60),
    ("cjs", "javascript", 60),
    ("jsx", "jsx", 60),
    ("ts", "typescript", 60),
    ("tsx", "tsx", 60),
    ("c", "c", 60),
    ("h", "c", 60),
    ("cpp", "cpp", 60),
    ("hpp", "cpp", 60),
    ("cc", "cpp", 60),
    ("cs", "csharp", 60),
    ("java", "java", 60),
    ("kt", "kotlin", 60),
    ("go", "go", 60),
    ("rb", "ruby", 60),
    ("php", "php", 60),
    ("sh", "shell", 60),
    ("bash", "shell", 60),
    ("zsh", "shell", 60),
    ("ps1", "powershell", 60),
    ("bat", "batch", 60),
    ("css", "css", 60),
    ("scss", "scss", 60),
    ("less", "less", 60),
    ("html", "html", 55),
    ("htm", "html", 55),
    ("vue", "vue", 60),
    ("svelte", "svelte", 60),
    ("sql", "sql", 60),
    ("lua", "lua", 60),
    ("r", "r", 60),
    ("swift", "swift", 60),
    ("dart", "dart", 60),
    ("scala", "scala", 60),
    ("pl", "perl", 60),
    ("json", "json", 60),
    ("jsonc", "json", 60),
    ("yaml", "yaml", 60),
    ("yml", "yaml", 60),
    ("toml", "toml", 60),
    ("xml", "xml", 55),
    ("svg", "xml", 30),
    ("ini", "ini", 60),
    ("cfg", "ini", 60),
    ("conf", "ini", 60),
    ("env", "ini", 60),
    ("properties", "ini", 60),
    ("gitignore", "plaintext", 60),
    ("dockerfile", "dockerfile", 60),
    ("makefile", "makefile", 60),
];

const EXTENSIONS: &[&str] = &[
    "txt",
    "log",
    "py",
    "rs",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cs",
    "java",
    "kt",
    "go",
    "rb",
    "php",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "css",
    "scss",
    "less",
    "html",
    "htm",
    "vue",
    "svelte",
    "sql",
    "lua",
    "r",
    "swift",
    "dart",
    "scala",
    "pl",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "xml",
    "svg",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "gitignore",
    "dockerfile",
    "makefile",
];

/// Fichiers reconnus par leur nom complet (minuscules) : (nom, langage).
const NAME_TABLE: &[(&str, &str)] = &[
    ("dockerfile", "dockerfile"),
    ("makefile", "makefile"),
    ("gnumakefile", "makefile"),
    ("readme", "plaintext"),
    ("license", "plaintext"),
    (".gitignore", "plaintext"),
    (".env", "ini"),
];

/// Encodages proposés dans les menus « Réouvrir / Enregistrer avec l'encodage » (noms encoding_rs).
const ENCODINGS: &[&str] = &[
    "UTF-8",
    "UTF-16LE",
    "UTF-16BE",
    "windows-1252",
    "windows-1250",
    "windows-1251",
    "windows-1253",
    "windows-1254",
    "windows-1255",
    "windows-1256",
    "windows-1257",
    "windows-1258",
    "windows-874",
    "ISO-8859-2",
    "ISO-8859-3",
    "ISO-8859-4",
    "ISO-8859-5",
    "ISO-8859-6",
    "ISO-8859-7",
    "ISO-8859-8",
    "ISO-8859-10",
    "ISO-8859-13",
    "ISO-8859-14",
    "ISO-8859-15",
    "ISO-8859-16",
    "KOI8-R",
    "KOI8-U",
    "IBM866",
    "macintosh",
    "x-mac-cyrillic",
    "Shift_JIS",
    "EUC-JP",
    "EUC-KR",
    "GBK",
    "gb18030",
    "Big5",
];

/// Encodages supportés en lecture et en écriture (noms encoding_rs).
pub fn supported_encodings() -> &'static [&'static str] {
    ENCODINGS
}

fn file_name_lower(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn language_by_name(path: &Path) -> Option<&'static str> {
    let name = file_name_lower(path);
    NAME_TABLE.iter().find(|(n, _)| *n == name).map(|(_, l)| *l)
}

fn ext_entry(ext: &str) -> Option<&'static (&'static str, &'static str, u8)> {
    EXT_TABLE.iter().find(|(e, _, _)| *e == ext)
}

/// Langage deviné par nom de fichier puis extension ("plaintext" par défaut).
fn guess_language(path: &Path) -> &'static str {
    if let Some(l) = language_by_name(path) {
        return l;
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    ext_entry(&ext).map(|(_, l, _)| *l).unwrap_or("plaintext")
}

pub struct TextHandler;

impl FormatHandler for TextHandler {
    fn id(&self) -> &'static str {
        "text"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Text
    }

    fn extensions(&self) -> &'static [&'static str] {
        EXTENSIONS
    }

    fn label_key(&self) -> &'static str {
        "formats.text"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        if !probe.is_text {
            return None;
        }
        if language_by_name(&probe.path).is_some() {
            return Some(Confidence(60));
        }
        let conf = ext_entry(&probe.ext).map(|(_, _, c)| *c).unwrap_or(30);
        Some(Confidence(conf))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: vec![],
            fidelity: Fidelity::Full,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Text(open_text(
            path,
            guess_language(path),
            None,
        )?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        save_text(doc, path)
    }
}

pub struct MarkdownHandler;

impl FormatHandler for MarkdownHandler {
    fn id(&self) -> &'static str {
        "markdown"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Text
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["md", "markdown", "mdown"]
    }

    fn label_key(&self) -> &'static str {
        "formats.markdown"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        (probe.is_text && self.extensions().contains(&probe.ext.as_str())).then_some(Confidence(70))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: vec!["html".to_string()],
            fidelity: Fidelity::Full,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Text(open_text(path, "markdown", None)?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        save_text(doc, path)
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        let DocumentModel::Text(t) = doc else {
            return Err(AppError::Unsupported);
        };
        if target != "html" {
            return Err(AppError::Unsupported);
        }
        let title = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        atomic::write(path, markdown_to_html(&t.text, &title).as_bytes())
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Document HTML complet (tables, tâches, barré, notes). Le HTML brut du Markdown est conservé,
/// mais une CSP `script-src 'none'` neutralise les scripts à l'ouverture du fichier exporté.
fn markdown_to_html(md: &str, title: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES;
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(md, opts));
    format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\">\n\
         <title>{}</title>\n</head>\n<body>\n{}</body>\n</html>\n",
        escape_html(title),
        body
    )
}

// --- Décodage / encodage ---

fn detect_line_ending(text: &str) -> LineEnding {
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut iter = text.bytes().peekable();
    while let Some(b) = iter.next() {
        match b {
            b'\r' => {
                if iter.peek() == Some(&b'\n') {
                    iter.next();
                    crlf += 1;
                } else {
                    cr += 1;
                }
            }
            b'\n' => lf += 1,
            _ => {}
        }
    }
    if lf >= crlf && lf >= cr {
        LineEnding::Lf
    } else if crlf >= cr {
        LineEnding::Crlf
    } else {
        LineEnding::Cr
    }
}

fn normalize_newlines(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn decode_with(enc: &'static Encoding, bytes: &[u8]) -> Option<String> {
    enc.decode_without_bom_handling_and_without_replacement(bytes)
        .map(|c| c.into_owned())
}

fn invalid_bytes(enc: &'static Encoding) -> AppError {
    AppError::Corrupt(format!("octets invalides pour l'encodage {}", enc.name()))
}

/// Décode `bytes` : encodage forcé, sinon BOM, UTF-8 valide, puis détection chardetng.
fn decode(
    bytes: &[u8],
    forced: Option<&'static Encoding>,
) -> Result<(String, &'static Encoding, bool)> {
    let bom = Encoding::for_bom(bytes);
    if let Some(enc) = forced {
        let (skip, has_bom) = match bom {
            Some((b, len)) if b == enc => (len, true),
            _ => (0, false),
        };
        let body = bytes.get(skip..).unwrap_or_default();
        let text = decode_with(enc, body).ok_or_else(|| invalid_bytes(enc))?;
        return Ok((text, enc, has_bom));
    }
    if let Some((enc, len)) = bom {
        let body = bytes.get(len..).unwrap_or_default();
        let text = decode_with(enc, body).ok_or_else(|| invalid_bytes(enc))?;
        return Ok((text, enc, true));
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok((s.to_string(), UTF_8, false));
    }
    let mut det = EncodingDetector::new(Iso2022JpDetection::Deny);
    let sample = bytes.get(..bytes.len().min(1024 * 1024)).unwrap_or(bytes);
    det.feed(sample, true);
    let guess = det.guess(None, Utf8Detection::Deny);
    if let Some(text) = decode_with(guess, bytes) {
        return Ok((text, guess, false));
    }
    let fallback = encoding_rs::WINDOWS_1252;
    let text = decode_with(fallback, bytes).ok_or_else(|| invalid_bytes(fallback))?;
    Ok((text, fallback, false))
}

fn open_text(path: &Path, language: &str, forced: Option<&'static Encoding>) -> Result<TextDoc> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    let bytes = std::fs::read(path)?;
    let (raw, enc, bom) = decode(&bytes, forced)?;
    Ok(TextDoc {
        line_ending: detect_line_ending(&raw),
        text: normalize_newlines(&raw),
        encoding: enc.name().to_string(),
        bom,
        language: language.to_string(),
    })
}

/// Premier caractère non représentable dans `enc`, pour un message d'erreur explicite.
fn first_unmappable(text: &str, enc: &'static Encoding) -> Option<char> {
    let mut buf = [0u8; 4];
    text.chars().find(|c| {
        let (_, _, unmappable) = enc.encode(c.encode_utf8(&mut buf));
        unmappable
    })
}

fn supported_encoding(label: &str) -> Result<&'static Encoding> {
    Encoding::for_label(label.as_bytes())
        .filter(|e| ENCODINGS.contains(&e.name()))
        .ok_or(AppError::Unsupported)
}

fn encode_text(doc: &TextDoc) -> Result<Vec<u8>> {
    let enc = supported_encoding(&doc.encoding)?;
    let text = match doc.line_ending {
        LineEnding::Lf => normalize_newlines(&doc.text),
        LineEnding::Crlf => normalize_newlines(&doc.text).replace('\n', "\r\n"),
        LineEnding::Cr => normalize_newlines(&doc.text).replace('\n', "\r"),
    };
    let mut out = Vec::with_capacity(text.len() + 3);
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        if doc.bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for u in text.encode_utf16() {
            out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        return Ok(out);
    }
    if doc.bom && enc == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let (bytes, _, unmappable) = enc.encode(&text);
    if unmappable {
        let detail = first_unmappable(&text, enc)
            .map(|c| format!(" (par ex. « {c} », U+{:04X})", c as u32))
            .unwrap_or_default();
        return Err(AppError::Corrupt(format!(
            "caractères non représentables en {}{detail}",
            enc.name()
        )));
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

fn save_text(doc: &DocumentModel, path: &Path) -> Result<()> {
    let DocumentModel::Text(t) = doc else {
        return Err(AppError::Unsupported);
    };
    atomic::write(path, &encode_text(t)?)
}

// --- Commandes ---

#[tauri::command]
#[specta::specta]
pub async fn text_encodings() -> Result<Vec<String>> {
    Ok(supported_encodings()
        .iter()
        .map(|s| s.to_string())
        .collect())
}

/// Relit le fichier avec un encodage imposé (langage deviné comme à l'ouverture normale).
#[tauri::command]
#[specta::specta]
pub async fn text_reopen_with_encoding(path: String, encoding: String) -> Result<TextDoc> {
    tauri::async_runtime::spawn_blocking(move || {
        let enc = supported_encoding(&encoding)?;
        let p = Path::new(&path);
        let is_md = p.extension().is_some_and(|e| {
            MarkdownHandler
                .extensions()
                .iter()
                .any(|m| e.eq_ignore_ascii_case(m))
        });
        let language = if is_md { "markdown" } else { guess_language(p) };
        open_text(p, language, Some(enc))
    })
    .await
    .map_err(|e| AppError::External(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(text: &str, encoding: &str, bom: bool, le: LineEnding) -> DocumentModel {
        DocumentModel::Text(TextDoc {
            text: text.to_string(),
            encoding: encoding.to_string(),
            bom,
            line_ending: le,
            language: "plaintext".to_string(),
        })
    }

    fn as_text(m: DocumentModel) -> TextDoc {
        match m {
            DocumentModel::Text(t) => t,
            _ => panic!("modèle inattendu"),
        }
    }

    /// open -> save doit redonner les mêmes octets ; renvoie le modèle relu.
    fn roundtrip_bytes(name: &str, bytes: &[u8]) -> TextDoc {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join(name);
        std::fs::write(&f, bytes).unwrap();
        let h = TextHandler;
        let doc = h.open(&f).unwrap();
        h.save(&doc, &f).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), bytes, "octets modifiés");
        as_text(h.open(&f).unwrap())
    }

    #[test]
    fn encodings_are_valid_names() {
        for n in supported_encodings() {
            let e = Encoding::for_label(n.as_bytes()).unwrap_or_else(|| panic!("{n}"));
            assert_eq!(e.name(), *n);
        }
    }

    #[test]
    fn tables_are_consistent() {
        let from_table: Vec<&str> = EXT_TABLE.iter().map(|(e, _, _)| *e).collect();
        assert_eq!(from_table, EXTENSIONS);
    }

    #[test]
    fn detection() {
        let h = TextHandler;
        let p = |n: &str, b: &[u8]| h.detect(&FileProbe::from_bytes(n, b));
        assert_eq!(p("a.py", b"x"), Some(Confidence(60)));
        assert_eq!(p("a.html", b"x"), Some(Confidence(55)));
        assert_eq!(p("a.svg", b"x"), Some(Confidence(30)));
        assert_eq!(p("a.zzz", b"x"), Some(Confidence(30)));
        assert_eq!(p("Dockerfile", b"x"), Some(Confidence(60)));
        assert_eq!(p("LICENSE", b"x"), Some(Confidence(60)));
        assert_eq!(p(".gitignore", b"x"), Some(Confidence(60)));
        assert_eq!(p("a.ts", &[0, 1, 2, 3, 0, 0, 0, 0]), None);
        assert_eq!(guess_language(Path::new("Makefile")), "makefile");
        assert_eq!(guess_language(Path::new("x.rs")), "rust");
        let md = MarkdownHandler.detect(&FileProbe::from_bytes("a.md", b"# t"));
        assert_eq!(md, Some(Confidence(70)));
    }

    #[test]
    fn utf8_line_endings_roundtrip() {
        let d = roundtrip_bytes("a.txt", "héllo\nwörld\n".as_bytes());
        assert_eq!(d.encoding, "UTF-8");
        assert_eq!(d.line_ending, LineEnding::Lf);
        assert!(!d.bom);
        let d = roundtrip_bytes("a.txt", "a\r\nb\r\nc\r\n".as_bytes());
        assert_eq!(d.line_ending, LineEnding::Crlf);
        assert_eq!(d.text, "a\nb\nc\n");
        let d = roundtrip_bytes("a.txt", b"a\rb\rc");
        assert_eq!(d.line_ending, LineEnding::Cr);
    }

    #[test]
    fn bom_variants_roundtrip() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("é\n".as_bytes());
        let d = roundtrip_bytes("a.txt", &b);
        assert!(d.bom);
        assert_eq!(d.encoding, "UTF-8");
        assert_eq!(d.text, "é\n");

        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("a€\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        let d = roundtrip_bytes("a.txt", &le);
        assert_eq!((d.encoding.as_str(), d.bom), ("UTF-16LE", true));
        assert_eq!(d.text, "a€\n");
        assert_eq!(d.line_ending, LineEnding::Crlf);

        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("a€\n".encode_utf16().flat_map(|u| u.to_be_bytes()))
            .collect();
        let d = roundtrip_bytes("a.txt", &be);
        assert_eq!(d.encoding, "UTF-16BE");
    }

    #[test]
    fn legacy_encoding_detected_and_preserved() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode("Voilà un café à Genève, très été\n");
        let d = roundtrip_bytes("a.txt", &bytes);
        assert_eq!(d.encoding, "windows-1252");
        assert!(d.text.contains("café"));
    }

    #[test]
    fn unmappable_chars_are_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        let m = model("日本", "windows-1252", false, LineEnding::Lf);
        match TextHandler.save(&m, &f) {
            Err(AppError::Corrupt(msg)) => assert!(msg.contains("windows-1252")),
            other => panic!("attendu Corrupt, obtenu {other:?}"),
        }
        assert!(!f.exists());
        let m = model("日本\n", "Shift_JIS", false, LineEnding::Crlf);
        TextHandler.save(&m, &f).unwrap();
        let back = as_text(TextHandler.open(&f).unwrap());
        assert_eq!(back.text, "日本\n");
        assert_eq!(back.line_ending, LineEnding::Crlf);
    }

    #[test]
    fn model_roundtrip_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.py");
        let m = model("print('é')\n", "UTF-16BE", true, LineEnding::Crlf);
        TextHandler.save(&m, &f).unwrap();
        let t = as_text(TextHandler.open(&f).unwrap());
        assert_eq!(t.encoding, "UTF-16BE");
        assert!(t.bom);
        assert_eq!(t.language, "python");
        assert_eq!(t.text, "print('é')\n");
        let forced = open_text(&f, "python", Some(UTF_16BE)).unwrap();
        assert!(forced.bom);

        let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode("è");
        std::fs::write(&f, &bytes).unwrap();
        assert!(open_text(&f, "x", Some(UTF_8)).is_err());
        let l2 = open_text(&f, "x", Some(encoding_rs::ISO_8859_2)).unwrap();
        assert_eq!(l2.text, "č");
        assert!(matches!(
            TextHandler.save(&model("a", "bogus", false, LineEnding::Lf), &f),
            Err(AppError::Unsupported)
        ));
    }

    #[test]
    fn markdown_export_html() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        let src = "# Titre <x>\n\n|a|b|\n|-|-|\n|1|2|\n\n- [x] fait\n\n~~barré~~ note[^1]\n\n[^1]: la note\n";
        std::fs::write(&f, src).unwrap();
        let doc = MarkdownHandler.open(&f).unwrap();
        assert_eq!(as_text(doc.clone()).language, "markdown");
        let out = dir.path().join("n.html");
        MarkdownHandler.export(&doc, "html", &out).unwrap();
        let html = std::fs::read_to_string(&out).unwrap();
        for needle in [
            "<!DOCTYPE html>",
            "<table>",
            "checked",
            "<del>barré</del>",
            "footnote",
            "<title>n</title>",
        ] {
            assert!(html.contains(needle), "manque {needle} dans {html}");
        }
        assert!(matches!(
            MarkdownHandler.export(&doc, "pdf", &out),
            Err(AppError::Unsupported)
        ));
    }
}
