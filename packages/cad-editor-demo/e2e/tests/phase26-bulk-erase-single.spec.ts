import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.6 Task D1 — 50k ERASE as one user command.
 *
 * The Phase 2.5 benchmarks never proved command atomicity for a bulk erase:
 * `eraase-50k` was 200 transactions of 256 entities and the browser case was 10
 * transactions of 2k. Ten undo records that each restore a slice is a different
 * guarantee from one undo record that restores everything.
 *
 * This spec issues the erase the way a command does — `eraseEntities()` with the
 * whole selection, which opens its own undo mark because no transaction is
 * active — and then asserts the three states end to end:
 *
 *   after ERASE   database 0, scene 0, spatial index 0
 *   after UNDO×1  database 50k, scene 50k, no ghost, no residual, no duplicate
 *   after REDO×1  database 0, scene 0, spatial index 0, still no ghost
 *
 * The ghost question is asked of the *complete* erased id list, not a sample,
 * and in both directions (scene ⊄ database and database ⊄ scene), so "one ghost
 * added, one legal entity dropped" cannot pass.
 *
 * Results go to `reports/phase26/bulk-erase-single.json`.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase26')
const reportPath = path.join(reportsDir, 'bulk-erase-single.json')

interface Findings {
  results: Record<string, unknown>
  steps: string[]
}

const findings: Findings = { results: {}, steps: [] }

function flush() {
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Fixture — same mix as `phase26-interaction.spec.ts` so the two
 * measurements describe the same scene: 60% LINE / 20% LWPOLYLINE /
 * 10% INSERT / 10% TEXT over 3 layers.
 * ------------------------------------------------------------------ */

function dxfPair(code: number, value: string | number) {
  return `${code}\n${value}\n`
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer: string) {
  return (
    dxfPair(0, 'LINE') +
    dxfPair(8, layer) +
    dxfPair(10, x1) +
    dxfPair(20, y1) +
    dxfPair(30, 0) +
    dxfPair(11, x2) +
    dxfPair(21, y2) +
    dxfPair(31, 0)
  )
}

function dxfPolyline(originX: number, originY: number, size: number) {
  return (
    dxfPair(0, 'LWPOLYLINE') +
    dxfPair(8, 'LINES') +
    dxfPair(90, 4) +
    dxfPair(70, 1) +
    dxfPair(10, originX) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY + size) +
    dxfPair(10, originX) +
    dxfPair(20, originY + size)
  )
}

function dxfInsert(x: number, y: number) {
  return (
    dxfPair(0, 'INSERT') +
    dxfPair(8, 'MARKS') +
    dxfPair(2, 'P26E_BLK') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0)
  )
}

function dxfText(x: number, y: number, value: string) {
  return (
    dxfPair(0, 'TEXT') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0) +
    dxfPair(40, 2) +
    dxfPair(1, value)
  )
}

function dxfHead() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'HEADER') +
    dxfPair(9, '$ACADVER') +
    dxfPair(1, 'AC1015') +
    dxfPair(0, 'ENDSEC') +
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'TABLES') +
    dxfPair(0, 'TABLE') +
    dxfPair(2, 'LAYER') +
    dxfPair(70, 3) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, '0') +
    dxfPair(70, 0) +
    dxfPair(62, 7) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'LINES') +
    dxfPair(70, 0) +
    dxfPair(62, 3) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'MARKS') +
    dxfPair(70, 0) +
    dxfPair(62, 5) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'ENDTAB') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfBlocks() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'BLOCKS') +
    dxfPair(0, 'BLOCK') +
    dxfPair(8, '0') +
    dxfPair(2, 'P26E_BLK') +
    dxfPair(70, 0) +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(30, 0) +
    dxfLine(0, 0, 2, 2, 'LINES') +
    dxfPair(0, 'ENDBLK') +
    dxfPair(8, '0') +
    dxfPair(0, 'ENDSEC')
  )
}

/** Writes the erase fixture; cells are 3x3 so picking stays exact. */
function writeFixture(count: number): string {
  const parts: string[] = []
  for (let index = 0; index < count; index++) {
    const x = (index % 100) * 3
    const y = Math.floor(index / 100) * 3
    const kind = index % 10
    if (kind < 6) parts.push(dxfLine(x, y, x + 2, y + 2, 'LINES'))
    else if (kind < 8) parts.push(dxfPolyline(x, y, 2))
    else if (kind === 8) parts.push(dxfInsert(x, y))
    else parts.push(dxfText(x, y, `E${index}`))
  }
  const file = path.join(os.tmpdir(), `phase26-erase-${count}.dxf`)
  fs.writeFileSync(
    file,
    dxfHead() +
      dxfBlocks() +
      dxfPair(0, 'SECTION') +
      dxfPair(2, 'ENTITIES') +
      parts.join('') +
      dxfPair(0, 'ENDSEC') +
      dxfPair(0, 'EOF'),
    'utf8'
  )
  return file
}

