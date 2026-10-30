import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.10 Task E3 - browser A/B of Transaction Snapshot Sharing.
 *
 * The same fixture, the same single-transaction MOVE, the same undo/redo, run
 * twice on one page lifecycle: once with `transactionManager.snapshotSharing`
 * off (the 3N baseline) and once with it on (2N). Arms are interleaved per
 * sample and the order flips every sample so a drifting machine cannot favour
 * one arm.
 *
 * Two things this spec refuses to conflate:
 *
 * - The transaction numbers (`editMs`, `undoMs`, `redoMs`, clone counters) are
 *   the sharing effect.
 * - `settleMs` / `readyWaitMs` are the render-convert cost, which sharing does
 *   not touch. They are reported next to the transaction numbers, never folded
 *   into them.
 *
 * Run against both bundles:
 *   npx playwright test e2e/tests/phase210-browser-ab.spec.ts            # dev
 *   $env:P210AB_MODE='prod'; npx playwright test -c playwright.prod.config.ts \
 *     e2e/tests/phase210-browser-ab.spec.ts                              # prod
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase210')

const MODE = (process.env.P210AB_MODE ?? 'dev').replace(/[^\w.-]/g, '_')
const SIZES = (process.env.P210AB_SIZES ?? '1000,10000')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)
const SAMPLES = Number(process.env.P210AB_SAMPLES ?? 3)
const MOVE_DX = 25
const MOVE_DY = 15

test.use({ trace: 'off' })
test.setTimeout(3_600_000)

interface Metrics {
  openedForWrite: number
  uniqueModifiedObjects: number
  rollbackSnapshotClones: number
  beforeSnapshotClones: number
  afterSnapshotClones: number
  sharedBeforeSnapshotCount: number
  copyOnWriteCount: number
  snapshotBytesEstimated: number
  openForWriteMs: number
  recordModifyMs: number
  transformMs: number
  finalizeMs: number
  commitMs: number
  undoMs: number
  redoMs: number
  abortMs: number
  retainedUndoChanges: number
  retainedSnapshotBytesEstimated: number
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (o?: { timeoutMs?: number }) => Promise<{ ready: boolean }>
        getSharedBatchMetrics?: () => Record<string, number>
        getSharedBatchEntries?: () => unknown[]
      }
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            snapshotSharing?: boolean
            undo: () => boolean
            redo: () => boolean
            getSnapshotSharingMetrics?: () => Metrics
            undoStack?: { undoRecords?: unknown[]; redoRecords?: unknown[] }
          }
          runDatabaseEdit: (label: string, fn: () => void) => void
        }
        entityService: {
          getEntitiesByIds: (ids: string[]) => unknown[]
          translateEntities: (
            entities: unknown[],
            displacement: { x: number; y: number; z: number }
          ) => number
        }
      }
    }
  }
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const iterator = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

