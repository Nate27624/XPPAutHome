# XPPAUT Web Port

Web-first port of XPPAUT focused on neuroscience workflows:

- `.ode` upload and parsing
- simulation and trajectory plotting
- phase-plane vector fields and nullclines
- one-parameter and two-parameter bifurcation views
- export to `SVG`, `PNG`, `CSV`
- local-only persistence (IndexedDB + portable ZIP bundles)

## Repository Layout

- `apps/web`: React + Vite user interface
- `packages/core-api`: shared schemas/types for requests/responses
- `packages/wasm-core`: worker runtime + WASM façade (`src/wasm/xpw_api.c`)
- `packages/benchmark`: benchmark models and runtime benchmark script
- `vendor/xppaut`: upstream XPPAUT source (GPL)
- `patches/xppaut-wasm.patch`: tracked patch skeleton for headless WASM adaptation

## Quick Start

```bash
npm install
npm run wasm:build
npm run dev
```

Open `http://localhost:5173`.

## Build and Test

```bash
npm run build
npm run test
```

Benchmark run:

```bash
npm run test -w packages/benchmark
```

## WASM Build Path

WASM bridge code is in `packages/wasm-core/src/wasm`.

```bash
npm run wasm:build
```

This command requires local Emscripten (`emcc`) and compiles the vendored XPPAUT C sources into a headless WASM module (`dist/wasm/xppcore.js` + `.wasm`).

When running `apps/web`, these artifacts are synced automatically into `apps/web/public/wasm` so the browser uses native WASM instead of fallback.

Current behavior:

- Runtime is WASM-first.
- If WASM is unavailable at load time, runtime falls back to the TypeScript engine.
- Once a linked WASM artifact is present, worker calls use the native XPPAUT bridge exported from `xpw_api.c`.

## API Surface

Worker runtime supports these operations:

- `boot`
- `load_model`
- `get_model_info`
- `run_simulation`
- `run_phase_plane`
- `run_bifurcation`
- `free`

Schemas are defined in `@xpp/core-api`.

## Keyboard Shortcuts

- `Ctrl+Enter`: Run simulation
- `Ctrl+Shift+P`: Run phase-plane analysis
- `Ctrl+Shift+B`: Run bifurcation analysis

## Licensing

This project is GPL-2.0-or-later.

Upstream XPPAUT source is vendored in `vendor/xppaut` and keeps its original GPL terms.
