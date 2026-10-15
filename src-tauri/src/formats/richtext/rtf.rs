//! RTF (lecture seule) : parseur maison borné. Groupes, styles de caractères, paragraphes,
//! couleurs, Unicode (`\uN`/`\ucN`), pages de code (`\ansicpg`, `\fcharsetN`).

use std::collections::HashMap;
use std::path::Path;

use super::tree::{Align, Block, Inline, Lossy, Mark, RichTree};
use super::util::format_pt;
use super::{read_limited, rich_of};
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_DEPTH;
use crate::core::model::{DocumentModel, ModelKind, RichDoc, RichMeta};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub struct RtfHandler;

impl FormatHandler for RtfHandler {
    fn id(&self) -> &'static str {
        "rtf"
    }

    fn model(&self) -> ModelKind {
        ModelKind::RichText
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["rtf"]
    }

    fn label_key(&self) -> &'static str {
        "formats.rtf"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        if probe.head.starts_with(b"{\\rtf") {
            Some(Confidence(90))
        } else if probe.ext == "rtf" {
            Some(Confidence(60))
        } else {
            None
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: ["docx", "odt", "markdown-rich", "html"]
                .map(String::from)
                .to_vec(),
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        Ok(DocumentModel::RichText(parse(&read_limited(path)?)?))
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        super::export_rich(rich_of(doc)?, target, path)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Dest {
    Body,
    Info,
    Title,
    Author,
    FontTbl,
    ColorTbl,
    Skip,
}

#[derive(Clone)]
struct State {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    vert: i8,
    color: usize,
    highlight: usize,
    font: Option<i32>,
    size: Option<i32>,
    align: Option<Align>,
    uc: usize,
    dest: Dest,
}

impl Default for State {
    fn default() -> Self {
        State {
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            vert: 0,
            color: 0,
            highlight: 0,
            font: None,
            size: None,
            align: None,
            uc: 1,
            dest: Dest::Body,
        }
    }
}

fn cp_encoding(cp: u32) -> &'static encoding_rs::Encoding {
    let label = match cp {
        932 => "shift_jis".to_string(),
        936 => "gbk".to_string(),
        949 => "euc-kr".to_string(),
        950 => "big5".to_string(),
        10000 => "macintosh".to_string(),
        65001 => "utf-8".to_string(),
        874 => "windows-874".to_string(),
        c => format!("windows-{c}"),
    };
    encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252)
}

fn charset_cp(charset: i32) -> Option<u32> {
    Some(match charset {
        77 => 10000,
        128 => 932,
        129 => 949,
        134 => 936,
        136 => 950,
        161 => 1253,
        162 => 1254,
        163 => 1258,
        177 => 1255,
        178 => 1256,
        186 => 1257,
        204 => 1251,
        222 => 874,
        238 => 1250,
        _ => return None,
    })
}

struct Parser {
    ansi_cp: u32,
    default_font: Option<i32>,
    font_charset: HashMap<i32, u32>,
    font_names: HashMap<i32, String>,
    cur_font_def: i32,
    font_buf: String,
    colors: Vec<Option<String>>,
    color_rgb: [Option<u8>; 3],
    pending: Vec<u8>,
    pending_hi: Option<u16>,
    skip: usize,
    runs: Vec<Inline>,
    blocks: Vec<Block>,
    title: String,
    author: String,
    lossy: Lossy,
}

impl Parser {
    fn marks(&self, st: &State) -> Vec<Mark> {
        let mut m = Vec::new();
        if st.bold {
            m.push(Mark::Bold);
        }
        if st.italic {
            m.push(Mark::Italic);
        }
        if st.underline {
            m.push(Mark::Underline);
        }
        if st.strike {
            m.push(Mark::Strike);
        }
        let color = self.colors.get(st.color).cloned().flatten();
        let font = match (st.font, self.default_font) {
            (Some(f), d) if Some(f) != d => self.font_names.get(&f).cloned(),
            _ => None,
        };
        let size = st.size.map(|h| format_pt(h as f32 / 2.0));
        if let Some(ts) = Mark::text_style(color, font, size) {
            m.push(ts);
        }
        if st.highlight > 0 {
            if let Some(c) = self.colors.get(st.highlight).cloned().flatten() {
                m.push(Mark::Highlight { color: Some(c) });
            }
        }
        match st.vert {
            1 => m.push(Mark::Superscript),
            -1 => m.push(Mark::Subscript),
            _ => {}
        }
        m
    }

