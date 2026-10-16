# OmniDoc

Éditeur de bureau universel, « à la LibreOffice Writer » : il ouvre et édite presque tout type de fichier, avec une
interface qui s'adapte au format (document, tableur, code, image, PDF, archive, audio/vidéo, binaire…).
Application Tauri 2 : backend Rust (lecture, écriture, conversion) + frontend React / TypeScript (éditeurs).
Hors ligne, sans télémétrie, licence MIT.

> Nom provisoire. English summary [below](#english-summary).

## Captures d'écran

À venir.

## Formats supportés

État réel du backend (voir [docs/FORMATS.md](docs/FORMATS.md) pour la matrice complète et les pertes connues).
Fidélité : **F** = aller-retour fidèle (testé), **P** = partielle (pertes documentées), **L** = lecture seule.

| Famille | Formats | Lecture | Écriture | Fidélité |
|---|---|---|---|---|
| Texte / code | txt, log, ~30 langages, json, yaml, toml, xml, ini, env | oui | oui | F |
| Markdown | md, markdown (source + aperçu, ou document riche) | oui | oui | F (source) / P (riche) |
| Traitement de texte | docx, odt, html, rtf | oui | docx, odt, html | P (rtf : L) |
| Tableur | csv, tsv, xlsx, xlsm, xls, ods | oui | csv, tsv, xlsx, ods | F (valeurs) / P |
| Images | png, jpg, webp, gif, bmp, tiff, ico, svg | oui | oui | P |
| PDF | pdf | oui | opérations sur les pages, annotations | P |
| Archives | zip, tar, tar.gz, gz, 7z | oui | zip, tar, tar.gz | F (7z : L) |
| Audio / vidéo | mp3, wav, flac, ogg, m4a, mp4, webm, mkv… | oui | tags, découpe (ffmpeg) | F (tags) |
| Données | sqlite, ics, vcf, ipynb | oui | ics, vcf | L (sqlite, ipynb) / F |
| Livres, diapositives | epub, pptx, odp | oui | — | L |
| Repli | tout autre fichier | hexadécimal par plages | — | L |

Un format non supporté en écriture s'ouvre toujours en lecture seule, de façon explicite. L'écriture est atomique
(fichier temporaire puis renommage) avec sauvegarde de l'original.

## Fonctionnalités par éditeur

- **Texte / code** : coloration (CodeMirror 6), recherche/remplacement, détection et changement d'encodage et de fins
  de ligne, vue arbre JSON/XML, validation, aperçu Markdown.
- **Texte riche** (docx, odt, html, md riche) : TipTap, styles de titre, listes, tableaux, liens, images, recherche.
- **Tableur** : grille virtualisée, feuilles multiples, formules conservées, import/export csv/xlsx/ods.
- **Image** : rotation, recadrage, redimensionnement, ajustements, annotations, EXIF (lecture, suppression), conversion.
- **PDF** : backend prêt (fusion, découpe, extraction, rotation, réordonnancement, annotations) ; éditeur à venir.
- **Archives** : arbre, extraction, ajout/suppression/renommage, conversion zip ↔ tar.gz.
- **Audio / vidéo** : lecteur, forme d'onde, tags et pochette, découpe et conversion si `ffmpeg` est présent.
- **Hexadécimal** : lecture par plages (gros fichiers), recherche.
- **Base de données, calendrier/contacts, notebook, ebook, diapositives** : sqlite (tables, requêtes SELECT, export csv),
  ics/vcf, ipynb, epub, pptx/odp.

Transverse : onglets, palette de commandes (Ctrl/Cmd+Shift+P ou K), « Exporter vers… » unifié (conversions internes et
par moteurs externes), récupération automatique après plantage, détection des modifications externes, glisser-déposer,
associations de fichiers, instance unique, thème clair/sombre, FR/EN, raccourcis configurables
(Paramètres : Ctrl/Cmd+,).

## Installation

Prérequis : Rust stable, Node.js 22, pnpm 10.

Dépendances Linux (Debian/Ubuntu) :

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev \
  libayatana-appindicator3-dev libxdo-dev pkg-config
```

```bash
pnpm install
pnpm tauri dev                 # développement
pnpm tauri build               # paquets : deb, rpm, AppImage, nsis, msi, dmg, app (selon la plateforme)
pnpm tauri build --debug --no-bundle   # compilation de contrôle
```

Les publications sont des releases brouillon créées par `.github/workflows/release.yml` sur un tag `v*`.

## Architecture

Un format = un plugin : un `FormatHandler` côté Rust, un `EditorView` côté front, reliés par un `DocumentModel`.
Le cœur ne connaît aucun format en dur. Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/FORMATS.md](docs/FORMATS.md), [docs/FUZZING.md](docs/FUZZING.md).

## Sécurité et vie privée

- Fonctionne hors ligne : aucune requête réseau sans action explicite de l'utilisateur, aucune télémétrie.
- Aucun programme embarqué dans un document n'est exécuté (macros ignorées) ; HTML et SVG sont assainis/isolés.
- Limites sur les archives, XML et fichiers volumineux ; parseurs fuzzés (voir [docs/FUZZING.md](docs/FUZZING.md)).
- Écriture atomique, sauvegarde de l'original, récupération automatique.

## Moteurs externes optionnels

Détectés dans le `PATH` à l'exécution, jamais lancés via un shell :

- **LibreOffice** (`soffice`) : docx/odt/rtf/doc, xlsx/ods/xls/csv, pptx/odp vers pdf, docx, odt, xlsx, ods.
- **pandoc** : md/html/docx/odt vers md, html, docx, odt, epub.
- **ffmpeg** : découpe et conversion audio/vidéo.

## Contribution

```bash
git config core.hooksPath .githooks   # hook pre-commit
./scripts/check.sh                    # fmt, clippy, tests Rust, lint, typecheck, tests front
```

- Commits : [Conventional Commits](https://www.conventionalcommits.org/) (`feat(editor-image): …`).
- Textes d'interface via i18n (FR et EN), jamais en dur.
- Un nouveau format ajoute un handler Rust et un éditeur dans `src/editors/<nom>/` (voir l'architecture).

## Licence

[MIT](LICENSE) © Sneakyquaza.

---

## English summary

OmniDoc is a universal desktop editor (Tauri 2, Rust + React/TypeScript) that opens and edits almost any file with an
interface adapting to the format: documents (docx, odt, md, html, rtf), spreadsheets (csv, xlsx, ods), code and text,
images, PDF, archives, audio/video, SQLite, calendars/contacts, notebooks, ebooks, slides, and a hex fallback.
It works offline, has no telemetry, writes files atomically with a backup of the original, and falls back to an
explicit read-only mode when a format cannot be written.

Install: `pnpm install`, then `pnpm tauri dev` (development) or `pnpm tauri build` (packages). On Linux install
`libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libxdo-dev`.
Optional external engines (LibreOffice, pandoc, ffmpeg) are auto-detected for extra conversions.
Contributions: run `./scripts/check.sh`, use Conventional Commits. License: MIT.
