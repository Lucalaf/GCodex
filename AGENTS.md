# AGENTS.md — GCodex Codebase Guide

GCodex is a cross-platform desktop CNC controller and G-code sender for Grbl 1.1+ machines, built with **Tauri v2** (Rust backend), **React 19 + TypeScript** (Vite frontend), and **Three.js** (3D WebGL toolpath & stock simulation).

The crate/binary is named `gcodex`; the RPM package name is `gcodex`, installing `/usr/bin/gcodex`.

---

## 1. Tech Stack & Commands

- **Frontend**: React 19, TypeScript (~6.0), Vite 8, Three.js (`^0.187.0`), `@tauri-apps/api` (`^2`).
- **Backend**: Rust (2021 edition), Tauri 2, `serialport` (`4.3`), `serde` / `serde_json`.
- **Dev & Build Commands** (run in project root):
  - `npm run dev` — Start Vite frontend dev server (`http://localhost:1420`).
  - `npm run tauri dev` — Launch full Tauri desktop app in development mode.
  - `npm run build` — Typecheck (`tsc`) and build frontend bundle into `dist/`.
  - `npm run tauri build` — Build production desktop application bundle.
  - `cargo check` / `cargo build` (inside `src-tauri/`) — Validate or compile the Rust backend directly.

---

## 2. Repository Structure

```text
GCodex/                         # repo root
├── index.html                  # App shell, global dark theme & scrollbar resets
├── package.json                # Frontend dependencies & npm scripts
├── vite.config.ts              # Vite config (port 1420 for Tauri)
├── src/                        # React + TypeScript Frontend
│   ├── main.tsx                # React DOM root entrypoint
│   ├── App.tsx                 # Main UI layout, state, jogging, shortcuts, gamepad & Tauri IPC
│   ├── gcodeParser.ts          # Client-side G-code parser (G0/G1/G2/G3, G20/G21, G90/G91)
│   └── ToolpathVisualizer.tsx  # Three.js WebGL 3D viewport, ViewCube HUD & heightmap stock mesh
└── src-tauri/                  # Tauri v2 Rust Backend
    ├── Cargo.toml              # Rust crate dependencies
    ├── tauri.conf.json         # Tauri window & bundle configuration
    └── src/
        ├── main.rs             # Tauri entrypoint, serial I/O, 127B streamer engine & IPC commands
        ├── simulator.rs        # Built-in 60Hz Virtual Grbl 1.1h physics & protocol simulator
        └── lib.rs              # Placeholder (desktop entrypoint is in main.rs)
```

---

## 3. Architecture & Core Modules

### Rust Backend (`src-tauri/src/`)

1. **[`main.rs`](src-tauri/src/main.rs) — Serial Manager, Status Parser & 127-Byte Streamer Engine**
   - **`AppState`**: Thread-safe state (`Arc<AtomicBool>`, `Arc<Mutex<...>>`) holding connection flags (`is_connected`, `is_virtual`), byte transmitter channel (`tx_channel`), `MachineStatus`, and `StreamerEngine`.
   - **Grbl 127-Byte Character-Counting Streamer (`StreamerEngine` & `pump_streamer`)**:
     - Enforces `GRBL_RX_BUFFER_SIZE = 127` bytes maximum in-flight data to prevent serial buffer overflow while keeping Grbl's lookahead planner saturated.
     - Tracks `in_flight: VecDeque<InFlightEntry>` (`byte_len`, `is_job_line`) and `in_flight_bytes`.
     - Prioritizes queued manual commands (`manual_queue`) before packing sanitized job lines (`sanitize_gcode_line` strips `;...` and `(...)` comments and `%`).
     - Decrements `in_flight_bytes` and advances `acked_lines` as `ok` or `error:` lines arrive from the controller.
   - **Hardware Polling & Telemetry (`connect_serial`, `update_machine_status`)**:
     - Opens hardware serial ports (default `115200` baud) with a dedicated writer thread (polls `?` every `200ms` / 5Hz) and reader thread.
     - Parses Grbl `<State|MPos:...|WPos:...|WCO:...|FS:...|Ov:...|Pn:...|Bf:...>` frames and automatically derives `WPos` from `MPos - WCO` (or vice versa).
   - **Real-Time Pick-Off Commands (`send_realtime_byte`)**:
     - Sends single-byte real-time control codes directly over the channel, bypassing the character-counting queue (`!` = `0x21` Feed Hold, `~` = `0x7E` Cycle Start, `0x18` Soft Reset, `0x85` Jog Cancel, `0x90`/`0x91`/`0x92` Feed Overrides).

2. **[`simulator.rs`](src-tauri/src/simulator.rs) — Virtual Grbl 1.1h Simulator**
   - `spawn_virtual_cnc` runs an in-memory 60Hz physics loop (`16ms` tick) and 5Hz status report emitter (`180ms`) with no physical hardware required.
   - Supports system commands (`$$`, `$G`, `$X`, `$H`), work coordinate zeroing (`G10 L20 P1`), modal G-code (`G0`–`G3`, `G20`/`G21`, `G90`/`G91`, `M3`/`M4`/`M5`/`M30`, `F`, `S`), `$J=` jogging, arc subdivision, real-time overrides, and simulated lookahead planner backpressure (`deferred_acks` when planner depth > 8).

### Tauri IPC Contract (Frontend <-> Backend)

- **Commands (`invoke`)**:
  - `list_serial_ports() -> DetectedPort[]`
  - `connect_serial({ portName, baudRate })`
  - `connect_virtual()`
  - `disconnect_serial()`
  - `send_serial_command({ command })`
  - `send_realtime_byte({ byte })`
  - `load_gcode_job({ fileName, content }) -> JobProgress`
  - `start_gcode_job() -> JobProgress`
  - `pause_gcode_job() -> JobProgress`
  - `stop_gcode_job() -> JobProgress`
