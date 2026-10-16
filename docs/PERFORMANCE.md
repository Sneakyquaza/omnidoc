# Performance

Objectifs : démarrage < 1 s ; ouverture d'un fichier de 50 Mo sans figer l'interface (aucun gel > 500 ms,
sauf décodage natif inévitable).

## Mesurer

```
pnpm tauri build --no-bundle      # avec VITE_E2E=1 pour les hooks de mesure (build release)
OMNIDOC_E2E_APP=$PWD/src-tauri/target/release/omnidoc pnpm e2e:perf
```

- `tests/e2e/specs/perf.e2e.ts` (lancée uniquement par `E2E_PERF=1`, donc jamais par `pnpm e2e`) ouvre chaque
  fichier de `tests/e2e/fixtures-perf/` (générés par `tests/e2e/perf/generate.py`, ignorés par git) puis
  journalise une ligne `PERF {...}` (et l'ajoute à `OMNIDOC_PERF_OUT` si défini). Seuils larges : le test ne
  sert qu'à produire des chiffres.
- Mesures côté page (`src/main.tsx`, build E2E/dev seulement) : `shellMs` = premier rendu React du shell depuis le
  début de la navigation ; `editorMs` = apparition de l'éditeur (fin de `open_document`) ; `contentMs` = contenu
  réellement rendu (`renderedProblem`) ; `maxFrameMs`/`longFrames` = plus grand écart entre deux
  `requestAnimationFrame` (> 200 ms = gel) de l'ouverture jusqu'à 3 s après le rendu ; `nativeStartMs` = du
  démarrage du processus (`/proc`) au début de la navigation (Rust + création de la WebView).
- `E2E_DRIVER_PORT` change le port de tauri-driver (plusieurs exécutions simultanées) ; `OMNIDOC_E2E_APP`
  choisit le binaire (release pour les mesures).

## Résultats (build release, Xvfb, machine de dev 8 cœurs)

Démarrage (sans fichier) : processus → début de navigation ≈ 0,28 s, premier rendu du shell ≈ 0,08 s après
(≈ 0,4 s au total). Inchangé : le setup Rust (registre, watcher) est négligeable ; le chunk d'entrée fait
≈ 280 Kio (+ `slots`/`Button` préchargés), tous les éditeurs sont des chunks `import()` paresseux.

Ouverture (contenu rendu `contentMs` / plus long gel `maxFrameMs`, en ms) :

| Fichier | Avant | Après |
|---|---|---|
| texte 50 Mo (`.rs`) | 1269 / 281 | 1223 / 331 |
| CSV 50 Mo (500 k lignes) | 10101 / **7742** | 2367 / 582 |
| JSON 20 Mo (une seule ligne) | **échec** (> 120 s) | 1492 / 842 |
| binaire 200 Mo (hexa) | 553 / 181 | 531 / 270 |
| PDF 300 pages | 756 / 524 | 703 / 496 |
| image PNG 8000×6000 (74 Mo) | 2145 / 626 | 2083 / 313 |
| zip 20 000 entrées | 640 / 115 | 723 / 103 |
| SQLite 1 M lignes | 586 / 132 | 586 / 133 |
| xlsx 200 k lignes | 3711 / 977 | 2153 / 136 |

## Correctifs

- **Cellules nues en JSON** (`src-tauri/src/core/model.rs`, `src/editors/sheet/model.ts`) : une `Cell` sans
  formule ni format est sérialisée `null` / nombre / chaîne / booléen au lieu de
  `{"v":{"type":…,"value":…},"f":null,"fmt":null}` ; le CSV 50 Mo passe de 272 Mo à 62 Mo de JSON, le xlsx de
  63 à 21 Mo. La désérialisation accepte les deux formes (fichiers de récupération anciens, sauvegarde du front
  qui émet encore des objets complets). Le front normalise via `decodeSheets` (≈ 150 ms pour 3 M cellules).
- **Formules différées** (`src/editors/sheet/formula/engine.ts`) : au-delà de 20 000 formules toutes dotées d'une
  valeur en cache, `load(…, true)` n'enregistre ni ne recalcule rien ; le graphe est construit à la première
  modification (`setCells`/`recalcAll`). Coût déplacé : ≈ 1 s sur 200 k formules à la première édition.
- **Arbre JSON/XML** (`TextEditor.tsx`) : le panneau « arbre » construisait l'arbre de tout le fichier (JSON.parse
  de 20 Mo + nœuds) ; désactivé au-delà de 2 Mio, comme la validation et la complétion (clé `tree.tooLarge`).
- **Image** (`src/editors/image/source.ts`) : `img.decode()` avant `drawImage` (décodage hors du fil principal).

## Limites restantes

- JSON/texte sur une seule ligne de 20 Mo : CodeMirror met la ligne entière en page (≈ 0,8 s de gel, natif).
- CSV 50 Mo : `JSON.parse` de 62 Mo sur le fil principal ≈ 0,5 s ; un classeur de 3 M cellules occupe plusieurs
  centaines de Mo de tas JS (limite `MAX_CELLS` = 5 M côté Rust). Une vraie solution serait un modèle paginé.
- Les modifications d'un gros classeur copient tout le classeur pour l'historique (`cloneSheets` dans
  `SheetEditor.tsx`) et la première édition d'un classeur à formules différées gèle ≈ 1 s.
- Ouverture xlsx 200 k lignes : 1,3 s de parsing Rust (asynchrone, sans gel) ; texte 50 Mo : ≈ 1,2 s avant rendu.
- Test `save-sample.html` : échec sporadique observé sous charge CPU (non lié aux modifications ci-dessus).
