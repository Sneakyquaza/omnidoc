use std::io::Write;
use std::path::{Path, PathBuf};

use super::*;

/// Dossier source : a.txt, sub/b.txt, sub/deep/c.bin, empty/.
fn make_src(root: &Path) -> Vec<String> {
    let src = root.join("src");
    std::fs::create_dir_all(src.join("sub/deep")).unwrap();
    std::fs::create_dir_all(src.join("empty")).unwrap();
    std::fs::write(src.join("a.txt"), "hello a").unwrap();
    std::fs::write(src.join("sub/b.txt"), "hello b").unwrap();
    std::fs::write(src.join("sub/deep/c.bin"), [0u8, 1, 2, 3]).unwrap();
    vec![
        src.join("a.txt").to_string_lossy().into_owned(),
        src.join("sub").to_string_lossy().into_owned(),
        src.join("empty").to_string_lossy().into_owned(),
    ]
}

fn open(path: &Path) -> ArchiveDoc {
    let fmt = detect_fmt(path).unwrap();
    match ArchiveHandler::new(fmt).open(path).unwrap() {
        DocumentModel::Archive(a) => a,
        _ => panic!("modèle inattendu"),
    }
}

fn names(doc: &ArchiveDoc) -> Vec<&str> {
    doc.entries.iter().map(|e| e.path.as_str()).collect()
}

fn full_names() -> Vec<&'static str> {
    vec![
        "a.txt",
        "empty",
        "sub",
        "sub/b.txt",
        "sub/deep",
        "sub/deep/c.bin",
    ]
}

fn created(dir: &Path, name: &str, format: &str) -> PathBuf {
    let files = make_src(dir);
    let dest = dir.join(name);
    create(&dest, &files, format).unwrap();
    dest
}

#[test]
fn create_open_roundtrip_all_writable() {
    for (name, format) in [("t.zip", "zip"), ("t.tar", "tar"), ("t.tar.gz", "tar.gz")] {
        let dir = tempfile::tempdir().unwrap();
        let p = created(dir.path(), name, format);
        let doc = open(&p);
        assert_eq!(doc.format, format);
        assert!(doc.writable);
        assert_eq!(names(&doc), full_names(), "{format}");
        let a = doc.entries.iter().find(|e| e.path == "a.txt").unwrap();
        assert_eq!(a.size, 7);
        assert!(!a.is_dir);
        assert!(a.modified.is_some());
        assert!(doc.entries.iter().find(|e| e.path == "sub").unwrap().is_dir);
    }
}

#[test]
fn add_remove_rename() {
    for (name, format) in [("t.zip", "zip"), ("t.tar", "tar"), ("t.tgz", "tar.gz")] {
        let dir = tempfile::tempdir().unwrap();
        let p = created(dir.path(), name, format);
        // add : fichier sous un préfixe + remplacement d'une entrée existante
        let extra = dir.path().join("x.txt");
        std::fs::write(&extra, "xx").unwrap();
        add(&p, &[extra.to_string_lossy().into_owned()], "docs/more").unwrap();
        let doc = open(&p);
        assert!(names(&doc).contains(&"docs/more/x.txt"));
        std::fs::write(&extra, "yyyy").unwrap();
        add(&p, &[extra.to_string_lossy().into_owned()], "docs/more").unwrap();
        let doc = open(&p);
        let n = names(&doc)
            .iter()
            .filter(|n| **n == "docs/more/x.txt")
            .count();
        assert_eq!(n, 1);
        assert_eq!(
            doc.entries
                .iter()
                .find(|e| e.path == "docs/more/x.txt")
                .unwrap()
                .size,
            4
        );
        // rename d'un dossier
        rename(&p, "sub", "renamed").unwrap();
        let doc = open(&p);
        assert!(names(&doc).contains(&"renamed/deep/c.bin"));
        assert!(!names(&doc).iter().any(|n| n.starts_with("sub")));
        // rename vers un nom existant → erreur
        assert!(rename(&p, "a.txt", "empty").is_err());
        // remove d'un dossier = tout son contenu
        remove(&p, &["renamed".to_string(), "a.txt".to_string()]).unwrap();
        let doc = open(&p);
        assert!(!names(&doc).iter().any(|n| n.starts_with("renamed")));
        assert!(!names(&doc).contains(&"a.txt"));
        assert!(names(&doc).contains(&"empty"));
        // le contenu d'une entrée conservée est intact
        let out = read_entry(&p, "docs/more/x.txt").unwrap();
        assert_eq!(std::fs::read(out).unwrap(), b"yyyy");
    }
}

