//! ODT (OpenDocument Text). Lecture et écriture maison (zip + quick-xml).

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::docx::{marks_from, RunProps};
use super::tree::{Align, Block, Cell, Image, Inline, Lossy, Mark, RichTree, TaskItem};
use super::util::{
    ext_from_mime, format_pt, image_size, make_data_uri, parse_data_uri, parse_font_size_pt,
    sniff_image_mime, to_hex6, xml_escape, xml_escaped,
};
use super::xml::{Child, Element};
use super::{
    open_zip, read_limited, resolve_path, rich_of, zip_read, zip_read_media, zip_read_xml, Zip,
};
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::{MAX_CELLS, MAX_DEPTH};
use crate::core::model::{DocumentModel, ModelKind, RichDoc, RichMeta};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

const MIME: &str = "application/vnd.oasis.opendocument.text";

pub struct OdtHandler;

impl FormatHandler for OdtHandler {
    fn id(&self) -> &'static str {
        "odt"
    }

    fn model(&self) -> ModelKind {
        ModelKind::RichText
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["odt"]
    }

    fn label_key(&self) -> &'static str {
        "formats.odt"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let pk = probe.head.starts_with(b"PK\x03\x04");
        let mime = MIME.as_bytes();
        let has_mime = probe.head.windows(mime.len()).any(|w| w == mime)
            && probe.head.windows(8).any(|w| w == b"mimetype");
        match (probe.ext == "odt", pk, has_mime) {
            (true, true, true) => Some(Confidence(95)),
            (false, true, true) => Some(Confidence(90)),
            (true, true, false) => Some(Confidence(60)),
            (true, false, _) => Some(Confidence(60)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: ["docx", "markdown-rich", "html", "pdf"]
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

#[derive(Default, Clone)]
struct OdStyle {
    display: String,
    parent: Option<String>,
    rpr: RunProps,
    align: Option<String>,
    border_bottom: bool,
}

#[derive(PartialEq)]
enum PKind {
    Normal,
    Quote,
    Code(Option<String>),
    Rule,
    Title,
}

fn decode_name(n: &str) -> String {
    n.replace("_20_", " ")
}

fn length_px(s: &str) -> Option<f64> {
    let s = s.trim();
    let idx = s.find(|c: char| c.is_alphabetic() || c == '%')?;
    let (num, unit) = s.split_at(idx);
    let v: f64 = num.parse().ok()?;
    let px = match unit {
        "cm" => v * 96.0 / 2.54,
        "mm" => v * 96.0 / 25.4,
        "in" => v * 96.0,
        "pt" => v * 96.0 / 72.0,
        "pc" => v * 16.0,
        "px" => v,
        _ => return None,
    };
    (px.is_finite() && px > 0.0).then_some(px)
}

fn parse_style(s: &Element) -> OdStyle {
    let mut st = OdStyle {
        display: s
            .attr("style:display-name")
            .map(String::from)
            .unwrap_or_else(|| decode_name(s.attr("style:name").unwrap_or(""))),
        parent: s.attr("style:parent-style-name").map(String::from),
        ..Default::default()
    };
    if let Some(tp) = s.find("style:text-properties") {
        let rp = &mut st.rpr;
        match tp.attr("fo:font-weight") {
            Some("bold") => rp.bold = Some(true),
            Some("normal") => rp.bold = Some(false),
            Some(n) => rp.bold = n.parse::<u32>().ok().map(|w| w >= 600),
            None => {}
        }
        match tp.attr("fo:font-style") {
            Some("italic" | "oblique") => rp.italic = Some(true),
            Some("normal") => rp.italic = Some(false),
            _ => {}
        }
        if let Some(u) = tp.attr("style:text-underline-style") {
            rp.underline = Some(u != "none");
        }
        if let Some(u) = tp.attr("style:text-line-through-style") {
            rp.strike = Some(u != "none");
        }
        rp.color = tp.attr("fo:color").and_then(to_hex6);
        rp.highlight = tp.attr("fo:background-color").and_then(to_hex6);
        if let Some(pos) = tp.attr("style:text-position") {
            let first = pos.split_whitespace().next().unwrap_or("");
            if first.starts_with("sub") || first.starts_with('-') {
                rp.vert = Some("subscript".into());
            } else if first.starts_with("super")
                || first
                    .trim_end_matches('%')
                    .parse::<f32>()
                    .is_ok_and(|v| v > 0.0)
            {
                rp.vert = Some("superscript".into());
            }
        }
        rp.font = tp
            .attr("fo:font-family")
            .or_else(|| tp.attr("style:font-name"))
            .map(|f| f.trim_matches(|c| c == '\'' || c == '"').to_string());
        if tp.attr("style:font-family-generic") == Some("modern") {
            rp.font = Some("monospace".into());
        }
        rp.size_half = tp
            .attr("fo:font-size")
            .filter(|v| !v.ends_with('%'))
            .and_then(parse_font_size_pt)
            .map(|pt| (pt * 2.0).round() as u32);
    }
    if let Some(pp) = s.find("style:paragraph-properties") {
        st.align = pp.attr("fo:text-align").map(String::from);
        st.border_bottom = pp
            .attr("fo:border-bottom")
            .or_else(|| pp.attr("fo:border"))
            .is_some_and(|b| b != "none" && !b.is_empty());
    }
    st
}

enum Item {
    Block(Block),
    Code { lang: Option<String>, text: String },
    Quote(Block),
}

struct Reader<'a, 'b> {
    archive: &'a mut Zip<'b>,
    styles: HashMap<String, OdStyle>,
    lists: HashMap<String, HashMap<u32, (bool, u32)>>,
    lossy: Lossy,
    cells: usize,
    media_bytes: u64,
}

impl Reader<'_, '_> {
    fn load_styles(&mut self, root: &Element) {
        for group in root
            .elems()
            .filter(|e| matches!(e.name.as_str(), "office:styles" | "office:automatic-styles"))
        {
            for s in group.elems() {
                match s.name.as_str() {
                    "style:style" => {
                        if let Some(n) = s.attr("style:name") {
                            self.styles.insert(n.to_string(), parse_style(s));
                        }
                    }
                    "text:list-style" => {
                        let Some(n) = s.attr("style:name") else {
                            continue;
                        };
                        let mut levels = HashMap::new();
                        for l in s.elems() {
                            let level: u32 = l
                                .attr("text:level")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(1);
                            let ordered = l.name == "text:list-level-style-number"
                                && l.attr("style:num-format").is_some_and(|f| !f.is_empty());
                            let start = l
                                .attr("text:start-value")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(1);
                            levels.insert(level, (ordered, start));
                        }
                        self.lists.insert(n.to_string(), levels);
                    }
                    _ => {}
                }
            }
        }
        if let Some(ms) = root.find("office:master-styles") {
            for m in ms.elems() {
                for h in m.elems() {
                    if matches!(
                        h.name.as_str(),
                        "style:header" | "style:footer" | "style:header-left" | "style:footer-left"
                    ) && !h.deep_text().trim().is_empty()
                    {
                        self.lossy.add("headers_footers");
                    }
                }
            }
        }
    }

    fn chain(&self, name: &str) -> Vec<&OdStyle> {
        let mut out = Vec::new();
        let mut cur = Some(name);
        while let Some(c) = cur {
            if out.len() >= 8 {
                break;
            }
            match self.styles.get(c) {
                Some(s) => {
                    out.push(s);
                    cur = s.parent.as_deref();
                }
                None => break,
            }
        }
        out
    }

    fn rpr(&self, name: &str) -> RunProps {
        let mut acc = RunProps::default();
        for s in self.chain(name).into_iter().rev() {
            acc = acc.overlay(&s.rpr);
        }
        acc
    }

    fn kind(&self, name: &str) -> PKind {
        for s in self.chain(name) {
            let d = s.display.to_lowercase();
            if let Some(lang) = d.strip_prefix("code block:") {
                let orig = s
                    .display
                    .get(s.display.len() - lang.len()..)
                    .unwrap_or("")
                    .trim();
                return PKind::Code((!orig.is_empty()).then(|| orig.to_string()));
            }
            match d.as_str() {
                "code block" | "preformatted text" | "source code" => return PKind::Code(None),
                "quotations" | "quote" | "block quotation" => return PKind::Quote,
                "horizontal line" => return PKind::Rule,
                "title" => return PKind::Title,
                _ => {}
            }
        }
        PKind::Normal
    }

    fn align(&self, name: &str) -> Option<Align> {
        self.chain(name)
            .iter()
            .find_map(|s| s.align.clone())
            .and_then(|a| Align::from_css(&a))
    }

    fn border_bottom(&self, name: &str) -> bool {
        self.chain(name).iter().any(|s| s.border_bottom)
    }

    fn push_text(&self, out: &mut Vec<Inline>, marks: &[Mark], s: &str) {
        if s.is_empty() {
            return;
        }
        out.push(Inline::Text {
            text: s.to_string(),
            marks: marks.to_vec(),
        });
    }

    fn image(&mut self, frame: &Element, out: &mut Vec<Inline>) {
        let Some(img) = frame.find("draw:image") else {
            self.lossy.add("shapes");
            return;
        };
        let Some(href) = img.attr("xlink:href") else {
            // image embarquée en base64 (draw:binary-data) : non gérée
            self.lossy.add("shapes");
            return;
        };
        if href.contains("://") {
            self.lossy.add("linked_images");
            return;
        }
        let path = resolve_path("", href);
        let Ok(Some(bytes)) = zip_read_media(self.archive, &path) else {
            return;
        };
        self.media_bytes += bytes.len() as u64;
        if self.media_bytes > 512 * 1024 * 1024 {
            self.lossy.add("images_limit");
            return;
        }
        let mime = sniff_image_mime(&bytes, &path);
        let natural = image_size(&bytes).map(|(w, _)| w);
        let width = frame
            .attr("svg:width")
            .and_then(length_px)
            .map(|p| p.round() as u32)
            .filter(|w| *w > 0 && natural.is_none_or(|n| n.abs_diff(*w) > 1));
        let text_of = |n: &str| {
            frame
                .find(n)
                .map(|e| e.deep_text().trim().to_string())
                .filter(|s| !s.is_empty())
        };
        out.push(Inline::Image(Image {
            src: make_data_uri(&mime, &bytes),
            alt: text_of("svg:desc"),
            title: text_of("svg:title"),
            width,
        }));
    }

    fn inline(
        &mut self,
        node: &Element,
        marks: &[Mark],
        prev_space: &mut bool,
        out: &mut Vec<Inline>,
        depth: usize,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        for c in &node.children {
            match c {
                Child::Text(t) => {
                    let mut s = String::new();
                    for ch in t.chars() {
                        if matches!(ch, ' ' | '\t' | '\n' | '\r') {
                            if !*prev_space {
                                s.push(' ');
                                *prev_space = true;
                            }
                        } else {
                            s.push(ch);
                            *prev_space = false;
                        }
                    }
                    self.push_text(out, marks, &s);
                }
                Child::Elem(e) => match e.name.as_str() {
                    "text:span" => {
                        let mut rp = RunProps::default();
                        if let Some(sn) = e.attr("text:style-name") {
                            rp = self.rpr(sn);
                        }
                        let link = marks.iter().find_map(|m| match m {
                            Mark::Link { href } => Some(href.as_str()),
                            _ => None,
                        });
                        let mut ms: Vec<Mark> = marks
                            .iter()
                            .filter(|m| matches!(m, Mark::Link { .. }))
                            .cloned()
                            .collect();
                        let own = marks_from(&rp, link.filter(|_| false));
                        // marques héritées (hors lien) + marques propres au span
                        ms.extend(
                            marks
                                .iter()
                                .filter(|m| !matches!(m, Mark::Link { .. }))
                                .cloned(),
                        );
                        ms.extend(own);
                        self.inline(e, &ms, prev_space, out, depth + 1);
                    }
                    "text:a" => {
                        let mut ms = marks.to_vec();
                        if let Some(h) = e.attr("xlink:href") {
                            ms.insert(
                                0,
                                Mark::Link {
                                    href: h.to_string(),
                                },
                            );
                        }
                        self.inline(e, &ms, prev_space, out, depth + 1);
                    }
                    "text:s" => {
                        let n: usize = e
                            .attr("text:c")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1)
                            .min(10_000);
                        self.push_text(out, marks, &" ".repeat(n));
                        *prev_space = false;
                    }
                    "text:tab" => {
                        self.push_text(out, marks, "\t");
                        *prev_space = false;
                    }
                    "text:line-break" => {
                        out.push(Inline::HardBreak);
                        *prev_space = true;
                    }
                    "draw:frame" => self.image(e, out),
                    "text:note" => self.lossy.add("footnotes"),
                    "office:annotation" | "office:annotation-end" => self.lossy.add("comments"),
                    "text:changed-region"
                    | "text:change"
                    | "text:change-start"
                    | "text:change-end" => self.lossy.add("tracked_changes"),
                    "draw:custom-shape" | "draw:rect" | "draw:ellipse" | "draw:line" | "draw:g" => {
                        self.lossy.add("shapes")
                    }
                    "draw:object" | "draw:object-ole" => self.lossy.add("embedded_objects"),
                    "text:soft-page-break"
                    | "text:bookmark"
                    | "text:bookmark-start"
                    | "text:bookmark-end"
                    | "text:reference-mark"
                    | "text:reference-mark-start"
                    | "text:reference-mark-end" => {}
                    name => {
                        if matches!(
                            name,
                            "text:page-number"
                                | "text:page-count"
                                | "text:date"
                                | "text:time"
                                | "text:title"
                                | "text:author-name"
                                | "text:file-name"
                                | "text:sequence"
                                | "text:variable-set"
                                | "text:user-field-get"
                        ) {
                            self.lossy.add("fields");
                        }
                        self.inline(e, marks, prev_space, out, depth + 1);
                    }
                },
            }
        }
    }

    fn inlines_of(&mut self, p: &Element, depth: usize) -> Vec<Inline> {
        let mut out = Vec::new();
        let mut prev_space = true;
        self.inline(p, &[], &mut prev_space, &mut out, depth);
        out
    }

    fn paragraph(&mut self, p: &Element, depth: usize) -> Item {
        let content = self.inlines_of(p, depth);
        let style = p.attr("text:style-name").unwrap_or("");
        let align = self.align(style);
        let kind = self.kind(style);
        match kind {
            PKind::Code(lang) => Item::Code {
                lang,
                text: super::tree::inlines_text(&content),
            },
            PKind::Rule => Item::Block(Block::HorizontalRule),
            PKind::Quote => Item::Quote(Block::Paragraph { align, content }),
            PKind::Title => Item::Block(Block::Heading {
                level: 1,
                align,
                content,
            }),
            PKind::Normal => {
                let empty = content.is_empty();
                if empty && self.border_bottom(style) {
                    Item::Block(Block::HorizontalRule)
                } else {
                    Item::Block(Block::Paragraph { align, content })
                }
            }
        }
    }

    fn heading(&mut self, h: &Element, depth: usize) -> Block {
        let level = h
            .attr("text:outline-level")
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(1)
            .clamp(1, 6);
        let content = self.inlines_of(h, depth);
        let align = self.align(h.attr("text:style-name").unwrap_or(""));
        Block::Heading {
            level,
            align,
            content,
        }
    }

    fn collect(&mut self, container: &Element, depth: usize, items: &mut Vec<Item>) {
        if depth > MAX_DEPTH {
            return;
        }
        for c in container.elems() {
            match c.name.as_str() {
                "text:p" => {
                    let it = self.paragraph(c, depth);
                    items.push(it);
                }
                "text:h" => {
                    let h = self.heading(c, depth);
                    items.push(Item::Block(h));
                }
                "text:list" => {
                    let l = self.list(c, 1, None, depth + 1);
                    items.push(Item::Block(l));
                }
                "table:table" => {
                    let t = self.table(c, depth + 1);
                    items.push(Item::Block(t));
                }
                "text:section" | "text:index-body" | "text:index-title" => {
                    self.collect(c, depth + 1, items)
                }
                "text:table-of-content" | "text:illustration-index" | "text:alphabetical-index" => {
                    self.lossy.add("fields");
                    if let Some(body) = c.find("text:index-body") {
                        self.collect(body, depth + 1, items);
                    }
                }
                "text:tracked-changes" => self.lossy.add("tracked_changes"),
                "draw:frame" => {
                    let mut out = Vec::new();
                    self.image(c, &mut out);
                    if !out.is_empty() {
                        items.push(Item::Block(Block::para(out)));
                    }
                }
                _ => {}
            }
        }
    }

    fn blocks(&mut self, container: &Element, depth: usize) -> Vec<Block> {
        let mut items = Vec::new();
        self.collect(container, depth, &mut items);
        group(items)
    }

    fn list(&mut self, l: &Element, level: u32, inherited: Option<&str>, depth: usize) -> Block {
        let style = l.attr("text:style-name").or(inherited);
        let (ordered, start) = style
            .and_then(|s| self.lists.get(s))
            .and_then(|lv| lv.get(&level))
            .copied()
            .unwrap_or((false, 1));
        let mut items: Vec<Vec<Block>> = Vec::new();
        let mut first_start: Option<u32> = None;
        for it in l
            .elems()
            .filter(|e| matches!(e.name.as_str(), "text:list-item" | "text:list-header"))
        {
            if first_start.is_none() {
                first_start = it.attr("text:start-value").and_then(|v| v.parse().ok());
            }
            let mut content: Vec<Block> = Vec::new();
            if depth <= MAX_DEPTH {
                let mut pending: Vec<Item> = Vec::new();
                for c in it.elems() {
                    if c.name == "text:list" {
                        content.extend(group(std::mem::take(&mut pending)));
                        content.push(self.list(c, level + 1, style, depth + 1));
                    } else {
                        let mut tmp = Element {
                            name: "x".into(),
                            ..Default::default()
                        };
                        tmp.children.push(Child::Elem(c.clone()));
                        self.collect(&tmp, depth + 1, &mut pending);
                    }
                }
                content.extend(group(pending));
            }
            items.push(content);
        }
        if ordered {
            Block::OrderedList {
                start: first_start.unwrap_or(start),
                items,
            }
        } else {
            Block::BulletList(items)
        }
    }

    fn table(&mut self, t: &Element, depth: usize) -> Block {
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        self.table_rows(t, false, depth, &mut rows);
        Block::Table(rows)
    }

    fn table_rows(
        &mut self,
        parent: &Element,
        header: bool,
        depth: usize,
        rows: &mut Vec<Vec<Cell>>,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        for c in parent.elems() {
            match c.name.as_str() {
                "table:table-header-rows" => self.table_rows(c, true, depth + 1, rows),
                "table:table-row-group" | "table:table-rows" => {
                    self.table_rows(c, header, depth + 1, rows)
                }
                "table:table-row" => {
                    let repeat = c
                        .attr("table:number-rows-repeated")
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(1)
                        .clamp(1, 64);
                    let mut row: Vec<Cell> = Vec::new();
                    for tc in c.elems().filter(|e| e.name == "table:table-cell") {
                        self.cells += 1;
                        if self.cells > MAX_CELLS {
                            self.lossy.add("cells_limit");
                            break;
                        }
                        let num = |a: &str| {
                            tc.attr(a)
                                .and_then(|v| v.parse::<u32>().ok())
                                .unwrap_or(1)
                                .clamp(1, 1000)
                        };
                        let content = self.blocks(tc, depth + 1);
                        let cell = Cell {
                            header,
                            colspan: num("table:number-columns-spanned"),
                            rowspan: num("table:number-rows-spanned"),
                            content,
                        };
                        let rep = tc
                            .attr("table:number-columns-repeated")
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(1)
                            .clamp(1, 64);
                        for _ in 0..rep {
                            row.push(cell.clone());
                        }
                    }
                    for _ in 0..repeat {
                        rows.push(row.clone());
                    }
                }
                _ => {}
            }
        }
    }
}

fn group(items: Vec<Item>) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    // 0 = autre, 1 = code, 2 = citation
    let mut prev = 0u8;
    for item in items {
        match item {
            Item::Block(b) => {
                out.push(b);
                prev = 0;
            }
            Item::Code { lang, text } => {
                if let (1, Some(Block::CodeBlock { text: t, .. })) = (prev, out.last_mut()) {
                    t.push('\n');
                    t.push_str(&text);
                } else {
                    out.push(Block::CodeBlock {
                        language: lang,
                        text,
                    });
                }
                prev = 1;
            }
            Item::Quote(b) => {
                if let (2, Some(Block::Blockquote(c))) = (prev, out.last_mut()) {
                    c.push(b);
                } else {
                    out.push(Block::Blockquote(vec![b]));
                }
                prev = 2;
            }
        }
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
    if let Some(m) = zip_read(&mut archive, "mimetype", 1024)? {
        let m = String::from_utf8_lossy(&m);
        if !m
            .trim()
            .starts_with("application/vnd.oasis.opendocument.text")
        {
            return Err(AppError::Corrupt(
                "ce n'est pas un document texte ODF".into(),
            ));
        }
    }
    let content = zip_read_xml(&mut archive, "content.xml")?
        .ok_or_else(|| AppError::Corrupt("content.xml absent".into()))?;
    if content.name != "office:document-content" {
        return Err(AppError::Corrupt("content.xml invalide".into()));
    }
    let styles_root = zip_read_xml(&mut archive, "styles.xml")?;
    let mut meta = RichMeta::default();
    if let Some(m) = zip_read_xml(&mut archive, "meta.xml")? {
        if let Some(om) = m.find("office:meta") {
            let get = |n: &str| {
                om.find(n)
                    .map(|e| e.deep_text().trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            meta.title = get("dc:title");
            meta.author = get("dc:creator").or_else(|| get("meta:initial-creator"));
        }
    }

    let mut lossy = Lossy::default();
    for n in &names {
        let l = n.to_lowercase();
        if l.starts_with("basic/") || l.starts_with("scripts/") {
            lossy.add("macros");
        } else if l.starts_with("object ") || l.starts_with("objects/") {
            lossy.add("embedded_objects");
        }
    }
    let mut reader = Reader {
        archive: &mut archive,
        styles: HashMap::new(),
        lists: HashMap::new(),
        lossy,
        cells: 0,
        media_bytes: 0,
    };
    if let Some(s) = &styles_root {
        reader.load_styles(s);
    }
    reader.load_styles(&content);
    let text = content
        .find("office:body")
        .and_then(|b| b.find("office:text"))
        .ok_or_else(|| AppError::Corrupt("office:text absent".into()))?;
    let blocks = reader.blocks(text, 0);
    let mut tree = RichTree { blocks };
    tree.raise_tasks();
    Ok(tree.into_rich(meta, reader.lossy))
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const MAX_DISPLAY_PX: u32 = 624;

struct Writer {
    body: String,
    text_styles: Vec<(Vec<Mark>, String)>,
    para_styles: Vec<(String, Align)>,
    list_styles: Vec<(bool, u32)>,
    images: Vec<(String, Vec<u8>)>,
    code_langs: Vec<String>,
    tables: u32,
}

fn cm(px: u32) -> String {
    format!("{:.4}cm", f64::from(px) * 2.54 / 96.0)
}

impl Writer {
    fn text_style(&mut self, marks: &[Mark]) -> Option<String> {
        let key: Vec<Mark> = marks
            .iter()
            .filter(|m| !matches!(m, Mark::Link { .. }))
            .cloned()
            .collect();
        if key.is_empty() {
            return None;
        }
        if let Some((_, n)) = self.text_styles.iter().find(|(k, _)| *k == key) {
            return Some(n.clone());
        }
        let name = format!("T{}", self.text_styles.len() + 1);
        self.text_styles.push((key, name.clone()));
        Some(name)
    }

    fn text(&mut self, s: &str) -> String {
        let mut out = String::new();
        let mut prev_nonspace = false;
        let mut pending_spaces = 0usize;
        let flush = |out: &mut String, n: &mut usize| {
            if *n == 1 {
                out.push_str("<text:s/>");
            } else if *n > 1 {
                let _ = write!(out, "<text:s text:c=\"{n}\"/>");
            }
            *n = 0;
        };
        for c in s.chars() {
            match c {
                ' ' => {
                    if prev_nonspace && pending_spaces == 0 {
                        out.push(' ');
                        prev_nonspace = false;
                        // le premier espace d'une série est littéral
                        pending_spaces = 0;
                        // marque : l'espace littéral compte comme « espace précédent »
                        continue;
                    }
                    pending_spaces += 1;
                }
                '\t' => {
                    flush(&mut out, &mut pending_spaces);
                    out.push_str("<text:tab/>");
                    prev_nonspace = false;
                }
                '\n' => {
                    flush(&mut out, &mut pending_spaces);
                    out.push_str("<text:line-break/>");
                    prev_nonspace = false;
                }
                '\r' => {}
                c => {
                    flush(&mut out, &mut pending_spaces);
                    xml_escape(c.encode_utf8(&mut [0; 4]), &mut out);
                    prev_nonspace = true;
                }
            }
        }
        flush(&mut out, &mut pending_spaces);
        out
    }

    fn image(&mut self, img: &Image) {
        let parsed = parse_data_uri(&img.src).filter(|(m, _)| m.starts_with("image/"));
        let Some((mime, bytes)) = parsed else {
            let label = img.alt.clone().unwrap_or_else(|| img.src.clone());
            let t = self.text(&label);
            self.body.push_str(&t);
            return;
        };
        let ext = ext_from_mime(&mime);
        if ext == "bin" {
            return;
        }
        let name = format!("image{}.{ext}", self.images.len() + 1);
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
        let mut extra = String::new();
        if let Some(t) = &img.title {
            let _ = write!(extra, "<svg:title>{}</svg:title>", xml_escaped(t));
        }
        if let Some(a) = &img.alt {
            let _ = write!(extra, "<svg:desc>{}</svg:desc>", xml_escaped(a));
        }
        let n = self.images.len() + 1;
        let _ = write!(
            self.body,
            "<draw:frame draw:style-name=\"fr1\" draw:name=\"Image{n}\" text:anchor-type=\"as-char\" svg:width=\"{}\" svg:height=\"{}\" draw:z-index=\"0\">\
<draw:image xlink:href=\"Pictures/{name}\" xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\"/>{extra}</draw:frame>",
            cm(w),
            cm(h)
        );
        self.images.push((name, bytes));
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
            if let Some(h) = &link {
                let _ = write!(
                    self.body,
                    "<text:a xlink:type=\"simple\" xlink:href=\"{}\">",
                    xml_escaped(h)
                );
            }
            for item in &content[i..j] {
                match item {
                    Inline::Text { text, marks } => {
                        let t = self.text(text);
                        match self.text_style(marks) {
                            Some(s) => {
                                let _ = write!(
                                    self.body,
                                    "<text:span text:style-name=\"{s}\">{t}</text:span>"
                                );
                            }
                            None => self.body.push_str(&t),
                        }
                    }
                    Inline::HardBreak => self.body.push_str("<text:line-break/>"),
                    Inline::Image(img) => self.image(img),
                }
            }
            if link.is_some() {
                self.body.push_str("</text:a>");
            }
            i = j;
        }
    }

    fn para_style(&mut self, base: &str, align: Option<Align>) -> String {
        match align {
            None => base.to_string(),
            Some(a) => {
                let key = (base.to_string(), a);
                let idx = match self.para_styles.iter().position(|k| *k == key) {
                    Some(i) => i,
                    None => {
                        self.para_styles.push(key);
                        self.para_styles.len() - 1
                    }
                };
                format!("P{}", idx + 1)
            }
        }
    }

    fn paragraph(&mut self, base: &str, align: Option<Align>, content: &[Inline]) {
        let style = self.para_style(base, align);
        let _ = write!(self.body, "<text:p text:style-name=\"{style}\">");
        self.inlines(content);
        self.body.push_str("</text:p>");
    }

    fn blocks(&mut self, blocks: &[Block], quote: bool) {
        for b in blocks {
            self.block(b, quote);
        }
    }

    fn block(&mut self, b: &Block, quote: bool) {
        match b {
            Block::Paragraph { align, content } => {
                let base = if quote { "Quotations" } else { "Standard" };
                self.paragraph(base, *align, content);
            }
            Block::Heading {
                level,
                align,
                content,
            } => {
                let level = (*level).clamp(1, 6);
                let style = self.para_style(&format!("Heading_20_{level}"), *align);
                let _ = write!(
                    self.body,
                    "<text:h text:style-name=\"{style}\" text:outline-level=\"{level}\">"
                );
                self.inlines(content);
                self.body.push_str("</text:h>");
            }
            Block::BulletList(items) => self.list(None, items),
            Block::OrderedList { start, items } => self.list(Some(*start), items),
            Block::TaskList(items) => {
                let lowered: Vec<Vec<Block>> = items
                    .iter()
                    .map(|TaskItem { content, .. }| content.clone())
                    .collect();
                self.list(None, &lowered);
            }
            Block::Blockquote(c) => self.blocks(c, true),
            Block::CodeBlock { language, text } => {
                let style = match language {
                    None => "Code_20_Block".to_string(),
                    Some(l) => {
                        let i = match self.code_langs.iter().position(|x| x == l) {
                            Some(i) => i,
                            None => {
                                self.code_langs.push(l.clone());
                                self.code_langs.len() - 1
                            }
                        };
                        format!("CodeBlock_{}", i + 1)
                    }
                };
                let t = self.text(text);
                let _ = write!(
                    self.body,
                    "<text:p text:style-name=\"{style}\">{t}</text:p>"
                );
            }
            Block::HorizontalRule => self
                .body
                .push_str("<text:p text:style-name=\"Horizontal_20_Line\"/>"),
            Block::Table(rows) => self.table(rows),
        }
    }

    fn list(&mut self, ordered_start: Option<u32>, items: &[Vec<Block>]) {
        let spec = (ordered_start.is_some(), ordered_start.unwrap_or(1));
        self.list_styles.push(spec);
        let _ = write!(
            self.body,
            "<text:list text:style-name=\"L{}\">",
            self.list_styles.len()
        );
        for item in items {
            self.body.push_str("<text:list-item>");
            for b in item {
                match b {
                    Block::BulletList(sub) => self.list(None, sub),
                    Block::OrderedList { start, items } => self.list(Some(*start), items),
                    other => self.block(other, false),
                }
            }
            self.body.push_str("</text:list-item>");
        }
        self.body.push_str("</text:list>");
    }

    fn table(&mut self, rows: &[Vec<Cell>]) {
        self.tables += 1;
        let mut xml = String::new();
        let mut ncols = 0usize;
        let mut occ: Vec<(u32, u32)> = Vec::new();
        let lead = rows
            .iter()
            .take_while(|r| !r.is_empty() && r.iter().all(|c| c.header))
            .count();
        for (ri, row) in rows.iter().enumerate() {
            if ri == 0 && lead > 0 {
                xml.push_str("<table:table-header-rows>");
            }
            xml.push_str("<table:table-row>");
            let mut col = 0usize;
            let mut cells = row.iter();
            loop {
                if let Some(&(rem, span)) = occ.get(col) {
                    if rem > 0 {
                        for _ in 0..span {
                            xml.push_str("<table:covered-table-cell/>");
                        }
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
                xml.push_str(
                    "<table:table-cell table:style-name=\"Cell\" office:value-type=\"string\"",
                );
                if span > 1 {
                    let _ = write!(xml, " table:number-columns-spanned=\"{span}\"");
                }
                if cell.rowspan > 1 {
                    let _ = write!(xml, " table:number-rows-spanned=\"{}\"", cell.rowspan);
                }
                xml.push('>');
                let saved = std::mem::take(&mut self.body);
                self.blocks(&cell.content, false);
                if cell.content.is_empty() {
                    self.body.push_str("<text:p text:style-name=\"Standard\"/>");
                }
                xml.push_str(&std::mem::replace(&mut self.body, saved));
                xml.push_str("</table:table-cell>");
                for _ in 1..span {
                    xml.push_str("<table:covered-table-cell/>");
                }
                col += span as usize;
            }
            ncols = ncols.max(col);
            xml.push_str("</table:table-row>");
            if ri + 1 == lead {
                xml.push_str("</table:table-header-rows>");
            }
        }
        let ncols = ncols.max(1);
        let _ = write!(
            self.body,
            "<table:table table:name=\"Table{}\" table:style-name=\"Tbl\"><table:table-column table:number-columns-repeated=\"{ncols}\"/>{xml}</table:table>",
            self.tables
        );
    }
}

fn text_style_xml(marks: &[Mark], name: &str) -> String {
    let mut a = String::new();
    let mut code = false;
    let mut font: Option<&String> = None;
    for m in marks {
        match m {
            Mark::Bold => a.push_str(" fo:font-weight=\"bold\""),
            Mark::Italic => a.push_str(" fo:font-style=\"italic\""),
            Mark::Underline => a.push_str(
                " style:text-underline-style=\"solid\" style:text-underline-width=\"auto\" style:text-underline-color=\"font-color\"",
            ),
            Mark::Strike => a.push_str(" style:text-line-through-style=\"solid\""),
            Mark::Code => code = true,
            Mark::Subscript => a.push_str(" style:text-position=\"sub 58%\""),
            Mark::Superscript => a.push_str(" style:text-position=\"super 58%\""),
            Mark::Highlight { color } => {
                let c = color.as_deref().and_then(to_hex6).unwrap_or_else(|| "#ffff00".into());
                let _ = write!(a, " fo:background-color=\"{c}\"");
            }
            Mark::TextStyle {
                color,
                font_family,
                font_size,
            } => {
                if let Some(c) = color.as_deref().and_then(to_hex6) {
                    let _ = write!(a, " fo:color=\"{c}\"");
                }
                if let Some(pt) = font_size.as_deref().and_then(parse_font_size_pt) {
                    let _ = write!(a, " fo:font-size=\"{}\"", format_pt(pt));
                }
                font = font_family.as_ref();
            }
            Mark::Link { .. } => {}
        }
    }
    if code {
        a.push_str(" style:font-name=\"Liberation Mono\" fo:font-family=\"'Liberation Mono'\" style:font-family-generic=\"modern\" style:font-pitch=\"fixed\"");
    } else if let Some(f) = font {
        let _ = write!(a, " fo:font-family=\"'{}'\"", xml_escaped(f));
    }
    format!(
        "<style:style style:name=\"{name}\" style:family=\"text\"><style:text-properties{a}/></style:style>"
    )
}

const NS: &str = "xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" \
xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" \
xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" \
xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" \
xmlns:draw=\"urn:oasis:names:tc:opendocument:xmlns:drawing:1.0\" \
xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" \
xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
xmlns:meta=\"urn:oasis:names:tc:opendocument:xmlns:meta:1.0\" \
xmlns:svg=\"urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0\"";

fn styles_xml(code_langs: &[String]) -> String {
    let mut s = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-styles {NS} office:version=\"1.3\">\
<office:font-face-decls><style:font-face style:name=\"Liberation Mono\" svg:font-family=\"'Liberation Mono'\" style:font-family-generic=\"modern\" style:font-pitch=\"fixed\"/></office:font-face-decls>\
<office:styles>\
<style:default-style style:family=\"paragraph\"><style:paragraph-properties fo:margin-bottom=\"0.2cm\"/><style:text-properties fo:font-size=\"11pt\"/></style:default-style>\
<style:style style:name=\"Standard\" style:family=\"paragraph\" style:class=\"text\"/>"
    );
    let sizes = [20, 16, 14, 13, 12, 11];
    for (i, sz) in sizes.iter().enumerate() {
        let n = i + 1;
        let _ = write!(
            s,
            "<style:style style:name=\"Heading_20_{n}\" style:display-name=\"Heading {n}\" style:family=\"paragraph\" style:parent-style-name=\"Standard\" style:next-style-name=\"Standard\" style:default-outline-level=\"{n}\" style:class=\"text\">\
<style:paragraph-properties fo:margin-top=\"0.4cm\" fo:margin-bottom=\"0.2cm\" fo:keep-with-next=\"always\"/><style:text-properties fo:font-size=\"{sz}pt\" fo:font-weight=\"bold\"/></style:style>"
        );
    }
    s.push_str(
        "<style:style style:name=\"Quotations\" style:display-name=\"Quotations\" style:family=\"paragraph\" style:parent-style-name=\"Standard\" style:class=\"html\">\
<style:paragraph-properties fo:margin-left=\"1cm\" fo:margin-right=\"0cm\" fo:text-indent=\"0cm\" fo:border-left=\"1.5pt solid #bfbfbf\" fo:padding-left=\"0.3cm\"/></style:style>\
<style:style style:name=\"Code_20_Block\" style:display-name=\"Code Block\" style:family=\"paragraph\" style:parent-style-name=\"Standard\" style:class=\"html\">\
<style:paragraph-properties fo:background-color=\"#f2f2f2\" fo:margin-bottom=\"0.2cm\"/><style:text-properties style:font-name=\"Liberation Mono\" fo:font-family=\"'Liberation Mono'\" style:font-family-generic=\"modern\" fo:font-size=\"10pt\"/></style:style>\
<style:style style:name=\"Horizontal_20_Line\" style:display-name=\"Horizontal Line\" style:family=\"paragraph\" style:parent-style-name=\"Standard\" style:class=\"html\">\
<style:paragraph-properties fo:margin-top=\"0cm\" fo:margin-bottom=\"0.2cm\" fo:border-bottom=\"0.5pt solid #808080\" fo:padding=\"0cm\"/><style:text-properties fo:font-size=\"6pt\"/></style:style>",
    );
    for (i, lang) in code_langs.iter().enumerate() {
        let _ = write!(
            s,
            "<style:style style:name=\"CodeBlock_{}\" style:display-name=\"Code Block: {}\" style:family=\"paragraph\" style:parent-style-name=\"Code_20_Block\"/>",
            i + 1,
            xml_escaped(lang)
        );
    }
    s.push_str(
        "</office:styles><office:automatic-styles>\
<style:page-layout style:name=\"pm1\"><style:page-layout-properties fo:page-width=\"21cm\" fo:page-height=\"29.7cm\" fo:margin-top=\"2cm\" fo:margin-bottom=\"2cm\" fo:margin-left=\"2cm\" fo:margin-right=\"2cm\"/></style:page-layout>\
</office:automatic-styles><office:master-styles><style:master-page style:name=\"Standard\" style:page-layout-name=\"pm1\"/></office:master-styles></office:document-styles>",
    );
    s
}

fn zip_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io(std::io::Error::other(format!("écriture zip : {e}")))
}

pub fn serialize(rich: &RichDoc) -> Result<Vec<u8>> {
    let mut tree = RichTree::from_rich(rich);
    tree.lower_tasks();
    let mut w = Writer {
        body: String::new(),
        text_styles: Vec::new(),
        para_styles: Vec::new(),
        list_styles: Vec::new(),
        images: Vec::new(),
        code_langs: Vec::new(),
        tables: 0,
    };
    w.blocks(&tree.blocks, false);
    if tree.blocks.is_empty() {
        w.body.push_str("<text:p text:style-name=\"Standard\"/>");
    }

    let mut auto = String::new();
    for (marks, name) in &w.text_styles {
        auto.push_str(&text_style_xml(marks, name));
    }
    for (i, (base, align)) in w.para_styles.iter().enumerate() {
        let _ = write!(
            auto,
            "<style:style style:name=\"P{}\" style:family=\"paragraph\" style:parent-style-name=\"{base}\"><style:paragraph-properties fo:text-align=\"{}\"/></style:style>",
            i + 1,
            align.css()
        );
    }
    for (i, (ordered, start)) in w.list_styles.iter().enumerate() {
        let _ = write!(auto, "<text:list-style style:name=\"L{}\">", i + 1);
        for level in 1..=10u32 {
            let indent = f64::from(level) * 0.635;
            let props = format!(
                "<style:list-level-properties text:list-level-position-and-space-mode=\"label-alignment\"><style:list-level-label-alignment text:label-followed-by=\"listtab\" text:list-tab-stop-position=\"{indent:.3}cm\" fo:text-indent=\"-0.635cm\" fo:margin-left=\"{indent:.3}cm\"/></style:list-level-properties>"
            );
            if *ordered {
                let fmt = ["1", "a", "i"][((level - 1) % 3) as usize];
                let _ = write!(
                    auto,
                    "<text:list-level-style-number text:level=\"{level}\" style:num-suffix=\".\" style:num-format=\"{fmt}\" text:start-value=\"{start}\">{props}</text:list-level-style-number>"
                );
            } else {
                let _ = write!(
                    auto,
                    "<text:list-level-style-bullet text:level=\"{level}\" text:bullet-char=\"\u{2022}\">{props}</text:list-level-style-bullet>"
                );
            }
        }
        auto.push_str("</text:list-style>");
    }
    auto.push_str(
        "<style:style style:name=\"Tbl\" style:family=\"table\"><style:table-properties style:width=\"17cm\" table:align=\"margins\"/></style:style>\
<style:style style:name=\"Cell\" style:family=\"table-cell\"><style:table-cell-properties fo:padding=\"0.1cm\" fo:border=\"0.5pt solid #808080\"/></style:style>\
<style:style style:name=\"fr1\" style:family=\"graphic\"><style:graphic-properties style:wrap=\"none\" style:vertical-pos=\"top\" style:vertical-rel=\"baseline\"/></style:style>",
    );

    let content = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-content {NS} office:version=\"1.3\">\
<office:font-face-decls><style:font-face style:name=\"Liberation Mono\" svg:font-family=\"'Liberation Mono'\" style:font-family-generic=\"modern\" style:font-pitch=\"fixed\"/></office:font-face-decls>\
<office:automatic-styles>{auto}</office:automatic-styles><office:body><office:text>{}</office:text></office:body></office:document-content>",
        w.body
    );

    let mut meta = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-meta {NS} office:version=\"1.3\"><office:meta><meta:generator>OmniDoc</meta:generator>"
    );
    if let Some(t) = &rich.meta.title {
        let _ = write!(meta, "<dc:title>{}</dc:title>", xml_escaped(t));
    }
    if let Some(a) = &rich.meta.author {
        let _ = write!(meta, "<dc:creator>{}</dc:creator>", xml_escaped(a));
    }
    meta.push_str("</office:meta></office:document-meta>");

    let mut manifest = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.3\">\
<manifest:file-entry manifest:full-path=\"/\" manifest:version=\"1.3\" manifest:media-type=\"{MIME}\"/>\
<manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>\
<manifest:file-entry manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/>\
<manifest:file-entry manifest:full-path=\"meta.xml\" manifest:media-type=\"text/xml\"/>"
    );
    for (name, _) in &w.images {
        let ext = name.rsplit('.').next().unwrap_or("");
        let _ = write!(
            manifest,
            "<manifest:file-entry manifest:full-path=\"Pictures/{name}\" manifest:media-type=\"{}\"/>",
            super::util::mime_from_ext(ext)
        );
    }
    manifest.push_str("</manifest:manifest>");

    let mut zw = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zw.start_file("mimetype", stored).map_err(zip_err)?;
    zw.write_all(MIME.as_bytes())?;
    let mut put = |name: &str, data: &[u8]| -> Result<()> {
        zw.start_file(name, deflated).map_err(zip_err)?;
        zw.write_all(data)?;
        Ok(())
    };
    put("META-INF/manifest.xml", manifest.as_bytes())?;
    put("content.xml", content.as_bytes())?;
    put("styles.xml", styles_xml(&w.code_langs).as_bytes())?;
    put("meta.xml", meta.as_bytes())?;
    for (name, data) in &w.images {
        put(&format!("Pictures/{name}"), data)?;
    }
    Ok(zw.finish().map_err(zip_err)?.into_inner())
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
            let again = parse(&serialize(&back).unwrap()).unwrap();
            assert_eq!(again.doc, doc.doc);
        }
    }

    #[test]
    fn whitespace_roundtrip() {
        let tree = RichTree {
            blocks: vec![Block::para(vec![Inline::text("  a   b \t c  ")])],
        };
        let doc = to_rich(tree);
        let back = parse(&serialize(&doc).unwrap()).unwrap();
        assert_eq!(back.doc, doc.doc);
    }

    #[test]
    fn package_layout() {
        let bytes = serialize(&to_rich(reference(true))).unwrap();
        // mimetype en premier, non compressé
        assert_eq!(&bytes[30..38], b"mimetype");
        assert!(bytes
            .windows(MIME.len())
            .take(200)
            .any(|w| w == MIME.as_bytes()));
        let mut z = open_zip(&bytes).unwrap();
        assert_eq!(z.by_index(0).unwrap().name_raw(), b"mimetype");
        assert_eq!(
            z.by_index(0).unwrap().compression(),
            CompressionMethod::Stored
        );
        for part in [
            "META-INF/manifest.xml",
            "content.xml",
            "styles.xml",
            "meta.xml",
            "Pictures/image1.png",
        ] {
            assert!(zip_read(&mut z, part, 1 << 24).unwrap().is_some(), "{part}");
        }
        for part in [
            "META-INF/manifest.xml",
            "content.xml",
            "styles.xml",
            "meta.xml",
        ] {
            let b = zip_read(&mut z, part, 1 << 24).unwrap().unwrap();
            super::super::xml::parse(&b).unwrap();
        }
    }

    #[test]
    fn detection_and_handler() {
        let bytes = serialize(&to_rich(reference(false))).unwrap();
        let h = OdtHandler;
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.odt", &bytes)),
            Some(Confidence(95))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("a.docx", b"hello")), None);
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.odt");
        let model = DocumentModel::RichText(to_rich(reference(true)));
        h.save(&model, &p).unwrap();
        let DocumentModel::RichText(back) = h.open(&p).unwrap() else {
            panic!("modèle");
        };
        assert_eq!(back.doc, rich_of(&model).unwrap().doc);
    }

    #[test]
    fn reads_libreoffice_style_content() {
        let content = format!(
            r#"<office:document-content {NS}><office:automatic-styles>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>
<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1" text:start-value="4"/></text:list-style>
</office:automatic-styles><office:body><office:text>
<text:h text:outline-level="2">Titre</text:h>
<text:p text:style-name="P1">Un <text:span text:style-name="T1">gras  italique</text:span> <text:a xlink:href="https://e.org/">lien</text:a><text:note/></text:p>
<text:list text:style-name="L1"><text:list-item><text:p>a</text:p></text:list-item></text:list>
</office:text></office:body></office:document-content>"#
        );
        let mut zw = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let o = SimpleFileOptions::default();
        zw.start_file("content.xml", o).unwrap();
        zw.write_all(content.as_bytes()).unwrap();
        let bytes = zw.finish().unwrap().into_inner();
        let doc = parse(&bytes).unwrap();
        let tree = RichTree::from_rich(&doc);
        assert!(matches!(&tree.blocks[0], Block::Heading { level: 2, .. }));
        match &tree.blocks[1] {
            Block::Paragraph { align, content } => {
                assert_eq!(*align, Some(Align::Center));
                assert_eq!(
                    super::super::tree::inlines_text(content),
                    "Un gras italique lien"
                );
                assert!(
                    matches!(&content[1], Inline::Text { marks, .. } if marks.contains(&Mark::Bold) && marks.contains(&Mark::Italic))
                );
            }
            b => panic!("{b:?}"),
        }
        assert!(matches!(
            &tree.blocks[2],
            Block::OrderedList { start: 4, .. }
        ));
        assert!(doc.lossy.contains(&"footnotes".to_string()));
    }

    #[test]
    fn corrupt_inputs_do_not_panic() {
        let good = serialize(&to_rich(reference(true))).unwrap();
        assert!(parse(&[]).is_err());
        assert!(parse(b"PK\x03\x04junk").is_err());
        for cut in [10, 100, 500, good.len() / 2, good.len() - 5] {
            let _ = parse(&good[..cut.min(good.len())]);
        }
        let mut flipped = good.clone();
        for i in (0..flipped.len()).step_by(41) {
            flipped[i] ^= 0x5A;
        }
        let _ = parse(&flipped);
    }
}
