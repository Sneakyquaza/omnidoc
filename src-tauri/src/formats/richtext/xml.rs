//! Mini-DOM XML borné (profondeur, nombre de nœuds) pour les lecteurs docx/odt.

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::core::limits::MAX_DEPTH;
use crate::error::{AppError, Result};

const MAX_NODES: usize = 20_000_000;

#[derive(Debug, Clone, Default)]
pub struct Element {
    /// Nom qualifié tel qu'écrit (`w:p`, `text:span`…).
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Child>,
}

#[derive(Debug, Clone)]
pub enum Child {
    Elem(Element),
    Text(String),
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn elems(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|c| match c {
            Child::Elem(e) => Some(e),
            Child::Text(_) => None,
        })
    }

    pub fn find(&self, name: &str) -> Option<&Element> {
        self.elems().find(|e| e.name == name)
    }

    /// Texte direct (sans descendre dans les éléments enfants).
    pub fn own_text(&self) -> String {
        self.children
            .iter()
            .filter_map(|c| match c {
                Child::Text(t) => Some(t.as_str()),
                Child::Elem(_) => None,
            })
            .collect()
    }

    /// Texte de tous les descendants.
    pub fn deep_text(&self) -> String {
        let mut out = String::new();
        self.collect_text(&mut out);
        out
    }

    fn collect_text(&self, out: &mut String) {
        for c in &self.children {
            match c {
                Child::Text(t) => out.push_str(t),
                Child::Elem(e) => e.collect_text(out),
            }
        }
    }

    /// Premier descendant (profondeur d'abord) portant ce nom.
    pub fn descendant(&self, name: &str) -> Option<&Element> {
        for e in self.elems() {
            if e.name == name {
                return Some(e);
            }
            if let Some(f) = e.descendant(name) {
                return Some(f);
            }
        }
        None
    }

    pub fn has_descendant(&self, name: &str) -> bool {
        self.descendant(name).is_some()
    }
}

fn bad<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Corrupt(format!("XML invalide : {e}"))
}

pub fn parse(bytes: &[u8]) -> Result<Element> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let mut nodes = 0usize;
    loop {
        let ev = reader.read_event_into(&mut buf).map_err(bad)?;
        match ev {
            Event::Start(e) => {
                nodes += 1;
                if nodes > MAX_NODES {
                    return Err(AppError::Limit("trop de nœuds XML".into()));
                }
                if stack.len() >= MAX_DEPTH {
                    return Err(AppError::Limit("profondeur XML".into()));
                }
                let mut el = Element {
                    name: e.name().as_ref().to_string(),
                    ..Default::default()
                };
                for a in e.attributes().flatten() {
                    let key = a.key.as_ref().to_string();
                    let val = match a.normalized_value(quick_xml::XmlVersion::Implicit1_0) {
                        Ok(v) => v.into_owned(),
                        Err(_) => a.value.to_string(),
                    };
                    el.attrs.push((key, val));
                }
                stack.push(el);
            }
            Event::End(_) => {
                let Some(el) = stack.pop() else {
                    return Err(bad("balise fermante orpheline"));
                };
                match stack.last_mut() {
                    Some(parent) => parent.children.push(Child::Elem(el)),
                    None => root = Some(el),
                }
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    push_text(top, &t.xml10_content());
                }
            }
            Event::CData(t) => {
                if let Some(top) = stack.last_mut() {
                    push_text(top, &t.xml10_content());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(top) = stack.last_mut() {
                    let name = r.xml10_content().into_owned();
                    let s = match r.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => match name.as_str() {
                            "amp" => "&".into(),
                            "lt" => "<".into(),
                            "gt" => ">".into(),
                            "quot" => "\"".into(),
                            "apos" => "'".into(),
                            _ => String::new(),
                        },
                    };
                    push_text(top, &s);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !stack.is_empty() {
        return Err(bad("document tronqué"));
    }
    root.ok_or_else(|| bad("aucun élément racine"))
}

fn push_text(el: &mut Element, s: &str) {
    if s.is_empty() {
        return;
    }
    if let Some(Child::Text(t)) = el.children.last_mut() {
        t.push_str(s);
    } else {
        el.children.push(Child::Text(s.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entities_and_attrs() {
        let r = parse(b"<a x=\"1&amp;2\"><b>t&lt;&#65;</b><c/></a>").unwrap();
        assert_eq!(r.attr("x"), Some("1&2"));
        assert_eq!(r.find("b").unwrap().own_text(), "t<A");
        assert!(r.find("c").is_some());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse(b"<a><b></a>").is_err());
        assert!(parse(b"").is_err());
        let deep = "<a>".repeat(MAX_DEPTH + 5);
        assert!(parse(deep.as_bytes()).is_err());
    }
}
