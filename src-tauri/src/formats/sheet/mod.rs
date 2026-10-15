//! Famille Tableur : csv/tsv, xlsx/xlsm/xls, ods (modèle `Workbook`).
//!
//! Conventions du modèle : `Cell.f` = formule SANS le "=" initial, syntaxe Excel anglaise à virgules
//! (`SUM(A1:B2)`) ; `rows` dense (départ en A1), lignes de longueurs variables autorisées ;
//! `Cell.fmt` = code de format de nombre Excel (ex. "0.00%") si connu ; `Sheet.col_widths` en
//! caractères Excel, `0.0` = largeur par défaut.

use std::io::{Cursor, Read};

use zip::ZipArchive;

use crate::core::limits::{
    MAX_ARCHIVE_ENTRIES, MAX_CELLS, MAX_COMPRESSION_RATIO, MAX_UNCOMPRESSED_BYTES,
};
use crate::core::model::{Cell, CellValue, DocumentModel, Sheet, Workbook};
use crate::error::{AppError, Result};

pub mod csv;
pub mod ods;
pub mod xlsx;

/// Cellule vide sans formule.
pub(crate) fn is_blank(c: &Cell) -> bool {
    c.v == CellValue::Empty && c.f.is_none()
}

/// Supprime les lignes vides de fin et vérifie `MAX_CELLS`.
pub(crate) fn finalize(sheets: &mut [Sheet]) -> Result<()> {
    let mut total = 0usize;
    for s in sheets.iter_mut() {
        while s.rows.last().is_some_and(|r| r.iter().all(is_blank)) {
            s.rows.pop();
        }
        for r in &s.rows {
            total = total.saturating_add(r.len());
            if total > MAX_CELLS {
                return Err(AppError::Limit("MAX_CELLS".into()));
            }
        }
    }
    Ok(())
}

pub(crate) fn expect_workbook(doc: &DocumentModel) -> Result<&Workbook> {
    match doc {
        DocumentModel::Sheet(wb) => Ok(wb),
        _ => Err(AppError::Unsupported),
    }
}

/// Ouvre une archive zip en vérifiant nombre d'entrées, taille et ratio de décompression.
pub(crate) fn guarded_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>> {
    let mut zip =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| AppError::Corrupt(e.to_string()))?;
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::Limit("MAX_ARCHIVE_ENTRIES".into()));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let f = zip
            .by_index_raw(i)
            .map_err(|e| AppError::Corrupt(e.to_string()))?;
        total = total.saturating_add(f.size());
        let allowed = f
            .compressed_size()
            .saturating_mul(MAX_COMPRESSION_RATIO)
            .max(1024 * 1024);
        if f.size() > allowed {
            return Err(AppError::Limit("MAX_COMPRESSION_RATIO".into()));
        }
    }
    if total > MAX_UNCOMPRESSED_BYTES {
        return Err(AppError::Limit("MAX_UNCOMPRESSED_BYTES".into()));
    }
    Ok(zip)
}

/// Lit une entrée zip en plafonnant la taille lue.
pub(crate) fn read_entry(
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    max: u64,
) -> Option<Vec<u8>> {
    let f = zip.by_name(name).ok()?;
    let mut out = Vec::new();
    f.take(max).read_to_end(&mut out).ok()?;
    Some(out)
}

/// Noms de feuilles valides et uniques (≤ `max` caractères, sans `[]:*?/\` ; Excel : 31).
pub(crate) fn sanitize_sheet_names(sheets: &[Sheet], max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, s) in sheets.iter().enumerate() {
        let mut base: String = s
            .name
            .chars()
            .map(|c| if "[]:*?/\\".contains(c) { '_' } else { c })
            .collect();
        base = base.trim_matches('\'').to_string();
        if base.trim().is_empty() {
            base = format!("Sheet{}", i + 1);
        }
        let mut name: String = base.chars().take(max).collect();
        let mut n = 2;
        while out.iter().any(|o| o.to_lowercase() == name.to_lowercase()) {
            let suffix = format!("_{n}");
            let keep = max.saturating_sub(suffix.chars().count());
            name = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
            n += 1;
        }
        out.push(name);
    }
    out
}

/// Date ISO (ODS) → numéro de série Excel (système 1900).
pub(crate) fn serial_from_iso(s: &str) -> Option<f64> {
    use chrono::{NaiveDate, NaiveDateTime, Timelike};
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some((d - epoch).num_days() as f64);
    }
    let dt = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    let days = (dt.date() - epoch).num_days() as f64;
    let secs = dt.time().num_seconds_from_midnight() as f64 + dt.time().nanosecond() as f64 / 1e9;
    Some(days + secs / 86400.0)
}

/// Numéro de série Excel → date ISO (`YYYY-MM-DD` ou `YYYY-MM-DDThh:mm:ss`).
pub(crate) fn iso_from_serial(serial: f64) -> Option<String> {
    use chrono::{Duration, NaiveDate};
    if !serial.is_finite() || serial.abs() > 3_000_000.0 {
        return None;
    }
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let ms = (serial * 86_400_000.0).round() as i64;
    let dt = epoch.checked_add_signed(Duration::milliseconds(ms))?;
    if ms.rem_euclid(86_400_000) == 0 {
        Some(dt.format("%Y-%m-%d").to_string())
    } else {
        Some(dt.format("%Y-%m-%dT%H:%M:%S").to_string())
    }
}

/// Le code de format de nombre désigne-t-il une date (hors texte entre guillemets / crochets) ?
pub(crate) fn is_date_fmt(fmt: &str) -> bool {
    let mut in_q = false;
    let mut in_b = false;
    for c in fmt.chars() {
        match c {
            '"' => in_q = !in_q,
            '[' if !in_q => in_b = true,
            ']' if !in_q => in_b = false,
            'y' | 'Y' | 'd' | 'D' if !in_q && !in_b => return true,
            _ => {}
        }
    }
    false
}

/// Parcourt un document XML en appelant `f` pour chaque élément ouvrant ou vide ; profondeur bornée.
pub(crate) fn scan_xml(
    bytes: &[u8],
    mut f: impl FnMut(&quick_xml::events::BytesStart<'_>),
) -> Result<()> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut depth = 0usize;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                depth += 1;
                if depth > crate::core::limits::MAX_DEPTH {
                    return Err(AppError::Limit("MAX_DEPTH".into()));
                }
                f(&e);
            }
            Ok(Event::Empty(e)) => f(&e),
            Ok(Event::End(_)) => depth = depth.saturating_sub(1),
            Ok(Event::Eof) => return Ok(()),
            Ok(_) => {}
            Err(e) => return Err(AppError::Corrupt(e.to_string())),
        }
        buf.clear();
    }
}

/// Valeur d'un attribut (nom complet ou local).
pub(crate) fn attr(e: &quick_xml::events::BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        let full = a.key.as_ref() == name;
        let local = a.key.local_name().as_ref() == name;
        (full || local)
            .then(|| {
                a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .ok()
                    .map(|v| v.into_owned())
            })
            .flatten()
    })
}

/// `needle` apparaît-il dans `hay` ?
pub(crate) fn bytes_contain(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// Lecture de test : `Workbook` sérialisé en JSON pour comparaison.
#[cfg(test)]
pub(crate) fn snapshot(wb: &Workbook) -> serde_json::Value {
    serde_json::to_value(&wb.sheets).unwrap_or_default()
}
