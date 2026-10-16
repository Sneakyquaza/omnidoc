//! ods : lecture calamine, écriture maison (zip + content.xml).
//!
//! Formules : syntaxe Excel (`SUM(A1:B2)`) ↔ OpenFormula (`of:=SUM([.A1:.B2])`) pour les références
//! de cellules et plages simples (avec ou sans feuille) et le séparateur `;`. Les colonnes/lignes
//! entières (`A:A`) et les tableaux littéraux ne sont pas convertis.
//! Pertes à l'écriture : styles, largeurs de colonnes, formats de nombre (sauf dates, écrites en
//! `office:date-value`), graphiques, images, fusions.

use std::io::{Cursor, Write};
use std::path::Path;

use calamine::{open_workbook_from_rs, Ods};

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::model::{Cell, CellValue, DocumentModel, ModelKind, Workbook};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::formats::sheet::xlsx::read_sheets;
use crate::formats::sheet::{
    bytes_contain, expect_workbook, guarded_zip, is_date_fmt, iso_from_serial, read_entry,
    sanitize_sheet_names,
};

const ODS_MIMETYPE: &str = "application/vnd.oasis.opendocument.spreadsheet";
const MAX_XML_ENTRY: u64 = 256 * 1024 * 1024;
const ERRORS: [&str; 7] = [
    "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!",
];

pub struct OdsHandler;

// --- Conversion de formules ---

fn needs_quote(name: &str) -> bool {
    let ch: Vec<char> = name.chars().collect();
    ch.is_empty()
        || ch[0].is_ascii_digit()
        || !ch.iter().all(|c| c.is_alphanumeric() || *c == '_')
        || parse_cell(&ch, 0) == Some(ch.len())
}

fn quote_name(name: &str) -> String {
    format!("'{}'", name.replace('\'', "''"))
}

/// `$?[A-Za-z]{1,3}$?[0-9]+` à la position `i` ; renvoie l'index de fin.
fn parse_cell(ch: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    if ch.get(j) == Some(&'$') {
        j += 1;
    }
    let letters = j;
    while ch.get(j).is_some_and(|c| c.is_ascii_alphabetic()) {
        j += 1;
    }
    if j == letters || j - letters > 3 {
        return None;
    }
    if ch.get(j) == Some(&'$') {
        j += 1;
    }
    let digits = j;
    while ch.get(j).is_some_and(|c| c.is_ascii_digit()) {
        j += 1;
    }
    if j == digits {
        return None;
    }
    match ch.get(j) {
        Some(c) if c.is_alphanumeric() || matches!(c, '_' | '(' | '.' | '!') => None,
        _ => Some(j),
    }
}

/// Préfixe de feuille `Nom!` ou `'Nom'!` ; renvoie (nom, index après `!`).
fn parse_sheet_prefix(ch: &[char], i: usize) -> Option<(String, usize)> {
    let mut j = i;
    let mut name = String::new();
    if ch.get(j) == Some(&'\'') {
        j += 1;
        loop {
            match ch.get(j)? {
                '\'' if ch.get(j + 1) == Some(&'\'') => {
                    name.push('\'');
                    j += 2;
                }
                '\'' => {
                    j += 1;
                    break;
                }
                c => {
                    name.push(*c);
                    j += 1;
                }
            }
        }
    } else {
        while ch
            .get(j)
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '.'))
        {
            name.push(ch[j]);
            j += 1;
        }
        if name.is_empty() {
            return None;
        }
    }
    (ch.get(j) == Some(&'!')).then_some((name, j + 1))
}

/// Borne d'une plage de colonnes (lettres) ou de lignes (chiffres), `$` optionnel.
fn parse_axis(ch: &[char], i: usize, digits: bool) -> Option<usize> {
    let mut j = i;
    if ch.get(j) == Some(&'$') {
        j += 1;
    }
    let start = j;
    while ch.get(j).is_some_and(|c| {
        if digits {
            c.is_ascii_digit()
        } else {
            c.is_ascii_alphabetic()
        }
    }) {
        j += 1;
    }
    (j > start).then_some(j)
}

