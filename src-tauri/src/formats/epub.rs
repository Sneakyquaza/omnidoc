//! EPUB (2 et 3) en lecture seule : métadonnées, chapitres dans l'ordre du spine, HTML assaini.
//!
//! Conventions du modèle (`EbookDoc`) :
//! - `chapters[i]` correspond à l'ancre `chapter-<i>` (index 0-based, ordre du spine) ;
//! - les `id` du HTML d'un chapitre sont préfixés `chapter-<i>--` ;
//! - les liens internes sont réécrits en `#chapter-<i>` ou `#chapter-<i>--<id>` ;
//! - les images sont des data URI (budget 20 Mio par livre), le CSS du livre est ignoré.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine;
use zip::ZipArchive;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, EbookChapter, EbookDoc, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::formats::zipxml::{dir_of, open_zip, parse_xml, read_entry, resolve, Node};

const MAX_XML_ENTRY: u64 = 16 * 1024 * 1024;
const MAX_CHAPTER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Budget cumulé d'images en data URI par livre.
const IMAGE_BUDGET: u64 = 20 * 1024 * 1024;
const MAX_CHAPTERS: usize = 10_000;

pub struct EpubHandler;

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// État partagé avec le filtre d'attributs d'ammonia.
struct Ctx {
    zip: ZipArchive<File>,
    image_bytes: u64,
    images_omitted: bool,
    remote_images: bool,
    chapter_dir: String,
    chapter_idx: usize,
    path_to_idx: HashMap<String, usize>,
    /// Octets décompressés lus au total (garde-fou).
    read_total: u64,
}

impl Ctx {
    fn image_data_uri(&mut self, src: &str) -> Option<String> {
        if src.starts_with("data:image/") {
            // Image déjà embarquée : acceptée si type raster/svg usuel et taille raisonnable.
            let ok = ["png", "jpeg", "gif", "webp", "svg+xml"]
                .iter()
                .any(|t| src.starts_with(&format!("data:image/{t};")));
            if ok && self.image_bytes + (src.len() as u64) < IMAGE_BUDGET {
                self.image_bytes += src.len() as u64;
                return Some(src.to_string());
            }
            self.images_omitted = true;
            return None;
        }
        let Some(path) = resolve(&self.chapter_dir, src) else {
            self.remote_images = true;
            return None;
        };
        let Some(mime) = image_mime(&path) else {
            self.images_omitted = true;
            return None;
        };
        match read_entry(&mut self.zip, &path, MAX_IMAGE_BYTES) {
            Ok(Some(bytes)) if self.image_bytes + bytes.len() as u64 <= IMAGE_BUDGET => {
                self.image_bytes += bytes.len() as u64;
                self.read_total += bytes.len() as u64;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                Some(format!("data:{mime};base64,{b64}"))
            }
            _ => {
                self.images_omitted = true;
                None
            }
        }
    }

    fn rewrite_link(&self, href: &str) -> Option<String> {
        let lower = href.trim().to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:")
        {
            return Some(href.trim().to_string());
        }
        let (target, frag) = match href.split_once('#') {
            Some((t, f)) => (t, Some(f)),
            None => (href, None),
        };
        let idx = if target.is_empty() {
            self.chapter_idx
        } else {
            let path = resolve(&self.chapter_dir, target)?;
            *self.path_to_idx.get(&path)?
        };
        Some(match frag {
            Some(f) if !f.is_empty() => format!("#chapter-{idx}--{f}"),
            _ => format!("#chapter-{idx}"),
        })
    }
}

