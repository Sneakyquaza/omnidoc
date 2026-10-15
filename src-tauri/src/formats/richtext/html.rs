//! HTML « document riche » : lecture via html5ever (scraper), écriture HTML5 propre.
//! Les scripts, styles, iframes et schémas dangereux (`javascript:`) sont ignorés.

use std::fmt::Write as _;
use std::path::Path;

use scraper::node::Node;
use scraper::{ElementRef, Html, Selector};

use super::docx::is_monospace;
use super::tree::{Align, Block, Cell, Image, Inline, Lossy, Mark, RichTree, TaskItem};
use super::util::{format_pt, parse_font_size_pt, safe_url, to_hex6, xml_escaped};
use super::{read_limited, rich_of};
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_DEPTH;
use crate::core::model::{DocumentModel, ModelKind, RichDoc, RichMeta};
use crate::core::probe::FileProbe;
use crate::error::Result;

pub struct HtmlHandler;

impl FormatHandler for HtmlHandler {
    fn id(&self) -> &'static str {
        "html"
    }

    fn model(&self) -> ModelKind {
        ModelKind::RichText
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["html", "htm"]
    }

    fn label_key(&self) -> &'static str {
        "formats.html"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let head = String::from_utf8_lossy(&probe.head).to_lowercase();
        let head = head.trim_start_matches('\u{feff}').trim_start();
        let sniffed = head.starts_with("<!doctype html") || head.contains("<html");
        if sniffed {
            return Some(Confidence(75));
        }
        matches!(probe.ext.as_str(), "html" | "htm").then_some(Confidence(70))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: ["docx", "odt", "markdown-rich", "pdf"]
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

#[derive(Default)]
struct Ctx {
    blocks: Vec<Block>,
    inlines: Vec<Inline>,
    marks: Vec<Mark>,
    align: Option<Align>,
    heading: Option<u8>,
    pre: bool,
}

impl Ctx {
    fn child(&self) -> Ctx {
        Ctx {
            marks: self.marks.clone(),
            ..Default::default()
        }
    }

    fn flush(&mut self) {
        let mut content = std::mem::take(&mut self.inlines);
        // Retire l'espace de tête / de queue (collapse HTML).
        if !self.pre {
            if let Some(Inline::Text { text, .. }) = content.first_mut() {
                *text = text.trim_start_matches(' ').to_string();
            }
            if let Some(Inline::Text { text, .. }) = content.last_mut() {
                *text = text.trim_end_matches(' ').to_string();
            }
        }
        content.retain(|i| !matches!(i, Inline::Text { text, .. } if text.is_empty()));
        if content.is_empty() {
            return;
        }
        let align = self.align;
        match self.heading {
            Some(level) => self.blocks.push(Block::Heading {
                level,
                align,
                content,
            }),
            None => self.blocks.push(Block::Paragraph { align, content }),
        }
    }
}

fn style_prop(style: &str, name: &str) -> Option<String> {
    style.split(';').find_map(|d| {
        let (k, v) = d.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(name)).then(|| v.trim().to_string())
    })
}

