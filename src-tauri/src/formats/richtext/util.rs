//! Utilitaires partagés par les handlers de la famille traitement de texte.

use base64::prelude::*;

/// Échappe `&`, `<`, `>`, `"` et retire les caractères interdits en XML 1.0.
pub fn xml_escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
}

pub fn xml_escaped(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    xml_escape(s, &mut out);
    out
}

/// Normalise une couleur CSS (`#rgb`, `#rrggbb`, `rgb(r,g,b)`) en `#rrggbb` minuscule.
pub fn to_hex6(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase();
    if let Some(h) = s.strip_prefix('#') {
        if !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        return match h.len() {
            6 => Some(format!("#{h}")),
            3 => {
                let mut o = String::from("#");
                for c in h.chars() {
                    o.push(c);
                    o.push(c);
                }
                Some(o)
            }
            _ => None,
        };
    }
    let inner = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb("))?;
    let inner = inner.strip_suffix(')')?;
    let mut vals = inner
        .split([',', ' ', '/'])
        .filter(|p| !p.is_empty())
        .take(3)
        .map(|p| p.parse::<f32>().ok());
    let r = vals.next()??;
    let g = vals.next()??;
    let b = vals.next()??;
    let c = |v: f32| v.clamp(0.0, 255.0).round() as u8;
    Some(format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b)))
}

/// Taille de police (`12pt`, `16px`, `12`) en points.
pub fn parse_font_size_pt(s: &str) -> Option<f32> {
    let s = s.trim().to_lowercase();
    let (num, factor) = if let Some(n) = s.strip_suffix("pt") {
        (n, 1.0)
    } else if let Some(n) = s.strip_suffix("px") {
        (n, 0.75)
    } else {
        (s.as_str(), 1.0)
    };
    let v: f32 = num.trim().parse().ok()?;
    let pt = v * factor;
    (pt.is_finite() && (1.0..=1000.0).contains(&pt)).then_some(pt)
}

pub fn format_pt(pt: f32) -> String {
    let rounded = (pt * 2.0).round() / 2.0;
    if rounded.fract().abs() < f32::EPSILON {
        format!("{}pt", rounded as i64)
    } else {
        format!("{rounded}pt")
    }
}

/// Décode une URI `data:` en (mime, octets).
pub fn parse_data_uri(src: &str) -> Option<(String, Vec<u8>)> {
    let rest = src.trim().strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let mime = parts.next().unwrap_or("").trim().to_lowercase();
    let is_b64 = parts.any(|p| p.eq_ignore_ascii_case("base64"));
    let bytes = if is_b64 {
        let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        BASE64_STANDARD.decode(cleaned.as_bytes()).ok()?
    } else {
        percent_decode(payload)
    };
    let mime = if mime.is_empty() {
        "text/plain".to_string()
    } else {
        mime
    };
    Some((mime, bytes))
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

pub fn make_data_uri(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes))
}

pub fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpeg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/tiff" => "tiff",
        "image/x-emf" => "emf",
        "image/x-wmf" => "wmf",
        _ => "bin",
    }
}

pub fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "emf" => "image/x-emf",
        "wmf" => "image/x-wmf",
        _ => "application/octet-stream",
    }
}

/// Type MIME d'une image : signature d'abord, extension du nom en repli.
pub fn sniff_image_mime(bytes: &[u8], name: &str) -> String {
    if let Some(t) = infer::get(bytes) {
        if t.mime_type().starts_with("image/") {
            return t.mime_type().to_string();
        }
    }
    let ext = name.rsplit('.').next().unwrap_or("");
    mime_from_ext(ext).to_string()
}

/// Dimensions en pixels (PNG, GIF, JPEG, BMP) sans décoder l'image.
pub fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    let be32 =
        |o: usize| -> Option<u32> { Some(u32::from_be_bytes(b.get(o..o + 4)?.try_into().ok()?)) };
    let le32 =
        |o: usize| -> Option<u32> { Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?)) };
    let le16 = |o: usize| -> Option<u32> {
        Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?) as u32)
    };
    let be16 = |o: usize| -> Option<u32> {
        Some(u16::from_be_bytes(b.get(o..o + 2)?.try_into().ok()?) as u32)
    };
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((be32(16)?, be32(20)?));
    }
    if b.starts_with(b"GIF8") {
        return Some((le16(6)?, le16(8)?));
    }
    if b.starts_with(b"BM") {
        let h = le32(22)? as i32;
        return Some((le32(18)?, h.unsigned_abs()));
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 4 < b.len() {
            if *b.get(i)? != 0xFF {
                i += 1;
                continue;
            }
            let marker = *b.get(i + 1)?;
            if marker == 0xFF {
                i += 1;
                continue;
            }
            if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                return Some((be16(i + 7)?, be16(i + 5)?));
            }
            if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
                i += 2;
                continue;
            }
            let len = be16(i + 2)? as usize;
            i += 2 + len.max(2);
        }
    }
    None
}

/// Filtre de schémas dangereux (liens `javascript:`…). Les images acceptent `data:image/`.
pub fn safe_url(url: &str, image: bool) -> Option<String> {
    let t = url.trim();
    if t.is_empty() {
        return None;
    }
    let lower: String = t
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
        return None;
    }
    if lower.starts_with("data:") {
        if image && lower.starts_with("data:image/") {
            return Some(t.to_string());
        }
        return None;
    }
    Some(t.to_string())
}

/// Décode un texte (BOM, UTF-8, repli windows-1252 ou charset déclaré en HTML).
pub fn decode_text(bytes: &[u8], html_sniff: bool) -> String {
    if let Some((enc, skip)) = encoding_rs::Encoding::for_bom(bytes) {
        return enc
            .decode_without_bom_handling(bytes.get(skip..).unwrap_or(&[]))
            .0
            .into_owned();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let mut enc = encoding_rs::WINDOWS_1252;
    if html_sniff {
        let head = String::from_utf8_lossy(bytes.get(..bytes.len().min(2048)).unwrap_or(&[]))
            .to_lowercase();
        if let Some(pos) = head.find("charset=") {
            let label: String = head
                .get(pos + 8..)
                .unwrap_or("")
                .trim_start_matches(['"', '\'', ' '])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
                .collect();
            if let Some(e) = encoding_rs::Encoding::for_label(label.as_bytes()) {
                enc = e;
            }
        }
    }
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors() {
        assert_eq!(to_hex6("#FFF").as_deref(), Some("#ffffff"));
        assert_eq!(to_hex6("rgb(255, 0, 16)").as_deref(), Some("#ff0010"));
        assert_eq!(to_hex6("red"), None);
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_font_size_pt("16px"), Some(12.0));
        assert_eq!(format_pt(10.5), "10.5pt");
        assert_eq!(format_pt(12.0), "12pt");
    }

    #[test]
    fn data_uri_roundtrip() {
        let u = make_data_uri("image/png", &[1, 2, 3]);
        assert_eq!(
            parse_data_uri(&u),
            Some(("image/png".into(), vec![1, 2, 3]))
        );
        assert_eq!(safe_url("JavaScript:alert(1)", false), None);
    }
}