/* ------------------------------------------------------------------ *
 * In-page probes
 * ------------------------------------------------------------------ */

type PageWindow = Window & {
  AcApDocManager?: { instance?: Record<string, unknown> }
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curDocument as
      | {
          database: {
            tables: {
              blockTable: {
                modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
              }
            }
          }
        }
      | undefined
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return []
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

/** Root drawable ids of every layout, read from the spatial index. */
async function readIndexIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as
      | {
          _scene?: {
            _layouts?: Map<
              string,
              { _spatialIndex?: { search: (box: unknown) => Array<{ id: string }> } }
            >
          }
        }
      | undefined
    const layouts = view?._scene?._layouts
    if (!layouts) return []
    const box = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
    const ids: string[] = []
    for (const layout of layouts.values()) {
      for (const item of layout._spatialIndex?.search(box) ?? []) {
        if (item?.id) ids.push(String(item.id))
      }
    }
    return ids
  })
}

/** Does the view still hold a drawable for `objectId`? */
async function countAlive(page: Page, ids: string[]): Promise<number> {
  return page.evaluate(list => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as { hasEntity?: (id: string) => boolean } | undefined
    if (!view?.hasEntity) return -1
    let alive = 0
    for (const id of list) if (view.hasEntity(id)) alive++
    return alive
  }, ids)
}

/**
 * Waits until the spatial index reports `expected` root drawables.
 *
 * `waitIdle()` can return before the first convert batch has started (every
 * counter is zero at that instant), so a fixed delay after it samples a
 * half-converted scene and turns a load race into a fake "missing entity".
 * Polling keeps the assertion exact — the full set still has to arrive — while
 * removing the arbitrary instant, and it measures how long the tail took.
 *
 * @returns Milliseconds spent after `waitIdle()` until the index was complete
 */
async function waitIndexCount(page: Page, expected: number, timeoutMs = 300_000) {
  const startedAt = Date.now()
  await expect
    .poll(async () => (await readIndexIds(page)).length, {
      timeout: timeoutMs,
      intervals: [50, 100, 250, 500]
    })
    .toBe(expected)
  return Date.now() - startedAt
}

async function waitIdle(page: Page, budgetMs = 600_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as
      | {
          waitUntilIdle?: (ms?: number) => Promise<boolean>
          isProcessingEntities?: boolean
          getOpenConvertStats?: () => Record<string, number>
        }
      | undefined
    if (!view) throw new Error('curView unavailable')
    if (view.waitUntilIdle) await view.waitUntilIdle(budget)
    const deadline = performance.now() + budget
    let idleStreak = 0
    while (idleStreak < 2 && performance.now() < deadline) {
      const stats = view.getOpenConvertStats?.() ?? {}
      const busy =
        Boolean(view.isProcessingEntities) ||
        (stats.pendingEntityUpdates ?? 0) > 0 ||
        (stats.pendingEntities ?? 0) > 0 ||
        (stats.convertQueued ?? 0) > 0 ||
        (stats.deferredActive ?? 0) > 0 ||
        (stats.pendingGeometryJobs ?? 0) > 0
      idleStreak = busy ? 0 : idleStreak + 1
      if (idleStreak >= 2) break
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
    return idleStreak >= 2
  }, budgetMs)
}

/**
 * Erases `ids` the way a command does.
 *
 * `eraseEntities` is called without an open transaction, so it opens its own
 * undo mark: one command, one undo boundary. Wrapping it in `runDatabaseEdit`
 * would nest a second mark and is exactly the split-command shape this test
 * exists to rule out.
 */
async function eraseInOneCommand(page: Page, ids: string[]) {
  return page.evaluate(list => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curDocument as
      | {
          entityService: { eraseEntities: (ids: string[]) => number }
        }
      | undefined
    if (!doc) throw new Error('curDocument unavailable')
    const startedAt = performance.now()
    const erased = doc.entityService.eraseEntities(list)
    return { erased, eraseMs: Math.round((performance.now() - startedAt) * 10) / 10 }
  }, ids)
}

/** Runs one undo or redo step and reports how long it blocked. */
async function stepHistory(page: Page, direction: 'undo' | 'redo') {
  return page.evaluate(kind => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curDocument as
      | { database: { transactionManager: Record<string, () => boolean> } }
      | undefined
    if (!doc) throw new Error('curDocument unavailable')
    const manager = doc.database.transactionManager
    const startedAt = performance.now()
    const changed = manager[kind]()
    return { changed, ms: Math.round((performance.now() - startedAt) * 10) / 10 }
  }, direction)
}

