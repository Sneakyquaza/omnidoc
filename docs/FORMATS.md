# OmniDoc — Matrice des formats

Légende fidélité : **F** = aller-retour fidèle (testé) · **P** = partielle (pertes documentées) · **L** = lecture seule.
Priorité : P1 (indispensable) · P2 · P3.

| Famille | Formats | Modèle | Lecture | Écriture | Export vers | Fidélité | Briques | Prio |
|---|---|---|---|---|---|---|---|---|
| Repli | tout | Binary | ✔ (plages) | — | — | L | maison | P1 |
| Texte/code | txt, log, ~30 langages (py, rs, js, ts, c, cpp, java, go, rb, php, sh, css, html, sql…) | Text | ✔ | ✔ | autres encodages / fins de ligne | F | encoding_rs, chardetng ; CodeMirror 6 | P1 |
| Données texte | json, yaml, toml, xml, ini, env | Text (+ vue arbre json/xml) | ✔ | ✔ | — | F | front : `yaml`, `smol-toml`, JSON.parse, DOMParser | P1 |
| Markdown | md, markdown | Text (source+aperçu) / RichText (ouvrir comme) | ✔ | ✔ | html, docx, odt, txt | F (source) / P (riche) | pulldown-cmark ; markdown-it + DOMPurify (aperçu) | P1 |
| Traitement de texte | docx | RichText | ✔ | ✔ | odt, md, html, txt, pdf* | P | quick-xml + zip (lecture), docx-rs (écriture) | P1 |
| | odt | RichText | ✔ | ✔ | docx, md, html, txt, pdf* | P | quick-xml + zip (lecture/écriture) | P1 |
| | html, htm | RichText (ou Text) | ✔ | ✔ | md, docx, odt, txt | P | html5ever/scraper, ammonia | P2 |
| | rtf | RichText | ✔ | — | docx, odt, md, html | L | parseur maison borné | P2 |
| | doc (binaire) | — | via LibreOffice* | — | — | L | externe | P3 |
| Tableur | csv, tsv | Sheet | ✔ (séparateur + encodage détectés) | ✔ | xlsx, ods | F (valeurs) | csv | P1 |
| | xlsx, xlsm, xls | Sheet | ✔ | xlsx ✔ | ods, csv | P (styles, graphiques perdus ; formules conservées en texte) | calamine (lecture), rust_xlsxwriter (écriture) | P1 |
| | ods | Sheet | ✔ | ✔ | xlsx, csv | P | calamine (lecture), écriture maison content.xml | P1 |
| Images | png, jpg/jpeg, webp, gif (1re image), bmp, tiff, ico | Image | ✔ | ✔ | entre eux | P (métadonnées hors EXIF perdues au réencodage) | image, kamadak-exif | P1 |
| | svg | Image (rendu) / Text (source) | ✔ | ✔ (source) | png | F (source) | `<img>` sandbox ; resvg (export png) | P2 |
| PDF | pdf | Pdf | ✔ | pages : fusion, découpe, rotation, extraction ; annotations surlignage/note | png (pages) | P (opérations structurelles fidèles) | pdfjs-dist (rendu), lopdf | P1 |
| Archives | zip | Archive | ✔ | ✔ (ajout/suppression = réécriture) | tar.gz | F | zip | P1 |
| | tar, tar.gz/tgz, gz | Archive | ✔ | tar, tar.gz ✔ | zip | F | tar, flate2 | P1 |
| | 7z | Archive | ✔ | — | zip | L | sevenz-rust2 | P2 |
| Médias | mp3, wav, flac, ogg, opus, m4a, aac | Media | ✔ (lecteur) | tags ✔ | découpe/conversion via ffmpeg* | F (tags) | lofty ; `<audio>` | P2 |
| | mp4, webm, mkv, mov | Media | ✔ (lecteur) | tags mp4 ✔ | idem | F (tags) | lofty ; `<video>` | P2 |
| Données | sqlite, db, sqlite3 | Database | ✔ (tables + requêtes SELECT) | — | csv (table) | L | rusqlite (bundled) | P2 |
| | ics | Records | ✔ | ✔ | — | F (propriétés inconnues conservées) | parseur maison | P2 |
| | vcf | Records | ✔ | ✔ | — | F | parseur maison | P2 |
| | ipynb | Notebook | ✔ | — | md, html | L | serde_json | P2 |
| Livres | epub | Ebook | ✔ | — | html | L | zip + quick-xml + ammonia | P2 |
| Diapositives | pptx, odp | Slides | ✔ (texte) | — | md | L | zip + quick-xml | P3 |

