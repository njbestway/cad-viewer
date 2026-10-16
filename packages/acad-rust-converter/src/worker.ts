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
 * Both the Architecture-A (`dwg-to-dxf`) and the Architecture-B sectioned
 * protocol below are wired into this one worker and share the same wasm module:
 *
 *   main -> worker:  { id, kind: 'dwg-to-dxf', data }
 *                    { id, kind: 'dxf-to-dxf', data }
 *                    { id, kind: 'open',    data }
 *                    { id, kind: 'dxf-open', data }
 *                    { id, kind: 'meta',    handle }
 *                    { id, kind: 'section', handle, section }
 *                    { id, kind: 'page',    handle, offset, limit }
 *                    { id, kind: 'block-page', handle, block, offset, limit }
 *                    { id, kind: 'close',   handle }
 *   worker -> main:  { type: 'result', id, dxf?, handle?, json? }
 *                    { type: 'error',  id?, message: string }
 *
 * The sectioned (B) kinds back `AcDbAcadRustNativeConverter`: a DWG is opened
 * once into a `CadDocument` that lives in wasm memory (`open` hands back a
 * handle), then pulled apart section by section / page by page (`meta` /
 * `section` / `page` / `block-page`) so a large drawing never materializes all
 * its entities in one string — the whole-document `dwg_to_json` OOM footgun. The
 * document is released with `close` when the conversion finishes.
 *
 * Rust exposes exactly one entry point per section discriminator; the `section`
 * kind is validated against `ACADRUST_SECTION_KINDS` (the TS mirror of Rust's
 * `SECTION_KINDS`) so an unknown kind fails fast here rather than throwing
 * inside the wasm match arm.
 *
 * The WASM binary is a *sibling* file (`acad-rust_bg.wasm`) fetched relative to
 * this worker's own URL, so the worker path deploys just the worker + wasm pair.
 * Running the parser in a Worker is a performance/memory choice (the UI thread
 * stays free and the wasm heap is reclaimable on teardown), not a licensing
 * requirement — acadrust is MPL-2.0, whose file-level copyleft imposes no runtime
 * isolation. See `src/main-thread.ts` for the `useWorker: false` main-thread path.
 *
 * This file is bundled by `vite.config.worker.ts` (esbuild) and excluded from
 * the tsc lib build, so the glue import needs no committed typings.
 */
import {
  dwg_block_entity_page,
  dwg_close,
  dwg_entity_page,
  dwg_meta,
  dwg_open,
  dwg_section_json,
  dwg_to_dxf,
  dxf_open,
  dxf_to_dxf,
  initSync
} from '../wasm/pkg/acad_rust_converter.js'
import {
  ACADRUST_SECTION_KINDS,
  type AcadRustSectionKind
} from './model/acadrust-model'

/** Sibling wasm asset name (kept in sync with vite.config.worker.ts). */
const WASM_FILE = 'acad-rust_bg.wasm'

/**
 * Worker request union. `dwg-to-dxf` is the single-shot Architecture-A path;
 * the remaining kinds drive the Architecture-B handle lifecycle. `handle` is the
 * opaque `u32` returned by `open` and threaded through every later call.
 */
type WorkerRequest =
  | { id: number; kind: 'dwg-to-dxf'; data: ArrayBuffer }
  | { id: number; kind: 'dxf-to-dxf'; data: ArrayBuffer }
  | { id: number; kind: 'open'; data: ArrayBuffer }
  | { id: number; kind: 'dxf-open'; data: ArrayBuffer }
  | { id: number; kind: 'meta'; handle: number }
  | { id: number; kind: 'section'; handle: number; section: string }
  | { id: number; kind: 'page'; handle: number; offset: number; limit: number }
  | {
      id: number
      kind: 'block-page'
      handle: number
      block: string
      offset: number
      limit: number
    }
  | { id: number; kind: 'close'; handle: number }

