# OmniDoc — Architecture

Éditeur de bureau universel. Tauri 2 : backend Rust (`src-tauri/`) qui lit/écrit/convertit les formats,
frontend React + TypeScript strict (`src/`) qui édite. **Le cœur ne connaît aucun format en dur** :
tout passe par deux registres (Rust `FormatHandler`, front `EditorView`) reliés par un `DocumentModel`.

## 1. Vue d'ensemble

```
            ┌──────────────── Front (WebView, React) ─────────────────┐
            │ Shell : onglets · accueil · palette · thème · i18n     │
            │   └─ EditorHost ─► editors/registry.ts (lazy)           │
            │        text · richtext · sheet · image · pdf · archive  │
            │        media · database · records · notebook · ebook    │
            │        slides · hex                                     │
            │ Stores Zustand : tabs, settings, recent                 │
            └──────────────┬──────────────────────────────────────────┘
                 invoke (JSON, typé)  │  raw bytes (ipc::Response) │ events
            ┌──────────────▼──────────────────────────────────────────┐
            │ Backend Rust                                           │
            │ commands.rs ─► core::Registry ─► formats/* (handlers)   │
            │ core::{probe, detect, atomic, backup, recovery, watch}  │
            │ external::{libreoffice, pandoc, ffmpeg} (optionnels)    │
            └─────────────────────────────────────────────────────────┘
```

Arborescence :

```
src-tauri/src/
  main.rs, lib.rs          # setup Tauri, plugins, gestion d'état
  commands.rs              # toutes les commandes #[tauri::command] (fines : délèguent)
  error.rs                 # AppError (thiserror) sérialisable {code, message}
  core/
    probe.rs               # FileProbe : chemin, ext, taille, 8 Kio de tête, is_text
    handler.rs             # trait FormatHandler, Capabilities, Confidence
    registry.rs            # Registry : detect(), get(id), list()
    model.rs               # DocumentModel + sous-modèles
    atomic.rs              # écriture atomique + sauvegarde de l'original
    recovery.rs            # autosave de récupération
    watch.rs               # watcher notify → événement "file-changed"
    limits.rs              # limites (taille, profondeur, entrées d'archive)
  formats/
    mod.rs                 # all_handlers() : SEUL endroit qui liste les handlers
    text.rs, markdown.rs, docx.rs, odt.rs, html.rs, rtf.rs,
    csv.rs, xlsx.rs, ods.rs, image.rs, pdf.rs, archive.rs,
    media.rs, sqlite.rs, epub.rs, ics.rs, vcf.rs, ipynb.rs, slides.rs, binary.rs
  external.rs              # détection + appel des outils externes (Command, jamais shell)
src/
  main.tsx, App.tsx
  ipc/                     # bindings générés (bindings.ts) + helpers (bytes, events)
  shell/                   # TabBar, Welcome, Toolbar, StatusBar, SidePanel, CommandPalette…
  stores/                  # tabs.ts, settings.ts, recent.ts (Zustand)
  editors/
    types.ts               # contrat EditorView
    registry.ts            # SEUL endroit qui liste les éditeurs (imports dynamiques)
    text/, richtext/, sheet/, image/, pdf/, archive/, media/,
    database/, records/, notebook/, ebook/, slides/, hex/
  i18n/                    # i18next ; locales/{fr,en}/<namespace>.json (1 namespace par éditeur)
  styles/                  # tokens.css (variables thème), global.css
```

## 2. Modèles internes (`core/model.rs`)

Sérialisés en JSON (serde, `#[serde(tag = "kind", rename_all = "camelCase")]`), types TS générés.
Les contenus binaires lourds (pixels, PDF, médias) **ne transitent jamais en JSON** : le front
les obtient via `read_bytes` (réponse brute `tauri::ipc::Response`) ou le protocole `asset:`.

```rust
pub enum DocumentModel {
    Text(TextDoc),         // texte brut, code, json/yaml/toml/xml, md (source)
    RichText(RichDoc),     // docx, odt, md (riche), html, rtf, txt
    Sheet(Workbook),       // csv, tsv, xlsx, ods, xls
    Image(ImageDoc),       // png, jpg, webp, gif, bmp, tiff, ico, svg
    Pdf(PdfDoc),
    Archive(ArchiveDoc),   // zip, tar, tar.gz/tgz, gz, 7z (+ ouvrir-comme pour docx/odt/epub…)
    Media(MediaDoc),       // mp3, wav, flac, ogg, m4a, mp4, webm, mkv, mov
    Database(DbDoc),       // sqlite
    Records(RecordsDoc),   // ics, vcf
    Notebook(NotebookDoc), // ipynb
    Ebook(EbookDoc),       // epub
    Slides(SlidesDoc),     // pptx, odp (lecture)
    Binary(BinaryDoc),     // repli universel (hexa)
}
```

