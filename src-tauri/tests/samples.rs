//! Générateur d'échantillons pour les tests E2E (`tests/e2e/fixtures/`, gitignoré).
//!
//! `cargo test --test samples -- --ignored` écrit un fichier valide de chaque type.
//! Les formats riches (docx, odt, rtf, xlsx, ods) passent par les handlers existants.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use omnidoc_lib::core::registry::Registry;
use zip::write::SimpleFileOptions;

fn out_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/e2e/fixtures");
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
    let mut z = zip::ZipWriter::new(File::create(path).unwrap());
    for (n, d) in files {
        let o = if *n == "mimetype" {
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
        } else {
            SimpleFileOptions::default()
        };
        z.start_file(*n, o).unwrap();
        z.write_all(d).unwrap();
    }
    z.finish().unwrap();
}

fn pdf_bytes(n: u32) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let mut kids = Vec::new();
    for i in 1..=n {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Td", vec![50.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(format!("Page {i}"))]),
                Operation::new("ET", vec![]),
            ],
        };
        let cid = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let pid = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => cid,
        });
        kids.push(Object::Reference(pid));
    }
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => n as i64,
        "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));
    let info = doc.add_object(dictionary! { "Title" => Object::string_literal("Exemple") });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc.trailer.set("Info", info);
    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

fn wav_bytes() -> Vec<u8> {
    let rate = 8000u32;
    let samples: Vec<i16> = (0..rate / 2)
        .map(|i| ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 8000.0) as i16)
        .collect();
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::new();
    b.extend(b"RIFF");
    b.extend((36 + data_len).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(rate.to_le_bytes());
    b.extend((rate * 2).to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(data_len.to_le_bytes());
    for s in samples {
        b.extend(s.to_le_bytes());
    }
    b
}

/// MP3 de silence : trames MPEG-1 Layer III, 128 kb/s, 44,1 kHz (417 octets chacune).
fn mp3_bytes() -> Vec<u8> {
    let mut b = Vec::new();
    for _ in 0..40 {
        let mut frame = vec![0u8; 417];
        frame[..4].copy_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        b.extend(frame);
    }
    b
}

/// WebM minimal (en-tête EBML + segment vide) : suffit à ouvrir l'éditeur média en mode vidéo.
fn webm_bytes() -> Vec<u8> {
    // En-tête EBML : DocType = "webm".
    let doctype = [0x42u8, 0x82, 0x84, b'w', b'e', b'b', b'm'];
    let mut b = vec![0x1A, 0x45, 0xDF, 0xA3, 0x80 | doctype.len() as u8];
    b.extend(doctype);
    // Segment vide.
    b.extend([0x18, 0x53, 0x80, 0x67, 0x80]);
    b
}

/// Binaire inconnu de 5000 octets : motif de départ, puis un marqueur texte à l'offset 4128 (0x1020).
fn bin_bytes() -> Vec<u8> {
    let mut b = vec![
        0x5Au8, 0x5A, 0x00, 0x01, 0x02, 0xFE, 0xFF, 0x10, 0x80, 0x7F, 0x00, 0x00,
    ];
    b.resize(5000, 0x00);
    b[4128..4128 + 12].copy_from_slice(b"OMNIDOC-MARK");
    b
}

fn epub(path: &Path) {
    zip_of(
        path,
        &[
            ("mimetype", b"application/epub+zip"),
            (
                "META-INF/container.xml",
                br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            ),
            (
                "OEBPS/content.opf",
                br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Mon Livre</dc:title><dc:creator>Ada</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#,
            ),
            (
                "OEBPS/nav.xhtml",
                br#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Premier</a></li><li><a href="ch2.xhtml">Second</a></li></ol></nav></body></html>"#,
            ),
            (
                "OEBPS/ch1.xhtml",
                br#"<html><head><title>Premier</title></head><body><h1>Un</h1><p>Texte du premier chapitre.</p></body></html>"#,
            ),
            (
                "OEBPS/ch2.xhtml",
                br#"<html><head><title>Second</title></head><body><h2>Deux</h2><p>Fin.</p></body></html>"#,
            ),
        ],
    );
}

fn pptx(path: &Path) {
    let slide = |t1: &str, t2: &str| {
        format!(
            r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{t1}</a:t></a:r></a:p><a:p><a:r><a:t>{t2}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
        )
    };
    let s1 = slide("Titre", "Premier point");
    let s2 = slide("Deux", "Second point");
    zip_of(
        path,
        &[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "ppt/presentation.xml",
                br#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                br#"<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>"#,
            ),
            ("ppt/slides/slide1.xml", s1.as_bytes()),
            ("ppt/slides/slide2.xml", s2.as_bytes()),
        ],
    );
}

fn odp(path: &Path) {
    zip_of(
        path,
        &[
            ("mimetype", b"application/vnd.oasis.opendocument.presentation"),
            (
                "content.xml",
                br#"<office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t" xmlns:presentation="pr"><office:body><office:presentation><draw:page draw:name="a"><draw:frame><draw:text-box><text:p>Bonjour</text:p></draw:text-box></draw:frame></draw:page><draw:page><draw:frame><draw:text-box><text:p>Item</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>"#,
            ),
        ],
    );
}

