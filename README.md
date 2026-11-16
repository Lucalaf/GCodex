# GCodex

Cross-platform desktop CNC controller and G-code sender for **Grbl 1.1+** machines,
with a live 3D toolpath and stock visualizer.

- **Backend:** Rust + Tauri v2 — Grbl 127-byte character-counting streamer, serial
  and virtual-controller drivers, in-app self-updater.
- **Frontend:** React 19 + TypeScript + Three.js — resizable dock layout, 3D stock
  carving, jogging, gamepad support, touch-plate probing.

See [`AGENTS.md`](AGENTS.md) for the full architecture guide.

## Development

```bash
npm install
npm run tauri dev      # full desktop app, hot-reloading frontend
npm run build          # typecheck + bundle the frontend into dist/
```

The Rust backend can be checked directly:

```bash
cd src-tauri && cargo check
```

## Building a Fedora / RHEL RPM

The Rust backend links against GTK and WebKit through `pkg-config`, so the package
must be built on Linux. Use [`scripts/build-rpm.sh`](scripts/build-rpm.sh), which
builds inside a **Fedora container** via podman (or Docker):

```bash
./scripts/build-rpm.sh          # targets Fedora 41
./scripts/build-rpm.sh 40       # older glibc floor (2.39)
```

The container build matters for more than convenience: the glibc symbols the
binary requires are inherited from the build machine, and a package built on a
newer distro will refuse to install on an older one. Building inside the oldest
Fedora release you intend to support keeps the floor at that release's glibc.

Output lands in `dist-linux/` (git-ignored — artifacts ship as GitHub Release
assets, not in the repository).

### Install

Download the `.rpm` from the [Releases page](https://github.com/Lucalaf/GCodex/releases)
and install it by absolute path:

```bash
sudo dnf install ~/Downloads/Gcodex-0.1.0-1.x86_64.rpm
```

`dnf` resolves relative paths against your **current directory**, so `./Gcodex-*.rpm`
fails with `No such file or directory` if you aren't standing in the folder you
downloaded to. Prefer an absolute path, or `cd` there first.

The package installs `/usr/bin/gcodex` plus a desktop entry and hicolor icons.

## Publishing a release

Release assets are what the in-app updater looks for: `updater.rs` queries
`releases/latest` and downloads the `.rpm` asset from it. With no published
release that call 404s and the updater reports "no releases published".

```bash
# after ./scripts/set-version.sh <ver> && ./scripts/build-rpm.sh
gh release create v0.1.0 ./dist-linux/Gcodex-0.1.0-1.x86_64.rpm \
  --repo Lucalaf/GCodex \
  --title "GCodex 0.1.0" --notes-file .release-notes-v0.1.0.md
```

**Tag convention: always `v` + version (`v0.1.0`, `v0.1.1`, …).** `parse_version()`
in `updater.rs` strips a leading `v`, so both spellings compare correctly — but
the tag is also the GitHub URL path (`/releases/tag/v0.1.0`) and what users see,
so stay consistent.

Releases must **not** be marked pre-release or draft — `releases/latest` skips
both, and the updater would see nothing.

The asset filename is matched by suffix (`.rpm`), so keeping the
`Gcodex-<version>-<release>.x86_64.rpm` shape is all that's required.

Runtime dependencies (declared in `src-tauri/tauri.conf.json`): `gtk3`,
`webkit2gtk4.1`, `openssl-libs`, `systemd-libs`.

## Layout

```text
src/                 React frontend (App, gcodeParser, ToolpathVisualizer)
src-tauri/src/       Rust backend (main.rs, simulator.rs, updater.rs)
scripts/build-rpm.sh Fedora RPM build (podman/Docker container)
dist-linux/          Built .rpm artifacts (git-ignored)
```