| Modèle | Contenu | Notes |
|---|---|---|
| `TextDoc` | `text: String`, `encoding` (label encoding_rs), `bom: bool`, `lineEnding: "lf"\|"crlf"\|"cr"`, `language: String` (id CodeMirror deviné par extension) | Décodage `chardetng` + `encoding_rs`, réencodage identique à la sauvegarde. |
| `RichDoc` | `doc: serde_json::Value` = **JSON ProseMirror/TipTap** ; `meta: {title?, author?}` ; `lossy: Vec<String>` (éléments non conservés) | Choix clé : le modèle riche *est* le schéma TipTap (nœuds `doc, paragraph, heading{level}, bulletList, orderedList, listItem, blockquote, codeBlock, horizontalRule, hardBreak, image{src}, table, tableRow, tableHeader, tableCell, text` ; marques `bold, italic, underline, strike, code, link{href}, textStyle{color}, highlight`). Le Rust convertit chaque format ⇄ cet arbre (helpers dans `formats/richtext_tree.rs`). Images incluses en `data:` URI. |
| `Workbook` | `sheets: [{name, rows: Vec<Vec<Cell>>, colWidths?}]` ; `Cell = {v: CellValue, f?: String (formule sans "="), fmt?: String}` ; `CellValue = Empty \| Number(f64) \| Text \| Bool \| Error(String)` ; `csv?: {delimiter, quote, encoding, header}` | Grille dense limitée (`limits::MAX_CELLS`). Calcul des formules côté front. |
| `ImageDoc` | `width, height, format, hasAlpha, exif: Vec<{tag, value}>` | Pixels via `read_bytes`. SVG : `format="svg"`, jamais exécuté (rendu `<img>`). |
| `PdfDoc` | `pageCount, title?, encrypted: bool` | Rendu pdf.js sur les octets. Opérations de pages côté Rust (lopdf). |
| `ArchiveDoc` | `format`, `entries: [{path, size, compressedSize?, isDir, modified?}]`, `writable: bool` | Écriture : zip, tar, tar.gz. 7z lecture/extraction. |
| `MediaDoc` | `mime, durationMs?, tags: Vec<{key, value}>, pictures: u32` | Lecture via protocole `asset:` (scope ajouté au fichier ouvert). Tags via `lofty`. |
| `DbDoc` | `tables: [{name, kind:"table"\|"view", columns:[{name, type}], rowCount}]` | Lignes paginées par commande `db_query`. Ouverture `SQLITE_OPEN_READ_ONLY`. |
| `RecordsDoc` | `format: "ics"\|"vcf"` (pas `kind` : collision avec le tag serde de `DocumentModel`), `components: [{name, props: [{name, params: Vec<(String,String)>, value}], children}]` | Arbre générique, propriétés inconnues conservées telles quelles → aller-retour fidèle. |
| `NotebookDoc` | `cells: [{cellType, source, outputs: [{kind, text?, mime?, data?}]}]`, `language` | Lecture seule. |
| `EbookDoc` | `title, author?, chapters: [{title, html}]` | HTML assaini côté Rust (pas de script), rendu en `iframe sandbox` sans `allow-scripts`. |
| `SlidesDoc` | `slides: [{index, texts: Vec<String>, notes?}]` | Lecture : extraction texte (pptx/odp). |
| `BinaryDoc` | `size: u64` | Octets lus par plages : `read_range(path, offset, len)`. |

Convergence : docx/odt/md/html/rtf/txt → `RichDoc` ⇒ tout format écrivable de la famille sert de cible
d'export « gratuit ». Idem csv/xlsx/ods → `Workbook`, png/jpg/webp/… → `ImageDoc`.

## 3. Trait `FormatHandler` (`core/handler.rs`)

