/**
 * Canonical filenames for Web Worker JS bundles shipped with the viewer.
 *
 * Keep these in one place so rename/migration is a single-file change.
 * Runtime TypeScript mirrors these in:
 *   packages/cad-simple-viewer/src/app/AcApWorkerAssets.ts
 */

/** LibreDWG (GPL) DWG parser worker from `@mlightcad/libredwg-converter`. */
export const LIBREDWG_PARSER_WORKER_FILE = 'libredwg-parser-worker.js'

/**
 * LibreDWG wasm sibling of {@link LIBREDWG_PARSER_WORKER_FILE}.
 * Must be deployed next to the worker (wasm is not inlined).
 */
export const LIBREDWG_PARSER_WASM_FILE = 'libredwg-web.wasm'

/** acadrust (MPL-2.0) DWG parser worker from `@mlightcad/acad-rust-converter`. */
export const ACADRUST_PARSER_WORKER_FILE = 'acad-rust-parser-worker.js'

/**
 * acadrust wasm sibling of {@link ACADRUST_PARSER_WORKER_FILE}.
 * Must be deployed next to the worker (wasm is not inlined).
 */
export const ACADRUST_WASM_FILE = 'acad-rust_bg.wasm'

/**
 * acadrust main-thread transcoder (ESM) — the `useWorker: false` escape hatch.
 * Deployed next to {@link ACADRUST_WASM_FILE}, which it fetches by URL; copied
 * alongside the worker so both runtimes stay available.
 */
export const ACADRUST_MAIN_THREAD_FILE = 'acad-rust-converter-main-thread.js'

/** MTEXT layout/shaping worker from `@mlightcad/mtext-renderer`. */
export const MTEXT_RENDERER_WORKER_FILE = 'mtext-renderer-worker.js'

/**
 * Proprietary DWG parser worker from private package `@mlightcad/dwg-converter`.
 * Optional — copied only when that package is resolvable (e.g. via local
 * pnpm-workspace override).
 */
export const DWG_PARSER_WORKER_FILE = 'dwg-parser-worker.js'

/**
 * Proprietary DWG parser main-thread module from `@mlightcad/dwg-converter`.
 * Used when parsing DWG on the main thread instead of a Web Worker.
 */
export const DWG_PARSER_MAIN_FILE = 'dwg-parser-main.js'

export const LIBREDWG_CONVERTER_PACKAGE = '@mlightcad/libredwg-converter'
export const ACADRUST_CONVERTER_PACKAGE = '@mlightcad/acad-rust-converter'
export const MTEXT_RENDERER_PACKAGE = '@mlightcad/mtext-renderer'
export const DWG_CONVERTER_PACKAGE = '@mlightcad/dwg-converter'