fn style_marks(style: &str) -> Vec<Mark> {
    let mut m = Vec::new();
    let lower = style.to_lowercase();
    if let Some(w) = style_prop(&lower, "font-weight") {
        if w == "bold" || w == "bolder" || w.parse::<u32>().is_ok_and(|n| n >= 600) {
            m.push(Mark::Bold);
        }
    }
    if matches!(
        style_prop(&lower, "font-style").as_deref(),
        Some("italic" | "oblique")
    ) {
        m.push(Mark::Italic);
    }
    if let Some(d) =
        style_prop(&lower, "text-decoration").or_else(|| style_prop(&lower, "text-decoration-line"))
    {
        if d.contains("underline") {
            m.push(Mark::Underline);
        }
        if d.contains("line-through") {
            m.push(Mark::Strike);
        }
    }
    match style_prop(&lower, "vertical-align").as_deref() {
        Some("sub") => m.push(Mark::Subscript),
        Some("super") => m.push(Mark::Superscript),
        _ => {}
    }
    let color = style_prop(style, "color").and_then(|c| to_hex6(&c));
    let font = style_prop(style, "font-family").and_then(|f| {
        let first = f
            .split(',')
            .next()?
            .trim()
            .trim_matches(|c| c == '\'' || c == '"');
        (!first.is_empty() && !matches!(first, "inherit" | "initial")).then(|| first.to_string())
    });
    let mut code = false;
    let font = match font {
        Some(f) if is_monospace(&f) => {
            code = true;
            None
        }
        f => f,
    };
    if code {
        m.push(Mark::Code);
    }
    let size = style_prop(style, "font-size")
        .and_then(|s| parse_font_size_pt(&s))
        .map(format_pt);
    if let Some(ts) = Mark::text_style(color, font, size) {
        m.push(ts);
    }
    if let Some(bg) = style_prop(style, "background-color").and_then(|c| to_hex6(&c)) {
        m.push(Mark::Highlight { color: Some(bg) });
    }
    m
}

fn style_align(el: &ElementRef) -> Option<Align> {
    el.value()
        .attr("style")
        .and_then(|s| style_prop(s, "text-align"))
        .or_else(|| el.value().attr("align").map(String::from))
        .and_then(|a| Align::from_css(&a))
}

fn skip_tag(name: &str) -> bool {
    matches!(
        name,
        "script"
            | "style"
            | "iframe"
            | "noscript"
            | "template"
            | "head"
            | "object"
            | "embed"
            | "canvas"
            | "svg"
            | "audio"
            | "video"
            | "input"
            | "button"
            | "select"
            | "textarea"
            | "link"
            | "meta"
            | "title"
    )
}

fn checkbox_state(el: &ElementRef, depth: usize) -> Option<bool> {
    if depth > 3 {
        return None;
    }
    for c in el.children() {
        if let Some(ce) = ElementRef::wrap(c) {
            if ce.value().name() == "input"
                && ce
                    .value()
                    .attr("type")
                    .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
            {
                return Some(ce.value().attr("checked").is_some());
            }
            if let Some(s) = checkbox_state(&ce, depth + 1) {
                return Some(s);
            }
        }
    }
    None
}

fn parse_u32(el: &ElementRef, attr: &str) -> u32 {
    el.value()
        .attr(attr)
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(1)
        .clamp(1, 1000)
}

struct Walker {
    lossy: Lossy,
}

