# @mlightcad/acad-rust-converter

DWG parsing for the CAD viewer built on
[acadrust](https://github.com/hakanaktt/acadrust) (pure Rust, compiled to
WebAssembly). It is a **copyleft-free replacement** for the GPL-3.0
`@mlightcad/libredwg-converter`, so hosts can parse DWG without the GPL
obligations that prevent closed-source commercial distribution.

## How it works (Architecture A — MVP)

1. `AcDbAcadRustConverter.read(dwgBytes, db, options)` transcodes the DWG bytes
   with the acadrust WASM. By default this runs in a Web Worker; set
   `useWorker: false` to run the same WASM on the main thread (see below).
2. The WASM calls `dwg_to_dxf(bytes)` (Rust) and returns **ASCII DXF** bytes.
3. The converter delegates to the MIT `AcDbNativeDxfConverter` from
   `@mlightcad/data-model`, which streams the DXF into the `AcDbDatabase`.

No GPL code is linked. The worker is a **performance and memory** choice — it
keeps a multi-second parse off the UI thread and lets the WASM heap be reclaimed
— **not** a licensing one: acadrust is MPL-2.0, whose file-level copyleft imposes
no runtime isolation, so a main-thread path is equally legitimate.

A second WASM entry, `dwg_to_json(bytes)` (acadrust `serde`), is already exposed
for a future **Architecture B**: native `process*()` mapping straight into
`AcDbDatabase` for entity classes where the DXF round-trip loses fidelity. That
work is incremental and driven by real-world drawings.

## Usage

Register the converter for `AcDbFileType.DWG` with a single call. Point
`assetBaseUrl` at the directory holding the deployed assets and the package
derives the worker / wasm / main-thread URLs for you:

```ts
import { registerAcadRustConverter } from '@mlightcad/acad-rust-converter'

// One line wires up DWG support (Web Worker path, the default):
registerAcadRustConverter({ assetBaseUrl: './workers/' })
```

For full control, construct the converter yourself and register it (e.g. to
override individual asset URLs, or to parse without a worker):

```ts
import { AcDbAcadRustConverter } from '@mlightcad/acad-rust-converter'
import {
  AcDbDatabaseConverterManager,
  AcDbFileType
} from '@mlightcad/data-model'

AcDbDatabaseConverterManager.instance.register(
  AcDbFileType.DWG,
  new AcDbAcadRustConverter({
    // Explicit per-file URLs override `assetBaseUrl` for non-standard layouts:
    parserWorkerUrl: './assets/acad-rust-parser-worker.js'
  })
)
```

### Running without a Web Worker

Hosts that cannot use a Web Worker (CSP `worker-src` restrictions, tiny
embedders, or a harness that has no worker) can transcode on the main thread:

```ts
registerAcadRustConverter({ assetBaseUrl: './workers/', useWorker: false })
```

This dynamically imports `acad-rust-converter-main-thread.js` (a small ESM
bundle that holds the parser glue, keeping it out of the main chunk) and fetches
the sibling wasm. It is **browser-only** (resolves URLs against
`document.baseURI`); the returned DXF is byte-for-byte identical to the worker
path — the only difference is that parsing blocks the calling thread.

### Deployed assets

The package emits three files into `dist/`; the two you deploy depends on the
runtime you use:

- `acad-rust-parser-worker.js` — the classic worker bundle (glue inlined).
- `acad-rust_bg.wasm` — fetched relative to whichever script loads it (worker or
  main-thread module), so it must sit next to them.
- `acad-rust-converter-main-thread.js` — the ESM main-thread transcoder, only
  needed when `useWorker: false`.

Serve the worker + wasm as siblings for the default path (see
`packages/cad-viewer-example/vite.config.ts` for the `viteStaticCopy` wiring);
`tools/copy-workers.mjs` copies the main-thread module opportunistically.

## Build

The build requires the **Rust toolchain** (this is the only package in the
monorepo that does):

- [`rustup`](https://rustup.rs) + `cargo`
- target `wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`)
- `wasm-bindgen-cli` **0.2.126** — must match the pinned crate dependency
  exactly, or the glue schema check fails:
  `cargo install wasm-bindgen-cli --version 0.2.126`

Then:

```bash
pnpm --filter @mlightcad/acad-rust-converter build
# = node scripts/build-wasm.mjs   (cargo build + wasm-bindgen → wasm/pkg)
# + tsc                            (src → lib, ESM + .d.ts)
# + vite build -c vite.config.main.ts    (dist/acad-rust-converter.js|.umd.cjs)
# + vite build -c vite.config.worker.ts  (dist/acad-rust-parser-worker.js + acad-rust_bg.wasm)
# + vite build -c vite.config.maint.ts   (dist/acad-rust-converter-main-thread.js)
```

Useful sub-scripts: `build:wasm`, `build:main`, `build:worker`,
`build:main-thread`, `clean`.

## License & compliance

This package is **dual-licensed**; the full terms live in [`LICENSE`](./LICENSE)
and the third-party attributions in [`NOTICE`](./NOTICE). SPDX identifier:
`(MIT AND MPL-2.0)`.

- **This package's own code** (TypeScript converter, worker, Rust bridge) is
  **MIT**.
- **acadrust** is **MPL-2.0** (file-level copyleft). It is used as an *unmodified
  crates.io dependency* (`acadrust` v0.6.3); the compiled `acad-rust_bg.wasm`
  therefore contains MPL-covered code.
- MPL-2.0 obligations (satisfied by `LICENSE` + `NOTICE`, both shipped in the
  npm `files` set): retain the license notices and tell recipients how to obtain
  the MPL-covered source. acadrust's source is available from
  [crates.io](https://crates.io/crates/acadrust) /
  [GitHub](https://github.com/hakanaktt/acadrust). If this repo ever patches
  acadrust directly, the modified files must remain available under MPL-2.0
  (prefer upstreaming a PR over a local fork).
- Unlike GPL-3.0, MPL-2.0's file-level copyleft does **not** extend to the rest
  of the application, which is what makes closed-source distribution possible.
  Have counsel review the §3.2/§3.3 notice obligations before shipping.
