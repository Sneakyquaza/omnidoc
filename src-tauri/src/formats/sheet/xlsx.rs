//! xlsx (lecture/écriture), xlsm et xls (lecture seule, export vers xlsx/ods/csv).
//!
//! Lecture : calamine (valeurs, formules, noms de feuilles ; dates → numéro de série + `fmt`
//! "yyyy-mm-dd" ; erreurs → `CellValue::Error`) + largeurs de colonnes lues dans le XML des feuilles.
//! Les codes de format de nombre autres que les dates ne sont pas exposés par calamine : `fmt` est
//! absent à la lecture (mais écrit si présent). Les macros d'un xlsm ne sont jamais exécutées.
//! Écriture : rust_xlsxwriter (formules avec valeur en cache = `v`).

use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::Path;

use calamine::{open_workbook_from_rs, Data, Range, Reader, Xls, Xlsx};

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_CELLS;
use crate::core::model::{Cell, CellValue, DocumentModel, ModelKind, Sheet, Workbook};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};
use crate::formats::sheet::{
    attr, bytes_contain, expect_workbook, finalize, guarded_zip, read_entry, sanitize_sheet_names,
    scan_xml, serial_from_iso,
};

const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_XML_ENTRY: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 1_048_576;
const MAX_COLS: usize = 16_384;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Xlsx,
    Xlsm,
    Xls,
}

pub struct ExcelHandler {
    kind: Kind,
}

impl ExcelHandler {
    pub fn xlsx() -> Self {
        ExcelHandler { kind: Kind::Xlsx }
    }

    pub fn xlsm() -> Self {
        ExcelHandler { kind: Kind::Xlsm }
    }

    pub fn xls() -> Self {
        ExcelHandler { kind: Kind::Xls }
    }
}

fn corrupt<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Corrupt(e.to_string())
}

/// Exécute `f` sans jamais laisser une panique de calamine (données non fiables) remonter.
fn guard<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(AppError::Corrupt("classeur illisible".into())))
}

/// Valeur calamine → (valeur, fmt).
fn convert(d: &Data) -> (CellValue, Option<String>) {
    match d {
        Data::Empty => (CellValue::Empty, None),
        Data::Int(i) => (CellValue::Number(*i as f64), None),
        Data::Float(f) => (CellValue::Number(*f), None),
        Data::String(s) => (CellValue::Text(s.clone()), None),
        Data::Bool(b) => (CellValue::Bool(*b), None),
        Data::Error(e) => (CellValue::Error(e.to_string()), None),
        Data::DateTime(dt) => {
            let n = dt.as_f64();
            let fmt = if !dt.is_datetime() {
                "[h]:mm:ss"
            } else if n.fract() == 0.0 {
                "yyyy-mm-dd"
            } else {
                "yyyy-mm-dd hh:mm:ss"
            };
            (CellValue::Number(n), Some(fmt.into()))
        }
        Data::DateTimeIso(s) => match serial_from_iso(s) {
            Some(n) => {
                let fmt = if n.fract() == 0.0 {
                    "yyyy-mm-dd"
                } else {
                    "yyyy-mm-dd hh:mm:ss"
                };
                (CellValue::Number(n), Some(fmt.into()))
            }
            None => (CellValue::Text(s.clone()), None),
        },
        Data::DurationIso(s) => (CellValue::Text(s.clone()), None),
    }
}