- **Events (`listen`)**:
  - `machine-status` (`MachineStatus` payload)
  - `job-progress` (`JobProgress` payload)
  - `serial-line` (`string` console line; job `ok` responses are suppressed to avoid UI flooding)
  - `serial-disconnected` (`()` payload)

---

### React Frontend (`src/`)

1. **[`App.tsx`](src/App.tsx) — Workspace UI, Jogging & Input Controllers**
   - **DaVinci Resolve-Style Resizable Dock Layout**: 4-pane split workspace (Left Dock: Digital Readout + Jog Control; Right Dock: 3D Viewport + Bottom Job Streamer & Serial Console) with draggable splitters and double-click/button layout reset.
   - **Jogging Engine**:
     - **Step Mode**: Sends discrete `$J=G21G91 X.. Y.. Z.. F..` commands.
     - **Continuous (Hold-to-Jog) Mode**: Replenishes short ~85ms lookahead slices every `65ms` while held, and immediately sends real-time Jog Cancel (`0x85`) on key/pointer/stick release.
   - **Keyboard Shortcuts**: Arrows (XY), `PageUp`/`PageDown` (Z), `Shift` (temporary continuous jog), `1`–`4` (step presets `0.1`, `1`, `10`, `50` mm), `J` (toggle Step/Continuous), `Space` (Feed Hold `0x21`), `Escape` (Jog Cancel `0x85`). Automatically disabled when typing in input fields or while a job is running.
   - **HTML5 Gamepad Polling (`75ms`)**: Left stick = proportional XY continuous jog, Right stick Y = proportional Z continuous jog, D-Pad = discrete step jog, `B`/`RB` = immediate Jog Cancel (`0x85`).

2. **[`gcodeParser.ts`](src/gcodeParser.ts) — Client-Side 3D Toolpath Parser**
   - `parseGcodeToolpath(content)` strips `;` and `(...)` comments and generates `ToolpathSegment[]` with `start`, `end`, `rapid`, and `lineIndex` (matching the backend's executable line indexing).
   - Interpolates `G2`/`G3` planar & helical arcs (both `I`/`J` center-offset and `R` radius formats) into 8–48 linear segments.
   - Computes both overall `bounds` and cutting-only `cutBounds` (preventing high `G0` clearance moves from distorting stock top Z).

3. **[`ToolpathVisualizer.tsx`](src/ToolpathVisualizer.tsx) — Three.js 3D Viewport & Stock Simulation**
   - **Coordinate System**: Z-up (`camera.up.set(0, 0, 1)`), XY worktable grid, RGB origin triad, and animated 3D cutter cone/shank that lerps to live `wpos`.
   - **View Modes**: `toolpath` (wireframe), `shaded` (watertight 3D stock mesh), and `hybrid` (stock + overlaid wireframe).
   - **Watertight 3D Stock Mesh (`buildWatertightStockMesh`)**: Rasterizes cutting segments up to `maxLineIndex` (`Infinity` for Final Part, or `ackedLines` for Live Carve simulation) onto an adaptive 2D heightmap grid (90–240 cells/axis) considering tool radius (`1.5`, `3.175`, `6.35`, `10.0` mm) and material palettes (`aluminum`, `wood`, `plastic`, `wax`).
   - **Fusion 360 Navigation & ViewCube HUD**: Secondary orthographic scene rendered via scissor test in the top-right corner; supports clicking faces, edges, and corners to snap camera views, plus roll arrows and cursor-centered wheel zoom.

---

## 4. Key Conventions & Guardrails for Agents

- **Executable Line Index Alignment**: `sanitize_gcode_line` in `src-tauri/src/main.rs` and `parseGcodeToolpath` in `src/gcodeParser.ts` must strip comments (`;`, `(...)`, `%`) and count executable lines identically so `job.acked_lines` accurately highlights completed segments and carves the 3D stock mesh in `ToolpathVisualizer.tsx`.
- **Never Overflow Grbl's Serial Buffer**: All multi-byte G-code commands must go through `StreamerEngine` (`manual_queue` + `pump_streamer`) respecting `GRBL_RX_BUFFER_SIZE` (127 bytes). Only single-byte real-time Grbl commands (`?`, `!`, `~`, `0x18`, `0x85`, override bytes) should bypass the character counter via `send_realtime_byte`.
- **Styling**: UI components use inline `CSSProperties` objects (`styles` maps at the bottom of `App.tsx` and `ToolpathVisualizer.tsx`) with a consistent slate/cyan dark theme (`#090d16`, `#0f172a`, `#1e293b`, `#38bdf8`).
- **Three.js Resource Cleanup**: When modifying `ToolpathVisualizer.tsx`, always dispose of `BufferGeometry` and `Material` instances when rebuilding meshes to prevent WebGL memory leaks during live carving.
- **First-Class Linux Compatibility**: Every change across Rust, Tauri, and React/Three.js must work flawlessly on Linux (`x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`, WebKitGTK, X11/Wayland, and `/dev/ttyUSB*` / `/dev/ttyACM*`):
  - Never introduce Windows-only crates, path separators (`\`), or un-scoped `[env]` flags in Cargo configuration that would break Linux `gcc`/`pkg-config` builds (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libudev-dev`).
  - Keep `color-scheme: dark` and `appearance: none` resets in `index.html` so GTK/WebKitGTK does not override button padding or render unreadable white `<select>` dropdowns on Linux desktops.

