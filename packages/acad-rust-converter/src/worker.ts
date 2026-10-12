/**
 * acad-rust parser worker (classic/IIFE bundle).
 *
 * Loads the wasm-bindgen glue generated into `wasm/pkg` and exposes a tiny
 * request/response protocol used by {@link AcDbAcadRustConverter}:
 *
 *   main → worker:  { id, kind: 'dwg-to-dxf', data: ArrayBuffer }
 *   worker → main:  { type: 'result', id, dxf?: ArrayBuffer }
 *                   { type: 'error',  id?, message: string }
 *
 * Only the Architecture-A (`dwg-to-dxf`) path is wired into the production
 * worker. The Rust crate also exposes `dwg_to_json` (Architecture B, serde over
 * the whole document), but that is a Phase-4 native-mapping entry with no
 * caller yet; serializing a large drawing to one giant JSON string is a wasm
 * OOM footgun, so its branch is intentionally left out of the shipped request
 * protocol until a real consumer lands.
 *
 * The WASM binary is a *sibling* file (`acad-rust_bg.wasm`) fetched relative to
 * this worker's own URL, so hosts deploy exactly two assets — mirroring the
 * LibreDWG worker + wasm layout this package replaces.
 *
 * This file is bundled by `vite.config.worker.ts` (esbuild) and excluded from
 * the tsc lib build, so the glue import needs no committed typings.
 */
import { dwg_to_dxf, initSync } from '../wasm/pkg/acad_rust_converter.js'

/** Sibling wasm asset name (kept in sync with vite.config.worker.ts). */
const WASM_FILE = 'acad-rust_bg.wasm'

interface WorkerRequest {
  id: number
  kind: 'dwg-to-dxf'
  data: ArrayBuffer
}

interface WorkerResult {
  type: 'result'
  id: number
  dxf?: ArrayBuffer
}

interface WorkerError {
  type: 'error'
  id?: number
  message: string
}

/** Minimal worker-global shape (avoids depending on the WebWorker TS lib). */
interface WorkerScope {
  readonly location: { readonly href: string }
  postMessage(message: WorkerResult | WorkerError, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

/** Lazily instantiate the wasm module once, sharing the promise across calls. */
let initPromise: Promise<void> | null = null
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmUrl = new URL(WASM_FILE, ctx.location.href)
      const response = await fetch(wasmUrl)
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${wasmUrl.href}: ${response.status} ${response.statusText}`
        )
      }
      // initSync takes the wasm bytes directly; using it (instead of the
      // glue's default async `init`) keeps the `new URL('..._bg.wasm',
      // import.meta.url)` fallback out of the bundle, so vite does not inline
      // the wasm as base64 — it stays a separate file we fetch here.
      initSync({ module: await response.arrayBuffer() })
    })().catch(err => {
      // Reset so a later request can retry instead of caching the failure.
      initPromise = null
      throw err
    })
  }
  return initPromise
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest
  const { id, kind, data } = request ?? ({} as WorkerRequest)
  void (async () => {
    try {
      if (data == null) {
        throw new Error('Missing request data (expected DWG bytes).')
      }
      await ensureInit()
      const input = new Uint8Array(data)
      if (kind === 'dwg-to-dxf') {
        const dxf = dwg_to_dxf(input)
        // wasm-bindgen normally hands back a zero-offset, exact-length view, but
        // a pooled/optimized buffer could expose a larger backing store. Re-slice
        // unless the view spans the whole buffer, so the transferred ArrayBuffer
        // holds *exactly* the UTF-8/ASCII DXF bytes and the downstream DXF decoder
        // never reads trailing garbage or starts at a non-zero offset.
        const exact =
          dxf.byteOffset === 0 && dxf.byteLength === dxf.buffer.byteLength
            ? dxf
            : dxf.slice()
        // wasm-bindgen hands back a Uint8Array over a plain ArrayBuffer (not a
        // SharedArrayBuffer); narrow `.buffer` so the `dxf` field and the
        // transfer list both stay `ArrayBuffer`.
        const buffer = exact.buffer as ArrayBuffer
        ctx.postMessage({ type: 'result', id, dxf: buffer }, [buffer])
      } else {
        throw new Error(`Unknown request kind: ${String(kind)}`)
      }
    } catch (err) {
      ctx.postMessage({ type: 'error', id, message: errorMessage(err) })
    }
  })()
})