interface WorkerResult {
  type: 'result'
  id: number
  dxf?: ArrayBuffer
  handle?: number
  json?: string
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

/** Narrow a wasm-bindgen Uint8Array to an exact, zero-offset ArrayBuffer. */
function toExactBuffer(bytes: Uint8Array): ArrayBuffer {
  // wasm-bindgen normally hands back a zero-offset, exact-length view, but a
  // pooled/optimized buffer could expose a larger backing store. Re-slice unless
  // the view spans the whole buffer, so the transferred ArrayBuffer holds
  // *exactly* the bytes and the downstream decoder never reads trailing garbage
  // or starts at a non-zero offset. `.buffer` is a plain ArrayBuffer (not a
  // SharedArrayBuffer), so narrowing keeps the `dxf` field and transfer list
  // both typed as `ArrayBuffer`.
  const exact =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice()
  return exact.buffer as ArrayBuffer
}

/**
 * Data-carrying requests parse input bytes: `*-to-dxf`/`open` are DWG bytes,
 * `dxf-to-dxf`/`dxf-open` are DXF bytes. Every other kind needs only a handle.
 */
function isDataRequest(
  request: WorkerRequest
): request is {
  id: number
  kind: 'dwg-to-dxf' | 'dxf-to-dxf' | 'open' | 'dxf-open'
  data: ArrayBuffer
} {
  return (
    request.kind === 'dwg-to-dxf' ||
    request.kind === 'dxf-to-dxf' ||
    request.kind === 'open' ||
    request.kind === 'dxf-open'
  )
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest
  const id = request?.id
  void (async () => {
    try {
      await ensureInit()
      if (isDataRequest(request)) {
        const { data } = request
        if (data == null) {
          throw new Error('Missing request data (expected DWG or DXF bytes).')
        }
        const input = new Uint8Array(data)
        switch (request.kind) {
          case 'dwg-to-dxf': {
            const dxf = toExactBuffer(dwg_to_dxf(input))
            ctx.postMessage(
              {
                type: 'result',
                id,
                dxf
              },
              // Transfer (move) the DXF buffer instead of structurally cloning
              // it: its backing store moves to the main thread with no copy,
              // so the worker's own reference is detached and left unused.
              [dxf]
            )
            return
          }
          case 'dxf-to-dxf': {
            const dxf = toExactBuffer(dxf_to_dxf(input))
            ctx.postMessage(
              {
                type: 'result',
                id,
                dxf
              },
              // Same zero-copy transfer as `dwg-to-dxf`.
              [dxf]
            )
            return
          }
          case 'open':
            ctx.postMessage({ type: 'result', id, handle: dwg_open(input) })
            return
          case 'dxf-open':
            ctx.postMessage({ type: 'result', id, handle: dxf_open(input) })
            return
        }
      }

      // Remaining kinds are handle-scoped string/no-payload calls.
      const { handle } = request
      switch (request.kind) {
        case 'meta':
          ctx.postMessage({ type: 'result', id, json: dwg_meta(handle) })
          break
        case 'section': {
          const section = request.section as AcadRustSectionKind
          if (!ACADRUST_SECTION_KINDS.includes(section)) {
            throw new Error(`Unknown acad-rust section kind: ${String(section)}`)
          }
          ctx.postMessage({
            type: 'result',
            id,
            json: dwg_section_json(handle, section)
          })
          break
        }
        case 'page':
          ctx.postMessage({
            type: 'result',
            id,
            json: dwg_entity_page(handle, request.offset, request.limit)
          })
          break
        case 'block-page':
          ctx.postMessage({
            type: 'result',
            id,
            json: dwg_block_entity_page(
              handle,
              request.block,
              request.offset,
              request.limit
            )
          })
          break
        case 'close':
          dwg_close(handle)
          ctx.postMessage({ type: 'result', id })
          break
        default:
          throw new Error(
            `Unknown request kind: ${String((request as { kind?: string }).kind)}`
          )
      }
    } catch (err) {
      ctx.postMessage({ type: 'error', id, message: errorMessage(err) })
    }
  })()
})
