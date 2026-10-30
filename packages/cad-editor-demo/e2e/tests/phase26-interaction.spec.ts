import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.6 Task D3 — interactive cost of a real 50k MOVE in a browser.
 *
 * The Node benchmark (`phase26-v2.bench.ts`) measures the transaction and the
 * view layer in isolation. Neither can answer the question the SPEC actually
 * asks: how long does the main thread block while a user commits a 50k MOVE,
 * and what does the conversion queue cost afterwards on a real WebGL renderer?
 *
 * This spec measures, for one MOVE command with one undo boundary:
 *
 * - `commitMs` — the synchronous `runDatabaseEdit` window (this is the block);
 * - `longestTaskMs` — largest `longtask` entry observed across the commit;
 * - `queueSettleMs` — from commit end to `getOpenConvertStats()` idle;
 * - `frame` — rAF intervals during commit + settle (p50 / p95 / max);
 * - `heapPeakMB` — peak `performance.memory.usedJSHeapSize` during the window;
 * - five MOVE / UNDO / REDO rounds for stability.
 *
 * Results go to `reports/phase26/browser-interaction.json`.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase26')
const reportPath = path.join(reportsDir, 'browser-interaction.json')

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
 * Fixture: 60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT over 3 layers
 *
 * Layer layout is the product case: every drawable of a layer shares one
 * material, which is what allows one batched container per layer. Text keeps a
 * small glyph path in the mix so the measurement is not a pure linework case.
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
    dxfPair(2, 'P26I_BLK') +
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
    dxfPair(2, 'P26I_BLK') +
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

/** Writes the interaction fixture; cells are 3x3 so picking stays exact. */
function writeFixture(count: number): string {
  const parts: string[] = []
  for (let index = 0; index < count; index++) {
    const x = (index % 100) * 3
    const y = Math.floor(index / 100) * 3
    const kind = index % 10
    if (kind < 6) parts.push(dxfLine(x, y, x + 2, y + 2, 'LINES'))
    else if (kind < 8) parts.push(dxfPolyline(x, y, 2))
    else if (kind === 8) parts.push(dxfInsert(x, y))
    else parts.push(dxfText(x, y, `T${index}`))
  }
  const file = path.join(os.tmpdir(), `phase26-interaction-${count}.dxf`)
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
  __p26i?: {
    sampling: boolean
    frames: number[]
    heapPeak: number
    longTasks: number[]
    lastFrameAt: number
  }
}

/** Long tasks + rAF sampling + heap peak, installed before the app boots. */
async function installProbes(page: Page) {
  await page.addInitScript(() => {
    const state = {
      sampling: false,
      frames: [] as number[],
      heapPeak: 0,
      longTasks: [] as number[],
      lastFrameAt: 0
    }
    ;(window as unknown as { __p26i: typeof state }).__p26i = state

    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) state.longTasks.push(Math.round(entry.duration))
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is not observable everywhere; the field stays empty.
    }

    const tick = (now: number) => {
      if (state.sampling) {
        if (state.lastFrameAt > 0) state.frames.push(Math.round(now - state.lastFrameAt))
        state.lastFrameAt = now
        const memory = (performance as unknown as {
          memory?: { usedJSHeapSize: number }
        }).memory
        if (memory && memory.usedJSHeapSize > state.heapPeak) {
          state.heapPeak = memory.usedJSHeapSize
        }
      } else {
        state.lastFrameAt = 0
      }
      window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  })
}

interface Stats {
  pendingEntityUpdates?: number
  pendingEntities?: number
  convertQueued?: number
  deferredActive?: number
  pendingGeometryJobs?: number
  [key: string]: number | undefined
}

async function resetSampling(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p26i
    if (!state) throw new Error('probes not installed')
    state.frames.length = 0
    state.longTasks.length = 0
    state.heapPeak = 0
    state.lastFrameAt = 0
    state.sampling = true
  })
}