impl Walker {
    fn text(&mut self, t: &str, ctx: &mut Ctx) {
        if ctx.pre {
            ctx.inlines.push(Inline::Text {
                text: t.to_string(),
                marks: ctx.marks.clone(),
            });
            return;
        }
        let mut s = String::with_capacity(t.len());
        let mut prev_space = match ctx.inlines.last() {
            Some(Inline::Text { text, .. }) => text.ends_with(' '),
            Some(Inline::HardBreak) | None => true,
            Some(Inline::Image(_)) => false,
        };
        for ch in t.chars() {
            if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                if !prev_space {
                    s.push(' ');
                    prev_space = true;
                }
            } else {
                s.push(ch);
                prev_space = false;
            }
        }
        if !s.is_empty() {
            ctx.inlines.push(Inline::Text {
                text: s,
                marks: ctx.marks.clone(),
            });
        }
    }

    fn children(&mut self, el: &ElementRef, ctx: &mut Ctx, depth: usize) {
        for c in el.children() {
            match c.value() {
                Node::Text(t) => {
                    let s: &str = t;
                    self.text(s, ctx);
                }
                Node::Element(_) => {
                    if let Some(ce) = ElementRef::wrap(c) {
                        self.element(&ce, ctx, depth + 1);
                    }
                }
                _ => {}
            }
        }
    }

    fn block_scope(&mut self, el: &ElementRef, ctx: &mut Ctx, depth: usize) -> Vec<Block> {
        let mut sub = ctx.child();
        self.children(el, &mut sub, depth);
        sub.flush();
        sub.blocks
    }

    fn element(&mut self, el: &ElementRef, ctx: &mut Ctx, depth: usize) {
        let name = el.value().name().to_lowercase();
        if skip_tag(&name) {
            if matches!(name.as_str(), "script" | "iframe" | "object" | "embed") {
                self.lossy.add("scripts_embeds");
            }
            return;
        }
        if depth > MAX_DEPTH {
            let t: String = el.text().collect();
            self.text(&t, ctx);
            return;
        }
        let style = el.value().attr("style").unwrap_or("");
        match name.as_str() {
            "br" => ctx.inlines.push(Inline::HardBreak),
            "hr" => {
                ctx.flush();
                ctx.blocks.push(Block::HorizontalRule);
            }
            "img" => {
                let src = el.value().attr("src").and_then(|s| safe_url(s, true));
                if let Some(src) = src {
                    let get = |a: &str| {
                        el.value()
                            .attr(a)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    };
                    let width = el
                        .value()
                        .attr("width")
                        .map(|w| w.trim().trim_end_matches("px").to_string())
                        .or_else(|| {
                            style_prop(style, "width").map(|w| w.trim_end_matches("px").to_string())
                        })
                        .and_then(|w| w.parse::<f64>().ok())
                        .filter(|w| *w >= 1.0 && *w < 100_000.0)
                        .map(|w| w.round() as u32);
                    ctx.inlines.push(Inline::Image(Image {
                        src,
                        alt: get("alt"),
                        title: get("title"),
                        width,
                    }));
                }
            }
            "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "nav"
            | "aside" | "figure" | "figcaption" | "details" | "summary" | "form" | "fieldset"
            | "address" | "center" | "dd" | "dt" | "dl" | "li" => {
                ctx.flush();
                let (old_align, old_len) = (ctx.align, ctx.marks.len());
                if let Some(a) = style_align(el) {
                    ctx.align = Some(a);
                } else if name == "center" {
                    ctx.align = Some(Align::Center);
                }
                ctx.marks.extend(style_marks(style));
                self.children(el, ctx, depth);
                ctx.flush();
                ctx.align = old_align;
                ctx.marks.truncate(old_len);
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                ctx.flush();
                let (old_align, old_len) = (ctx.align, ctx.marks.len());
                let level = name[1..].parse::<u8>().unwrap_or(1);
                ctx.heading = Some(level);
                ctx.align = style_align(el);
                ctx.marks.extend(style_marks(style));
                self.children(el, ctx, depth);
                ctx.flush();
                ctx.heading = None;
                ctx.align = old_align;
                ctx.marks.truncate(old_len);
            }
            "blockquote" => {
                ctx.flush();
                let inner = self.block_scope(el, ctx, depth);
                ctx.blocks.push(Block::Blockquote(inner));
            }
            "pre" => {
                ctx.flush();
                let code_el = el
                    .children()
                    .filter_map(ElementRef::wrap)
                    .find(|c| c.value().name() == "code");
                let lang_src = code_el.as_ref().unwrap_or(el);
                let language = lang_src
                    .value()
                    .classes()
                    .find_map(|c| {
                        c.strip_prefix("language-")
                            .or_else(|| c.strip_prefix("lang-"))
                    })
                    .map(String::from);
                let mut text: String = el.text().collect();
                if text.ends_with('\n') {
                    text.pop();
                }
                ctx.blocks.push(Block::CodeBlock { language, text });
            }
            "ul" | "ol" => {
                ctx.flush();
                let lis: Vec<ElementRef> = el
                    .children()
                    .filter_map(ElementRef::wrap)
                    .filter(|c| c.value().name() == "li")
                    .collect();
                let task = el.value().attr("data-type") == Some("taskList")
                    || lis.iter().any(|li| {
                        li.value().attr("data-checked").is_some() || checkbox_state(li, 0).is_some()
                    });
                if task {
                    let items = lis
                        .iter()
                        .map(|li| {
                            let checked = match li.value().attr("data-checked") {
                                Some(v) => v == "true",
                                None => checkbox_state(li, 0).unwrap_or(false),
                            };
                            TaskItem {
                                checked,
                                content: self.block_scope(li, ctx, depth + 1),
                            }
                        })
                        .collect();
                    ctx.blocks.push(Block::TaskList(items));
                } else {
                    let items: Vec<Vec<Block>> = lis
                        .iter()
                        .map(|li| self.block_scope(li, ctx, depth + 1))
                        .collect();
                    if name == "ol" {
                        let start = el
                            .value()
                            .attr("start")
                            .and_then(|s| s.trim().parse::<u32>().ok())
                            .unwrap_or(1);
                        ctx.blocks.push(Block::OrderedList { start, items });
                    } else {
                        ctx.blocks.push(Block::BulletList(items));
                    }
                }
            }
            "table" => {
                ctx.flush();
                let mut rows: Vec<Vec<Cell>> = Vec::new();
                self.table_rows(el, ctx, depth, &mut rows);
                ctx.blocks.push(Block::Table(rows));
            }
            _ => {
                // Éléments en ligne (et inconnus : contenu aplati).
                let old_len = ctx.marks.len();
                ctx.marks.extend(style_marks(style));
                match name.as_str() {
                    "strong" | "b" => ctx.marks.push(Mark::Bold),
                    "em" | "i" | "cite" | "dfn" | "var" => ctx.marks.push(Mark::Italic),
                    "u" | "ins" => ctx.marks.push(Mark::Underline),
                    "s" | "strike" | "del" => ctx.marks.push(Mark::Strike),
                    "code" | "tt" | "kbd" | "samp" => ctx.marks.push(Mark::Code),
                    "sub" => ctx.marks.push(Mark::Subscript),
                    "sup" => ctx.marks.push(Mark::Superscript),
                    "mark" => ctx.marks.push(Mark::Highlight {
                        color: Some("#ffff00".into()),
                    }),
                    "a" => {
                        if let Some(h) = el.value().attr("href").and_then(|h| safe_url(h, false)) {
                            ctx.marks.push(Mark::Link { href: h });
                        }
                    }
                    "font" => {
                        let color = el.value().attr("color").and_then(to_hex6);
                        let face = el.value().attr("face").map(String::from);
                        if let Some(ts) = Mark::text_style(color, face, None) {
                            ctx.marks.push(ts);
                        }
                    }
                    _ => {}
                }
                self.children(el, ctx, depth);
                ctx.marks.truncate(old_len);
            }
        }
    }

    fn table_rows(
        &mut self,
        el: &ElementRef,
        ctx: &mut Ctx,
        depth: usize,
        rows: &mut Vec<Vec<Cell>>,
    ) {
        for c in el.children().filter_map(ElementRef::wrap) {
            match c.value().name() {
                "thead" | "tbody" | "tfoot" => self.table_rows(&c, ctx, depth + 1, rows),
                "tr" => {
                    let mut row = Vec::new();
                    for cell in c.children().filter_map(ElementRef::wrap) {
                        let n = cell.value().name();
                        if n != "td" && n != "th" {
                            continue;
                        }
                        let content = self.block_scope(&cell, ctx, depth + 1);
                        row.push(Cell {
                            header: n == "th",
                            colspan: parse_u32(&cell, "colspan"),
                            rowspan: parse_u32(&cell, "rowspan"),
                            content,
                        });
                    }
                    rows.push(row);
                }
                _ => {}
            }
        }
    }
}