\* moteur externe optionnel détecté à l'exécution (LibreOffice `soffice --headless --convert-to`, `pandoc`, `ffmpeg`).
Export PDF du traitement de texte : impression WebView (« Enregistrer en PDF ») ou LibreOffice si présent.

## Pertes connues (rapport de fidélité)

- **DOCX/ODT** : conservés = paragraphes, titres 1-6, gras/italique/souligné/barré, couleur de texte, surlignage,
  listes (puces/numérotées, imbrication), tableaux simples (sans fusion), liens, images inline, sauts de ligne, citations,
  blocs de code. Perdus = styles personnalisés, mise en page (marges, colonnes, sections), en-têtes/pieds,
  notes de bas de page, commentaires, suivi des modifications, champs, formes, macros (jamais exécutées).
  L'éditeur affiche « certaines mises en forme ne seront pas conservées » (`lossy` non vide).
- **XLSX/ODS** : conservés = valeurs, formules (texte), noms de feuilles, largeurs de colonnes (xlsx).
  Perdus = styles, mises en forme conditionnelles, graphiques, images, validations, cellules fusionnées, macros.
- **Images** : réencodage → perte JPEG classique ; EXIF lisible et supprimable (réencodage sans métadonnées).
- **PDF** : jamais réécrit par rendu ; opérations sur l'arbre d'objets (lopdf) → contenu préservé.

## Dépendances et licences

Rust : tauri 2 (MIT/Apache-2.0), tauri-plugin-dialog / -opener (MIT/Apache), serde/serde_json, thiserror, infer (MIT),
encoding_rs (MIT/Apache), chardetng (MIT/Apache), tempfile (MIT/Apache), notify (CC0/Artistic-2.0), quick-xml (MIT),
zip (MIT), tar (MIT/Apache), flate2 (MIT/Apache), sevenz-rust2 (Apache-2.0), docx-rs (MIT), pulldown-cmark (MIT),
scraper (ISC), ammonia (MIT/Apache), csv (MIT/Unlicense), calamine (MIT), rust_xlsxwriter (MIT/Apache), image (MIT/Apache),
kamadak-exif (BSD-2), resvg (MIT/Apache), lopdf (MIT), lofty (MIT/Apache), rusqlite bundled (MIT ; SQLite domaine public),
base64 (MIT/Apache), specta + tauri-specta (MIT).

Front : react, react-dom (MIT), zustand (MIT), i18next + react-i18next (MIT), @tauri-apps/api + plugins (MIT/Apache),
CodeMirror 6 + langages (MIT), @tiptap/* (MIT), pdfjs-dist (Apache-2.0), @tanstack/react-virtual (MIT), yaml (ISC),
smol-toml (BSD-3), markdown-it (MIT), dompurify (MPL-2.0/Apache-2.0). Dev : vite, typescript, vitest, eslint (MIT).

Écartés : HyperFormula (GPL-3 / commercial), crate `epub` (GPL-3), Glide Data Grid (lourd, canvas).

## Risques principaux et parades

| Risque | Parade |
|---|---|
| Corruption à la sauvegarde | écriture atomique same-dir + rename, sauvegarde de l'original, tests aller-retour, lecture seule si fidélité inconnue |
| Fidélité DOCX/ODT/XLSX insuffisante | modèle riche volontairement simple + avertissement explicite ; export via LibreOffice si installé |
| Fichiers hostiles (zip bomb, XML profond, PDF piégé) | limites centralisées, aucun unwrap sur données, fuzzing, sandbox HTML/SVG |
| Gros fichiers (UI figée) | spawn_blocking, lecture par plages, virtualisation, chunks lazy |
| Taille du bundle front (pdf.js, TipTap, CodeMirror) | imports dynamiques par éditeur |
| tauri-specta encore en RC | repli documenté ts-rs + wrappers manuels |
| WebKitGTK (Linux) : codecs médias, impression | message clair si codec absent ; export PDF via LibreOffice en repli |
