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

## Lancer

```bash
cd src-tauri
cargo +nightly fuzz run probe_detect -- -max_total_time=60
cargo +nightly fuzz run rtf -- -max_total_time=60
cargo +nightly fuzz run records_ics -- -max_total_time=60
cargo +nightly fuzz run csv -- -max_total_time=60
cargo +nightly fuzz run markdown_rich -- -max_total_time=60
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