/// Convertit les feuilles d'un classeur calamine ; `fix_formula` normalise la syntaxe des formules.
pub(crate) fn read_sheets<RS, R>(wb: &mut R, fix_formula: fn(&str) -> String) -> Result<Vec<Sheet>>
where
    RS: Read + Seek,
    R: Reader<RS>,
    R::Error: std::fmt::Display,
{
    let mut sheets = Vec::new();
    let mut total = 0usize;
    for name in wb.sheet_names() {
        let range = wb.worksheet_range(&name).map_err(corrupt)?;
        let formulas: Range<String> = wb
            .worksheet_formula(&name)
            .unwrap_or_else(|_| Range::empty());
        let (r0, c0) = range.start().unwrap_or((0, 0));
        let (fr0, fc0) = formulas.start().unwrap_or((0, 0));
        let (h, w) = range.get_size();
        let (fh, fw) = formulas.get_size();
        let n_rows = if range.is_empty() { 0 } else { r0 as usize + h };
        let n_rows = n_rows.max(if formulas.is_empty() {
            0
        } else {
            fr0 as usize + fh
        });
        let n_cols = if range.is_empty() { 0 } else { c0 as usize + w };
        let n_cols = n_cols.max(if formulas.is_empty() {
            0
        } else {
            fc0 as usize + fw
        });
        if n_rows > MAX_ROWS
            || n_cols > MAX_COLS
            || n_rows.saturating_mul(n_cols) > MAX_CELLS.saturating_sub(total)
        {
            return Err(AppError::Limit("MAX_CELLS".into()));
        }
        total += n_rows * n_cols;
        let empty = || Cell {
            v: CellValue::Empty,
            f: None,
            fmt: None,
        };
        let mut rows: Vec<Vec<Cell>> = (0..n_rows)
            .map(|_| (0..n_cols).map(|_| empty()).collect())
            .collect();
        for (ri, row) in range.rows().enumerate() {
            for (ci, d) in row.iter().enumerate() {
                if let Some(cell) = rows
                    .get_mut(r0 as usize + ri)
                    .and_then(|r| r.get_mut(c0 as usize + ci))
                {
                    let (v, fmt) = convert(d);
                    cell.v = v;
                    cell.fmt = fmt;
                }
            }
        }
        for (ri, row) in formulas.rows().enumerate() {
            for (ci, f) in row.iter().enumerate() {
                let f = f.trim();
                if f.is_empty() {
                    continue;
                }
                if let Some(cell) = rows
                    .get_mut(fr0 as usize + ri)
                    .and_then(|r| r.get_mut(fc0 as usize + ci))
                {
                    cell.f = Some(fix_formula(f));
                }
            }
        }
        for row in &mut rows {
            while row.last().is_some_and(super::is_blank) {
                row.pop();
            }
        }
        sheets.push(Sheet {
            name,
            rows,
            col_widths: None,
        });
    }
    finalize(&mut sheets)?;
    Ok(sheets)
}

fn strip_equals(f: &str) -> String {
    f.strip_prefix('=').unwrap_or(f).to_string()
}

/// Largeurs de colonnes par nom de feuille, lues dans le XML (`<cols><col min max width/>`).
fn read_col_widths(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>) -> HashMap<String, Vec<f64>> {
    let mut out = HashMap::new();
    let Some(wbxml) = read_entry(zip, "xl/workbook.xml", MAX_XML_ENTRY) else {
        return out;
    };
    let mut sheets: Vec<(String, String)> = Vec::new();
    let _ = scan_xml(&wbxml, |e| {
        if e.local_name().as_ref() == "sheet" {
            if let (Some(n), Some(id)) = (attr(e, "name"), attr(e, "id")) {
                sheets.push((n, id));
            }
        }
    });
    let mut rels: HashMap<String, String> = HashMap::new();
    if let Some(relxml) = read_entry(zip, "xl/_rels/workbook.xml.rels", MAX_XML_ENTRY) {
        let _ = scan_xml(&relxml, |e| {
            if e.local_name().as_ref() == "Relationship" {
                if let (Some(id), Some(t)) = (attr(e, "Id"), attr(e, "Target")) {
                    rels.insert(id, t);
                }
            }
        });
    }
    for (name, rid) in sheets {
        let Some(target) = rels.get(&rid) else {
            continue;
        };
        let path = match target.strip_prefix('/') {
            Some(abs) => abs.to_string(),
            None => format!("xl/{target}"),
        };
        let Some(xml) = read_entry(zip, &path, MAX_XML_ENTRY) else {
            continue;
        };
        let mut widths: Vec<f64> = Vec::new();
        let _ = scan_xml(&xml, |e| {
            if e.local_name().as_ref() != "col" {
                return;
            }
            let num = |k: &str| attr(e, k).and_then(|v| v.parse::<f64>().ok());
            let (Some(min), Some(max), Some(w)) = (num("min"), num("max"), num("width")) else {
                return;
            };
            if min < 1.0 || max < min || !w.is_finite() || w < 0.0 {
                return;
            }
            let first = min as usize - 1;
            let last = (max as usize).min(MAX_COLS);
            if first >= last {
                return;
            }
            if widths.len() < last {
                widths.resize(last, 0.0);
            }
            // Largeur stockée = caractères + 5 px de marge (police par défaut, 7 px par caractère).
            let chars = ((w * 7.0).round() - 5.0).max(0.0) / 7.0;
            for slot in widths.iter_mut().take(last).skip(first) {
                *slot = chars;
            }
        });
        if widths.iter().any(|w| *w > 0.0) {
            out.insert(name, widths);
        }
    }
    out
}

