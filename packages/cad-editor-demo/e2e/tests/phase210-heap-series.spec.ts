import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.10 Task F2 - the five control experiments for the Phase 2.9 ERASE
 * heap residue.
 *
 * Phase 2.9 measured ~70 B/entity/round left behind after clearing the undo
 * history, with every renderer and scene counter flat. A counter table cannot
 * name the retainer, so each experiment here isolates one candidate:
 *
 * 1. erase / undo / redo / undo, history kept - the baseline slope.
 * 2. the same edits, history cleared every round - if the slope survives the
 *    history, the history is not (only) the retainer.
 * 3. the same, history cleared *and* the document closed each round - residue
 *    that survives a document swap is pinned by something global.
 * 4. no edits at all, only the same number of scene queries as an edit round -
 *    separates "query caches grow" from "edits leak".
 * 5. the same edits with the convert bookkeeping (`_erasedConvertObjectIds`,
 *    `_claimedConvertObjectIds`, generations, missed images) cleared each round
 *    - the toggled-cache comparison the task asks for.
 *
 * Every round is measured *after* a forced GC, so the numbers are live objects
 * only. Two heap snapshots bracket experiment 2 for retainer-path analysis with
 * `tools/phase210-heap-retainers.mjs`.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase210')

const SIZE = Number(process.env.P210H_SIZE ?? 1_000)
const ROUNDS = Number(process.env.P210H_ROUNDS ?? 6)
const SNAPSHOTS = process.env.P210H_SNAPSHOT !== '0'

test.use({ trace: 'off' })
test.setTimeout(3_600_000)

type ViewWindow = Window & {
  AcApDocManager?: {
    instance?: {
      closeDocument?: () => Promise<boolean>
      curView?: {
        waitUntilSceneReady?: (o?: { timeoutMs?: number }) => Promise<{ ready: boolean }>
        getSceneReadiness?: (o?: { sampleLimit?: number }) => { ready: boolean }
        getOpenConvertStats?: () => Record<string, number>
        getSharedBatchMetrics?: () => Record<string, number>
        getSharedBatchEntries?: () => unknown[]
        hasEntity?: (id: string) => boolean
        _claimedConvertObjectIds?: Set<string>
        _erasedConvertObjectIds?: Set<string>
        _entityConvertGeneration?: Map<string, number>
        _missedImages?: Map<string, string>
        _viewportRepairOwnerIds?: Set<string>
        _scene?: {
          _layouts?: Map<string, { collectObjectIds?: () => Set<string>; spatialIndexRootIds?: string[] }>
        }
      }
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            undo: () => boolean
            redo: () => boolean
            undoStack?: {
              undoRecords?: unknown[]
              redoRecords?: unknown[]
              retainedChangeCount?: number
            }
          }
        }
        entityService: { eraseEntities: (ids: string[]) => number }
      }
    }
  }
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const iterator = (window as unknown as ViewWindow).AcApDocManager?.instance?.curDocument
      ?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