/** Compares the view against the database in both directions. */
async function compare(page: Page, erasedIds: string[]) {
  const dbIds = await readDbIds(page)
  const indexIds = await readIndexIds(page)
  const dbSet = new Set(dbIds)
  const indexSet = new Set(indexIds)
  const erasedSet = new Set(erasedIds)
  return {
    dbCount: dbIds.length,
    sceneCount: indexIds.length,
    duplicateIndexIds: indexIds.length - indexSet.size,
    // In the index but not in the database.
    spatialIndexResidual: indexIds.filter(id => !dbSet.has(id)).length,
    // In the database but not rendered.
    missingFromIndex: dbIds.filter(id => !indexSet.has(id)).length,
    // The ghost question, asked of every erased id rather than a sample.
    ghostDrawablesAmongErased: indexIds.filter(id => erasedSet.has(id)).length,
    aliveAmongErased: await countAlive(page, erasedIds)
  }
}

/* ------------------------------------------------------------------ *
 * Case
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 })

test('50k ERASE: one command, one undo boundary, one redo boundary', async ({ page }) => {
  test.setTimeout(1_800_000)
  const total = 50_000
  const fixture = writeFixture(total)

  findings.steps.push(
    'fixture: 60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT over 3 layers (same scene as phase26-interaction)'
  )
  flush()

  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 60_000 })
  await waitIdle(page)
  const loadSettleMs = await waitIndexCount(page, total)
  findings.steps.push(`load: index reached ${total} in ${loadSettleMs} ms after waitUntilIdle()`)
  flush()

  const dbIds = await readDbIds(page)
  expect(dbIds.length).toBe(total)
  const opened = await compare(page, [])
  expect(opened.sceneCount).toBe(total)

  /* ---- one ERASE command ------------------------------------------- */
  const erase = await eraseInOneCommand(page, dbIds)
  expect(erase.erased).toBe(total)
  await waitIdle(page)
  const afterErase = await compare(page, dbIds)
  findings.results.afterErase = { eraseMs: erase.eraseMs, erased: erase.erased, ...afterErase }
  flush()

  expect(afterErase.dbCount).toBe(0)
  expect(afterErase.sceneCount).toBe(0)
  expect(afterErase.ghostDrawablesAmongErased).toBe(0)
  expect(afterErase.spatialIndexResidual).toBe(0)

  /* ---- one UNDO restores everything --------------------------------- */
  const undo = await stepHistory(page, 'undo')
  expect(undo.changed).toBe(true)
  await waitIdle(page)
  const afterUndo = await compare(page, dbIds)
  findings.results.afterUndo = { undoMs: undo.ms, ...afterUndo }
  flush()

  expect(afterUndo.dbCount).toBe(total)
  expect(afterUndo.sceneCount).toBe(total)
  // Inverse of the erase: *every* erased id must be drawable again, exactly
  // once. `ghostDrawablesAmongErased` is the same measurement as after the
  // erase, read against a state where the expected value is `total`.
  expect(afterUndo.ghostDrawablesAmongErased).toBe(total)
  expect(afterUndo.spatialIndexResidual).toBe(0)
  expect(afterUndo.missingFromIndex).toBe(0)
  expect(afterUndo.duplicateIndexIds).toBe(0)

  /* ---- one REDO erases everything again ----------------------------- */
  const redo = await stepHistory(page, 'redo')
  expect(redo.changed).toBe(true)
  await waitIdle(page)
  const afterRedo = await compare(page, dbIds)
  findings.results.afterRedo = { redoMs: redo.ms, ...afterRedo }
  flush()

  expect(afterRedo.dbCount).toBe(0)
  expect(afterRedo.sceneCount).toBe(0)
  expect(afterRedo.ghostDrawablesAmongErased).toBe(0)
  expect(afterRedo.spatialIndexResidual).toBe(0)

  findings.results.verdict = {
    singleCommand: true,
    undoBoundaries: 1,
    eraseMs: erase.eraseMs,
    undoMs: undo.ms,
    redoMs: redo.ms,
    ghostsAcrossAllStates: Math.max(
      afterErase.ghostDrawablesAmongErased,
      afterRedo.ghostDrawablesAmongErased
    ),
    restoredByOneUndo: afterUndo.ghostDrawablesAmongErased,
    note:
      undo.ms > 0 && redo.ms > 10 * undo.ms
        ? 'Redo of one bulk erase is an order of magnitude slower than undo; see STRUCTURAL_INDEX_STRESS_REPORT.md §3.'
        : 'Undo and redo are within the same order of magnitude.'
  }
  flush()
})

test.afterAll(() => {
  flush()
})