/// Éléments d'un xlsx/xlsm qui ne sont pas conservés à la réécriture.
fn detect_lossy(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>) -> Vec<String> {
    let names: Vec<String> = zip.file_names().flatten().map(|n| n.into_owned()).collect();
    let mut lossy: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        if !lossy.iter().any(|l| l == s) {
            lossy.push(s.to_string());
        }
    };
    for n in &names {
        if n.starts_with("xl/charts/") {
            add("charts");
        } else if n.starts_with("xl/media/") {
            add("images");
        } else if n == "xl/vbaProject.bin" {
            add("macros");
        } else if n.starts_with("xl/pivotTables/") {
            add("pivotTables");
        } else if n.starts_with("xl/comments") {
            add("comments");
        }
    }
    for n in names.iter().filter(|n| {
        n.starts_with("xl/worksheets/") && n.ends_with(".xml") && !n.contains("/_rels/")
    }) {
        let Some(xml) = read_entry(zip, n, MAX_XML_ENTRY) else {
            continue;
        };
        if bytes_contain(&xml, b"<mergeCell ") {
            add("merges");
        }
        if bytes_contain(&xml, b"<conditionalFormatting") {
            add("conditionalFormatting");
        }
        if bytes_contain(&xml, b"<dataValidation ") {
            add("dataValidations");
        }
    }
    if let Some(styles) = read_entry(zip, "xl/styles.xml", MAX_XML_ENTRY) {
        let count = |tag: &str| -> usize {
            let mut n = 0;
            let _ = scan_xml(&styles, |e| {
                if e.local_name().as_ref() == tag {
                    n = attr(e, "count").and_then(|c| c.parse().ok()).unwrap_or(0);
                }
            });
            n
        };
        if count("fonts") > 1 || count("fills") > 2 || count("borders") > 1 {
            add("styles");
        }
    }
    lossy
}

fn read_xlsx(bytes: &[u8]) -> Result<Workbook> {
    guard(|| read_xlsx_unguarded(bytes))
}

fn read_xlsx_unguarded(bytes: &[u8]) -> Result<Workbook> {
    let mut zip = guarded_zip(bytes)?;
    let widths = read_col_widths(&mut zip);
    let lossy = detect_lossy(&mut zip);
    let mut wb: Xlsx<_> = open_workbook_from_rs(std::io::Cursor::new(bytes)).map_err(corrupt)?;
    let mut sheets = read_sheets(&mut wb, strip_equals)?;
    for s in &mut sheets {
        s.col_widths = widths.get(&s.name).cloned();
    }
    Ok(Workbook {
        sheets,
        csv: None,
        lossy,
    })
}

fn read_xls(bytes: &[u8]) -> Result<Workbook> {
    guard(|| read_xls_unguarded(bytes))
}

fn read_xls_unguarded(bytes: &[u8]) -> Result<Workbook> {
    let mut wb: Xls<_> = open_workbook_from_rs(std::io::Cursor::new(bytes)).map_err(corrupt)?;
    let sheets = read_sheets(&mut wb, strip_equals)?;
    Ok(Workbook {
        sheets,
        csv: None,
        lossy: vec![],
    })
}