fn sanitize(html: &str, ctx: &Arc<Mutex<Ctx>>) -> String {
    let c = Arc::clone(ctx);
    let mut b = ammonia::Builder::default();
    b.add_generic_attributes(["id"])
        .clean_content_tags(["script", "style", "title", "head"].into_iter().collect())
        .attribute_filter(move |element, attribute, value| {
            let mut ctx = c.lock().unwrap_or_else(|e| e.into_inner());
            match (element, attribute) {
                (_, "id") => Some(Cow::Owned(format!("chapter-{}--{value}", ctx.chapter_idx))),
                ("img", "src") => ctx.image_data_uri(value).map(Cow::Owned),
                ("a", "href") => ctx.rewrite_link(value).map(Cow::Owned),
                _ => Some(Cow::Owned(value.to_string())),
            }
        });
    b.clean(html).to_string()
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Texte du premier élément `<tag ...>…</tag>` (insensible à la casse).
fn tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let mut from = 0;
    while let Some(rel) = lower.get(from..)?.find(&open) {
        let start = from + rel;
        let after = lower.get(start + open.len()..)?;
        // Évite de confondre <h1 avec <h10, <title avec <titlex.
        if !after.starts_with(['>', ' ', '\t', '\n', '\r', '/']) {
            from = start + open.len();
            continue;
        }
        let gt = lower.get(start..)?.find('>')? + start + 1;
        let end = lower.get(gt..)?.find(&format!("</{tag}"))? + gt;
        let text = strip_tags(html.get(gt..end)?);
        return (!text.is_empty()).then_some(text);
    }
    None
}

struct Manifest {
    href: String,
    media_type: String,
    properties: String,
}

fn parse_opf(
    opf: &Node,
    opf_dir: &str,
) -> (HashMap<String, Manifest>, Vec<String>, Option<String>) {
    let mut manifest = HashMap::new();
    if let Some(m) = opf.child("manifest") {
        for it in m.nodes().filter(|n| n.name == "item") {
            let (Some(id), Some(href)) = (it.attr("id"), it.attr("href")) else {
                continue;
            };
            if let Some(path) = resolve(opf_dir, href) {
                manifest.insert(
                    id.to_string(),
                    Manifest {
                        href: path,
                        media_type: it.attr("media-type").unwrap_or("").to_string(),
                        properties: it.attr("properties").unwrap_or("").to_string(),
                    },
                );
            }
        }
    }
    let mut spine = Vec::new();
    let mut toc_id = None;
    if let Some(s) = opf.child("spine") {
        toc_id = s.attr("toc").map(String::from);
        spine.extend(
            s.nodes()
                .filter(|n| n.name == "itemref")
                .filter_map(|n| n.attr("idref").map(String::from)),
        );
    }
    (manifest, spine, toc_id)
}

/// Titres de chapitres : chemin (sans fragment) → titre. EPUB3 nav, sinon EPUB2 ncx.
fn toc_titles(
    zip: &mut ZipArchive<File>,
    manifest: &HashMap<String, Manifest>,
    toc_id: Option<&str>,
) -> HashMap<String, String> {
    let mut titles: HashMap<String, String> = HashMap::new();
    let nav = manifest
        .values()
        .find(|m| m.properties.split_whitespace().any(|p| p == "nav"));
    if let Some(nav) = nav {
        if let Ok(Some(bytes)) = read_entry(zip, &nav.href, MAX_XML_ENTRY) {
            if let Ok(root) = parse_xml(&bytes) {
                let navs = root.find_all("nav");
                let toc = navs
                    .iter()
                    .find(|n| n.attr_local("type") == Some("toc"))
                    .or_else(|| navs.first());
                if let Some(toc) = toc {
                    let dir = dir_of(&nav.href);
                    for a in toc.find_all("a") {
                        let (Some(href), text) = (a.attr("href"), a.text()) else {
                            continue;
                        };
                        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                        if let (Some(path), false) = (resolve(dir, href), text.is_empty()) {
                            titles.entry(path).or_insert(text);
                        }
                    }
                }
            }
        }
    }
    if titles.is_empty() {
        let ncx = toc_id.and_then(|id| manifest.get(id)).or_else(|| {
            manifest
                .values()
                .find(|m| m.media_type == "application/x-dtbncx+xml")
        });
        if let Some(ncx) = ncx {
            if let Ok(Some(bytes)) = read_entry(zip, &ncx.href, MAX_XML_ENTRY) {
                if let Ok(root) = parse_xml(&bytes) {
                    let dir = dir_of(&ncx.href);
                    for p in root.find_all("navPoint") {
                        let label = p
                            .child("navLabel")
                            .map(|l| l.text().split_whitespace().collect::<Vec<_>>().join(" "))
                            .unwrap_or_default();
                        let src = p.child("content").and_then(|c| c.attr("src"));
                        if let (Some(src), false) = (src, label.is_empty()) {
                            if let Some(path) = resolve(dir, src) {
                                titles.entry(path).or_insert(label);
                            }
                        }
                    }
                }
            }
        }
    }
    titles
}

