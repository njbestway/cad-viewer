import {
  type AcDbConversionProgressCallback,
  type AcDbDatabase,
  AcDbDatabaseConverter,
  type AcDbDatabaseConverterConfig,
  type AcDbDatabaseConverterReadOptions,
  AcDbNativeDxfConverter
} from '@mlightcad/data-model'

/**
 * Share of the progress bar reserved for the DWG -> DXF transcode. The delegated
 * native DXF converter is then scaled into the remaining `[end, 100]` range so
 * the bar stays monotonic.
 */
const TRANSCODE_END_PERCENTAGE = 20

/** Worker -> main response payloads (mirror of `src/worker.ts`). */
interface AcadRustWorkerResult {
  type: 'result'
  id: number
  dxf?: ArrayBuffer
}

interface AcadRustWorkerError {
  type: 'error'
  id?: number
  message: string
}

type AcadRustWorkerMessage = AcadRustWorkerResult | AcadRustWorkerError

/** One in-flight transcode request awaiting its id-matched worker response. */
interface PendingTranscode {
  resolve: (dxf: ArrayBuffer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Canonical deployed asset filenames. Kept in sync with
 * `tools/worker-assets.mjs`; the wasm is a sibling of whichever script loads it.
 */
const WORKER_FILE = 'acad-rust-parser-worker.js'
const WASM_FILE = 'acad-rust_bg.wasm'
const MAIN_THREAD_FILE = 'acad-rust-converter-main-thread.js'

/** Shape of the dynamically-imported main-thread transcoder module. */
interface AcadRustMainThreadModule {
  transcodeDwgToDxf(data: Uint8Array, wasmUrl: string): Promise<Uint8Array>
}

/**
 * Converter options. Extends the data-model config with the acad-rust
 * deployment ergonomics so a host can point at a single asset directory instead
 * of reconstructing each canonical filename.
 */
export interface AcDbAcadRustConverterConfig extends AcDbDatabaseConverterConfig {
  /**
   * Base directory (URL) that holds the deployed acad-rust assets — the worker,
   * its sibling wasm, and the main-thread transcoder module — letting the
   * converter derive their URLs from the canonical filenames. A trailing slash
   * is optional. Any of the more specific URLs below override this.
   */
  assetBaseUrl?: string | URL
  /** Explicit worker script URL; wins over `assetBaseUrl`. */
  parserWorkerUrl?: string | URL
  /** Explicit main-thread transcoder module URL; wins over `assetBaseUrl`. */
  mainThreadModuleUrl?: string | URL
  /** Explicit wasm URL for the main-thread path; wins over `assetBaseUrl`. */
  wasmUrl?: string | URL
  /**
   * Which conversion architecture to use for DWG. Defaults to `'dxf'`
   * (Architecture A: acadrust `dwg_to_dxf` then the MIT native DXF converter).
   * `'native'` selects Architecture B ({@link AcDbAcadRustNativeConverter}),
   * which maps acadrust `CadDocument` sections straight into the database, with
   * a transparent fallback to Architecture A if the native open/section path
   * fails. See the Phase 4 plan; as of Slice 0 `'native'` populates header +
   * tables only and is not yet the default.
   */
  architecture?: 'dxf' | 'native'
  /**
   * Input byte format fed to the acadrust WASM. Defaults to `'dwg'`.
   * `'dxf'` routes a `.dxf` through the acadrust front end instead —
   * Architecture A calls `dxf_to_dxf` (DXF -> CadDocument -> DXF) then the MIT
   * DXF converter, and Architecture B calls `dxf_open` so the sectioned reader
   * maps DXF -> CadDocument -> JSON -> DB. Used by the example's DXF benchmark
   * to compare these against the built-in DXF reader; the main-thread path does
   * not implement it (worker only).
   */
  inputFormat?: 'dwg' | 'dxf'
}

/**
 * DWG converter backed by [acadrust](https://github.com/hakanaktt/acadrust)
 * compiled to WebAssembly (MPL-2.0) — a copyleft-free replacement for the GPL
 * `@mlightcad/libredwg-converter`.
 *
 * Architecture A (MVP): DWG bytes are transcoded to ASCII DXF by the acadrust
 * WASM, then handed to the MIT {@link AcDbNativeDxfConverter}, which streams the
 * DXF into the {@link AcDbDatabase}.
 *
 * By default the WASM transcode runs in a Web Worker. That is a *performance and
 * memory* choice — it keeps a multi-second parse off the UI thread and lets the
 * worker's linear-memory heap be reclaimed — **not** a licensing one: acadrust
 * is MPL-2.0, whose file-level copyleft imposes no runtime isolation. Hosts that
 * cannot (or do not want to) use a Worker can set `useWorker: false` to run the
 * same WASM on the main thread instead.
 *
 * Deployment ergonomics: point `assetBaseUrl` at the directory holding the
 * deployed assets (worker, sibling wasm, main-thread module) and the converter
 * derives their URLs; `parserWorkerUrl` / `wasmUrl` / `mainThreadModuleUrl` are
 * per-file overrides for hosts with a non-standard layout.
 *
 * ```ts
 * // One line for bundler hosts that copy the assets into e.g. ./workers:
 * registerAcadRustConverter({ assetBaseUrl: './workers/' })
 * ```
 */
export class AcDbAcadRustConverter extends AcDbDatabaseConverter<null> {
  /** Reused for the DXF stage; always runs on the main thread. */
  private readonly dxfConverter: AcDbNativeDxfConverter

  /** Our (superset) options — `this.config` is typed to the base config. */
  private readonly opts: AcDbAcadRustConverterConfig

  /**
   * Parser worker, created on first use and reused across reads. Terminated only
   * on a fatal/unattributable failure so the next read transparently rebuilds it,
   * avoiding a fresh worker + wasm fetch/init for every file.
   */
  private worker: Worker | null = null
  /** Monotonic request id used to route responses back to the right caller. */
  private nextRequestId = 1
  /** Requests awaiting their worker response, keyed by {@link nextRequestId}. */
  private readonly pending = new Map<number, PendingTranscode>()

  constructor(config?: AcDbAcadRustConverterConfig) {
    super(config)
    this.opts = config ?? {}
    // Only the DWG -> DXF transcode may use a worker; the DXF stage runs inline.
    this.dxfConverter = new AcDbNativeDxfConverter({
      ...config,
      useWorker: false
    })
  }

  /**
   * Transcode DWG -> DXF (worker/WASM), then delegate to the native DXF
   * converter to populate `db`.
   */
  async read(
    data: ArrayBuffer,
    db: AcDbDatabase,
    options?: AcDbDatabaseConverterReadOptions
  ): Promise<void> {
    const progress = options?.progress ?? this.progress
    const timeout = this.getParserWorkerTimeout(
      data,
      options?.timeout ?? this.config.timeout
    )

    await progress?.(2, 'PARSE', 'IN-PROGRESS')
    const dxf = await this.transcodeDwgToDxf(data, timeout)
    await progress?.(TRANSCODE_END_PERCENTAGE, 'PARSE', 'IN-PROGRESS')

    await this.dxfConverter.read(dxf, db, {
      ...options,
      progress: progress ? scaleProgress(progress) : undefined
    })
  }

  /**
   * Run the WASM `dwg_to_dxf` (or `dxf_to_dxf` for `inputFormat: 'dxf'`),
   * choosing worker vs main thread from `useWorker`. Both paths produce
   * identical DXF bytes; the worker just keeps the parse off the UI thread and
   * its heap reclaimable.
   */
  private transcodeDwgToDxf(
    data: ArrayBuffer,
    timeout: number
  ): Promise<ArrayBuffer> {
    if (this.opts.useWorker === false) {
      if (this.opts.inputFormat === 'dxf') {
        return Promise.reject(
          new Error(
            'AcDbAcadRustConverter DXF input (inputFormat: \'dxf\') is worker-only; '
              + 'the main-thread transcoder exposes just DWG. Use the worker path.'
          )
        )
      }
      return this.transcodeOnMainThread(data, timeout)
    }
    return this.transcodeViaWorker(data, timeout)
  }

  /** Resolve an asset URL: explicit per-file URL, else `assetBaseUrl` + file. */
  private resolveAssetUrl(
    explicit: string | URL | undefined,
    file: string
  ): string | undefined {
    if (explicit != null) {
      return explicit.toString()
    }
    const base = this.opts.assetBaseUrl
    return base == null ? undefined : joinAssetBase(base.toString(), file)
  }

  /** Worker script URL: explicit `parserWorkerUrl` or `assetBaseUrl` derived. */
  private resolveWorkerUrl(): string | undefined {
    return this.resolveAssetUrl(this.opts.parserWorkerUrl, WORKER_FILE)
  }

  /** Post the DWG bytes to the shared WASM worker and await the DXF reply. */
  private transcodeViaWorker(
    data: ArrayBuffer,
    timeout: number
  ): Promise<ArrayBuffer> {
    const workerUrl = this.resolveWorkerUrl()
    if (!workerUrl) {
      return Promise.reject(
        new Error(
          'AcDbAcadRustConverter needs a worker URL: set config.parserWorkerUrl, ' +
            `or config.assetBaseUrl to the directory holding ${WORKER_FILE} ` +
            '(the WASM parser then runs in a Web Worker).'
        )
      )
    }

    let worker: Worker
    try {
      worker = this.ensureWorker(workerUrl)
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      )
    }

    const id = this.nextRequestId++
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the routing entry so a late worker response is ignored, but keep
        // the worker alive: a slow file is not a fatal worker error.
        this.pending.delete(id)
        reject(
          new Error(
            `acad-rust DWG -> DXF transcode timed out after ${timeout}ms.`
          )
        )
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })

