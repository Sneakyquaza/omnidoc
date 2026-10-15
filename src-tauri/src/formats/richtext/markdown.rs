//! Markdown « document riche » (GFM) : lecture pulldown-cmark, sérialiseur maison.
//! Alternative « Ouvrir comme document riche » du handler texte Markdown (confiance 40).

use std::path::Path;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::tree::{blocks_text, Block, Cell, Image, Inline, Lossy, Mark, RichTree, TaskItem};
use super::util::{decode_text, safe_url};
use super::{read_limited, rich_of};
use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::model::{DocumentModel, ModelKind, RichDoc, RichMeta};
use crate::core::probe::FileProbe;
use crate::error::Result;

pub struct MarkdownRichHandler;

impl FormatHandler for MarkdownRichHandler {
    fn id(&self) -> &'static str {
        "markdown-rich"
    }

    fn model(&self) -> ModelKind {
        ModelKind::RichText
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["md", "markdown"]
    }

    fn label_key(&self) -> &'static str {
        "formats.markdownRich"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        matches!(probe.ext.as_str(), "md" | "markdown").then_some(Confidence(40))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: ["docx", "odt", "html", "pdf"].map(String::from).to_vec(),
            fidelity: Fidelity::Partial,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let bytes = read_limited(path)?;
        Ok(DocumentModel::RichText(parse(&bytes)?))
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

struct ListCtx {
    start: Option<u64>,
    items: Vec<(Vec<Block>, Option<bool>)>,
}

#[derive(Default)]
struct Builder {
    stack: Vec<Vec<Block>>,
    inlines: Vec<Inline>,
    marks: Vec<Mark>,
    html_marks: Vec<Mark>,
    lists: Vec<ListCtx>,
    checked: Vec<Option<bool>>,
    heading: Option<u8>,
    code: Option<(Option<String>, String)>,
    table: Option<Vec<Vec<Cell>>>,
    row: Vec<Cell>,
    in_head: bool,
    image: Option<(String, Option<String>, String)>,
    html_block: bool,
    lossy: Lossy,
}

impl Builder {
    fn push_block(&mut self, b: Block) {
        if let Some(top) = self.stack.last_mut() {
            top.push(b);
        }
    }

    fn flush(&mut self) {
        if !self.inlines.is_empty() {
            let c = std::mem::take(&mut self.inlines);
            self.push_block(Block::para(c));
        }
    }

    fn all_marks(&self) -> Vec<Mark> {
        let mut m = self.marks.clone();
        m.extend(self.html_marks.iter().cloned());
        m
    }

    fn text(&mut self, t: &str, extra: Option<Mark>) {
        if t.is_empty() {
            return;
        }
        let mut marks = self.all_marks();
        marks.extend(extra);
        self.inlines.push(Inline::Text {
            text: t.to_string(),
            marks,
        });
    }

    fn html(&mut self, s: &str) {
        let mut rest = s;
        while let Some(i) = rest.find('<') {
            let after = &rest[i + 1..];
            let Some(j) = after.find('>') else {
                break;
            };
            let tag = after[..j].trim();
            rest = &after[j + 1..];
            let (closing, tag) = match tag.strip_prefix('/') {
                Some(t) => (true, t),
                None => (false, tag),
            };
            let name: String = tag
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            let mark = match name.as_str() {
                "br" => {
                    if !closing {
                        self.inlines.push(Inline::HardBreak);
                    }
                    continue;
                }
                "u" | "ins" => Mark::Underline,
                "sub" => Mark::Subscript,
                "sup" => Mark::Superscript,
                "mark" => Mark::Highlight {
                    color: Some("#ffff00".into()),
                },
                _ => continue,
            };
            if closing {
                if let Some(p) = self.html_marks.iter().rposition(|m| *m == mark) {
                    self.html_marks.remove(p);
                }
            } else if self.html_marks.len() < 64 {
                self.html_marks.push(mark);
            }
        }
    }

