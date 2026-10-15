//! Diapositives PPTX et ODP en lecture seule (extraction de texte + miniature).
//!
//! `Slide.index` est 1-based ; `texts` = un élément par paragraphe non vide ; `notes` = notes
//! de l'orateur (paragraphes joints par « \n »). `SlidesDoc.thumbnail` = data URI de la
//! miniature embarquée, si présente.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, ModelKind, Slide, SlidesDoc};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::formats::zipxml::{dir_of, open_zip, parse_xml, read_entry, resolve, Item, Node};

const MAX_XML_ENTRY: u64 = 256 * 1024 * 1024;
const MAX_THUMB: u64 = 4 * 1024 * 1024;
const MAX_SLIDES: usize = 10_000;

fn contains(head: &[u8], needle: &[u8]) -> bool {
    head.windows(needle.len()).any(|w| w == needle)
}

fn thumbnail(
    zip: &mut zip::ZipArchive<std::fs::File>,
    candidates: &[(&str, &str)],
) -> Option<String> {
    for (name, mime) in candidates {
        if let Ok(Some(bytes)) = read_entry(zip, name, MAX_THUMB) {
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            return Some(format!("data:{mime};base64,{b64}"));
        }
    }
    None
}

fn check_size(path: &Path) -> Result<()> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    Ok(())
}

// --- PPTX ---

/// Texte d'un paragraphe `a:p`.
fn pptx_para_text(p: &Node, out: &mut String) {
    for n in p.nodes() {
        match n.name.as_str() {
            "t" => out.push_str(&n.text()),
            "br" => out.push('\n'),
            "tab" => out.push('\t'),
            "pPr" => {}
            _ => pptx_para_text(n, out),
        }
    }
}

fn is_meta_placeholder(sp: &Node) -> bool {
    sp.find_all("ph").iter().any(|ph| {
        matches!(
            ph.attr("type"),
            Some("sldNum" | "hdr" | "ftr" | "dt" | "sldImg")
        )
    })
}

fn pptx_paragraphs(node: &Node, skip_meta: bool, out: &mut Vec<String>) {
    for n in node.nodes() {
        if n.name == "sp" && skip_meta && is_meta_placeholder(n) {
            continue;
        }
        if n.name == "p" {
            let mut s = String::new();
            pptx_para_text(n, &mut s);
            if !s.trim().is_empty() {
                out.push(s);
            }
        } else {
            pptx_paragraphs(n, skip_meta, out);
        }
    }
}

/// Relations d'un fichier .rels : (Id → (Type, Target)).
fn rels(zip: &mut zip::ZipArchive<std::fs::File>, part: &str) -> HashMap<String, (String, String)> {
    let rels_path = format!(
        "{}/_rels/{}.rels",
        dir_of(part),
        part.rsplit('/').next().unwrap_or("")
    );
    let rels_path = rels_path.trim_start_matches('/').to_string();
    let mut map = HashMap::new();
    if let Ok(Some(bytes)) = read_entry(zip, &rels_path, 16 * 1024 * 1024) {
        if let Ok(root) = parse_xml(&bytes) {
            for r in root.find_all("Relationship") {
                if let (Some(id), Some(t), Some(target)) =
                    (r.attr("Id"), r.attr("Type"), r.attr("Target"))
                {
                    map.insert(id.to_string(), (t.to_string(), target.to_string()));
                }
            }
        }
    }
    map
}

