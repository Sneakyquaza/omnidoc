use super::*;

/// WAV PCM 8 bits mono 8 kHz, `secs` secondes de silence.
fn wav_bytes(secs: u32) -> Vec<u8> {
    let rate = 8000u32;
    let data_len = rate * secs;
    let mut v = Vec::new();
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes()); // byte rate
    v.extend_from_slice(&1u16.to_le_bytes()); // block align
    v.extend_from_slice(&8u16.to_le_bytes()); // bits
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    v.extend(std::iter::repeat_n(0x80u8, data_len as usize));
    v
}

/// FLAC minimal : marqueur + STREAMINFO (aucune trame audio), 1 s à 44,1 kHz.
fn flac_bytes() -> Vec<u8> {
    let mut v = b"fLaC".to_vec();
    v.extend_from_slice(&[0x80, 0, 0, 34]); // dernier bloc, STREAMINFO, 34 octets
    v.extend_from_slice(&4096u16.to_be_bytes()); // min block size
    v.extend_from_slice(&4096u16.to_be_bytes()); // max block size
    v.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // frame sizes
                                              // 44100 Hz (20 bits), canaux-1 (3 bits), bits-1 (5 bits), 44100 échantillons (36 bits)
    let packed: u64 = (44100u64 << 44) | (15u64 << 36) | 44100u64;
    v.extend_from_slice(&packed.to_be_bytes());
    v.extend_from_slice(&[0u8; 16]); // MD5
    v
}

fn open_doc(path: &Path) -> MediaDoc {
    match MediaHandler.open(path).unwrap() {
        DocumentModel::Media(m) => m,
        _ => panic!("modèle inattendu"),
    }
}

fn kv(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: value.into(),
    }
}

fn get<'a>(doc: &'a MediaDoc, key: &str) -> Option<&'a str> {
    doc.tags
        .iter()
        .find(|t| t.key == key)
        .map(|t| t.value.as_str())
}

#[test]
fn wav_duration_and_detection() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.wav");
    std::fs::write(&p, wav_bytes(2)).unwrap();
    let doc = open_doc(&p);
    assert_eq!(doc.duration_ms, Some(2000));
    assert!(doc.mime.starts_with("audio/"));
    let probe = FileProbe::from_path(&p).unwrap();
    assert_eq!(MediaHandler.detect(&probe), Some(Confidence(90)));
    let by_ext = FileProbe::from_bytes("x.mkv", b"not really");
    assert_eq!(MediaHandler.detect(&by_ext), Some(Confidence(60)));
    let other = FileProbe::from_bytes("x.txt", b"hi");
    assert_eq!(MediaHandler.detect(&other), None);
}