#[test]
fn extract_all_selection_and_no_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let p = created(dir.path(), "t.zip", "zip");
    let out = dir.path().join("out");
    assert_eq!(extract(&p, None, &out).unwrap(), 3);
    assert_eq!(std::fs::read(out.join("sub/b.txt")).unwrap(), b"hello b");
    assert!(out.join("empty").is_dir());
    // 2e extraction : pas d'écrasement
    assert_eq!(extract(&p, None, &out).unwrap(), 3);
    assert_eq!(std::fs::read(out.join("a (1).txt")).unwrap(), b"hello a");
    // sélection d'un dossier
    let out2 = dir.path().join("out2");
    let n = extract(&p, Some(vec!["sub".into()]), &out2).unwrap();
    assert_eq!(n, 2);
    assert!(!out2.join("a.txt").exists());
    assert!(out2.join("sub/deep/c.bin").exists());
}

#[test]
fn read_entry_writes_temp_copy() {
    let dir = tempfile::tempdir().unwrap();
    let p = created(dir.path(), "t.tar.gz", "tar.gz");
    let path = read_entry(&p, "sub/b.txt").unwrap();
    assert!(path.ends_with("b.txt"));
    assert_eq!(std::fs::read(&path).unwrap(), b"hello b");
    assert!(matches!(
        read_entry(&p, "nope.txt"),
        Err(AppError::NotFound)
    ));
    assert!(read_entry(&p, "../etc/passwd").is_err());
}

#[test]
fn convert_between_formats() {
    let dir = tempfile::tempdir().unwrap();
    let z = created(dir.path(), "t.zip", "zip");
    let tg = dir.path().join("c.tar.gz");
    convert(&z, &tg, "tar.gz").unwrap();
    assert_eq!(names(&open(&tg)), full_names());
    let z2 = dir.path().join("c.zip");
    convert(&tg, &z2, "zip").unwrap();
    assert_eq!(names(&open(&z2)), full_names());
    let out = read_entry(&z2, "sub/b.txt").unwrap();
    assert_eq!(std::fs::read(out).unwrap(), b"hello b");
    assert!(convert(&z, &z2, "7z").is_err());
}

fn zip_with_names(path: &Path, entries: &[(&str, &[u8])]) {
    let f = std::fs::File::create(path).unwrap();
    let mut zw = ::zip::ZipWriter::new(f);
    for (n, d) in entries {
        zw.start_file(*n, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(d).unwrap();
    }
    zw.finish().unwrap();
}

#[test]
fn zip_slip_entries_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("evil.zip");
    zip_with_names(
        &p,
        &[
            ("../evil.txt", b"x"),
            ("/abs.txt", b"x"),
            ("C:/win.txt", b"x"),
            ("a\\b.txt", b"x"),
            ("ok/fine.txt", b"fine"),
        ],
    );
    assert_eq!(names(&open(&p)), vec!["ok/fine.txt"]);
    let out = dir.path().join("o/p");
    assert_eq!(extract(&p, None, &out).unwrap(), 1);
    assert!(!dir.path().join("o/evil.txt").exists());
    assert!(!dir.path().join("evil.txt").exists());
    assert!(out.join("ok/fine.txt").exists());
}

