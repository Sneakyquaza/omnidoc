//! Images raster : métadonnées + EXIF à l'ouverture ; pixels lus par le front (`read_bytes`).
//!
//! Le modèle ne contient pas les pixels : `write: false`. L'édition passe par le canvas du front
//! puis `image_save` / `image_convert` / `image_strip_metadata` (réencodage → EXIF supprimé).

use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
    RgbImage,
};

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, ExifEntry, ImageDoc, ModelKind};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

const MAX_EXIF_ENTRIES: usize = 500;
const MAX_DIMENSION: u32 = 20_000;
const MAX_PIXELS: u64 = 100_000_000;
const MAX_PREVIEW_SIDE: u32 = 8192;
const MAX_ICO_SIDE: u32 = 256;

pub struct ImageHandler;

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_DIMENSION);
    l.max_image_height = Some(MAX_DIMENSION);
    l.max_alloc = Some(MAX_OPEN_BYTES);
    l
}

fn corrupt(e: impl std::fmt::Display) -> AppError {
    AppError::Corrupt(e.to_string())
}

fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::WebP => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Ico => "ico",
        _ => "unknown",
    }
}

fn target_format(name: &str) -> Result<ImageFormat> {
    match name.to_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        "webp" => Ok(ImageFormat::WebP),
        "bmp" => Ok(ImageFormat::Bmp),
        "tiff" | "tif" => Ok(ImageFormat::Tiff),
        "gif" => Ok(ImageFormat::Gif),
        "ico" => Ok(ImageFormat::Ico),
        _ => Err(AppError::Unsupported),
    }
}

fn read_exif(path: &Path) -> Vec<ExifEntry> {
    let Ok(file) = File::open(path) else {
        return vec![];
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return vec![];
    };
    exif.fields()
        .take(MAX_EXIF_ENTRIES)
        .map(|f| ExifEntry {
            tag: f.tag.to_string(),
            value: f.display_value().with_unit(&exif).to_string(),
        })
        .collect()
}

/// Décode un fichier image (limites appliquées, orientation EXIF appliquée) ; renvoie aussi le format source.
fn decode_file(path: &Path) -> Result<(DynamicImage, ImageFormat)> {
    let reader = ImageReader::open(path)?
        .with_guessed_format()
        .map_err(AppError::Io)?;
    let format = reader.format().ok_or(AppError::Unsupported)?;
    let mut decoder = reader.into_decoder().map_err(corrupt)?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(AppError::TooLarge);
    }
    decoder.set_limits(limits()).map_err(corrupt)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(corrupt)?;
    img.apply_orientation(orientation);
    Ok((img, format))
}

/// Refuse les GIF/WebP animés : le réencodage ne garde que la première image.
fn ensure_not_animated(path: &Path, format: ImageFormat) -> Result<()> {
    let animated = match format {
        ImageFormat::Gif => {
            let dec = GifDecoder::new(BufReader::new(File::open(path)?)).map_err(corrupt)?;
            dec.into_frames().take(2).filter(|f| f.is_ok()).count() > 1
        }
        ImageFormat::WebP => WebPDecoder::new(BufReader::new(File::open(path)?))
            .map_err(corrupt)?
            .has_animation(),
        _ => false,
    };
    if animated {
        return Err(AppError::Limit("animated_image".into()));
    }
    Ok(())
}

/// Profil ICC d'un JPEG (conservé au réencodage).
fn jpeg_icc(path: &Path) -> Option<Vec<u8>> {
    let reader = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    decoder.icc_profile().ok().flatten()
}

fn decode_png_bytes(bytes: &[u8]) -> Result<DynamicImage> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    reader.limits(limits());
    reader.decode().map_err(corrupt)
}

fn flatten_on_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = u32::from(p[3]);
        let mix = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
        out.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    out
}

fn encode(img: &DynamicImage, format: ImageFormat, quality: Option<u8>) -> Result<Vec<u8>> {
    encode_with_icc(img, format, quality, None)
}