#[test]
#[ignore = "génère tests/e2e/fixtures/ (voir tests/e2e)"]
fn generate_samples() {
    let dir = out_dir();
    let p = |name: &str| dir.join(name);
    let registry = Registry::new();

    // Texte et code.
    fs::write(p("sample.txt"), "Bonjour le monde\nDeuxième ligne\n").unwrap();
    fs::write(p("sample.py"), "def hello():\n    print(\"hello\")\n").unwrap();
    fs::write(
        p("sample.json"),
        "{\n  \"nom\": \"OmniDoc\",\n  \"n\": [1, 2, 3]\n}\n",
    )
    .unwrap();
    fs::write(p("sample.yaml"), "nom: OmniDoc\nliste:\n  - un\n  - deux\n").unwrap();
    fs::write(
        p("sample.md"),
        "# Titre\n\nUn paragraphe avec **gras** et *italique*.\n\n- un\n- deux\n",
    )
    .unwrap();
    fs::write(
        p("sample.html"),
        "<!DOCTYPE html><html><head><title>Exemple</title></head><body><h1>Titre</h1><p>Un paragraphe <b>gras</b>.</p><ul><li>un</li><li>deux</li></ul></body></html>",
    )
    .unwrap();
    fs::write(p("sample.svg"), r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#3b82f6"/><circle cx="50" cy="50" r="30" fill="#fff"/></svg>"##).unwrap();
    fs::write(
        p("sample.csv"),
        "nom,age,ville\nAda,36,Londres\nBob,42,Paris\nCléo,29,Lyon\n",
    )
    .unwrap();
    fs::write(
        p("sample.ipynb"),
        r##"{"cells":[{"cell_type":"markdown","metadata":{},"source":["# Titre\n","texte"]},{"cell_type":"code","execution_count":1,"metadata":{},"outputs":[{"output_type":"stream","name":"stdout","text":["3\n"]}],"source":["print(1+2)"]}],"metadata":{"kernelspec":{"name":"python3","display_name":"Python 3","language":"python"},"language_info":{"name":"python"}},"nbformat":4,"nbformat_minor":5}"##,
    )
    .unwrap();
    fs::write(
        p("sample.ics"),
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OmniDoc//FR\r\nBEGIN:VEVENT\r\nUID:1@omnidoc\r\nDTSTAMP:20260101T100000Z\r\nDTSTART:20260115T140000Z\r\nDTEND:20260115T150000Z\r\nSUMMARY:Réunion\r\nLOCATION:Paris\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    )
    .unwrap();
    fs::write(
        p("sample.vcf"),
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;;\r\nEMAIL:ada@example.org\r\nTEL:+33123456789\r\nEND:VCARD\r\n",
    )
    .unwrap();
    fs::write(p("sample.bin"), bin_bytes()).unwrap();

    // Documents riches et tableurs via les handlers.
    let html = registry
        .get("html")
        .unwrap()
        .open(&p("sample.html"))
        .unwrap();
    for id in ["docx", "odt"] {
        let h = registry.get(id).unwrap();
        h.save(&html, &p(&format!("sample.{id}"))).unwrap();
    }
    fs::write(
        p("sample.rtf"),
        r"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\pard Bonjour \b gras\b0 .\par Deuxi\'e8me ligne.\par}",
    )
    .unwrap();
    let csv = registry.get("csv").unwrap().open(&p("sample.csv")).unwrap();
    for id in ["xlsx", "ods"] {
        let h = registry.get(id).unwrap();
        h.save(&csv, &p(&format!("sample.{id}"))).unwrap();
    }

    // Images.
    let img = image::RgbImage::from_fn(64, 48, |x, y| {
        image::Rgb([(x * 4) as u8, (y * 5) as u8, 128])
    });
    img.save(p("sample.png")).unwrap();
    img.save(p("sample.jpg")).unwrap();

    // PDF, audio, base de données, livre, diapositives.
    fs::write(p("sample.pdf"), pdf_bytes(3)).unwrap();
    fs::write(p("sample.wav"), wav_bytes()).unwrap();
    fs::write(p("sample.mp3"), mp3_bytes()).unwrap();
    // Fixture propre aux parcours (le test d'ouverture ne prend que `sample.*`).
    fs::write(p("video.webm"), webm_bytes()).unwrap();
    let _ = fs::remove_file(p("sample.sqlite"));
    let c = rusqlite::Connection::open(p("sample.sqlite")).unwrap();
    c.execute_batch(
        "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score REAL);
         INSERT INTO people VALUES (1,'Ada',1.5),(2,'Bob',2.0),(3,NULL,NULL);",
    )
    .unwrap();
    drop(c);
    epub(&p("sample.epub"));
    pptx(&p("sample.pptx"));
    odp(&p("sample.odp"));

    // Archives.
    zip_of(
        &p("sample.zip"),
        &[("a.txt", b"alpha"), ("dossier/b.txt", b"beta")],
    );
    let gz = flate2::write::GzEncoder::new(
        File::create(p("sample.tar.gz")).unwrap(),
        flate2::Compression::default(),
    );
    let mut tar = tar::Builder::new(gz);
    for (name, data) in [("a.txt", &b"alpha"[..]), ("dossier/b.txt", &b"beta"[..])] {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, name, data).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap();
    let src = dir.join("_7z_src");
    fs::create_dir_all(src.join("dossier")).unwrap();
    fs::write(src.join("a.txt"), "alpha").unwrap();
    fs::write(src.join("dossier/b.txt"), "beta").unwrap();
    sevenz_rust2::compress_to_path(&src, p("sample.7z")).unwrap();
    fs::remove_dir_all(&src).unwrap();
}
