//! csv / tsv : détection d'encodage (BOM, UTF-8, chardetng), de séparateur et de fins de ligne.
//!
//! Conventions :
//! - une seule feuille ; nombres reconnus seulement s'ils se réécrivent à l'identique (pas de zéro
//!   initial, ≤ 15 chiffres, pas d'exposant) ; les zéros finaux décimaux ("12.50") sont conservés via
//!   `fmt` ("0.00") ; `TRUE`/`FALSE` exacts → booléens ;
//! - séparateur `;` ⇒ décimale en virgule (FR) : "1,5" est un nombre, "1.5" reste du texte ; avec les
//!   autres séparateurs, "1,5" reste du texte ;
//! - à l'écriture, une formule est écrite sous sa valeur `v` (le front fournit les valeurs
//!   calculées) ; si `v` est vide, on écrit `=` + formule.

use std::collections::HashMap;
use std::path::Path;

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::Encoding;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_CELLS;
use crate::core::model::{Cell, CellValue, CsvOptions, DocumentModel, ModelKind, Sheet, Workbook};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::formats::sheet::{expect_workbook, finalize};

const CANDIDATES: &[u8] = b",;\t|";
const SAMPLE_RECORDS: usize = 50;

pub struct CsvHandler {
    tab: bool,
}

impl CsvHandler {
    pub fn csv() -> Self {
        CsvHandler { tab: false }
    }

    pub fn tsv() -> Self {
        CsvHandler { tab: true }
    }
}

struct Decoded {
    text: String,
    encoding: String,
    bom: bool,
}

fn decode_strict(enc: &'static Encoding, bytes: &[u8]) -> Option<String> {
    enc.decode_without_bom_handling_and_without_replacement(bytes)
        .map(|c| c.into_owned())
}

