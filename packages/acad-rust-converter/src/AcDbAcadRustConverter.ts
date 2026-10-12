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
 * DWG converter backed by [acadrust](https://github.com/hakanaktt/acadrust)
 * compiled to WebAssembly (MPL-2.0) — a copyleft-free replacement for the GPL
 * `@mlightcad/libredwg-converter`.
 *
 * Architecture A (MVP): DWG bytes are transcoded to ASCII DXF inside a Web
 * Worker (WASM), then handed to the MIT {@link AcDbNativeDxfConverter}, which
 * streams the DXF into the {@link AcDbDatabase}. No GPL code is linked and the
 * WASM never enters the main bundle.
 *
 * Register it exactly like the LibreDWG converter:
 * ```ts
 * AcDbDatabaseConverterManager.instance.register(
 *   AcDbFileType.DWG,
 *   new AcDbAcadRustConverter({ useWorker: true, parserWorkerUrl })
 * )
 * ```
 */
export class AcDbAcadRustConverter extends AcDbDatabaseConverter<null> {
  /** Reused for the DXF stage; always runs on the main thread. */
  private readonly dxfConverter: AcDbNativeDxfConverter

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

  constructor(config?: AcDbDatabaseConverterConfig) {
    super(config)
    // Only the DWG -> DXF transcode uses a worker; the DXF stage runs inline.
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

  /** Run the WASM `dwg_to_dxf` in the (shared) parser worker and resolve the DXF bytes. */
  private transcodeDwgToDxf(
    data: ArrayBuffer,
    timeout: number
  ): Promise<ArrayBuffer> {
    const workerUrl = this.config.parserWorkerUrl
    if (!workerUrl) {
      return Promise.reject(
        new Error(
          'AcDbAcadRustConverter requires config.parserWorkerUrl pointing at ' +
            'acad-rust-parser-worker.js (the WASM parser runs in a Web Worker).'
        )
      )
    }

    // Unlike a permissive converter, the copyleft (MPL-2.0) acadrust WASM has no
    // main-thread fallback: `useWorker: false` would either crash or pull the
    // wasm into the main bundle, so reject it explicitly rather than ignore it.
    if (this.config.useWorker === false) {
      return Promise.reject(
        new Error(
          'AcDbAcadRustConverter cannot run with `useWorker: false`; the ' +
            'acadrust WASM parser is worker-only. Provide config.parserWorkerUrl ' +
            'and leave `useWorker` at its default (true).'
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
      worker.postMessage({ id, kind: 'dwg-to-dxf', data: payload }, [payload])
    })
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
