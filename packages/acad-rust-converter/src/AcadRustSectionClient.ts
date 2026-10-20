import {
  ACADRUST_SECTION_KINDS,
  type AcadRustEntity,
  type AcadRustMeta,
  type AcadRustSectionKind
} from './model/acadrust-model'

/**
 * Low-level client for the Architecture-B sectioned WASM protocol.
 *
 * It abstracts the `dwg_open` -> `dwg_meta` -> `dwg_section_json` ->
 * `dwg_entity_page` -> `dwg_close` round-trips behind one interface so that:
 *   * the production {@link AcadRustWorkerDocumentClient} talks to the real
 *     parser Web Worker, and
 *   * a jest test can inject a fake that replays the committed
 *     `__tests__/fixtures/sample-drawing/*.json` (node cannot load the
 *     `--target web` wasm glue, so the worker path itself is untestable there).
 *
 * Everything above the handle boundary is JSON text; this client parses it once
 * so the converter only ever sees typed model objects.
 */
export interface AcadRustDocumentClient {
  /** Parse the DWG once into a resident `CadDocument`; returns its handle. */
  open(data: ArrayBuffer): Promise<number>
  /** Bounded summary for progress + pagination upper bounds. */
  meta(handle: number): Promise<AcadRustMeta>
  /** One document section, parsed from serde JSON into `T`. */
  section<T>(handle: number, kind: AcadRustSectionKind): Promise<T>
  /** One bounded page of model-space entities. */
  entityPage(handle: number, offset: number, limit: number): Promise<AcadRustEntity[]>
  /** One bounded page of a named block definition's entities. */
  blockEntityPage(
    handle: number,
    blockName: string,
    offset: number,
    limit: number
  ): Promise<AcadRustEntity[]>
  /**
   * Complete entity lists for several block definitions in one round-trip.
   * Callers batch only definitions small enough to fit one page budget and
   * keep {@link blockEntityPage} for oversized ones.
   */
  blockEntitiesBatch(
    handle: number,
    blockNames: string[]
  ): Promise<AcadRustBlockEntityGroup[]>
  /** Release the resident document behind `handle`. */
  close(handle: number): Promise<void>
  /** Tear down any transport (worker) resources; safe to call more than once. */
  dispose(): void
}

/** One block definition returned by {@link AcadRustDocumentClient.blockEntitiesBatch}. */
export interface AcadRustBlockEntityGroup {
  name: string
  entities: AcadRustEntity[]
}

/** Response payloads the worker can return for a given request id. */
interface AcadRustWorkerResult {
  type: 'result'
  id: number
  dxf?: ArrayBuffer
  handle?: number
  json?: string
  /** `open` only: wall time of the wasm `dwg_open` read, measured in-worker. */
  parseMs?: number
}

interface AcadRustWorkerError {
  type: 'error'
  id?: number
  message: string
}

type AcadRustWorkerMessage = AcadRustWorkerResult | AcadRustWorkerError

