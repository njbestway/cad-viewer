# @mlightcad/acad-rust-converter

DWG parsing for the CAD viewer built on
[acadrust](https://github.com/hakanaktt/acadrust) (pure Rust, compiled to
WebAssembly). It is a **copyleft-free replacement** for the GPL-3.0
`@mlightcad/libredwg-converter`, so hosts can parse DWG without the GPL
obligations that prevent closed-source commercial distribution.

## How it works (Architecture A — MVP)

1. `AcDbAcadRustConverter.read(dwgBytes, db, options)` sends the DWG bytes to a
   Web Worker running the acadrust WASM.
2. The worker calls `dwg_to_dxf(bytes)` (Rust) and returns **ASCII DXF** bytes.
3. The converter delegates to the MIT `AcDbNativeDxfConverter` from
   `@mlightcad/data-model`, which streams the DXF into the `AcDbDatabase`.

No GPL code is linked, and the WASM stays in the worker — it never enters the
main bundle.

A second WASM entry, `dwg_to_json(bytes)` (acadrust `serde`), is already exposed
for a future **Architecture B**: native `process*()` mapping straight into
`AcDbDatabase` for entity classes where the DXF round-trip loses fidelity. That
work is incremental and driven by real-world drawings.

## Usage

Register the converter for `AcDbFileType.DWG`, exactly like the LibreDWG one:

```ts
import {
  AcDbDatabaseConverterManager,
  AcDbFileType
} from '@mlightcad/data-model'
import { AcDbAcadRustConverter } from '@mlightcad/acad-rust-converter'

export function registerAcadRustConverter(parserWorkerUrl: string): void {
  AcDbDatabaseConverterManager.instance.register(
    AcDbFileType.DWG,
    new AcDbAcadRustConverter({ useWorker: true, parserWorkerUrl })
  )
}
```

### Deployed assets

Hosts must serve **two files** next to each other (this package copies them into
`dist/`):

- `acad-rust-parser-worker.js` — the classic worker bundle (glue inlined).
- `acad-rust_bg.wasm` — fetched by the worker relative to its own URL.

Point `parserWorkerUrl` at the worker (e.g. `./assets/acad-rust-parser-worker.js`)
and copy the sibling `.wasm` into the same directory. See
`packages/cad-viewer-example/vite.config.ts` for the `viteStaticCopy` wiring.

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
```

Useful sub-scripts: `build:wasm`, `build:main`, `build:worker`, `clean`.

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
