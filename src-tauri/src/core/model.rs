//! Modèles de documents échangés avec le front (ARCHITECTURE.md §2).
//! Les contenus binaires lourds ne transitent jamais ici (voir `read_bytes`).

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentModel {
    Text(TextDoc),
    RichText(RichDoc),
    Sheet(Workbook),
    Image(ImageDoc),
    Pdf(PdfDoc),
    Archive(ArchiveDoc),
    Media(MediaDoc),
    Database(DbDoc),
    Records(RecordsDoc),
    Notebook(NotebookDoc),
    Ebook(EbookDoc),
    Slides(SlidesDoc),
    Binary(BinaryDoc),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModelKind {
    Text,
    RichText,
    Sheet,
    Image,
    Pdf,
    Archive,
    Media,
    Database,
    Records,
    Notebook,
    Ebook,
    Slides,
    Binary,
}

impl DocumentModel {
    pub fn kind(&self) -> ModelKind {
        match self {
            DocumentModel::Text(_) => ModelKind::Text,
            DocumentModel::RichText(_) => ModelKind::RichText,
            DocumentModel::Sheet(_) => ModelKind::Sheet,
            DocumentModel::Image(_) => ModelKind::Image,
            DocumentModel::Pdf(_) => ModelKind::Pdf,
            DocumentModel::Archive(_) => ModelKind::Archive,
            DocumentModel::Media(_) => ModelKind::Media,
            DocumentModel::Database(_) => ModelKind::Database,
            DocumentModel::Records(_) => ModelKind::Records,
            DocumentModel::Notebook(_) => ModelKind::Notebook,
            DocumentModel::Ebook(_) => ModelKind::Ebook,
            DocumentModel::Slides(_) => ModelKind::Slides,
            DocumentModel::Binary(_) => ModelKind::Binary,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

// --- Text ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDoc {
    pub text: String,
    /// Label `encoding_rs` (ex. "UTF-8").
    pub encoding: String,
    pub bom: bool,
    pub line_ending: LineEnding,
    /// Identifiant de langage CodeMirror deviné par extension.
    pub language: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
}

// --- RichText (JSON ProseMirror/TipTap) ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RichDoc {
    /// Typé `unknown` côté TS (le schéma TipTap est validé par l'éditeur).
    #[specta(type = specta_typescript::Unknown)]
    pub doc: serde_json::Value,
    pub meta: RichMeta,
    /// Éléments du format source non conservés.
    pub lossy: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RichMeta {
    pub title: Option<String>,
    pub author: Option<String>,
}

// --- Sheet ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workbook {
    pub sheets: Vec<Sheet>,
    pub csv: Option<CsvOptions>,
    /// Éléments non conservés à l'ouverture (styles, graphiques, fusions…), pour avertir l'utilisateur.
    #[serde(default)]
    pub lossy: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub name: String,
    /// Lignes denses, de longueurs éventuellement variables.
    pub rows: Vec<Vec<Cell>>,
    pub col_widths: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub v: CellValue,
    /// Formule sans le "=" initial, syntaxe Excel anglaise à virgules (`SUM(A1:B2)`).
    pub f: Option<String>,
    /// Code de format de nombre Excel (ex. "0.00%") si connu.
    pub fmt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Bool(bool),
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    pub delimiter: String,
    pub quote: String,
    pub encoding: String,
    pub header: bool,
    /// BOM UTF-8 présent à l'origine.
    #[serde(default)]
    pub bom: bool,
    /// Fins de ligne CRLF (sinon LF).
    #[serde(default)]
    pub crlf: bool,
}

// --- Image ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageDoc {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub has_alpha: bool,
    pub exif: Vec<ExifEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExifEntry {
    pub tag: String,
    pub value: String,
}

// --- Pdf ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PdfDoc {
    pub page_count: u32,
    pub title: Option<String>,
    pub encrypted: bool,
}

// --- Archive ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDoc {
    pub format: String,
    pub entries: Vec<ArchiveEntry>,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub compressed_size: Option<u64>,
    pub is_dir: bool,
    pub modified: Option<String>,
}

// --- Media ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaDoc {
    pub mime: String,
    pub duration_ms: Option<u64>,
    pub tags: Vec<KeyValue>,
    pub pictures: u32,
}

// --- Database ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbDoc {
    pub tables: Vec<DbTable>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    pub name: String,
    pub kind: DbTableKind,
    pub columns: Vec<DbColumn>,
    pub row_count: u64,
    /// Faux si le comptage a dépassé le délai (`row_count` vaut alors 0 et est inconnu).
    #[serde(default)]
    pub row_count_exact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DbTableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
}

// --- Records (ics, vcf) ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordsDoc {
    /// Sérialisé en `format` : `kind` entrerait en collision avec le tag de `DocumentModel`.
    #[serde(rename = "format")]
    pub kind: RecordsKind,
    pub components: Vec<RecordComponent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordsKind {
    Ics,
    Vcf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordComponent {
    pub name: String,
    pub props: Vec<RecordProp>,
    pub children: Vec<RecordComponent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordProp {
    pub name: String,
    pub params: Vec<(String, String)>,
    pub value: String,
}

// --- Notebook ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookDoc {
    pub cells: Vec<NotebookCell>,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCell {
    pub cell_type: String,
    pub source: String,
    pub outputs: Vec<NotebookOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookOutput {
    pub kind: String,
    pub text: Option<String>,
    pub mime: Option<String>,
    pub data: Option<String>,
}

// --- Ebook ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EbookDoc {
    pub title: String,
    pub author: Option<String>,
    pub chapters: Vec<EbookChapter>,
    /// Éléments du livre non conservés (ids : "css", "images-omitted", "remote-images").
    #[serde(default)]
    pub lossy: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EbookChapter {
    pub title: String,
    /// HTML assaini (aucun script).
    pub html: String,
}

// --- Slides ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlidesDoc {
    pub slides: Vec<Slide>,
    /// Miniature du fichier (data URI), si présente.
    #[serde(default)]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Slide {
    pub index: u32,
    pub texts: Vec<String>,
    pub notes: Option<String>,
}

// --- Binary ---

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDoc {
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_is_tagged_by_kind() {
        let m = DocumentModel::Binary(BinaryDoc { size: 3 });
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["kind"], "binary");
        assert_eq!(v["size"], 3);
        let back: DocumentModel = serde_json::from_value(v).unwrap();
        assert_eq!(back.kind(), ModelKind::Binary);
    }

    #[test]
    fn records_model_roundtrips_without_kind_collision() {
        let m = DocumentModel::Records(RecordsDoc {
            kind: RecordsKind::Ics,
            components: vec![],
        });
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["kind"], "records");
        assert_eq!(v["format"], "ics");
        let back: DocumentModel = serde_json::from_value(v).unwrap();
        assert_eq!(back.kind(), ModelKind::Records);
    }

    #[test]
    fn rich_text_kind_is_camel_case() {
        let m = DocumentModel::RichText(RichDoc {
            doc: serde_json::json!({"type": "doc"}),
            meta: RichMeta::default(),
            lossy: vec![],
        });
        assert_eq!(serde_json::to_value(&m).unwrap()["kind"], "richText");
    }

    #[test]
    fn cell_value_roundtrip() {
        let c = Cell {
            v: CellValue::Number(1.5),
            f: Some("A1+1".into()),
            fmt: None,
        };
        let back: Cell = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.v, CellValue::Number(1.5));
        let e = serde_json::to_value(CellValue::Empty).unwrap();
        assert_eq!(e["type"], "empty");
    }
}