async function drain(page: Page) {
  const result = await page.evaluate(async () => {
    const view = (window as unknown as ViewWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return { ready: Boolean(snapshot?.ready) }
  })
  expect(result.ready).toBe(true)
}

async function loadFixture(page: Page) {
  const fixture = writeMixedFixture(SIZE, `p210heap${SIZE}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
    .toBe(SIZE)
  await drain(page)
}

/** One erase -> undo -> redo -> undo cycle; the Phase 2.9 profile. */
async function editRound(page: Page) {
  // Read the ids from the live document: experiment 3 reopens the drawing
  // between rounds, so a cached list would name ids the new document lacks.
  const ids = await readDbIds(page)
  const erased = await page.evaluate(list => {
    const doc = (window as unknown as ViewWindow).AcApDocManager?.instance?.curDocument
    return doc?.entityService.eraseEntities(list) ?? 0
  }, ids)
  expect(erased).toBe(ids.length)
  await drain(page)
  for (const action of ['undo', 'redo', 'undo'] as const) {
    const ok = await page.evaluate(name => {
      const manager = (window as unknown as ViewWindow).AcApDocManager?.instance?.curDocument
        ?.database.transactionManager
      return name === 'undo' ? manager?.undo() : manager?.redo()
    }, action)
    expect(ok, `${action} was refused`).toBe(true)
    await drain(page)
  }
}

/** Equal-volume scene queries, no mutation. */
async function queryRound(page: Page) {
  await page.evaluate(async () => {
    const win = window as unknown as ViewWindow
    const view = win.AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    for (let pass = 0; pass < 4; pass++) {
      view?.getSceneReadiness?.({ sampleLimit: 16 })
      view?.getOpenConvertStats?.()
      view?.getSharedBatchMetrics?.()
      view?.getSharedBatchEntries?.()
      if (layouts instanceof Map) {
        for (const layout of layouts.values()) {
          layout.collectObjectIds?.()
          layout.spatialIndexRootIds
        }
      }
      const iterator = win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable
        .modelSpace.newIterator()
      if (iterator) {
        for (const entity of iterator) view?.hasEntity?.(String(entity.objectId))
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

async function readCounters(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as ViewWindow
    const view = win.AcApDocManager?.instance?.curView
    const stack = win.AcApDocManager?.instance?.curDocument?.database.transactionManager.undoStack
    let sceneIds = 0
    const layouts = view?._scene?._layouts
    if (layouts instanceof Map) {
      for (const layout of layouts.values()) sceneIds += layout.collectObjectIds?.().size ?? 0
    }
    return {
      sceneIds,
      undoRecords: (stack?.undoRecords ?? []).length,
      redoRecords: (stack?.redoRecords ?? []).length,
      retainedChanges: stack?.retainedChangeCount ?? -1,
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      erasedTombstones: view?._erasedConvertObjectIds?.size ?? -1,
      generations: view?._entityConvertGeneration?.size ?? -1,
      missedImages: view?._missedImages?.size ?? -1,
      viewportRepair: view?._viewportRepairOwnerIds?.size ?? -1,
      sharedBatchEntries: view?.getSharedBatchEntries?.().length ?? -1,
      convert: view?.getOpenConvertStats?.()
    }
  })
}

async function readHeapMB(page: Page) {
  return page.evaluate(() => {
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
    return Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10
  })
}

async function takeSnapshot(
  cdp: import('@playwright/test').CDPSession,
  file: string
) {
  const chunks: string[] = []
  const onChunk = (event: { chunk: string }) => chunks.push(event.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  fs.writeFileSync(file, chunks.join(''), 'utf8')
  return { file: path.basename(file), bytes: fs.statSync(file).size }
}

/** Arithmetic mean of the per-round deltas, i.e. the slope in MB/round. */
function slope(samples: number[]) {
  if (samples.length < 2) return 0
  const deltas: number[] = []
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1])
  return Math.round((deltas.reduce((sum, value) => sum + value, 0) / deltas.length) * 1000) / 1000
}

async function runSeries(
  page: Page,
  cdp: import('@playwright/test').CDPSession,
  options: {
    name: string
    /** Per-round work. Reads the live document itself so a reopened drawing
     * (experiment 3) is not edited with the previous document's ids. */
    round: () => Promise<void>
    /** Clears the undo/redo history before the GC sample. */
    clearHistory?: boolean
    /** Closes the document before the GC sample and reloads after it. */
    closeDocument?: boolean
    /** Clears convert bookkeeping before the GC sample. */
    clearConvertState?: boolean
    /** Snapshot file prefix; two snapshots are taken when set. */
    snapshotPrefix?: string
  }
) {
  const { name, round } = options
  await loadFixture(page)
  await cdp.send('HeapProfiler.collectGarbage')

  const samples: number[] = []
  const counterRows: unknown[] = []
  let first: { file: string; bytes: number } | null = null
  let last: { file: string; bytes: number } | null = null

  for (let roundIndex = 1; roundIndex <= ROUNDS; roundIndex++) {
    await round()

    if (options.clearHistory) {
      await page.evaluate(() => {
        const stack = (window as unknown as ViewWindow).AcApDocManager?.instance?.curDocument
          ?.database.transactionManager.undoStack
        if (stack?.undoRecords) stack.undoRecords.length = 0
        if (stack?.redoRecords) stack.redoRecords.length = 0
      })
    }
    if (options.clearConvertState) {
      await page.evaluate(() => {
        const view = (window as unknown as ViewWindow).AcApDocManager?.instance?.curView
        view?._erasedConvertObjectIds?.clear()
        view?._claimedConvertObjectIds?.clear()
        view?._entityConvertGeneration?.clear()
        view?._missedImages?.clear()
        view?._viewportRepairOwnerIds?.clear()
      })
    }
    if (options.closeDocument) {
      const closed = await page.evaluate(
        async () => await (window as unknown as ViewWindow).AcApDocManager?.instance?.closeDocument?.()
      )
      expect(closed).toBe(true)
    }

    await cdp.send('HeapProfiler.collectGarbage')
    const heapMB = await readHeapMB(page)
    samples.push(heapMB)
    counterRows.push({
      round: roundIndex,
      heapMB,
      counters: options.closeDocument ? null : await readCounters(page)
    })

    if (options.snapshotPrefix && SNAPSHOTS && (roundIndex === 1 || roundIndex === ROUNDS)) {
      const file = path.join(
        reportsDir,
        `phase210-heap-${options.snapshotPrefix}-r${roundIndex}.heapsnapshot`
      )
      const written = await takeSnapshot(cdp, file)
      if (roundIndex === 1) first = written
      else last = written
    }

    if (options.closeDocument && roundIndex < ROUNDS) {
      await loadFixture(page)
    }
  }

  return {
    name,
    rounds: ROUNDS,
    clearHistory: Boolean(options.clearHistory),
    closeDocument: Boolean(options.closeDocument),
    clearConvertState: Boolean(options.clearConvertState),
    samples,
    slopeMBPerRound: slope(samples),
    bytesPerEntityPerRound: Math.round((slope(samples) * 1024 * 1024 * 10) / SIZE) / 10,
    counterRows,
    snapshots: { first, last }
  }
}

test('phase 2.10 F2 heap residue controls', async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')

  const experiments: unknown[] = []

  experiments.push(await runSeries(page, cdp, { name: '1-edit-history-kept', round: () => editRound(page) }))
  experiments.push(
    await runSeries(page, cdp, {
      name: '2-edit-history-cleared',
      round: () => editRound(page),
      clearHistory: true,
      snapshotPrefix: 'series'
    })
  )
  experiments.push(
    await runSeries(page, cdp, {
      name: '3-edit-history-cleared-close',
      round: () => editRound(page),
      clearHistory: true,
      closeDocument: true
    })
  )
  experiments.push(
    await runSeries(page, cdp, { name: '4-query-only', round: () => queryRound(page) })
  )
  experiments.push(
    await runSeries(page, cdp, {
      name: '5-edit-convert-state-cleared',
      round: () => editRound(page),
      clearHistory: true,
      clearConvertState: true
    })
  )

  const summary = {
    phase: '2.10',
    task: 'F2',
    generatedAt: new Date().toISOString(),
    size: SIZE,
    rounds: ROUNDS,
    userAgent: await page.evaluate(() => navigator.userAgent),
    note:
      'Every sample is taken after a forced GC. `slopeMBPerRound` is the mean first difference of the post-GC heap.',
    experiments
  }
  fs.writeFileSync(
    path.join(reportsDir, 'phase210-heap-series.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8'
  )
  console.log(
    `[phase210-heap] ${experiments
      .map(entry => {
        const row = entry as { name: string; slopeMBPerRound: number }
        return `${row.name}=${row.slopeMBPerRound}MB/round`
      })
      .join(' ')}`
  )
})
