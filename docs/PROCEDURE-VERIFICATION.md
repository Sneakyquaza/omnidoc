# Procédure de vérification et de publication

Checklist à dérouler **avant chaque release** (et après tout gros chantier). Document vivant : à chaque version,
ajouter les vérifications propres aux nouveautés (section 5) et une ligne au journal (section 9). Un bug trouvé en
manuel doit, autant que possible, devenir un test automatique (Vitest, `cargo test` ou spec E2E) ; noter alors la
case manuelle comme « couverte par <test> ».

Légende : 🤖 automatisé (CI ou script), 👤 manuel.

## 1. Portes automatiques 🤖

| Étape | Commande | Attendu |
|---|---|---|
| Format, lint, types, tests | `scripts/check.sh` | tout vert (fmt, clippy `-D warnings`, `cargo test`, eslint, tsc, vitest) |
| Bindings à jour | `cd src-tauri && cargo test export_bindings && git diff --exit-code ../src/ipc/bindings.ts` | aucun diff |
| CI GitHub | onglet Actions sur `main` | `check` ubuntu/windows/macos + `e2e` verts |
| Dépendances | `cargo audit` (si installé), `pnpm audit --prod` | pas de vulnérabilité haute non justifiée |

## 2. Bout en bout 🤖

```bash
pnpm e2e:fixtures && pnpm e2e:build && pnpm e2e      # ≈ 4 min, Linux (tauri-driver + xvfb)
E2E_THEME=dark pnpm e2e                               # passe complète en thème sombre
E2E_SHOTS=/tmp/shots pnpm e2e                         # captures à parcourir à l'œil (régressions visuelles)
```

Rappel : `cargo test` / `check.sh` écrasent le binaire debug → refaire `pnpm e2e:build` avant `pnpm e2e`.
Les instances E2E tournent sans instance unique (`OMNIDOC_E2E=1`, posé par `wdio.conf.ts`) : plusieurs suites en
parallèle ne se volent plus leurs fichiers ; sur une machine chargée, préférer une seule suite à la fois.
Depuis 0.1.1, chaque éditeur a au moins un parcours E2E (`tests/e2e/specs/*.journey.ts`). Un nouvel éditeur
arrive avec son parcours.

## 3. Robustesse et performances 🤖

- Fuzzing court de non-régression (voir `docs/FUZZING.md`) : chaque cible ≥ 60 s ; aucun crash nouveau.
  Tout crash → cas ajouté au corpus + test de régression.
- Performances : `pnpm e2e:perf`, comparer à `docs/PERFORMANCE.md` (tolérance +20 %). Mettre à jour le tableau si
  la mesure change durablement.

## 4. Parcours manuels par éditeur 👤

Pour chaque ligne : ouvrir un fichier réel, modifier, enregistrer, rouvrir, vérifier l'absence de perte ; puis
ouvrir le fichier enregistré dans l'application de référence indiquée.

| Éditeur | Vérifications | Référence externe |
|---|---|---|
| Texte / code | coloration, rechercher/remplacer, changement d'encodage et de fins de ligne, arbre JSON/XML, gros fichier (> 20 Mo) | éditeur texte quelconque, `file -i` |
| Markdown | source + aperçu (Mod+Shift+M), mode riche, aller-retour sans perte | GitHub / autre lecteur md |
| Texte riche | docx, odt, html : titres, listes, tableau, lien, image, recherche ; pas de « modifié » à l'ouverture | **Word et LibreOffice** |
| Tableur | csv/xlsx/ods : formules, feuilles multiples, gros csv (50 Mo), export | **Excel et LibreOffice Calc** |
| Image | rotation, recadrage, redimensionnement, ajustements, annotations, EXIF, conversion | visionneuse système |
| PDF | rendu, recherche, annotations, fusion/découpe/rotation/suppression/réordonnancement, export PNG ; PDF CJK et JPEG2000 | lecteur PDF système |
| Archives | arbre, extraction, ajout/suppression/renommage, zip ↔ tar.gz ; archive avec chemins `../` refusée | `unzip -l`, `tar tf` |
| Audio / vidéo | lecture, forme d'onde, tags et pochette ; découpe/conversion avec et sans `ffmpeg` | lecteur système |
| Base de données | tables, requête SELECT, export csv ; requête d'écriture refusée | `sqlite3` |
| Agenda / contacts | ics, vcf : modification et enregistrement | client agenda/contacts |
| Notebook, ebook, diapositives | ipynb, epub, pptx/odp en lecture | Jupyter, liseuse, LibreOffice Impress |
| Hexadécimal | fichier binaire inconnu, gros fichier, recherche | `xxd` |

Transverse : onglets (fermeture avec modifications → confirmation), palette (Mod+Shift+P/K), « Exporter vers… »,
récupération après plantage (`kill -9` pendant une édition), modification externe détectée, glisser-déposer,
double-clic depuis le gestionnaire de fichiers (associations), instance unique, thème clair/sombre, FR/EN,
raccourcis configurables, Préférences.

Conversions externes : au moins une conversion réelle par moteur (LibreOffice `soffice`, `pandoc`, `ffmpeg`) et
le message clair quand le moteur est absent.

## 5. Vérifications propres aux versions

À compléter à chaque version : une sous-section par nouveauté, avec ce qui doit être vérifié à la main.

