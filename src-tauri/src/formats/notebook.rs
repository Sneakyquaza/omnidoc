//! Jupyter Notebook (.ipynb, nbformat 4) en lecture seule.
//!
//! Conventions de `NotebookOutput.kind` (type de rendu) :
//! - `"stream"` : `text` ; `"text"` : `text` (text/plain) ; `"error"` : `text` (ename, evalue,
//!   traceback sans codes ANSI) ;
//! - `"html"` : `data` = HTML assaini, `mime` = "text/html" ;
//! - `"image"` : `data` = data URI (png, jpeg, svg+xml), `mime` = type d'origine.

use std::path::Path;

use base64::Engine;
use serde_json::Value;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{DocumentModel, ModelKind, NotebookCell, NotebookDoc, NotebookOutput};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub struct NotebookHandler;

fn join_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

/// Retire les séquences d'échappement ANSI (CSI et ESC isolés).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&n) {
                    break;
                }
            }
        }
    }
    out
}

fn sanitize_html(html: &str) -> String {
    ammonia::clean(html)
}

fn data_uri(mime: &str, v: &Value) -> Option<String> {
    let raw = join_text(v);
    if mime == "image/svg+xml" {
        let b64 = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        return Some(format!("data:{mime};base64,{b64}"));
    }
    let b64: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    (!b64.is_empty()).then(|| format!("data:{mime};base64,{b64}"))
}

fn rich_output(data: &Value) -> Option<NotebookOutput> {
    let get = |k: &str| data.get(k);
    if let Some(h) = get("text/html") {
        return Some(NotebookOutput {
            kind: "html".into(),
            text: None,
            mime: Some("text/html".into()),
            data: Some(sanitize_html(&join_text(h))),
        });
    }
    for mime in ["image/png", "image/jpeg", "image/svg+xml"] {
        if let Some(uri) = get(mime).and_then(|v| data_uri(mime, v)) {
            return Some(NotebookOutput {
                kind: "image".into(),
                text: None,
                mime: Some(mime.into()),
                data: Some(uri),
            });
        }
    }
    get("text/plain").map(|t| NotebookOutput {
        kind: "text".into(),
        text: Some(join_text(t)),
        mime: Some("text/plain".into()),
        data: None,
    })
}

fn parse_output(o: &Value) -> Option<NotebookOutput> {
    match o.get("output_type")?.as_str()? {
        "stream" => Some(NotebookOutput {
            kind: "stream".into(),
            text: Some(join_text(o.get("text")?)),
            mime: None,
            data: None,
        }),
        "execute_result" | "display_data" => rich_output(o.get("data")?),
        "error" => {
            let name = o.get("ename").and_then(Value::as_str).unwrap_or("");
            let value = o.get("evalue").and_then(Value::as_str).unwrap_or("");
            let tb = o
                .get("traceback")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            Some(NotebookOutput {
                kind: "error".into(),
                text: Some(strip_ansi(&format!("{name}: {value}\n{tb}"))),
                mime: None,
                data: None,
            })
        }
        _ => None,
    }
}

fn language_of(root: &Value) -> String {
    let meta = root.get("metadata");
    meta.and_then(|m| m.get("kernelspec"))
        .and_then(|k| k.get("language"))
        .and_then(Value::as_str)
        .or_else(|| {
            meta.and_then(|m| m.get("language_info"))
                .and_then(|k| k.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string()
}

fn parse_notebook(bytes: &[u8]) -> Result<NotebookDoc> {
    // serde_json refuse au-delà de 128 niveaux d'imbrication (erreur, pas de panique).
    let root: Value = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Corrupt(format!("JSON invalide : {e}")))?;
    let cells = root
        .get("cells")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Corrupt("notebook sans cellules (nbformat 4 requis)".into()))?;
    let cells = cells
        .iter()
        .map(|c| {
            let cell_type = c
                .get("cell_type")
                .and_then(Value::as_str)
                .filter(|t| matches!(*t, "markdown" | "code" | "raw"))
                .unwrap_or("raw");
            NotebookCell {
                cell_type: cell_type.into(),
                source: c.get("source").map(join_text).unwrap_or_default(),
                outputs: c
                    .get("outputs")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(parse_output).collect())
                    .unwrap_or_default(),
            }
        })
        .collect();
    Ok(NotebookDoc {
        cells,
        language: language_of(&root),
    })
}