fn encode_with_icc(
    img: &DynamicImage,
    format: ImageFormat,
    quality: Option<u8>,
    icc: Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let mut buf = Cursor::new(Vec::new());
    match format {
        ImageFormat::Jpeg => {
            let rgb = flatten_on_white(img);
            let q = quality.unwrap_or(90).clamp(1, 100);
            let mut enc = JpegEncoder::new_with_quality(&mut buf, q);
            if let Some(icc) = icc {
                let _ = enc.set_icc_profile(icc);
            }
            enc.encode_image(&rgb).map_err(corrupt)?;
        }
        ImageFormat::Png => img.write_to(&mut buf, format).map_err(corrupt)?,
        ImageFormat::Ico => {
            let scaled = if img.width() > MAX_ICO_SIDE || img.height() > MAX_ICO_SIDE {
                img.resize(MAX_ICO_SIDE, MAX_ICO_SIDE, FilterType::Lanczos3)
            } else {
                img.clone()
            };
            DynamicImage::ImageRgba8(scaled.to_rgba8())
                .write_to(&mut buf, format)
                .map_err(corrupt)?;
        }
        ImageFormat::Gif => DynamicImage::ImageRgba8(img.to_rgba8())
            .write_to(&mut buf, format)
            .map_err(corrupt)?,
        _ => {
            let norm = if img.color().has_alpha() {
                DynamicImage::ImageRgba8(img.to_rgba8())
            } else {
                DynamicImage::ImageRgb8(img.to_rgb8())
            };
            norm.write_to(&mut buf, format).map_err(corrupt)?;
        }
    }
    Ok(buf.into_inner())
}

/// Réencode un PNG (base64, préfixe data: accepté) vers `format`, écriture atomique.
pub fn save_from_png_base64(
    dest: &Path,
    png_base64: &str,
    format: &str,
    quality: Option<u8>,
) -> Result<()> {
    let payload = match png_base64.split_once("base64,") {
        Some((head, rest)) if head.starts_with("data:") => rest,
        _ => png_base64,
    };
    let bytes = STANDARD
        .decode(payload.trim().as_bytes())
        .map_err(corrupt)?;
    let img = decode_png_bytes(&bytes)?;
    let out = encode(&img, target_format(format)?, quality)?;
    atomic::write(dest, &out)
}

pub fn convert_file(path: &Path, dest: &Path, format: &str, quality: Option<u8>) -> Result<()> {
    let (img, src_format) = decode_file(path)?;
    ensure_not_animated(path, src_format)?;
    let out = encode(&img, target_format(format)?, quality)?;
    atomic::write(dest, &out)
}

pub fn strip_metadata(path: &Path, dest: &Path) -> Result<()> {
    let (img, format) = decode_file(path)?;
    ensure_not_animated(path, format)?;
    let quality = (format == ImageFormat::Jpeg).then_some(95);
    let icc = (format == ImageFormat::Jpeg)
        .then(|| jpeg_icc(path))
        .flatten();
    let out = encode_with_icc(&img, format, quality, icc)?;
    atomic::write(dest, &out)
}

pub fn preview_png(path: &Path) -> Result<String> {
    let (mut img, _) = decode_file(path)?;
    if img.width().max(img.height()) > MAX_PREVIEW_SIDE {
        img = img.resize(MAX_PREVIEW_SIDE, MAX_PREVIEW_SIDE, FilterType::Triangle);
    }
    let png = encode(&img, ImageFormat::Png, None)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

impl FormatHandler for ImageHandler {
    fn id(&self) -> &'static str {
        "image"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Image
    }

    fn extensions(&self) -> &'static [&'static str] {
        &[
            "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "ico",
        ]
    }

    fn label_key(&self) -> &'static str {
        "formats.image"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let magic = matches!(
            probe.mime.as_deref(),
            Some(
                "image/png"
                    | "image/jpeg"
                    | "image/webp"
                    | "image/gif"
                    | "image/bmp"
                    | "image/tiff"
                    | "image/vnd.microsoft.icon"
            )
        );
        if magic {
            Some(Confidence(90))
        } else if self.extensions().contains(&probe.ext.as_str()) {
            Some(Confidence(60))
        } else {
            None
        }
    }

    /// `write: false` : le modèle ne porte pas les pixels, l'édition passe par les commandes
    /// `image_save` / `image_convert` / `image_strip_metadata`.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: Fidelity::Partial,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let reader = ImageReader::open(path)?
            .with_guessed_format()
            .map_err(AppError::Io)?;
        let format = reader.format().ok_or(AppError::Unsupported)?;
        let decoder = reader.into_decoder().map_err(corrupt)?;
        let (width, height) = decoder.dimensions();
        let has_alpha = decoder.color_type().has_alpha();
        Ok(DocumentModel::Image(ImageDoc {
            width,
            height,
            format: format_name(format).to_string(),
            has_alpha,
            exif: read_exif(path),
        }))
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::External(e.to_string()))?
}