    fn event(&mut self, ev: Event<'_>) {
        if self.html_block {
            if matches!(ev, Event::End(TagEnd::HtmlBlock)) {
                self.html_block = false;
            }
            return;
        }
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {}
                Tag::Heading { level, .. } => {
                    self.flush();
                    self.heading = Some(level as u8);
                }
                Tag::BlockQuote(_) => {
                    self.flush();
                    self.stack.push(Vec::new());
                }
                Tag::CodeBlock(kind) => {
                    self.flush();
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => info
                            .split_whitespace()
                            .next()
                            .map(String::from)
                            .filter(|s| !s.is_empty()),
                        CodeBlockKind::Indented => None,
                    };
                    self.code = Some((lang, String::new()));
                }
                Tag::HtmlBlock => {
                    self.flush();
                    self.lossy.add("html");
                    self.html_block = true;
                }
                Tag::List(start) => {
                    self.flush();
                    self.lists.push(ListCtx {
                        start,
                        items: Vec::new(),
                    });
                }
                Tag::Item => {
                    self.flush();
                    self.stack.push(Vec::new());
                    self.checked.push(None);
                }
                Tag::Table(_) => {
                    self.flush();
                    self.table = Some(Vec::new());
                }
                Tag::TableHead => {
                    self.in_head = true;
                    self.row = Vec::new();
                }
                Tag::TableRow => self.row = Vec::new(),
                Tag::TableCell => self.inlines.clear(),
                Tag::Emphasis => self.marks.push(Mark::Italic),
                Tag::Strong => self.marks.push(Mark::Bold),
                Tag::Strikethrough => self.marks.push(Mark::Strike),
                Tag::Link { dest_url, .. } => {
                    let href = safe_url(&dest_url, false).unwrap_or_default();
                    self.marks.push(Mark::Link { href });
                }
                Tag::Image {
                    dest_url, title, ..
                } => {
                    let src = safe_url(&dest_url, true).unwrap_or_default();
                    let title = (!title.is_empty()).then(|| title.to_string());
                    self.image = Some((src, title, String::new()));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => self.flush(),
                TagEnd::Heading(_) => {
                    let c = std::mem::take(&mut self.inlines);
                    let level = self.heading.take().unwrap_or(1);
                    self.push_block(Block::Heading {
                        level,
                        align: None,
                        content: c,
                    });
                }
                TagEnd::BlockQuote(_) => {
                    self.flush();
                    if let Some(c) = self.stack.pop() {
                        self.push_block(Block::Blockquote(c));
                    }
                }
                TagEnd::CodeBlock => {
                    if let Some((language, mut text)) = self.code.take() {
                        if text.ends_with('\n') {
                            text.pop();
                        }
                        self.push_block(Block::CodeBlock { language, text });
                    }
                }
                TagEnd::List(_) => {
                    if let Some(l) = self.lists.pop() {
                        let tasks = l.items.iter().any(|(_, c)| c.is_some());
                        let block = if tasks {
                            Block::TaskList(
                                l.items
                                    .into_iter()
                                    .map(|(content, c)| TaskItem {
                                        checked: c.unwrap_or(false),
                                        content,
                                    })
                                    .collect(),
                            )
                        } else if let Some(start) = l.start {
                            Block::OrderedList {
                                start: u32::try_from(start).unwrap_or(1),
                                items: l.items.into_iter().map(|(c, _)| c).collect(),
                            }
                        } else {
                            Block::BulletList(l.items.into_iter().map(|(c, _)| c).collect())
                        };
                        self.push_block(block);
                    }
                }
                TagEnd::Item => {
                    self.flush();
                    let blocks = self.stack.pop().unwrap_or_default();
                    let checked = self.checked.pop().flatten();
                    if let Some(l) = self.lists.last_mut() {
                        l.items.push((blocks, checked));
                    }
                }
                TagEnd::Table => {
                    if let Some(rows) = self.table.take() {
                        self.push_block(Block::Table(rows));
                    }
                }
                TagEnd::TableHead => {
                    let row = std::mem::take(&mut self.row);
                    if let Some(t) = self.table.as_mut() {
                        t.push(row);
                    }
                    self.in_head = false;
                }
                TagEnd::TableRow => {
                    let row = std::mem::take(&mut self.row);
                    if let Some(t) = self.table.as_mut() {
                        t.push(row);
                    }
                }
                TagEnd::TableCell => {
                    let c = std::mem::take(&mut self.inlines);
                    self.row.push(Cell {
                        header: self.in_head,
                        colspan: 1,
                        rowspan: 1,
                        content: vec![Block::para(c)],
                    });
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                    self.marks.pop();
                }
                TagEnd::Image => {
                    if let Some((src, title, alt)) = self.image.take() {
                        if !src.is_empty() {
                            self.inlines.push(Inline::Image(Image {
                                src,
                                alt: (!alt.is_empty()).then_some(alt),
                                title,
                                width: None,
                            }));
                        }
                    }
                }
                _ => {}
            },
            Event::Text(t) => {
                if let Some((_, buf)) = self.code.as_mut() {
                    buf.push_str(&t);
                } else if let Some((_, _, alt)) = self.image.as_mut() {
                    alt.push_str(&t);
                } else {
                    self.text(&t, None);
                }
            }
            Event::Code(t) => {
                if let Some((_, _, alt)) = self.image.as_mut() {
                    alt.push_str(&t);
                } else {
                    self.text(&t, Some(Mark::Code));
                }
            }
            Event::SoftBreak => {
                if let Some((_, _, alt)) = self.image.as_mut() {
                    alt.push(' ');
                } else {
                    self.text(" ", None);
                }
            }
            Event::HardBreak => self.inlines.push(Inline::HardBreak),
            Event::Rule => {
                self.flush();
                self.push_block(Block::HorizontalRule);
            }
            Event::TaskListMarker(c) => {
                if let Some(slot) = self.checked.last_mut() {
                    *slot = Some(c);
                }
            }
            Event::InlineHtml(h) => self.html(&h),
            Event::Html(_) => self.lossy.add("html"),
            Event::FootnoteReference(_) => self.lossy.add("footnotes"),
            _ => {}
        }
    }
}