/// Plage entière de colonnes (`A:A`, `$B:$C`) ou de lignes (`1:1`) → (début, fin, index après).
fn parse_axis_range(ch: &[char], i: usize) -> Option<(String, String, usize)> {
    for digits in [false, true] {
        let Some(e1) = parse_axis(ch, i, digits) else {
            continue;
        };
        if ch.get(e1) != Some(&':') {
            continue;
        }
        let Some(e2) = parse_axis(ch, e1 + 1, digits) else {
            continue;
        };
        if ch
            .get(e2)
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '(' | '.' | '!'))
        {
            continue;
        }
        return Some((
            ch[i..e1].iter().collect(),
            ch[e1 + 1..e2].iter().collect(),
            e2,
        ));
    }
    None
}

fn push_axis_ref(out: &mut String, sheet: Option<&str>, first: &str, second: &str) {
    out.push('[');
    if let Some(s) = sheet {
        out.push('$');
        out.push_str(&if needs_quote(s) {
            quote_name(s)
        } else {
            s.to_string()
        });
    }
    out.push('.');
    out.push_str(first);
    out.push_str(":.");
    out.push_str(second);
    out.push(']');
}

fn copy_string_literal(ch: &[char], i: &mut usize, out: &mut String) {
    out.push('"');
    *i += 1;
    while let Some(&c) = ch.get(*i) {
        out.push(c);
        *i += 1;
        if c == '"' {
            if ch.get(*i) == Some(&'"') {
                out.push('"');
                *i += 1;
            } else {
                break;
            }
        }
    }
}

