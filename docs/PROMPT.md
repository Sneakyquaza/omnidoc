# Prompt de lancement — OmniDoc

> À coller tel quel dans une session Claude Code ouverte dans `~/omnidoc`.

---

## 1. Rôle et mode de travail

Tu es l'architecte principal et l'orchestrateur du projet **OmniDoc**. Je suis seul développeur, sur un abonnement Claude Pro (budget de tokens limité) : sois économe.

- Toi (Opus) : tu conçois, découpes en tâches, rédiges les briefs, relis les diffs. Tu n'écris pas le code toi-même sauf micro-correctifs (< ~10 lignes).
- L'implémentation passe par l'agent `code-implementer` (Sonnet, défini dans `.claude/agents/`). Chaque brief contient : fichiers exacts, fonctions/types visés, critères d'acceptation vérifiables, contraintes, commandes de vérification.
- Lis le code par plages (grep puis lecture ciblée), jamais de gros fichiers entiers.
- Avance **phase par phase** (section 8). À la fin de chaque phase : récapitulatif court, mise à jour de `CLAUDE.md`, proposition de commit, et tu **attends mon feu vert** avant la phase suivante.
- Si une décision structurante n'est pas tranchée ici, propose 2 options max avec ta recommandation et demande-moi.
- Jamais de push, de tag ou de release sans mon accord explicite.

## 2. Vision

OmniDoc est un **éditeur de bureau universel**, dans l'esprit de LibreOffice Writer, mais qui ouvre **n'importe quel fichier** et **adapte son interface au type de fichier** :

- un `.docx` / `.odt` / `.md` s'ouvre dans un traitement de texte riche (styles, titres, listes, tableaux, images) ;
- un `.xlsx` / `.ods` / `.csv` dans un tableur (grille, formules simples, tri, filtres) ;
- un `.py` / `.rs` / `.json` / `.yaml` dans un éditeur de code (coloration, repli, recherche/remplacement, validation de syntaxe pour JSON/YAML/TOML/XML) ;
- un `.png` / `.jpg` / `.webp` / `.svg` dans un éditeur d'image (recadrer, pivoter, redimensionner, annoter, convertir) ;
- un `.pdf` dans une visionneuse-annotateur (lire, surligner, commenter, fusionner/découper, extraire des pages) ;
- un `.zip` / `.tar.gz` / `.7z` dans un explorateur d'archive (lister, extraire, ajouter, supprimer) ;
- un `.mp3` / `.mp4` / `.wav` dans un lecteur avec métadonnées éditables (tags ID3, etc.) et découpe simple ;
- un `.pptx` / `.odp` en visionneuse de diapositives (édition texte en phase avancée) ;
- un `.epub` en liseuse ; un `.sqlite` en navigateur de tables ; un `.ics` / `.vcf` en formulaire ; un `.ipynb` en notebook en lecture ;
- **tout fichier inconnu** dans un éditeur hexadécimal sûr, avec détection du vrai type par signature (magic bytes) et proposition du bon éditeur.

L'interface est commune (fenêtre, onglets multi-fichiers, barre latérale, palette de commandes, recherche globale, thème clair/sombre), mais **la barre d'outils, les menus, le panneau latéral et la barre d'état changent selon l'éditeur actif**. L'utilisateur ne doit jamais se demander « avec quel logiciel j'ouvre ça ».

Objectifs non fonctionnels :
- Démarrage < 1 s, ouverture d'un fichier de 50 Mo sans figer l'UI (chargement asynchrone, virtualisation des grandes grilles/longs textes).
- **Zéro corruption** : écriture atomique, sauvegarde de l'original avant première écriture, fidélité aller-retour testée. Un format qu'on sait lire mais pas réécrire fidèlement s'ouvre en lecture seule avec « Exporter vers… ».
- Hors ligne, sans télémétrie, sans compte. Aucun accès réseau sans action explicite.
- Multiplateforme : Linux (dev), Windows, macOS.

## 3. Stack (décidée — ne pas rediscuter sauf blocage réel)

