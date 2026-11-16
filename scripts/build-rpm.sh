#!/bin/bash
# build-rpm.sh — build a Fedora-native .rpm of GCodex.
#
# The Rust backend links against GTK/WebKit via pkg-config, so the RPM must be
# produced on Linux. Building inside a Fedora container also keeps the binary's
# glibc symbol floor at the *oldest Fedora we target* rather than whatever the
# host happens to run — a Ubuntu/Tumbleweed host would raise that floor and the
# package would refuse to install on older Fedora releases.
#
# Usage:
#   ./scripts/build-rpm.sh              # default target: fedora 41
#   ./scripts/build-rpm.sh 40           # older glibc floor (2.39)
#
# Requirements: podman (or docker) with a working network connection.
# Output: dist-linux/Gcodex-<version>-<release>.x86_64.rpm

set -euo pipefail

FEDORA_VERSION="${1:-41}"

# Resolved before `set -e` can abort on the failed lookup, so a missing engine
# produces the error message below instead of a silent non-zero exit.
if [ -z "${CONTAINER_ENGINE:-}" ]; then
  CONTAINER_ENGINE="$(command -v podman || command -v docker || true)"
fi

if [ -z "$CONTAINER_ENGINE" ]; then
  echo "error: neither podman nor docker is available" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${GCODEX_BUILD_WORKDIR:-/tmp/gcodex-build}"
IMAGE="gcodex-builder:fc${FEDORA_VERSION}"

mkdir -p "$WORK/out" "$WORK/cargo-registry" "$WORK/cargo-git"

# --- 1. Builder image ------------------------------------------------------
# Everything the Tauri bundler and rpmbuild need, plus the GTK/WebKit headers
# the Rust backend is compiled against.
cat > "$WORK/Dockerfile" <<EOF
FROM docker.io/library/fedora:${FEDORA_VERSION}
RUN dnf install -y --setopt=install_weak_deps=False \\
      cargo rust gcc gcc-c++ make pkgconf-pkg-config \\
      nodejs npm \\
      webkit2gtk4.1-devel gtk3-devel librsvg2-devel \\
      openssl-devel systemd-devel libsoup3-devel \\
      patchelf rpm-build file curl \\
    && dnf clean all
ENV CARGO_HOME=/root/.cargo
EOF

echo ">> building builder image ${IMAGE}"
"$CONTAINER_ENGINE" build -t "$IMAGE" "$WORK"

# --- 2. Staged source ------------------------------------------------------
# Copy only tracked inputs: host bind-mounts of node_modules/target are full of
# Windows binaries and would poison the Linux build.
echo ">> staging source"
rm -rf "$WORK/src"
mkdir -p "$WORK/src"
( cd "$REPO_ROOT" && tar -cf - \
    --exclude=node_modules \
    --exclude=target \
    --exclude=.git \
    --exclude=dist \
    --exclude=dist-linux \
    . ) | ( cd "$WORK/src" && tar -xf - )

# --- 3. Build --------------------------------------------------------------
echo ">> building RPM inside fedora:${FEDORA_VERSION}"
"$CONTAINER_ENGINE" run --rm \
  -v "$WORK/src:/src:z" \
  -v "$WORK/out:/out:z" \
  -v "$WORK/cargo-registry:/root/.cargo/registry:z" \
  -v "$WORK/cargo-git:/root/.cargo/git:z" \
  -w /src \
  "$IMAGE" \
  bash -c '
    set -euo pipefail
    npm ci --no-audit --no-fund
    npm run build
    npx tauri build --bundles rpm
    cp -v /src/src-tauri/target/release/bundle/rpm/*.rpm /out/
  '

# --- 4. Collect ------------------------------------------------------------
mkdir -p "$REPO_ROOT/dist-linux"
cp -v "$WORK"/out/*.rpm "$REPO_ROOT/dist-linux/"

echo
echo ">> built:"
ls -lh "$REPO_ROOT"/dist-linux/*.rpm