fn tar_bytes(entries: &[(&[u8], EntryKind)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, kind) in entries {
        let mut h = ::tar::Header::new_gnu();
        h.set_mode(0o644);
        h.set_size(0);
        match kind {
            EntryKind::File => h.set_entry_type(::tar::EntryType::Regular),
            EntryKind::Symlink(t) => {
                h.set_entry_type(::tar::EntryType::Symlink);
                h.as_old_mut().linkname[..t.len()].copy_from_slice(t.as_bytes());
            }
        }
        h.as_old_mut().name[..name.len()].copy_from_slice(name);
        h.set_cksum();
        out.extend_from_slice(h.as_bytes());
    }
    out.extend_from_slice(&[0u8; 1024]);
    out
}

enum EntryKind {
    File,
    Symlink(&'static str),
}

#[test]
fn tar_slip_and_symlinks_are_not_extracted() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("evil.tar");
    let data = tar_bytes(&[
        (b"../evil.txt", EntryKind::File),
        (b"link", EntryKind::Symlink("/etc")),
        (b"link2", EntryKind::Symlink("../../x")),
        (b"good.txt", EntryKind::File),
    ]);
    std::fs::write(&p, data).unwrap();
    let doc = open(&p);
    assert_eq!(names(&doc), vec!["good.txt", "link", "link2"]);
    let out = dir.path().join("out");
    assert_eq!(extract(&p, None, &out).unwrap(), 1);
    assert!(out.join("good.txt").exists());
    assert!(!out.join("link").exists());
    assert!(!dir.path().join("evil.txt").exists());
}

#[test]
fn zip_bomb_is_stopped_by_ratio() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("bomb.zip");
    // 40 Mio de zéros : ratio deflate ~1030 > 1000 (+ marge de 64 Kio).
    let f = std::fs::File::create(&p).unwrap();
    let mut zw = ::zip::ZipWriter::new(f);
    zw.start_file(
        "zeros.bin",
        ::zip::write::SimpleFileOptions::default()
            .compression_method(::zip::CompressionMethod::Deflated),
    )
    .unwrap();
    let chunk = vec![0u8; 1 << 20];
    for _ in 0..40 {
        zw.write_all(&chunk).unwrap();
    }
    zw.finish().unwrap();
    let out = dir.path().join("out");
    assert!(matches!(extract(&p, None, &out), Err(AppError::Limit(_))));
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0);
    assert!(matches!(
        read_entry(&p, "zeros.bin"),
        Err(AppError::Limit(_))
    ));
}

#[test]
fn targz_bomb_is_stopped_by_ratio() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("bomb.tar.gz");
    let f = std::fs::File::create(&p).unwrap();
    let gz = flate2::write::GzEncoder::new(f, flate2::Compression::best());
    let mut b = ::tar::Builder::new(gz);
    let size = 60u64 << 20;
    let mut h = ::tar::Header::new_gnu();
    h.set_size(size);
    h.set_mode(0o644);
    b.append_data(&mut h, "zeros.bin", std::io::repeat(0).take(size))
        .unwrap();
    b.into_inner().unwrap().finish().unwrap();
    // Même la simple liste décompresse le flux : elle doit être bornée.
    let fmt = detect_fmt(&p).unwrap();
    assert_eq!(fmt, Fmt::TarGz);
    assert!(matches!(list(&p, fmt), Err(AppError::Limit(_))));
}

#[test]
fn gz_single_entry() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("notes.txt.gz");
    let f = std::fs::File::create(&p).unwrap();
    let mut gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    gz.write_all(b"some text").unwrap();
    gz.finish().unwrap();
    let doc = open(&p);
    assert_eq!(doc.format, "gz");
    assert!(!doc.writable);
    assert_eq!(names(&doc), vec!["notes.txt"]);
    assert_eq!(doc.entries[0].size, 9);
    let out = dir.path().join("out");
    assert_eq!(extract(&p, None, &out).unwrap(), 1);
    assert_eq!(std::fs::read(out.join("notes.txt")).unwrap(), b"some text");
    assert!(matches!(add(&p, &[], ""), Err(AppError::ReadOnly)));
}

