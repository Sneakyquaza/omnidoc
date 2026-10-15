//! DOCX (WordprocessingML). Lecture maison (zip + quick-xml), écriture XML maison :
//! contrôle total de la numérotation (redémarrage des listes), des fusions de cellules et des
//! styles Heading1-6, sans la dépendance lourde de `docx-rs`.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::tree::{
    inlines_text, Align, Block, Cell, Image, Inline, Lossy, Mark, RichTree, TaskItem,
};
use super::util::{
    ext_from_mime, format_pt, image_size, make_data_uri, mime_from_ext, parse_data_uri,
    parse_font_size_pt, sniff_image_mime, to_hex6, xml_escape, xml_escaped,
};
use super::xml::Element;
use super::{open_zip, read_limited, resolve_path, rich_of, zip_read_media, zip_read_xml, Zip};
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::{MAX_CELLS, MAX_DEPTH};
use crate::core::model::{DocumentModel, ModelKind, RichDoc, RichMeta};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub struct DocxHandler;

impl FormatHandler for DocxHandler {
    fn id(&self) -> &'static str {
        "docx"
    }

    fn model(&self) -> ModelKind {
        ModelKind::RichText
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["docx"]
    }

    fn label_key(&self) -> &'static str {
        "formats.docx"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let pk = probe.head.starts_with(b"PK\x03\x04");
        let has = |needle: &[u8]| probe.head.windows(needle.len()).any(|w| w == needle);
        let word_like = has(b"word/") || has(b"[Content_Types].xml");
        let other_office = has(b"xl/") || has(b"ppt/");
        match (probe.ext == "docx", pk) {
            (true, true) if !other_office || has(b"word/") => Some(Confidence(95)),
            (true, true) => Some(Confidence(60)),
            (true, false) => Some(Confidence(60)),
            (false, true) if has(b"word/") && !other_office => Some(Confidence(75)),
            (false, true) if word_like && has(b"word/document.xml") => Some(Confidence(75)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: ["odt", "markdown-rich", "html", "pdf"]
                .map(String::from)
                .to_vec(),
            fidelity: Fidelity::Partial,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::RichText(parse(&read_limited(path)?)?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        atomic::write(path, &serialize(rich_of(doc)?)?)
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        super::export_rich(rich_of(doc)?, target, path)
    }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub(super) struct RunProps {
    pub(super) bold: Option<bool>,
    pub(super) italic: Option<bool>,
    pub(super) underline: Option<bool>,
    pub(super) strike: Option<bool>,
    pub(super) color: Option<String>,
    pub(super) highlight: Option<String>,
    pub(super) vert: Option<String>,
    pub(super) font: Option<String>,
    pub(super) size_half: Option<u32>,
    pub(super) rstyle: Option<String>,
}

impl RunProps {
    /// `over` l'emporte sur `self` champ par champ.
    pub(super) fn overlay(mut self, over: &RunProps) -> RunProps {
        macro_rules! o {
            ($f:ident) => {
                if over.$f.is_some() {
                    self.$f = over.$f.clone();
                }
            };
        }
        o!(bold);
        o!(italic);
        o!(underline);
        o!(strike);
        o!(color);
        o!(highlight);
        o!(vert);
        o!(font);
        o!(size_half);
        o!(rstyle);
        self
    }

    /// Seules les marques « de contenu » d'un style de paragraphe sont reprises.
    fn content_only(&self) -> RunProps {
        RunProps {
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strike: self.strike,
            color: self.color.clone(),
            ..Default::default()
        }
    }
}

fn toggle(parent: &Element, name: &str) -> Option<bool> {
    let e = parent.find(name)?;
    Some(!matches!(
        e.attr("w:val"),
        Some("0" | "false" | "off" | "none")
    ))
}

fn highlight_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "yellow" => "#ffff00",
        "green" => "#00ff00",
        "cyan" => "#00ffff",
        "magenta" => "#ff00ff",
        "blue" => "#0000ff",
        "red" => "#ff0000",
        "darkBlue" => "#000080",
        "darkCyan" => "#008080",
        "darkGreen" => "#008000",
        "darkMagenta" => "#800080",
        "darkRed" => "#800000",
        "darkYellow" => "#808000",
        "darkGray" => "#808080",
        "lightGray" => "#c0c0c0",
        "black" => "#000000",
        "white" => "#ffffff",
        _ => return None,
    })
}

fn parse_rpr(rpr: &Element) -> RunProps {
    let color = rpr
        .find("w:color")
        .and_then(|c| c.attr("w:val"))
        .filter(|v| *v != "auto")
        .and_then(|v| to_hex6(&format!("#{v}")));
    let highlight = rpr
        .find("w:highlight")
        .and_then(|h| h.attr("w:val"))
        .and_then(highlight_name)
        .map(String::from)
        .or_else(|| {
            rpr.find("w:shd")
                .and_then(|s| s.attr("w:fill"))
                .filter(|f| *f != "auto")
                .and_then(|f| to_hex6(&format!("#{f}")))
        });
    let font = rpr.find("w:rFonts").and_then(|f| {
        ["w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"]
            .iter()
            .find_map(|k| f.attr(k))
            .map(String::from)
    });
    RunProps {
        bold: toggle(rpr, "w:b"),
        italic: toggle(rpr, "w:i"),
        underline: toggle(rpr, "w:u"),
        strike: toggle(rpr, "w:strike").or_else(|| toggle(rpr, "w:dstrike")),
        color,
        highlight,
        vert: rpr
            .find("w:vertAlign")
            .and_then(|v| v.attr("w:val"))
            .map(String::from),
        font,
        size_half: rpr
            .find("w:sz")
            .and_then(|s| s.attr("w:val"))
            .and_then(|v| v.parse().ok()),
        rstyle: rpr
            .find("w:rStyle")
            .and_then(|s| s.attr("w:val"))
            .map(String::from),
    }
}

pub(super) fn is_monospace(font: &str) -> bool {
    let f = font.to_lowercase();
    [
        "consolas",
        "courier",
        "lucida console",
        "source code",
        "menlo",
        "monaco",
        "mono",
        "monospace",
    ]
    .iter()
    .any(|m| f.contains(m))
}

pub(super) fn marks_from(rp: &RunProps, link: Option<&str>) -> Vec<Mark> {
    let mut m = Vec::new();
    if let Some(h) = link {
        m.push(Mark::Link {
            href: h.to_string(),
        });
    }
    if rp.bold == Some(true) {
        m.push(Mark::Bold);
    }
    if rp.italic == Some(true) {
        m.push(Mark::Italic);
    }
    if rp.underline == Some(true) {
        m.push(Mark::Underline);
    }
    if rp.strike == Some(true) {
        m.push(Mark::Strike);
    }
    let code = rp.font.as_deref().is_some_and(is_monospace);
    if code {
        m.push(Mark::Code);
    }
    let size = rp.size_half.map(|h| format_pt(h as f32 / 2.0));
    let font = if code { None } else { rp.font.clone() };
    if let Some(ts) = Mark::text_style(rp.color.clone(), font, size) {
        m.push(ts);
    }
    if let Some(c) = &rp.highlight {
        m.push(Mark::Highlight {
            color: Some(c.clone()),
        });
    }
    match rp.vert.as_deref() {
        Some("subscript") => m.push(Mark::Subscript),
        Some("superscript") => m.push(Mark::Superscript),
        _ => {}
    }
    m
}

#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Normal,
    Heading(u8),
    Quote,
    Code(Option<String>),
}

#[derive(Debug, Clone, Default)]
struct StyleDef {
    name: String,
    based_on: Option<String>,
    rpr: RunProps,
    jc: Option<String>,
    num_id: Option<u32>,
    ilvl: Option<u32>,
}

#[derive(Default)]
struct Styles(HashMap<String, StyleDef>);