pub fn parse(bytes: &[u8]) -> Result<RichDoc> {
    let text = decode_text(bytes, false);
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut b = Builder {
        stack: vec![Vec::new()],
        ..Default::default()
    };
    for ev in Parser::new_ext(&text, opts) {
        b.event(ev);
    }
    b.flush();
    let blocks = b.stack.into_iter().next().unwrap_or_default();
    Ok(RichTree { blocks }.into_rich(RichMeta::default(), b.lossy))
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq)]
enum Tag2 {
    Link(String),
    Bold,
    Italic,
    Strike,
    Underline,
    Sub,
    Sup,
    Mark,
}

impl Tag2 {
    fn open(&self) -> &'static str {
        match self {
            Tag2::Link(_) => "[",
            Tag2::Bold => "**",
            Tag2::Italic => "*",
            Tag2::Strike => "~~",
            Tag2::Underline => "<u>",
            Tag2::Sub => "<sub>",
            Tag2::Sup => "<sup>",
            Tag2::Mark => "<mark>",
        }
    }

    fn close(&self) -> String {
        match self {
            Tag2::Link(h) => format!("]({})", link_dest(h)),
            Tag2::Bold => "**".into(),
            Tag2::Italic => "*".into(),
            Tag2::Strike => "~~".into(),
            Tag2::Underline => "</u>".into(),
            Tag2::Sub => "</sub>".into(),
            Tag2::Sup => "</sup>".into(),
            Tag2::Mark => "</mark>".into(),
        }
    }
}

fn link_dest(h: &str) -> String {
    if h.chars()
        .any(|c| c.is_whitespace() || matches!(c, '(' | ')' | '<' | '>'))
    {
        let esc: String = h
            .chars()
            .map(|c| match c {
                '<' => "%3C".to_string(),
                '>' => "%3E".to_string(),
                c if c.is_whitespace() => "%20".to_string(),
                c => c.to_string(),
            })
            .collect();
        format!("<{esc}>")
    } else {
        h.to_string()
    }
}

