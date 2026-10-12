import { AcDbAcadRustConverter } from '../src/AcDbAcadRustConverter'

/**
 * A minimal stand-in for the Web Worker global. Records posted messages and lets
 * a test drive the converter's `onmessage` / `onerror` handlers directly, so the
 * id-routing / timeout / fatal-error contract of the shared parser worker can be
 * exercised without a real worker or the wasm binary.
 */
class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: unknown[] = []
  terminated = false

  constructor(
    readonly url: string | URL,
    readonly options?: { name?: string }
  ) {
    FakeWorker.instances.push(this)
  }

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a `message` event to the converter's handler. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  /** Deliver a top-level worker `error` event. */
  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

interface ConverterTestApi {
  config: Record<string, unknown>
  worker: FakeWorker | null
  nextRequestId: number
  pending: Map<number, unknown>
  transcodeDwgToDxf(data: ArrayBuffer, timeout: number): Promise<ArrayBuffer>
}

// Object.create skips the real constructor (which builds a native DXF converter),
// so the worker-routing internals can be tested in isolation.
function makeConverter(config: Record<string, unknown>): ConverterTestApi {
  const converter = Object.create(
    AcDbAcadRustConverter.prototype
  ) as ConverterTestApi
  converter.config = config
  converter.worker = null
  converter.nextRequestId = 1
  converter.pending = new Map()
  return converter
}

const WORKER_URL = 'acad-rust-parser-worker.js'

beforeEach(() => {
  FakeWorker.instances = []
  // testEnvironment is "node": there is no built-in Worker, so install ours.
  ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
})

describe('AcDbAcadRustConverter.transcodeDwgToDxf contract', () => {
  it('rejects when no parserWorkerUrl is configured', async () => {
    const converter = makeConverter({})
    await expect(
      converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    ).rejects.toThrow(/parserWorkerUrl/)
    expect(FakeWorker.instances.length).toBe(0)
  })

  it('rejects `useWorker: false` (acadrust WASM is worker-only)', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL, useWorker: false })
    await expect(
      converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    ).rejects.toThrow(/worker-only|useWorker: false/)
    expect(FakeWorker.instances.length).toBe(0)
  })

  it('creates the worker lazily, routes by id, and reuses it across reads', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL })

    const first = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    expect(FakeWorker.instances.length).toBe(1)
    const worker = FakeWorker.instances[0]
    expect(worker.posted[0]).toMatchObject({ id: 1, kind: 'dwg-to-dxf' })

    const dxf = new ArrayBuffer(16)
    worker.emit({ type: 'result', id: 1, dxf })
    await expect(first).resolves.toBe(dxf)

    // Second read reuses the SAME worker and gets the next id.
    const second = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    expect(FakeWorker.instances.length).toBe(1)
    expect(worker.posted[1]).toMatchObject({ id: 2, kind: 'dwg-to-dxf' })
    worker.emit({ type: 'result', id: 2, dxf })
    await expect(second).resolves.toBe(dxf)
  })

  it('rejects a result without DXF bytes for the matched request', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL })
    const pending = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    const worker = FakeWorker.instances[0]

    worker.emit({ type: 'result', id: 1 })
    await expect(pending).rejects.toThrow(/without DXF bytes/)
    expect(worker.terminated).toBe(false)
  })

  it('times out only that request, keeps the worker, and ignores its late reply', async () => {
    jest.useFakeTimers()
    try {
      const converter = makeConverter({ parserWorkerUrl: WORKER_URL })
      const pending = converter.transcodeDwgToDxf(new ArrayBuffer(8), 50)
      const worker = FakeWorker.instances[0]

      // Fire the timeout: only this request rejects; the worker stays alive.
      jest.advanceTimersByTime(51)
      await expect(pending).rejects.toThrow(/timed out/)
      expect(converter.pending.size).toBe(0)
      expect(worker.terminated).toBe(false)

      // A late reply for the already-timed-out id must be silently ignored
      // (no throw, no new rejection).
      expect(() =>
        worker.emit({ type: 'result', id: 1, dxf: new ArrayBuffer(4) })
      ).not.toThrow()
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects only the file for an attributable worker error', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL })
    const pending = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    const worker = FakeWorker.instances[0]

    worker.emit({ type: 'error', id: 1, message: 'unsupported DWG version' })
    await expect(pending).rejects.toThrow('unsupported DWG version')
    // Worker survives a per-file failure for subsequent reads.
    expect(worker.terminated).toBe(false)
    expect(converter.worker).toBe(worker)
  })

  it('rejects all and rebuilds on an unattributable error (missing id)', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL })
    const pending = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    const worker = FakeWorker.instances[0]

    worker.emit({ type: 'error', message: 'worker misbehaved' })
    await expect(pending).rejects.toThrow('worker misbehaved')
    expect(worker.terminated).toBe(true)
    expect(converter.worker).toBeNull()

    // Next read transparently builds a fresh worker.
    const retry = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    expect(FakeWorker.instances.length).toBe(2)
    const rebuilt = FakeWorker.instances[1]
    // Settle the retry so its timeout timer is cleared before the test ends.
    const dxf = new ArrayBuffer(8)
    rebuilt.emit({ type: 'result', id: 2, dxf })
    await expect(retry).resolves.toBe(dxf)
  })

  it('rejects all and rebuilds on a top-level worker error', async () => {
    const converter = makeConverter({ parserWorkerUrl: WORKER_URL })
    const pending = converter.transcodeDwgToDxf(new ArrayBuffer(8), 1000)
    const worker = FakeWorker.instances[0]

    worker.emitError('parser script failed to load')
    await expect(pending).rejects.toThrow('parser script failed to load')
    expect(worker.terminated).toBe(true)
    expect(converter.worker).toBeNull()
  })
})
