//! PDF : métadonnées à l'ouverture (rendu côté front avec pdf.js sur `read_bytes`) et opérations
//! de structure via `lopdf` (fusion, découpe, extraction, rotation, annotations…).
//!
//! Le handler est en lecture seule : toute modification passe par les commandes `pdf_*`, qui
//! écrivent un `dest` de façon atomique (`dest == path` remplace l'original, avec sauvegarde).
//! Les PDF chiffrés sont refusés (`AppError::Unsupported`). Les opérations qui retirent des pages
//! (extract, delete, split, reorder, merge) ignorent les signets/destinations nommées/formulaires.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::atomic;
use crate::core::handler::{Capabilities, Confidence, Fidelity, FormatHandler};
use crate::core::limits::{MAX_DEPTH, MAX_OPEN_BYTES};
use crate::core::model::{DocumentModel, ModelKind, PdfDoc};
use crate::core::probe::FileProbe;
use crate::error::{AppError, Result};

pub struct PdfHandler;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

/// Annotation standard. Coordonnées en espace utilisateur PDF (origine en bas à gauche).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotation {
    /// Page 1-based.
    pub page: u32,
    /// "highlight" | "note" | "freeText" | "ink".
    pub kind: String,
    /// [x1, y1, x2, y2].
    pub rect: [f32; 4],
    /// QuadPoints (8 nombres par quadrilatère), highlight uniquement.
    pub quads: Option<Vec<f32>>,
    /// Composantes RGB 0..1.
    pub color: [f32; 3],
    pub contents: Option<String>,
    pub author: Option<String>,
    /// Traits à main levée : x,y,x,y… par trait (ink uniquement).
    pub ink_list: Option<Vec<Vec<f32>>>,
}

fn pdf_err(e: impl std::fmt::Display) -> AppError {
    AppError::Corrupt(e.to_string())
}

fn invalid(msg: &str) -> AppError {
    AppError::Limit(msg.to_string())
}

/// Charge un PDF en mémoire sans jamais paniquer (le parseur est appliqué à des données non fiables).
fn load_bytes(bytes: &[u8]) -> Result<Document> {
    let res = std::panic::catch_unwind(|| Document::load_mem(bytes));
    match res {
        Ok(Ok(doc)) => Ok(doc),
        Ok(Err(e)) => Err(pdf_err(e)),
        Err(_) => Err(AppError::Corrupt("PDF illisible".into())),
    }
}

fn read_limited(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path)?.len() > MAX_OPEN_BYTES {
        return Err(AppError::TooLarge);
    }
    Ok(std::fs::read(path)?)
}

fn is_encrypted(doc: &Document) -> bool {
    doc.is_encrypted() || doc.was_encrypted()
}