async function loadFixture(page: Page, size: number) {
  const fixture = writeMixedFixture(size, `p210ab${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [250] })
    .toBe(size)
  // Diagnostics travel with the assertion: a prod bundle that hides the view
  // handle fails here, and the message has to say so instead of "false".
  const readiness = await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: (snapshot as { reasons?: string[] } | undefined)?.reasons,
      hasManager: Boolean((window as unknown as PageWindow).AcApDocManager?.instance),
      hasView: Boolean(view),
      hasWait: typeof view?.waitUntilSceneReady
    }
  })
  expect(readiness.ready, JSON.stringify(readiness)).toBe(true)
}

async function waitReady(page: Page) {
  const started = Date.now()
  const ready = await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return Boolean(snapshot?.ready)
  })
  expect(ready).toBe(true)
  return Date.now() - started
}

/** One arm: MOVE in a single transaction, then undo, then redo. */
async function runArm(page: Page, size: number, sharing: boolean) {
  await loadFixture(page, size)
  const ids = await readDbIds(page)

  const configured = await page.evaluate(enabled => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    if (!manager || typeof manager.snapshotSharing !== 'boolean') return false
    manager.snapshotSharing = enabled
    return manager.snapshotSharing === enabled
  }, sharing)
  expect(configured, 'transactionManager.snapshotSharing is not toggleable').toBe(true)

  const before = await page.evaluate(() => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    return {
      metrics: manager?.getSnapshotSharingMetrics?.() ?? null,
      batchEntries:
        (window as unknown as PageWindow).AcApDocManager?.instance?.curView
          ?.getSharedBatchEntries?.().length ?? -1
    }
  })
  if (!before.metrics) {
    throw new Error('getSnapshotSharingMetrics() is missing from the shipped data-model build')
  }

  const move = await page.evaluate(
    ({ list, dx, dy }) => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const startedAt = performance.now()
      doc.database.runDatabaseEdit('phase210-move', () => {
        const entities = doc.entityService.getEntitiesByIds(list)
        doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
      })
      return Math.round((performance.now() - startedAt) * 10) / 10
    },
    { list: ids, dx: MOVE_DX, dy: MOVE_DY }
  )

  const settleMs = await waitReady(page)

  const undone = await page.evaluate(() => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    const startedAt = performance.now()
    const ok = manager?.undo() ?? false
    return { ok, ms: Math.round((performance.now() - startedAt) * 10) / 10 }
  })
  expect(undone.ok).toBe(true)
  await waitReady(page)

  const redone = await page.evaluate(() => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    const startedAt = performance.now()
    const ok = manager?.redo() ?? false
    return { ok, ms: Math.round((performance.now() - startedAt) * 10) / 10 }
  })
  expect(redone.ok).toBe(true)
  await waitReady(page)

  const after = await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const manager = win.AcApDocManager?.instance?.curDocument?.database.transactionManager
    const stack = manager?.undoStack
    return {
      metrics: manager?.getSnapshotSharingMetrics?.() ?? null,
      batchEntries: win.AcApDocManager?.instance?.curView?.getSharedBatchEntries?.().length ?? -1,
      batchMetrics: win.AcApDocManager?.instance?.curView?.getSharedBatchMetrics?.() ?? {},
      undoRecords: (stack?.undoRecords ?? []).length,
      redoRecords: (stack?.redoRecords ?? []).length
    }
  })

  const delta: Partial<Record<keyof Metrics, number>> = {}
  for (const key of Object.keys(after.metrics ?? {}) as Array<keyof Metrics>) {
    const start = before.metrics[key]
    const end = after.metrics[key]
    if (typeof start === 'number' && typeof end === 'number') delta[key] = end - start
  }

  return {
    sharing,
    entities: ids.length,
    editMs: move,
    settleMs,
    undoMs: undone.ms,
    undoMsMeasuredByKernel: delta.undoMs ?? null,
    redoMs: redone.ms,
    redoMsMeasuredByKernel: delta.redoMs ?? null,
    undoRecords: after.undoRecords,
    redoRecords: after.redoRecords,
    batchEntriesBefore: before.batchEntries,
    batchEntriesAfter: after.batchEntries,
    batchMetrics: after.batchMetrics,
    /** Counters this run performed, i.e. the arm's 3N / 2N evidence. */
    clones: {
      uniqueModifiedObjects: delta.uniqueModifiedObjects ?? null,
      rollbackSnapshotClones: delta.rollbackSnapshotClones ?? null,
      beforeSnapshotClones: delta.beforeSnapshotClones ?? null,
      afterSnapshotClones: delta.afterSnapshotClones ?? null,
      sharedBeforeSnapshotCount: delta.sharedBeforeSnapshotCount ?? null,
      copyOnWriteCount: delta.copyOnWriteCount ?? null
    },
    kernelMs: {
      openForWriteMs: delta.openForWriteMs ?? null,
      recordModifyMs: delta.recordModifyMs ?? null,
      commitMs: delta.commitMs ?? null,
      finalizeMs: delta.finalizeMs ?? null
    },
    retained: {
      undoChanges: after.metrics?.retainedUndoChanges ?? null,
      snapshotBytes: after.metrics?.retainedSnapshotBytesEstimated ?? null
    }
  }
}

/** Median of a numeric column; `values` shorter than one is not expected. */
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10
    : sorted[middle]
}

function summarise(runs: Array<{ sharing: boolean } & Record<string, unknown>>) {
  const rows = runs as unknown as Array<{
    sharing: boolean
    editMs: number
    settleMs: number
    undoMs: number
    redoMs: number
    clones: Record<string, number>
    kernelMs: Record<string, number>
  }>
  const pick = (arm: boolean) => rows.filter(row => row.sharing === arm)
  const column = (arm: boolean, key: 'editMs' | 'settleMs' | 'undoMs' | 'redoMs') =>
    median(pick(arm).map(row => row[key]))
  const cloneCount = (arm: boolean, key: string) =>
    median(pick(arm).map(row => row.clones[key] ?? 0))
  const kernel = (arm: boolean, key: string) =>
    median(pick(arm).map(row => row.kernelMs[key] ?? 0))

  const off = pick(false).length
    ? {
        editMs: column(false, 'editMs'),
        settleMs: column(false, 'settleMs'),
        undoMs: column(false, 'undoMs'),
        redoMs: column(false, 'redoMs'),
        clones: {
          rollbackSnapshotClones: cloneCount(false, 'rollbackSnapshotClones'),
          beforeSnapshotClones: cloneCount(false, 'beforeSnapshotClones'),
          afterSnapshotClones: cloneCount(false, 'afterSnapshotClones'),
          sharedBeforeSnapshotCount: cloneCount(false, 'sharedBeforeSnapshotCount'),
          copyOnWriteCount: cloneCount(false, 'copyOnWriteCount'),
          total: cloneCount(false, 'rollbackSnapshotClones') +
            cloneCount(false, 'beforeSnapshotClones') +
            cloneCount(false, 'afterSnapshotClones')
        },
        kernel: {
          openForWriteMs: kernel(false, 'openForWriteMs'),
          recordModifyMs: kernel(false, 'recordModifyMs'),
          commitMs: kernel(false, 'commitMs')
        }
      }
    : null
  const on = pick(true).length
    ? {
        editMs: column(true, 'editMs'),
        settleMs: column(true, 'settleMs'),
        undoMs: column(true, 'undoMs'),
        redoMs: column(true, 'redoMs'),
        clones: {
          rollbackSnapshotClones: cloneCount(true, 'rollbackSnapshotClones'),
          beforeSnapshotClones: cloneCount(true, 'beforeSnapshotClones'),
          afterSnapshotClones: cloneCount(true, 'afterSnapshotClones'),
          sharedBeforeSnapshotCount: cloneCount(true, 'sharedBeforeSnapshotCount'),
          copyOnWriteCount: cloneCount(true, 'copyOnWriteCount'),
          total: cloneCount(true, 'rollbackSnapshotClones') +
            cloneCount(true, 'beforeSnapshotClones') +
            cloneCount(true, 'afterSnapshotClones')
        },
        kernel: {
          openForWriteMs: kernel(true, 'openForWriteMs'),
          recordModifyMs: kernel(true, 'recordModifyMs'),
          commitMs: kernel(true, 'commitMs')
        }
      }
    : null

  const change = (a: number | undefined, b: number | undefined) =>
    a && b ? Math.round(((b - a) / a) * 1000) / 10 : null

  return {
    off,
    on,
    deltaPercent: {
      editMs: change(off?.editMs, on?.editMs),
      settleMs: change(off?.settleMs, on?.settleMs),
      undoMs: change(off?.undoMs, on?.undoMs),
      redoMs: change(off?.redoMs, on?.redoMs),
      totalClones: change(off?.clones.total, on?.clones.total)
    }
  }
}

test('phase 2.10 E3 browser A/B', async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const outputPath = path.join(reportsDir, 'phase210-browser-ab.json')
  const existing = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : { phase: '2.10', task: 'E3', modes: {} }

  const sizes: Record<string, unknown> = {}
  for (const size of SIZES) {
    const runs: unknown[] = []
    for (let sample = 0; sample < SAMPLES; sample++) {
      // Flip the order every sample: a machine that warms up or throttles mid
      // run would otherwise bias the arm that always runs first.
      const order = sample % 2 === 0 ? [false, true] : [true, false]
      for (const sharing of order) {
        runs.push(await runArm(page, size, sharing))
      }
    }
    const rows = runs as Array<{ sharing: boolean } & Record<string, unknown>>
    sizes[String(size)] = {
      size,
      samples: SAMPLES,
      userAgent: await page.evaluate(() => navigator.userAgent),
      runs,
      summary: summarise(rows)
    }
    console.log(
      `[phase210-ab] ${MODE} ${size}: ${JSON.stringify(sizes[String(size)].summary)}`
    )
  }

  existing.modes[MODE] = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    // Merged per size so a 50k-only rerun does not drop the 1k/10k rows.
    sizes: { ...(existing.modes[MODE]?.sizes ?? {}), ...sizes },
    note:
      'A/B of transaction snapshot sharing on the same page lifecycle. `editMs`/`undoMs`/`redoMs` are the sharing effect; `settleMs` is render-convert cost and is not part of it.'
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
})