### 0.1.1 : mises à jour

- Premier lancement : la question « vérifier automatiquement les mises à jour ? » apparaît une seule fois ; « Non »
  → aucune requête réseau au démarrage.
- Préférences → Mises à jour : version affichée, « Rechercher maintenant » → « à jour » / erreur réseau propre
  (tester hors ligne).
- Mise à jour réelle : installer la version N-1, publier N, vérifier détection, notes de version affichées,
  téléchargement, installation, redémarrage, puis dialogue « Nouveautés ». Sur chaque OS et format : AppImage,
  deb/rpm (lien vers la page de téléchargement si l'installation directe n'est pas prise en charge), NSIS/MSI, dmg.
- « Ignorer cette version » : plus proposé en automatique, toujours proposé en manuel.
- Modifications non enregistrées → avertissement avant installation.
- deb/rpm : l'installation demande le mot de passe administrateur (pkexec) ; en cas d'échec, bouton « Ouvrir la
  page de téléchargement ».

### 0.1.1 : correctifs de l'audit (régressions à surveiller)

Couverts par des tests automatiques (Rust/Vitest) : liens PDF vers pages supprimées, réécriture d'archives
(chemins atypiques, FIFO, gz multi-membres, remplacement de dossier), liens symboliques, collisions de sauvegarde,
fins de ligne mixtes, CSV sans perte, ODS `A:A`, échappements ics/vcf, révision d'onglet, course autosave/récupération,
ouvertures concurrentes, saisie tableur sur une autre feuille, raccourcis Alt.
À vérifier à la main :
- Tableur : taper dans une cellule de la feuille 2 sans valider, Ctrl+S → valeur dans la feuille 2.
- Fichier texte modifié par un autre programme pendant que l'onglet est modifié → Ctrl+S propose Écraser /
  Recharger / Annuler.
- Fichier à fins de ligne mixtes : ouvrir, enregistrer sans modifier → octets identiques ; modifier → choix LF/CRLF/CR.
- Lien symbolique (ex. `~/.bashrc` vers un dépôt) : enregistrer → le lien subsiste, la cible change.
- Média : lancer une lecture, changer d'onglet → pause.
- Fermer la fenêtre avec des onglets modifiés → « Tout enregistrer et quitter » ; Entrée = Annuler.
- `kill -9` pendant une édition, relancer en double-cliquant sur le même fichier → la récupération est proposée.

## 6. Paquets et installation 👤

Sur une machine (ou VM) propre de chaque OS, à partir des artefacts de la release brouillon :

- Linux : `.deb` (Debian/Ubuntu), `.rpm` (Fedora), `.AppImage` ; entrée de menu, icône, associations de fichiers
  (`xdg-open fichier.docx`), désinstallation propre.
- Windows : `setup.exe` (NSIS) et `.msi` ; avertissement SmartScreen attendu (binaire non signé) ; associations.
- macOS : `.dmg` universel, Intel et Apple Silicon ; Gatekeeper (clic droit → Ouvrir) ; associations.

## 7. Confidentialité et sécurité 👤

- Aucune requête réseau sans action de l'utilisateur (hors vérification de MAJ consentie) : vérifier avec
  `ss -tp` / moniteur réseau pendant une session ordinaire.
- Rien de privé dans le dépôt : `git ls-files | grep -iE 'claude|\.env|\.key'` vide ; pas de secret dans l'historique.
- Contenu actif (HTML, SVG, EPUB, Markdown, notebook) affiché sans exécution de script.

## 8. Publication

1. Mettre `CHANGELOG.md` à jour : renommer `[Non publié]` en `[x.y.z] - AAAA-MM-JJ`.
2. Monter la version dans `package.json`, `src-tauri/Cargo.toml` (+ `Cargo.lock`) et `src-tauri/tauri.conf.json`.
3. Commit `chore(release): vx.y.z`, push, CI verte.
4. `git tag vx.y.z && git push origin vx.y.z` → workflow Release : release brouillon avec installeurs signés pour
   le système de mises à jour (`latest.json`) et notes tirées du CHANGELOG.
5. Tester les installeurs (section 6) et la mise à jour depuis la version précédente (section 5).
6. Publier la release (non brouillon, non pre-release : l'URL `releases/latest` ne voit que les releases stables).
7. Ajouter une ligne au journal ci-dessous.

La clé privée de signature des mises à jour n'est **jamais** dans le dépôt : secrets GitHub
`TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, copie de sauvegarde hors dépôt chez le
mainteneur. Perdre la clé = plus aucune mise à jour automatique possible pour les installations existantes.

## 9. Journal des vérifications

| Version | Date | Automatique | Manuel | Remarques |
|---|---|---|---|---|
| 0.1.0 | 2026-10-16 | check.sh, CI 3 OS, 59 specs E2E, fuzzing court | installation Linux OK | binaires non signés ; conversions externes non testées réellement |
| 0.1.1 | 2026-10-16 | check.sh (197 Rust, 273 Vitest), 66 specs E2E, audit de code back/front (≈ 45 points corrigés) | à faire : mise à jour réelle 0.1.0 → 0.1.1 impossible (0.1.0 sans updater) ; à valider dès 0.1.2 | premier jalon avec mises à jour signées |