/// Charge un PDF pour modification : refuse les PDF chiffrés.
fn load_plain(path: &Path) -> Result<Document> {
    let bytes = read_limited(path)?;
    match load_bytes(&bytes) {
        Ok(doc) if is_encrypted(&doc) => Err(AppError::Unsupported),
        Ok(doc) => Ok(doc),
        Err(_) if contains(&bytes, b"/Encrypt") => Err(AppError::Unsupported),
        Err(e) => Err(e),
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn save_doc(doc: &mut Document, dest: &Path) -> Result<()> {
    let mut buf = Vec::new();
    doc.save_to(&mut buf).map_err(pdf_err)?;
    atomic::write(dest, &buf)
}

fn title_of(doc: &Document) -> Option<String> {
    let info = doc.trailer.get(b"Info").ok()?;
    let (_, info) = doc.dereference(info).ok()?;
    let title = info.as_dict().ok()?.get(b"Title").ok()?;
    let (_, title) = doc.dereference(title).ok()?;
    let s = lopdf::decode_text_string(title).ok()?;
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

// --- Aides de structure ---

fn collect_refs(obj: &Object, out: &mut Vec<ObjectId>) {
    let mut stack = vec![obj];
    while let Some(o) = stack.pop() {
        match o {
            Object::Reference(id) => out.push(*id),
            Object::Array(a) => stack.extend(a.iter()),
            Object::Dictionary(d) => stack.extend(d.iter().map(|(_, v)| v)),
            Object::Stream(s) => stack.extend(s.dict.iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

/// Supprime les objets inaccessibles depuis le trailer.
fn prune(doc: &mut Document) {
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let mut todo = Vec::new();
    for (_, v) in doc.trailer.iter() {
        collect_refs(v, &mut todo);
    }
    while let Some(id) = todo.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(o) = doc.objects.get(&id) {
            collect_refs(o, &mut todo);
        }
    }
    doc.objects.retain(|id, _| seen.contains(id));
}

fn inherited(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut cur = page;
    for _ in 0..MAX_DEPTH {
        let d = doc.get_dictionary(cur).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v.clone());
        }
        cur = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Copie dans la page les attributs hérités du parent (avant de la rattacher à un autre arbre).
fn materialize(doc: &mut Document, page: ObjectId) -> Result<()> {
    let mut found = Vec::new();
    {
        let d = doc.get_dictionary(page).map_err(pdf_err)?;
        for key in INHERITABLE {
            if !d.has(key) {
                if let Some(v) = inherited(doc, page, key) {
                    found.push((key, v));
                }
            }
        }
    }
    let d = doc.get_dictionary_mut(page).map_err(pdf_err)?;
    for (key, v) in found {
        d.set(key.to_vec(), v);
    }
    Ok(())
}

fn rotation(doc: &Document, page: ObjectId) -> i64 {
    inherited(doc, page, b"Rotate")
        .and_then(|o| doc.dereference(&o).ok().and_then(|(_, o)| o.as_i64().ok()))
        .unwrap_or(0)
}

fn page_ids(doc: &Document, pages: &[u32]) -> Result<Vec<ObjectId>> {
    let map = doc.get_pages();
    pages
        .iter()
        .map(|n| {
            map.get(n)
                .copied()
                .ok_or_else(|| invalid(&format!("page {n} hors limites")))
        })
        .collect()
}

fn ensure_unique(pages: &[u32]) -> Result<()> {
    let set: BTreeSet<_> = pages.iter().collect();
    if set.len() != pages.len() {
        return Err(invalid("pages dupliquées"));
    }
    Ok(())
}

/// Reconstruit l'arbre des pages à plat avec exactement `ids` (dans cet ordre).
fn keep_pages(doc: &mut Document, ids: &[ObjectId]) -> Result<()> {
    if ids.is_empty() {
        return Err(invalid("aucune page à conserver"));
    }
    for id in ids {
        materialize(doc, *id)?;
    }
    let root = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(pdf_err)?;
    for id in ids {
        doc.get_dictionary_mut(*id)
            .map_err(pdf_err)?
            .set("Parent", root);
    }
    let node = doc.get_dictionary_mut(root).map_err(pdf_err)?;
    node.set(
        "Kids",
        ids.iter()
            .map(|id| Object::Reference(*id))
            .collect::<Vec<_>>(),
    );
    node.set("Count", ids.len() as i64);
    node.remove(b"Parent");
    let catalog = doc.catalog_mut().map_err(pdf_err)?;
    for key in [
        &b"Outlines"[..],
        b"Names",
        b"Dests",
        b"OpenAction",
        b"AcroForm",
        b"StructTreeRoot",
        b"PageLabels",
        b"Threads",
    ] {
        catalog.remove(key);
    }
    strip_dangling_links(doc, ids);
    prune(doc);
    Ok(())
}

/// Neutralise les annotations des pages gardées qui pointent vers une page retirée
/// (`/Dest`, action `GoTo`, `/P`) : sinon `prune` les suivrait et garderait le contenu supprimé.
fn strip_dangling_links(doc: &mut Document, ids: &[ObjectId]) {
    let keep: HashSet<ObjectId> = ids.iter().copied().collect();
    let mut annots: Vec<ObjectId> = Vec::new();
    for id in ids {
        let Ok(page) = doc.get_dictionary(*id) else {
            continue;
        };
        let Ok(list) = page.get(b"Annots") else {
            continue;
        };
        let list = match list {
            Object::Reference(r) => doc.get_object(*r).ok(),
            o => Some(o),
        };
        if let Some(Object::Array(a)) = list {
            annots.extend(a.iter().filter_map(|o| o.as_reference().ok()));
        }
    }
    for id in &annots {
        let Ok(d) = doc.get_dictionary(*id) else {
            continue;
        };
        let action_goto = match d.get(b"A") {
            Ok(Object::Reference(r)) => doc
                .get_dictionary(*r)
                .ok()
                .and_then(|a| a.get(b"S").ok())
                .and_then(|s| s.as_name().ok())
                .is_some_and(|n| n != b"URI"),
            Ok(Object::Dictionary(a)) => a
                .get(b"S")
                .ok()
                .and_then(|s| s.as_name().ok())
                .is_some_and(|n| n != b"URI"),
            _ => false,
        };
        let bad_p = d
            .get(b"P")
            .ok()
            .and_then(|p| p.as_reference().ok())
            .is_some_and(|p| !keep.contains(&p));
        if let Ok(d) = doc.get_dictionary_mut(*id) {
            d.remove(b"Dest");
            if action_goto {
                d.remove(b"A");
            }
            if bad_p {
                d.remove(b"P");
            }
        }
    }
}

// --- Opérations ---

pub fn merge(paths: &[PathBuf], dest: &Path) -> Result<()> {
    if paths.is_empty() {
        return Err(invalid("aucun fichier à fusionner"));
    }
    let mut out = Document::with_version("1.7");
    let mut offset: u32 = 0;
    let mut all_pages: Vec<ObjectId> = Vec::new();
    for p in paths {
        let mut doc = load_plain(p)?;
        let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        for id in &pages {
            materialize(&mut doc, *id)?;
        }
        let mut max = 0;
        for (id, mut obj) in std::mem::take(&mut doc.objects) {
            shift_refs(&mut obj, offset);
            let new_id = (id.0.saturating_add(offset), id.1);
            max = max.max(new_id.0);
            out.objects.insert(new_id, obj);
        }
        all_pages.extend(pages.iter().map(|id| (id.0.saturating_add(offset), id.1)));
        offset = max;
    }
    out.max_id = offset;
    let pages_id = out.new_object_id();
    for id in &all_pages {
        if let Ok(d) = out.get_dictionary_mut(*id) {
            d.set("Parent", pages_id);
        }
    }
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => all_pages.iter().map(|id| Object::Reference(*id)).collect::<Vec<_>>(),
            "Count" => all_pages.len() as i64,
        }),
    );
    let catalog = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    out.trailer.set("Root", catalog);
    prune(&mut out);
    save_doc(&mut out, dest)
}

fn shift_refs(obj: &mut Object, offset: u32) {
    let mut stack = vec![obj];
    while let Some(o) = stack.pop() {
        match o {
            Object::Reference(id) => id.0 = id.0.saturating_add(offset),
            Object::Array(a) => stack.extend(a.iter_mut()),
            Object::Dictionary(d) => stack.extend(d.iter_mut().map(|(_, v)| v)),
            Object::Stream(s) => stack.extend(s.dict.iter_mut().map(|(_, v)| v)),
            _ => {}
        }
    }
}

pub fn split(path: &Path, ranges: &[PageRange], dest_dir: &Path) -> Result<Vec<String>> {
    let doc = load_plain(path)?;
    let count = doc.get_pages().len() as u32;
    for r in ranges {
        if r.start < 1 || r.start > r.end || r.end > count {
            return Err(invalid(&format!("plage {}-{} invalide", r.start, r.end)));
        }
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    std::fs::create_dir_all(dest_dir)?;
    let mut outputs = Vec::new();
    for r in ranges {
        let mut part = doc.clone();
        let pages: Vec<u32> = (r.start..=r.end).collect();
        let ids = page_ids(&part, &pages)?;
        keep_pages(&mut part, &ids)?;
        let file = dest_dir.join(format!("{stem}-{}-{}.pdf", r.start, r.end));
        save_doc(&mut part, &file)?;
        outputs.push(file.to_string_lossy().into_owned());
    }
    Ok(outputs)
}

pub fn extract(path: &Path, pages: &[u32], dest: &Path) -> Result<()> {
    ensure_unique(pages)?;
    let mut doc = load_plain(path)?;
    let ids = page_ids(&doc, pages)?;
    keep_pages(&mut doc, &ids)?;
    save_doc(&mut doc, dest)
}

pub fn delete_pages(path: &Path, pages: &[u32], dest: &Path) -> Result<()> {
    let mut doc = load_plain(path)?;
    page_ids(&doc, pages)?;
    let drop: BTreeSet<u32> = pages.iter().copied().collect();
    let keep: Vec<u32> = doc
        .get_pages()
        .keys()
        .copied()
        .filter(|n| !drop.contains(n))
        .collect();
    let ids = page_ids(&doc, &keep)?;
    keep_pages(&mut doc, &ids)?;
    save_doc(&mut doc, dest)
}

pub fn rotate(path: &Path, pages: &[u32], degrees: i32, dest: &Path) -> Result<()> {
    if degrees % 90 != 0 {
        return Err(invalid("l'angle doit être un multiple de 90"));
    }
    let mut doc = load_plain(path)?;
    let ids = page_ids(&doc, pages)?;
    let unique: BTreeSet<ObjectId> = ids.into_iter().collect();
    for id in unique {
        let new = (rotation(&doc, id) + i64::from(degrees)).rem_euclid(360);
        doc.get_dictionary_mut(id)
            .map_err(pdf_err)?
            .set("Rotate", new);
    }
    save_doc(&mut doc, dest)
}

pub fn reorder(path: &Path, order: &[u32], dest: &Path) -> Result<()> {
    let mut doc = load_plain(path)?;
    let count = doc.get_pages().len();
    ensure_unique(order)?;
    if order.len() != count {
        return Err(invalid("l'ordre doit contenir toutes les pages"));
    }
    let ids = page_ids(&doc, order)?;
    keep_pages(&mut doc, &ids)?;
    save_doc(&mut doc, dest)
}

fn real_array(values: &[f32]) -> Object {
    Object::Array(values.iter().map(|v| Object::Real(*v)).collect())
}

fn check_finite(values: &[f32]) -> Result<()> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(invalid("coordonnée non finie"))
    }
}

fn highlight_appearance(a: &PdfAnnotation, quads: &[f32]) -> Object {
    let mut content = format!("/GS gs {} {} {} rg\n", a.color[0], a.color[1], a.color[2]);
    for q in quads.as_chunks::<8>().0.iter() {
        let xs = q.iter().step_by(2);
        let ys = q.iter().skip(1).step_by(2);
        let (x0, x1) = xs.fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        let (y0, y1) = ys.fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        content.push_str(&format!("{x0} {y0} {} {} re f\n", x1 - x0, y1 - y0));
    }
    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => real_array(&a.rect),
        "Resources" => dictionary! {
            "ExtGState" => dictionary! {
                "GS" => dictionary! { "Type" => "ExtGState", "BM" => "Multiply" },
            },
        },
    };
    Object::Stream(Stream::new(dict, content.into_bytes()))
}

fn build_annotation(doc: &mut Document, a: &PdfAnnotation) -> Result<Object> {
    check_finite(&a.rect)?;
    check_finite(&a.color)?;
    let color: Vec<f32> = a.color.iter().map(|c| c.clamp(0.0, 1.0)).collect();
    let mut d = dictionary! {
        "Type" => "Annot",
        "Rect" => real_array(&a.rect),
        "C" => real_array(&color),
        "F" => 4,
    };
    if let Some(c) = &a.contents {
        d.set("Contents", lopdf::text_string(c));
    }
    if let Some(t) = &a.author {
        d.set("T", lopdf::text_string(t));
    }
    match a.kind.as_str() {
        "highlight" => {
            let [x1, y1, x2, y2] = a.rect;
            let quads = a
                .quads
                .clone()
                .filter(|q| !q.is_empty() && q.len() % 8 == 0)
                .unwrap_or_else(|| vec![x1, y2, x2, y2, x1, y1, x2, y1]);
            check_finite(&quads)?;
            d.set("Subtype", "Highlight");
            d.set("QuadPoints", real_array(&quads));
            let ap = doc.add_object(highlight_appearance(a, &quads));
            d.set("AP", dictionary! { "N" => ap });
        }
        "note" => {
            d.set("Subtype", "Text");
            d.set("Name", "Note");
            d.set("Open", false);
        }
        "freeText" => {
            d.set("Subtype", "FreeText");
            d.set(
                "DA",
                Object::string_literal(format!(
                    "{} {} {} rg /Helv 12 Tf",
                    color[0], color[1], color[2]
                )),
            );
        }
        "ink" => {
            let strokes = a
                .ink_list
                .as_ref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("inkList requis pour une annotation ink"))?;
            for s in strokes {
                check_finite(s)?;
            }
            d.set("Subtype", "Ink");
            d.set(
                "InkList",
                Object::Array(strokes.iter().map(|s| real_array(s)).collect()),
            );
            d.set("BS", dictionary! { "W" => 1 });
        }
        _ => return Err(AppError::Unsupported),
    }
    Ok(Object::Dictionary(d))
}