    fn push_text(&mut self, st: &State, text: String) {
        if text.is_empty() {
            return;
        }
        match st.dest {
            Dest::Body => {
                let marks = self.marks(st);
                self.runs.push(Inline::Text { text, marks });
            }
            Dest::Title => self.title.push_str(&text),
            Dest::Author => self.author.push_str(&text),
            Dest::FontTbl => self.font_buf.push_str(&text),
            _ => {}
        }
    }

    fn flush(&mut self, st: &State) {
        if self.pending.is_empty() {
            return;
        }
        let cp = st
            .font
            .and_then(|f| self.font_charset.get(&f).copied())
            .unwrap_or(self.ansi_cp);
        let bytes = std::mem::take(&mut self.pending);
        let (s, _) = cp_encoding(cp).decode_without_bom_handling(&bytes);
        self.push_text(st, s.into_owned());
    }

    fn end_paragraph(&mut self, st: &State) {
        self.flush(st);
        let content = std::mem::take(&mut self.runs);
        self.blocks.push(Block::Paragraph {
            align: st.align,
            content,
        });
    }

    fn unicode(&mut self, st: &State, v: i32) {
        let u = (v & 0xFFFF) as u16;
        let ch = if (0xD800..0xDC00).contains(&u) {
            self.pending_hi = Some(u);
            return;
        } else if (0xDC00..0xE000).contains(&u) {
            match self.pending_hi.take() {
                Some(hi) => char::decode_utf16([hi, u]).next().and_then(|r| r.ok()),
                None => None,
            }
        } else {
            char::from_u32(u32::from(u))
        };
        if let Some(c) = ch {
            self.push_text(st, c.to_string());
        }
    }

    fn color_entry(&mut self) {
        let c = match self.color_rgb {
            [None, None, None] => None,
            [r, g, b] => Some(format!(
                "#{:02x}{:02x}{:02x}",
                r.unwrap_or(0),
                g.unwrap_or(0),
                b.unwrap_or(0)
            )),
        };
        if self.colors.len() < 4096 {
            self.colors.push(c);
        }
        self.color_rgb = [None, None, None];
    }

    /// Détermine la destination d'un groupe d'après son premier mot de contrôle.
    fn destination(&mut self, word: &str, st: &mut State) {
        let parent = st.dest;
        st.dest = match word {
            "fonttbl" => Dest::FontTbl,
            "colortbl" => Dest::ColorTbl,
            "info" => Dest::Info,
            "title" if parent == Dest::Info => Dest::Title,
            "author" if parent == Dest::Info => Dest::Author,
            _ if parent == Dest::Info => Dest::Skip,
            "stylesheet" | "listtable" | "listoverridetable" | "revtbl" | "rsidtbl"
            | "generator" | "themedata" | "colorschememapping" | "datastore" | "latentstyles"
            | "xmlnstbl" | "mmathpr" | "pgdsctbl" | "private" | "fldinst" | "nonshppict"
            | "bkmkstart" | "bkmkend" | "userprops" | "wgrffmtfilter" | "template" | "filetbl"
            | "factoidname" => Dest::Skip,
            "pict" | "shppict" | "object" | "shp" | "shpgrp" => {
                self.lossy.add("images");
                Dest::Skip
            }
            "header" | "headerl" | "headerr" | "headerf" | "footer" | "footerl" | "footerr"
            | "footerf" => {
                self.lossy.add("headers_footers");
                Dest::Skip
            }
            "footnote" => {
                self.lossy.add("footnotes");
                Dest::Skip
            }
            "pntext" | "listtext" | "pn" => {
                self.lossy.add("lists");
                Dest::Skip
            }
            "annotation" | "atnid" | "atnauthor" => {
                self.lossy.add("comments");
                Dest::Skip
            }
            _ => parent,
        };
    }
}