```rust
pub trait FormatHandler: Send + Sync {
    fn id(&self) -> &'static str;                         // "docx", "csv", "zip"…
    fn model(&self) -> ModelKind;                         // modèle produit
    fn extensions(&self) -> &'static [&'static str];      // pour dialogues + "Nouveau"
    fn detect(&self, probe: &FileProbe) -> Option<Confidence>;
    fn capabilities(&self) -> Capabilities;               // read, write, export_to, fidelity
    fn open(&self, path: &Path) -> Result<DocumentModel>;
    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()> { Err(AppError::ReadOnly) }
    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()> { … }
}
pub struct Capabilities { read: bool, write: bool, export_to: Vec<&'static str>, fidelity: Fidelity }
pub enum Fidelity { Full, Partial, ReadOnly }
pub struct Confidence(pub u8); // 0..=100 : magic bytes 90, extension 60, heuristique 30, repli 1
```

- `save` reçoit des octets **en mémoire** puis passe par `core::atomic::write` (jamais d'écriture directe).
- `export(target)` : par défaut, le registre cherche le handler `target` de même `ModelKind` et appelle son `save`.
  Les handlers surchargent pour des conversions croisées (ex. `RichDoc → pdf` via moteur externe).
- **Détection** (`Registry::detect`) : construit `FileProbe` (ext minuscule, 8 Kio de tête, `infer::get`,
  `is_text` = UTF-8/UTF-16 valide ou < 1 % d'octets de contrôle), interroge tous les handlers, trie par
  confiance. Retour : `Detected { handlerId, model, mime, label, alternatives: Vec<handlerId> }`.
  Le handler `binary` répond toujours (confiance 1) → tout fichier s'ouvre.
  Divergence extension ↔ signature (ex. `.png` qui est un PDF) → on suit la signature et on le signale.
- « Ouvrir comme… » : `open_document(path, Some(handlerId))` force un handler (ex. `.docx` en `zip` ou `binary`).

## 4. Contrat `EditorView` (front, `src/editors/types.ts`)

```ts
export interface EditorProps<M> {
  tab: TabState;                 // id, path, handlerId, readOnly, dirty…
  model: M;                      // sous-modèle du DocumentModel
  onChange(next: M): void;       // marque dirty + alimente l'autosave
  registerCommands(cmds: EditorCommand[]): void;  // palette + raccourcis
  setStatus(items: StatusItem[]): void;           // barre d'état contextuelle
}
export interface EditorView<M = unknown> {
  kind: ModelKind;                                // "text" | "richText" | …
  namespace: string;                              // namespace i18n
  component: React.LazyExoticComponent<React.ComponentType<EditorProps<M>>>;
  // Toolbar / SidePanel : rendus par le composant lui-même dans des slots
  // <EditorToolbar> / <EditorSidePanel> (portails vers le shell).
}
```

Le shell (`EditorHost`) choisit l'éditeur par `model.kind` dans `editors/registry.ts` (imports dynamiques →
le code de pdf.js, TipTap, etc. n'est chargé qu'à l'usage). Chaque éditeur possède son namespace i18n.
`EditorCommand = { id, titleKey, shortcut?, run }`.

## 5. Flux

**Ouvrir** : dialogue / glisser-déposer / argv / récents → `detect_file(path)` → `open_document(path, forced?)`
(thread bloquant `tauri::async_runtime::spawn_blocking`) → `OpenedDocument { docId, path, handlerId, model,
capabilities, detected, warnings }` → nouvel onglet ; `watch_file(path)` ; ajout aux récents.

**Éditer** : l'état vit dans l'éditeur (CodeMirror state, TipTap, grille…) ; `onChange` → `tab.dirty = true`.
Annuler/rétablir : historique natif de chaque éditeur (CM6, TipTap) ou pile maison (grille, image), par onglet.
Autosave de récupération toutes les 30 s si dirty : `recovery_store(docId, path, model)` → `<app_data>/recovery/`.

**Sauver** : `save_document(path, handlerId, model)` → handler.save → `atomic::write` :
1. première écriture de la session sur ce chemin : copie de l'original dans `<app_data>/backups/<horodatage>-<nom>` ;
2. écriture dans un fichier temporaire du **même dossier** (`tempfile::NamedTempFile::new_in`), `sync_all` ;
3. `persist` (rename atomique) ; permissions d'origine conservées ;
4. le watcher ignore l'événement provoqué par notre propre écriture (horodatage mémorisé).
Fidélité `Partial` → avertissement avant la 1ʳᵉ sauvegarde dans le format d'origine. `ReadOnly` → bouton « Exporter vers… ».

**Convertir** : `export_document(model, targetHandlerId, destPath)` ; liste des cibles = handlers de même modèle
écrivables + moteurs externes détectés (`external_tools()` : `soffice`, `pandoc`, `ffmpeg` via recherche PATH).

**Modification externe** : `notify` → événement `file-changed {path}` → bandeau « Recharger / Ignorer ».

**Récupération** : au démarrage, `recovery_list()` ; s'il y a des entrées → proposition de restauration.

## 6. Commandes Tauri (`commands.rs`)

Toutes `async`, travail lourd dans `spawn_blocking`. Types exportés vers `src/ipc/bindings.ts`
(tauri-specta ; si incompatible avec la version de Tauri, repli `ts-rs` + wrappers `invoke` écrits à la main).

`detect_file, open_document, save_document, export_document, read_bytes, read_range, list_handlers,
new_document(kind), recovery_store, recovery_list, recovery_take, recovery_discard, watch_file, unwatch_file,
recent_list/recent_add (ou côté front via store persistant), external_tools,`
+ commandes spécifiques par famille, préfixées : `pdf_merge, pdf_split, pdf_rotate, pdf_extract, pdf_annotate,
image_save, archive_extract, archive_add, archive_remove, archive_read_entry, media_write_tags, media_trim,
db_query, …` (déclarées dans le module du format, enregistrées dans `lib.rs`).

## 7. Erreurs

`AppError` (thiserror) : `Io, Unsupported, ReadOnly, TooLarge, Corrupt(String), Limit(String), External(String), Cancelled`.
Sérialisé `{ code, message }` ; le front traduit `code` via i18n (`errors.<code>`) et affiche le message technique en détail.
**Aucun `unwrap`/`expect`/indexation non vérifiée sur des données de fichier.** Tout parseur reçoit des limites
(`core/limits.rs`) : taille max ouvrable en mémoire 512 Mio (au-delà → hexa par plages), profondeur XML/JSON 256,
entrées d'archive 100 000, taille décompressée totale 8 Gio et ratio 1:1000 (zip bomb), cellules 5 M.

## 8. Threads et performance

- Thread UI WebView jamais bloqué : chaque commande lourde en `spawn_blocking`.
- Gros fichiers : hexa par plages (`read_range`), grille et hexa virtualisés (`@tanstack/react-virtual`),
  CodeMirror gère nativement de longs documents ; > 20 Mio de texte → lecture seule proposée.
- Code des éditeurs chargé à la demande (imports dynamiques, chunks Vite).

## 9. Sécurité

- Fichiers non fiables : parseurs bornés, pas de panique (test `cargo fuzz` sur les parseurs maison : rtf, ics/vcf, détection).
- Archives : chemins normalisés, refus de `..`, chemins absolus, liens symboliques sortants ; limites zip bomb.
- Office : macros jamais exécutées (ignorées). SVG/HTML/EPUB : jamais de script — SVG via `<img>`, HTML assaini
  (`ammonia` côté Rust ou DOMPurify côté front) et rendu en `iframe sandbox` sans `allow-scripts`.
- CSP stricte (`default-src 'self'; img-src 'self' asset: data: blob:; media-src asset: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:`),
  capabilities Tauri minimales (dialog open/save, opener pour « ouvrir le dossier »), pas d'`eval`.
- Outils externes : `std::process::Command` avec arguments séparés, jamais `sh -c`.
- Pas de réseau. Pas de télémétrie.

## 10. Choix techniques

- **Styles : CSS Modules + variables CSS** (`styles/tokens.css`) — natif Vite, zéro dépendance, thème clair/sombre
  par simple bascule d'attribut `data-theme`.
- État : Zustand (`tabs`, `settings` persistés via `localStorage`, `recent`).
- i18n : i18next + react-i18next, FR par défaut si la langue système est française, sinon EN.
- Tableur : **moteur de formules maison** (TS, parseur Pratt : arithmétique, comparaisons, `&`, références A1,
  plages, ~40 fonctions courantes). HyperFormula écarté (GPL/commercial).
- Grille : composant maison virtualisé (`@tanstack/react-virtual`) plutôt que Glide (dépendance lourde, canvas).
- Tests : `cargo test` (aller-retour sur `tests/fixtures/` générés), Vitest (formules, stores, utilitaires),
  E2E reportés (WebDriver Tauri non supporté partout) — script de fumée `scripts/check.sh`.