#[test]
fn wav_tags_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.wav");
    std::fs::write(&p, wav_bytes(1)).unwrap();
    let mut doc = open_doc(&p);
    assert!(doc.tags.is_empty());
    doc.tags = vec![
        kv("title", "Titre é"),
        kv("artist", "Artiste"),
        kv("album", "Album"),
        kv("genre", "Jazz"),
        kv("comment", "Salut"),
    ];
    MediaHandler.save(&DocumentModel::Media(doc), &p).unwrap();
    let again = open_doc(&p);
    assert_eq!(again.duration_ms, Some(1000));
    assert_eq!(get(&again, "title"), Some("Titre é"));
    assert_eq!(get(&again, "artist"), Some("Artiste"));
    assert_eq!(get(&again, "album"), Some("Album"));
    assert_eq!(get(&again, "genre"), Some("Jazz"));
    // modification + suppression d'un tag vidé
    let mut m = again.clone();
    m.tags.retain(|t| t.key != "genre");
    for t in &mut m.tags {
        if t.key == "title" {
            t.value = "Autre".into();
        }
        if t.key == "comment" {
            t.value.clear();
        }
    }
    MediaHandler.save(&DocumentModel::Media(m), &p).unwrap();
    let last = open_doc(&p);
    assert_eq!(get(&last, "title"), Some("Autre"));
    assert_eq!(get(&last, "genre"), None);
    assert_eq!(get(&last, "comment"), None);
    assert_eq!(get(&last, "artist"), Some("Artiste"));
    assert_eq!(last.duration_ms, Some(1000));
    // aucun fichier temporaire résiduel
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn flac_tags_roundtrip_and_cover() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.flac");
    std::fs::write(&p, flac_bytes()).unwrap();
    let mut doc = open_doc(&p);
    assert_eq!(doc.duration_ms, Some(1000));
    doc.tags = vec![
        kv("title", "T"),
        kv("artist", "A"),
        kv("album", "Al"),
        kv("albumArtist", "AA"),
        kv("year", "2024"),
        kv("track", "3"),
        kv("trackTotal", "12"),
        kv("disc", "1"),
        kv("genre", "G"),
        kv("composer", "C"),
        kv("lyrics", "la la"),
    ];
    MediaHandler
        .save(&DocumentModel::Media(doc.clone()), &p)
        .unwrap();
    let back = open_doc(&p);
    for t in &doc.tags {
        assert_eq!(get(&back, &t.key), Some(t.value.as_str()), "{}", t.key);
    }
    assert_eq!(back.pictures, 0);
    assert_eq!(cover_data_uri(&p).unwrap(), None);
    // pochette : PNG 1x1
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 13, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9C, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0, 5, 0xFE, 2, 0xFE, 0xA7, 0x35, 0x81,
        0x84, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let img = dir.path().join("c.png");
    std::fs::write(&img, png).unwrap();
    let pic = Picture::from_reader(&mut std::fs::File::open(&img).unwrap()).unwrap();
    edit_tags(&p, |tag| {
        tag.push_picture(pic);
        Ok(())
    })
    .unwrap();
    assert_eq!(open_doc(&p).pictures, 1);
    let uri = cover_data_uri(&p).unwrap().unwrap();
    assert!(uri.starts_with("data:image/png;base64,"));
    assert_eq!(get(&open_doc(&p), "title"), Some("T"));
    edit_tags(&p, |tag| {
        while tag.picture_count() > 0 {
            tag.remove_picture(0);
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(open_doc(&p).pictures, 0);
}

#[test]
fn unsupported_container_is_readonly_and_empty() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("clip.mkv");
    std::fs::write(&p, [0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0]).unwrap();
    let doc = open_doc(&p);
    assert!(doc.tags.is_empty());
    assert_eq!(doc.duration_ms, None);
    assert!(doc.mime.starts_with("video/"));
    assert!(matches!(
        MediaHandler.save(&DocumentModel::Media(doc), &p),
        Err(AppError::ReadOnly)
    ));
}

#[test]
fn garbage_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let good = wav_bytes(1);
    let mut seed = 7u32;
    for i in 0..60 {
        let mut v = good[..(i * 53).min(good.len())].to_vec();
        for _ in 0..4 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            if !v.is_empty() {
                let idx = (seed as usize) % v.len();
                v[idx] ^= 0xA5;
            }
        }
        for name in ["g.wav", "g.mp3", "g.flac", "g.ogg", "g.m4a", "g.mp4"] {
            let f = dir.path().join(name);
            std::fs::write(&f, &v).unwrap();
            let _ = MediaHandler.open(&f);
            let _ = cover_data_uri(&f);
        }
    }
}

#[test]
fn ffmpeg_helpers() {
    assert_eq!(seconds(1500), "1.500");
    assert_eq!(seconds(61_007), "61.007");
    assert!(matches!(
        run_ffmpeg_missing(),
        Err(AppError::External(_)) | Ok(())
    ));
}

/// Sans ffmpeg dans le PATH : `External`. Avec : un fichier invalide échoue aussi en `External`.
fn run_ffmpeg_missing() -> Result<()> {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("in.wav");
    std::fs::write(&src, b"not audio").unwrap();
    let dest = dir.path().join("out.wav");
    let res = run_ffmpeg(&[], &src, &[], &dest, ".wav");
    assert!(!dest.exists());
    res
}

#[test]
fn playlists_are_refused_before_ffmpeg() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.wav");
    for (name, body) in [
        ("a.m3u8", &b"#EXTM3U\nhttp://x/y"[..]),
        ("b.wav", b"ffconcat version 1.0\nfile /etc/passwd"),
        ("c.txt", b"#EXTM3U\n"),
    ] {
        let src = dir.path().join(name);
        std::fs::write(&src, body).unwrap();
        assert!(
            matches!(
                run_ffmpeg(&[], &src, &[], &dest, ".wav"),
                Err(AppError::Unsupported)
            ),
            "{name}"
        );
    }
}

#[test]
fn corrupt_adts_does_not_hang() {
    // Régression fuzz : flux AAC (ADTS) corrompu qui faisait boucler `lofty` indéfiniment.
    let data: &[u8] = &[
        0xd2, 0xd2, 0x2e, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xfe, 0xff, 0xff, 0xff, 0x00,
        0x00, 0x01, 0x84, 0x00, 0x10, 0x00, 0x77, 0x61, 0x00, 0x90, 0xff, 0xff, 0x00, 0x00, 0x00,
        0x0c, 0xff, 0xff, 0xff, 0x00, 0x00, 0x01, 0x84, 0x00, 0x10, 0x00, 0x77, 0x64, 0x69, 0x6f,
        0x2f, 0x64, 0x1f, 0x00, 0x61, 0x69, 0x66, 0x66, 0x45, 0x66, 0x3d, 0x67, 0x67, 0x56, 0x45,
        0x0a, 0xf3, 0x01, 0x66, 0x00, 0xf3, 0x3d, 0xd1, 0xf1, 0xf3, 0x0a, 0xd1, 0xff, 0x9f, 0xf1,
        0x00,
    ];
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.aac");
    std::fs::write(&p, data).unwrap();
    let _ = MediaHandler.open(&p);
}