pub fn parse(bytes: &[u8]) -> Result<RichDoc> {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    if !bytes.get(start..).is_some_and(|b| b.starts_with(b"{\\rtf")) {
        return Err(AppError::Corrupt("signature RTF absente".into()));
    }
    let mut p = Parser {
        ansi_cp: 1252,
        default_font: None,
        font_charset: HashMap::new(),
        font_names: HashMap::new(),
        cur_font_def: 0,
        font_buf: String::new(),
        colors: Vec::new(),
        color_rgb: [None, None, None],
        pending: Vec::new(),
        pending_hi: None,
        skip: 0,
        runs: Vec::new(),
        blocks: Vec::new(),
        title: String::new(),
        author: String::new(),
        lossy: Lossy::default(),
    };
    let mut stack: Vec<State> = vec![State::default()];
    let mut i = start;
    let mut first_in_group = false;
    let mut starred = false;
    let len = bytes.len();

    while i < len {
        let b = bytes[i];
        let Some(st) = stack.last().cloned() else {
            break;
        };
        match b {
            b'{' => {
                p.flush(&st);
                if stack.len() >= MAX_DEPTH {
                    return Err(AppError::Limit("profondeur RTF".into()));
                }
                stack.push(st);
                first_in_group = true;
                starred = false;
                i += 1;
            }
            b'}' => {
                p.flush(&st);
                if st.dest == Dest::FontTbl && !p.font_buf.is_empty() {
                    let name = p.font_buf.trim().trim_end_matches(';').trim().to_string();
                    p.font_names.insert(p.cur_font_def, name);
                    p.font_buf.clear();
                }
                if stack.len() > 1 {
                    stack.pop();
                } else {
                    break;
                }
                first_in_group = false;
                i += 1;
            }
            b'\\' => {
                i += 1;
                let Some(&c) = bytes.get(i) else {
                    break;
                };
                if c.is_ascii_alphabetic() {
                    let ws = i;
                    while bytes.get(i).is_some_and(u8::is_ascii_alphabetic) {
                        i += 1;
                    }
                    let word = String::from_utf8_lossy(&bytes[ws..i]).into_owned();
                    let mut neg = false;
                    if bytes.get(i) == Some(&b'-') {
                        neg = true;
                        i += 1;
                    }
                    let ds = i;
                    while bytes.get(i).is_some_and(u8::is_ascii_digit) && i - ds < 10 {
                        i += 1;
                    }
                    let param: Option<i32> = std::str::from_utf8(&bytes[ds..i])
                        .ok()
                        .and_then(|s| s.parse::<i64>().ok())
                        .map(|v| {
                            (if neg { -v } else { v }).clamp(-2_000_000_000, 2_000_000_000) as i32
                        });
                    if bytes.get(i) == Some(&b' ') {
                        i += 1;
                    }
                    let top = stack.len() - 1;
                    if first_in_group {
                        first_in_group = false;
                        if starred {
                            stack[top].dest = Dest::Skip;
                        } else {
                            let mut s = stack[top].clone();
                            p.destination(&word.to_lowercase(), &mut s);
                            stack[top] = s;
                        }
                    }
                    let mut cur = stack[top].clone();
                    control_word(&mut p, &mut cur, &word, param);
                    stack[top] = cur;
                    // flush avant changement de style est fait dans control_word
                } else {
                    i += 1;
                    match c {
                        b'\'' => {
                            let hex = bytes
                                .get(i..i + 2)
                                .and_then(|h| std::str::from_utf8(h).ok());
                            i = (i + 2).min(len);
                            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                                if p.skip > 0 {
                                    p.skip -= 1;
                                } else if st.dest == Dest::Body || st.dest == Dest::FontTbl {
                                    p.pending.push(v);
                                }
                            }
                        }
                        b'*' => {
                            starred = true;
                            if first_in_group {
                                // la destination sera ignorée au prochain mot de contrôle
                            }
                            continue;
                        }
                        b'\\' | b'{' | b'}' => {
                            if st.dest == Dest::Body {
                                p.pending.push(c);
                            }
                        }
                        b'~' => {
                            p.flush(&st);
                            p.push_text(&st, "\u{a0}".into());
                        }
                        b'_' => {
                            p.flush(&st);
                            p.push_text(&st, "\u{2011}".into());
                        }
                        b'\n' | b'\r' if st.dest == Dest::Body => p.end_paragraph(&st),
                        _ => {}
                    }
                    first_in_group = false;
                }
            }
            b'\r' | b'\n' => i += 1,
            b';' if st.dest == Dest::ColorTbl => {
                p.color_entry();
                i += 1;
            }
            _ => {
                first_in_group = false;
                if p.skip > 0 {
                    p.skip -= 1;
                } else if matches!(
                    st.dest,
                    Dest::Body | Dest::FontTbl | Dest::Title | Dest::Author
                ) {
                    p.pending.push(b);
                }
                i += 1;
            }
        }
    }
    if let Some(st) = stack.last().cloned() {
        p.flush(&st);
        if !p.runs.is_empty() {
            let st = State {
                align: stack.first().and_then(|s| s.align),
                ..Default::default()
            };
            p.end_paragraph(&st);
        }
    }
    while matches!(p.blocks.last(), Some(Block::Paragraph { content, .. }) if content.is_empty()) {
        p.blocks.pop();
    }
    let meta = RichMeta {
        title: Some(p.title.trim().to_string()).filter(|s| !s.is_empty()),
        author: Some(p.author.trim().to_string()).filter(|s| !s.is_empty()),
    };
    Ok(RichTree { blocks: p.blocks }.into_rich(meta, p.lossy))
}