fn push_annotation(doc: &mut Document, page: ObjectId, annot: ObjectId) -> Result<()> {
    let existing = doc
        .get_dictionary(page)
        .map_err(pdf_err)?
        .get(b"Annots")
        .ok()
        .cloned();
    match existing {
        Some(Object::Reference(r)) => {
            if let Some(Object::Array(a)) = doc.objects.get_mut(&r) {
                a.push(Object::Reference(annot));
                return Ok(());
            }
        }
        Some(Object::Array(_)) => {
            if let Ok(Object::Array(a)) = doc
                .get_dictionary_mut(page)
                .map_err(pdf_err)?
                .get_mut(b"Annots")
            {
                a.push(Object::Reference(annot));
            }
            return Ok(());
        }
        _ => {}
    }
    doc.get_dictionary_mut(page)
        .map_err(pdf_err)?
        .set("Annots", vec![Object::Reference(annot)]);
    Ok(())
}

pub fn annotate(path: &Path, annotations: &[PdfAnnotation], dest: &Path) -> Result<()> {
    let mut doc = load_plain(path)?;
    for a in annotations {
        let page = *page_ids(&doc, &[a.page])?
            .first()
            .ok_or_else(|| invalid("page hors limites"))?;
        let obj = build_annotation(&mut doc, a)?;
        let id = doc.add_object(obj);
        push_annotation(&mut doc, page, id)?;
    }
    save_doc(&mut doc, dest)
}

