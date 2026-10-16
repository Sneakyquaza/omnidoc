//! iCalendar (.ics, RFC 5545) et vCard (.vcf, RFC 6350) : parseur/sérialiseur maison partagé.
//!
//! Conventions du modèle :
//! - `value` est la valeur BRUTE, non décodée : les échappements (`\,` `\;` `\n` `\\`) et les
//!   encodages vCard 2.1 (QUOTED-PRINTABLE…) restent tels quels.
//! - Les valeurs de paramètres sont brutes aussi, guillemets inclus (`PARAM="a,b"`) ; un
//!   paramètre sans `=` (vCard 2.1 : `TEL;WORK:`) est stocké avec une valeur vide.
//! - Noms de propriétés/composants conservés tels quels (casse d'origine) ; propriétés inconnues
//!   conservées dans l'ordre.
//! - Lignes vides ignorées, BOM UTF-8 de tête ignoré, fichier obligatoirement UTF-8.
//! - Sérialisation : CRLF, pliage à 75 octets sans couper un caractère UTF-8. Un fichier déjà
//!   plié ainsi se resérialise à l'octet près.

use std::path::Path;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::MAX_OPEN_BYTES;
use crate::core::model::{
    DocumentModel, ModelKind, RecordComponent, RecordProp, RecordsDoc, RecordsKind,
};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

/// Profondeur max d'imbrication des composants.
pub const MAX_RECORD_DEPTH: usize = 32;
/// Nombre max de propriétés dans un fichier.
pub const MAX_RECORD_PROPS: usize = 100_000;
const FOLD_WIDTH: usize = 75;

/// Dépliage : une ligne commençant par espace/tab prolonge la précédente (ce caractère est ôté).
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    lines
}

/// Découpe `s` sur `sep` hors guillemets.
fn split_unquoted(s: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut in_quote = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if c == '"' {
            in_quote = !in_quote;
        } else if c == sep && !in_quote {
            parts.push(s.get(start..i).unwrap_or_default());
            start = i + c.len_utf8();
        }
    }
    parts.push(s.get(start..).unwrap_or_default());
    parts
}

/// Position du premier `:` hors guillemets.
fn find_colon(s: &str) -> Option<usize> {
    let mut in_quote = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            ':' if !in_quote => return Some(i),
            _ => {}
        }
    }
    None
}

fn parse_prop(line: &str) -> Result<RecordProp> {
    let colon = find_colon(line)
        .ok_or_else(|| AppError::Corrupt(format!("ligne sans « : » : {}", preview(line))))?;
    let header = line.get(..colon).unwrap_or_default();
    let value = line.get(colon + 1..).unwrap_or_default();
    let mut parts = split_unquoted(header, ';').into_iter();
    let name = parts.next().unwrap_or_default();
    if name.is_empty() {
        return Err(AppError::Corrupt(format!(
            "nom de propriété vide : {}",
            preview(line)
        )));
    }
    let params = parts
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (p.to_string(), String::new()),
        })
        .collect();
    Ok(RecordProp {
        name: name.to_string(),
        params,
        value: value.to_string(),
    })
}

fn preview(line: &str) -> String {
    line.chars().take(40).collect()
}

/// Analyse un fichier iCalendar/vCard complet.
pub fn parse(bytes: &[u8], kind: RecordsKind) -> Result<RecordsDoc> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Corrupt("le fichier n'est pas en UTF-8".to_string()))?;
    let mut roots: Vec<RecordComponent> = Vec::new();
    let mut stack: Vec<RecordComponent> = Vec::new();
    let mut count = 0usize;
    let mut lines = unfold(text).into_iter();
    while let Some(line) = lines.next() {
        let mut prop = parse_prop(&line)?;
        // vCard 2.1 QUOTED-PRINTABLE : `=` en fin de ligne = coupure souple, la ligne suivante
        // est une continuation (conservée telle quelle, séparée par CRLF).
        while is_quoted_printable(&prop) && prop.value.ends_with('=') {
            match lines.next() {
                Some(next) => {
                    prop.value.push_str("\r\n");
                    prop.value.push_str(&next);
                }
                None => break,
            }
        }
        if prop.name.eq_ignore_ascii_case("BEGIN") {
            if stack.len() >= MAX_RECORD_DEPTH {
                return Err(AppError::Limit(format!(
                    "imbrication supérieure à {MAX_RECORD_DEPTH}"
                )));
            }
            stack.push(RecordComponent {
                name: prop.value,
                props: Vec::new(),
                children: Vec::new(),
            });
        } else if prop.name.eq_ignore_ascii_case("END") {
            let done = stack
                .pop()
                .ok_or_else(|| AppError::Corrupt("END sans BEGIN".to_string()))?;
            if !done.name.eq_ignore_ascii_case(&prop.value) {
                return Err(AppError::Corrupt(format!(
                    "END:{} ne correspond pas à BEGIN:{}",
                    prop.value, done.name
                )));
            }
            match stack.last_mut() {
                Some(parent) => parent.children.push(done),
                None => roots.push(done),
            }
        } else {
            count += 1;
            if count > MAX_RECORD_PROPS {
                return Err(AppError::Limit(format!(
                    "plus de {MAX_RECORD_PROPS} propriétés"
                )));
            }
            match stack.last_mut() {
                Some(c) => c.props.push(prop),
                None => {
                    return Err(AppError::Corrupt(format!(
                        "propriété hors composant : {}",
                        prop.name
                    )))
                }
            }
        }
    }
    if let Some(open) = stack.last() {
        return Err(AppError::Corrupt(format!(
            "composant {} non fermé",
            open.name
        )));
    }
    Ok(RecordsDoc {
        kind,
        components: roots,
    })
}