fn control_word(p: &mut Parser, st: &mut State, word: &str, param: Option<i32>) {
    let on = param != Some(0);
    // Mots qui changent le style ou finissent un segment de texte : on vide d'abord.
    let snapshot = st.clone();
    match st.dest {
        Dest::FontTbl => {
            match word {
                "f" => p.cur_font_def = param.unwrap_or(0),
                "fcharset" => {
                    if let Some(cp) = param.and_then(charset_cp) {
                        p.font_charset.insert(p.cur_font_def, cp);
                    }
                }
                _ => {}
            }
            return;
        }
        Dest::ColorTbl => {
            let v = param.map(|v| v.clamp(0, 255) as u8);
            match word {
                "red" => p.color_rgb[0] = v,
                "green" => p.color_rgb[1] = v,
                "blue" => p.color_rgb[2] = v,
                _ => {}
            }
            return;
        }
        Dest::Skip | Dest::Info | Dest::Title | Dest::Author => {
            if matches!(word, "par" | "line") && matches!(st.dest, Dest::Title | Dest::Author) {
                return;
            }
            if !matches!(word, "u" | "uc") {
                return;
            }
        }
        Dest::Body => {}
    }
    match word {
        "rtf" | "ansi" | "mac" | "pc" | "pca" => {}
        "ansicpg" => {
            if let Some(cp) = param {
                p.ansi_cp = cp.clamp(0, 70_000) as u32;
            }
        }
        "deff" => p.default_font = param,
        "uc" => st.uc = param.unwrap_or(1).clamp(0, 16) as usize,
        "u" => {
            p.flush(&snapshot);
            p.unicode(st, param.unwrap_or(0));
            p.skip = st.uc;
        }
        "par" | "sect" => p.end_paragraph(st),
        "row" => {
            p.lossy.add("tables");
            p.end_paragraph(st)
        }
        "cell" | "nestcell" => {
            p.lossy.add("tables");
            p.flush(&snapshot);
            p.push_text(st, "\t".into());
        }
        "trowd" => p.lossy.add("tables"),
        "line" => {
            p.flush(&snapshot);
            p.runs.push(Inline::HardBreak);
        }
        "tab" => {
            p.flush(&snapshot);
            p.push_text(st, "\t".into());
        }
        "emdash" | "endash" | "bullet" | "lquote" | "rquote" | "ldblquote" | "rdblquote"
        | "emspace" | "enspace" | "qmspace" => {
            p.flush(&snapshot);
            let c = match word {
                "emdash" => "\u{2014}",
                "endash" => "\u{2013}",
                "bullet" => "\u{2022}",
                "lquote" => "\u{2018}",
                "rquote" => "\u{2019}",
                "ldblquote" => "\u{201c}",
                "rdblquote" => "\u{201d}",
                _ => " ",
            };
            p.push_text(st, c.into());
        }
        "pard" => st.align = None,
        "ql" => st.align = None,
        "qr" => st.align = Some(Align::Right),
        "qc" => st.align = Some(Align::Center),
        "qj" => st.align = Some(Align::Justify),
        "plain" => {
            p.flush(&snapshot);
            let (align, uc, dest) = (st.align, st.uc, st.dest);
            *st = State {
                align,
                uc,
                dest,
                ..Default::default()
            };
        }
        "b" | "i" | "strike" | "striked" | "super" | "sub" | "nosupersub" | "ul" | "ulnone"
        | "uld" | "uldb" | "ulw" | "ulth" | "ulwave" | "uldash" | "uldashd" | "uldashdd"
        | "ulhwave" | "ulldash" | "cf" | "highlight" | "fs" | "f" => {
            p.flush(&snapshot);
            match word {
                "b" => st.bold = on,
                "i" => st.italic = on,
                "strike" | "striked" => st.strike = on,
                "super" => st.vert = 1,
                "sub" => st.vert = -1,
                "nosupersub" => st.vert = 0,
                "ulnone" => st.underline = false,
                "cf" => st.color = param.unwrap_or(0).max(0) as usize,
                "highlight" => st.highlight = param.unwrap_or(0).max(0) as usize,
                "fs" => st.size = param.filter(|v| *v > 0 && *v < 2000),
                "f" => st.font = param,
                _ => st.underline = on,
            }
        }
        "lang" | "langfe" | "langnp" | "langfenp" => {}
        "ls" | "ilvl" => p.lossy.add("lists"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::tree::{blocks_text, testutil::*};
    use super::*;

    const SAMPLE: &str = concat!(
        r"{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fnil\fcharset0 Calibri;}{\f1\fnil\fcharset0 Courier New;}}",
        r"{\colortbl ;\red255\green0\blue0;\red255\green255\blue0;}",
        r"{\info{\title Mon titre}{\author Moi}}",
        r"\viewkind4\uc1\pard\qc\b\fs32 Titre\b0\fs22\par",
        r"\pard Texte \b gras\b0  \i italique\i0  \ul souligne\ulnone  \strike barre\strike0  \cf1 rouge\cf0  \highlight2 jaune\highlight0 .\par",
        r"\pard\qr Caf\'e9 \u8364? et \u233? fin\line apr\'e8s\tab tab\par",
        r"{\*\generator Word;}{\header ignored}\pard\qj Justifi\'e9{\footnote note} \super 2\nosupersub\par",
        r"\pard\f1 mono\par",
        "}"
    );

    #[test]
    fn parses_sample() {
        let doc = parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(doc.meta.title.as_deref(), Some("Mon titre"));
        assert_eq!(doc.meta.author.as_deref(), Some("Moi"));
        let tree = RichTree::from_rich(&doc);
        assert_eq!(tree.blocks.len(), 5);
        let Block::Paragraph { align, content } = &tree.blocks[0] else {
            panic!("paragraphe");
        };
        assert_eq!(*align, Some(Align::Center));
        assert!(matches!(&content[0], Inline::Text { text, marks }
            if text == "Titre" && marks.contains(&Mark::Bold)));
        let Block::Paragraph { content, .. } = &tree.blocks[1] else {
            panic!("paragraphe");
        };
        let find = |t: &str| {
            content.iter().find_map(|i| match i {
                Inline::Text { text, marks } if text == t => Some(marks.clone()),
                _ => None,
            })
        };
        assert_eq!(
            find("gras"),
            Some(vec![
                Mark::Bold,
                Mark::TextStyle {
                    color: None,
                    font_family: None,
                    font_size: Some("11pt".into())
                }
            ])
        );
        assert!(find("italique").unwrap().contains(&Mark::Italic));
        assert!(find("souligne").unwrap().contains(&Mark::Underline));
        assert!(find("barre").unwrap().contains(&Mark::Strike));
        assert!(find("rouge")
            .unwrap()
            .iter()
            .any(|m| matches!(m, Mark::TextStyle { color: Some(c), .. } if c == "#ff0000")));
        assert!(find("jaune").unwrap().contains(&Mark::Highlight {
            color: Some("#ffff00".into())
        }));
        let text = blocks_text(&tree.blocks);
        assert!(text.contains("Café € et é fin\naprès\ttab"), "{text}");
        assert!(text.contains("Justifié"));
        assert!(!text.contains("ignored") && !text.contains("note") && !text.contains("Word"));
        let Block::Paragraph { align, .. } = &tree.blocks[3] else {
            panic!("paragraphe");
        };
        assert_eq!(*align, Some(Align::Justify));
        for k in ["headers_footers", "footnotes"] {
            assert!(doc.lossy.contains(&k.to_string()), "{:?}", doc.lossy);
        }
    }

    #[test]
    fn code_pages_and_unicode_skip() {
        let rtf = r"{\rtf1\ansi\ansicpg1251\deff0{\fonttbl{\f0\fcharset204 Arial;}}\uc2\f0 \'cf\'f0\'e8\'e2\'e5\'f2 \u1087?? x\par}";
        let doc = parse(rtf.as_bytes()).unwrap();
        let tree = RichTree::from_rich(&doc);
        assert_eq!(blocks_text(&tree.blocks), "Привет п x");
    }

    #[test]
    fn exports_to_other_formats() {
        let doc = parse(SAMPLE.as_bytes()).unwrap();
        let model = DocumentModel::RichText(doc);
        let dir = tempfile::tempdir().unwrap();
        let h = RtfHandler;
        for (target, name) in [
            ("docx", "a.docx"),
            ("odt", "a.odt"),
            ("markdown-rich", "a.md"),
            ("html", "a.html"),
        ] {
            let p = dir.path().join(name);
            h.export(&model, target, &p).unwrap();
            assert!(p.metadata().unwrap().len() > 100);
        }
        assert!(matches!(
            h.save(&model, &dir.path().join("x.rtf")),
            Err(AppError::ReadOnly)
        ));
        // le DOCX produit est relisible
        let back =
            super::super::docx::parse(&std::fs::read(dir.path().join("a.docx")).unwrap()).unwrap();
        assert!(blocks_text(&RichTree::from_rich(&back).blocks).contains("Texte"));
    }

    #[test]
    fn detection_and_robustness() {
        let h = RtfHandler;
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.bin", b"{\\rtf1 x}")),
            Some(Confidence(90))
        );
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.rtf", b"zzz")),
            Some(Confidence(60))
        );
        assert!(parse(b"not rtf").is_err());
        let deep = format!("{{\\rtf1{}", "{".repeat(1000));
        assert!(parse(deep.as_bytes()).is_err());
        for bytes in [
            &b"{\\rtf1\\u"[..],
            b"{\\rtf1\\'",
            b"{\\rtf1\\'z",
            b"{\\rtf1 \\",
            b"{\\rtf1\\u-99999999999 x}",
            b"{\\rtf1{\\*\\x",
        ] {
            let _ = parse(bytes);
        }
        let _ = reference(false);
    }
}
