//! Zip : lecture (limites en flux) et réécriture avec copie brute des entrées inchangées.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read};
use std::path::Path;

use chrono::{Datelike, Timelike};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::safety::{io_to_app, max_for_compressed, normalize_entry_path, Budget, LimitedReader};
use super::{Action, Flow, Item, Kind, Sink, StreamMeta, Visitor};
use crate::error::{AppError, Result};

fn zip_err(e: ZipError) -> AppError {
    match e {
        ZipError::Io(e) => io_to_app(e),
        ZipError::InvalidPassword | ZipError::UnsupportedArchive(_) => AppError::Unsupported,
        other => AppError::Corrupt(other.to_string()),
    }
}

fn to_epoch(dt: zip::DateTime) -> Option<i64> {
    chrono::NaiveDate::from_ymd_opt(
        i32::from(dt.year()),
        u32::from(dt.month()),
        u32::from(dt.day()),
    )?
    .and_hms_opt(
        u32::from(dt.hour()),
        u32::from(dt.minute()),
        u32::from(dt.second()),
    )
    .map(|n| n.and_utc().timestamp())
}

fn from_epoch(t: Option<i64>) -> zip::DateTime {
    let Some(d) = t.and_then(|t| chrono::DateTime::from_timestamp(t, 0)) else {
        return zip::DateTime::default();
    };
    let d = d.naive_utc();
    u16::try_from(d.year())
        .ok()
        .and_then(|y| {
            zip::DateTime::from_date_and_time(
                y,
                d.month() as u8,
                d.day() as u8,
                d.hour() as u8,
                d.minute() as u8,
                d.second() as u8,
            )
            .ok()
        })
        .unwrap_or_default()
}

fn item_of<R: Read>(file: &zip::read::ZipFile<'_, R>) -> Option<Item> {
    let path = normalize_entry_path(&file.name().ok()?)?;
    let kind = if file.is_dir() {
        Kind::Dir
    } else if file.is_symlink() {
        Kind::Symlink
    } else {
        Kind::File
    };
    Some(Item {
        path,
        kind,
        size: file.size(),
        compressed: Some(file.compressed_size()),
        mtime: file.last_modified().and_then(to_epoch),
        mode: file.unix_mode(),
        uid: 0,
        gid: 0,
        link: None,
    })
}

pub fn visit(path: &Path, want_data: bool, f: &mut Visitor) -> Result<()> {
    let mut ar = ZipArchive::new(BufReader::new(File::open(path)?)).map_err(zip_err)?;
    let mut budget = Budget::default();
    for i in 0..ar.len() {
        budget.entry()?;
        let item = {
            let raw = ar.by_index_raw(i).map_err(zip_err)?;
            match item_of(&raw) {
                Some(item) => item,
                None => continue,
            }
        };
        let flow = if want_data && item.kind == Kind::File {
            let file = ar.by_index(i).map_err(zip_err)?;
            let max = max_for_compressed(file.compressed_size()).min(budget.remaining_bytes());
            let mut reader = LimitedReader::new(file, max);
            let flow = f(&item, &mut reader)?;
            budget.add_bytes(reader.bytes_read())?;
            flow
        } else {
            f(&item, &mut io::empty())?
        };
        if matches!(flow, Flow::Stop) {
            break;
        }
    }
    Ok(())
}

pub struct ZipSink<'a> {
    zw: ZipWriter<BufWriter<&'a File>>,
}

impl<'a> ZipSink<'a> {
    pub fn new(file: &'a File) -> Self {
        Self {
            zw: ZipWriter::new(BufWriter::new(file)),
        }
    }

    /// Copie brute (sans recompression) des entrées de `old`, filtrées/renommées par `decide`.
    pub fn raw_rewrite(
        &mut self,
        old: &Path,
        decide: &mut dyn FnMut(&str) -> Action,
        skip: &HashSet<&str>,
    ) -> Result<()> {
        let mut ar = ZipArchive::new(BufReader::new(File::open(old)?)).map_err(zip_err)?;
        let mut budget = Budget::default();
        for i in 0..ar.len() {
            budget.entry()?;
            let file = ar.by_index_raw(i).map_err(zip_err)?;
            // Chemin rejeté (`..`, `\`…) : recopié tel quel, jamais extrait, pour ne rien perdre.
            let Some(norm) = normalize_entry_path(&file.name().unwrap_or_default()) else {
                self.zw.raw_copy_file(file).map_err(zip_err)?;
                continue;
            };
            if super::skipped(skip, &norm) {
                continue;
            }
            match decide(&norm) {
                Action::Drop => {}
                Action::Keep => self.zw.raw_copy_file(file).map_err(zip_err)?,
                Action::Rename(to) => {
                    let name = if file.is_dir() { format!("{to}/") } else { to };
                    self.zw.raw_copy_file_rename(file, name).map_err(zip_err)?
                }
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Result<()> {
        let mut w = self.zw.finish().map_err(zip_err)?;
        io::Write::flush(&mut w)?;
        Ok(())
    }

    fn options(meta: &StreamMeta) -> SimpleFileOptions {
        let mut opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(from_epoch(meta.mtime))
            .large_file(meta.size > u64::from(u32::MAX));
        if let Some(mode) = meta.mode {
            opts = opts.unix_permissions(mode & 0o7777);
        }
        opts
    }
}

impl Sink for ZipSink<'_> {
    fn dir(&mut self, name: &str, meta: &StreamMeta) -> Result<()> {
        self.zw
            .add_directory(name, Self::options(meta))
            .map_err(zip_err)
    }

    fn stream(&mut self, name: &str, meta: &StreamMeta, data: &mut dyn Read) -> Result<()> {
        self.zw
            .start_file(name, Self::options(meta))
            .map_err(zip_err)?;
        io::copy(data, &mut self.zw).map_err(io_to_app)?;
        Ok(())
    }

    /// Les liens ne sont pas écrits dans un zip.
    fn link(&mut self, _name: &str, _target: &str, _hard: bool) -> Result<()> {
        Ok(())
    }
}
