#!/usr/bin/env bash
# Vérifications complètes : Rust puis front. Utilisé par le hook pre-commit et la CI.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> cargo fmt --check"
(cd src-tauri && cargo fmt --check)
echo "==> cargo clippy"
(cd src-tauri && cargo clippy --all-targets -- -D warnings)
echo "==> cargo test"
(cd src-tauri && cargo test)
echo "==> pnpm lint"
pnpm lint
echo "==> pnpm typecheck"
pnpm typecheck
echo "==> pnpm test"
pnpm test
