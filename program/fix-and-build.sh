#!/usr/bin/env bash
# Iteratively pin edition2024-only transitive deps to older versions until
# `anchor build` succeeds with the platform-tools cargo (1.84).
set -u
cd "$(dirname "$0")"

# Known-good downgrade targets for crates that went edition2024 upstream.
declare -A PINS=(
  [zeroize_derive]=1.4.2
  [blake3]=1.5.5
  [toml_edit]=0.22.27
  [proc-macro-crate]=3.2.0
  [hashbrown]=0.15.5
  [indexmap]=2.9.0
  [borsh]=1.5.7
  [borsh-derive]=1.5.7
  [crypto-common]=0.1.6
  [block-buffer]=0.10.4
  [digest]=0.10.7
  [subtle]=2.6.1
  [cc]=1.2.20
  [libc]=0.2.172
  [serde_json]=1.0.140
  [serde]=1.0.219
  [syn]=2.0.101
  [proc-macro2]=1.0.95
  [quote]=1.0.40
  [thiserror]=1.0.69
  [winnow]=0.7.10
  [smallvec]=1.15.0
  [once_cell]=1.21.3
  [getrandom]=0.2.16
  [ahash]=0.8.12
)

for i in $(seq 1 25); do
  out=$(anchor build 2>&1)
  if ! echo "$out" | grep -q 'edition2024'; then
    echo "$out" | tail -8
    if echo "$out" | grep -qi 'error'; then
      echo "BUILD FAILED (non-edition2024 error above)"
      exit 1
    fi
    echo "BUILD OK after $i attempt(s)"
    exit 0
  fi
  pkgver=$(echo "$out" | grep -oP 'index.crates.io-[^/]+/\K[^/]+(?=/Cargo.toml)' | head -1)
  name=$(echo "$pkgver" | sed -E 's/-[0-9][0-9A-Za-z.+-]*$//')
  ver=$(echo "$pkgver" | sed -E "s/^${name}-//")
  # Some crates must be fixed by downgrading their PARENT instead.
  if [ "$name" = "zeroize_derive" ]; then
    echo "--- offender: zeroize_derive → downgrading parent zeroize to 1.7.0"
    cargo update -p zeroize --precise 1.7.0 2>&1 | tail -2 && continue
  fi
  target=${PINS[$name]:-}
  echo "--- offender: $name@$ver (pin target: ${target:-NONE})"
  if [ -z "$target" ]; then
    echo "No pin known for $name — inspect manually:"
    cargo tree -i "$name@$ver" | head -8
    exit 2
  fi
  cargo update -p "$name@$ver" --precise "$target" 2>&1 | tail -2 || {
    echo "pin failed for $name@$ver -> $target"
    cargo tree -i "$name@$ver" | head -8
    exit 3
  }
done
echo "Exhausted attempts"
exit 4