pub fn parse(bytes: &[u8]) -> Result<RichDoc> {
    let src = super::util::decode_text(bytes, true);
    let html = Html::parse_document(&src);
    let mut meta = RichMeta::default();
    if let Ok(sel) = Selector::parse("title") {
        meta.title = html
            .select(&sel)
            .next()
            .map(|t| t.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty());
    }
    if let Ok(sel) = Selector::parse("meta[name=author]") {
        meta.author = html
            .select(&sel)
            .next()
            .and_then(|m| m.value().attr("content"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
    let root = Selector::parse("body")
        .ok()
        .and_then(|s| html.select(&s).next())
        .unwrap_or_else(|| html.root_element());
    let mut w = Walker {
        lossy: Lossy::default(),
    };
    let mut ctx = Ctx::default();
    w.children(&root, &mut ctx, 0);
    ctx.flush();
    let tree = RichTree { blocks: ctx.blocks };
    Ok(tree.into_rich(meta, w.lossy))
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

fn wrap_marks(inner: String, marks: &[Mark]) -> String {
    let mut s = inner;
    let mut style = String::new();
    let mut hl: Option<&Option<String>> = None;
    for m in marks {
        match m {
            Mark::TextStyle {
                color,
                font_family,
                font_size,
            } => {
                if let Some(c) = color.as_deref().and_then(to_hex6) {
                    let _ = write!(style, "color:{c};");
                }
                if let Some(f) = font_family {
                    let _ = write!(style, "font-family:'{}';", f.replace('\'', ""));
                }
                if let Some(sz) = font_size.as_deref().and_then(parse_font_size_pt) {
                    let _ = write!(style, "font-size:{};", format_pt(sz));
                }
            }
            Mark::Highlight { color } => hl = Some(color),
            _ => {}
        }
    }
    let style = style.trim_end_matches(';').to_string();
    // Du plus intérieur au plus extérieur (ordre canonique inversé).
    if !style.is_empty() {
        s = format!("<span style=\"{}\">{s}</span>", xml_escaped(&style));
    }
    for m in marks.iter().rev() {
        s = match m {
            Mark::Superscript => format!("<sup>{s}</sup>"),
            Mark::Subscript => format!("<sub>{s}</sub>"),
            Mark::Highlight { .. } => match hl.and_then(|c| c.as_deref()).and_then(to_hex6) {
                Some(c) => format!("<mark style=\"background-color:{c}\">{s}</mark>"),
                None => format!("<mark>{s}</mark>"),
            },
            Mark::Code => format!("<code>{s}</code>"),
            Mark::Strike => format!("<s>{s}</s>"),
            Mark::Underline => format!("<u>{s}</u>"),
            Mark::Italic => format!("<em>{s}</em>"),
            Mark::Bold => format!("<strong>{s}</strong>"),
            Mark::Link { href } => format!("<a href=\"{}\">{s}</a>", xml_escaped(href)),
            Mark::TextStyle { .. } => s,
        };
    }
    s
}

fn text_html(t: &str) -> String {
    let esc = xml_escaped(t).replace("&quot;", "\"");
    let mut out = String::with_capacity(esc.len());
    let mut prev_space = false;
    for c in esc.chars() {
        match c {
            '\n' => {
                out.push_str("<br>");
                prev_space = false;
            }
            ' ' if prev_space => out.push('\u{a0}'),
            ' ' => {
                out.push(' ');
                prev_space = true;
            }
            c => {
                out.push(c);
                prev_space = false;
            }
        }
    }
    out
}

fn inlines_html(content: &[Inline]) -> String {
    let mut out = String::new();
    for i in content {
        match i {
            Inline::Text { text, marks } => out.push_str(&wrap_marks(text_html(text), marks)),
            Inline::HardBreak => out.push_str("<br>"),
            Inline::Image(img) => {
                let _ = write!(out, "<img src=\"{}\"", xml_escaped(&img.src));
                if let Some(a) = &img.alt {
                    let _ = write!(out, " alt=\"{}\"", xml_escaped(a));
                }
                if let Some(t) = &img.title {
                    let _ = write!(out, " title=\"{}\"", xml_escaped(t));
                }
                if let Some(w) = img.width {
                    let _ = write!(out, " width=\"{w}\"");
                }
                out.push('>');
            }
        }
    }
    out
}

fn align_attr(align: Option<Align>) -> String {
    align
        .map(|a| format!(" style=\"text-align:{}\"", a.css()))
        .unwrap_or_default()
}

fn blocks_html(blocks: &[Block], out: &mut String) {
    for b in blocks {
        block_html(b, out);
    }
}

fn items_html(items: &[Vec<Block>], out: &mut String) {
    for it in items {
        out.push_str("<li>");
        blocks_html(it, out);
        out.push_str("</li>\n");
    }
}

fn block_html(b: &Block, out: &mut String) {
    match b {
        Block::Paragraph { align, content } => {
            let _ = writeln!(
                out,
                "<p{}>{}</p>",
                align_attr(*align),
                inlines_html(content)
            );
        }
        Block::Heading {
            level,
            align,
            content,
        } => {
            let l = (*level).clamp(1, 6);
            let _ = writeln!(
                out,
                "<h{l}{}>{}</h{l}>",
                align_attr(*align),
                inlines_html(content)
            );
        }
        Block::BulletList(items) => {
            out.push_str("<ul>\n");
            items_html(items, out);
            out.push_str("</ul>\n");
        }
        Block::OrderedList { start, items } => {
            if *start == 1 {
                out.push_str("<ol>\n");
            } else {
                let _ = writeln!(out, "<ol start=\"{start}\">");
            }
            items_html(items, out);
            out.push_str("</ol>\n");
        }
        Block::TaskList(items) => {
            out.push_str("<ul data-type=\"taskList\">\n");
            for it in items {
                let (attr, chk) = if it.checked {
                    ("true", " checked")
                } else {
                    ("false", "")
                };
                let _ = write!(
                    out,
                    "<li data-type=\"taskItem\" data-checked=\"{attr}\"><input type=\"checkbox\" disabled{chk}>"
                );
                blocks_html(&it.content, out);
                out.push_str("</li>\n");
            }
            out.push_str("</ul>\n");
        }
        Block::Blockquote(c) => {
            out.push_str("<blockquote>\n");
            blocks_html(c, out);
            out.push_str("</blockquote>\n");
        }
        Block::CodeBlock { language, text } => {
            let class = language
                .as_ref()
                .map(|l| format!(" class=\"language-{}\"", xml_escaped(l)))
                .unwrap_or_default();
            // html5ever retire un saut de ligne initial juste après <pre>.
            let lead = if text.starts_with('\n') { "\n" } else { "" };
            let _ = writeln!(
                out,
                "<pre>{lead}<code{class}>{}</code></pre>",
                xml_escaped(text).replace("&quot;", "\"")
            );
        }
        Block::HorizontalRule => out.push_str("<hr>\n"),
        Block::Table(rows) => {
            out.push_str("<table>\n");
            let head = rows
                .first()
                .is_some_and(|r| !r.is_empty() && r.iter().all(|c| c.header));
            for (ri, row) in rows.iter().enumerate() {
                if ri == 0 && head {
                    out.push_str("<thead>\n");
                }
                if (ri == 1 && head) || (ri == 0 && !head) {
                    out.push_str("<tbody>\n");
                }
                out.push_str("<tr>");
                for c in row {
                    let tag = if c.header { "th" } else { "td" };
                    let mut attrs = String::new();
                    if c.colspan > 1 {
                        let _ = write!(attrs, " colspan=\"{}\"", c.colspan);
                    }
                    if c.rowspan > 1 {
                        let _ = write!(attrs, " rowspan=\"{}\"", c.rowspan);
                    }
                    let _ = write!(out, "<{tag}{attrs}>");
                    blocks_html(&c.content, out);
                    let _ = write!(out, "</{tag}>");
                }
                out.push_str("</tr>\n");
                if ri == 0 && head {
                    out.push_str("</thead>\n");
                }
            }
            if rows.len() > usize::from(head) {
                out.push_str("</tbody>\n");
            }
            out.push_str("</table>\n");
        }
    }
}

pub fn serialize(rich: &RichDoc) -> Result<Vec<u8>> {
    let tree = RichTree::from_rich(rich);
    let mut out = String::from("<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n");
    if let Some(a) = &rich.meta.author {
        let _ = writeln!(out, "<meta name=\"author\" content=\"{}\">", xml_escaped(a));
    }
    let _ = writeln!(
        out,
        "<title>{}</title>",
        xml_escaped(rich.meta.title.as_deref().unwrap_or(""))
    );
    out.push_str("</head>\n<body>\n");
    blocks_html(&tree.blocks, &mut out);
    out.push_str("</body>\n</html>\n");
    Ok(out.into_bytes())
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
            assert_eq!(
                back.doc,
                doc.doc,
                "rich={rich}\n{}",
                String::from_utf8_lossy(&bytes)
            );
            let again = parse(&serialize(&back).unwrap()).unwrap();
            assert_eq!(again.doc, doc.doc);
        }
    }

    #[test]
    fn writes_complete_html5() {
        let mut doc = to_rich(reference(false));
        doc.meta.title = Some("A & B".into());
        let s = String::from_utf8(serialize(&doc).unwrap()).unwrap();
        assert!(s.starts_with("<!DOCTYPE html>"));
        assert!(s.contains("<meta charset=\"utf-8\">"));
        assert!(s.contains("<title>A &amp; B</title>"));
        assert!(s.contains("<h1>Titre principal</h1>"));
        assert!(s.contains("&lt;salut&gt; &amp; ok"));
        let back = parse(s.as_bytes()).unwrap();
        assert_eq!(back.meta.title.as_deref(), Some("A & B"));
    }

    #[test]
    fn reads_messy_html_safely() {
        let src = r#"<!doctype html><html><head><title>T</title><style>p{}</style></head><body>
<script>alert(1)</script><div>texte <b>gras</b>   <i>it</i> <a href="javascript:evil()">x</a><a href="https://e.org">ok</a>
<custom-tag>inconnu</custom-tag></div><iframe src="x"></iframe>
<ul><li>un<ul><li>sous</li></ul></li><li>deux</li></ul>
<p style="text-align:center;color:#f00">c</p><table><tr><th>h</th></tr><tr><td colspan="2">d</td></tr></table>
<pre><code class="language-py">x = 1
</code></pre></body></html>"#;
        let doc = parse(src.as_bytes()).unwrap();
        let s = doc.doc.to_string();
        assert!(!s.contains("alert"));
        assert!(!s.contains("javascript"));
        assert!(s.contains("inconnu"));
        assert!(s.contains("\"language\":\"py\""));
        assert!(s.contains("\"textAlign\":\"center\""));
        assert!(s.contains("\"colspan\":2"));
        assert_eq!(doc.meta.title.as_deref(), Some("T"));
        assert!(doc.lossy.contains(&"scripts_embeds".to_string()));
    }

    #[test]
    fn detection() {
        let h = HtmlHandler;
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.html", b"x")),
            Some(Confidence(70))
        );
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.txt", b"  <!DOCTYPE html><p>")),
            Some(Confidence(75))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("a.txt", b"hello")), None);
    }

    #[test]
    fn handler_io_and_garbage() {
        let h = HtmlHandler;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.html");
        let model = DocumentModel::RichText(to_rich(reference(true)));
        h.save(&model, &p).unwrap();
        let DocumentModel::RichText(back) = h.open(&p).unwrap() else {
            panic!("modèle");
        };
        assert_eq!(back.doc, rich_of(&model).unwrap().doc);
        for bytes in [
            &[0u8, 159, 146, 150][..],
            b"<<<<>>>",
            b"<table><tr><td><table>",
            b"</div></p>",
        ] {
            let _ = parse(bytes);
        }
        let deep = "<div>".repeat(5000);
        let _ = parse(deep.as_bytes());
    }
}
