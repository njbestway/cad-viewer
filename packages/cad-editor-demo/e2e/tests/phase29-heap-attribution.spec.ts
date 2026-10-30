import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.9 — JS heap attribution for the ERASE/Undo/Redo cycle.
 *
 * The Task D runs show every *graph* counter flat (renderer geometries,
 * `Object3D` nodes, shared batches, template geometries, undo records, retained
 * changes) while the post-GC JS heap climbs by a constant per round. A flat
 * counter table cannot name the retainer, so this spec takes two V8 heap
 * snapshots around a fixed number of rounds and leaves the diff to
 * `tools/phase29-heap-diff.mjs`.
 *
 * Deliberately *not* a regression test: it produces evidence. The pass/fail
 * gate for the leak lives in the Task D spec, where the source of truth is a
 * 50-round series rather than a two-point sample.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase29')

const size = Number(process.env.P29H_SIZE ?? 5_000)
const rounds = Number(process.env.P29H_ROUNDS ?? 8)
const tag = (process.env.P29H_TAG ?? 'heap').replace(/[^\w.-]/g, '_')
/** Allocation sampling names the allocating call stack; off unless asked for. */
const sampling = process.env.P29H_SAMPLING === '1'
/**
 * V8 heap snapshots are ~450 MB each at 5k entities. Two cost more disk than
 * the question needs when only the *series* matters (e.g. "is the slope
 * per-round or per-entity?"), so they can be skipped.
 */
const snapshots = process.env.P29H_SNAPSHOT !== '0'

test.use({ trace: 'off' })
test.setTimeout(3_600_000)
test.describe.configure({ mode: 'serial' })

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (options?: {
          timeoutMs?: number
        }) => Promise<{ ready: boolean; reasons: string[] }>
      }
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            undo: () => boolean
            redo: () => boolean
            undoStack?: { undoRecords?: unknown[]; redoRecords?: unknown[] }
          }
        }
        entityService: { eraseEntities: (ids: string[]) => number }
      }
    }
  }
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

async function drain(page: Page) {
  return page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: (snapshot?.reasons ?? []) as string[]
    }
  })
}

/** Tenths of a MB of the JS heap; `performance.memory` is Chromium-only. */
async function readHeapMB(page: Page) {
  return page.evaluate(() => {
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
    return Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10
  })
}

/** Streams one V8 heap snapshot to disk; the chunks arrive as CDP events. */
async function takeHeapSnapshot(
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

test(`phase29 heap attribution: ${rounds} erase rounds on ${size}`, async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(size, `p29heap${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
    .toBe(size)
  expect((await drain(page)).ready).toBe(true)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')
  const ids = await readDbIds(page)

  const runRound = async (round: number) => {
    await page.evaluate(list => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.entityService.eraseEntities(list)
    }, ids)
    expect((await drain(page)).ready).toBe(true)
    await page.evaluate(() => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.database.transactionManager.undo()
    })
    expect((await drain(page)).ready).toBe(true)
    await page.evaluate(() => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.database.transactionManager.redo()
    })
    expect((await drain(page)).ready).toBe(true)
    await page.evaluate(() => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.database.transactionManager.undo()
    })
    expect((await drain(page)).ready).toBe(true)
    const restored = await readDbIds(page)
    expect(restored.length, `round ${round} restored ${restored.length}/${size}`).toBe(size)
  }

  await runRound(1)
  // Forced GC so the snapshot holds live data plus one round's worth of noise,
  // not an entire upload burst.
  await cdp.send('HeapProfiler.collectGarbage')
  const before = snapshots
    ? await takeHeapSnapshot(
        cdp,
        path.join(reportsDir, `phase29-heap-${tag}-before-${size}.heapsnapshot`)
      )
    : null
  const beforeHeapMB = await readHeapMB(page)

  // Allocation sampling over the measured rounds: self-size ranked by call
  // frame, i.e. "which code allocates the objects that pile up".
  if (sampling) {
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    })
  }

  for (let round = 2; round <= rounds; round++) await runRound(round)

  if (sampling) {
    const profile = await cdp.send('HeapProfiler.stopSampling')
    fs.writeFileSync(
      path.join(reportsDir, `phase29-heap-${tag}-sampling-${size}.json`),
      `${JSON.stringify(profile, null, 2)}\n`,
      'utf8'
    )
  }

  await cdp.send('HeapProfiler.collectGarbage')
  const after = snapshots
    ? await takeHeapSnapshot(
        cdp,
        path.join(reportsDir, `phase29-heap-${tag}-after-${size}.heapsnapshot`)
      )
    : null
  const afterHeapMB = await readHeapMB(page)

  // Attribution test: if dropping the transaction history releases the growth,
  // the growth *is* retained undo history (legitimate, reported not judged).
  // If the heap stays where it was, the objects are pinned by something else
  // and the slope is a real retention defect.
  const historyCleared = await page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const stack = doc?.database.transactionManager.undoStack
    if (!stack) return null
    const undoRecords = (stack.undoRecords ?? []).length
    const redoRecords = (stack.redoRecords ?? []).length
    if (stack.undoRecords) stack.undoRecords.length = 0
    if (stack.redoRecords) stack.redoRecords.length = 0
    return { undoRecords, redoRecords }
  })
  await cdp.send('HeapProfiler.collectGarbage')
  const afterClearHeapMB = await readHeapMB(page)

  const summary = {
    tag,
    size,
    rounds,
    /** Rounds between the two snapshots. */
    roundsBetween: rounds - 1,
    before,
    after,
    beforeHeapMB,
    afterHeapMB,
    heapGrowthMB: afterHeapMB - beforeHeapMB,
    growthPerRoundMB: Math.round(((afterHeapMB - beforeHeapMB) / (rounds - 1)) * 100) / 100,
    /** Diagnostics only: the history is dropped at the very end of the session. */
    historyProbe: {
      cleared: historyCleared,
      heapAfterClearMB: afterClearHeapMB,
      releasedByClearingMB: afterHeapMB - afterClearHeapMB,
      interpretation:
        'releasedByClearingMB close to heapGrowthMB means the slope is retained undo history; close to 0 means the objects are pinned elsewhere'
    },
    sampling: sampling ? `phase29-heap-${tag}-sampling-${size}.json` : null,
    userAgent: await page.evaluate(() => navigator.userAgent)
  }
  fs.writeFileSync(
    path.join(reportsDir, `phase29-heap-${tag}-${size}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8'
  )
  console.log(
    `[phase29-heap] ${beforeHeapMB} → ${afterHeapMB} MB over ${rounds - 1} rounds; ` +
      `clearing history released ${summary.historyProbe.releasedByClearingMB} MB`
  )
})