/// Décodage sans perte : jamais de U+FFFD. Octets invalides → repli windows-1252 (réversible).
fn decode(bytes: &[u8]) -> Decoded {
    let bomed: [(&[u8], &'static Encoding, &str); 3] = [
        (&[0xEF, 0xBB, 0xBF], encoding_rs::UTF_8, "utf-8"),
        (&[0xFF, 0xFE], encoding_rs::UTF_16LE, "utf-16le"),
        (&[0xFE, 0xFF], encoding_rs::UTF_16BE, "utf-16be"),
    ];
    for (mark, enc, name) in bomed {
        if let Some(rest) = bytes.strip_prefix(mark) {
            if let Some(text) = decode_strict(enc, rest) {
                return Decoded {
                    text,
                    encoding: name.into(),
                    bom: true,
                };
            }
            // BOM + octets invalides : on retombe sur le repli sans perte ci-dessous.
            break;
        }
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Decoded {
            text: s.to_string(),
            encoding: "utf-8".into(),
            bom: false,
        };
    }
    let mut det = EncodingDetector::new(Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    let guess = det.guess(None, Utf8Detection::Deny);
    if let Some(text) = decode_strict(guess, bytes) {
        return Decoded {
            text,
            encoding: guess.name().to_lowercase(),
            bom: false,
        };
    }
    let fallback = encoding_rs::WINDOWS_1252;
    Decoded {
        text: fallback.decode_without_bom_handling(bytes).0.into_owned(),
        encoding: fallback.name().to_lowercase(),
        bom: false,
    }
}

fn encode_utf16(text: &str, big_endian: bool, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    let mut push = |u: u16| {
        let b = if big_endian {
            u.to_be_bytes()
        } else {
            u.to_le_bytes()
        };
        out.extend_from_slice(&b);
    };
    if bom {
        push(0xFEFF);
    }
    for u in text.encode_utf16() {
        push(u);
    }
    out
}

fn encode(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>> {
    match encoding.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        "utf-16le" | "utf-16" => Ok(encode_utf16(text, false, bom)),
        "utf-16be" => Ok(encode_utf16(text, true, bom)),
        other => {
            let enc = Encoding::for_label(other.as_bytes()).ok_or(AppError::Unsupported)?;
            let (bytes, _, had_errors) = enc.encode(text);
            if had_errors {
                return Err(AppError::Encoding(other.to_string()));
            }
            Ok(bytes.into_owned())
        }
    }
}

/// (colonnes du mode, lignes conformes au mode, lignes analysées) pour un séparateur.
fn score(text: &str, delim: u8, drop_last: bool) -> (usize, usize, usize) {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .flexible(true)
        .has_headers(false)
        .from_reader(text.as_bytes());
    let mut counts: Vec<usize> = rdr
        .records()
        .take(SAMPLE_RECORDS)
        .filter_map(|r| r.ok())
        .map(|r| r.len())
        .collect();
    if drop_last && counts.len() > 1 {
        counts.pop();
    }
    let mut freq: HashMap<usize, usize> = HashMap::new();
    for c in &counts {
        *freq.entry(*c).or_insert(0) += 1;
    }
    let (cols, matching) = freq
        .into_iter()
        .max_by_key(|&(cols, n)| (n, cols))
        .unwrap_or((0, 0));
    (cols, matching, counts.len())
}

/// Meilleur séparateur parmi `cands` : (séparateur, colonnes, conformes, total), ≥ 2 colonnes.
fn best_delimiter(text: &str, cands: &[u8], drop_last: bool) -> Option<(u8, usize, usize, usize)> {
    let mut best: Option<(u8, usize, usize, usize)> = None;
    for &d in cands {
        let (cols, matching, total) = score(text, d, drop_last);
        if cols < 2 {
            continue;
        }
        let better = match best {
            None => true,
            Some((_, bc, bm, _)) => (matching, cols) > (bm, bc),
        };
        if better {
            best = Some((d, cols, matching, total));
        }
    }
    best
}

/// Nombre reconnu seulement s'il se réécrit à l'identique ; renvoie (valeur, fmt éventuel).
fn parse_number(s: &str, decimal_comma: bool) -> Option<(f64, Option<String>)> {
    let body = s.strip_prefix('-').unwrap_or(s);
    let sep = if decimal_comma { ',' } else { '.' };
    let (int, frac) = match body.split_once(sep) {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || frac.is_some_and(|f| !digits(f)) {
        return None;
    }
    if int.len() > 1 && int.starts_with('0') {
        return None;
    }
    if int.len() + frac.map_or(0, str::len) > 15 {
        return None;
    }
    let normalized = match frac {
        Some(f) => format!("{int}.{f}"),
        None => int.to_string(),
    };
    let mut n: f64 = normalized.parse().ok()?;
    if s.starts_with('-') {
        n = -n;
    }
    let fmt = frac
        .filter(|f| f.ends_with('0'))
        .map(|f| format!("0.{}", "0".repeat(f.len())));
    Some((n, fmt))
}

fn parse_value(s: &str, decimal_comma: bool) -> Cell {
    let (v, fmt) = if s.is_empty() {
        (CellValue::Empty, None)
    } else if s == "TRUE" || s == "FALSE" {
        (CellValue::Bool(s == "TRUE"), None)
    } else if let Some((n, fmt)) = parse_number(s, decimal_comma) {
        (CellValue::Number(n), fmt)
    } else {
        (CellValue::Text(s.to_string()), None)
    };
    Cell { v, f: None, fmt }
}

fn cell_text(c: &Cell, decimal_comma: bool) -> String {
    let s = match &c.v {
        CellValue::Empty => match &c.f {
            Some(f) => return format!("={f}"),
            None => String::new(),
        },
        CellValue::Text(t) => return t.clone(),
        CellValue::Error(e) => return e.clone(),
        CellValue::Bool(b) => return if *b { "TRUE" } else { "FALSE" }.into(),
        CellValue::Number(n) if !n.is_finite() => return "#NUM!".into(),
        CellValue::Number(n) => {
            let decimals = c
                .fmt
                .as_deref()
                .and_then(|f| f.strip_prefix("0."))
                .filter(|d| !d.is_empty() && d.bytes().all(|b| b == b'0'))
                .map(str::len);
            match decimals {
                Some(d) => format!("{n:.d$}"),
                None => format!("{n}"),
            }
        }
    };
    if decimal_comma {
        s.replace('.', ",")
    } else {
        s
    }
}

pub fn parse(bytes: &[u8], forced: Option<u8>, name: &str) -> Result<Workbook> {
    let dec = decode(bytes);
    let delim = forced
        .or_else(|| best_delimiter(&dec.text, CANDIDATES, false).map(|b| b.0))
        .unwrap_or(b',');
    let decimal_comma = delim == b';';
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .flexible(true)
        .has_headers(false)
        .from_reader(dec.text.as_bytes());
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut total = 0usize;
    let mut rec = csv::StringRecord::new();
    loop {
        let line_before = rdr.position().line();
        if !rdr
            .read_record(&mut rec)
            .map_err(|e| AppError::Corrupt(e.to_string()))?
        {
            break;
        }
        // Le lecteur saute les lignes vides : on les rétablit (lignes intermédiaires conservées).
        // `position()` après lecture = ligne suivant l'enregistrement ; on retire ses propres lignes.
        let inner: u64 = rec
            .iter()
            .map(|f| f.bytes().filter(|&b| b == b'\n').count() as u64)
            .sum();
        let start = rdr
            .position()
            .line()
            .saturating_sub(1)
            .saturating_sub(inner);
        for _ in line_before..start {
            total = total.saturating_add(1);
            if total > MAX_CELLS {
                return Err(AppError::Limit("MAX_CELLS".into()));
            }
            rows.push(Vec::new());
        }
        total = total.saturating_add(rec.len());
        if total > MAX_CELLS {
            return Err(AppError::Limit("MAX_CELLS".into()));
        }
        rows.push(rec.iter().map(|s| parse_value(s, decimal_comma)).collect());
    }
    let header = match rows.as_slice() {
        [first, second, ..] => {
            !first.is_empty()
                && first
                    .iter()
                    .all(|c| matches!(&c.v, CellValue::Text(t) if !t.is_empty()))
                && second
                    .iter()
                    .any(|c| matches!(c.v, CellValue::Number(_) | CellValue::Bool(_)))
        }
        _ => false,
    };
    let crlf = dec
        .text
        .find('\n')
        .is_some_and(|i| i > 0 && dec.text.as_bytes().get(i - 1) == Some(&b'\r'));
    let mut sheets = vec![Sheet {
        name: name.to_string(),
        rows,
        col_widths: None,
    }];
    finalize(&mut sheets)?;
    Ok(Workbook {
        sheets,
        csv: Some(CsvOptions {
            delimiter: (delim as char).to_string(),
            quote: "\"".into(),
            encoding: dec.encoding,
            header,
            bom: dec.bom,
            crlf,
        }),
        lossy: vec![],
    })
}

pub(crate) fn default_options() -> CsvOptions {
    CsvOptions {
        delimiter: ",".into(),
        quote: "\"".into(),
        encoding: "utf-8".into(),
        header: false,
        bom: false,
        crlf: false,
    }
}

fn single_byte(s: &str, default: u8) -> Result<u8> {
    match s.as_bytes() {
        [] => Ok(default),
        [b] if b.is_ascii() => Ok(*b),
        _ => Err(AppError::Unsupported),
    }
}

/// Sérialise une feuille avec les options données.
pub(crate) fn serialize(sheet: &Sheet, o: &CsvOptions) -> Result<Vec<u8>> {
    let delim = single_byte(&o.delimiter, b',')?;
    let quote = single_byte(&o.quote, b'"')?;
    let terminator = if o.crlf {
        csv::Terminator::CRLF
    } else {
        csv::Terminator::Any(b'\n')
    };
    let mut builder = csv::WriterBuilder::new();
    builder
        .delimiter(delim)
        .quote(quote)
        .flexible(true)
        .terminator(terminator);
    let mut w = builder.from_writer(Vec::new());
    let decimal_comma = delim == b';';
    for row in &sheet.rows {
        if row.is_empty() {
            // Ligne vide : le `csv::Writer` écrirait `""`, on garde une vraie ligne vide.
            let mut buf = w
                .into_inner()
                .map_err(|e| AppError::Corrupt(e.to_string()))?;
            buf.extend_from_slice(if o.crlf { b"\r\n" } else { b"\n" });
            w = builder.from_writer(buf);
            continue;
        }
        w.write_record(row.iter().map(|c| cell_text(c, decimal_comma)))
            .map_err(|e| AppError::Corrupt(e.to_string()))?;
    }
    let buf = w
        .into_inner()
        .map_err(|e| AppError::Corrupt(e.to_string()))?;
    let text = String::from_utf8(buf).map_err(|e| AppError::Corrupt(e.to_string()))?;
    encode(&text, &o.encoding, o.bom)
}

/// Exporte une feuille choisie en CSV avec le séparateur donné ("\t" pour tabulation).
#[tauri::command]
#[specta::specta]
pub async fn sheet_export_csv(
    model: Workbook,
    sheet_index: u32,
    dest: String,
    delimiter: String,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let sheet = model
            .sheets
            .get(sheet_index as usize)
            .ok_or(AppError::NotFound)?;
        let mut opts = model.csv.clone().unwrap_or_else(default_options);
        opts.delimiter = delimiter;
        atomic::write(Path::new(&dest), &serialize(sheet, &opts)?)
    })
    .await
    .map_err(|_| AppError::Internal)?
}

impl FormatHandler for CsvHandler {
    fn id(&self) -> &'static str {
        if self.tab {
            "tsv"
        } else {
            "csv"
        }
    }

    fn model(&self) -> ModelKind {
        ModelKind::Sheet
    }

    fn extensions(&self) -> &'static [&'static str] {
        if self.tab {
            &["tsv", "tab"]
        } else {
            &["csv"]
        }
    }

    fn label_key(&self) -> &'static str {
        if self.tab {
            "formats.tsv"
        } else {
            "formats.csv"
        }
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        if self.extensions().contains(&probe.ext.as_str()) {
            return Some(Confidence(60));
        }
        if !probe.is_text || probe.head.is_empty() {
            return None;
        }
        let cands: &[u8] = if self.tab { b"\t" } else { b",;|" };
        let drop_last = probe.size > probe.head.len() as u64;
        let (_, _, matching, total) = best_delimiter(&decode(&probe.head).text, cands, drop_last)?;
        (total >= 2 && matching * 5 >= total * 4).then_some(Confidence(30))
    }

    fn capabilities(&self) -> Capabilities {
        let export_to = if self.tab {
            vec!["csv", "xlsx", "ods"]
        } else {
            vec!["tsv", "xlsx", "ods"]
        };
        Capabilities {
            read: true,
            write: true,
            export_to: export_to.into_iter().map(String::from).collect(),
            fidelity: Fidelity::Full,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let bytes = std::fs::read(path)?;
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Sheet1".into());
        let forced = self.tab.then_some(b'\t');
        Ok(DocumentModel::Sheet(parse(&bytes, forced, &name)?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        let wb = expect_workbook(doc)?;
        let mut opts = wb.csv.clone().unwrap_or_else(default_options);
        if self.tab {
            opts.delimiter = "\t".into();
        }
        let empty = Sheet {
            name: String::new(),
            rows: vec![],
            col_widths: None,
        };
        let sheet = wb.sheets.first().unwrap_or(&empty);
        atomic::write(path, &serialize(sheet, &opts)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::sheet::snapshot;

    fn open_bytes(h: &CsvHandler, name: &str, bytes: &[u8]) -> (tempfile::TempDir, Workbook) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        match h.open(&p).unwrap() {
            DocumentModel::Sheet(wb) => (dir, wb),
            _ => panic!("modèle inattendu"),
        }
    }

    fn roundtrip_bytes(h: &CsvHandler, name: &str, bytes: &[u8]) -> Vec<u8> {
        let (dir, wb) = open_bytes(h, name, bytes);
        let out = dir.path().join(format!("out-{name}"));
        h.save(&DocumentModel::Sheet(wb), &out).unwrap();
        std::fs::read(out).unwrap()
    }

    fn cell(wb: &Workbook, r: usize, c: usize) -> CellValue {
        wb.sheets[0].rows[r][c].v.clone()
    }

    #[test]
    fn simple_csv_is_byte_identical() {
        let src = b"name,qty,ok\nfoo,12,TRUE\nbar,3.50,FALSE\n";
        let h = CsvHandler::csv();
        assert_eq!(roundtrip_bytes(&h, "a.csv", src), src);
        let (_d, wb) = open_bytes(&h, "a.csv", src);
        assert_eq!(cell(&wb, 1, 1), CellValue::Number(12.0));
        assert_eq!(cell(&wb, 1, 2), CellValue::Bool(true));
        assert_eq!(wb.sheets[0].rows[2][1].fmt.as_deref(), Some("0.00"));
        let o = wb.csv.unwrap();
        assert!(o.header && !o.bom && !o.crlf && o.delimiter == ",");
    }

    #[test]
    fn french_semicolon_decimal_comma_crlf() {
        let src = b"a;b\r\n1,5;x\r\n007;12345678901234567\r\n";
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "fr.csv", src);
        let o = wb.csv.clone().unwrap();
        assert_eq!(o.delimiter, ";");
        assert!(o.crlf);
        assert_eq!(cell(&wb, 1, 0), CellValue::Number(1.5));
        assert_eq!(cell(&wb, 2, 0), CellValue::Text("007".into()));
        assert_eq!(cell(&wb, 2, 1), CellValue::Text("12345678901234567".into()));
        assert_eq!(roundtrip_bytes(&h, "fr.csv", src), src);
    }

    #[test]
    fn comma_decimal_stays_text_with_comma_delimiter() {
        let src = b"a,b\n\"1,5\",2\n";
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "x.csv", src);
        assert_eq!(cell(&wb, 1, 0), CellValue::Text("1,5".into()));
        assert_eq!(roundtrip_bytes(&h, "x.csv", src), src);
    }

    #[test]
    fn quotes_and_newlines_in_cells() {
        let src = b"a,b\n\"he said \"\"hi\"\"\",\"line1\nline2\"\n";
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "q.csv", src);
        assert_eq!(cell(&wb, 1, 0), CellValue::Text("he said \"hi\"".into()));
        assert_eq!(cell(&wb, 1, 1), CellValue::Text("line1\nline2".into()));
        assert_eq!(roundtrip_bytes(&h, "q.csv", src), src);
    }

    #[test]
    fn utf8_bom_roundtrip() {
        let src = "\u{feff}nom;ville\nzoé;Paris\n".as_bytes();
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "b.csv", src);
        assert!(wb.csv.as_ref().unwrap().bom);
        assert_eq!(cell(&wb, 1, 0), CellValue::Text("zoé".into()));
        assert_eq!(roundtrip_bytes(&h, "b.csv", src), src);
    }

    #[test]
    fn invalid_bytes_after_bom_are_lossless() {
        let mut src = vec![0xEF, 0xBB, 0xBF];
        src.extend_from_slice(b"nom;v\ncaf\xE9;1\n");
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "i.csv", &src);
        assert!(!wb.csv.as_ref().unwrap().bom);
        assert_eq!(roundtrip_bytes(&h, "i.csv", &src), src);
    }

    #[test]
    fn blank_lines_are_kept() {
        let src = b"a,b\n1,2\n\n\n3,4\n";
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "e.csv", src);
        assert_eq!(wb.sheets[0].rows.len(), 5);
        assert_eq!(roundtrip_bytes(&h, "e.csv", src), src);
    }

    #[test]
    fn windows_1252_roundtrip() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1252
            .encode("nom;ville\nJosé;Béziers\nÉlodie;Orléans\nGaëlle;Mâcon\nFrançois;Besançon\n");
        let src = bytes.into_owned();
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "w.csv", &src);
        assert_eq!(wb.csv.as_ref().unwrap().encoding, "windows-1252");
        assert_eq!(cell(&wb, 1, 1), CellValue::Text("Béziers".into()));
        assert_eq!(roundtrip_bytes(&h, "w.csv", &src), src);
    }

    #[test]
    fn utf16_bom_roundtrip() {
        let src = encode_utf16("a;b\nx;1\n", false, true);
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "u.csv", &src);
        assert_eq!(wb.csv.as_ref().unwrap().encoding, "utf-16le");
        assert_eq!(roundtrip_bytes(&h, "u.csv", &src), src);
    }

    #[test]
    fn tsv_and_pipe_and_ragged_rows() {
        let h = CsvHandler::tsv();
        let src = b"a\tb\tc\n1\t2\n";
        let (_d, wb) = open_bytes(&h, "t.tsv", src);
        assert_eq!(wb.sheets[0].rows[1].len(), 2);
        assert_eq!(roundtrip_bytes(&h, "t.tsv", src), src);
        let c = CsvHandler::csv();
        let (_d, wb) = open_bytes(&c, "p.csv", b"a|b\n1|2\n3|4\n");
        assert_eq!(wb.csv.unwrap().delimiter, "|");
    }

    #[test]
    fn trailing_empty_rows_trimmed_and_limits() {
        let h = CsvHandler::csv();
        let (_d, wb) = open_bytes(&h, "e.csv", b"a,b\n1,2\n,\n,\n");
        assert_eq!(wb.sheets[0].rows.len(), 2);
    }

    #[test]
    fn detection() {
        let c = CsvHandler::csv();
        let t = CsvHandler::tsv();
        assert_eq!(
            c.detect(&FileProbe::from_bytes("a.csv", b"x")),
            Some(Confidence(60))
        );
        assert_eq!(
            t.detect(&FileProbe::from_bytes("a.tab", b"x")),
            Some(Confidence(60))
        );
        let body = b"a;b;c\n1;2;3\n4;5;6\n";
        assert_eq!(
            c.detect(&FileProbe::from_bytes("data.txt", body)),
            Some(Confidence(30))
        );
        assert_eq!(t.detect(&FileProbe::from_bytes("data.txt", body)), None);
        assert_eq!(
            c.detect(&FileProbe::from_bytes("n.txt", b"hello world\nbye\n")),
            None
        );
    }

    #[test]
    fn formula_written_as_value_and_export_one_sheet() {
        let wb = Workbook {
            sheets: vec![
                Sheet {
                    name: "S1".into(),
                    rows: vec![vec![
                        Cell {
                            v: CellValue::Number(3.0),
                            f: Some("SUM(A1:B1)".into()),
                            fmt: None,
                        },
                        Cell {
                            v: CellValue::Empty,
                            f: Some("A1*2".into()),
                            fmt: None,
                        },
                    ]],
                    col_widths: None,
                },
                Sheet {
                    name: "S2".into(),
                    rows: vec![vec![Cell {
                        v: CellValue::Text("z".into()),
                        f: None,
                        fmt: None,
                    }]],
                    col_widths: None,
                },
            ],
            csv: None,
            lossy: vec![],
        };
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        CsvHandler::csv()
            .save(&DocumentModel::Sheet(wb.clone()), &p)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "3,=A1*2\n");
        let sheet2 = serialize(
            &wb.sheets[1],
            &CsvOptions {
                delimiter: "\t".into(),
                ..default_options()
            },
        )
        .unwrap();
        assert_eq!(sheet2, b"z\n");
        let (_d, back) = open_bytes(&CsvHandler::csv(), "f.csv", b"3,=A1*2\n");
        assert_eq!(snapshot(&back).as_array().unwrap().len(), 1);
    }

    #[test]
    fn corrupt_bytes_do_not_panic() {
        let h = CsvHandler::csv();
        let mut seed = 12345u32;
        for len in [0usize, 1, 7, 100, 2000] {
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed >> 24) as u8
                })
                .collect();
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("r.csv");
            std::fs::write(&p, &bytes).unwrap();
            let _ = h.open(&p);
            let _ = h.detect(&FileProbe::from_bytes("r.bin", &bytes));
        }
    }
}