fn read_pptx(path: &Path) -> Result<SlidesDoc> {
    check_size(path)?;
    let mut zip = open_zip(path)?;
    let pres = read_entry(&mut zip, "ppt/presentation.xml", MAX_XML_ENTRY)?
        .ok_or_else(|| AppError::Corrupt("presentation.xml absent".into()))?;
    let pres = parse_xml(&pres)?;
    let pres_rels = rels(&mut zip, "ppt/presentation.xml");
    let mut slides = Vec::new();
    let ids = pres
        .find("sldIdLst")
        .map(|l| l.find_all("sldId"))
        .unwrap_or_default();
    for id in ids.into_iter().take(MAX_SLIDES) {
        let Some(rid) = id
            .attrs
            .iter()
            .find(|(k, _)| k.ends_with(":id"))
            .map(|(_, v)| v)
        else {
            continue;
        };
        let Some(slide_path) = pres_rels.get(rid).and_then(|(_, t)| resolve("ppt", t)) else {
            continue;
        };
        let xml = read_entry(&mut zip, &slide_path, MAX_XML_ENTRY)?
            .ok_or_else(|| AppError::Corrupt(format!("{slide_path} absent")))?;
        let mut texts = Vec::new();
        pptx_paragraphs(&parse_xml(&xml)?, false, &mut texts);
        let notes_path = rels(&mut zip, &slide_path)
            .into_values()
            .find(|(t, _)| t.ends_with("/notesSlide"))
            .and_then(|(_, target)| resolve(dir_of(&slide_path), &target));
        let notes = match notes_path {
            Some(np) => match read_entry(&mut zip, &np, MAX_XML_ENTRY)? {
                Some(b) => {
                    let mut paras = Vec::new();
                    pptx_paragraphs(&parse_xml(&b)?, true, &mut paras);
                    (!paras.is_empty()).then(|| paras.join("\n"))
                }
                None => None,
            },
            None => None,
        };
        slides.push(Slide {
            index: slides.len() as u32 + 1,
            texts,
            notes,
        });
    }
    let thumbnail = thumbnail(
        &mut zip,
        &[
            ("docProps/thumbnail.jpeg", "image/jpeg"),
            ("docProps/thumbnail.png", "image/png"),
        ],
    );
    Ok(SlidesDoc { slides, thumbnail })
}

// --- ODP ---

fn odp_para_text(p: &Node, out: &mut String) {
    for i in &p.items {
        match i {
            Item::Text(t) => out.push_str(t),
            Item::Node(n) => match n.name.as_str() {
                "s" => {
                    let c = n
                        .attr_local("c")
                        .and_then(|c| c.parse::<usize>().ok())
                        .unwrap_or(1);
                    out.push_str(&" ".repeat(c.min(1000)));
                }
                "tab" => out.push('\t'),
                "line-break" => out.push('\n'),
                _ => odp_para_text(n, out),
            },
        }
    }
}

fn odp_paragraphs(node: &Node, in_notes: bool, out: &mut Vec<String>) {
    for n in node.nodes() {
        match n.name.as_str() {
            "notes" if !in_notes => {}
            "p" | "h" => {
                let mut s = String::new();
                odp_para_text(n, &mut s);
                if !s.trim().is_empty() {
                    out.push(s);
                }
            }
            _ => odp_paragraphs(n, in_notes, out),
        }
    }
}

fn read_odp(path: &Path) -> Result<SlidesDoc> {
    check_size(path)?;
    let mut zip = open_zip(path)?;
    let content = read_entry(&mut zip, "content.xml", MAX_XML_ENTRY)?
        .ok_or_else(|| AppError::Corrupt("content.xml absent".into()))?;
    let root = parse_xml(&content)?;
    let mut slides = Vec::new();
    for page in root.find_all("page").into_iter().take(MAX_SLIDES) {
        let mut texts = Vec::new();
        odp_paragraphs(page, false, &mut texts);
        let mut notes = Vec::new();
        for n in page.find_all("notes") {
            odp_paragraphs(n, true, &mut notes);
        }
        slides.push(Slide {
            index: slides.len() as u32 + 1,
            texts,
            notes: (!notes.is_empty()).then(|| notes.join("\n")),
        });
    }
    let thumbnail = thumbnail(&mut zip, &[("Thumbnails/thumbnail.png", "image/png")]);
    Ok(SlidesDoc { slides, thumbnail })
}

