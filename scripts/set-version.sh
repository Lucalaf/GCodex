#!/bin/bash
# set-version.sh — bump GCodex's app version in every place it is recorded.
#
# The version lives in four files that MUST agree:
#   package.json              npm metadata
#   src-tauri/tauri.conf.json Tauri bundle version -> RPM version
#   src-tauri/Cargo.toml      compiled in via env!("CARGO_PKG_VERSION")
#   src-tauri/Cargo.lock      stale here makes `cargo build --locked` fail
#
# The self-updater compares the published release tag against
# env!("CARGO_PKG_VERSION") (see current_version() in updater.rs), so a Cargo.toml
# that lags behind tauri.conf.json produces an RPM whose filenames say the new
# version while the binary still reports the old one — the update then installs
# but keeps offering itself.
#
# Usage:
#   ./scripts/set-version.sh 0.1.1
#   ./scripts/set-version.sh 0.1.1 --commit    # also commit the bump

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <version> [--commit]" >&2
  exit 1
fi

VERSION="$1"
COMMIT="${2:-}"

if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: version must look like MAJOR.MINOR.PATCH (got '$VERSION')" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# `sed -i` on a Windows checkout keeps CRLF intact; that is what we want here.
sed_i() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

echo ">> setting version to ${VERSION}"

# package.json / tauri.conf.json: replace only the first "version" key.
sed_i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${VERSION}\"/" package.json
sed_i -E "0,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/s//\"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json

# Cargo.toml: only inside the [package] block, so a dependency's version is safe.
sed_i -E "/^\[package\]/,/^\[/ s/^version[[:space:]]*=[[:space:]]*\"[^\"]*\"/version = \"${VERSION}\"/" src-tauri/Cargo.toml

# Cargo.lock: retarget the gcodex stanza only.
sed_i -E "/^name = \"gcodex\"$/{n;s/^version = \"[^\"]*\"$/version = \"${VERSION}\"/}" src-tauri/Cargo.lock

echo ">> verifying"
fail=0
check() {
  if printf '%s' "$2" | grep -q "$VERSION"; then
    echo "   ok   $1"
  else
    echo "   FAIL $1 (expected ${VERSION}, got '$2')" >&2
    fail=1
  fi
}
check package.json              "$(grep -m1 '"version"' package.json | tr -d ' ,')"
check src-tauri/tauri.conf.json "$(grep -m1 '"version"' src-tauri/tauri.conf.json | tr -d ' ,')"
check src-tauri/Cargo.toml      "$(sed -n '/^\[package\]/,/^\[/p' src-tauri/Cargo.toml | grep -m1 '^version' | tr -d ' ')"
check src-tauri/Cargo.lock      "$(grep -A1 '^name = "gcodex"$' src-tauri/Cargo.lock | grep 'version')"

if [ "$fail" -ne 0 ]; then
  echo "error: version verification failed" >&2
  exit 1
fi

if [ "$COMMIT" = "--commit" ]; then
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -m "Bump version to ${VERSION}"
  echo ">> committed"
fi

echo
echo ">> next: build the RPM, publish a v${VERSION} release, attach the .rpm"