/// Sérialise le classeur en xlsx (octets).
pub(crate) fn write_xlsx(wb: &Workbook) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Format, Formula, Workbook as XWorkbook};

    let ext = |e: rust_xlsxwriter::XlsxError| AppError::External(e.to_string());
    let mut x = XWorkbook::new();
    let names = sanitize_sheet_names(&wb.sheets, 31);
    let mut formats: HashMap<String, Format> = HashMap::new();
    for (sheet, name) in wb.sheets.iter().zip(&names) {
        if sheet.rows.len() > MAX_ROWS || sheet.rows.iter().any(|r| r.len() > MAX_COLS) {
            return Err(AppError::Limit("dimensions".into()));
        }
        let ws = x.add_worksheet();
        ws.set_name(name).map_err(ext)?;
        if let Some(widths) = &sheet.col_widths {
            for (ci, w) in widths.iter().enumerate().take(MAX_COLS) {
                if *w > 0.0 && w.is_finite() {
                    ws.set_column_width(ci as u16, *w).map_err(ext)?;
                }
            }
        }
        for (ri, row) in sheet.rows.iter().enumerate() {
            for (ci, c) in row.iter().enumerate() {
                let (r, col) = (ri as u32, ci as u16);
                let fmt = c.fmt.as_deref().filter(|f| !f.is_empty()).map(|f| {
                    formats
                        .entry(f.to_string())
                        .or_insert_with(|| Format::new().set_num_format(f))
                        .clone()
                });
                let value = match &c.v {
                    CellValue::Number(n) if !n.is_finite() => CellValue::Error("#NUM!".into()),
                    other => other.clone(),
                };
                match c.f.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
                    Some(f) => {
                        let result = match &value {
                            CellValue::Empty => String::new(),
                            CellValue::Number(n) => n.to_string(),
                            CellValue::Text(t) | CellValue::Error(t) => t.clone(),
                            CellValue::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
                        };
                        let formula = Formula::new(f).set_result(result);
                        match &fmt {
                            Some(fm) => ws.write_formula_with_format(r, col, formula, fm),
                            None => ws.write_formula(r, col, formula),
                        }
                        .map_err(ext)?;
                    }
                    None => {
                        match (&value, &fmt) {
                            (CellValue::Empty, _) => continue,
                            (CellValue::Number(n), Some(fm)) => {
                                ws.write_number_with_format(r, col, *n, fm)
                            }
                            (CellValue::Number(n), None) => ws.write_number(r, col, *n),
                            (CellValue::Text(t) | CellValue::Error(t), Some(fm)) => {
                                ws.write_string_with_format(r, col, t, fm)
                            }
                            (CellValue::Text(t) | CellValue::Error(t), None) => {
                                ws.write_string(r, col, t)
                            }
                            (CellValue::Bool(b), Some(fm)) => {
                                ws.write_boolean_with_format(r, col, *b, fm)
                            }
                            (CellValue::Bool(b), None) => ws.write_boolean(r, col, *b),
                        }
                        .map_err(ext)?;
                    }
                }
            }
        }
    }
    if wb.sheets.is_empty() {
        x.add_worksheet();
    }
    x.save_to_buffer().map_err(ext)
}

