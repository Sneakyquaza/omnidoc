# Fuzzing

Les parseurs qui lisent des octets arbitraires sont fuzzés avec [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz)
(libFuzzer). Le crate `src-tauri/fuzz/` est **autonome** (son `[workspace]` vide l'exclut du workspace
de `src-tauri`) : `cargo test` et `cargo clippy` ne le compilent pas.

## Prérequis

- Toolchain **nightly** (sanitizers) : `rustup toolchain install nightly`
- `cargo install cargo-fuzz`
- Les dépendances système de Tauri (voir le README), car le fuzz dépend de la crate `omnidoc`.

## Cibles

| Cible | Ce qui est exercé |
|---|---|
| `probe_detect` | `FileProbe::from_bytes` + `Registry::detect` (le premier octet choisit le nom/extension) |
| `rtf` | `formats::richtext::rtf::parse` |
| `records_ics` | `formats::records::parse` (ICS et VCF) puis `serialize` |
| `csv` | `formats::sheet::csv::parse` (détection et séparateurs imposés) |
| `markdown_rich` | `formats::richtext::markdown::parse` puis `serialize` |
| `docx`, `odt`, `html` | `open` du handler (documents riches) |
| `xlsx`, `ods` | `open` du handler tableur (calamine / lecture ODS) |
| `epub`, `pptx`, `odp`, `ipynb` | `open` du handler |
| `zip`, `tar`, `targz`, `sevenz` | `open` du handler d'archive (listing) |
| `image` | `open` du handler image (en-tête + EXIF) ; 1er octet = extension (png, jpg, gif, bmp, webp, tiff, ico) |
| `svg` | `open` du handler SVG |
| `pdf` | `open` du handler PDF + `pdf::list_annotations` |
| `media` | `open` du handler média (lofty) ; 1er octet = extension (mp3, wav, flac, ogg, m4a, mp4, mkv, opus, aac) |
| `vcf` | `open` du handler VCF |

Les cibles « `open` » passent par `omnidoc_fuzz::open_with` (`src-tauri/fuzz/src/lib.rs`) : les octets sont
écrits dans un fichier temporaire (`<tmp>/omnidoc-fuzz-<pid>/f.<ext>`) puis ouverts via le `Registry`.

## Seeds

`src-tauri/fuzz/seeds/<cible>/` (versionné, < 50 Ko par cible) contient des fichiers valides issus de
`pnpm e2e:fixtures`. Les copier dans le corpus (ignoré par git) avant de lancer :

```bash
cd src-tauri/fuzz
for d in seeds/*; do mkdir -p corpus/$(basename $d); cp $d/* corpus/$(basename $d)/; done
```

## Lancer

```bash
cd src-tauri
cargo +nightly fuzz run <cible> -- -max_total_time=120 -rss_limit_mb=2048 -timeout=10 -jobs=4 -workers=4
```

Un crash est écrit dans `src-tauri/fuzz/artifacts/<cible>/` ; le rejouer avec
`cargo +nightly fuzz run <cible> artifacts/<cible>/crash-…`, le corriger, puis ajouter un test de
non-régression dans le module concerné. Les dossiers `corpus/`, `artifacts/` et `target/` sont ignorés par git.

## Ajouter une cible

1. Créer `src-tauri/fuzz/fuzz_targets/<nom>.rs` (`fuzz_target!(|data: &[u8]| { … })`).
2. Déclarer le `[[bin]]` correspondant dans `src-tauri/fuzz/Cargo.toml`.
3. Si le parseur n'est pas public, l'exposer en `pub` (changement additif) ou passer par un fichier temporaire.
4. Documenter la cible dans le tableau ci-dessus.

`src-tauri/fuzz/Cargo.lock` est copié de `src-tauri/Cargo.lock` pour fuzzer les mêmes versions de dépendances.

## Résultats (campagne du 2026-10-16)

120 s par cible, `-jobs=4 -workers=4`, `-rss_limit_mb=2048 -timeout=10`, corpus = seeds. **Aucun crash,
timeout ni OOM** sur les 23 cibles. Exécutions cumulées (4 workers) :

| Cible | Exécutions | Cible | Exécutions |
|---|---|---|---|
| `zip` | 801 k | `pdf` | 274 k |
| `tar` | 915 k | `media` | 447 k |
| `targz` | 798 k | `vcf` | 883 k |
| `sevenz` | 688 k | `probe_detect` | 279 k |
| `docx` | 456 k | `rtf` | 5,28 M |
| `odt` | 230 k | `records_ics` | 6,57 M |
| `html` | 398 k | `csv` | 433 k |
| `xlsx` | 424 k | `markdown_rich` | 2,12 M |
| `ods` | 566 k | `image` | 716 k |
| `epub` | 612 k | `svg` | 27 k (resvg lent) |
| `pptx` | 732 k | `odp` | 787 k |
| `ipynb` | 831 k | | |

Campagne complémentaire de 300 s sur `pdf` (727 k exécutions), `media`, `image` (1,74 M), `xlsx`, `sevenz`
(1,44 M) : deux bugs trouvés (ci-dessous), corrigés, puis `xlsx`, `media` et `ods` relancés 240 s sans crash
(879 k, 1,18 M et 1,12 M exécutions).

### Bugs trouvés

| Symptôme | Cause | Correctif |
|---|---|---|
| `xlsx` : panique « attempt to multiply with overflow » (calamine 0.36, `get_row_and_optional_column`) sur `<dimension ref="A1:ZZZZZZZZZZ1"/>` | débordement `u32` dans une crate tierce (en build release : wrap silencieux) | `guard()` (`catch_unwind` → `AppError::Corrupt`) autour de `read_xlsx` / `read_xls` dans `formats/sheet/xlsx.rs` ; test `dimension_with_huge_column_does_not_panic` |
| `media` : blocage infini à l'ouverture d'un flux ADTS (.aac) corrompu | boucle sans fin dans `lofty::aac::read::find_next_frame` (lecture des propriétés) | `read_tagged()` dans `formats/media.rs` : pas de lecture des propriétés pour `FileType::Aac` ; test `corrupt_adts_does_not_hang` |

### Notes

- libfuzzer-sys abandonne dès qu'une panique survient, même rattrapée par un `catch_unwind` du code testé :
  `omnidoc_fuzz::write_temp` installe donc un hook de panique silencieux (les paniques non rattrapées font
  toujours échouer la cible).
- Protections existantes/ajoutées contre les paniques de crates tierces : `catch_unwind` autour de
  `lopdf::Document::load_mem` (`formats/pdf.rs`) et de calamine xlsx/xls (`formats/sheet/xlsx.rs`).
- Une campagne plus longue (plusieurs heures, corpus enrichi) reste recommandée.