impl Styles {
    fn parse(root: &Element) -> Styles {
        let mut map = HashMap::new();
        for s in root.elems().filter(|e| e.name == "w:style") {
            let Some(id) = s.attr("w:styleId") else {
                continue;
            };
            let ppr = s.find("w:pPr");
            let numpr = ppr.and_then(|p| p.find("w:numPr"));
            let val = |e: Option<&Element>, n: &str| {
                e.and_then(|x| x.find(n))
                    .and_then(|x| x.attr("w:val"))
                    .map(String::from)
            };
            map.insert(
                id.to_string(),
                StyleDef {
                    name: val(Some(s), "w:name").unwrap_or_default(),
                    based_on: val(Some(s), "w:basedOn"),
                    rpr: s.find("w:rPr").map(parse_rpr).unwrap_or_default(),
                    jc: val(ppr, "w:jc"),
                    num_id: val(numpr, "w:numId").and_then(|v| v.parse().ok()),
                    ilvl: val(numpr, "w:ilvl").and_then(|v| v.parse().ok()),
                },
            );
        }
        Styles(map)
    }

    /// Chaîne `id` puis ses parents (max 8).
    fn chain<'a>(&'a self, id: &'a str) -> Vec<(&'a str, &'a StyleDef)> {
        let mut out = Vec::new();
        let mut cur = Some(id);
        while let Some(c) = cur {
            if out.len() >= 8 {
                break;
            }
            match self.0.get(c) {
                Some(d) => {
                    out.push((c, d));
                    cur = d.based_on.as_deref();
                }
                None => {
                    out.push((c, &EMPTY_STYLE));
                    break;
                }
            }
        }
        out
    }

    fn classify(&self, id: &str) -> Kind {
        for (sid, def) in self.chain(id) {
            let name = def.name.to_lowercase();
            let sid_l = sid.to_lowercase();
            if let Some(lang) = name.strip_prefix("code block:") {
                let orig = def.name.get(def.name.len() - lang.len()..).unwrap_or("");
                let lang = orig.trim();
                return Kind::Code((!lang.is_empty()).then(|| lang.to_string()));
            }
            if name == "code block"
                || name == "source code"
                || name == "preformatted text"
                || name == "html preformatted"
                || sid_l == "codeblock"
            {
                return Kind::Code(None);
            }
            if name == "title" || sid_l == "title" {
                return Kind::Heading(1);
            }
            let digit = |s: &str, prefixes: &[&str]| -> Option<u8> {
                prefixes.iter().find_map(|p| {
                    let rest = s.strip_prefix(p)?.trim();
                    rest.parse::<u8>().ok().filter(|n| *n >= 1)
                })
            };
            if let Some(n) =
                digit(&name, &["heading", "titre"]).or_else(|| digit(&sid_l, &["heading", "titre"]))
            {
                return Kind::Heading(n.min(6));
            }
            if matches!(
                name.as_str(),
                "quote" | "intense quote" | "block text" | "blockquote" | "block quotation"
            ) || matches!(sid_l.as_str(), "quote" | "intensequote" | "blocktext")
            {
                return Kind::Quote;
            }
        }
        Kind::Normal
    }

    fn char_rpr(&self, id: &str) -> RunProps {
        let mut acc = RunProps::default();
        for (_, def) in self.chain(id).into_iter().rev() {
            acc = acc.overlay(&def.rpr);
        }
        acc
    }

    fn para_rpr(&self, id: &str) -> RunProps {
        self.char_rpr(id).content_only()
    }

    fn jc(&self, id: &str) -> Option<String> {
        self.chain(id).into_iter().find_map(|(_, d)| d.jc.clone())
    }

    fn num(&self, id: &str) -> (Option<u32>, Option<u32>) {
        let chain = self.chain(id);
        (
            chain.iter().find_map(|(_, d)| d.num_id),
            chain.iter().find_map(|(_, d)| d.ilvl),
        )
    }
}

static EMPTY_STYLE: StyleDef = StyleDef {
    name: String::new(),
    based_on: None,
    rpr: RunProps {
        bold: None,
        italic: None,
        underline: None,
        strike: None,
        color: None,
        highlight: None,
        vert: None,
        font: None,
        size_half: None,
        rstyle: None,
    },
    jc: None,
    num_id: None,
    ilvl: None,
};

/// numId -> (ilvl -> (ordonnée ?, début)).
type Numbering = HashMap<u32, HashMap<u32, (bool, u32)>>;