async function stopSampling(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p26i!
    state.sampling = false
    const frames = [...state.frames].sort((a, b) => a - b)
    const at = (fraction: number) =>
      frames.length === 0 ? null : frames[Math.min(frames.length - 1, Math.floor(frames.length * fraction))]
    return {
      frames: frames.length,
      frameP50Ms: at(0.5),
      frameP95Ms: at(0.95),
      frameMaxMs: frames.length === 0 ? null : frames[frames.length - 1],
      heapPeakMB: Math.round((state.heapPeak / 1048576) * 10) / 10,
      longTaskCount: state.longTasks.length,
      longestTaskMs: state.longTasks.length === 0 ? 0 : Math.max(...state.longTasks)
    }
  })
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curDocument as
      | {
          database: {
            tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
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

async function readSceneIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as
      | {
          _scene?: {
            _layouts?: Map<string, { _spatialIndex?: { search: (box: unknown) => Array<{ id: string }> } }>
          }
        }
      | undefined
    const layouts = view?._scene?._layouts
    if (!layouts) return []
    const box = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }
    const ids: string[] = []
    for (const layout of layouts.values()) {
      const items = layout._spatialIndex?.search(box) ?? []
      for (const item of items) if (item?.id) ids.push(String(item.id))
    }
    return ids
  })
}

async function readStats(page: Page): Promise<Stats> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as
      | { getOpenConvertStats?: () => Stats; isProcessingEntities?: boolean }
      | undefined
    const stats: Stats = { ...(view?.getOpenConvertStats?.() ?? {}) }
    stats.busy = (view?.isProcessingEntities ? 1 : 0) as unknown as number
    return stats
  })
}

async function waitIdle(page: Page, budgetMs = 300_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance
      ?.curView as
      | {
          waitUntilIdle?: (ms?: number) => Promise<boolean>
          isProcessingEntities?: boolean
          getOpenConvertStats?: () => Stats
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
 * Moves `ids` in one user command.
 *
 * `runDatabaseEdit` opens the undo mark and the transaction; the service opens
 * each entity for write and transforms it. Nothing is batched, so this is a
 * single 50k transaction and a single undo boundary — the case D1/D2 ask for.
 */
async function moveInOneCommand(page: Page, ids: string[], dx: number, dy: number) {
  return page.evaluate(
    ({ list, offsetX, offsetY }) => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance
        ?.curDocument as
        | {
            database: { runDatabaseEdit: (label: string, fn: () => void) => void }
            entityService: {
              getEntitiesByIds: (ids: string[]) => unknown[]
              translateEntities: (
                entities: unknown[],
                displacement: { x: number; y: number; z: number }
              ) => number
            }
          }
        | undefined
      if (!doc) throw new Error('curDocument unavailable')
      let moved = 0
      const startedAt = performance.now()
      doc.database.runDatabaseEdit('phase26-move', () => {
        const entities = doc.entityService.getEntitiesByIds(list)
        moved = doc.entityService.translateEntities(entities, {
          x: offsetX,
          y: offsetY,
          z: 0
        })
      })
      return {
        moved,
        commitMs: Math.round((performance.now() - startedAt) * 10) / 10
      }
    },
    { list: ids, offsetX: dx, offsetY: dy }
  )
}

async function undoOnce(page: Page) {
  return page.evaluate(() =>
    Boolean(
      (
        window as unknown as PageWindow
      ).AcApDocManager?.instance?.curDocument &&
        (
          (window as unknown as PageWindow).AcApDocManager!.instance!
            .curDocument as { database: { transactionManager: { undo: () => boolean } } }
        ).database.transactionManager.undo()
    )
  )
}

async function redoOnce(page: Page) {
  return page.evaluate(() =>
    Boolean(
      (
        window as unknown as PageWindow
      ).AcApDocManager?.instance?.curDocument &&
        (
          (window as unknown as PageWindow).AcApDocManager!.instance!
            .curDocument as { database: { transactionManager: { redo: () => boolean } } }
        ).database.transactionManager.redo()
    )
  )
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: 'serial', timeout: 30 * 60_000 })