      // Copy before transfer so the caller's ArrayBuffer is not detached — a
      // reused worker may serve several concurrent reads.
      const payload = data.slice(0)
      const kind = this.opts.inputFormat === 'dxf' ? 'dxf-to-dxf' : 'dwg-to-dxf'
      worker.postMessage({ id, kind, data: payload }, [payload])
    })
  }

  /**
   * Main-thread escape hatch (`useWorker: false`): dynamically import the
   * deployed transcoder module and run `dwg_to_dxf` on this thread. Browser-only
   * — asset URLs are resolved against `document.baseURI`, the same base a
   * relative `new Worker(url)` would use, so no `import.meta` (and thus no UMD
   * build breakage) is required.
   */
  private async transcodeOnMainThread(
    data: ArrayBuffer,
    timeout: number
  ): Promise<ArrayBuffer> {
    const moduleUrl = this.resolveAssetUrl(
      this.opts.mainThreadModuleUrl,
      MAIN_THREAD_FILE
    )
    const wasmUrl = this.resolveAssetUrl(this.opts.wasmUrl, WASM_FILE)
    if (!moduleUrl || !wasmUrl) {
      throw new Error(
        'AcDbAcadRustConverter main-thread transcode needs config.assetBaseUrl ' +
          `(or explicit mainThreadModuleUrl + wasmUrl) for ${MAIN_THREAD_FILE} ` +
          `and ${WASM_FILE}.`
      )
    }
    if (typeof document === 'undefined') {
      throw new Error(
        'AcDbAcadRustConverter main-thread transcode is browser-only (it resolves ' +
          'module/wasm URLs against document.baseURI). Use the worker path when no ' +
          'DOM is available.'
      )
    }
    const resolved = new URL(moduleUrl, document.baseURI).href
    // `@vite-ignore` + a runtime-computed specifier keeps the (large) WASM glue
    // out of this bundle — it is loaded only when the main-thread path runs.
    const loader = (await import(/* @vite-ignore */ resolved)) as AcadRustMainThreadModule
    const dxf = await withTimeout(
      loader.transcodeDwgToDxf(
        new Uint8Array(data),
        new URL(wasmUrl, document.baseURI).href
      ),
      timeout
    )
    return normalizeDxfBuffer(dxf)
  }

  /** Create the parser worker once, wiring the shared message/error handlers. */
  private ensureWorker(workerUrl: string | URL): Worker {
    if (this.worker) {
      return this.worker
    }
    const worker = new Worker(workerUrl, { name: 'acad-rust-parser' })
    worker.onmessage = (event: MessageEvent<AcadRustWorkerMessage>) =>
      this.handleWorkerMessage(event.data)
    worker.onerror = (event: ErrorEvent) =>
      this.handleWorkerError(event.message)
    this.worker = worker
    return worker
  }

  /** Route a worker response to its pending request by id, ignoring stale ones. */
  private handleWorkerMessage(message: AcadRustWorkerMessage): void {
    if (!message || typeof message !== 'object') {
      return
    }
    const entry = this.takePending(message.id)
    if (message.type === 'result') {
      if (!entry) {
        // Response for an already-timed-out/unknown request — nothing to settle.
        return
      }
      if (message.dxf) {
        entry.resolve(message.dxf)
      } else {
        entry.reject(
          new Error('acad-rust worker returned a result without DXF bytes.')
        )
      }
    } else if (message.type === 'error') {
      const error = new Error(
        message.message || 'acad-rust DWG -> DXF transcode failed.'
      )
      if (entry) {
        // Failure attributable to one file (e.g. unsupported DWG): reject just
        // this request and keep the worker for subsequent files.
        entry.reject(error)
      } else {
        // Unattributable error (missing/invalid id): reset so the next read
        // starts from a fresh worker instead of a possibly-broken one.
        this.rejectAllPending(error)
        this.resetWorker()
      }
    }
  }

  /** The worker itself failed to start/run: fail every waiter and rebuild. */
  private handleWorkerError(message: string): void {
    this.rejectAllPending(
      new Error(message || 'acad-rust parser worker failed to start.')
    )
    this.resetWorker()
  }

  /** Pop a pending request (clearing its timer); returns undefined if none. */
  private takePending(id: number | undefined): PendingTranscode | undefined {
    if (id == null) {
      return undefined
    }
    const entry = this.pending.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
    }
    return entry
  }

  /** Reject every outstanding waiter (used when the worker is going away). */
  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Tear down the worker so the next {@link ensureWorker} call rebuilds it. */
  private resetWorker(): void {
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
  }
}

