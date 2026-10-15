//! Utilitaires partagés des formats conteneurs ZIP + XML (epub, pptx, odp) :
//! ouverture bornée, lecture d'entrées, résolution de chemins, mini-arbre XML.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::result::ZipError;
use zip::ZipArchive;

use crate::core::limits::{MAX_ARCHIVE_ENTRIES, MAX_COMPRESSION_RATIO, MAX_DEPTH};
use crate::error::{AppError, Result};

/// Nombre max de nœuds XML d'un document.
const MAX_XML_NODES: usize = 2_000_000;

fn zip_err(e: ZipError) -> AppError {
    match e {
        ZipError::Io(e) => AppError::Io(e),
        other => AppError::Corrupt(other.to_string()),
    }
}

pub fn open_zip(path: &Path) -> Result<ZipArchive<File>> {
    let zip = ZipArchive::new(File::open(path)?).map_err(zip_err)?;
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AppError::Limit("entrées d'archive".into()));
    }
    Ok(zip)
}

/// Lit une entrée (None si absente). Refuse au-delà de `max` octets ou d'un ratio suspect.
pub fn read_entry(zip: &mut ZipArchive<File>, name: &str, max: u64) -> Result<Option<Vec<u8>>> {
    let file = match zip.by_name(name) {
        Ok(f) => f,
        Err(ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(zip_err(e)),
    };
    if file.size() > max {
        return Err(AppError::Limit("taille d'entrée".into()));
    }
    let packed = file.compressed_size().max(1);
    if file.size() > 1024 * 1024 && file.size() / packed > MAX_COMPRESSION_RATIO {
        return Err(AppError::Limit("ratio de compression".into()));
    }
    let mut buf = Vec::new();
    file.take(max + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max {
        return Err(AppError::Limit("taille d'entrée".into()));
    }
    Ok(Some(buf))
}

fn percent_decode(s: &str) -> String {
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
    String::from_utf8_lossy(&out).into_owned()
}

/// Résout `href` (fragment et requête ignorés) relativement à `base_dir` ("" ou "a/b").
/// None si vide, URL absolue (schéma) ou chemin sortant de la racine de l'archive.
pub fn resolve(base_dir: &str, href: &str) -> Option<String> {
    let href = href.split(['#', '?']).next().unwrap_or("");
    if href.is_empty() {
        return None;
    }
    let first_seg = href.split('/').next().unwrap_or("");
    if first_seg.contains(':') {
        return None;
    }
    let decoded = percent_decode(href).replace('\\', "/");
    let joined = if let Some(abs) = decoded.strip_prefix('/') {
        abs.to_string()
    } else if base_dir.is_empty() {
        decoded
    } else {
        format!("{base_dir}/{decoded}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Dossier parent d'un chemin d'archive ("" si à la racine).
pub fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

pub enum Item {
    Node(Node),
    Text(String),
}

/// Nœud XML : noms d'éléments en nom local, attributs en nom qualifié.
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub items: Vec<Item>,
}

impl Node {
    pub fn attr(&self, qname: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == qname)
            .map(|(_, v)| v.as_str())
    }

    /// Attribut par nom local (premier trouvé, quel que soit le préfixe).
    pub fn attr_local(&self, local: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.rsplit(':').next() == Some(local))
            .map(|(_, v)| v.as_str())
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.items.iter().filter_map(|i| match i {
            Item::Node(n) => Some(n),
            Item::Text(_) => None,
        })
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.nodes().find(|n| n.name == name)
    }

    /// Descendants (ordre du document) portant ce nom local.
    pub fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for n in self.nodes() {
            if n.name == name {
                out.push(n);
            }
            n.descendants(name, out);
        }
    }

    pub fn find_all(&self, name: &str) -> Vec<&Node> {
        let mut v = Vec::new();
        self.descendants(name, &mut v);
        v
    }

    pub fn find(&self, name: &str) -> Option<&Node> {
        for n in self.nodes() {
            if n.name == name {
                return Some(n);
            }
            if let Some(f) = n.find(name) {
                return Some(f);
            }
        }
        None
    }

    /// Texte concaténé de tout le sous-arbre.
    pub fn text(&self) -> String {
        let mut s = String::new();
        self.push_text(&mut s);
        s
    }

    fn push_text(&self, out: &mut String) {
        for i in &self.items {
            match i {
                Item::Text(t) => out.push_str(t),
                Item::Node(n) => n.push_text(out),
            }
        }
    }
}

fn local(qname: &str) -> String {
    qname.rsplit(':').next().unwrap_or("").to_string()
}

fn node_from(e: &quick_xml::events::BytesStart<'_>) -> Node {
    let mut attrs = Vec::new();
    for a in e.attributes().flatten() {
        let key = a.key.as_ref().to_string();
        let val = a
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map(|v| v.into_owned())
            .unwrap_or_default();
        attrs.push((key, val));
    }
    Node {
        name: local(e.name().as_ref()),
        attrs,
        items: Vec::new(),
    }
}

fn push_text(stack: &mut [Node], t: &str) {
    if let Some(top) = stack.last_mut() {
        if let Some(Item::Text(last)) = top.items.last_mut() {
            last.push_str(t);
        } else {
            top.items.push(Item::Text(t.to_string()));
        }
    }
}

/// Analyse un document XML en arbre borné (profondeur `MAX_DEPTH`, nombre de nœuds).
pub fn parse_xml(bytes: &[u8]) -> Result<Node> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    let mut reader = Reader::from_str(&text);
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    let mut count = 0usize;
    let bad = |e: quick_xml::Error| AppError::Corrupt(format!("XML : {e}"));
    loop {
        match reader.read_event().map_err(bad)? {
            Event::Start(e) => {
                count += 1;
                if stack.len() >= MAX_DEPTH {
                    return Err(AppError::Limit("profondeur XML".into()));
                }
                if count > MAX_XML_NODES {
                    return Err(AppError::Limit("nœuds XML".into()));
                }
                stack.push(node_from(&e));
            }
            Event::Empty(e) => {
                count += 1;
                if count > MAX_XML_NODES {
                    return Err(AppError::Limit("nœuds XML".into()));
                }
                let n = node_from(&e);
                match stack.last_mut() {
                    Some(top) => top.items.push(Item::Node(n)),
                    None => root = root.or(Some(n)),
                }
            }
            Event::End(_) => {
                if let Some(n) = stack.pop() {
                    match stack.last_mut() {
                        Some(top) => top.items.push(Item::Node(n)),
                        None => root = root.or(Some(n)),
                    }
                }
            }
            Event::Text(t) => push_text(&mut stack, &t.xml10_content()),
            Event::CData(c) => push_text(&mut stack, &c.into_inner()),
            Event::GeneralRef(r) => {
                let s = if r.is_char_ref() {
                    match r.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => String::new(),
                    }
                } else {
                    match r.xml10_content().as_ref() {
                        "amp" => "&".into(),
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        _ => String::new(),
                    }
                };
                push_text(&mut stack, &s);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    root.ok_or_else(|| AppError::Corrupt("XML vide".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_safely() {
        assert_eq!(
            resolve("OEBPS", "ch1.xhtml#a").as_deref(),
            Some("OEBPS/ch1.xhtml")
        );
        assert_eq!(
            resolve("OEBPS/t", "../img/a%20b.png").as_deref(),
            Some("OEBPS/img/a b.png")
        );
        assert_eq!(resolve("a", "../../x"), None);
        assert_eq!(resolve("a", "http://x/y"), None);
        assert_eq!(resolve("a", "#frag"), None);
        assert_eq!(resolve("a", "/ppt/s.xml").as_deref(), Some("ppt/s.xml"));
    }

    #[test]
    fn parses_tree_and_entities() {
        let n = parse_xml(b"<a:r xmlns:a='x'><b k='1&amp;2'>x &lt; y &#65;</b><c/></a:r>").unwrap();
        assert_eq!(n.name, "r");
        assert_eq!(n.child("b").unwrap().attr("k"), Some("1&2"));
        assert_eq!(n.text(), "x < y A");
    }

    #[test]
    fn rejects_deep_and_broken_xml() {
        let deep = "<a>".repeat(MAX_DEPTH + 5);
        assert!(parse_xml(deep.as_bytes()).is_err());
        assert!(parse_xml(b"<a><b></a>").is_err());
        assert!(parse_xml(b"").is_err());
    }
}