/// Ajoute `line` pliée à 75 octets (continuations : espace + 74 octets), CRLF final.
fn push_folded(out: &mut Vec<u8>, line: &str) {
    let mut rest = line;
    let mut limit = FOLD_WIDTH;
    while rest.len() > limit {
        let mut cut = limit;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let (head, tail) = rest.split_at(cut);
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(b"\r\n ");
        rest = tail;
        limit = FOLD_WIDTH - 1;
    }
    out.extend_from_slice(rest.as_bytes());
    out.extend_from_slice(b"\r\n");
}

fn is_quoted_printable(p: &RecordProp) -> bool {
    p.params.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("QUOTED-PRINTABLE") || v.eq_ignore_ascii_case("QUOTED-PRINTABLE")
    })
}

/// Remplace tout saut de ligne réel par l'échappement littéral `\n` (RFC 5545/6350).
fn escape_newlines(s: &str) -> String {
    s.replace("\r\n", "\\n").replace(['\n', '\r'], "\\n")
}

fn write_component(out: &mut Vec<u8>, c: &RecordComponent) {
    push_folded(out, &format!("BEGIN:{}", c.name));
    for p in &c.props {
        let mut line = p.name.clone();
        for (k, v) in &p.params {
            line.push(';');
            line.push_str(k);
            if !v.is_empty() {
                line.push('=');
                line.push_str(&escape_newlines(v));
            }
        }
        line.push(':');
        if is_quoted_printable(p) {
            // Lignes physiques d'une valeur QUOTED-PRINTABLE multiligne.
            let mut segs = p.value.split("\r\n");
            line.push_str(segs.next().unwrap_or_default());
            push_folded(out, &line);
            for seg in segs {
                push_folded(out, seg);
            }
            continue;
        }
        line.push_str(&escape_newlines(&p.value));
        push_folded(out, &line);
    }
    for child in &c.children {
        write_component(out, child);
    }
    push_folded(out, &format!("END:{}", c.name));
}

/// Sérialise en CRLF avec pliage à 75 octets.
pub fn serialize(doc: &RecordsDoc) -> Vec<u8> {
    let mut out = Vec::new();
    for c in &doc.components {
        write_component(&mut out, c);
    }
    out
}

pub struct RecordsHandler {
    kind: RecordsKind,
}

impl RecordsHandler {
    pub fn ics() -> Self {
        Self {
            kind: RecordsKind::Ics,
        }
    }

    pub fn vcf() -> Self {
        Self {
            kind: RecordsKind::Vcf,
        }
    }

    fn magic(&self) -> &'static [u8] {
        match self.kind {
            RecordsKind::Ics => b"BEGIN:VCALENDAR",
            RecordsKind::Vcf => b"BEGIN:VCARD",
        }
    }
}

