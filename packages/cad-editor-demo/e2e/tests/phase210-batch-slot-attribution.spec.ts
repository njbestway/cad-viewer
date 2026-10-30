import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.10 Task F1 - names the owner of the per-round heap residue.
 *
 * The snapshots say the residue is `Box3` + `_Vector3` at roughly the polylines'
 * share of the fixture, and that each `Box3` is held directly by a
 * `boundingBox` property. That is a property *name*, not an owner: several
 * structures have one. This spec reads the batch slot tables themselves, so the
 * question "is a freed slot still holding its box, or is a new slot allocated
 * every round" is answered by arithmetic instead of by another snapshot.
 *
 * Runs the same erase -> undo -> redo -> undo cycle as `phase210-heap-series`,
 * clears the history (experiment 2 proved the slope survives it) and samples:
 *
 * - `slots`: live `_geometryInfo` record count across every batch.
 * - `boxes`: how many of those records still carry a `boundingBox`.
 * - `snapshots`: records still carrying a `hiddenDrawSnapshot`.
 * - `pool`: ids sitting in `_availableGeometryIds` (freed, awaiting reuse).
 *
 * A flat `slots` with a growing `boxes` means freed records keep their box; a
 * growing `slots` with `pool` returning to zero means the slot array itself is
 * growing.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase210')

const SIZE = Number(process.env.P210S_SIZE ?? 1_000)
const ROUNDS = Number(process.env.P210S_ROUNDS ?? 6)

test.use({ trace: 'off' })
test.setTimeout(1_800_000)

type BatchLike = {
  _geometryInfo?: Array<{ boundingBox?: unknown; hiddenDrawSnapshot?: unknown; flags?: number }>
  _availableGeometryIds?: number[]
}

type SlotWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (o?: { timeoutMs?: number }) => Promise<{ ready: boolean }>
        renderer?: { _renderer?: { info?: { memory?: { geometries?: number } } } }
        _scene?: {
          _layouts?: Map<string, { _group?: unknown }>
        }
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
    const iterator = (window as unknown as SlotWindow).AcApDocManager?.instance?.curDocument
      ?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

async function drain(page: Page) {
  const result = await page.evaluate(async () => {
    const view = (window as unknown as SlotWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return { ready: Boolean(snapshot?.ready) }
  })
  expect(result.ready).toBe(true)
}

async function loadFixture(page: Page) {
  const fixture = writeMixedFixture(SIZE, `p210slot${SIZE}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
    .toBe(SIZE)
  await drain(page)
}

/**
 * Walks the scene graph instead of assuming where batches hang: the layout owns
 * a `THREE.Group`, and every batch is an `Object3D` that happens to carry a
 * `_geometryInfo` slot table.
 */
async function readSlots(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as SlotWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    let batches = 0
    let slots = 0
    let boxes = 0
    let snapshots = 0
    let pool = 0
    let arrayLength = 0
    if (layouts instanceof Map) {
      for (const layout of layouts.values()) {
        const visit = (node: unknown) => {
          const batch = node as BatchLike & { children?: unknown[]; traverse?: (fn: (o: unknown) => void) => void }
          if (Array.isArray(batch._geometryInfo)) {
            batches++
            slots += batch._geometryInfo.length
            arrayLength += batch._geometryInfo.length
            pool += batch._availableGeometryIds?.length ?? 0
            for (const info of batch._geometryInfo) {
              if (info?.boundingBox) boxes++
              if (info?.hiddenDrawSnapshot) snapshots++
            }
          }
          // Not every node is an Object3D in the test mocks; walk children when
          // present and fall back to nothing otherwise.
          for (const child of batch.children ?? []) visit(child)
        }
        visit(layout._group)
      }
    }
    return {
      batches,
      slots,
      arrayLength,
      boxes,
      snapshots,
      pool,
      geometries: view?.renderer?._renderer?.info?.memory?.geometries ?? null
    }
  })
}

async function step(page: Page, action: 'undo' | 'redo') {
  const ok = await page.evaluate(name => {
    const manager = (window as unknown as SlotWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    return name === 'undo' ? manager?.undo() : manager?.redo()
  }, action)
  expect(ok, `${action} was refused`).toBe(true)
  await drain(page)
}

/**
 * One erase -> undo -> redo -> undo cycle, sampling the slot table at the two
 * moments that separate "the free list never gets the id" from "the free list
 * gets it and the insert path ignores it": right after the erase and right
 * after the first undo that re-inserts the same entities.
 */
async function editRound(page: Page) {
  const ids = await readDbIds(page)
  const erased = await page.evaluate(list => {
    const doc = (window as unknown as SlotWindow).AcApDocManager?.instance?.curDocument
    return doc?.entityService.eraseEntities(list) ?? 0
  }, ids)
  expect(erased).toBe(ids.length)
  await drain(page)
  const afterErase = await readSlots(page)
  await step(page, 'undo')
  const afterUndo = await readSlots(page)
  await step(page, 'redo')
  await step(page, 'undo')
  return { afterErase, afterUndo }
}

test('phase 2.10 F1 batch slot attribution', async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.enable')

  await loadFixture(page)
  await cdp.send('HeapProfiler.collectGarbage')

  const rows: unknown[] = []
  for (let round = 1; round <= ROUNDS; round++) {
    const { afterErase, afterUndo } = await editRound(page)
    await page.evaluate(() => {
      const stack = (window as unknown as SlotWindow).AcApDocManager?.instance?.curDocument
        ?.database.transactionManager.undoStack
      if (stack?.undoRecords) stack.undoRecords.length = 0
      if (stack?.redoRecords) stack.redoRecords.length = 0
    })
    await cdp.send('HeapProfiler.collectGarbage')
    const slots = await readSlots(page)
    rows.push({ round, afterErase, afterUndo, endOfRound: slots })
  }

  const payload = {
    phase: '2.10',
    task: 'F1',
    generatedAt: new Date().toISOString(),
    size: SIZE,
    rounds: ROUNDS,
    note:
      'History cleared and GC forced before every sample. `slots` counts live geometry-info records; `boxes` counts those still holding a Box3.',
    rows
  }
  fs.writeFileSync(
    path.join(reportsDir, 'phase210-batch-slots.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  )
  console.log(`[phase210-slots] ${JSON.stringify(rows)}`)
})