#[tauri::command]
#[specta::specta]
pub async fn image_preview_png(path: String) -> Result<String> {
    blocking(move || preview_png(Path::new(&path))).await
}

#[tauri::command]
#[specta::specta]
pub async fn image_save(
    dest: String,
    png_base64: String,
    format: String,
    quality: Option<u8>,
) -> Result<()> {
    blocking(move || save_from_png_base64(Path::new(&dest), &png_base64, &format, quality)).await
}

#[tauri::command]
#[specta::specta]
pub async fn image_strip_metadata(path: String, dest: String) -> Result<()> {
    blocking(move || strip_metadata(Path::new(&path), Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn image_convert(
    path: String,
    dest: String,
    format: String,
    quality: Option<u8>,
) -> Result<()> {
    blocking(move || convert_file(Path::new(&path), Path::new(&dest), &format, quality)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn sample_png_b64(w: u32, h: u32) -> String {
        let img = RgbaImage::from_fn(w, h, |x, y| Rgba([(x * 10) as u8, (y * 10) as u8, 99, 255]));
        let png = encode(&DynamicImage::ImageRgba8(img), ImageFormat::Png, None).unwrap();
        STANDARD.encode(png)
    }

    fn open_doc(path: &Path) -> ImageDoc {
        match ImageHandler.open(path).unwrap() {
            DocumentModel::Image(d) => d,
            _ => panic!("modèle inattendu"),
        }
    }

    #[test]
    fn save_converts_and_keeps_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let b64 = sample_png_b64(24, 16);
        for fmt in ["png", "jpeg", "webp", "bmp", "tiff", "gif", "ico"] {
            let dest = dir.path().join(format!("out.{fmt}"));
            save_from_png_base64(&dest, &format!("data:image/png;base64,{b64}"), fmt, None)
                .unwrap();
            let d = open_doc(&dest);
            assert_eq!((d.width, d.height), (24, 16), "{fmt}");
            assert_eq!(d.format, fmt);
        }
    }

    #[test]
    fn ico_is_resized_and_jpeg_flattened() {
        let dir = tempfile::tempdir().unwrap();
        let big = sample_png_b64(300, 300);
        let ico = dir.path().join("a.ico");
        save_from_png_base64(&ico, &big, "ico", None).unwrap();
        let d = open_doc(&ico);
        assert!(d.width <= 256 && d.height <= 256);

        let transparent = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 0]));
        let png = encode(
            &DynamicImage::ImageRgba8(transparent),
            ImageFormat::Png,
            None,
        )
        .unwrap();
        let jpg = dir.path().join("t.jpg");
        save_from_png_base64(&jpg, &STANDARD.encode(png), "jpeg", Some(90)).unwrap();
        let (img, _) = decode_file(&jpg).unwrap();
        let p = img.to_rgb8().get_pixel(1, 1).0;
        assert!(p.iter().all(|&c| c > 250));
    }

    #[test]
    fn unsupported_format_and_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("x");
        assert!(matches!(
            save_from_png_base64(&d, &sample_png_b64(4, 4), "xyz", None),
            Err(AppError::Unsupported)
        ));
        assert!(save_from_png_base64(&d, "!!!", "png", None).is_err());
        assert!(save_from_png_base64(&d, &STANDARD.encode(b"not a png"), "png", None).is_err());
    }

    /// JPEG avec un segment APP1 EXIF minimal inséré à la main (Orientation = 1).
    fn jpeg_with_exif() -> Vec<u8> {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(8, 8, image::Rgb([10, 20, 30])));
        let jpg = encode(&img, ImageFormat::Jpeg, Some(90)).unwrap();
        let mut tiff: Vec<u8> = b"MM\0\x2a\0\0\0\x08".to_vec();
        tiff.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let len = (app1.len() + 2) as u16;
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpg[2..]);
        out
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = !0u32;
        for b in data {
            c ^= u32::from(*b);
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        let mut crc_in = kind.to_vec();
        crc_in.extend_from_slice(body);
        out.extend_from_slice(&crc_in);
        out.extend_from_slice(&crc32(&crc_in).to_be_bytes());
    }

    #[test]
    fn huge_pixel_count_is_refused_before_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&11_000u32.to_be_bytes());
        ihdr.extend_from_slice(&11_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        png_chunk(&mut png, b"IHDR", &ihdr);
        png_chunk(&mut png, b"IDAT", &[0x78, 0x9c, 0, 0]);
        let p = dir.path().join("big.png");
        std::fs::write(&p, png).unwrap();
        assert!(matches!(decode_file(&p), Err(AppError::TooLarge)));
    }

    #[test]
    fn animated_gif_is_refused_and_icc_is_kept() {
        use image::codecs::gif::GifEncoder;
        use image::{Frame, RgbaImage};
        let dir = tempfile::tempdir().unwrap();
        let gif = dir.path().join("anim.gif");
        let mut enc = GifEncoder::new(File::create(&gif).unwrap());
        let frames =
            (0..2).map(|i| Frame::new(RgbaImage::from_pixel(4, 4, Rgba([i * 100, 0, 0, 255]))));
        enc.encode_frames(frames).unwrap();
        drop(enc);
        let out = dir.path().join("o.gif");
        assert!(strip_metadata(&gif, &out).is_err());
        assert!(convert_file(&gif, &dir.path().join("o.png"), "png", None).is_err());
        assert!(!out.exists());

        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(8, 8, image::Rgb([1, 2, 3])));
        let icc = b"fake-icc-profile-0123456789".to_vec();
        let jpg = dir.path().join("a.jpg");
        std::fs::write(
            &jpg,
            encode_with_icc(&img, ImageFormat::Jpeg, Some(90), Some(icc.clone())).unwrap(),
        )
        .unwrap();
        assert_eq!(jpeg_icc(&jpg), Some(icc.clone()));
        let stripped = dir.path().join("b.jpg");
        strip_metadata(&jpg, &stripped).unwrap();
        assert_eq!(jpeg_icc(&stripped), Some(icc));
    }

    #[test]
    fn strip_removes_exif() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.jpg");
        std::fs::write(&src, jpeg_with_exif()).unwrap();
        let before = open_doc(&src);
        assert!(!before.exif.is_empty(), "EXIF attendu dans la fixture");
        let dest = dir.path().join("b.jpg");
        strip_metadata(&src, &dest).unwrap();
        let after = open_doc(&dest);
        assert!(after.exif.is_empty());
        assert_eq!(
            (after.width, after.height, after.format.as_str()),
            (8, 8, "jpeg")
        );
    }

    #[test]
    fn convert_and_preview() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        save_from_png_base64(&src, &sample_png_b64(10, 6), "png", None).unwrap();
        let dest = dir.path().join("a.webp");
        convert_file(&src, &dest, "webp", None).unwrap();
        assert_eq!(open_doc(&dest).format, "webp");
        let tif = dir.path().join("a.tiff");
        convert_file(&src, &tif, "tiff", None).unwrap();
        assert!(preview_png(&tif)
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn detection() {
        let h = ImageHandler;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        save_from_png_base64(&p, &sample_png_b64(4, 4), "png", None).unwrap();
        let probe = FileProbe::from_path(&p).unwrap();
        assert_eq!(h.detect(&probe), Some(Confidence(90)));
        assert_eq!(
            h.detect(&FileProbe::from_bytes("x.jpg", b"zzzz")),
            Some(Confidence(60))
        );
        assert_eq!(h.detect(&FileProbe::from_bytes("x.txt", b"zzzz")), None);
    }

    #[test]
    fn corrupted_bytes_do_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let good = jpeg_with_exif();
        for (i, name) in [
            "c.jpg", "d.png", "e.gif", "f.bmp", "g.tiff", "h.ico", "i.webp",
        ]
        .iter()
        .enumerate()
        {
            let p = dir.path().join(name);
            let mut bytes: Vec<u8> = good[..good.len() / 2].to_vec();
            bytes.extend((0..64u8).map(|b| b.wrapping_mul(i as u8 + 7)));
            std::fs::write(&p, &bytes).unwrap();
            let _ = ImageHandler.open(&p);
            let _ = preview_png(&p);
        }
        std::fs::write(dir.path().join("z.png"), [0u8; 3]).unwrap();
        assert!(ImageHandler.open(&dir.path().join("z.png")).is_err());
    }
}