/**
 * Join a deployment base directory to a canonical asset filename, adding the
 * separator only when the base does not already end in one.
 */
function joinAssetBase(base: string, file: string): string {
  return base.endsWith('/') ? `${base}${file}` : `${base}/${file}`
}

/** Reject if `promise` does not settle within `timeout` ms; else pass through. */
function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`acad-rust DWG -> DXF transcode timed out after ${timeout}ms.`)
      )
    }, timeout)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Normalize a wasm-bindgen Uint8Array view into an exact, zero-offset
 * ArrayBuffer — the same guarantee the worker applies before transferring DXF
 * bytes, so the downstream DXF decoder never reads trailing garbage.
 */
function normalizeDxfBuffer(dxf: Uint8Array): ArrayBuffer {
  const exact =
    dxf.byteOffset === 0 && dxf.byteLength === dxf.buffer.byteLength
      ? dxf
      : dxf.slice()
  return exact.buffer as ArrayBuffer
}

/**
 * Wrap a progress callback so the delegated DXF converter's 0-100 range maps
 * into `[TRANSCODE_END_PERCENTAGE, 100]`, keeping the bar monotonic after the
 * transcode slice.
 */
function scaleProgress(
  progress: AcDbConversionProgressCallback
): AcDbConversionProgressCallback {
  const span = 100 - TRANSCODE_END_PERCENTAGE
  return (percentage, stage, stageStatus, data, error) =>
    progress(
      TRANSCODE_END_PERCENTAGE + (percentage * span) / 100,
      stage,
      stageStatus,
      data,
      error
    )
}
