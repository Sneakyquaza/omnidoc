//! 7z : lecture seule (liste, extraction).

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use sevenz_rust2::{Archive, ArchiveEntry, ArchiveReader, Password};

use super::safety::{max_for_compressed, normalize_entry_path, Budget, LimitedReader};
use super::{Flow, Item, Kind, Visitor};
use crate::error::{AppError, Result};

fn sz_err(e: sevenz_rust2::Error) -> AppError {
    match e {
        sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_) => {
            AppError::Unsupported
        }
        sevenz_rust2::Error::FileOpen(e, _) | sevenz_rust2::Error::Io(e, _) => {
            super::safety::io_to_app(e)
        }
        other => AppError::Corrupt(other.to_string()),
    }
}

/// Secondes epoch depuis un FILETIME Windows (100 ns depuis 1601).
fn epoch_of(e: &ArchiveEntry) -> Option<i64> {
    if !e.has_last_modified_date {
        return None;
    }
    let ticks = u64::from(e.last_modified_date);
    i64::try_from(ticks / 10_000_000)
        .ok()?
        .checked_sub(11_644_473_600)
}

fn item_of(e: &ArchiveEntry) -> Option<Item> {
    if e.is_anti_item {
        return None;
    }
    let path = normalize_entry_path(&e.name)?;
    // Les attributs Unix sont dans les 16 bits hauts quand le bit 0x8000 est posé.
    let unix_mode = (e.has_windows_attributes && e.windows_attributes & 0x8000 != 0)
        .then_some(e.windows_attributes >> 16);
    let kind = if e.is_directory {
        Kind::Dir
    } else if unix_mode.is_some_and(|m| m & 0o170000 == 0o120000) {
        Kind::Symlink
    } else {
        Kind::File
    };
    Some(Item {
        path,
        kind,
        size: e.size,
        compressed: (e.compressed_size > 0).then_some(e.compressed_size),
        mtime: epoch_of(e),
        mode: unix_mode.map(|m| m & 0o7777),
        uid: 0,
        gid: 0,
        link: None,
    })
}

pub fn visit(path: &Path, want_data: bool, f: &mut Visitor) -> Result<()> {
    if !want_data {
        let archive = Archive::open(path).map_err(sz_err)?;
        let mut budget = Budget::default();
        for e in &archive.files {
            budget.entry()?;
            if let Some(item) = item_of(e) {
                if matches!(f(&item, &mut io::empty())?, Flow::Stop) {
                    break;
                }
            }
        }
        return Ok(());
    }
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut reader = ArchiveReader::new(BufReader::new(file), Password::empty()).map_err(sz_err)?;
    let mut budget = Budget::default();
    let mut failure: Option<AppError> = None;
    let mut used = 0u64;
    let res = reader.for_each_entries(|e, data| {
        let step = (|| -> Result<bool> {
            budget.entry()?;
            let Some(item) = item_of(e) else {
                return Ok(true);
            };
            // Pas de taille compressée fiable par entrée (blocs solides) : limite globale.
            let max = max_for_compressed(size)
                .saturating_sub(used)
                .min(budget.remaining_bytes());
            let mut limited = LimitedReader::new(data, max);
            let flow = f(&item, &mut limited)?;
            used += limited.bytes_read();
            budget.add_bytes(limited.bytes_read())?;
            Ok(matches!(flow, Flow::Continue))
        })();
        match step {
            Ok(cont) => Ok(cont),
            Err(err) => {
                failure = Some(err);
                Ok(false)
            }
        }
    });
    if let Some(err) = failure {
        return Err(err);
    }
    res.map_err(sz_err)
}