/** One in-flight request awaiting its id-matched worker response. */
interface PendingRequest {
  resolve: (result: AcadRustWorkerResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Minimal worker-global shape (avoids depending on the WebWorker TS lib). */
interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

/**
 * Options for the worker-backed client. Mirrors the fields
 * {@link AcDbAcadRustConverter} resolves from its config, so the factory can
 * hand the same asset URLs to either architecture.
 */
export interface AcadRustWorkerClientOptions {
  /** Canonical worker script URL, or `assetBaseUrl`-derived by the caller. */
  workerUrl: string | URL
  /** Per-request timeout in ms (open is the slow one; sized accordingly). */
  timeout: number
  /**
   * Input byte format for `open`: `'dwg'` (default) posts the `open` kind
   * (WASM `dwg_open`), `'dxf'` posts `dxf-open` (WASM `dxf_open`). Only the
   * open call is format-sensitive; every later sectioned call is handle-scoped
   * and identical for both.
   */
  inputFormat?: 'dwg' | 'dxf'
}

/**
 * {@link AcadRustDocumentClient} backed by the shared acad-rust parser Web
 * Worker. A single worker serves every sectioned call for one document, so the
 * handle opened by `open` stays valid in that worker's wasm memory until
 * `close`. Created lazily; reused for subsequent files; terminated only on a
 * fatal/unattributable failure so the next read transparently rebuilds it.
 */
export class AcadRustWorkerDocumentClient implements AcadRustDocumentClient {
  private worker: WorkerLike | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly options: AcadRustWorkerClientOptions
  /**
   * Per-request timeout, refreshed by {@link setRequestTimeout} because a
   * reused client serves files of different sizes (the converter scales the
   * budget with the input length).
   */
  private requestTimeout: number

  constructor(options: AcadRustWorkerClientOptions) {
    this.options = options
    this.requestTimeout = options.timeout
  }

  /**
   * Update the per-request timeout. A cached client outlives one conversion, so
   * the next `read()` can hand it a budget sized for the new file without
   * rebuilding the worker (and re-instantiating the wasm module).
   */
  setRequestTimeout(timeout: number): void {
    this.requestTimeout = Math.max(1, timeout)
  }

  async open(data: ArrayBuffer): Promise<number> {
    // Copy before transfer so the caller's ArrayBuffer is never detached.
    const payload = data.slice(0)
    const kind = this.options.inputFormat === 'dxf' ? 'dxf-open' : 'open'
    const result = await this.request(
      { id: 0, kind, data: payload },
      [payload]
    )
    if (result.handle == null) {
      throw new Error('acad-rust worker returned an open result without a handle.')
    }
    return result.handle
  }

  async meta(handle: number): Promise<AcadRustMeta> {
    const result = await this.request({ id: 0, kind: 'meta', handle })
    return this.parseJson<AcadRustMeta>(result, 'meta')
  }

  async section<T>(handle: number, kind: AcadRustSectionKind): Promise<T> {
    if (!ACADRUST_SECTION_KINDS.includes(kind)) {
      throw new Error(`Unknown acad-rust section kind: ${String(kind)}`)
    }
    const result = await this.request({ id: 0, kind: 'section', handle, section: kind })
    return this.parseJson<T>(result, `section:${kind}`)
  }

  async entityPage(
    handle: number,
    offset: number,
    limit: number
  ): Promise<AcadRustEntity[]> {
    const result = await this.request({ id: 0, kind: 'page', handle, offset, limit })
    return this.parseJson<AcadRustEntity[]>(result, 'entity-page')
  }

  async blockEntityPage(
    handle: number,
    blockName: string,
    offset: number,
    limit: number
  ): Promise<AcadRustEntity[]> {
    const result = await this.request({
      id: 0,
      kind: 'block-page',
      handle,
      block: blockName,
      offset,
      limit
    })
    return this.parseJson<AcadRustEntity[]>(result, 'block-entity-page')
  }

  async blockEntitiesBatch(
    handle: number,
    blockNames: string[]
  ): Promise<AcadRustBlockEntityGroup[]> {
    if (blockNames.length === 0) {
      return []
    }
    // Names travel as one JSON string: a 500-entry array is a few KB, far
    // cheaper than a nested structured clone, and the worker hands the same
    // string straight to wasm without re-serializing it.
    const result = await this.request({
      id: 0,
      kind: 'block-batch',
      handle,
      names: JSON.stringify(blockNames)
    })
    return this.parseJson<AcadRustBlockEntityGroup[]>(
      result,
      'block-entities-batch'
    )
  }

  async close(handle: number): Promise<void> {
    await this.request({ id: 0, kind: 'close', handle })
  }

  dispose(): void {
    this.rejectAllPending(new Error('acad-rust section client disposed.'))
    this.resetWorker()
  }

  /** Parse a `{json}` worker response, tagging failures with the request label. */
  private parseJson<T>(result: AcadRustWorkerResult, label: string): T {
    if (result.json == null) {
      throw new Error(`acad-rust worker returned no JSON for ${label}.`)
    }
    return JSON.parse(result.json) as T
  }

  /** Post one request, await its id-matched response (or reject on timeout). */
  private request(
    partial: Record<string, unknown>,
    transfer?: Transferable[]
  ): Promise<AcadRustWorkerResult> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const message = { ...partial, id }
    return new Promise<AcadRustWorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop routing so a late reply is ignored; keep the worker (a slow
        // section is not fatal) — the next read reuses it.
        this.pending.delete(id)
        reject(
          new Error(
            `acad-rust section request '${String(partial.kind)}' timed out after ` +
              `${this.requestTimeout}ms.`
          )
        )
      }, this.requestTimeout)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage(message, transfer)
    })
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) {
      return this.worker
    }
    const WorkerCtor = (
      globalThis as unknown as { Worker?: new (url: string | URL, opts?: { name?: string }) => WorkerLike }
    ).Worker
    if (!WorkerCtor) {
      throw new Error(
        'AcadRustWorkerDocumentClient requires a Web Worker global; run it in a ' +
          'browser, or inject a fake AcadRustDocumentClient (see the parity tests).'
      )
    }
    const worker = new WorkerCtor(this.options.workerUrl, {
      name: 'acad-rust-parser'
    })
    worker.onmessage = (event: MessageEvent) =>
      this.handleMessage(event.data as AcadRustWorkerMessage)
    worker.onerror = (event: ErrorEvent) => this.handleError(event.message)
    this.worker = worker
    return worker
  }

  private handleMessage(message: AcadRustWorkerMessage): void {
    if (!message || typeof message !== 'object') {
      return
    }
    const entry = this.takePending(message.id)
    if (message.type === 'result') {
      if (!entry) {
        return // late reply for an already-timed-out request — ignore
      }
      entry.resolve(message)
    } else if (message.type === 'error') {
      const error = new Error(
        message.message || 'acad-rust section request failed.'
      )
      if (entry) {
        entry.reject(error)
      } else {
        // Unattributable error (missing/invalid id): reset so the next read
        // builds a fresh worker instead of trusting a possibly-broken one.
        this.rejectAllPending(error)
        this.resetWorker()
      }
    }
  }

  private handleError(message: string): void {
    this.rejectAllPending(
      new Error(message || 'acad-rust parser worker failed to start.')
    )
    this.resetWorker()
  }

  private takePending(id: number | undefined): PendingRequest | undefined {
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

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

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