/// Fence assez longue pour entourer `content`.
fn fence(content: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

fn fenced(out: &mut String, lang: &str, content: &str) {
    let f = fence(content);
    out.push_str(&format!(
        "{f}{lang}\n{}\n{f}\n\n",
        content.trim_end_matches('\n')
    ));
}

fn to_markdown(doc: &NotebookDoc) -> String {
    let mut out = String::new();
    for c in &doc.cells {
        match c.cell_type.as_str() {
            "markdown" => out.push_str(&format!("{}\n\n", c.source.trim_end_matches('\n'))),
            "code" => {
                fenced(&mut out, &doc.language, &c.source);
                for o in &c.outputs {
                    if let (true, Some(t)) = (
                        matches!(o.kind.as_str(), "stream" | "text" | "error"),
                        &o.text,
                    ) {
                        fenced(&mut out, "text", t);
                    }
                }
            }
            _ => fenced(&mut out, "", &c.source),
        }
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn to_html(doc: &NotebookDoc) -> String {
    let mut out = String::from(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>Notebook</title>\
         <style>body{font-family:sans-serif;max-width:60em;margin:2em auto;padding:0 1em}\
         pre{background:#f5f5f5;padding:.6em;overflow:auto;white-space:pre-wrap}\
         .out{border-left:3px solid #bbb;padding-left:.6em}.err{color:#a00}img{max-width:100%}\
         </style></head><body>\n",
    );
    for c in &doc.cells {
        match c.cell_type.as_str() {
            "markdown" => out.push_str(&format!("<pre class=\"md\">{}</pre>\n", esc(&c.source))),
            "code" => {
                out.push_str(&format!(
                    "<pre><code class=\"language-{}\">{}</code></pre>\n",
                    esc(&doc.language),
                    esc(&c.source)
                ));
                for o in &c.outputs {
                    match (o.kind.as_str(), &o.text, &o.data) {
                        ("error", Some(t), _) => {
                            out.push_str(&format!("<pre class=\"out err\">{}</pre>\n", esc(t)))
                        }
                        (_, Some(t), _) => {
                            out.push_str(&format!("<pre class=\"out\">{}</pre>\n", esc(t)))
                        }
                        ("html", _, Some(h)) => {
                            out.push_str(&format!("<div class=\"out\">{h}</div>\n"))
                        }
                        ("image", _, Some(u)) => out.push_str(&format!(
                            "<div class=\"out\"><img src=\"{}\" alt=\"\"></div>\n",
                            esc(u)
                        )),
                        _ => {}
                    }
                }
            }
            _ => out.push_str(&format!("<pre>{}</pre>\n", esc(&c.source))),
        }
    }
    out.push_str("</body></html>\n");
    out
}

impl FormatHandler for NotebookHandler {
    fn id(&self) -> &'static str {
        "ipynb"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Notebook
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["ipynb"]
    }

    fn label_key(&self) -> &'static str {
        "formats.ipynb"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        if probe.ext != "ipynb" {
            return None;
        }
        let head = String::from_utf8_lossy(&probe.head);
        if head.contains("\"cells\"") && head.contains("\"nbformat\"") {
            Some(Confidence(90))
        } else if head.trim_start().starts_with('{') {
            // « nbformat » est souvent en fin de fichier, hors de l'en-tête sondé.
            Some(Confidence(75))
        } else {
            Some(Confidence(60))
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec!["md".into(), "html".into()],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
            return Err(AppError::TooLarge);
        }
        let bytes = std::fs::read(path)?;
        Ok(DocumentModel::Notebook(parse_notebook(&bytes)?))
    }

    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> {
        let DocumentModel::Notebook(d) = doc else {
            return Err(AppError::Unsupported);
        };
        match target {
            "md" => atomic::write(path, to_markdown(d).as_bytes()),
            "html" => atomic::write(path, to_html(d).as_bytes()),
            _ => Err(AppError::Unsupported),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NB: &str = r##"{
 "cells": [
  {"cell_type":"markdown","source":["# Titre\n","texte"]},
  {"cell_type":"code","source":"print(1)","outputs":[
    {"output_type":"stream","name":"stdout","text":["1\n"]},
    {"output_type":"execute_result","data":{"text/plain":"2","text/html":"<b>2</b><script>x()</script>"}},
    {"output_type":"display_data","data":{"image/png":"iVBO\nRw==","text/plain":"<img>"}},
    {"output_type":"display_data","data":{"image/svg+xml":["<svg/>"]}},
    {"output_type":"error","ename":"ValueError","evalue":"bad","traceback":["\u001b[31mTrace\u001b[0m"]}
  ]},
  {"cell_type":"weird","source":"x"}
 ],
 "metadata": {"kernelspec":{"language":"python","name":"python3"}},
 "nbformat": 4, "nbformat_minor": 5
}"##;

    fn doc() -> NotebookDoc {
        parse_notebook(NB.as_bytes()).unwrap()
    }

    #[test]
    fn parses_cells_outputs_and_language() {
        let d = doc();
        assert_eq!(d.language, "python");
        assert_eq!(d.cells.len(), 3);
        assert_eq!(d.cells[0].source, "# Titre\ntexte");
        assert_eq!(d.cells[2].cell_type, "raw");
        let o = &d.cells[1].outputs;
        assert_eq!(o.len(), 5);
        assert_eq!(
            (o[0].kind.as_str(), o[0].text.as_deref()),
            ("stream", Some("1\n"))
        );
        assert_eq!(o[1].kind, "html");
        assert_eq!(o[1].data.as_deref(), Some("<b>2</b>"));
        assert_eq!(o[2].data.as_deref(), Some("data:image/png;base64,iVBORw=="));
        assert!(o[3]
            .data
            .as_deref()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert_eq!(o[4].kind, "error");
        let t = o[4].text.as_deref().unwrap();
        assert!(t.contains("ValueError: bad") && t.contains("Trace") && !t.contains('\u{1b}'));
    }

    #[test]
    fn exports_md_and_html() {
        let d = DocumentModel::Notebook(doc());
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("a.md");
        NotebookHandler.export(&d, "md", &md).unwrap();
        let s = std::fs::read_to_string(&md).unwrap();
        assert!(
            s.contains("# Titre")
                && s.contains("```python\nprint(1)\n```")
                && s.contains("```text\n1\n```")
        );
        let html = dir.path().join("a.html");
        NotebookHandler.export(&d, "html", &html).unwrap();
        let s = std::fs::read_to_string(&html).unwrap();
        assert!(s.contains("<b>2</b>") && !s.contains("<script"));
        assert!(NotebookHandler.export(&d, "pdf", &html).is_err());
        assert!(matches!(
            NotebookHandler.save(&d, &html),
            Err(AppError::ReadOnly)
        ));
    }

    #[test]
    fn opens_file_detects_and_rejects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("n.ipynb");
        std::fs::write(&p, NB).unwrap();
        assert!(NotebookHandler.open(&p).is_ok());
        let probe = FileProbe::from_path(&p).unwrap();
        assert_eq!(NotebookHandler.detect(&probe), Some(Confidence(90)));
        assert_eq!(
            NotebookHandler.detect(&FileProbe::from_bytes("a.json", b"{}")),
            None
        );
        for bad in ["", "{", "[]", "{\"cells\": 3}", &"[".repeat(5000)] {
            assert!(parse_notebook(bad.as_bytes()).is_err());
        }
        assert!(parse_notebook(&NB.as_bytes()[..100]).is_err());
    }
}