fn to_markdown(d: &SlidesDoc) -> String {
    let mut out = String::new();
    for s in &d.slides {
        out.push_str(&format!("## Diapo {}\n\n", s.index));
        for t in &s.texts {
            out.push_str(&format!("- {}\n", t.replace('\n', " ")));
        }
        if let Some(n) = &s.notes {
            out.push_str(&format!("\n> {}\n", n.replace('\n', "\n> ")));
        }
        out.push('\n');
    }
    out
}

fn export_md(doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
    match (doc, target) {
        (DocumentModel::Slides(d), "md") => atomic::write(path, to_markdown(d).as_bytes()),
        _ => Err(AppError::Unsupported),
    }
}

fn caps() -> Capabilities {
    Capabilities {
        read: true,
        write: false,
        export_to: vec!["md".into()],
        fidelity: Fidelity::ReadOnly,
    }
}

pub struct PptxHandler;

impl FormatHandler for PptxHandler {
    fn id(&self) -> &'static str {
        "pptx"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Slides
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["pptx"]
    }

    fn label_key(&self) -> &'static str {
        "formats.pptx"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let is_zip = probe.head.starts_with(b"PK");
        let ooxml = contains(&probe.head, b"ppt/");
        match (probe.ext == "pptx", is_zip) {
            (true, true) => Some(Confidence(if ooxml { 95 } else { 90 })),
            (false, true) if ooxml && contains(&probe.head, b"[Content_Types].xml") => {
                Some(Confidence(70))
            }
            (true, false) => Some(Confidence(60)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        caps()
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Slides(read_pptx(path)?))
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        export_md(doc, target, path)
    }
}

pub struct OdpHandler;

