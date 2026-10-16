//! Tar, tar.gz et gz simple (une seule entrée).

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use tar::{Builder, EntryType, Header};

use super::safety::{io_to_app, max_for_compressed, normalize_entry_path, Budget, LimitedReader};
use super::{Action, Flow, Item, Kind, Sink, StreamMeta, Visitor};
use crate::error::{AppError, Result};

/// Vrai si le début décompressé d'un flux gzip ressemble à une archive tar (`ustar`).
pub fn gz_contains_tar(head: &[u8]) -> bool {
    if !head.starts_with(&[0x1F, 0x8B]) {
        return false;
    }
    let mut buf = Vec::new();
    let _ = MultiGzDecoder::new(head).take(512).read_to_end(&mut buf);
    buf.get(257..262) == Some(b"ustar")
}

fn open_reader(file: File, size: u64, gz: bool) -> Box<dyn Read> {
    if gz {
        Box::new(LimitedReader::new(
            MultiGzDecoder::new(BufReader::new(file)),
            max_for_compressed(size),
        ))
    } else {
        Box::new(BufReader::new(file))
    }
}

pub fn visit(path: &Path, gz: bool, _want_data: bool, f: &mut Visitor) -> Result<()> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let reader = open_reader(file, size, gz);
    let mut archive = tar::Archive::new(reader);
    let mut budget = Budget::default();
    for entry in archive.entries().map_err(io_to_app)? {
        let mut entry = entry.map_err(io_to_app)?;
        budget.entry()?;
        let header = entry.header();
        let kind = match header.entry_type() {
            EntryType::Regular | EntryType::Continuous => Kind::File,
            EntryType::Directory => Kind::Dir,
            EntryType::Symlink => Kind::Symlink,
            EntryType::Link => Kind::Hardlink,
            _ => continue,
        };
        let raw = entry.path().map_err(io_to_app)?;
        let Some(path) = normalize_entry_path(&raw.to_string_lossy()) else {
            continue;
        };
        let item = Item {
            path,
            kind,
            size: entry.size(),
            compressed: None,
            mtime: header.mtime().ok().and_then(|t| i64::try_from(t).ok()),
            mode: header.mode().ok(),
            uid: header.uid().unwrap_or(0),
            gid: header.gid().unwrap_or(0),
            link: entry
                .link_name()
                .ok()
                .flatten()
                .map(|l| l.to_string_lossy().into_owned()),
        };
        if matches!(f(&item, &mut entry)?, Flow::Stop) {
            break;
        }
    }
    Ok(())
}

/// gzip simple : une entrée, nommée d'après le fichier sans `.gz`.
pub fn visit_gz(path: &Path, want_data: bool, f: &mut Visitor) -> Result<()> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut head = [0u8; 10];
    file.read_exact(&mut head)
        .map_err(|_| AppError::Corrupt("gzip".into()))?;
    let mtime = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    // ISIZE : taille d'origine modulo 2^32, dans les 4 derniers octets.
    let mut isize_bytes = [0u8; 4];
    file.seek(SeekFrom::End(-4))?;
    file.read_exact(&mut isize_bytes)?;
    file.seek(SeekFrom::Start(0))?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = match file_name.len().checked_sub(3) {
        Some(cut)
            if file_name.is_char_boundary(cut) && file_name[cut..].eq_ignore_ascii_case(".gz") =>
        {
            &file_name[..cut]
        }
        _ => file_name.as_str(),
    };
    let name = normalize_entry_path(stem).unwrap_or_else(|| "data".to_string());
    let item = Item {
        path: name,
        kind: Kind::File,
        size: u64::from(u32::from_le_bytes(isize_bytes)),
        compressed: Some(size),
        mtime: (mtime != 0).then_some(i64::from(mtime)),
        mode: None,
        uid: 0,
        gid: 0,
        link: None,
    };
    if want_data {
        let mut reader = LimitedReader::new(
            MultiGzDecoder::new(BufReader::new(file)),
            max_for_compressed(size),
        );
        f(&item, &mut reader)?;
    } else {
        f(&item, &mut io::empty())?;
    }
    Ok(())
}

#[allow(clippy::large_enum_variant)]
enum Out<'a> {
    Plain(BufWriter<&'a File>),
    Gz(GzEncoder<BufWriter<&'a File>>),
}

impl Write for Out<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Out::Plain(w) => w.write(buf),
            Out::Gz(w) => w.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Out::Plain(w) => w.flush(),
            Out::Gz(w) => w.flush(),
        }
    }
}