impl FormatHandler for ExcelHandler {
    fn id(&self) -> &'static str {
        match self.kind {
            Kind::Xlsx => "xlsx",
            Kind::Xlsm => "xlsm",
            Kind::Xls => "xls",
        }
    }

    fn model(&self) -> ModelKind {
        ModelKind::Sheet
    }

    fn extensions(&self) -> &'static [&'static str] {
        match self.kind {
            Kind::Xlsx => &["xlsx"],
            Kind::Xlsm => &["xlsm"],
            Kind::Xls => &["xls"],
        }
    }

    fn label_key(&self) -> &'static str {
        match self.kind {
            Kind::Xlsx => "formats.xlsx",
            Kind::Xlsm => "formats.xlsm",
            Kind::Xls => "formats.xls",
        }
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let ext_ok = self.extensions().contains(&probe.ext.as_str());
        if self.kind == Kind::Xls {
            const OLE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
            return match (ext_ok, probe.head.starts_with(&OLE)) {
                (true, true) => Some(Confidence(95)),
                (true, false) => Some(Confidence(60)),
                _ => None,
            };
        }
        let pk = probe.head.starts_with(b"PK\x03\x04");
        let sheet_zip =
            pk && (probe.mime.as_deref() == Some(XLSX_MIME) || bytes_contain(&probe.head, b"xl/"));
        match (ext_ok, sheet_zip) {
            (true, true) => Some(Confidence(95)),
            (false, true)
                if self.kind == Kind::Xlsx && probe.mime.as_deref() == Some(XLSX_MIME) =>
            {
                Some(Confidence(90))
            }
            (true, false) => Some(Confidence(60)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        match self.kind {
            Kind::Xlsx => Capabilities {
                read: true,
                write: true,
                export_to: vec!["ods".into(), "csv".into()],
                fidelity: Fidelity::Partial,
            },
            _ => Capabilities {
                read: true,
                write: false,
                export_to: vec!["xlsx".into(), "ods".into(), "csv".into()],
                fidelity: Fidelity::ReadOnly,
            },
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let bytes = std::fs::read(path)?;
        let wb = match self.kind {
            Kind::Xls => read_xls(&bytes)?,
            _ => read_xlsx(&bytes)?,
        };
        Ok(DocumentModel::Sheet(wb))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        if self.kind != Kind::Xlsx {
            return Err(AppError::ReadOnly);
        }
        let wb = expect_workbook(doc)?;
        atomic::write(path, &write_xlsx(wb)?)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::formats::sheet::snapshot;

    pub(crate) fn c(v: CellValue) -> Cell {
        Cell {
            v,
            f: None,
            fmt: None,
        }
    }

    pub(crate) fn sample() -> Workbook {
        let formula = Cell {
            v: CellValue::Number(6.0),
            f: Some("SUM(A1:B2)".into()),
            fmt: None,
        };
        let pct = Cell {
            v: CellValue::Number(0.25),
            f: None,
            fmt: Some("0.00%".into()),
        };
        let date = Cell {
            v: CellValue::Number(45000.0),
            f: None,
            fmt: Some("yyyy-mm-dd".into()),
        };
        Workbook {
            sheets: vec![
                Sheet {
                    name: "Données".into(),
                    rows: vec![
                        vec![c(CellValue::Number(1.0)), c(CellValue::Number(2.5))],
                        vec![
                            c(CellValue::Number(3.0)),
                            c(CellValue::Text("été ☀ 日本".into())),
                        ],
                        vec![formula, pct, date],
                        vec![
                            c(CellValue::Bool(true)),
                            c(CellValue::Empty),
                            c(CellValue::Text("x".into())),
                        ],
                    ],
                    col_widths: Some(vec![12.0, 0.0, 30.5]),
                },
                Sheet {
                    name: "Deux".into(),
                    rows: vec![vec![
                        c(CellValue::Text("a".into())),
                        Cell {
                            v: CellValue::Text("ab".into()),
                            f: Some("CONCATENATE(A1,\"b\")".into()),
                            fmt: None,
                        },
                    ]],
                    col_widths: None,
                },
            ],
            csv: None,
            lossy: vec![],
        }
    }

    fn reopen(bytes: &[u8]) -> Workbook {
        read_xlsx(bytes).unwrap()
    }

    #[test]
    fn xlsx_roundtrip_values_formulas_sheets() {
        let wb = sample();
        let back = reopen(&write_xlsx(&wb).unwrap());
        assert_eq!(back.sheets.len(), 2);
        assert_eq!(back.sheets[0].name, "Données");
        assert_eq!(back.sheets[1].name, "Deux");
        let rows = &back.sheets[0].rows;
        assert_eq!(rows[1][1].v, CellValue::Text("été ☀ 日本".into()));
        assert_eq!(rows[2][0].f.as_deref(), Some("SUM(A1:B2)"));
        assert_eq!(rows[2][0].v, CellValue::Number(6.0));
        assert_eq!(rows[2][2].v, CellValue::Number(45000.0));
        assert_eq!(rows[2][2].fmt.as_deref(), Some("yyyy-mm-dd"));
        assert_eq!(rows[3][0].v, CellValue::Bool(true));
        assert_eq!(
            back.sheets[0]
                .col_widths
                .as_ref()
                .map(|w| w[0] > 11.0 && w[2] > 30.0),
            Some(true)
        );
        assert_eq!(back.sheets[1].rows[0][1].v, CellValue::Text("ab".into()));
        assert_eq!(
            back.sheets[1].rows[0][1].f.as_deref(),
            Some("CONCATENATE(A1,\"b\")")
        );
    }

    #[test]
    fn xlsx_save_open_save_open_is_stable() {
        let h = ExcelHandler::xlsx();
        let dir = tempfile::tempdir().unwrap();
        let (p1, p2) = (dir.path().join("a.xlsx"), dir.path().join("b.xlsx"));
        h.save(&DocumentModel::Sheet(sample()), &p1).unwrap();
        let m1 = h.open(&p1).unwrap();
        h.save(&m1, &p2).unwrap();
        let m2 = h.open(&p2).unwrap();
        match (m1, m2) {
            (DocumentModel::Sheet(a), DocumentModel::Sheet(b)) => {
                assert_eq!(snapshot(&a), snapshot(&b))
            }
            _ => panic!("modèle inattendu"),
        }
    }

    #[test]
    fn errors_and_lossy_detected() {
        let mut x = rust_xlsxwriter::Workbook::new();
        let ws = x.add_worksheet();
        ws.merge_range(0, 0, 0, 1, "m", &rust_xlsxwriter::Format::new().set_bold())
            .unwrap();
        ws.write_formula(
            1,
            0,
            rust_xlsxwriter::Formula::new("1/0").set_result("#DIV/0!"),
        )
        .unwrap();
        let back = reopen(&x.save_to_buffer().unwrap());
        assert_eq!(
            back.sheets[0].rows[1][0].v,
            CellValue::Error("#DIV/0!".into())
        );
        assert!(back.lossy.iter().any(|l| l == "merges"));
        assert!(back.lossy.iter().any(|l| l == "styles"));
    }

    #[test]
    fn long_sheet_names_are_sanitized() {
        let mut wb = sample();
        wb.sheets[0].name = "a/b:c?".repeat(10);
        wb.sheets[1].name = wb.sheets[0].name.clone();
        let back = reopen(&write_xlsx(&wb).unwrap());
        assert_eq!(back.sheets.len(), 2);
        assert_ne!(back.sheets[0].name, back.sheets[1].name);
    }

    #[test]
    fn detection_and_readonly_variants() {
        let bytes = write_xlsx(&sample()).unwrap();
        let x = ExcelHandler::xlsx();
        assert_eq!(
            x.detect(&FileProbe::from_bytes("a.xlsx", &bytes)),
            Some(Confidence(95))
        );
        assert!(x
            .detect(&FileProbe::from_bytes("a.txt", b"hello"))
            .is_none());
        let m = ExcelHandler::xlsm();
        assert_eq!(
            m.detect(&FileProbe::from_bytes("a.xlsm", &bytes)),
            Some(Confidence(95))
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.xlsm");
        std::fs::write(&p, &bytes).unwrap();
        let doc = m.open(&p).unwrap();
        assert!(matches!(m.save(&doc, &p), Err(AppError::ReadOnly)));
        let xls = ExcelHandler::xls();
        let mut ole = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        ole.extend_from_slice(&[0; 64]);
        assert_eq!(
            xls.detect(&FileProbe::from_bytes("a.xls", &ole)),
            Some(Confidence(95))
        );
        assert!(matches!(xls.save(&doc, &p), Err(AppError::ReadOnly)));
    }

    #[test]
    fn corrupt_bytes_do_not_panic() {
        let good = write_xlsx(&sample()).unwrap();
        for cut in [0usize, 10, 100, good.len() / 2, good.len() - 5] {
            let _ = read_xlsx(&good[..cut]);
        }
        let mut seed = 99u32;
        let junk: Vec<u8> = (0..3000)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        assert!(read_xlsx(&junk).is_err());
        assert!(read_xls(&junk).is_err());
        let mut flipped = good.clone();
        for i in (0..flipped.len()).step_by(37) {
            flipped[i] ^= 0xFF;
        }
        let _ = read_xlsx(&flipped);
    }

    #[test]
    fn dimension_with_huge_column_does_not_panic() {
        // Régression fuzz : `<dimension ref="A1:ZZZZZZZZZZ1">` faisait déborder calamine (u32).
        use std::io::Write;
        let parts: [(&str, &str); 5] = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:ZZZZZZZZZZ1"/><sheetData><row r="1"><c r="ZZZZZZZZZZ1"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        ];
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(&mut buf);
        for (name, body) in parts {
            zw.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
        let _ = read_xlsx(&buf.into_inner());
    }
}
