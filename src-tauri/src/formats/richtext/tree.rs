//! Arbre intermédiaire du traitement de texte + conversion bidirectionnelle vers le JSON
//! TipTap/ProseMirror (`RichDoc.doc`). Tous les formats de la famille passent par ces types.

use serde_json::{json, Map, Value};

use crate::core::limits::MAX_DEPTH;
use crate::core::model::{RichDoc, RichMeta};

/// Éléments du format source non conservés (clés stables, traduites côté front).
#[derive(Debug, Default, Clone)]
pub struct Lossy(Vec<String>);

impl Lossy {
    pub fn add(&mut self, key: &str) {
        if !self.0.iter().any(|k| k == key) {
            self.0.push(key.to_string());
        }
    }

    pub fn extend(&mut self, keys: &[String]) {
        for k in keys {
            self.add(k);
        }
    }

    pub fn into_vec(self) -> Vec<String> {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Center,
    Right,
    Justify,
}

impl Align {
    pub fn css(self) -> &'static str {
        match self {
            Align::Center => "center",
            Align::Right => "right",
            Align::Justify => "justify",
        }
    }

    pub fn from_css(s: &str) -> Option<Align> {
        match s.trim().to_lowercase().as_str() {
            "center" => Some(Align::Center),
            "right" | "end" => Some(Align::Right),
            "justify" | "both" | "distribute" => Some(Align::Justify),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mark {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Link {
        href: String,
    },
    TextStyle {
        color: Option<String>,
        font_family: Option<String>,
        font_size: Option<String>,
    },
    Highlight {
        color: Option<String>,
    },
    Subscript,
    Superscript,
}

impl Mark {
    fn rank(&self) -> u8 {
        match self {
            Mark::Link { .. } => 0,
            Mark::Bold => 1,
            Mark::Italic => 2,
            Mark::Underline => 3,
            Mark::Strike => 4,
            Mark::Code => 5,
            Mark::TextStyle { .. } => 6,
            Mark::Highlight { .. } => 7,
            Mark::Subscript => 8,
            Mark::Superscript => 9,
        }
    }

    pub fn text_style(
        color: Option<String>,
        font_family: Option<String>,
        font_size: Option<String>,
    ) -> Option<Mark> {
        if color.is_none() && font_family.is_none() && font_size.is_none() {
            None
        } else {
            Some(Mark::TextStyle {
                color,
                font_family,
                font_size,
            })
        }
    }

    fn to_json(&self) -> Value {
        fn with(ty: &str, attrs: Map<String, Value>) -> Value {
            if attrs.is_empty() {
                json!({ "type": ty })
            } else {
                json!({ "type": ty, "attrs": attrs })
            }
        }
        let mut a = Map::new();
        match self {
            Mark::Bold => with("bold", a),
            Mark::Italic => with("italic", a),
            Mark::Underline => with("underline", a),
            Mark::Strike => with("strike", a),
            Mark::Code => with("code", a),
            Mark::Subscript => with("subscript", a),
            Mark::Superscript => with("superscript", a),
            Mark::Link { href } => {
                a.insert("href".into(), json!(href));
                with("link", a)
            }
            Mark::TextStyle {
                color,
                font_family,
                font_size,
            } => {
                if let Some(c) = color {
                    a.insert("color".into(), json!(c));
                }
                if let Some(f) = font_family {
                    a.insert("fontFamily".into(), json!(f));
                }
                if let Some(s) = font_size {
                    a.insert("fontSize".into(), json!(s));
                }
                with("textStyle", a)
            }
            Mark::Highlight { color } => {
                if let Some(c) = color {
                    a.insert("color".into(), json!(c));
                }
                with("highlight", a)
            }
        }
    }

    fn from_json(v: &Value, lossy: &mut Lossy) -> Option<Mark> {
        let ty = v.get("type")?.as_str()?;
        let attr = |k: &str| -> Option<String> {
            v.get("attrs")?
                .get(k)?
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        Some(match ty {
            "bold" => Mark::Bold,
            "italic" => Mark::Italic,
            "underline" => Mark::Underline,
            "strike" => Mark::Strike,
            "code" => Mark::Code,
            "subscript" => Mark::Subscript,
            "superscript" => Mark::Superscript,
            "link" => Mark::Link {
                href: attr("href")?,
            },
            "textStyle" => Mark::text_style(attr("color"), attr("fontFamily"), attr("fontSize"))?,
            "highlight" => Mark::Highlight {
                color: attr("color"),
            },
            other => {
                lossy.add(&format!("mark:{other}"));
                return None;
            }
        })
    }
}

/// Ordre canonique, fusion des `textStyle`, suppression des doublons.
pub fn canon_marks(marks: Vec<Mark>) -> Vec<Mark> {
    let mut out: Vec<Mark> = Vec::with_capacity(marks.len());
    for m in marks {
        match &m {
            Mark::TextStyle {
                color,
                font_family,
                font_size,
            } => {
                if let Some(Mark::TextStyle {
                    color: c,
                    font_family: f,
                    font_size: s,
                }) = out.iter_mut().find(|x| matches!(x, Mark::TextStyle { .. }))
                {
                    if c.is_none() {
                        *c = color.clone();
                    }
                    if f.is_none() {
                        *f = font_family.clone();
                    }
                    if s.is_none() {
                        *s = font_size.clone();
                    }
                } else {
                    out.push(m);
                }
            }
            Mark::Link { .. } | Mark::Highlight { .. } => {
                if !out.iter().any(|x| x.rank() == m.rank()) {
                    out.push(m);
                }
            }
            _ => {
                if !out.contains(&m) {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by_key(Mark::rank);
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub src: String,
    pub alt: Option<String>,
    pub title: Option<String>,
    /// Largeur d'affichage en pixels, si différente de la taille naturelle.
    pub width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text { text: String, marks: Vec<Mark> },
    HardBreak,
    Image(Image),
}

impl Inline {
    pub fn text(t: impl Into<String>) -> Inline {
        Inline::Text {
            text: t.into(),
            marks: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskItem {
    pub checked: bool,
    pub content: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub header: bool,
    pub colspan: u32,
    pub rowspan: u32,
    pub content: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph {
        align: Option<Align>,
        content: Vec<Inline>,
    },
    Heading {
        level: u8,
        align: Option<Align>,
        content: Vec<Inline>,
    },
    BulletList(Vec<Vec<Block>>),
    OrderedList {
        start: u32,
        items: Vec<Vec<Block>>,
    },
    TaskList(Vec<TaskItem>),
    Blockquote(Vec<Block>),
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    HorizontalRule,
    Table(Vec<Vec<Cell>>),
}

impl Block {
    pub fn para(content: Vec<Inline>) -> Block {
        Block::Paragraph {
            align: None,
            content,
        }
    }

    pub fn empty_para() -> Block {
        Block::para(vec![])
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RichTree {
    pub blocks: Vec<Block>,
}

// ---------------------------------------------------------------------------
// Texte brut / normalisation
// ---------------------------------------------------------------------------

pub fn inlines_text(content: &[Inline]) -> String {
    let mut s = String::new();
    for i in content {
        match i {
            Inline::Text { text, .. } => s.push_str(text),
            Inline::HardBreak => s.push('\n'),
            Inline::Image(img) => {
                if let Some(a) = &img.alt {
                    s.push_str(a);
                }
            }
        }
    }
    s
}

pub fn blocks_text(blocks: &[Block]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for b in blocks {
        match b {
            Block::Paragraph { content, .. } | Block::Heading { content, .. } => {
                parts.push(inlines_text(content))
            }
            Block::BulletList(items) | Block::OrderedList { items, .. } => {
                for it in items {
                    parts.push(blocks_text(it));
                }
            }
            Block::TaskList(items) => {
                for it in items {
                    parts.push(blocks_text(&it.content));
                }
            }
            Block::Blockquote(c) => parts.push(blocks_text(c)),
            Block::CodeBlock { text, .. } => parts.push(text.clone()),
            Block::HorizontalRule => {}
            Block::Table(rows) => {
                for r in rows {
                    let cells: Vec<String> = r.iter().map(|c| blocks_text(&c.content)).collect();
                    parts.push(cells.join("\t"));
                }
            }
        }
    }
    parts.join("\n")
}

fn norm_inlines(content: &mut Vec<Inline>) {
    let old = std::mem::take(content);
    for i in old {
        match i {
            Inline::Text { text, marks } => {
                if text.is_empty() {
                    continue;
                }
                let marks = canon_marks(marks);
                if let Some(Inline::Text {
                    text: prev,
                    marks: pm,
                }) = content.last_mut()
                {
                    if *pm == marks {
                        prev.push_str(&text);
                        continue;
                    }
                }
                content.push(Inline::Text { text, marks });
            }
            other => content.push(other),
        }
    }
}

fn norm_blocks(blocks: &mut Vec<Block>, in_cell: bool, lossy: &mut Lossy) {
    let old = std::mem::take(blocks);
    for mut b in old {
        match &mut b {
            Block::Paragraph { content, .. } => norm_inlines(content),
            Block::Heading { level, content, .. } => {
                *level = (*level).clamp(1, 6);
                norm_inlines(content);
            }
            Block::BulletList(items) | Block::OrderedList { items, .. } => {
                for it in items.iter_mut() {
                    norm_blocks(it, in_cell, lossy);
                    if it.is_empty() {
                        it.push(Block::empty_para());
                    }
                }
                if items.is_empty() {
                    continue;
                }
            }
            Block::TaskList(items) => {
                for it in items.iter_mut() {
                    norm_blocks(&mut it.content, in_cell, lossy);
                    if it.content.is_empty() {
                        it.content.push(Block::empty_para());
                    }
                }
                if items.is_empty() {
                    continue;
                }
            }
            Block::Blockquote(c) => {
                norm_blocks(c, in_cell, lossy);
                if c.is_empty() {
                    c.push(Block::empty_para());
                }
            }
            Block::CodeBlock { language, .. } => {
                if language.as_deref() == Some("") {
                    *language = None;
                }
            }
            Block::HorizontalRule => {}
            Block::Table(rows) => {
                if in_cell {
                    lossy.add("nested_tables");
                    for line in blocks_text(std::slice::from_ref(&b)).split('\n') {
                        blocks.push(Block::para(vec![Inline::text(line)]));
                    }
                    continue;
                }
                for r in rows.iter_mut() {
                    for c in r.iter_mut() {
                        c.colspan = c.colspan.clamp(1, 1000);
                        c.rowspan = c.rowspan.clamp(1, 1000);
                        norm_blocks(&mut c.content, true, lossy);
                        if c.content.is_empty() {
                            c.content.push(Block::empty_para());
                        }
                    }
                }
                rows.retain(|r| !r.is_empty());
                if rows.is_empty() {
                    continue;
                }
            }
        }
        blocks.push(b);
    }
}

// ---------------------------------------------------------------------------
// Tâches <-> puces avec case à cocher (formats sans liste de tâches native)
// ---------------------------------------------------------------------------

const BALLOT_OFF: &str = "\u{2610} ";
const BALLOT_ON: &str = "\u{2611} ";

fn prefix_item(content: &mut Vec<Block>, checked: bool) {
    let p = if checked { BALLOT_ON } else { BALLOT_OFF };
    match content.first_mut() {
        Some(Block::Paragraph { content: c, .. }) => c.insert(0, Inline::text(p)),
        _ => content.insert(0, Block::para(vec![Inline::text(p)])),
    }
}

fn ballot_of(content: &[Block]) -> Option<bool> {
    if let Some(Block::Paragraph { content: c, .. }) = content.first() {
        if let Some(Inline::Text { text, .. }) = c.first() {
            if text.starts_with(BALLOT_OFF) {
                return Some(false);
            }
            if text.starts_with(BALLOT_ON) {
                return Some(true);
            }
        }
    }
    None
}

fn strip_ballot(content: &mut [Block]) {
    if let Some(Block::Paragraph { content: c, .. }) = content.first_mut() {
        if let Some(Inline::Text { text, .. }) = c.first_mut() {
            let n = BALLOT_OFF.len();
            if text.len() >= n {
                text.drain(..n);
            }
        }
    }
}

impl RichTree {
    /// Remplace les listes de tâches par des puces préfixées « ☐ / ☑ ».
    pub fn lower_tasks(&mut self) {
        fn walk(blocks: &mut [Block]) {
            for b in blocks.iter_mut() {
                match b {
                    Block::TaskList(items) => {
                        let items = std::mem::take(items);
                        let lowered: Vec<Vec<Block>> = items
                            .into_iter()
                            .map(|mut it| {
                                walk(&mut it.content);
                                prefix_item(&mut it.content, it.checked);
                                it.content
                            })
                            .collect();
                        *b = Block::BulletList(lowered);
                    }
                    Block::BulletList(items) | Block::OrderedList { items, .. } => {
                        items.iter_mut().for_each(|i| walk(i));
                    }
                    Block::Blockquote(c) => walk(c),
                    Block::Table(rows) => {
                        rows.iter_mut().flatten().for_each(|c| walk(&mut c.content))
                    }
                    _ => {}
                }
            }
        }
        walk(&mut self.blocks);
    }

    /// Inverse de `lower_tasks` : une liste à puces dont tous les items commencent par ☐/☑.
    pub fn raise_tasks(&mut self) {
        fn walk(blocks: &mut [Block]) {
            for b in blocks.iter_mut() {
                match b {
                    Block::BulletList(items) => {
                        items.iter_mut().for_each(|i| walk(i));
                        if !items.is_empty() && items.iter().all(|i| ballot_of(i).is_some()) {
                            let items = std::mem::take(items);
                            let tasks = items
                                .into_iter()
                                .map(|mut content| {
                                    let checked = ballot_of(&content).unwrap_or(false);
                                    strip_ballot(&mut content);
                                    TaskItem { checked, content }
                                })
                                .collect();
                            *b = Block::TaskList(tasks);
                        }
                    }
                    Block::OrderedList { items, .. } => items.iter_mut().for_each(|i| walk(i)),
                    Block::TaskList(items) => items.iter_mut().for_each(|i| walk(&mut i.content)),
                    Block::Blockquote(c) => walk(c),
                    Block::Table(rows) => {
                        rows.iter_mut().flatten().for_each(|c| walk(&mut c.content))
                    }
                    _ => {}
                }
            }
        }
        walk(&mut self.blocks);
    }

    /// Normalise l'arbre et produit le `RichDoc` (modèle échangé avec le front).
    pub fn into_rich(mut self, meta: RichMeta, mut lossy: Lossy) -> RichDoc {
        norm_blocks(&mut self.blocks, false, &mut lossy);
        RichDoc {
            doc: self.to_json(),
            meta,
            lossy: lossy.into_vec(),
        }
    }

    /// Arbre d'un `RichDoc` (JSON TipTap), normalisé.
    pub fn from_rich(rich: &RichDoc) -> RichTree {
        let mut lossy = Lossy::default();
        RichTree::from_json(&rich.doc, &mut lossy)
    }
}

// ---------------------------------------------------------------------------
// Arbre -> JSON TipTap
// ---------------------------------------------------------------------------

fn node(ty: &str, attrs: Map<String, Value>, content: Option<Vec<Value>>) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!(ty));
    if !attrs.is_empty() {
        m.insert("attrs".into(), Value::Object(attrs));
    }
    if let Some(c) = content {
        m.insert("content".into(), Value::Array(c));
    }
    Value::Object(m)
}

fn attrs_of(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn inline_json(i: &Inline) -> Value {
    match i {
        Inline::Text { text, marks } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("text"));
            m.insert("text".into(), json!(text));
            if !marks.is_empty() {
                m.insert(
                    "marks".into(),
                    Value::Array(marks.iter().map(Mark::to_json).collect()),
                );
            }
            Value::Object(m)
        }
        Inline::HardBreak => node("hardBreak", Map::new(), None),
        Inline::Image(img) => {
            let mut a = Map::new();
            a.insert("src".into(), json!(img.src));
            if let Some(v) = &img.alt {
                a.insert("alt".into(), json!(v));
            }
            if let Some(v) = &img.title {
                a.insert("title".into(), json!(v));
            }
            if let Some(w) = img.width {
                a.insert("width".into(), json!(w));
            }
            node("image", a, None)
        }
    }
}

fn inlines_json(c: &[Inline]) -> Option<Vec<Value>> {
    if c.is_empty() {
        None
    } else {
        Some(c.iter().map(inline_json).collect())
    }
}

fn align_attrs(mut a: Map<String, Value>, align: Option<Align>) -> Map<String, Value> {
    if let Some(al) = align {
        a.insert("textAlign".into(), json!(al.css()));
    }
    a
}

fn items_json(ty: &str, items: &[Vec<Block>]) -> Vec<Value> {
    items
        .iter()
        .map(|it| node(ty, Map::new(), Some(blocks_json(it))))
        .collect()
}

fn blocks_json(blocks: &[Block]) -> Vec<Value> {
    blocks.iter().map(block_json).collect()
}

fn block_json(b: &Block) -> Value {
    match b {
        Block::Paragraph { align, content } => node(
            "paragraph",
            align_attrs(Map::new(), *align),
            inlines_json(content),
        ),
        Block::Heading {
            level,
            align,
            content,
        } => node(
            "heading",
            align_attrs(attrs_of(vec![("level", json!(level))]), *align),
            inlines_json(content),
        ),
        Block::BulletList(items) => node(
            "bulletList",
            Map::new(),
            Some(items_json("listItem", items)),
        ),
        Block::OrderedList { start, items } => node(
            "orderedList",
            attrs_of(vec![("start", json!(start))]),
            Some(items_json("listItem", items)),
        ),
        Block::TaskList(items) => node(
            "taskList",
            Map::new(),
            Some(
                items
                    .iter()
                    .map(|it| {
                        node(
                            "taskItem",
                            attrs_of(vec![("checked", json!(it.checked))]),
                            Some(blocks_json(&it.content)),
                        )
                    })
                    .collect(),
            ),
        ),
        Block::Blockquote(c) => node("blockquote", Map::new(), Some(blocks_json(c))),
        Block::CodeBlock { language, text } => {
            let attrs = match language {
                Some(l) => attrs_of(vec![("language", json!(l))]),
                None => Map::new(),
            };
            let content = if text.is_empty() {
                None
            } else {
                Some(vec![json!({ "type": "text", "text": text })])
            };
            node("codeBlock", attrs, content)
        }
        Block::HorizontalRule => node("horizontalRule", Map::new(), None),
        Block::Table(rows) => node(
            "table",
            Map::new(),
            Some(
                rows.iter()
                    .map(|r| {
                        node(
                            "tableRow",
                            Map::new(),
                            Some(
                                r.iter()
                                    .map(|c| {
                                        node(
                                            if c.header { "tableHeader" } else { "tableCell" },
                                            attrs_of(vec![
                                                ("colspan", json!(c.colspan)),
                                                ("rowspan", json!(c.rowspan)),
                                            ]),
                                            Some(blocks_json(&c.content)),
                                        )
                                    })
                                    .collect(),
                            ),
                        )
                    })
                    .collect(),
            ),
        ),
    }
}

impl RichTree {
    pub fn to_json(&self) -> Value {
        let mut content = blocks_json(&self.blocks);
        if content.is_empty() {
            content.push(block_json(&Block::empty_para()));
        }
        node("doc", Map::new(), Some(content))
    }
}

// ---------------------------------------------------------------------------
// JSON TipTap -> arbre (tolérant)
// ---------------------------------------------------------------------------

fn children(v: &Value) -> &[Value] {
    v.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn attr_str(v: &Value, k: &str) -> Option<String> {
    v.get("attrs")?
        .get(k)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn attr_u32(v: &Value, k: &str) -> Option<u32> {
    let a = v.get("attrs")?.get(k)?;
    if let Some(n) = a.as_u64() {
        return u32::try_from(n).ok();
    }
    if let Some(f) = a.as_f64() {
        return (f >= 0.0 && f < u32::MAX as f64).then_some(f as u32);
    }
    let s = a.as_str()?.trim().trim_end_matches("px");
    s.parse::<f64>()
        .ok()
        .filter(|f| *f >= 0.0 && *f < u32::MAX as f64)
        .map(|f| f as u32)
}

fn align_of(v: &Value) -> Option<Align> {
    attr_str(v, "textAlign").and_then(|s| Align::from_css(&s))
}

fn node_type(v: &Value) -> &str {
    v.get("type").and_then(Value::as_str).unwrap_or("")
}

fn image_of(v: &Value) -> Option<Image> {
    Some(Image {
        src: attr_str(v, "src")?,
        alt: attr_str(v, "alt"),
        title: attr_str(v, "title"),
        width: attr_u32(v, "width").filter(|w| *w > 0),
    })
}

fn parse_inlines(nodes: &[Value], marks: &[Mark], depth: usize, lossy: &mut Lossy) -> Vec<Inline> {
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        lossy.add("depth");
        return out;
    }
    for n in nodes {
        match node_type(n) {
            "text" => {
                let mut ms: Vec<Mark> = marks.to_vec();
                if let Some(arr) = n.get("marks").and_then(Value::as_array) {
                    ms.extend(arr.iter().filter_map(|m| Mark::from_json(m, lossy)));
                }
                if let Some(t) = n.get("text").and_then(Value::as_str) {
                    out.push(Inline::Text {
                        text: t.to_string(),
                        marks: ms,
                    });
                }
            }
            "hardBreak" => out.push(Inline::HardBreak),
            "image" => match image_of(n) {
                Some(i) => out.push(Inline::Image(i)),
                None => lossy.add("node:image"),
            },
            other => {
                if !children(n).is_empty() {
                    // Nœud inconnu ou bloc inattendu : on aplatit son contenu inline.
                    if !matches!(other, "paragraph" | "heading") {
                        lossy.add(&format!("node:{other}"));
                    }
                    if !out.is_empty() && matches!(other, "paragraph" | "heading") {
                        out.push(Inline::HardBreak);
                    }
                    out.extend(parse_inlines(children(n), marks, depth + 1, lossy));
                } else if let Some(t) = n.get("text").and_then(Value::as_str) {
                    out.push(Inline::text(t));
                } else if !other.is_empty() && !matches!(other, "paragraph" | "heading") {
                    lossy.add(&format!("node:{other}"));
                }
            }
        }
    }
    out
}

fn parse_blocks(nodes: &[Value], depth: usize, lossy: &mut Lossy) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    if depth > MAX_DEPTH {
        lossy.add("depth");
        return out;
    }
    let mut pending: Vec<Value> = Vec::new();
    let flush = |pending: &mut Vec<Value>, out: &mut Vec<Block>, lossy: &mut Lossy| {
        if !pending.is_empty() {
            let c = parse_inlines(pending, &[], depth + 1, lossy);
            out.push(Block::para(c));
            pending.clear();
        }
    };
    for n in nodes {
        let ty = node_type(n);
        if matches!(ty, "text" | "hardBreak" | "image") {
            pending.push(n.clone());
            continue;
        }
        flush(&mut pending, &mut out, lossy);
        match ty {
            "paragraph" => out.push(Block::Paragraph {
                align: align_of(n),
                content: parse_inlines(children(n), &[], depth + 1, lossy),
            }),
            "heading" => out.push(Block::Heading {
                level: attr_u32(n, "level").unwrap_or(1).clamp(1, 6) as u8,
                align: align_of(n),
                content: parse_inlines(children(n), &[], depth + 1, lossy),
            }),
            "bulletList" => out.push(Block::BulletList(parse_items(n, depth, lossy))),
            "orderedList" => out.push(Block::OrderedList {
                start: attr_u32(n, "start").unwrap_or(1),
                items: parse_items(n, depth, lossy),
            }),
            "taskList" => {
                let items = children(n)
                    .iter()
                    .map(|it| TaskItem {
                        checked: it
                            .get("attrs")
                            .and_then(|a| a.get("checked"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        content: parse_blocks(children(it), depth + 1, lossy),
                    })
                    .collect();
                out.push(Block::TaskList(items));
            }
            "blockquote" => out.push(Block::Blockquote(parse_blocks(
                children(n),
                depth + 1,
                lossy,
            ))),
            "codeBlock" => {
                let mut text = String::new();
                for c in children(n) {
                    match node_type(c) {
                        "hardBreak" => text.push('\n'),
                        _ => {
                            if let Some(t) = c.get("text").and_then(Value::as_str) {
                                text.push_str(t);
                            }
                        }
                    }
                }
                out.push(Block::CodeBlock {
                    language: attr_str(n, "language"),
                    text,
                });
            }
            "horizontalRule" => out.push(Block::HorizontalRule),
            "table" => {
                let rows = children(n)
                    .iter()
                    .map(|r| {
                        children(r)
                            .iter()
                            .map(|c| Cell {
                                header: node_type(c) == "tableHeader",
                                colspan: attr_u32(c, "colspan").unwrap_or(1).max(1),
                                rowspan: attr_u32(c, "rowspan").unwrap_or(1).max(1),
                                content: parse_blocks(children(c), depth + 1, lossy),
                            })
                            .collect()
                    })
                    .collect();
                out.push(Block::Table(rows));
            }
            other => {
                // listItem/taskItem/tableRow/… hors contexte, ou nœud inconnu : on aplatit.
                if !matches!(
                    other,
                    "listItem" | "taskItem" | "tableRow" | "tableCell" | "tableHeader"
                ) {
                    lossy.add(&format!("node:{other}"));
                }
                if !children(n).is_empty() {
                    out.extend(parse_blocks(children(n), depth + 1, lossy));
                } else if let Some(t) = n.get("text").and_then(Value::as_str) {
                    out.push(Block::para(vec![Inline::text(t)]));
                }
            }
        }
    }
    flush(&mut pending, &mut out, lossy);
    out
}

fn parse_items(list: &Value, depth: usize, lossy: &mut Lossy) -> Vec<Vec<Block>> {
    children(list)
        .iter()
        .map(|it| {
            if matches!(node_type(it), "listItem" | "taskItem") {
                parse_blocks(children(it), depth + 1, lossy)
            } else {
                parse_blocks(std::slice::from_ref(it), depth + 1, lossy)
            }
        })
        .collect()
}

impl RichTree {
    /// Lit un document TipTap. Les nœuds inconnus sont aplatis et signalés dans `lossy`.
    pub fn from_json(v: &Value, lossy: &mut Lossy) -> RichTree {
        let mut tree = if node_type(v) == "doc" {
            RichTree {
                blocks: parse_blocks(children(v), 0, lossy),
            }
        } else if let Some(arr) = v.as_array() {
            RichTree {
                blocks: parse_blocks(arr, 0, lossy),
            }
        } else {
            RichTree {
                blocks: parse_blocks(std::slice::from_ref(v), 0, lossy),
            }
        };
        norm_blocks(&mut tree.blocks, false, lossy);
        tree
    }
}

// ---------------------------------------------------------------------------
// Document de référence pour les tests aller-retour
// ---------------------------------------------------------------------------

#[cfg(test)]
pub mod testutil {
    use super::*;

    /// PNG 1x1 rouge.
    pub const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    pub fn t(s: &str) -> Inline {
        Inline::text(s)
    }

    pub fn tm(s: &str, marks: Vec<Mark>) -> Inline {
        Inline::Text {
            text: s.into(),
            marks,
        }
    }

    pub fn p(c: Vec<Inline>) -> Block {
        Block::para(c)
    }

    pub fn item(s: &str) -> Vec<Block> {
        vec![p(vec![t(s)])]
    }

    pub fn cell(header: bool, s: &str) -> Cell {
        Cell {
            header,
            colspan: 1,
            rowspan: 1,
            content: vec![p(vec![t(s)])],
        }
    }

    pub fn png_uri() -> String {
        crate::formats::richtext::util::make_data_uri("image/png", PNG_1X1)
    }

    /// Document couvrant tout le schéma (hors spécificités limitées à un format).
    /// `rich` : marques/attributs que seuls docx/odt/html conservent (couleurs, alignement,
    /// colspan, en-têtes mixtes, tâches imbriquées…).
    pub fn reference(rich: bool) -> RichTree {
        let mut blocks = vec![
            Block::Heading {
                level: 1,
                align: None,
                content: vec![t("Titre principal")],
            },
            Block::Heading {
                level: 2,
                align: if rich { Some(Align::Center) } else { None },
                content: vec![t("Sous-titre")],
            },
            Block::Heading {
                level: 3,
                align: None,
                content: vec![t("Niveau 3")],
            },
            p(vec![
                t("Texte "),
                tm("gras", vec![Mark::Bold]),
                t(" "),
                tm("italique", vec![Mark::Italic]),
                t(" "),
                tm("gras italique", vec![Mark::Bold, Mark::Italic]),
                t(" "),
                tm("souligné", vec![Mark::Underline]),
                t(" "),
                tm("barré", vec![Mark::Strike]),
                t(" "),
                tm("code", vec![Mark::Code]),
                t(" H"),
                tm("2", vec![Mark::Subscript]),
                t("O x"),
                tm("2", vec![Mark::Superscript]),
                t(" "),
                tm(
                    "surligné",
                    vec![Mark::Highlight {
                        color: Some("#ffff00".into()),
                    }],
                ),
                t("."),
            ]),
            p(vec![
                t("Un "),
                tm(
                    "lien",
                    vec![Mark::Link {
                        href: "https://example.com/a?b=1&c=2".into(),
                    }],
                ),
                t(" puis "),
                tm(
                    "lien gras",
                    vec![
                        Mark::Link {
                            href: "https://example.org/".into(),
                        },
                        Mark::Bold,
                    ],
                ),
                Inline::HardBreak,
                t("ligne après saut"),
            ]),
            Block::BulletList(vec![
                item("Puce un"),
                vec![
                    p(vec![t("Puce deux")]),
                    Block::OrderedList {
                        start: 1,
                        items: vec![item("Imbriquée a"), item("Imbriquée b")],
                    },
                ],
                item("Puce trois"),
            ]),
            Block::OrderedList {
                start: 3,
                items: vec![
                    item("Trois"),
                    vec![
                        p(vec![t("Quatre")]),
                        Block::BulletList(vec![item("sous-puce")]),
                    ],
                ],
            },
            Block::TaskList(vec![
                TaskItem {
                    checked: true,
                    content: item("Fait"),
                },
                TaskItem {
                    checked: false,
                    content: item("À faire"),
                },
            ]),
            Block::Blockquote(vec![p(vec![
                t("Une citation "),
                tm("importante", vec![Mark::Italic]),
            ])]),
            Block::CodeBlock {
                language: Some("rust".into()),
                text: "fn main() {\n    println!(\"<salut> & ok\");\n}".into(),
            },
            Block::HorizontalRule,
            Block::Table(vec![
                vec![cell(true, "Nom"), cell(true, "Valeur")],
                vec![cell(false, "alpha"), cell(false, "1")],
                vec![cell(false, "bêta"), cell(false, "2")],
            ]),
            p(vec![
                t("Image : "),
                Inline::Image(Image {
                    src: png_uri(),
                    alt: Some("pixel".into()),
                    title: if rich { Some("Un pixel".into()) } else { None },
                    width: None,
                }),
            ]),
        ];
        if rich {
            blocks.push(Block::Paragraph {
                align: Some(Align::Right),
                content: vec![
                    tm(
                        "coloré",
                        vec![Mark::TextStyle {
                            color: Some("#ff0000".into()),
                            font_family: Some("Georgia".into()),
                            font_size: Some("14pt".into()),
                        }],
                    ),
                    t(" "),
                    tm("fin", vec![Mark::Bold]),
                ],
            });
            blocks.push(Block::Paragraph {
                align: Some(Align::Justify),
                content: vec![t("Justifié.")],
            });
            blocks.push(Block::Table(vec![
                vec![
                    Cell {
                        header: false,
                        colspan: 2,
                        rowspan: 1,
                        content: vec![p(vec![t("large")])],
                    },
                    Cell {
                        header: false,
                        colspan: 1,
                        rowspan: 2,
                        content: vec![p(vec![t("haut")])],
                    },
                ],
                vec![cell(false, "x"), cell(false, "y")],
            ]));
            blocks.push(p(vec![t("Fin.")]));
        }
        RichTree { blocks }
    }

    /// Passage par `into_rich` pour comparer des arbres normalisés.
    pub fn normalized(tree: RichTree) -> Value {
        tree.into_rich(RichMeta::default(), Lossy::default()).doc
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn json_roundtrip_of_reference() {
        for rich in [false, true] {
            let tree = reference(rich);
            let json = normalized(tree.clone());
            let mut lossy = Lossy::default();
            let back = RichTree::from_json(&json, &mut lossy);
            assert!(lossy.into_vec().is_empty());
            assert_eq!(back.to_json(), json);
        }
    }

    #[test]
    fn json_shape_matches_tiptap() {
        let json = normalized(reference(false));
        let first = &json["content"][0];
        assert_eq!(first["type"], "heading");
        assert_eq!(first["attrs"]["level"], 1);
        assert_eq!(first["content"][0]["text"], "Titre principal");
        let text = &json["content"][3]["content"][1];
        assert_eq!(text["marks"][0]["type"], "bold");
    }

    #[test]
    fn unknown_nodes_are_flattened_and_reported() {
        let v = json!({"type":"doc","content":[
            {"type":"callout","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]},
            {"type":"paragraph","content":[
                {"type":"text","text":"a","marks":[{"type":"wiggle"}]},
                {"type":"mention","attrs":{"id":"1"}}
            ]}
        ]});
        let mut lossy = Lossy::default();
        let tree = RichTree::from_json(&v, &mut lossy);
        assert_eq!(tree.blocks.len(), 2);
        let l = lossy.into_vec();
        assert!(l.contains(&"node:callout".to_string()));
        assert!(l.contains(&"mark:wiggle".to_string()));
        assert!(l.contains(&"node:mention".to_string()));
    }

    #[test]
    fn merges_adjacent_text_and_nested_tables_flatten() {
        let tree = RichTree {
            blocks: vec![Block::Table(vec![vec![Cell {
                header: false,
                colspan: 1,
                rowspan: 1,
                content: vec![Block::Table(vec![vec![cell(false, "i")]])],
            }]])],
        };
        let mut lossy = Lossy::default();
        let doc = tree.into_rich(RichMeta::default(), Lossy::default());
        let _ = &mut lossy;
        assert!(doc.doc.to_string().contains("\"i\""));
        let mut c = vec![t("a"), t("b")];
        norm_inlines(&mut c);
        assert_eq!(c, vec![t("ab")]);
    }

    #[test]
    fn tasks_lower_and_raise() {
        let mut tree = reference(false);
        let orig = normalized(tree.clone());
        tree.lower_tasks();
        assert!(!format!("{:?}", tree).contains("TaskList"));
        tree.raise_tasks();
        assert_eq!(normalized(tree), orig);
    }
}