impl FormatHandler for RecordsHandler {
    fn id(&self) -> &'static str {
        match self.kind {
            RecordsKind::Ics => "ics",
            RecordsKind::Vcf => "vcf",
        }
    }

    fn model(&self) -> ModelKind {
        ModelKind::Records
    }

    fn extensions(&self) -> &'static [&'static str] {
        match self.kind {
            RecordsKind::Ics => &["ics"],
            RecordsKind::Vcf => &["vcf"],
        }
    }

    fn label_key(&self) -> &'static str {
        match self.kind {
            RecordsKind::Ics => "formats.ics",
            RecordsKind::Vcf => "formats.vcf",
        }
    }

    /// Extension + signature 90 ; extension seule 60 ; signature seule 40.
    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        let ext_ok = self.extensions().contains(&probe.ext.as_str());
        let head = probe
            .head
            .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
            .unwrap_or(&probe.head);
        let head = head.trim_ascii_start();
        let magic = self.magic();
        let sig_ok = head
            .get(..magic.len())
            .is_some_and(|h| h.eq_ignore_ascii_case(magic));
        match (ext_ok, sig_ok) {
            (true, true) => Some(Confidence(90)),
            (true, false) => Some(Confidence(60)),
            (false, true) => Some(Confidence(40)),
            _ => None,
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: true,
            export_to: vec![],
            fidelity: Fidelity::Full,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
            return Err(AppError::TooLarge);
        }
        let bytes = std::fs::read(path)?;
        Ok(DocumentModel::Records(parse(&bytes, self.kind)?))
    }

    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> {
        let DocumentModel::Records(r) = doc else {
            return Err(AppError::Unsupported);
        };
        atomic::write(path, &serialize(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICS: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//FR\r\n\
BEGIN:VEVENT\r\nUID:1@x\r\nDTSTART;TZID=Europe/Paris:20261015T090000\r\n\
SUMMARY:Réunion\\, importante\\; \\n suite\r\nATTENDEE;CN=\"Doe, John\";ROLE=REQ-PARTICIPANT:mailto:j@x.org\r\n\
X-CUSTOM;FOO=bar:valeur inconnue\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn long_ics() -> Vec<u8> {
        // Une description longue, accentuée, repliée par notre propre sérialiseur.
        let desc = format!("DESCRIPTION:{}", "é€ab".repeat(60));
        let mut out = Vec::new();
        push_folded(&mut out, "BEGIN:VCALENDAR");
        push_folded(&mut out, "BEGIN:VEVENT");
        push_folded(&mut out, &desc);
        push_folded(&mut out, "END:VEVENT");
        push_folded(&mut out, "END:VCALENDAR");
        out
    }

    #[test]
    fn parses_structure() {
        let d = parse(ICS.as_bytes(), RecordsKind::Ics).unwrap();
        assert_eq!(d.components.len(), 1);
        let cal = &d.components[0];
        assert_eq!(cal.name, "VCALENDAR");
        assert_eq!(cal.props.len(), 2);
        let ev = &cal.children[0];
        assert_eq!(ev.name, "VEVENT");
        assert_eq!(ev.children[0].name, "VALARM");
        assert_eq!(ev.props[0].value, "1@x");
        assert_eq!(
            ev.props[1].params,
            vec![("TZID".to_string(), "Europe/Paris".to_string())]
        );
        assert_eq!(ev.props[2].value, "Réunion\\, importante\\; \\n suite");
        assert_eq!(ev.props[3].params[0], ("CN".into(), "\"Doe, John\"".into()));
        assert_eq!(ev.props[3].value, "mailto:j@x.org");
        assert_eq!(ev.props[4].name, "X-CUSTOM");
    }

    #[test]
    fn byte_identical_roundtrip() {
        assert_eq!(
            serialize(&parse(ICS.as_bytes(), RecordsKind::Ics).unwrap()),
            ICS.as_bytes()
        );
        let long = long_ics();
        let d = parse(&long, RecordsKind::Ics).unwrap();
        let desc = &d.components[0].children[0].props[0];
        assert_eq!(desc.value, "é€ab".repeat(60));
        assert_eq!(serialize(&d), long);
        // Aucune ligne > 75 octets et aucune coupure dans un caractère.
        for l in long.split(|b| *b == b'\n') {
            assert!(l.len() <= 76);
        }
        assert!(std::str::from_utf8(&long).is_ok());
    }

    #[test]
    fn vcard_roundtrip_and_tolerance() {
        let vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jean\r\nTEL;TYPE=WORK,VOICE:+33 1\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:B\r\nEND:VCARD\r\n";
        let d = parse(vcf.as_bytes(), RecordsKind::Vcf).unwrap();
        assert_eq!(d.components.len(), 2);
        assert_eq!(d.components[0].props[2].params[0].1, "WORK,VOICE");
        assert_eq!(serialize(&d), vcf.as_bytes());
        // LF seuls et dépliage tab : accepté, resérialisé en CRLF.
        let lf = "BEGIN:VCARD\nNOTE:ab\n\tcd\nEND:VCARD\n";
        let d = parse(lf.as_bytes(), RecordsKind::Vcf).unwrap();
        assert_eq!(d.components[0].props[0].value, "abcd");
        // Paramètre sans valeur (vCard 2.1).
        let v21 = "BEGIN:VCARD\r\nTEL;WORK;VOICE:1\r\nEND:VCARD\r\n";
        assert_eq!(
            serialize(&parse(v21.as_bytes(), RecordsKind::Vcf).unwrap()),
            v21.as_bytes()
        );
    }

    #[test]
    fn newlines_in_values_are_escaped_and_roundtrip() {
        let mut d = parse(ICS.as_bytes(), RecordsKind::Ics).unwrap();
        let ev = &mut d.components[0];
        ev.props.push(RecordProp {
            name: "DESCRIPTION".into(),
            params: vec![],
            value: "a\nb\r\nc\rd".into(),
        });
        let bytes = serialize(&d);
        let back = parse(&bytes, RecordsKind::Ics).unwrap();
        let v = &back.components[0].props.last().unwrap().value;
        assert_eq!(v, "a\\nb\\nc\\nd");
        assert_eq!(serialize(&back), bytes);
    }

    #[test]
    fn quoted_printable_soft_breaks_roundtrip() {
        let vcf = "BEGIN:VCARD\r\nVERSION:2.1\r\nNOTE;ENCODING=QUOTED-PRINTABLE:ligne un=0A=\r\nligne deux\r\nFN:Jean\r\nEND:VCARD\r\n";
        let d = parse(vcf.as_bytes(), RecordsKind::Vcf).unwrap();
        let props = &d.components[0].props;
        assert_eq!(props.len(), 3);
        assert_eq!(props[2].name, "FN");
        assert_eq!(serialize(&d), vcf.as_bytes());
    }

    #[test]
    fn limits() {
        let mut deep = String::new();
        for _ in 0..=MAX_RECORD_DEPTH {
            deep.push_str("BEGIN:X\r\n");
        }
        assert!(matches!(
            parse(deep.as_bytes(), RecordsKind::Ics),
            Err(AppError::Limit(_))
        ));
        let mut many = String::from("BEGIN:X\r\n");
        for _ in 0..=MAX_RECORD_PROPS {
            many.push_str("A:b\r\n");
        }
        many.push_str("END:X\r\n");
        assert!(matches!(
            parse(many.as_bytes(), RecordsKind::Ics),
            Err(AppError::Limit(_))
        ));
    }

    #[test]
    fn corrupted_input_never_panics() {
        for bad in [
            &b""[..],
            b"\xff\xfe\x00",
            b"BEGIN:VCALENDAR",
            b"END:VCALENDAR\r\n",
            b"BEGIN:A\r\nEND:B\r\n",
            b"NOCOLON\r\n",
            b":x\r\n",
            b"A:b\r\n",
            b"BEGIN:A\r\nX;P=\"unclosed:v\r\nEND:A\r\n",
            b" \r\n \t\r\n",
            b"BEGIN:A\r\n \r\n\xc3",
        ] {
            let _ = parse(bad, RecordsKind::Ics);
        }
        // Troncatures et octets altérés d'un fichier valide.
        let src = ICS.as_bytes();
        for i in 0..src.len() {
            let _ = parse(&src[..i], RecordsKind::Ics);
            let mut v = src.to_vec();
            if let Some(b) = v.get_mut(i) {
                *b = b.wrapping_add(97);
            }
            let _ = parse(&v, RecordsKind::Ics);
        }
    }

    #[test]
    fn detection() {
        let ics = RecordsHandler::ics();
        let vcf = RecordsHandler::vcf();
        let p = |n: &str, b: &[u8]| FileProbe::from_bytes(n, b);
        assert_eq!(
            ics.detect(&p("a.ics", b"BEGIN:VCALENDAR\r\n")),
            Some(Confidence(90))
        );
        assert_eq!(ics.detect(&p("a.ics", b"zzz")), Some(Confidence(60)));
        assert_eq!(
            ics.detect(&p("a.txt", b"begin:vcalendar")),
            Some(Confidence(40))
        );
        assert_eq!(ics.detect(&p("a.txt", b"hello")), None);
        assert_eq!(
            vcf.detect(&p("c.vcf", b"BEGIN:VCARD\r\n")),
            Some(Confidence(90))
        );
        assert_eq!(vcf.detect(&p("c.ics", b"BEGIN:VCALENDAR")), None);
    }

    #[test]
    fn handler_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.ics");
        std::fs::write(&f, ICS).unwrap();
        let h = RecordsHandler::ics();
        let m = h.open(&f).unwrap();
        let g = dir.path().join("b.ics");
        h.save(&m, &g).unwrap();
        assert_eq!(std::fs::read(&g).unwrap(), ICS.as_bytes());
        assert_eq!(
            serde_json::to_value(h.open(&g).unwrap()).unwrap(),
            serde_json::to_value(m).unwrap()
        );
    }
}