#[test]
fn sevenz_read_and_readonly() {
    let dir = tempfile::tempdir().unwrap();
    make_src(dir.path());
    let p = dir.path().join("t.7z");
    sevenz_rust2::compress_to_path(dir.path().join("src"), &p).unwrap();
    let doc = open(&p);
    assert_eq!(doc.format, "7z");
    assert!(!doc.writable);
    let n = names(&doc);
    assert!(n.iter().any(|e| e.ends_with("a.txt")));
    assert!(n.iter().any(|e| e.ends_with("sub/deep/c.bin")));
    let out = dir.path().join("out");
    let count = extract(&p, None, &out).unwrap();
    assert_eq!(count, 3);
    let entry = n.iter().find(|e| e.ends_with("sub/b.txt")).unwrap();
    let tmp = read_entry(&p, entry).unwrap();
    assert_eq!(std::fs::read(tmp).unwrap(), b"hello b");
    assert!(matches!(remove(&p, &["x".into()]), Err(AppError::ReadOnly)));
    // 7z → zip
    let z = dir.path().join("from7z.zip");
    convert(&p, &z, "zip").unwrap();
    assert_eq!(open(&z).entries.len(), doc.entries.len());
}

#[test]
fn detection() {
    let dir = tempfile::tempdir().unwrap();
    let z = created(dir.path(), "t.zip", "zip");
    let probe = FileProbe::from_path(&z).unwrap();
    assert_eq!(Fmt::Zip.detect(&probe), Some(Confidence(90)));
    assert_eq!(Fmt::SevenZ.detect(&probe), None);
    // PK sans extension d'archive (ex. docx) : repli bas
    let head = FileProbe::from_bytes("x.docx", b"PK\x03\x04rest");
    assert_eq!(Fmt::Zip.detect(&head), Some(Confidence(50)));
    let tgz = created(dir.path(), "t.tar.gz", "tar.gz");
    let probe = FileProbe::from_path(&tgz).unwrap();
    assert_eq!(Fmt::TarGz.detect(&probe), Some(Confidence(90)));
    assert!(Fmt::Gz.detect(&probe).unwrap().0 < 90);
    let tar = created(dir.path(), "t.tar", "tar");
    let probe = FileProbe::from_path(&tar).unwrap();
    assert_eq!(Fmt::Tar.detect(&probe), Some(Confidence(90)));
    let sz = FileProbe::from_bytes("a.7z", &[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C, 0]);
    assert_eq!(Fmt::SevenZ.detect(&sz), Some(Confidence(90)));
    assert_eq!(
        Fmt::Zip.detect(&FileProbe::from_bytes("a.txt", b"hello")),
        None
    );
}

#[test]
fn garbage_and_truncation_never_panic() {
    let dir = tempfile::tempdir().unwrap();
    let mut sources = Vec::new();
    for (n, f) in [("t.zip", "zip"), ("t.tar", "tar"), ("t.tar.gz", "tar.gz")] {
        sources.push(std::fs::read(created(dir.path(), n, f)).unwrap());
    }
    make_src(dir.path());
    let sz = dir.path().join("t.7z");
    sevenz_rust2::compress_to_path(dir.path().join("src"), &sz).unwrap();
    sources.push(std::fs::read(&sz).unwrap());
    let mut seed = 0x1234_5678u32;
    for (i, src) in sources.iter().enumerate() {
        let mut variants: Vec<Vec<u8>> = (0..src.len())
            .step_by(37)
            .map(|cut| src[..cut].to_vec())
            .collect();
        for _ in 0..30 {
            let mut v = src.clone();
            for _ in 0..8 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let idx = (seed as usize) % v.len();
                v[idx] ^= (seed >> 24) as u8 | 1;
            }
            variants.push(v);
        }
        for (j, bytes) in variants.iter().enumerate() {
            for fmt in Fmt::ALL {
                let f = dir.path().join(format!("g{i}_{j}.bin"));
                std::fs::write(&f, bytes).unwrap();
                let _ = list(&f, fmt);
                let _ = extract(&f, None, &dir.path().join("gout"));
                let _ = read_entry(&f, "a.txt");
            }
        }
    }
}