pub struct TarSink<'a> {
    builder: Builder<Out<'a>>,
}

impl<'a> TarSink<'a> {
    pub fn new(file: &'a File, gz: bool) -> Self {
        let w = BufWriter::new(file);
        let out = if gz {
            Out::Gz(GzEncoder::new(w, Compression::default()))
        } else {
            Out::Plain(w)
        };
        Self {
            builder: Builder::new(out),
        }
    }

    pub fn finish(self) -> Result<()> {
        match self.builder.into_inner()? {
            Out::Plain(mut w) => w.flush()?,
            Out::Gz(g) => g.finish()?.flush()?,
        }
        Ok(())
    }

    /// Recopie tar -> tar en conservant tous les types d'entrées (FIFO, périphériques…) et
    /// les chemins rejetés (recopiés tels quels, jamais extraits).
    pub fn raw_rewrite(
        &mut self,
        old: &Path,
        gz: bool,
        decide: &mut dyn FnMut(&str) -> Action,
        skip: &HashSet<&str>,
    ) -> Result<()> {
        let file = File::open(old)?;
        let size = file.metadata()?.len();
        let mut archive = tar::Archive::new(open_reader(file, size, gz));
        let mut budget = Budget::default();
        for entry in archive.entries().map_err(io_to_app)? {
            let mut entry = entry.map_err(io_to_app)?;
            budget.entry()?;
            let raw = entry
                .path()
                .map_err(io_to_app)?
                .to_string_lossy()
                .into_owned();
            let mut h = entry.header().clone();
            let name = match normalize_entry_path(&raw) {
                None => {
                    // Chemin rejeté : en-tête recopié tel quel (set_path refuserait `..`).
                    self.builder.append(&h, &mut entry).map_err(io_to_app)?;
                    continue;
                }
                Some(norm) => {
                    if super::skipped(skip, &norm) {
                        continue;
                    }
                    match decide(&norm) {
                        Action::Drop => continue,
                        Action::Keep => norm,
                        Action::Rename(to) => to,
                    }
                }
            };
            let kind = h.entry_type();
            if kind.is_dir() {
                let name = format!("{}/", name.trim_end_matches('/'));
                self.builder
                    .append_data(&mut h, name, io::empty())
                    .map_err(io_to_app)?;
            } else if kind.is_symlink() || kind.is_hard_link() {
                let target = entry
                    .link_name()
                    .map_err(io_to_app)?
                    .map(|l| l.into_owned())
                    .unwrap_or_default();
                self.builder
                    .append_link(&mut h, name, target)
                    .map_err(io_to_app)?;
            } else {
                self.builder
                    .append_data(&mut h, name, &mut entry)
                    .map_err(io_to_app)?;
            }
        }
        Ok(())
    }

    fn header(meta: &StreamMeta, kind: EntryType, default_mode: u32) -> Header {
        let mut h = Header::new_gnu();
        h.set_entry_type(kind);
        h.set_size(if kind == EntryType::Regular {
            meta.size
        } else {
            0
        });
        h.set_mode(meta.mode.unwrap_or(default_mode));
        h.set_mtime(u64::try_from(meta.mtime.unwrap_or(0)).unwrap_or(0));
        h.set_uid(meta.uid);
        h.set_gid(meta.gid);
        h
    }
}

impl Sink for TarSink<'_> {
    fn dir(&mut self, name: &str, meta: &StreamMeta) -> Result<()> {
        let mut h = Self::header(meta, EntryType::Directory, 0o755);
        self.builder
            .append_data(&mut h, format!("{name}/"), io::empty())
            .map_err(io_to_app)
    }

    fn stream(&mut self, name: &str, meta: &StreamMeta, data: &mut dyn Read) -> Result<()> {
        let mut h = Self::header(meta, EntryType::Regular, 0o644);
        self.builder
            .append_data(&mut h, name, data)
            .map_err(io_to_app)
    }

    fn link(&mut self, name: &str, target: &str, hard: bool) -> Result<()> {
        let kind = if hard {
            EntryType::Link
        } else {
            EntryType::Symlink
        };
        let mut h = Self::header(
            &StreamMeta {
                size: 0,
                mode: None,
                mtime: None,
                uid: 0,
                gid: 0,
            },
            kind,
            0o777,
        );
        self.builder
            .append_link(&mut h, name, target)
            .map_err(io_to_app)
    }
}