/// Formule Excel (sans "=") → OpenFormula (`of:=...`).
pub(crate) fn excel_to_ods(f: &str) -> String {
    let ch: Vec<char> = f.chars().collect();
    let mut out = String::from("of:=");
    let mut i = 0;
    while let Some(&c) = ch.get(i) {
        if c == '"' {
            copy_string_literal(&ch, &mut i, &mut out);
        } else if c == ',' {
            out.push(';');
            i += 1;
        } else if let Some((a, b, next)) = c
            .is_ascii_digit()
            .then(|| parse_axis_range(&ch, i))
            .flatten()
        {
            // Plage de lignes `1:1`.
            push_axis_ref(&mut out, None, &a, &b);
            i = next;
        } else if c.is_ascii_digit() {
            while ch.get(i).is_some_and(|c| c.is_ascii_digit() || *c == '.') {
                out.push(ch[i]);
                i += 1;
            }
            if matches!(ch.get(i), Some('e' | 'E')) {
                let sign = matches!(ch.get(i + 1), Some('+' | '-'));
                let d = i + 1 + usize::from(sign);
                if ch.get(d).is_some_and(|c| c.is_ascii_digit()) {
                    out.extend(&ch[i..d]);
                    i = d;
                    while ch.get(i).is_some_and(|c| c.is_ascii_digit()) {
                        out.push(ch[i]);
                        i += 1;
                    }
                }
            }
        } else if c.is_alphabetic() || matches!(c, '_' | '$' | '\'') {
            let (sheet, start) = match parse_sheet_prefix(&ch, i) {
                Some((n, e)) => (Some(n), e),
                None => (None, i),
            };
            if let Some(end) = parse_cell(&ch, start) {
                let first: String = ch[start..end].iter().collect();
                let mut second = None;
                let mut next = end;
                if ch.get(end) == Some(&':') {
                    if let Some(e2) = parse_cell(&ch, end + 1) {
                        second = Some(ch[end + 1..e2].iter().collect::<String>());
                        next = e2;
                    }
                }
                out.push('[');
                if let Some(s) = &sheet {
                    out.push('$');
                    out.push_str(&if needs_quote(s) {
                        quote_name(s)
                    } else {
                        s.clone()
                    });
                }
                out.push('.');
                out.push_str(&first);
                if let Some(s2) = second {
                    out.push_str(":.");
                    out.push_str(&s2);
                }
                out.push(']');
                i = next;
            } else if let Some((a, b, next)) = parse_axis_range(&ch, start) {
                // Plage de colonnes `A:A` ou de lignes `1:1`.
                push_axis_ref(&mut out, sheet.as_deref(), &a, &b);
                i = next;
            } else if sheet.is_some() {
                out.extend(&ch[i..start]);
                i = start;
            } else if c == '\'' {
                out.push(c);
                i += 1;
            } else {
                let mut j = i;
                while ch
                    .get(j)
                    .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '$'))
                {
                    j += 1;
                }
                let j = j.max(i + 1);
                out.extend(&ch[i..j]);
                i = j;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Partie d'une référence ODF (`.A1`, `$Feuille.A1`, `$'Ma feuille'.A1`) → (feuille, cellule).
fn parse_ods_part(p: &str) -> Option<(Option<String>, String)> {
    let valid_cell =
        |c: &str| !c.is_empty() && c.chars().all(|x| x.is_ascii_alphanumeric() || x == '$');
    if let Some(cell) = p.strip_prefix('.') {
        return valid_cell(cell).then(|| (None, cell.to_string()));
    }
    let p = p.strip_prefix('$').unwrap_or(p);
    let ch: Vec<char> = p.chars().collect();
    let (name, mut j) = if ch.first() == Some(&'\'') {
        let mut name = String::new();
        let mut j = 1;
        loop {
            match ch.get(j)? {
                '\'' if ch.get(j + 1) == Some(&'\'') => {
                    name.push('\'');
                    j += 2;
                }
                '\'' => {
                    j += 1;
                    break;
                }
                c => {
                    name.push(*c);
                    j += 1;
                }
            }
        }
        (name, j)
    } else {
        let dot = ch.iter().position(|c| *c == '.')?;
        (ch[..dot].iter().collect::<String>(), dot)
    };
    if ch.get(j) != Some(&'.') {
        return None;
    }
    j += 1;
    let cell: String = ch[j..].iter().collect();
    valid_cell(&cell).then_some((Some(name), cell))
}

fn convert_ods_ref(inner: &str) -> Option<String> {
    // Découpe sur ':' hors apostrophes.
    let mut parts: Vec<String> = vec![String::new()];
    let mut quoted = false;
    for c in inner.chars() {
        match c {
            '\'' => {
                quoted = !quoted;
                parts.last_mut()?.push(c);
            }
            ':' if !quoted => parts.push(String::new()),
            _ => parts.last_mut()?.push(c),
        }
    }
    if parts.len() > 2 {
        return None;
    }
    let (sheet, first) = parse_ods_part(&parts[0])?;
    let mut out = String::new();
    if let Some(s) = &sheet {
        out.push_str(&if needs_quote(s) {
            quote_name(s)
        } else {
            s.clone()
        });
        out.push('!');
    }
    out.push_str(&first);
    if let Some(p2) = parts.get(1) {
        let (sheet2, second) = parse_ods_part(p2)?;
        if sheet2.is_some() && sheet2 != sheet {
            return None;
        }
        out.push(':');
        out.push_str(&second);
    }
    Some(out)
}

/// Formule OpenFormula (`of:=...`) → Excel (sans "=").
pub(crate) fn ods_to_excel(f: &str) -> String {
    let f = f
        .strip_prefix("of:")
        .or_else(|| f.strip_prefix("oooc:"))
        .unwrap_or(f);
    let f = f.strip_prefix('=').unwrap_or(f);
    let ch: Vec<char> = f.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while let Some(&c) = ch.get(i) {
        match c {
            '"' => copy_string_literal(&ch, &mut i, &mut out),
            ';' => {
                out.push(',');
                i += 1;
            }
            '[' => {
                let mut j = i + 1;
                let mut quoted = false;
                while let Some(&x) = ch.get(j) {
                    if x == '\'' {
                        quoted = !quoted;
                    } else if x == ']' && !quoted {
                        break;
                    }
                    j += 1;
                }
                if ch.get(j) == Some(&']') {
                    let inner: String = ch[i + 1..j].iter().collect();
                    match convert_ods_ref(&inner) {
                        Some(r) => out.push_str(&r),
                        None => out.extend(&ch[i..=j]),
                    }
                    i = j + 1;
                } else {
                    out.push(c);
                    i += 1;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn fix_formula(f: &str) -> String {
    ods_to_excel(f)
}

// --- Lecture ---

fn detect_lossy(zip: &mut zip::ZipArchive<Cursor<&[u8]>>) -> Vec<String> {
    let mut lossy: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        if !lossy.iter().any(|l| l == s) {
            lossy.push(s.to_string());
        }
    };
    let names: Vec<String> = zip.file_names().flatten().map(|n| n.into_owned()).collect();
    if names
        .iter()
        .any(|n| n.starts_with("Basic/") || n.starts_with("Scripts/"))
    {
        add("macros");
    }
    if names.iter().any(|n| n.starts_with("Object ")) {
        add("charts");
    }
    if names.iter().any(|n| n.starts_with("Pictures/")) {
        add("images");
    }
    if let Some(xml) = read_entry(zip, "content.xml", MAX_XML_ENTRY) {
        if bytes_contain(&xml, b"number-columns-spanned")
            || bytes_contain(&xml, b"number-rows-spanned")
        {
            add("merges");
        }
        if bytes_contain(&xml, b"calcext:conditional-format") {
            add("conditionalFormatting");
        }
        if bytes_contain(&xml, b"<office:annotation") {
            add("comments");
        }
        if bytes_contain(&xml, b"fo:background-color")
            || bytes_contain(&xml, b"fo:font-weight")
            || bytes_contain(&xml, b"fo:color")
        {
            add("styles");
        }
    }
    lossy
}

fn read_ods(bytes: &[u8]) -> Result<Workbook> {
    let mut zip = guarded_zip(bytes)?;
    let lossy = detect_lossy(&mut zip);
    let mut wb = open_workbook_from_rs::<Ods<_>, _>(Cursor::new(bytes))
        .map_err(|e| AppError::Corrupt(e.to_string()))?;
    let mut sheets = read_sheets(&mut wb, fix_formula)?;
    // calamine ne distingue pas les erreurs ODS : texte d'erreur connu dans une cellule à formule.
    for s in &mut sheets {
        for c in s.rows.iter_mut().flatten() {
            if let (Some(_), CellValue::Text(t)) = (&c.f, &c.v) {
                if ERRORS.contains(&t.as_str()) {
                    c.v = CellValue::Error(t.clone());
                }
            }
        }
    }
    Ok(Workbook {
        sheets,
        csv: None,
        lossy,
    })
}

// --- Écriture ---

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// Texte d'une cellule → paragraphes `text:p` (espaces multiples, tabulations).
fn paragraphs(s: &str) -> String {
    let mut out = String::new();
    for line in s.split('\n') {
        out.push_str("<text:p>");
        let mut spaces = 0usize;
        let mut at_start = true;
        let flush = |out: &mut String, spaces: &mut usize, at_start: bool| {
            if *spaces > 0 {
                if at_start {
                    out.push_str(&format!("<text:s text:c=\"{spaces}\"/>"));
                } else {
                    out.push(' ');
                    if *spaces > 1 {
                        out.push_str(&format!("<text:s text:c=\"{}\"/>", *spaces - 1));
                    }
                }
                *spaces = 0;
            }
        };
        for c in line.chars() {
            match c {
                ' ' => spaces += 1,
                '\t' => {
                    flush(&mut out, &mut spaces, at_start);
                    out.push_str("<text:tab/>");
                    at_start = false;
                }
                '\r' => {}
                c => {
                    flush(&mut out, &mut spaces, at_start);
                    out.push_str(&esc(&c.to_string()));
                    at_start = false;
                }
            }
        }
        flush(&mut out, &mut spaces, at_start);
        out.push_str("</text:p>");
    }
    out
}

fn cell_xml(c: &Cell) -> String {
    let formula =
        c.f.as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(|f| format!(" table:formula=\"{}\"", esc(&excel_to_ods(f))));
    let fattr = formula.unwrap_or_default();
    match &c.v {
        CellValue::Empty => format!("<table:table-cell{fattr}/>"),
        CellValue::Number(n) if !n.is_finite() => format!(
            "<table:table-cell office:value-type=\"string\" calcext:value-type=\"error\"{fattr}><text:p>#NUM!</text:p></table:table-cell>"
        ),
        CellValue::Number(n) => {
            let date = c
                .fmt
                .as_deref()
                .filter(|f| is_date_fmt(f))
                .and_then(|_| iso_from_serial(*n));
            match date {
                Some(iso) => format!(
                    "<table:table-cell office:value-type=\"date\" office:date-value=\"{iso}\"{fattr}><text:p>{iso}</text:p></table:table-cell>"
                ),
                None => format!(
                    "<table:table-cell office:value-type=\"float\" office:value=\"{n}\"{fattr}><text:p>{n}</text:p></table:table-cell>"
                ),
            }
        }
        CellValue::Text(t) => format!(
            "<table:table-cell office:value-type=\"string\"{fattr}>{}</table:table-cell>",
            paragraphs(t)
        ),
        CellValue::Error(e) => format!(
            "<table:table-cell office:value-type=\"string\" calcext:value-type=\"error\"{fattr}>{}</table:table-cell>",
            paragraphs(e)
        ),
        CellValue::Bool(b) => format!(
            "<table:table-cell office:value-type=\"boolean\" office:boolean-value=\"{b}\"{fattr}><text:p>{}</text:p></table:table-cell>",
            if *b { "TRUE" } else { "FALSE" }
        ),
    }
}

fn blank(c: &Cell) -> bool {
    crate::formats::sheet::is_blank(c)
}

fn content_xml(wb: &Workbook) -> String {
    let names = sanitize_sheet_names(&wb.sheets, 255);
    let mut x = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-content \
xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" \
xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" \
xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" \
xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" \
xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" \
xmlns:of=\"urn:oasis:names:tc:opendocument:xmlns:of:1.2\" \
xmlns:calcext=\"urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0\" \
office:version=\"1.2\"><office:automatic-styles/><office:body><office:spreadsheet>",
    );
    for (sheet, name) in wb.sheets.iter().zip(&names) {
        x.push_str(&format!("<table:table table:name=\"{}\">", esc(name)));
        let last_row = sheet
            .rows
            .iter()
            .rposition(|r| !r.iter().all(blank))
            .map_or(0, |i| i + 1);
        let ncols = sheet.rows[..last_row]
            .iter()
            .map(Vec::len)
            .max()
            .unwrap_or(1)
            .max(1);
        x.push_str(&format!(
            "<table:table-column table:number-columns-repeated=\"{ncols}\"/>"
        ));
        let mut empty_rows = 0usize;
        let flush_rows = |x: &mut String, n: &mut usize| {
            if *n > 0 {
                x.push_str(&format!(
                    "<table:table-row table:number-rows-repeated=\"{n}\"><table:table-cell/></table:table-row>"
                ));
                *n = 0;
            }
        };
        for row in &sheet.rows[..last_row] {
            let used = row.iter().rposition(|c| !blank(c)).map_or(0, |i| i + 1);
            if used == 0 {
                empty_rows += 1;
                continue;
            }
            flush_rows(&mut x, &mut empty_rows);
            x.push_str("<table:table-row>");
            let mut empties = 0usize;
            for c in &row[..used] {
                if blank(c) {
                    empties += 1;
                    continue;
                }
                if empties > 0 {
                    x.push_str(&format!(
                        "<table:table-cell table:number-columns-repeated=\"{empties}\"/>"
                    ));
                    empties = 0;
                }
                x.push_str(&cell_xml(c));
            }
            x.push_str("</table:table-row>");
        }
        flush_rows(&mut x, &mut empty_rows);
        if last_row == 0 {
            x.push_str("<table:table-row><table:table-cell/></table:table-row>");
        }
        x.push_str("</table:table>");
    }
    if wb.sheets.is_empty() {
        x.push_str(
            "<table:table table:name=\"Sheet1\"><table:table-column/><table:table-row><table:table-cell/></table:table-row></table:table>",
        );
    }
    x.push_str("</office:spreadsheet></office:body></office:document-content>");
    x
}

const MANIFEST: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<manifest:manifest \
xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.2\">\
<manifest:file-entry manifest:full-path=\"/\" manifest:version=\"1.2\" \
manifest:media-type=\"application/vnd.oasis.opendocument.spreadsheet\"/>\
<manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>\
<manifest:file-entry manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/>\
<manifest:file-entry manifest:full-path=\"meta.xml\" manifest:media-type=\"text/xml\"/>\
</manifest:manifest>";

const STYLES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-styles \
xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" office:version=\"1.2\">\
<office:styles/><office:automatic-styles/></office:document-styles>";

fn meta_xml() -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-meta \
xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" \
xmlns:meta=\"urn:oasis:names:tc:opendocument:xmlns:meta:1.0\" office:version=\"1.2\">\
<office:meta><meta:generator>OmniDoc</meta:generator>\
<meta:creation-date>{now}</meta:creation-date></office:meta></office:document-meta>"
    )
}

/// Sérialise le classeur en ods (octets).
pub(crate) fn write_ods(wb: &Workbook) -> Result<Vec<u8>> {
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let io = |e: zip::result::ZipError| AppError::External(e.to_string());
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).map_err(io)?;
    zip.write_all(ODS_MIMETYPE.as_bytes())?;
    let content = content_xml(wb);
    let meta = meta_xml();
    for (name, data) in [
        ("META-INF/manifest.xml", MANIFEST),
        ("content.xml", content.as_str()),
        ("styles.xml", STYLES),
        ("meta.xml", meta.as_str()),
    ] {
        zip.start_file(name, deflated).map_err(io)?;
        zip.write_all(data.as_bytes())?;
    }
    Ok(zip.finish().map_err(io)?.into_inner())
}

impl FormatHandler for OdsHandler {
    fn id(&self) -> &'static str {
        "ods"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Sheet
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["ods"]
    }

    fn label_key(&self) -> &'static str {
        "formats.ods"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let ext_ok = probe.ext == "ods";
        let marker = format!("mimetype{ODS_MIMETYPE}");
        let sig =
            probe.head.starts_with(b"PK\x03\x04") && bytes_contain(&probe.head, marker.as_bytes());
        match (ext_ok, sig) {
            (true, true) => Some(Confidence(95)),
            (false, true) => Some(Confidence(90)),
            (true, false) => Some(Confidence(60)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: vec!["xlsx".into(), "csv".into()],
            fidelity: Fidelity::Partial,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let bytes = std::fs::read(path)?;
        Ok(DocumentModel::Sheet(read_ods(&bytes)?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        let wb = expect_workbook(doc)?;
        atomic::write(path, &write_ods(wb)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::sheet::snapshot;
    use crate::formats::sheet::xlsx::tests::{c, sample};
    use crate::formats::sheet::xlsx::{write_xlsx, ExcelHandler};

    #[test]
    fn formula_conversion_both_ways() {
        let cases = [
            ("SUM(A1:B2)", "of:=SUM([.A1:.B2])"),
            ("IF(A1>0,\"a,b\",B$2)", "of:=IF([.A1]>0;\"a,b\";[.B$2])"),
            (
                "Sheet2!A1+'My Sheet'!B2:C3",
                "of:=[$Sheet2.A1]+[$'My Sheet'.B2:.C3]",
            ),
            ("LOG10(A1)*2E5+TRUE", "of:=LOG10([.A1])*2E5+TRUE"),
            ("$A$1&\"x\"", "of:=[.$A$1]&\"x\""),
            ("SUM(A:A)", "of:=SUM([.A:.A])"),
            ("SUM(1:1)+2", "of:=SUM([.1:.1])+2"),
            ("SUM(Sheet2!$B:$C)", "of:=SUM([$Sheet2.$B:.$C])"),
            ("COUNT('My Sheet'!2:3)", "of:=COUNT([$'My Sheet'.2:.3])"),
        ];
        for (excel, ods) in cases {
            assert_eq!(excel_to_ods(excel), ods, "{excel}");
            assert_eq!(ods_to_excel(ods), excel, "{ods}");
        }
        assert_eq!(ods_to_excel("of:=[$Sheet1.A1:.B2]"), "Sheet1!A1:B2");
        assert_eq!(ods_to_excel("of:=SUM([.A1:.B2])"), "SUM(A1:B2)");
    }

    #[test]
    fn ods_roundtrip_values_formulas_sheets() {
        let wb = sample();
        let back = read_ods(&write_ods(&wb).unwrap()).unwrap();
        assert_eq!(back.sheets.len(), 2);
        assert_eq!(back.sheets[0].name, "Données");
        let rows = &back.sheets[0].rows;
        assert_eq!(rows[0][1].v, CellValue::Number(2.5));
        assert_eq!(rows[1][1].v, CellValue::Text("été ☀ 日本".into()));
        assert_eq!(rows[2][0].f.as_deref(), Some("SUM(A1:B2)"));
        assert_eq!(rows[2][0].v, CellValue::Number(6.0));
        assert_eq!(rows[2][2].v, CellValue::Number(45000.0));
        assert_eq!(rows[2][2].fmt.as_deref(), Some("yyyy-mm-dd"));
        assert_eq!(rows[3][0].v, CellValue::Bool(true));
        assert_eq!(rows[3][1].v, CellValue::Empty);
        assert_eq!(rows[3][2].v, CellValue::Text("x".into()));
        assert_eq!(
            back.sheets[1].rows[0][1].f.as_deref(),
            Some("CONCATENATE(A1,\"b\")")
        );
    }

    #[test]
    fn special_text_and_gaps_roundtrip() {
        let mut wb = sample();
        wb.sheets.truncate(1);
        wb.sheets[0].rows = vec![
            vec![c(CellValue::Text("a  b\nline2 <&>\"'".into()))],
            vec![],
            vec![],
            vec![
                c(CellValue::Empty),
                c(CellValue::Empty),
                c(CellValue::Number(7.0)),
            ],
            vec![c(CellValue::Error("#DIV/0!".into()))],
        ];
        wb.sheets[0].rows[4][0].f = Some("1/0".into());
        let back = read_ods(&write_ods(&wb).unwrap()).unwrap();
        let rows = &back.sheets[0].rows;
        assert_eq!(rows[0][0].v, CellValue::Text("a  b\nline2 <&>\"'".into()));
        assert_eq!(rows[3][2].v, CellValue::Number(7.0));
        assert_eq!(rows[4][0].v, CellValue::Error("#DIV/0!".into()));
        assert_eq!(rows.len(), 5);
    }

    #[test]
    fn xlsx_ods_xlsx_preserves_content() {
        let wb = sample();
        let ods = read_ods(&write_ods(&wb).unwrap()).unwrap();
        let xlsx = read_xlsx_bytes(&write_xlsx(&ods).unwrap());
        let original = read_xlsx_bytes(&write_xlsx(&wb).unwrap());
        let strip = |mut w: Workbook| {
            for s in &mut w.sheets {
                s.col_widths = None;
                for c in s.rows.iter_mut().flatten() {
                    c.fmt = None;
                }
            }
            snapshot(&w)
        };
        assert_eq!(strip(xlsx), strip(original));
    }

    fn read_xlsx_bytes(b: &[u8]) -> Workbook {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.xlsx");
        std::fs::write(&p, b).unwrap();
        match ExcelHandler::xlsx().open(&p).unwrap() {
            DocumentModel::Sheet(w) => w,
            _ => panic!("modèle inattendu"),
        }
    }

    #[test]
    fn file_roundtrip_and_detection() {
        let h = OdsHandler;
        let dir = tempfile::tempdir().unwrap();
        let (p1, p2) = (dir.path().join("a.ods"), dir.path().join("b.ods"));
        h.save(&DocumentModel::Sheet(sample()), &p1).unwrap();
        let bytes = std::fs::read(&p1).unwrap();
        assert!(bytes.starts_with(b"PK\x03\x04"));
        assert!(bytes_contain(
            &bytes[..200],
            b"mimetypeapplication/vnd.oasis"
        ));
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.ods", &bytes)),
            Some(Confidence(95))
        );
        assert_eq!(
            h.detect(&FileProbe::from_bytes("a.zip", &bytes)),
            Some(Confidence(90))
        );
        assert!(h.detect(&FileProbe::from_bytes("a.txt", b"x")).is_none());
        let m1 = h.open(&p1).unwrap();
        h.save(&m1, &p2).unwrap();
        match (m1, h.open(&p2).unwrap()) {
            (DocumentModel::Sheet(a), DocumentModel::Sheet(b)) => {
                assert_eq!(snapshot(&a), snapshot(&b))
            }
            _ => panic!("modèle inattendu"),
        }
    }

    #[test]
    fn corrupt_bytes_do_not_panic() {
        let good = write_ods(&sample()).unwrap();
        for cut in [0usize, 10, 100, good.len() / 2, good.len() - 5] {
            let _ = read_ods(&good[..cut]);
        }
        let mut flipped = good.clone();
        for i in (0..flipped.len()).step_by(41) {
            flipped[i] ^= 0xFF;
        }
        let _ = read_ods(&flipped);
        assert!(read_ods(&[1, 2, 3, 4, 5]).is_err());
    }
}