test('50k MOVE: main-thread block, queue settle, frames, memory, stability', async ({
  page
}) => {
  test.setTimeout(1_800_000)
  const total = 50_000
  const fixture = writeFixture(total)

  findings.steps.push(
    'fixture: 60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT over 3 layers (product material strategy)'
  )
  flush()

  await installProbes(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 60_000 })
  await waitIdle(page)
  await page.waitForTimeout(500)

  const dbIds = await readDbIds(page)
  expect(dbIds.length).toBe(total)

  /* ---- one 50k MOVE ------------------------------------------------ */
  await resetSampling(page)
  const move = await moveInOneCommand(page, dbIds, 10, 10)
  const statsAfterCommit = await readStats(page)
  const settleStartedAt = Date.now()
  await waitIdle(page)
  const queueSettleMs = Date.now() - settleStartedAt
  await page.waitForTimeout(400)
  const samples = await stopSampling(page)

  const sceneIds = await readSceneIds(page)
  const dbSet = new Set(dbIds)
  const residual = sceneIds.filter(id => !dbSet.has(id))
  const missing = dbIds.filter(id => !sceneIds.includes(id))

  findings.results.move50k = {
    entityCount: total,
    moved: move.moved,
    commitMs: move.commitMs,
    queueSettleMs,
    queueDepthAfterCommit: {
      pendingEntityUpdates: statsAfterCommit.pendingEntityUpdates ?? null,
      pendingEntities: statsAfterCommit.pendingEntities ?? null,
      convertQueued: statsAfterCommit.convertQueued ?? null,
      deferredActive: statsAfterCommit.deferredActive ?? null
    },
    ...samples,
    sceneEntityCount: sceneIds.length,
    expectedSceneEntityCount: dbIds.length,
    spatialIndexResidual: residual.length,
    missingFromIndex: missing.length
  }
  flush()

  expect(move.moved).toBe(total)
  expect(residual).toEqual([])
  expect(missing).toEqual([])
  expect(sceneIds.length).toBe(dbIds.length)
  // The commit is synchronous; the SPEC asks for this number explicitly.
  findings.results.blockingVerdict = {
    commitMs: move.commitMs,
    nearSecond: move.commitMs >= 900,
    note:
      move.commitMs >= 900
        ? 'The synchronous part of a 50k MOVE is still near or above one second; see the report for the proposed split.'
        : 'The synchronous part of a 50k MOVE stays below one second in this run.'
  }
  flush()

  /* ---- five MOVE / UNDO / REDO rounds ------------------------------ */
  const rounds: Array<Record<string, unknown>> = []
  for (let round = 1; round <= 5; round++) {
    const ids = await readDbIds(page)
    const next = await moveInOneCommand(page, ids, 5, 5)
    await waitIdle(page)
    expect((await undoOnce(page)).valueOf()).toBe(true)
    await waitIdle(page)
    expect((await redoOnce(page)).valueOf()).toBe(true)
    await waitIdle(page)

    const idsAfter = await readDbIds(page)
    const sceneAfter = await readSceneIds(page)
    const sceneSet = new Set(sceneAfter)
    rounds.push({
      round,
      moved: next.moved,
      commitMs: next.commitMs,
      dbCount: idsAfter.length,
      sceneCount: sceneAfter.length,
      missingFromScene: idsAfter.filter(id => !sceneSet.has(id)).length,
      residual: sceneAfter.filter(id => !idsAfter.includes(id)).length
    })
    expect(idsAfter.length).toBe(total)
    expect(sceneAfter.length).toBe(total)
  }

  findings.results.stability = rounds
  findings.results.stabilityVerdict = {
    rounds: rounds.length,
    maxCommitMs: Math.max(...rounds.map(entry => Number(entry.commitMs))),
    failures: rounds.filter(
      entry => Number(entry.missingFromScene) !== 0 || Number(entry.residual) !== 0
    ).length
  }
  flush()

  expect(findings.results.stabilityVerdict).toMatchObject({ failures: 0 })
})

test.afterAll(() => {
  flush()
})