fn floats(obj: &Object) -> Vec<f32> {
    obj.as_array()
        .map(|a| a.iter().filter_map(|o| o.as_float().ok()).collect())
        .unwrap_or_default()
}

fn parse_annotation(doc: &Document, page: u32, d: &Dictionary) -> Option<PdfAnnotation> {
    let kind = match d.get(b"Subtype").ok()?.as_name().ok()? {
        b"Highlight" => "highlight",
        b"Text" => "note",
        b"FreeText" => "freeText",
        b"Ink" => "ink",
        _ => return None,
    };
    let r = floats(d.get(b"Rect").ok()?);
    let rect = [*r.first()?, *r.get(1)?, *r.get(2)?, *r.get(3)?];
    let c = d.get(b"C").map(floats).unwrap_or_default();
    let color = if c.len() == 3 {
        [c[0], c[1], c[2]]
    } else {
        [0.0, 0.0, 0.0]
    };
    let text = |key: &[u8]| {
        let o = d.get(key).ok()?;
        let (_, o) = doc.dereference(o).ok()?;
        lopdf::decode_text_string(o).ok()
    };
    let quads = d.get(b"QuadPoints").ok().map(floats);
    let ink_list = d
        .get(b"InkList")
        .ok()
        .and_then(|o| o.as_array().ok())
        .map(|a| a.iter().map(floats).collect());
    Some(PdfAnnotation {
        page,
        kind: kind.to_string(),
        rect,
        quads,
        color,
        contents: text(b"Contents"),
        author: text(b"T"),
        ink_list,
    })
}