fn is_html(m: &Manifest) -> bool {
    matches!(
        m.media_type.as_str(),
        "application/xhtml+xml" | "text/html" | "application/x-dtbook+xml"
    )
}

fn read_epub(path: &Path) -> Result<EbookDoc> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    let mut zip = open_zip(path)?;
    let container = read_entry(&mut zip, "META-INF/container.xml", MAX_XML_ENTRY)?
        .ok_or_else(|| AppError::Corrupt("container.xml absent".into()))?;
    let container = parse_xml(&container)?;
    let opf_path = container
        .find_all("rootfile")
        .iter()
        .find_map(|r| r.attr("full-path"))
        .and_then(|p| resolve("", p))
        .ok_or_else(|| AppError::Corrupt("rootfile absent".into()))?;
    let opf_bytes = read_entry(&mut zip, &opf_path, MAX_XML_ENTRY)?
        .ok_or_else(|| AppError::Corrupt("OPF absent".into()))?;
    let opf = parse_xml(&opf_bytes)?;
    let opf_dir = dir_of(&opf_path).to_string();

    let meta_text = |name: &str| {
        opf.child("metadata")
            .and_then(|m| m.child(name))
            .map(|n| n.text().trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let book_title = meta_text("title");
    let author = meta_text("creator");

    let (manifest, spine, toc_id) = parse_opf(&opf, &opf_dir);
    let mut lossy = Vec::new();
    if manifest.values().any(|m| m.media_type == "text/css") {
        lossy.push("css".to_string());
    }
    let titles = toc_titles(&mut zip, &manifest, toc_id.as_deref());

    let items: Vec<&Manifest> = spine
        .iter()
        .filter_map(|id| manifest.get(id))
        .filter(|m| is_html(m))
        .take(MAX_CHAPTERS)
        .collect();
    let mut path_to_idx = HashMap::new();
    for (i, m) in items.iter().enumerate() {
        path_to_idx.entry(m.href.clone()).or_insert(i);
    }
    let ctx = Arc::new(Mutex::new(Ctx {
        zip,
        image_bytes: 0,
        images_omitted: false,
        remote_images: false,
        chapter_dir: String::new(),
        chapter_idx: 0,
        path_to_idx,
        read_total: 0,
    }));

    let mut chapters = Vec::with_capacity(items.len());
    for (i, m) in items.iter().enumerate() {
        let raw = {
            let mut c = ctx.lock().unwrap_or_else(|e| e.into_inner());
            c.chapter_dir = dir_of(&m.href).to_string();
            c.chapter_idx = i;
            if c.read_total > MAX_OPEN_BYTES {
                return Err(AppError::Limit("taille décompressée".into()));
            }
            let bytes = read_entry(&mut c.zip, &m.href, MAX_CHAPTER_BYTES)?.unwrap_or_default();
            c.read_total += bytes.len() as u64;
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let html = sanitize(&raw, &ctx);
        let title = titles
            .get(&m.href)
            .cloned()
            .or_else(|| tag_text(&html, "h1"))
            .or_else(|| tag_text(&html, "h2"))
            .or_else(|| tag_text(&raw, "title"))
            .unwrap_or_else(|| {
                let name = m.href.rsplit('/').next().unwrap_or(&m.href);
                name.rsplit_once('.')
                    .map(|(s, _)| s)
                    .unwrap_or(name)
                    .to_string()
            });
        chapters.push(EbookChapter { title, html });
    }
    {
        let c = ctx.lock().unwrap_or_else(|e| e.into_inner());
        if c.images_omitted {
            lossy.push("images-omitted".into());
        }
        if c.remote_images {
            lossy.push("remote-images".into());
        }
    }
    let title = book_title
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Ok(EbookDoc {
        title,
        author,
        chapters,
        lossy,
    })
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn to_html(doc: &EbookDoc) -> String {
    let mut out = String::new();
    out.push_str("<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">");
    out.push_str(&format!("<title>{}</title>", escape_html(&doc.title)));
    out.push_str(
        "<style>body{font-family:serif;max-width:46em;margin:2em auto;padding:0 1em;line-height:1.5}\
         img{max-width:100%}section{margin-bottom:3em}</style></head><body>\n",
    );
    out.push_str(&format!("<h1>{}</h1>\n", escape_html(&doc.title)));
    if let Some(a) = &doc.author {
        out.push_str(&format!("<p><em>{}</em></p>\n", escape_html(a)));
    }
    for (i, c) in doc.chapters.iter().enumerate() {
        out.push_str(&format!(
            "<section id=\"chapter-{i}\">\n{}\n</section>\n",
            c.html
        ));
    }
    out.push_str("</body></html>\n");
    out
}

impl FormatHandler for EpubHandler {
    fn id(&self) -> &'static str {
        "epub"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Ebook
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["epub"]
    }

    fn label_key(&self) -> &'static str {
        "formats.epub"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let is_zip = probe.head.starts_with(b"PK");
        let needle: &[u8] = b"mimetypeapplication/epub+zip";
        let has_mimetype = probe.head.windows(needle.len()).any(|w| w == needle);
        if probe.ext == "epub" && is_zip {
            return Some(Confidence(if has_mimetype { 95 } else { 90 }));
        }
        if is_zip && has_mimetype {
            return Some(Confidence(85));
        }
        (probe.ext == "epub").then_some(Confidence(60))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec!["html".into()],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Ebook(read_epub(path)?))
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        match (doc, target) {
            (DocumentModel::Ebook(d), "html") => atomic::write(path, to_html(d).as_bytes()),
            _ => Err(AppError::Unsupported),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

    fn build(dir: &Path, with_nav: bool) -> std::path::PathBuf {
        let p = dir.join("b.epub");
        let mut z = zip::ZipWriter::new(File::create(&p).unwrap());
        let o = SimpleFileOptions::default();
        let mut add = |name: &str, data: &[u8]| {
            let o = if name == "mimetype" {
                o.compression_method(zip::CompressionMethod::Stored)
            } else {
                o
            };
            z.start_file(name, o).unwrap();
            z.write_all(data).unwrap();
        };
        add("mimetype", b"application/epub+zip");
        add(
            "META-INF/container.xml",
            br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
        );
        let nav_item = if with_nav {
            r#"<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>"#
        } else {
            ""
        };
        add(
            "OEBPS/content.opf",
            format!(
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Mon Livre</dc:title><dc:creator>Ada</dc:creator></metadata><manifest>{nav_item}<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="img" href="img/a.png" media-type="image/png"/><item id="css" href="s.css" media-type="text/css"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>"#
            )
            .as_bytes(),
        );
        add(
            "OEBPS/nav.xhtml",
            br#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Premier</a></li><li><a href="text/ch2.xhtml#s">Second</a></li></ol></nav></body></html>"#,
        );
        add(
            "OEBPS/text/ch1.xhtml",
            br##"<html><head><title>T1</title><script>alert(1)</script></head><body><h1 id="top">Un</h1><p onclick="x()">Texte <b>gras</b> <a href="ch2.xhtml#s">vers 2</a> <a href="#top">haut</a> <a href="javascript:alert(1)">mal</a></p><iframe src="http://x"></iframe><form><input></form><img src="../img/a.png" alt="a"><img src="http://evil/x.png"><script>bad()</script></body></html>"##,
        );
        add(
            "OEBPS/text/ch2.xhtml",
            br#"<html><head><title>Titre Deux</title></head><body><h2>Sous-titre</h2><table><tr><td>1</td></tr></table><p id="s">fin</p></body></html>"#,
        );
        add("OEBPS/img/a.png", PNG);
        add("OEBPS/s.css", b"p{color:red}");
        z.finish().unwrap();
        p
    }

    fn open(p: &Path) -> EbookDoc {
        match EpubHandler.open(p).unwrap() {
            DocumentModel::Ebook(d) => d,
            _ => panic!("modèle inattendu"),
        }
    }

    #[test]
    fn reads_epub3_sanitized_in_spine_order() {
        let dir = tempfile::tempdir().unwrap();
        let d = open(&build(dir.path(), true));
        assert_eq!(
            (d.title.as_str(), d.author.as_deref()),
            ("Mon Livre", Some("Ada"))
        );
        assert_eq!(d.chapters.len(), 2);
        // spine : c2 puis c1.
        assert_eq!(d.chapters[0].title, "Second");
        assert_eq!(d.chapters[1].title, "Premier");
        let c1 = &d.chapters[1].html;
        for bad in [
            "script",
            "onclick",
            "iframe",
            "<form",
            "<input",
            "javascript",
            "evil",
            "alert",
        ] {
            assert!(!c1.contains(bad), "{bad} dans {c1}");
        }
        assert!(c1.contains("<b>gras</b>"));
        assert!(c1.contains("data:image/png;base64,iVBORw0KGgoBAgM="));
        assert!(c1.contains("href=\"#chapter-0--s\""));
        assert!(c1.contains("href=\"#chapter-1--top\""));
        assert!(c1.contains("id=\"chapter-1--top\""));
        assert!(d.chapters[0].html.contains("<table>"));
        assert!(d.lossy.contains(&"css".to_string()));
        assert!(d.lossy.contains(&"remote-images".to_string()));
    }

    #[test]
    fn falls_back_to_headings_without_nav() {
        let dir = tempfile::tempdir().unwrap();
        let d = open(&build(dir.path(), false));
        assert_eq!(d.chapters[0].title, "Sous-titre");
        assert_eq!(d.chapters[1].title, "Un");
    }

    #[test]
    fn exports_single_html() {
        let dir = tempfile::tempdir().unwrap();
        let p = build(dir.path(), true);
        let m = EpubHandler.open(&p).unwrap();
        let out = dir.path().join("o.html");
        EpubHandler.export(&m, "html", &out).unwrap();
        let s = std::fs::read_to_string(&out).unwrap();
        assert!(
            s.contains("<section id=\"chapter-0\">") && s.contains("<section id=\"chapter-1\">")
        );
        assert!(s.contains("<title>Mon Livre</title>"));
        assert!(EpubHandler.export(&m, "pdf", &out).is_err());
        assert!(matches!(
            EpubHandler.save(&m, &out),
            Err(AppError::ReadOnly)
        ));
    }

    #[test]
    fn detects_and_survives_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let p = build(dir.path(), true);
        let bytes = std::fs::read(&p).unwrap();
        let probe = FileProbe::from_bytes("b.epub", &bytes);
        assert_eq!(EpubHandler.detect(&probe), Some(Confidence(95)));
        assert_eq!(
            EpubHandler.detect(&FileProbe::from_bytes("b.epub", b"hello")),
            Some(Confidence(60))
        );
        assert_eq!(
            EpubHandler.detect(&FileProbe::from_bytes("b.txt", b"hello")),
            None
        );
        let bad = dir.path().join("bad.epub");
        for cut in [0, 10, bytes.len() / 2, bytes.len() - 5] {
            std::fs::write(&bad, &bytes[..cut]).unwrap();
            assert!(EpubHandler.open(&bad).is_err());
        }
        std::fs::write(&bad, vec![0x41u8; 5000]).unwrap();
        assert!(EpubHandler.open(&bad).is_err());
    }
}