- **Tauri 2** : un seul exécutable léger.
- **Backend Rust** (`src-tauri/`) : détection de type, lecture/écriture/conversion des formats, accès disque, opérations lourdes (dans des threads, jamais sur le thread UI).
- **Frontend React + TypeScript strict + Vite** (`src/`), pnpm. État : Zustand. Styles : CSS modules ou Tailwind (choisis et justifie en une phrase).
- Briques suggérées (vérifie licence compatible et maintenance avant d'adopter, et signale-moi chaque nouvelle dépendance lourde) :
  - Texte riche : TipTap / ProseMirror.
  - Code : CodeMirror 6.
  - Tableur : grille virtualisée (ex. Glide Data Grid ou équivalent) + moteur de formules (ex. HyperFormula — attention licence GPL/commerciale, sinon alternative).
  - PDF : pdf.js (rendu) + `lopdf` côté Rust (manipulation de pages).
  - Images : canvas + crate `image` côté Rust pour les conversions.
  - Archives : crates `zip`, `tar`, `flate2`, `sevenz-rust`.
  - DOCX/ODT/XLSX/ODS : crates Rust (`docx-rs`, `calamine` pour la lecture tableur, `rust_xlsxwriter` pour l'écriture…) ; évalue la fidélité, et documente ce qui est perdu.
  - Détection de type : crate `infer` + extension + heuristique texte/binaire.
  - Conversions avancées optionnelles : si LibreOffice / pandoc / ffmpeg sont installés sur la machine, les proposer comme moteurs de conversion externes (détection à l'exécution, jamais requis).

## 4. Architecture cœur : tout est plugin

Le cœur ne connaît **aucun format en dur**. Deux registres :

**Côté Rust — `FormatHandler`** (trait), un par famille de formats :
```rust
trait FormatHandler: Send + Sync {
    fn id(&self) -> &'static str;                  // "docx", "csv", "zip"…
    fn detect(&self, probe: &FileProbe) -> Option<Confidence>; // ext + magic bytes + contenu
    fn capabilities(&self) -> Capabilities;        // read / write / export_to: [...] / streaming
    fn open(&self, path: &Path) -> Result<DocumentModel>;
    fn save(&self, doc: &DocumentModel, path: &Path) -> Result<()>; // si write
    fn export(&self, doc: &DocumentModel, target: &str, path: &Path) -> Result<()>;
}
```
`DocumentModel` = un petit nombre de modèles internes partagés (à concevoir précisément en phase 0) : `RichText`, `Sheet`, `PlainText/Code`, `Raster/Vector Image`, `PageDocument (PDF)`, `Tree (archive/JSON/XML)`, `Media`, `Binary`, `Table DB`. Plusieurs formats convergent vers un même modèle (docx/odt/md/html/rtf → RichText), ce qui donne les conversions « gratuitement ».

**Côté front — `EditorView`** : un composant par modèle, qui déclare sa barre d'outils, ses menus, son panneau latéral, sa barre d'état et ses commandes (pour la palette). Le shell les monte dynamiquement selon le modèle du document actif.

**Commandes Tauri** typées et générées (ex. `tauri-specta`) pour que le TypeScript reste synchronisé avec Rust.

Services transverses : onglets et historique annuler/rétablir par document, détection des modifications externes (watcher), récupération après crash (autosave dans un dossier de récupération), fichiers récents, glisser-déposer, ouvrir avec / association de fichiers, paramètres, i18n FR/EN, raccourcis clavier configurables, palette de commandes (Ctrl+Shift+P), recherche dans le document.

## 5. Sécurité

- Les fichiers ouverts sont **non fiables** : aucun parseur ne doit pouvoir faire planter l'app (pas de `unwrap` sur des données de fichier, limites de taille/profondeur, protection zip bomb et path traversal à l'extraction d'archive, macros Office jamais exécutées, scripts SVG/HTML jamais exécutés — rendu en sandbox).
- CSP Tauri stricte, permissions Tauri minimales (capabilities par fenêtre), pas d'`eval`.
- Outils externes (LibreOffice, ffmpeg, pandoc) appelés avec arguments échappés, jamais via un shell.
- Fuzzing (`cargo fuzz`) des parseurs maison à partir de la phase 3.

## 6. Qualité et tests

- Chaque `FormatHandler` en écriture a un **test aller-retour** (ouvrir → sauver → rouvrir → comparer) sur des fichiers d'exemple dans `tests/fixtures/` (petits, libres de droits, générés si possible).
- Tests unitaires Rust (`cargo test`), front (Vitest), et quelques tests bout en bout (Playwright ou WebDriver Tauri) sur les parcours clés : ouvrir, éditer, sauver, convertir.
- Lint : `cargo fmt`, `cargo clippy -D warnings`, ESLint, `tsc --noEmit`. Script unique `scripts/check.sh` qui lance tout ; hook pre-commit.
- CI GitHub Actions (build Linux/Windows/macOS + tests) — mise en place en phase 1, release seulement plus tard et avec mon accord.

## 7. UX

- Look sobre et moderne (pas un clone du ruban Office) : barre d'onglets en haut, barre d'outils contextuelle, panneau latéral repliable (plan du document, feuilles, calques, arborescence d'archive, métadonnées…), barre d'état contextuelle (mots/pages, cellule sélectionnée, dimensions image, encodage/fin de ligne…).
- Écran d'accueil : fichiers récents, « Nouveau » (document, tableur, fichier texte, …), zone de dépôt.
- Toujours afficher le type détecté et permettre « Ouvrir comme… » (forcer un autre éditeur, ex. ouvrir un `.docx` en archive ZIP ou en hexa).
- Indicateurs clairs : lecture seule, fidélité partielle (« certaines mises en forme ne seront pas conservées »), modifications non sauvegardées.
- Accessibilité : navigation clavier complète, contraste suffisant.

## 8. Feuille de route (une phase à la fois, validation entre chaque)

**Phase 0 — Conception (pas de code applicatif)**
- `docs/ARCHITECTURE.md` : modèles internes détaillés, trait `FormatHandler`, contrat `EditorView`, flux ouvrir/éditer/sauver/convertir, gestion des erreurs, threads.
- `docs/FORMATS.md` : matrice format × (lecture / écriture / export / fidélité / crate) avec priorités.
- Liste des dépendances avec licence. Risques principaux et parades.
- Mise à jour de `CLAUDE.md` (carte du projet, commandes).

**Phase 1 — Squelette**
- Scaffold Tauri 2 + React/TS + Vite + pnpm, lint/format/tests configurés, `scripts/check.sh`, CI.
- Shell : fenêtre, onglets, écran d'accueil, ouverture par dialogue et glisser-déposer, fichiers récents, thème clair/sombre, i18n FR/EN, palette de commandes.
- Registre des handlers + détection de type + **éditeur hexadécimal** (lecture) comme repli universel.
- Critère : j'ouvre n'importe quel fichier, il apparaît dans un onglet avec son type détecté.

**Phase 2 — Texte et code**
- Handler texte brut/code (encodage détecté, fins de ligne, très gros fichiers), éditeur CodeMirror avec coloration pour ~30 langages, validation JSON/YAML/TOML/XML, vue arbre pour JSON/XML.
- Markdown : édition source + aperçu côte à côte.
- Écriture atomique + sauvegarde + autosave de récupération + watcher.

**Phase 3 — Traitement de texte riche**
- Modèle `RichText`, éditeur TipTap (styles, titres, listes, tableaux, images, liens, en-têtes/pieds simples, compteur de mots, export PDF).
- Formats : DOCX, ODT, Markdown, HTML, RTF (lecture), TXT. Tests aller-retour, rapport de fidélité.

**Phase 4 — Tableur**
- Modèle `Sheet`, grille virtualisée, multi-feuilles, formules de base, tri/filtre, formats de nombre.
- Formats : CSV/TSV (détection séparateur/encodage), XLSX, ODS.

**Phase 5 — Images et PDF**
- Images : affichage, zoom, recadrage, rotation, redimensionnement, annotations, conversion entre formats, métadonnées EXIF (lecture/suppression).
- PDF : rendu pdf.js, recherche, surlignage/commentaires, fusion/découpe/rotation/extraction de pages, export images.

**Phase 6 — Archives, médias, données**
- Archives (zip, tar, gz, 7z) : arborescence, extraction sûre, ajout/suppression, ouverture d'un fichier interne dans son éditeur.
- Audio/vidéo : lecteur, tags éditables, découpe simple (via ffmpeg si présent).
- SQLite (navigation, requêtes en lecture), EPUB (liseuse), ICS/VCF (formulaires), IPYNB (lecture).

**Phase 7 — Conversions et finition**
- Menu « Exporter vers… » unifié s'appuyant sur les modèles communs + moteurs externes optionnels.
- Associations de fichiers et « Ouvrir avec » sur chaque OS, installeurs, préférences complètes, performance, accessibilité.
- (Plus tard) PPTX/ODP, système de plugins tiers, mise à jour automatique signée.

## 9. Livrable immédiat

Commence **uniquement la phase 0** : produis `docs/ARCHITECTURE.md` et `docs/FORMATS.md`, mets à jour `CLAUDE.md`, puis présente-moi en quelques lignes les décisions clés, les points à trancher et les risques. N'écris aucun code avant ma validation.
