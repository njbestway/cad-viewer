/**
 * acad-rust main-thread transcoder (ESM bundle).
 *
 * Escape hatch for `AcDbAcadRustConverter` when `useWorker: false`: instead of a
 * Web Worker, the WASM `dwg_to_dxf` runs on the calling (main) thread. The
 * class dynamically imports this module by URL and calls
 * {@link transcodeDwgToDxf}, passing the URL of the sibling
 * `acad-rust_bg.wasm` to fetch and initialize.
 *
 * This mirrors `src/worker.ts` (same wasm-bindgen glue, same `initSync` +
 * runtime-fetch strategy) minus the worker protocol: wasm is deliberately NOT
 * statically imported, so vite does not inline it as base64 — it stays a
 * separate file we `fetch` by URL. Keeping the glue import here, in a bundle
 * emitted only for the main-thread path, also keeps the (large) parser glue out
 * of the main library chunk.
 *
 * Browser-only: relies on `fetch`. Hosts without a DOM must use the worker path.
 *
 * This file is bundled by `vite.config.maint.ts` and excluded from the tsc lib
 * build (the glue lives outside `src/`), so it needs no committed typings.
 */
import { dwg_to_dxf, initSync } from '../wasm/pkg/acad_rust_converter.js'

/** Lazily instantiate the wasm module once, shared across calls in this realm. */
let initPromise: Promise<void> | null = null
function ensureInit(wasmUrl: string): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const response = await fetch(wasmUrl)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${wasmUrl}: ${response.status} ${response.statusText}`
        )
      }
      initSync({ module: await response.arrayBuffer() })
    })().catch(err => {
      // Reset so a later call can retry instead of caching the failure.
      initPromise = null
      throw err
    })
  }
  return initPromise
}

/**
 * Transcode DWG bytes to ASCII DXF bytes on the current thread. The returned
 * view is normalized to an exact buffer by the caller.
 */
export async function transcodeDwgToDxf(
  data: Uint8Array,
  wasmUrl: string
): Promise<Uint8Array> {
  await ensureInit(wasmUrl)
  return dwg_to_dxf(data)
}