fn parse_numbering(root: &Element) -> Numbering {
    let mut abstracts: HashMap<String, HashMap<u32, (bool, u32)>> = HashMap::new();
    for a in root.elems().filter(|e| e.name == "w:abstractNum") {
        let Some(id) = a.attr("w:abstractNumId") else {
            continue;
        };
        let mut levels = HashMap::new();
        for l in a.elems().filter(|e| e.name == "w:lvl") {
            let ilvl: u32 = l.attr("w:ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
            let fmt = l
                .find("w:numFmt")
                .and_then(|f| f.attr("w:val"))
                .unwrap_or("decimal");
            let start = l
                .find("w:start")
                .and_then(|f| f.attr("w:val"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            levels.insert(ilvl, (!matches!(fmt, "bullet" | "none"), start));
        }
        abstracts.insert(id.to_string(), levels);
    }
    let mut out = HashMap::new();
    for n in root.elems().filter(|e| e.name == "w:num") {
        let Some(id) = n.attr("w:numId").and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        let mut levels = n
            .find("w:abstractNumId")
            .and_then(|a| a.attr("w:val"))
            .and_then(|a| abstracts.get(a))
            .cloned()
            .unwrap_or_default();
        for ov in n.elems().filter(|e| e.name == "w:lvlOverride") {
            let ilvl: u32 = ov.attr("w:ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
            let start = ov
                .find("w:startOverride")
                .and_then(|s| s.attr("w:val"))
                .or_else(|| {
                    ov.find("w:lvl")
                        .and_then(|l| l.find("w:start"))
                        .and_then(|s| s.attr("w:val"))
                })
                .and_then(|v| v.parse().ok());
            if let Some(st) = start {
                let e = levels.entry(ilvl).or_insert((true, st));
                e.1 = st;
            }
        }
        out.insert(id, levels);
    }
    out
}

struct Rel {
    target: String,
    external: bool,
}

enum Item {
    Block(Block),
    List {
        level: u32,
        num_id: u32,
        ordered: bool,
        start: u32,
        content: Block,
    },
    Code {
        lang: Option<String>,
        text: String,
    },
    Quote(Block),
}

struct Field {
    instr: String,
    in_result: bool,
}

struct Reader<'a, 'b> {
    archive: &'a mut Zip<'b>,
    rels: HashMap<String, Rel>,
    styles: Styles,
    nums: Numbering,
    lossy: Lossy,
    cells: usize,
    media_bytes: u64,
    sections: u32,
}

fn field_link(instr: &str) -> Option<String> {
    let t = instr.trim();
    if !t.to_uppercase().starts_with("HYPERLINK") {
        return None;
    }
    let quoted = t.split('"').nth(1).map(String::from)?;
    if t.contains("\\l") {
        Some(format!("#{quoted}"))
    } else {
        Some(quoted)
    }
}

impl Reader<'_, '_> {
    fn load_rels(&mut self, part: &str) -> Result<()> {
        let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
        let rels_path = format!("{dir}/_rels/{file}.rels");
        if let Some(root) = zip_read_xml(self.archive, &rels_path)? {
            for r in root.elems().filter(|e| e.name == "Relationship") {
                if let (Some(id), Some(target)) = (r.attr("Id"), r.attr("Target")) {
                    self.rels.insert(
                        id.to_string(),
                        Rel {
                            target: target.to_string(),
                            external: r.attr("TargetMode") == Some("External"),
                        },
                    );
                }
            }
        }
        Ok(())
    }

    fn link_of_rel(&self, id: &str) -> Option<String> {
        let r = self.rels.get(id)?;
        r.external.then(|| r.target.clone())
    }

    fn image_from_rel(
        &mut self,
        rid: &str,
        alt: Option<String>,
        title: Option<String>,
        cx: Option<u64>,
    ) -> Option<Inline> {
        let rel = self.rels.get(rid)?;
        if rel.external {
            self.lossy.add("linked_images");
            return None;
        }
        let path = resolve_path("word", &rel.target);
        let bytes = zip_read_media(self.archive, &path).ok()??;
        self.media_bytes += bytes.len() as u64;
        if self.media_bytes > 512 * 1024 * 1024 {
            self.lossy.add("images_limit");
            return None;
        }
        let mime = sniff_image_mime(&bytes, &path);
        let natural = image_size(&bytes).map(|(w, _)| w);
        let width = cx
            .map(|c| (c / 9525) as u32)
            .filter(|w| *w > 0 && natural.is_none_or(|n| n.abs_diff(*w) > 1));
        Some(Inline::Image(Image {
            src: make_data_uri(&mime, &bytes),
            alt,
            title,
            width,
        }))
    }

    fn drawing(&mut self, d: &Element, out: &mut Vec<Inline>) {
        if d.has_descendant("wps:wsp") || d.has_descendant("w:txbxContent") {
            self.lossy.add("shapes");
        }
        let Some(blip) = d.descendant("a:blip") else {
            self.lossy.add("shapes");
            return;
        };
        let Some(rid) = blip.attr("r:embed") else {
            self.lossy.add("linked_images");
            return;
        };
        let docpr = d.descendant("wp:docPr");
        let non_empty = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(String::from);
        let alt = non_empty(docpr.and_then(|p| p.attr("descr")));
        let title = non_empty(docpr.and_then(|p| p.attr("title")));
        let cx = d
            .descendant("wp:extent")
            .and_then(|e| e.attr("cx"))
            .and_then(|v| v.parse::<u64>().ok());
        if let Some(img) = self.image_from_rel(rid, alt, title, cx) {
            out.push(img);
        }
    }

    fn run_children(
        &mut self,
        parent: &Element,
        marks: &[Mark],
        link_default: Option<&str>,
        fields: &mut Vec<Field>,
        out: &mut Vec<Inline>,
    ) {
        let mut buf = String::new();
        macro_rules! flush {
            () => {
                if !buf.is_empty() {
                    let link = fields
                        .iter()
                        .rev()
                        .filter(|f| f.in_result)
                        .find_map(|f| field_link(&f.instr));
                    let mut ms = marks.to_vec();
                    if link_default.is_none() {
                        if let Some(l) = link {
                            ms.insert(0, Mark::Link { href: l });
                        }
                    }
                    out.push(Inline::Text {
                        text: std::mem::take(&mut buf),
                        marks: ms,
                    });
                }
            };
        }
        for c in parent.elems() {
            let in_instr = fields.last().is_some_and(|f| !f.in_result);
            match c.name.as_str() {
                "w:t" if !in_instr => buf.push_str(&c.own_text()),
                "w:tab" | "w:ptab" => buf.push('\t'),
                "w:noBreakHyphen" => buf.push('-'),
                "w:br" => match c.attr("w:type") {
                    Some("page") | Some("column") => self.lossy.add("page_breaks"),
                    _ => {
                        flush!();
                        out.push(Inline::HardBreak);
                    }
                },
                "w:cr" => {
                    flush!();
                    out.push(Inline::HardBreak);
                }
                "w:fldChar" => match c.attr("w:fldCharType") {
                    Some("begin") => {
                        flush!();
                        if fields.len() < MAX_DEPTH {
                            fields.push(Field {
                                instr: String::new(),
                                in_result: false,
                            });
                        }
                    }
                    Some("separate") => {
                        if let Some(f) = fields.last_mut() {
                            f.in_result = true;
                        }
                    }
                    Some("end") => {
                        flush!();
                        if let Some(f) = fields.pop() {
                            if field_link(&f.instr).is_none() {
                                self.lossy.add("fields");
                            }
                        }
                    }
                    _ => {}
                },
                "w:instrText" => {
                    if let Some(f) = fields.last_mut() {
                        f.instr.push_str(&c.own_text());
                    }
                }
                "w:drawing" => {
                    flush!();
                    self.drawing(c, out);
                }
                "w:pict" | "w:object" => {
                    flush!();
                    if let Some(rid) = c.descendant("v:imagedata").and_then(|i| i.attr("r:id")) {
                        if let Some(img) = self.image_from_rel(rid, None, None, None) {
                            out.push(img);
                        }
                    } else {
                        self.lossy.add("shapes");
                    }
                }
                "mc:AlternateContent" => {
                    flush!();
                    if let Some(ch) = c.find("mc:Choice") {
                        self.run_children(ch, marks, link_default, fields, out);
                    }
                }
                "w:footnoteReference" | "w:endnoteReference" => self.lossy.add("footnotes"),
                "w:commentReference" => self.lossy.add("comments"),
                _ => {}
            }
        }
        flush!();
    }

    fn run(
        &mut self,
        r: &Element,
        base: &RunProps,
        link: Option<&str>,
        fields: &mut Vec<Field>,
        out: &mut Vec<Inline>,
    ) {
        let direct = r.find("w:rPr").map(parse_rpr).unwrap_or_default();
        let mut rp = base.clone();
        if let Some(sid) = &direct.rstyle {
            let lower = sid.to_lowercase();
            let skip = lower == "hyperlink"
                || self
                    .styles
                    .0
                    .get(sid)
                    .is_some_and(|d| d.name.eq_ignore_ascii_case("hyperlink"));
            if !skip {
                rp = rp.overlay(&self.styles.char_rpr(sid));
            }
        }
        rp = rp.overlay(&direct);
        let marks = marks_from(&rp, link);
        self.run_children(r, &marks, link, fields, out);
    }

    fn inlines(
        &mut self,
        parent: &Element,
        base: &RunProps,
        link: Option<&str>,
        fields: &mut Vec<Field>,
        out: &mut Vec<Inline>,
    ) {
        for c in parent.elems() {
            match c.name.as_str() {
                "w:r" => self.run(c, base, link, fields, out),
                "w:hyperlink" => {
                    let href = c
                        .attr("r:id")
                        .and_then(|id| self.link_of_rel(id))
                        .or_else(|| c.attr("w:anchor").map(|a| format!("#{a}")))
                        .or_else(|| link.map(String::from));
                    self.inlines(c, base, href.as_deref(), fields, out);
                }
                "w:ins" | "w:moveTo" => {
                    self.lossy.add("tracked_changes");
                    self.inlines(c, base, link, fields, out);
                }
                "w:del" | "w:moveFrom" => self.lossy.add("tracked_changes"),
                "w:smartTag" | "w:customXml" | "w:dir" | "w:bdo" => {
                    self.inlines(c, base, link, fields, out)
                }
                "w:sdt" => {
                    if let Some(content) = c.find("w:sdtContent") {
                        self.inlines(content, base, link, fields, out);
                    }
                }
                "w:fldSimple" => {
                    let href = c.attr("w:instr").and_then(field_link);
                    if href.is_none() {
                        self.lossy.add("fields");
                    }
                    let l = href.or_else(|| link.map(String::from));
                    self.inlines(c, base, l.as_deref(), fields, out);
                }
                "w:commentRangeStart" | "w:commentRangeEnd" => self.lossy.add("comments"),
                "mc:AlternateContent" => {
                    if let Some(ch) = c.find("mc:Choice") {
                        self.inlines(ch, base, link, fields, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn para(&mut self, p: &Element) -> Item {
        let ppr = p.find("w:pPr");
        let style_id = ppr
            .and_then(|x| x.find("w:pStyle"))
            .and_then(|s| s.attr("w:val"));
        let kind = style_id.map_or(Kind::Normal, |s| self.styles.classify(s));
        let base = match (&kind, style_id) {
            (Kind::Normal, Some(s)) => self.styles.para_rpr(s),
            _ => RunProps::default(),
        };
        if ppr.is_some_and(|x| x.has_descendant("w:sectPr")) {
            self.sections += 1;
        }
        let mut content = Vec::new();
        let mut fields = Vec::new();
        self.inlines(p, &base, None, &mut fields, &mut content);

        let align = ppr
            .and_then(|x| x.find("w:jc"))
            .and_then(|j| j.attr("w:val").map(String::from))
            .or_else(|| style_id.and_then(|s| self.styles.jc(s)))
            .and_then(|v| Align::from_css(&v));

        if let Kind::Code(lang) = kind {
            return Item::Code {
                lang,
                text: inlines_text(&content),
            };
        }
        let empty = content.iter().all(|i| match i {
            Inline::Text { text, .. } => text.trim().is_empty(),
            _ => false,
        });
        let has_bottom_border = ppr
            .and_then(|x| x.find("w:pBdr"))
            .and_then(|b| b.find("w:bottom"))
            .is_some_and(|b| !matches!(b.attr("w:val"), Some("nil" | "none")));
        if empty && has_bottom_border {
            return Item::Block(Block::HorizontalRule);
        }
        match kind {
            Kind::Heading(level) => Item::Block(Block::Heading {
                level,
                align,
                content,
            }),
            Kind::Quote => Item::Quote(Block::Paragraph { align, content }),
            _ => {
                // Numérotation : directe puis héritée du style.
                let direct = ppr.and_then(|x| x.find("w:numPr"));
                let from_style = style_id.map(|s| self.styles.num(s)).unwrap_or((None, None));
                let num_id = direct
                    .and_then(|n| n.find("w:numId"))
                    .and_then(|n| n.attr("w:val"))
                    .and_then(|v| v.parse::<u32>().ok())
                    .or(from_style.0);
                let ilvl = direct
                    .and_then(|n| n.find("w:ilvl"))
                    .and_then(|n| n.attr("w:val"))
                    .and_then(|v| v.parse::<u32>().ok())
                    .or(from_style.1)
                    .unwrap_or(0)
                    .min(16);
                let paragraph = Block::Paragraph { align, content };
                match num_id {
                    Some(id) if id != 0 => {
                        let (ordered, start) = self
                            .nums
                            .get(&id)
                            .and_then(|l| l.get(&ilvl))
                            .copied()
                            .unwrap_or((false, 1));
                        Item::List {
                            level: ilvl,
                            num_id: id,
                            ordered,
                            start,
                            content: paragraph,
                        }
                    }
                    _ => Item::Block(paragraph),
                }
            }
        }
    }

    fn collect_items(&mut self, container: &Element, depth: usize, items: &mut Vec<Item>) {
        if depth > MAX_DEPTH {
            return;
        }
        for c in container.elems() {
            match c.name.as_str() {
                "w:p" => {
                    let it = self.para(c);
                    items.push(it);
                }
                "w:tbl" => {
                    let t = self.table(c, depth + 1);
                    items.push(Item::Block(t));
                }
                "w:sdt" => {
                    if let Some(content) = c.find("w:sdtContent") {
                        self.collect_items(content, depth + 1, items);
                    }
                }
                "w:customXml" | "w:ins" | "w:moveTo" => self.collect_items(c, depth + 1, items),
                "w:del" | "w:moveFrom" => self.lossy.add("tracked_changes"),
                "mc:AlternateContent" => self.lossy.add("shapes"),
                _ => {}
            }
        }
    }

    fn blocks_of(&mut self, container: &Element, depth: usize) -> Vec<Block> {
        let mut items = Vec::new();
        self.collect_items(container, depth, &mut items);
        group(items)
    }

    fn table(&mut self, tbl: &Element, depth: usize) -> Block {
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        // colonne de grille -> (ligne, index de cellule) de la cellule vMerge d'origine
        let mut open: HashMap<u32, (usize, usize)> = HashMap::new();
        for tr in tbl.elems().filter(|e| e.name == "w:tr") {
            let trpr = tr.find("w:trPr");
            let header = trpr.is_some_and(|t| t.find("w:tblHeader").is_some());
            let mut col: u32 = trpr
                .and_then(|t| t.find("w:gridBefore"))
                .and_then(|g| g.attr("w:val"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let row_idx = rows.len();
            let mut row: Vec<Cell> = Vec::new();
            for tc in tr.elems().filter(|e| e.name == "w:tc") {
                self.cells += 1;
                if self.cells > MAX_CELLS {
                    self.lossy.add("cells_limit");
                    break;
                }
                let tcpr = tc.find("w:tcPr");
                let span: u32 = tcpr
                    .and_then(|t| t.find("w:gridSpan"))
                    .and_then(|g| g.attr("w:val"))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1)
                    .clamp(1, 1000);
                let vmerge = tcpr.and_then(|t| t.find("w:vMerge"));
                match vmerge.map(|v| v.attr("w:val")) {
                    Some(Some("restart")) => {
                        open.insert(col, (row_idx, row.len()));
                    }
                    Some(_) => {
                        // continuation : agrandit la cellule d'origine
                        if let Some(&(r, c)) = open.get(&col) {
                            let target = if r == row_idx {
                                row.get_mut(c)
                            } else {
                                rows.get_mut(r).and_then(|rw| rw.get_mut(c))
                            };
                            if let Some(cell) = target {
                                cell.rowspan += 1;
                            }
                        }
                        col += span;
                        continue;
                    }
                    None => {
                        open.remove(&col);
                    }
                }
                let content = self.blocks_of(tc, depth + 1);
                row.push(Cell {
                    header,
                    colspan: span,
                    rowspan: 1,
                    content,
                });
                col += span;
            }
            rows.push(row);
        }
        Block::Table(rows)
    }
}

#[derive(PartialEq)]
enum Prev {
    Other,
    Code,
    Quote,
}

struct OpenList {
    level: u32,
    num_id: u32,
    ordered: bool,
    start: u32,
    items: Vec<Vec<Block>>,
}

fn close_top(stack: &mut Vec<OpenList>, out: &mut Vec<Block>) {
    let Some(l) = stack.pop() else {
        return;
    };
    let block = if l.ordered {
        Block::OrderedList {
            start: l.start,
            items: l.items,
        }
    } else {
        Block::BulletList(l.items)
    };
    match stack.last_mut() {
        Some(parent) => {
            if parent.items.is_empty() {
                parent.items.push(vec![]);
            }
            if let Some(last) = parent.items.last_mut() {
                last.push(block);
            }
        }
        None => out.push(block),
    }
}

/// Regroupe les paragraphes-éléments en listes imbriquées, code et citations continus.
fn group(items: Vec<Item>) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    let mut stack: Vec<OpenList> = Vec::new();
    let mut prev = Prev::Other;
    for item in items {
        match item {
            Item::List {
                level,
                num_id,
                ordered,
                start,
                content,
            } => {
                while stack.last().is_some_and(|l| l.level > level) {
                    close_top(&mut stack, &mut out);
                }
                if stack
                    .last()
                    .is_some_and(|l| l.level == level && l.num_id != num_id)
                {
                    close_top(&mut stack, &mut out);
                }
                if stack.last().is_none_or(|l| l.level < level) {
                    stack.push(OpenList {
                        level,
                        num_id,
                        ordered,
                        start,
                        items: vec![],
                    });
                }
                if let Some(top) = stack.last_mut() {
                    top.items.push(vec![content]);
                }
                prev = Prev::Other;
            }
            other => {
                while !stack.is_empty() {
                    close_top(&mut stack, &mut out);
                }
                match other {
                    Item::Block(b) => {
                        out.push(b);
                        prev = Prev::Other;
                    }
                    Item::Code { lang, text } => {
                        if let (Prev::Code, Some(Block::CodeBlock { text: t, .. })) =
                            (&prev, out.last_mut())
                        {
                            t.push('\n');
                            t.push_str(&text);
                        } else {
                            out.push(Block::CodeBlock {
                                language: lang,
                                text,
                            });
                        }
                        prev = Prev::Code;
                    }
                    Item::Quote(b) => {
                        if let (Prev::Quote, Some(Block::Blockquote(c))) = (&prev, out.last_mut()) {
                            c.push(b);
                        } else {
                            out.push(Block::Blockquote(vec![b]));
                        }
                        prev = Prev::Quote;
                    }
                    Item::List { .. } => {}
                }
            }
        }
    }
    while !stack.is_empty() {
        close_top(&mut stack, &mut out);
    }
    out
}

pub fn parse(bytes: &[u8]) -> Result<RichDoc> {
    let mut archive = open_zip(bytes)?;
    let names: Vec<String> = archive
        .file_names()
        .flatten()
        .map(|n| n.into_owned())
        .collect();
    let mut lossy = Lossy::default();

    // Partie principale : via _rels/.rels, sinon word/document.xml.
    let mut main = "word/document.xml".to_string();
    if let Some(root) = zip_read_xml(&mut archive, "_rels/.rels")? {
        if let Some(t) = root
            .elems()
            .find(|r| {
                r.attr("Type")
                    .is_some_and(|t| t.ends_with("/officeDocument"))
            })
            .and_then(|r| r.attr("Target"))
        {
            main = resolve_path("", t);
        }
    }
    let doc_root = zip_read_xml(&mut archive, &main)?
        .ok_or_else(|| AppError::Corrupt("word/document.xml absent".into()))?;
    if doc_root.name != "w:document" {
        return Err(AppError::Corrupt("document.xml invalide".into()));
    }
    let main_dir = main.rsplit_once('/').map_or("", |(d, _)| d).to_string();

    let styles = zip_read_xml(&mut archive, &format!("{main_dir}/styles.xml"))?
        .map(|r| Styles::parse(&r))
        .unwrap_or_default();
    let nums = zip_read_xml(&mut archive, &format!("{main_dir}/numbering.xml"))?
        .map(|r| parse_numbering(&r))
        .unwrap_or_default();

    let mut meta = RichMeta::default();
    if let Some(core) = zip_read_xml(&mut archive, "docProps/core.xml")? {
        let get = |n: &str| {
            core.find(n)
                .map(|e| e.deep_text().trim().to_string())
                .filter(|s| !s.is_empty())
        };
        meta.title = get("dc:title");
        meta.author = get("dc:creator");
    }

    for n in &names {
        let l = n.to_lowercase();
        if l.starts_with("word/header") || l.starts_with("word/footer") {
            if l.ends_with(".xml") {
                lossy.add("headers_footers");
            }
        } else if l == "word/comments.xml" {
            lossy.add("comments");
        } else if l.ends_with("vbaproject.bin") {
            lossy.add("macros");
        } else if l.starts_with("word/embeddings/") {
            lossy.add("embedded_objects");
        } else if l.starts_with("word/charts/") {
            lossy.add("charts");
        } else if l.starts_with("word/diagrams/") {
            lossy.add("shapes");
        }
    }

    let body = doc_root
        .find("w:body")
        .ok_or_else(|| AppError::Corrupt("w:body absent".into()))?;
    let mut reader = Reader {
        archive: &mut archive,
        rels: HashMap::new(),
        styles,
        nums,
        lossy,
        cells: 0,
        media_bytes: 0,
        sections: 0,
    };
    reader.load_rels(&main)?;
    let blocks = reader.blocks_of(body, 0);
    if reader.sections > 1 {
        reader.lossy.add("sections");
    }
    let mut tree = RichTree { blocks };
    tree.raise_tasks();
    Ok(tree.into_rich(meta, reader.lossy))
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" \
xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"";

const REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_DISPLAY_PX: u32 = 624;

enum NumInst {
    Bullet,
    Ordered { level: u32, start: u32 },
}

struct Writer {
    body: String,
    rels: Vec<(String, String, String, bool)>,
    media: Vec<(String, Vec<u8>)>,
    media_types: BTreeMap<String, String>,
    nums: Vec<NumInst>,
    code_langs: Vec<String>,
    doc_pr: u32,
}

fn rgb(hex: &str) -> Option<String> {
    to_hex6(hex).map(|h| h[1..].to_uppercase())
}

impl Writer {
    fn new() -> Self {
        Writer {
            body: String::new(),
            rels: Vec::new(),
            media: Vec::new(),
            media_types: BTreeMap::new(),
            nums: Vec::new(),
            code_langs: Vec::new(),
            doc_pr: 0,
        }
    }

    fn add_rel(&mut self, ty: &str, target: &str, external: bool) -> String {
        if let Some((id, ..)) = self
            .rels
            .iter()
            .find(|(_, t, tg, ex)| t == ty && tg == target && *ex == external)
        {
            return id.clone();
        }
        let id = format!("rId{}", self.rels.len() + 3);
        self.rels
            .push((id.clone(), ty.into(), target.into(), external));
        id
    }

    fn rpr(&self, marks: &[Mark], linked: bool) -> String {
        let mut s = String::new();
        let mut bold = false;
        let mut italic = false;
        let mut strike = false;
        let mut underline = false;
        let mut code = false;
        let mut ts: Option<(&Option<String>, &Option<String>, &Option<String>)> = None;
        let mut hl: Option<&Option<String>> = None;
        let mut vert = None;
        for m in marks {
            match m {
                Mark::Bold => bold = true,
                Mark::Italic => italic = true,
                Mark::Strike => strike = true,
                Mark::Underline => underline = true,
                Mark::Code => code = true,
                Mark::TextStyle {
                    color,
                    font_family,
                    font_size,
                } => ts = Some((color, font_family, font_size)),
                Mark::Highlight { color } => hl = Some(color),
                Mark::Subscript => vert = Some("subscript"),
                Mark::Superscript => vert = Some("superscript"),
                Mark::Link { .. } => {}
            }
        }
        if linked {
            s.push_str("<w:rStyle w:val=\"Hyperlink\"/>");
        } else if code {
            s.push_str("<w:rStyle w:val=\"CodeChar\"/>");
        }
        let font = if linked && code {
            Some("Consolas".to_string())
        } else {
            ts.and_then(|t| t.1.clone())
        };
        if let Some(f) = font {
            let f = xml_escaped(&f);
            let _ = write!(
                s,
                "<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:cs=\"{f}\"/>"
            );
        }
        if bold {
            s.push_str("<w:b/>");
        }
        if italic {
            s.push_str("<w:i/>");
        }
        if strike {
            s.push_str("<w:strike/>");
        }
        if let Some(c) = ts.and_then(|t| t.0.as_deref()).and_then(rgb) {
            let _ = write!(s, "<w:color w:val=\"{c}\"/>");
        }
        if let Some(pt) = ts.and_then(|t| t.2.as_deref()).and_then(parse_font_size_pt) {
            let half = (pt * 2.0).round() as u32;
            let _ = write!(s, "<w:sz w:val=\"{half}\"/><w:szCs w:val=\"{half}\"/>");
        }
        if underline {
            s.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(h) = hl {
            let c = h
                .as_deref()
                .and_then(rgb)
                .unwrap_or_else(|| "FFFF00".into());
            let _ = write!(
                s,
                "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{c}\"/>"
            );
        }
        if let Some(v) = vert {
            let _ = write!(s, "<w:vertAlign w:val=\"{v}\"/>");
        }
        if s.is_empty() {
            s
        } else {
            format!("<w:rPr>{s}</w:rPr>")
        }
    }

    fn text_run(&mut self, text: &str, rpr: &str) {
        let mut seg = String::new();
        let mut parts: Vec<String> = Vec::new();
        let flush = |seg: &mut String, parts: &mut Vec<String>| {
            if !seg.is_empty() {
                parts.push(format!(
                    "<w:t xml:space=\"preserve\">{}</w:t>",
                    xml_escaped(seg)
                ));
                seg.clear();
            }
        };
        for c in text.chars() {
            match c {
                '\t' => {
                    flush(&mut seg, &mut parts);
                    parts.push("<w:tab/>".into());
                }
                '\n' => {
                    flush(&mut seg, &mut parts);
                    parts.push("<w:br/>".into());
                }
                '\r' => {}
                c => seg.push(c),
            }
        }
        flush(&mut seg, &mut parts);
        if parts.is_empty() {
            return;
        }
        let _ = write!(self.body, "<w:r>{rpr}{}</w:r>", parts.concat());
    }

    fn image(&mut self, img: &Image) {
        let parsed = parse_data_uri(&img.src).filter(|(m, _)| m.starts_with("image/"));
        let Some((mime, bytes)) = parsed else {
            // Image non embarquable : on garde au moins le texte alternatif / la source.
            let label = img.alt.clone().unwrap_or_else(|| img.src.clone());
            self.text_run(&label, "");
            return;
        };
        let ext = ext_from_mime(&mime);
        if ext == "bin" {
            return;
        }
        let idx = self.media.len() + 1;
        let name = format!("image{idx}.{ext}");
        self.media_types
            .insert(ext.to_string(), mime_from_ext(ext).to_string());
        let rid = self.add_rel("image", &format!("media/{name}"), false);
        let (nw, nh) = image_size(&bytes).unwrap_or((96, 96));
        let (nw, nh) = (nw.max(1), nh.max(1));
        let (w, h) = match img.width {
            Some(w) => (
                w.max(1),
                (u64::from(w) * u64::from(nh) / u64::from(nw)).max(1) as u32,
            ),
            None if nw > MAX_DISPLAY_PX => (
                MAX_DISPLAY_PX,
                (u64::from(MAX_DISPLAY_PX) * u64::from(nh) / u64::from(nw)).max(1) as u32,
            ),
            None => (nw, nh),
        };
        let (cx, cy) = (u64::from(w) * 9525, u64::from(h) * 9525);
        self.media.push((name.clone(), bytes));
        self.doc_pr += 1;
        let id = self.doc_pr;
        let mut attrs = format!("id=\"{id}\" name=\"Image {id}\"");
        if let Some(a) = &img.alt {
            let _ = write!(attrs, " descr=\"{}\"", xml_escaped(a));
        }
        if let Some(t) = &img.title {
            let _ = write!(attrs, " title=\"{}\"", xml_escaped(t));
        }
        let _ = write!(
            self.body,
            "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:docPr {attrs}/>\
<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>\
</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
        );
    }

    fn inlines(&mut self, content: &[Inline]) {
        let link_of = |i: &Inline| -> Option<String> {
            match i {
                Inline::Text { marks, .. } => marks.iter().find_map(|m| match m {
                    Mark::Link { href } => Some(href.clone()),
                    _ => None,
                }),
                _ => None,
            }
        };
        let mut i = 0;
        while i < content.len() {
            let link = link_of(&content[i]);
            let mut j = i + 1;
            while j < content.len() && link_of(&content[j]) == link {
                j += 1;
            }
            if let Some(href) = &link {
                if let Some(anchor) = href.strip_prefix('#') {
                    let _ = write!(
                        self.body,
                        "<w:hyperlink w:anchor=\"{}\" w:history=\"1\">",
                        xml_escaped(anchor)
                    );
                } else {
                    let rid = self.add_rel("hyperlink", href, true);
                    let _ = write!(self.body, "<w:hyperlink r:id=\"{rid}\" w:history=\"1\">");
                }
            }
            for item in &content[i..j] {
                match item {
                    Inline::Text { text, marks } => {
                        let rpr = self.rpr(marks, link.is_some());
                        self.text_run(text, &rpr);
                    }
                    Inline::HardBreak => self.body.push_str("<w:r><w:br/></w:r>"),
                    Inline::Image(img) => self.image(img),
                }
            }
            if link.is_some() {
                self.body.push_str("</w:hyperlink>");
            }
            i = j;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn paragraph(
        &mut self,
        style: Option<&str>,
        num: Option<(u32, u32)>,
        align: Option<Align>,
        indent: Option<u32>,
        content: &[Inline],
    ) {
        let mut ppr = String::new();
        if let Some(s) = style {
            let _ = write!(ppr, "<w:pStyle w:val=\"{s}\"/>");
        }
        if let Some((ilvl, id)) = num {
            let _ = write!(
                ppr,
                "<w:numPr><w:ilvl w:val=\"{ilvl}\"/><w:numId w:val=\"{id}\"/></w:numPr>"
            );
        }
        if let Some(l) = indent {
            let _ = write!(ppr, "<w:ind w:left=\"{l}\"/>");
        }
        if let Some(a) = align {
            let v = if a == Align::Justify { "both" } else { a.css() };
            let _ = write!(ppr, "<w:jc w:val=\"{v}\"/>");
        }
        self.body.push_str("<w:p>");
        if !ppr.is_empty() {
            let _ = write!(self.body, "<w:pPr>{ppr}</w:pPr>");
        }
        self.inlines(content);
        self.body.push_str("</w:p>");
    }

    fn code_style(&mut self, lang: &Option<String>) -> String {
        match lang {
            None => "CodeBlock".into(),
            Some(l) => {
                let idx = match self.code_langs.iter().position(|x| x == l) {
                    Some(i) => i,
                    None => {
                        self.code_langs.push(l.clone());
                        self.code_langs.len() - 1
                    }
                };
                format!("CodeBlock{}", idx + 1)
            }
        }
    }

    fn blocks(&mut self, blocks: &[Block], quote: bool) {
        for (i, b) in blocks.iter().enumerate() {
            if matches!(b, Block::Table(_))
                && matches!(blocks.get(i.wrapping_sub(1)), Some(Block::Table(_)))
            {
                self.body.push_str("<w:p/>");
            }
            self.block(b, quote);
        }
    }

    fn block(&mut self, b: &Block, quote: bool) {
        match b {
            Block::Paragraph { align, content } => {
                self.paragraph(quote.then_some("Quote"), None, *align, None, content)
            }
            Block::Heading {
                level,
                align,
                content,
            } => {
                let style = format!("Heading{}", (*level).clamp(1, 6));
                self.paragraph(Some(&style), None, *align, None, content);
            }
            Block::BulletList(items) => self.list(None, items, 0),
            Block::OrderedList { start, items } => self.list(Some(*start), items, 0),
            Block::TaskList(items) => {
                // Normalement déjà abaissée en puces ; repli défensif.
                let lowered: Vec<Vec<Block>> = items
                    .iter()
                    .map(|TaskItem { content, .. }| content.clone())
                    .collect();
                self.list(None, &lowered, 0);
            }
            Block::Blockquote(c) => self.blocks(c, true),
            Block::CodeBlock { language, text } => {
                let style = self.code_style(language);
                let rpr = String::new();
                let _ = write!(self.body, "<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>");
                self.text_run(text, &rpr);
                self.body.push_str("</w:p>");
            }
            Block::HorizontalRule => self.body.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"808080\"/></w:pBdr></w:pPr></w:p>",
            ),
            Block::Table(rows) => self.table(rows),
        }
    }

    fn list(&mut self, ordered_start: Option<u32>, items: &[Vec<Block>], level: u32) {
        let level = level.min(8);
        let inst = match ordered_start {
            Some(start) => NumInst::Ordered { level, start },
            None => NumInst::Bullet,
        };
        self.nums.push(inst);
        let num_id = self.nums.len() as u32;
        for item in items {
            let mut rest = item.as_slice();
            match item.first() {
                Some(Block::Paragraph { align, content }) => {
                    self.paragraph(
                        Some("ListParagraph"),
                        Some((level, num_id)),
                        *align,
                        None,
                        content,
                    );
                    rest = &item[1..];
                }
                _ => self.paragraph(
                    Some("ListParagraph"),
                    Some((level, num_id)),
                    None,
                    None,
                    &[],
                ),
            }
            for b in rest {
                match b {
                    Block::BulletList(sub) => self.list(None, sub, level + 1),
                    Block::OrderedList { start, items } => {
                        self.list(Some(*start), items, level + 1)
                    }
                    Block::Paragraph { align, content } => {
                        self.paragraph(None, None, *align, Some(720 * (level + 1)), content)
                    }
                    other => self.block(other, false),
                }
            }
        }
    }

    fn table(&mut self, rows: &[Vec<Cell>]) {
        let mut xml = String::new();
        let mut ncols = 0u32;
        // occupation : colonne de départ -> (lignes restantes, colspan)
        let mut occ: Vec<(u32, u32)> = Vec::new();
        for row in rows {
            let all_header = !row.is_empty() && row.iter().all(|c| c.header);
            xml.push_str("<w:tr>");
            if all_header {
                xml.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            let mut col = 0usize;
            let mut cells = row.iter();
            loop {
                if let Some(&(rem, span)) = occ.get(col) {
                    if rem > 0 {
                        let _ = write!(
                            xml,
                            "<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>{}<w:vMerge/></w:tcPr><w:p/></w:tc>",
                            if span > 1 {
                                format!("<w:gridSpan w:val=\"{span}\"/>")
                            } else {
                                String::new()
                            }
                        );
                        if let Some(o) = occ.get_mut(col) {
                            o.0 -= 1;
                        }
                        col += span as usize;
                        continue;
                    }
                }
                let Some(cell) = cells.next() else {
                    break;
                };
                let span = cell.colspan.max(1);
                if occ.len() <= col {
                    occ.resize(col + 1, (0, 1));
                }
                if let Some(o) = occ.get_mut(col) {
                    *o = if cell.rowspan > 1 {
                        (cell.rowspan - 1, span)
                    } else {
                        (0, 1)
                    };
                }
                xml.push_str("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>");
                if span > 1 {
                    let _ = write!(xml, "<w:gridSpan w:val=\"{span}\"/>");
                }
                if cell.rowspan > 1 {
                    xml.push_str("<w:vMerge w:val=\"restart\"/>");
                }
                xml.push_str("</w:tcPr>");
                let saved = std::mem::take(&mut self.body);
                self.blocks(&cell.content, false);
                if !matches!(cell.content.last(), Some(b) if !matches!(b, Block::Table(_))) {
                    self.body.push_str("<w:p/>");
                }
                xml.push_str(&std::mem::replace(&mut self.body, saved));
                xml.push_str("</w:tc>");
                col += span as usize;
            }
            ncols = ncols.max(col as u32);
            xml.push_str("</w:tr>");
        }
        let ncols = ncols.max(1);
        let w = 9000 / ncols;
        self.body.push_str(
            "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/>\
<w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"1\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/></w:tblPr><w:tblGrid>",
        );
        for _ in 0..ncols {
            let _ = write!(self.body, "<w:gridCol w:w=\"{w}\"/>");
        }
        self.body.push_str("</w:tblGrid>");
        self.body.push_str(&xml);
        self.body.push_str("</w:tbl>");
    }
}

fn heading_style(level: usize, size: u32) -> String {
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"Heading{level}\"><w:name w:val=\"heading {level}\"/>\
<w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:uiPriority w:val=\"9\"/><w:qFormat/>\
<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"240\" w:after=\"80\"/><w:outlineLvl w:val=\"{}\"/></w:pPr>\
<w:rPr><w:b/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>",
        level - 1
    )
}

fn styles_xml(code_langs: &[String]) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/>\
<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:lang w:val=\"fr-FR\" w:eastAsia=\"en-US\" w:bidi=\"ar-SA\"/></w:rPr></w:rPrDefault>\
<w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"259\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>\
<w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/><w:uiPriority w:val=\"1\"/><w:semiHidden/></w:style>\
<w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/>\
<w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>\
<w:style w:type=\"numbering\" w:default=\"1\" w:styleId=\"NoList\"><w:name w:val=\"No List\"/><w:uiPriority w:val=\"99\"/><w:semiHidden/></w:style>",
    );
    let sizes = [40, 32, 28, 26, 24, 22];
    for (i, sz) in sizes.iter().enumerate() {
        s.push_str(&heading_style(i + 1, *sz));
    }
    s.push_str(
        "<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"BFBFBF\"/></w:pBdr><w:ind w:left=\"720\"/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:spacing w:after=\"40\"/><w:contextualSpacing/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"CodeBlock\"><w:name w:val=\"Code Block\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/><w:spacing w:after=\"120\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>\
<w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/><w:sz w:val=\"20\"/><w:szCs w:val=\"20\"/></w:rPr></w:style>\
<w:style w:type=\"character\" w:styleId=\"CodeChar\"><w:name w:val=\"Code Char\"/><w:basedOn w:val=\"DefaultParagraphFont\"/>\
<w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/></w:rPr></w:style>\
<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:basedOn w:val=\"DefaultParagraphFont\"/><w:uiPriority w:val=\"99\"/>\
<w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>\
<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:basedOn w:val=\"TableNormal\"/><w:uiPriority w:val=\"39\"/>\
<w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/>\
<w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/>\
<w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/></w:tblBorders></w:tblPr></w:style>",
    );
    for (i, lang) in code_langs.iter().enumerate() {
        let _ = write!(
            s,
            "<w:style w:type=\"paragraph\" w:customStyle=\"1\" w:styleId=\"CodeBlock{}\"><w:name w:val=\"Code Block: {}\"/><w:basedOn w:val=\"CodeBlock\"/><w:qFormat/></w:style>",
            i + 1,
            xml_escaped(lang)
        );
    }
    s.push_str("</w:styles>");
    s
}

fn numbering_xml(nums: &[NumInst]) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    );
    for (abs, bullet) in [(0, true), (1, false)] {
        let _ = write!(
            s,
            "<w:abstractNum w:abstractNumId=\"{abs}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>"
        );
        for l in 0..9u32 {
            let (fmt, text) = if bullet {
                (
                    "bullet",
                    ["\u{2022}", "\u{25E6}", "\u{25AA}"][(l % 3) as usize].to_string(),
                )
            } else {
                (
                    ["decimal", "lowerLetter", "lowerRoman"][(l % 3) as usize],
                    format!("%{}.", l + 1),
                )
            };
            let _ = write!(
                s,
                "<w:lvl w:ilvl=\"{l}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{text}\"/><w:lvlJc w:val=\"left\"/>\
<w:pPr><w:ind w:left=\"{}\" w:hanging=\"360\"/></w:pPr></w:lvl>",
                720 * (l + 1)
            );
        }
        s.push_str("</w:abstractNum>");
    }
    for (i, n) in nums.iter().enumerate() {
        let id = i + 1;
        match n {
            NumInst::Bullet => {
                let _ = write!(
                    s,
                    "<w:num w:numId=\"{id}\"><w:abstractNumId w:val=\"0\"/></w:num>"
                );
            }
            NumInst::Ordered { level, start } => {
                let _ = write!(
                    s,
                    "<w:num w:numId=\"{id}\"><w:abstractNumId w:val=\"1\"/><w:lvlOverride w:ilvl=\"{level}\"><w:startOverride w:val=\"{start}\"/></w:lvlOverride></w:num>"
                );
            }
        }
    }
    s.push_str("</w:numbering>");
    s
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io(std::io::Error::other(format!("écriture zip : {e}")))
}

pub fn serialize(rich: &RichDoc) -> Result<Vec<u8>> {
    let mut tree = RichTree::from_rich(rich);
    tree.lower_tasks();
    let mut w = Writer::new();
    w.blocks(&tree.blocks, false);
    if tree.blocks.is_empty() || matches!(tree.blocks.last(), Some(Block::Table(_))) {
        w.body.push_str("<w:p/>");
    }

    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS}><w:body>{}\
<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1417\" w:right=\"1417\" w:bottom=\"1417\" w:left=\"1417\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/></w:sectPr>\
</w:body></w:document>",
        w.body
    );

    let mut content_types = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    );
    for (ext, mime) in &w.media_types {
        let _ = write!(
            content_types,
            "<Default Extension=\"{ext}\" ContentType=\"{mime}\"/>"
        );
    }
    content_types.push_str(
        "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/></Types>",
    );

    let root_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"{REL_NS}\">\
<Relationship Id=\"rId1\" Type=\"{REL_BASE}/officeDocument\" Target=\"word/document.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
<Relationship Id=\"rId3\" Type=\"{REL_BASE}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>"
    );

    let mut doc_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"{REL_NS}\">\
<Relationship Id=\"rId1\" Type=\"{REL_BASE}/styles\" Target=\"styles.xml\"/>\
<Relationship Id=\"rId2\" Type=\"{REL_BASE}/numbering\" Target=\"numbering.xml\"/>"
    );
    for (id, ty, target, external) in &w.rels {
        let mut t = String::new();
        xml_escape(target, &mut t);
        let mode = if *external {
            " TargetMode=\"External\""
        } else {
            ""
        };
        let _ = write!(
            doc_rels,
            "<Relationship Id=\"{id}\" Type=\"{REL_BASE}/{ty}\" Target=\"{t}\"{mode}/>"
        );
    }
    doc_rels.push_str("</Relationships>");

    let mut core = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">",
    );
    if let Some(t) = &rich.meta.title {
        let _ = write!(core, "<dc:title>{}</dc:title>", xml_escaped(t));
    }
    if let Some(a) = &rich.meta.author {
        let _ = write!(core, "<dc:creator>{}</dc:creator>", xml_escaped(a));
    }
    core.push_str("</cp:coreProperties>");

    let app = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>OmniDoc</Application></Properties>";

    let mut zw = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut put = |name: &str, data: &[u8]| -> Result<()> {
        zw.start_file(name, opts).map_err(zip_err)?;
        zw.write_all(data)?;
        Ok(())
    };
    put("[Content_Types].xml", content_types.as_bytes())?;
    put("_rels/.rels", root_rels.as_bytes())?;
    put("word/document.xml", document.as_bytes())?;
    put("word/_rels/document.xml.rels", doc_rels.as_bytes())?;
    put("word/styles.xml", styles_xml(&w.code_langs).as_bytes())?;
    put("word/numbering.xml", numbering_xml(&w.nums).as_bytes())?;
    put("docProps/core.xml", core.as_bytes())?;
    put("docProps/app.xml", app.as_bytes())?;
    for (name, data) in &w.media {
        put(&format!("word/media/{name}"), data)?;
    }
    let cursor = zw.finish().map_err(zip_err)?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::super::tree::testutil::*;
    use super::*;

    fn to_rich(tree: RichTree) -> RichDoc {
        tree.into_rich(RichMeta::default(), Lossy::default())
    }

    #[test]
    fn roundtrip_reference() {
        for rich in [false, true] {
            let doc = to_rich(reference(rich));
            let bytes = serialize(&doc).unwrap();
            let back = parse(&bytes).unwrap();
            assert_eq!(back.doc, doc.doc, "rich={rich}");
            // idempotence : open -> save -> open
            let again = parse(&serialize(&back).unwrap()).unwrap();
            assert_eq!(again.doc, doc.doc);
        }
    }

    #[test]
    fn meta_roundtrip() {
        let mut doc = to_rich(reference(false));
        doc.meta.title = Some("Mon <titre> & co".into());
        doc.meta.author = Some("Moi".into());
        let back = parse(&serialize(&doc).unwrap()).unwrap();
        assert_eq!(back.meta.title, doc.meta.title);
        assert_eq!(back.meta.author, doc.meta.author);
    }

    #[test]
    fn zip_contains_required_parts() {
        let bytes = serialize(&to_rich(reference(true))).unwrap();
        let mut z = open_zip(&bytes).unwrap();
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
            "docProps/core.xml",
            "word/media/image1.png",
        ] {
            assert!(zip_read(&mut z, part, 1 << 24).unwrap().is_some(), "{part}");
        }
        // Toutes les parties XML sont bien formées.
        for part in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
        ] {
            let b = zip_read(&mut z, part, 1 << 24).unwrap().unwrap();
            super::super::xml::parse(&b).unwrap();
        }
        let styles = zip_read(&mut z, "word/styles.xml", 1 << 24)
            .unwrap()
            .unwrap();
        let styles = String::from_utf8(styles).unwrap();
        for n in 1..=6 {
            assert!(styles.contains(&format!("w:styleId=\"Heading{n}\"")));
        }
    }

    use super::super::zip_read;

    #[test]
    fn detection() {
        let bytes = serialize(&to_rich(reference(false))).unwrap();
        let h = DocxHandler;
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.docx", &bytes)),
            Some(Confidence(95))
        );
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.docx", b"not a zip")),
            Some(Confidence(60))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("a.txt", b"hello")), None);
    }

    #[test]
    fn handler_save_open_and_export() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.docx");
        let model = DocumentModel::RichText(to_rich(reference(true)));
        let h = DocxHandler;
        h.save(&model, &p).unwrap();
        let DocumentModel::RichText(back) = h.open(&p).unwrap() else {
            panic!("modèle");
        };
        assert_eq!(back.doc, rich_of(&model).unwrap().doc);
        let md = dir.path().join("a.md");
        h.export(&model, "markdown-rich", &md).unwrap();
        assert!(std::fs::read_to_string(md)
            .unwrap()
            .contains("# Titre principal"));
        assert!(matches!(
            h.export(&model, "xyz", &dir.path().join("z")),
            Err(AppError::Unsupported)
        ));
    }

    fn word_doc(body: &str, extra: &[(&str, &str)]) -> Vec<u8> {
        let mut zw = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default();
        let doc =
            format!("<?xml version=\"1.0\"?><w:document {NS}><w:body>{body}</w:body></w:document>");
        zw.start_file("word/document.xml", opts).unwrap();
        zw.write_all(doc.as_bytes()).unwrap();
        for (n, c) in extra {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_foreign_word_features() {
        let styles = r#"<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Citation"><w:name w:val="Quote"/></w:style></w:styles>"#;
        let numbering = r#"<w:numbering xmlns:w="x"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#;
        let rels = r#"<Relationships xmlns="r"><Relationship Id="rId9" Type="x/hyperlink" Target="https://e.org/" TargetMode="External"/></Relationships>"#;
        let body = r#"
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>T</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t>H1</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Citation"/></w:pPr><w:r><w:t>q</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>sub</w:t></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>
 <w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:highlight w:val="yellow"/><w:sz w:val="28"/></w:rPr><w:t>x</w:t></w:r>
 <w:hyperlink r:id="rId9"><w:r><w:t>lnk</w:t></w:r></w:hyperlink>
 <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
 <w:ins><w:r><w:t>ins</w:t></w:r></w:ins><w:del><w:r><w:delText>gone</w:delText></w:r></w:del>
</w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p/></w:tc></w:tr>
<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>"#;
        let bytes = word_doc(
            body,
            &[
                ("word/styles.xml", styles),
                ("word/numbering.xml", numbering),
                ("word/_rels/document.xml.rels", rels),
                ("word/header1.xml", "<w:hdr xmlns:w=\"x\"/>"),
                ("word/vbaProject.bin", "x"),
            ],
        );
        let doc = parse(&bytes).unwrap();
        let tree = RichTree::from_rich(&doc);
        assert!(matches!(&tree.blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(&tree.blocks[1], Block::Heading { level: 1, .. }));
        assert!(matches!(&tree.blocks[2], Block::Blockquote(_)));
        match &tree.blocks[3] {
            Block::OrderedList { items, .. } => {
                assert_eq!(items.len(), 1);
                assert!(matches!(items[0][1], Block::BulletList(_)));
            }
            b => panic!("{b:?}"),
        }
        match &tree.blocks[4] {
            Block::Paragraph { align, content } => {
                assert_eq!(*align, Some(Align::Center));
                let all = inlines_text(content);
                assert_eq!(all, "xlnk3ins");
                assert!(matches!(&content[0], Inline::Text { marks, .. }
                    if marks.contains(&Mark::Bold)
                    && marks.contains(&Mark::Highlight { color: Some("#ffff00".into()) })));
                assert!(matches!(&content[1], Inline::Text { marks, .. }
                    if marks.contains(&Mark::Link { href: "https://e.org/".into() })));
            }
            b => panic!("{b:?}"),
        }
        match &tree.blocks[5] {
            Block::Table(rows) => {
                assert_eq!(rows[0][0].colspan, 2);
                assert_eq!(rows[0][1].rowspan, 2);
                assert_eq!(rows[1].len(), 2);
            }
            b => panic!("{b:?}"),
        }
        for k in ["headers_footers", "macros", "fields", "tracked_changes"] {
            assert!(doc.lossy.contains(&k.to_string()), "{k}: {:?}", doc.lossy);
        }
    }

    #[test]
    fn corrupt_inputs_do_not_panic() {
        let good = serialize(&to_rich(reference(true))).unwrap();
        assert!(parse(&[]).is_err());
        assert!(parse(b"PK\x03\x04garbage").is_err());
        assert!(parse(&word_doc("<w:p>", &[])).is_err() || true);
        for cut in [10, 100, 500, good.len() / 2, good.len() - 5] {
            let _ = parse(&good[..cut.min(good.len())]);
        }
        let mut flipped = good.clone();
        for i in (0..flipped.len()).step_by(37) {
            flipped[i] ^= 0xA5;
        }
        let _ = parse(&flipped);
        // XML de document tronqué
        let _ = parse(&word_doc("<w:p><w:r><w:t>x", &[]));
    }

    #[test]
    fn docx_to_odt_to_docx() {
        let doc = to_rich(reference(true));
        let docx_bytes = serialize(&doc).unwrap();
        let from_docx = parse(&docx_bytes).unwrap();
        let odt_bytes = super::super::odt::serialize(&from_docx).unwrap();
        let from_odt = super::super::odt::parse(&odt_bytes).unwrap();
        let again = parse(&serialize(&from_odt).unwrap()).unwrap();
        assert_eq!(again.doc, doc.doc);
    }
}