pub fn list_annotations(path: &Path) -> Result<Vec<PdfAnnotation>> {
    let doc = load_plain(path)?;
    let mut out = Vec::new();
    for (num, id) in doc.get_pages() {
        let Ok(page) = doc.get_dictionary(id) else {
            continue;
        };
        let Ok(annots) = page.get(b"Annots") else {
            continue;
        };
        let Ok((_, annots)) = doc.dereference(annots) else {
            continue;
        };
        let Ok(annots) = annots.as_array() else {
            continue;
        };
        for a in annots {
            let Ok((_, a)) = doc.dereference(a) else {
                continue;
            };
            if let Some(parsed) = a
                .as_dict()
                .ok()
                .and_then(|d| parse_annotation(&doc, num, d))
            {
                out.push(parsed);
            }
        }
    }
    Ok(out)
}

impl FormatHandler for PdfHandler {
    fn id(&self) -> &'static str {
        "pdf"
    }

    fn model(&self) -> ModelKind {
        ModelKind::Pdf
    }

    fn extensions(&self) -> &'static [&'static str] {
        &["pdf"]
    }

    fn label_key(&self) -> &'static str {
        "formats.pdf"
    }

    fn detect(&self, probe: &FileProbe) -> Option<Confidence> {
        if probe.head.starts_with(b"%PDF-") {
            Some(Confidence(95))
        } else if probe.ext == "pdf" {
            Some(Confidence(60))
        } else {
            None
        }
    }

    /// Lecture seule via `save` ; modifications par les commandes `pdf_*`.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            read: true,
            write: false,
            export_to: vec![],
            fidelity: Fidelity::ReadOnly,
        }
    }

    fn open(&self, path: &Path) -> Result<DocumentModel> {
        let bytes = read_limited(path)?;
        match load_bytes(&bytes) {
            Ok(doc) => Ok(DocumentModel::Pdf(PdfDoc {
                page_count: doc.get_pages().len() as u32,
                title: title_of(&doc),
                encrypted: is_encrypted(&doc),
            })),
            // Chiffré avec mot de passe : pas une erreur, le front propose une alternative.
            Err(_) if contains(&bytes, b"/Encrypt") => Ok(DocumentModel::Pdf(PdfDoc {
                page_count: 0,
                title: None,
                encrypted: true,
            })),
            Err(e) => Err(e),
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::Internal)?
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_merge(paths: Vec<String>, dest: String) -> Result<()> {
    blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        merge(&paths, Path::new(&dest))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_split(
    path: String,
    ranges: Vec<PageRange>,
    dest_dir: String,
) -> Result<Vec<String>> {
    blocking(move || split(Path::new(&path), &ranges, Path::new(&dest_dir))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_extract(path: String, pages: Vec<u32>, dest: String) -> Result<()> {
    blocking(move || extract(Path::new(&path), &pages, Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_delete_pages(path: String, pages: Vec<u32>, dest: String) -> Result<()> {
    blocking(move || delete_pages(Path::new(&path), &pages, Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_rotate(path: String, pages: Vec<u32>, degrees: i32, dest: String) -> Result<()> {
    blocking(move || rotate(Path::new(&path), &pages, degrees, Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_reorder(path: String, order: Vec<u32>, dest: String) -> Result<()> {
    blocking(move || reorder(Path::new(&path), &order, Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_annotate(
    path: String,
    annotations: Vec<PdfAnnotation>,
    dest: String,
) -> Result<()> {
    blocking(move || annotate(Path::new(&path), &annotations, Path::new(&dest))).await
}

#[tauri::command]
#[specta::specta]
pub async fn pdf_list_annotations(path: String) -> Result<Vec<PdfAnnotation>> {
    blocking(move || list_annotations(Path::new(&path))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};

    /// PDF de test : `n` pages « Page i ». Resources/MediaBox/Rotate sont sur le nœud Pages (hérités).
    fn make_pdf(n: u32, label: &str, rotate: Option<i64>) -> Vec<u8> {
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
                    Operation::new("Tj", vec![Object::string_literal(format!("{label} {i}"))]),
                    Operation::new("ET", vec![]),
                ],
            };
            let cid = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let pid = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id, "Contents" => cid,
            });
            kids.push(Object::Reference(pid));
        }
        let mut pages = dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => n as i64,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        };
        if let Some(r) = rotate {
            pages.set("Rotate", r);
        }
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let info = doc.add_object(dictionary! { "Title" => Object::string_literal("Mon titre") });
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        doc.trailer.set("Info", info);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    fn write_pdf(dir: &Path, name: &str, n: u32, label: &str, rotate: Option<i64>) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, make_pdf(n, label, rotate)).unwrap();
        p
    }

    /// Textes des pages dans l'ordre ; vérifie aussi que la sortie est rechargeable.
    fn texts(path: &Path) -> Vec<String> {
        let doc = Document::load(path).unwrap();
        doc.get_pages()
            .values()
            .map(|id| {
                let c = String::from_utf8_lossy(&doc.get_page_content(*id)).into_owned();
                let start = c.find('(').unwrap() + 1;
                c[start..c.find(')').unwrap()].to_string()
            })
            .collect()
    }

    #[test]
    fn open_and_detect() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_pdf(dir.path(), "a.pdf", 3, "Page", None);
        match PdfHandler.open(&p).unwrap() {
            DocumentModel::Pdf(d) => {
                assert_eq!(d.page_count, 3);
                assert_eq!(d.title.as_deref(), Some("Mon titre"));
                assert!(!d.encrypted);
            }
            _ => panic!("modèle inattendu"),
        }
        let probe = FileProbe::from_path(&p).unwrap();
        assert_eq!(PdfHandler.detect(&probe), Some(Confidence(95)));
        assert_eq!(
            PdfHandler.detect(&FileProbe::from_bytes("x.pdf", b"zz")),
            Some(Confidence(60))
        );
        assert_eq!(
            PdfHandler.detect(&FileProbe::from_bytes("x.txt", b"zz")),
            None
        );
    }

    #[test]
    fn merge_2_plus_3() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_pdf(dir.path(), "a.pdf", 2, "A", None);
        let b = write_pdf(dir.path(), "b.pdf", 3, "B", None);
        let out = dir.path().join("m.pdf");
        merge(&[a, b], &out).unwrap();
        assert_eq!(texts(&out), ["A 1", "A 2", "B 1", "B 2", "B 3"]);
    }

    #[test]
    fn split_extract_delete_reorder() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_pdf(dir.path(), "doc.pdf", 5, "Page", None);

        let parts = split(
            &p,
            &[
                PageRange { start: 1, end: 2 },
                PageRange { start: 3, end: 5 },
            ],
            &dir.path().join("parts"),
        )
        .unwrap();
        assert!(parts[0].ends_with("doc-1-2.pdf") && parts[1].ends_with("doc-3-5.pdf"));
        assert_eq!(texts(Path::new(&parts[0])), ["Page 1", "Page 2"]);
        assert_eq!(texts(Path::new(&parts[1])), ["Page 3", "Page 4", "Page 5"]);
        assert!(split(&p, &[PageRange { start: 3, end: 9 }], dir.path()).is_err());

        let out = dir.path().join("e.pdf");
        extract(&p, &[4, 1, 3], &out).unwrap();
        assert_eq!(texts(&out), ["Page 4", "Page 1", "Page 3"]);

        let out = dir.path().join("d.pdf");
        delete_pages(&p, &[2, 5], &out).unwrap();
        assert_eq!(texts(&out), ["Page 1", "Page 3", "Page 4"]);
        assert!(delete_pages(&p, &[1, 2, 3, 4, 5], &out).is_err());

        let out = dir.path().join("r.pdf");
        reorder(&p, &[5, 4, 3, 2, 1], &out).unwrap();
        assert_eq!(
            texts(&out),
            ["Page 5", "Page 4", "Page 3", "Page 2", "Page 1"]
        );
        assert!(reorder(&p, &[1, 2], &out).is_err());
        assert!(extract(&p, &[1, 1], &out).is_err());
    }

    #[test]
    fn removed_pages_not_kept_through_links() {
        let dir = tempfile::tempdir().unwrap();
        let mut doc = Document::load_mem(&make_pdf(3, "Secret", None)).unwrap();
        let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link",
            "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "A" => dictionary! { "S" => "GoTo", "D" => vec![Object::Reference(pages[1]), "Fit".into()] },
            "P" => pages[0],
        });
        let link2 = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link",
            "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Dest" => vec![Object::Reference(pages[1]), "Fit".into()],
        });
        doc.get_dictionary_mut(pages[0]).unwrap().set(
            "Annots",
            vec![Object::Reference(link), Object::Reference(link2)],
        );
        let src = dir.path().join("l.pdf");
        doc.save(&src).unwrap();
        let out = dir.path().join("o.pdf");
        delete_pages(&src, &[2], &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert!(!contains(&bytes, b"Secret 2"));
        assert_eq!(texts(&out), ["Secret 1", "Secret 3"]);
    }

    #[test]
    fn rotate_accumulates_with_inherited() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_pdf(dir.path(), "a.pdf", 2, "Page", Some(90));
        let out = dir.path().join("r1.pdf");
        rotate(&p, &[1], 90, &out).unwrap();
        let out2 = dir.path().join("r2.pdf");
        rotate(&out, &[1, 2], -270, &out2).unwrap();
        let doc = Document::load(&out2).unwrap();
        let pages = doc.get_pages();
        // page 1 : 90 hérité + 90 + (-270) = -90 -> 270 ; page 2 : 90 + (-270) -> 180
        assert_eq!(rotation(&doc, pages[&1]), 270);
        assert_eq!(rotation(&doc, pages[&2]), 180);
        assert!(rotate(&p, &[1], 45, &out).is_err());
        assert!(rotate(&p, &[9], 90, &out).is_err());
    }

    #[test]
    fn annotate_then_list() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_pdf(dir.path(), "a.pdf", 2, "Page", None);
        let mk = |page, kind: &str| PdfAnnotation {
            page,
            kind: kind.into(),
            rect: [10.0, 20.0, 110.0, 40.0],
            quads: None,
            color: [1.0, 1.0, 0.0],
            contents: Some("Bonjour é".into()),
            author: Some("Moi".into()),
            ink_list: None,
        };
        let mut ink = mk(2, "ink");
        ink.ink_list = Some(vec![vec![1.0, 2.0, 3.0, 4.0]]);
        let mut hl = mk(1, "highlight");
        hl.quads = Some(vec![10.0, 40.0, 110.0, 40.0, 10.0, 20.0, 110.0, 20.0]);
        let out = dir.path().join("n.pdf");
        annotate(&p, &[hl, mk(1, "note"), mk(2, "freeText"), ink], &out).unwrap();
        // ajout dans un PDF déjà annoté (tableau /Annots existant)
        annotate(&out, &[mk(1, "note")], &out).unwrap();

        let list = list_annotations(&out).unwrap();
        let kinds: Vec<(u32, &str)> = list.iter().map(|a| (a.page, a.kind.as_str())).collect();
        assert_eq!(
            kinds,
            [
                (1, "highlight"),
                (1, "note"),
                (1, "note"),
                (2, "freeText"),
                (2, "ink")
            ]
        );
        assert_eq!(list[0].quads.as_ref().map(Vec::len), Some(8));
        assert_eq!(list[0].contents.as_deref(), Some("Bonjour é"));
        assert_eq!(list[0].author.as_deref(), Some("Moi"));
        assert_eq!(list[0].color, [1.0, 1.0, 0.0]);
        assert_eq!(list[4].ink_list, Some(vec![vec![1.0, 2.0, 3.0, 4.0]]));
        assert_eq!(texts(&out).len(), 2);
        assert!(annotate(&p, &[mk(1, "stamp")], &out).is_err());
        assert!(annotate(&p, &[mk(7, "note")], &out).is_err());
    }

    #[test]
    fn in_place_replaces_original() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_pdf(dir.path(), "a.pdf", 3, "Page", None);
        delete_pages(&p, &[1], &p).unwrap();
        assert_eq!(texts(&p), ["Page 2", "Page 3"]);
    }

    #[test]
    fn corrupted_bytes_do_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let good = make_pdf(3, "Page", None);
        let p = dir.path().join("c.pdf");
        for cut in [0, 5, 20, good.len() / 3, good.len() / 2, good.len() - 10] {
            std::fs::write(&p, &good[..cut]).unwrap();
            let _ = PdfHandler.open(&p);
            let _ = extract(&p, &[1], &dir.path().join("o.pdf"));
            let _ = list_annotations(&p);
        }
        let mut junk = good.clone();
        for (i, b) in junk.iter_mut().enumerate().skip(30) {
            if i % 7 == 0 {
                *b = b.wrapping_add(i as u8);
            }
        }
        std::fs::write(&p, &junk).unwrap();
        let _ = PdfHandler.open(&p);
        let _ = merge(std::slice::from_ref(&p), &dir.path().join("o.pdf"));
        std::fs::write(&p, b"%PDF-1.4 garbage").unwrap();
        assert!(PdfHandler.open(&p).is_err());
    }

    #[test]
    fn encrypted_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e.pdf");
        // Faux PDF chiffré : trailer /Encrypt mais structure inexploitable.
        std::fs::write(&p, b"%PDF-1.4\ntrailer\n<< /Encrypt 1 0 R >>\n%%EOF").unwrap();
        match PdfHandler.open(&p).unwrap() {
            DocumentModel::Pdf(d) => assert!(d.encrypted),
            _ => panic!("modèle inattendu"),
        }
        assert!(matches!(
            extract(&p, &[1], &dir.path().join("o.pdf")),
            Err(AppError::Unsupported)
        ));
    }
}