fn tags_of(marks: &[Mark]) -> Vec<Tag2> {
    let mut t = Vec::new();
    for m in marks {
        if let Mark::Link { href } = m {
            t.push(Tag2::Link(href.clone()));
        }
    }
    let has = |x: &Mark| marks.contains(x);
    if has(&Mark::Bold) {
        t.push(Tag2::Bold);
    }
    if has(&Mark::Italic) {
        t.push(Tag2::Italic);
    }
    if has(&Mark::Strike) {
        t.push(Tag2::Strike);
    }
    if has(&Mark::Underline) {
        t.push(Tag2::Underline);
    }
    if has(&Mark::Subscript) {
        t.push(Tag2::Sub);
    }
    if has(&Mark::Superscript) {
        t.push(Tag2::Sup);
    }
    if marks.iter().any(|m| matches!(m, Mark::Highlight { .. })) {
        t.push(Tag2::Mark);
    }
    t
}

fn escape(core: &str, line_start: bool) -> String {
    let chars: Vec<char> = core.chars().collect();
    let mut out = String::with_capacity(core.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        let prev = if i > 0 { chars.get(i - 1) } else { None };
        let next = chars.get(i + 1);
        let alnum = |x: Option<&char>| x.is_some_and(|c| c.is_alphanumeric());
        match c {
            '\\' | '`' | '*' | '[' | ']' | '<' | '~' => {
                out.push('\\');
                out.push(c);
            }
            '_' if !(alnum(prev) && alnum(next)) => {
                out.push('\\');
                out.push('_');
            }
            '&' if {
                let rest: String = chars[i + 1..].iter().take(12).collect();
                rest.find(';').is_some_and(|p| {
                    p > 0
                        && rest[..p]
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '#')
                })
            } =>
            {
                out.push_str("\\&")
            }
            '#' | '>' if line_start && i == 0 => {
                out.push('\\');
                out.push(c);
            }
            '-' | '+' if line_start && i == 0 && next.is_none_or(|n| n.is_whitespace()) => {
                out.push('\\');
                out.push(c);
            }
            '.' | ')'
                if line_start
                    && i > 0
                    && chars[..i].iter().all(|d| d.is_ascii_digit())
                    && next.is_none_or(|n| n.is_whitespace()) =>
            {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

fn code_span(text: &str) -> String {
    let mut longest = 0;
    let mut cur = 0;
    for c in text.chars() {
        if c == '`' {
            cur += 1;
            longest = longest.max(cur);
        } else {
            cur = 0;
        }
    }
    let fence = "`".repeat(longest + 1);
    let pad = text.starts_with('`')
        || text.ends_with('`')
        || (text.starts_with(' ') && text.ends_with(' ') && !text.trim().is_empty());
    if pad {
        format!("{fence} {text} {fence}")
    } else {
        format!("{fence}{text}{fence}")
    }
}

fn image_md(img: &Image) -> String {
    let alt: String = img
        .alt
        .clone()
        .unwrap_or_default()
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .collect();
    let alt = alt
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    let title = img
        .title
        .as_ref()
        .map(|t| format!(" \"{}\"", t.replace('\\', "\\\\").replace('"', "\\\"")))
        .unwrap_or_default();
    format!("![{alt}]({}{title})", link_dest(&img.src))
}

/// `mode` : 0 = paragraphe, 1 = titre (sauts aplatis), 2 = cellule de tableau.
fn inline_md(content: &[Inline], mode: u8) -> String {
    let mut out = String::new();
    let mut stack: Vec<Tag2> = Vec::new();
    let mut pending = String::new();
    for item in content {
        match item {
            Inline::HardBreak => {
                pending.clear();
                while let Some(s) = stack.pop() {
                    out.push_str(&s.close());
                }
                out.push_str(match mode {
                    0 => "\\\n",
                    1 => " ",
                    _ => "<br>",
                });
            }
            Inline::Image(img) => {
                out.push_str(&pending);
                pending.clear();
                out.push_str(&image_md(img));
            }
            Inline::Text { text, marks } => {
                let text = text.replace('\r', "").replace('\n', " ");
                let tags = tags_of(marks);
                let is_code = marks.contains(&Mark::Code);
                let (lead, core, trail) = if is_code {
                    (String::new(), text.clone(), String::new())
                } else {
                    let t = text.trim_start_matches([' ', '\t']);
                    let lead = text[..text.len() - t.len()].to_string();
                    let c = t.trim_end_matches([' ', '\t']);
                    let trail = t[c.len()..].to_string();
                    (lead, c.to_string(), trail)
                };
                if let Some(i) = stack.iter().position(|s| !tags.contains(s)) {
                    while stack.len() > i {
                        if let Some(s) = stack.pop() {
                            out.push_str(&s.close());
                        }
                    }
                }
                if core.is_empty() {
                    pending.push_str(&text);
                    continue;
                }
                out.push_str(&pending);
                out.push_str(&lead);
                pending = trail;
                let line_start =
                    tags.is_empty() && lead.is_empty() && (out.is_empty() || out.ends_with('\n'));
                for t in &tags {
                    if !stack.contains(t) {
                        out.push_str(t.open());
                        stack.push(t.clone());
                    }
                }
                let mut body = if is_code {
                    code_span(&core)
                } else {
                    escape(&core, line_start)
                };
                if mode == 2 {
                    body = body.replace('|', "\\|");
                }
                out.push_str(&body);
            }
        }
    }
    while let Some(s) = stack.pop() {
        out.push_str(&s.close());
    }
    out.push_str(&pending);
    out
}

fn indent_lines(s: &str, first: &str, rest: &str) -> String {
    let mut out = String::new();
    for (i, line) in s.split('\n').enumerate() {
        let p = if i == 0 { first } else { rest };
        if line.is_empty() {
            out.push_str(p.trim_end());
        } else {
            out.push_str(p);
            out.push_str(line);
        }
        out.push('\n');
    }
    out.pop();
    out
}

fn item_md(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (i, b) in blocks.iter().enumerate() {
        if i > 0 {
            let tight = matches!(
                b,
                Block::BulletList(_) | Block::OrderedList { .. } | Block::TaskList(_)
            );
            out.push_str(if tight { "\n" } else { "\n\n" });
        }
        out.push_str(&block_md(b));
    }
    out
}

fn table_md(rows: &[Vec<Cell>]) -> String {
    let ncols = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let cell_md = |c: &Cell| -> String {
        let parts: Vec<String> = c
            .content
            .iter()
            .map(|b| match b {
                Block::Paragraph { content, .. } | Block::Heading { content, .. } => {
                    inline_md(content, 2)
                }
                other => escape(&blocks_text(std::slice::from_ref(other)), false)
                    .replace('\n', " ")
                    .replace('|', "\\|"),
            })
            .collect();
        parts.join("<br>")
    };
    let mut lines = Vec::new();
    for (ri, r) in rows.iter().enumerate() {
        let mut cells: Vec<String> = r.iter().map(&cell_md).collect();
        cells.resize(ncols, String::new());
        lines.push(format!("| {} |", cells.join(" | ")));
        if ri == 0 {
            lines.push(format!("|{}|", vec![" --- "; ncols].join("|")));
        }
    }
    lines.join("\n")
}

fn block_md(b: &Block) -> String {
    match b {
        Block::Paragraph { content, .. } => inline_md(content, 0),
        Block::Heading { level, content, .. } => {
            format!(
                "{} {}",
                "#".repeat(usize::from((*level).clamp(1, 6))),
                inline_md(content, 1)
            )
        }
        Block::BulletList(items) => items
            .iter()
            .map(|it| indent_lines(&item_md(it), "- ", "  "))
            .collect::<Vec<_>>()
            .join("\n"),
        Block::OrderedList { start, items } => items
            .iter()
            .enumerate()
            .map(|(i, it)| {
                let marker = format!("{}. ", u64::from(*start) + i as u64);
                let pad = " ".repeat(marker.len());
                indent_lines(&item_md(it), &marker, &pad)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Block::TaskList(items) => items
            .iter()
            .map(|it| {
                let m = if it.checked { "- [x] " } else { "- [ ] " };
                indent_lines(&item_md(&it.content), m, "  ")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Blockquote(c) => indent_lines(&blocks_md(c), "> ", "> "),
        Block::CodeBlock { language, text } => {
            let mut longest = 0;
            for l in text.lines() {
                let t = l.trim_start();
                let n = t.chars().take_while(|c| *c == '`').count();
                longest = longest.max(n);
            }
            let fence = "`".repeat(longest.max(2) + 1);
            let lang = language.as_deref().unwrap_or("");
            format!("{fence}{lang}\n{text}\n{fence}")
        }
        Block::HorizontalRule => "---".into(),
        Block::Table(rows) => table_md(rows),
    }
}

fn blocks_md(blocks: &[Block]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prev_list: Option<u8> = None;
    for b in blocks {
        let kind = match b {
            Block::BulletList(_) => Some(0),
            Block::OrderedList { .. } => Some(1),
            Block::TaskList(_) => Some(0),
            _ => None,
        };
        if kind.is_some() && kind == prev_list {
            // Deux listes consécutives de même type fusionneraient : séparateur invisible.
            parts.push("<!-- -->".into());
        }
        prev_list = kind;
        let s = block_md(b);
        // Un paragraphe vide produit une ligne vide : on le saute.
        if matches!(b, Block::Paragraph { .. }) && s.trim().is_empty() {
            continue;
        }
        parts.push(s);
    }
    parts.join("\n\n")
}

pub fn serialize(rich: &RichDoc) -> Result<Vec<u8>> {
    let tree = RichTree::from_rich(rich);
    let mut s = blocks_md(&tree.blocks);
    s.push('\n');
    Ok(s.into_bytes())
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
        let doc = to_rich(reference(false));
        let bytes = serialize(&doc).unwrap();
        let back = parse(&bytes).unwrap();
        assert_eq!(back.doc, doc.doc, "{}", String::from_utf8_lossy(&bytes));
        let again = parse(&serialize(&back).unwrap()).unwrap();
        assert_eq!(again.doc, doc.doc);
    }

    #[test]
    fn writes_clean_markdown() {
        let md = String::from_utf8(serialize(&to_rich(reference(false))).unwrap()).unwrap();
        assert!(md.starts_with("# Titre principal\n\n## Sous-titre"));
        assert!(md.contains("Texte **gras** *italique* ***gras italique***"));
        assert!(md.contains("~~barré~~"));
        assert!(md.contains("- [x] Fait\n- [ ] À faire"));
        assert!(md.contains("3. Trois\n4. Quatre"));
        assert!(md.contains("```rust\nfn main()"));
        assert!(md.contains("| Nom | Valeur |\n| --- | --- |"));
        assert!(md.contains("![pixel](data:image/png;base64,"));
        assert!(md.contains("> Une citation"));
    }

    #[test]
    fn reads_gfm() {
        let src = "# T\n\n- [x] a\n- [ ] b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nx ~~y~~ <u>z</u> `c`\n\n<div>raw</div>\n";
        let doc = parse(src.as_bytes()).unwrap();
        let tree = RichTree::from_rich(&doc);
        assert!(matches!(&tree.blocks[1], Block::TaskList(t) if t[0].checked && !t[1].checked));
        assert!(matches!(&tree.blocks[2], Block::Table(r) if r[0][0].header && !r[1][0].header));
        assert!(doc.lossy.contains(&"html".to_string()));
    }

    #[test]
    fn escapes_special_characters() {
        let tree = RichTree {
            blocks: vec![
                Block::para(vec![Inline::text(
                    "1. pas une liste *x* _y_ snake_case <b> [l](u) & #",
                )]),
                Block::para(vec![Inline::text("# pas un titre")]),
            ],
        };
        let doc = to_rich(tree);
        let back = parse(&serialize(&doc).unwrap()).unwrap();
        assert_eq!(back.doc, doc.doc);
    }

    #[test]
    fn handler_detect_and_io() {
        let h = MarkdownRichHandler;
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.md", b"# x")),
            Some(Confidence(40))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("a.txt", b"# x")), None);
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        let model = DocumentModel::RichText(to_rich(reference(false)));
        h.save(&model, &p).unwrap();
        let DocumentModel::RichText(back) = h.open(&p).unwrap() else {
            panic!("modèle");
        };
        assert_eq!(back.doc, rich_of(&model).unwrap().doc);
    }

    #[test]
    fn garbage_does_not_panic() {
        for bytes in [
            &[0u8, 159, 146, 150][..],
            b"[[[[",
            b"![](",
            b"| a |\n|-|\n| \x00",
        ] {
            let _ = parse(bytes);
        }
    }
}