impl FormatHandler for OdpHandler {
    fn id(&self) -> &'static str {
        "odp"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Slides
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["odp"]
    }

    fn label_key(&self) -> &'static str {
        "formats.odp"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let is_zip = probe.head.starts_with(b"PK");
        let mime = contains(
            &probe.head,
            b"application/vnd.oasis.opendocument.presentation",
        );
        match (probe.ext == "odp", is_zip) {
            (true, true) => Some(Confidence(if mime { 95 } else { 90 })),
            (false, true) if mime => Some(Confidence(90)),
            (true, false) => Some(Confidence(60)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        caps()
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::Slides(read_odp(path)?))
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        export_md(doc, target, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (n, d) in files {
            let o = if *n == "mimetype" {
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
            } else {
                SimpleFileOptions::default()
            };
            z.start_file(*n, o).unwrap();
            z.write_all(d).unwrap();
        }
        z.finish().unwrap();
    }

    fn slides(m: DocumentModel) -> SlidesDoc {
        match m {
            DocumentModel::Slides(s) => s,
            _ => panic!("modèle inattendu"),
        }
    }

    fn make_pptx(dir: &Path) -> std::path::PathBuf {
        let p = dir.join("a.pptx");
        let slide = |t1: &str, t2: &str| {
            format!(
                r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{t1}</a:t></a:r></a:p><a:p><a:r><a:t>{t2}</a:t></a:r><a:br/><a:r><a:t>suite</a:t></a:r></a:p><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
            )
        };
        let s1 = slide("Titre", "Point &amp; un");
        let s2 = slide("Deux", "x");
        zip_of(
            &p,
            &[
                ("[Content_Types].xml", b"<Types/>"),
                (
                    "ppt/presentation.xml",
                    br#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>"#,
                ),
                (
                    "ppt/_rels/presentation.xml.rels",
                    br#"<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide1.xml"/></Relationships>"#,
                ),
                ("ppt/slides/slide1.xml", s1.as_bytes()),
                ("ppt/slides/slide2.xml", s2.as_bytes()),
                (
                    "ppt/slides/_rels/slide1.xml.rels",
                    br#"<Relationships><Relationship Id="r1" Type="http://x/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>"#,
                ),
                (
                    "ppt/notesSlides/notesSlide1.xml",
                    br#"<p:notes xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Ma note</a:t></a:r></a:p></p:txBody></p:sp></p:notes>"#,
                ),
                ("docProps/thumbnail.jpeg", &[0xFF, 0xD8, 0xFF, 0xD9]),
            ],
        );
        p
    }

    #[test]
    fn reads_pptx_in_presentation_order() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_pptx(dir.path());
        let d = slides(PptxHandler.open(&p).unwrap());
        assert_eq!(d.slides.len(), 2);
        assert_eq!(d.slides[0].index, 1);
        assert_eq!(d.slides[0].texts, ["Titre", "Point & un\nsuite"]);
        assert_eq!(d.slides[0].notes.as_deref(), Some("Ma note"));
        assert_eq!(d.slides[1].texts[0], "Deux");
        assert_eq!(d.slides[1].notes, None);
        assert_eq!(
            d.thumbnail.as_deref(),
            Some("data:image/jpeg;base64,/9j/2Q==")
        );

        let md = dir.path().join("o.md");
        PptxHandler
            .export(&DocumentModel::Slides(d), "md", &md)
            .unwrap();
        let s = std::fs::read_to_string(&md).unwrap();
        assert!(s.contains("## Diapo 1\n\n- Titre\n- Point & un suite\n\n> Ma note"));
        assert!(s.contains("## Diapo 2"));
    }

    #[test]
    fn reads_odp() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.odp");
        zip_of(
            &p,
            &[
                ("mimetype", b"application/vnd.oasis.opendocument.presentation"),
                (
                    "content.xml",
                    br#"<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t" xmlns:presentation="pr"><office:body><office:presentation><draw:page draw:name="a"><draw:frame><draw:text-box><text:p>Bonjour<text:s text:c="2"/><text:span>monde</text:span></text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Note</text:p></draw:text-box></draw:frame></presentation:notes></draw:page><draw:page><text:list><text:list-item><text:p>Item</text:p></text:list-item></text:list></draw:page></office:presentation></office:body></office:document-content>"#,
                ),
                ("Thumbnails/thumbnail.png", &[1, 2, 3]),
            ],
        );
        let probe = FileProbe::from_path(&p).unwrap();
        assert_eq!(OdpHandler.detect(&probe), Some(Confidence(95)));
        let d = slides(OdpHandler.open(&p).unwrap());
        assert_eq!(d.slides.len(), 2);
        assert_eq!(d.slides[0].texts, ["Bonjour  monde"]);
        assert_eq!(d.slides[0].notes.as_deref(), Some("Note"));
        assert_eq!(d.slides[1].texts, ["Item"]);
        assert_eq!(d.thumbnail.as_deref(), Some("data:image/png;base64,AQID"));
        assert!(matches!(
            OdpHandler.save(&DocumentModel::Slides(d), &p),
            Err(AppError::ReadOnly)
        ));
    }

    #[test]
    fn detects_and_survives_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let p = make_pptx(dir.path());
        let bytes = std::fs::read(&p).unwrap();
        let probe = FileProbe::from_bytes("a.pptx", &bytes);
        assert_eq!(PptxHandler.detect(&probe), Some(Confidence(95)));
        assert_eq!(OdpHandler.detect(&probe), None);
        assert_eq!(
            PptxHandler.detect(&FileProbe::from_bytes("a.txt", b"x")),
            None
        );
        let bad = dir.path().join("bad.pptx");
        for cut in [0, 20, bytes.len() / 2, bytes.len() - 3] {
            std::fs::write(&bad, &bytes[..cut]).unwrap();
            assert!(PptxHandler.open(&bad).is_err());
            assert!(OdpHandler.open(&bad).is_err());
        }
        std::fs::write(&bad, vec![7u8; 3000]).unwrap();
        assert!(PptxHandler.open(&bad).is_err());
    }
}
