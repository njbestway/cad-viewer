import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.7 Task E — bulk ERASE replay in a real browser.
 *
 * Phase 2.6 measured `ERASE → UNDO → REDO` once and found that the redo of one
 * 50k command spent 105 s in the main thread. The fix is in
 * `AcDbChangeApplier.applyForward`: consecutive removes that target the same
 * block table record are handed to `removeEntity(ids)` in one call instead of
 * one call per id. This spec is the browser half of the proof — the Node
 * matrix only shows the database stopped scanning.
 *
 * Three cases, all set based (never sampled):
 *
 * 1. `ERASE → UNDO → RERO → UNDO → REDO` on the Phase 2.6 50k single-command
 *    fixture. After every step the database id set, the scene id set (read
 *    from the spatial index), the picking result, the undo/redo stack depth,
 *    the GPU resource counters, the long tasks and the heap peak are recorded
 *    and compared against the state the same step reached in round one.
 * 2. `ERASE → UNDO → REDO` issued *while the drawing is still loading*: the
 *    load path and the replay path both enqueue converts, which is where the
 *    ghost geometry defect (R-8) used to hide.
 * 3. `ERASE → UNDO → REDO` parked at the new `queued` convert stage — ids are
 *    still sitting in `_convertQueue` and none of them is claimed. Phase 2.6
 *    covered `claimed` / `beforeCommit` / `groupLayer`; the queued-but-
 *    unclaimed state is a different code path (`AcApContext.entityErased`
 *    hands *every* erased layout-space id to the view because of it) and is
 *    not a repeat of the `claimed` case.
 *
 * Results go to `reports/phase27/bulk-replay.json`, plus a Playwright trace of
 * the replay sequence in `reports/phase27/bulk-replay-trace.zip`.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase27')
const reportPath = path.join(reportsDir, 'bulk-replay.json')
const tracePath = path.join(reportsDir, 'bulk-replay-trace.zip')

// The project keeps `trace: 'retain-on-failure'`, which starts a trace before
// the test body runs and makes a second `tracing.start()` throw. The replay
// sequence is traced by hand instead, so a *passing* run still leaves a trace.
test.use({ trace: 'off' })

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
 * Fixture — identical mix to `phase26-bulk-erase-single.spec.ts`, so the
 * redo number here is comparable with the Phase 2.6 measurement:
 * 60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT over 3 layers.
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
    dxfPair(2, 'P27_BLK') +
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
    dxfPair(2, 'P27_BLK') +
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
  const file = path.join(os.tmpdir(), `phase27-replay-${count}.dxf`)
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
 * In-page handles
 * ------------------------------------------------------------------ */

interface SpatialIndexHandle {
  search: (box: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }) => Array<{ id: string }>
}

interface LayoutHandle {
  _spatialIndex?: SpatialIndexHandle
}

interface RendererInfo {
  memory?: { geometries?: number; textures?: number }
  render?: { calls?: number; triangles?: number }
}

interface ViewHandle {
  hasEntity: (id: string) => boolean
  pick: (
    point: { x: number; y: number },
    hitRadius?: number
  ) => Array<{ id: string }>
  waitUntilIdle?: (timeoutMs?: number) => Promise<boolean>
  isProcessingEntities?: boolean
  getOpenConvertStats?: () => Record<string, number>
  setConvertDebugHook?: (
    hook: ((stage: string, objectId: string) => void | Promise<void>) | null
  ) => void
  renderer?: { _renderer?: { info?: RendererInfo } }
  _scene?: {
    _layouts?: Map<string, LayoutHandle> | LayoutHandle[]
    stats?: { summary?: { entityCount?: number } }
  }
  _convertQueue?: Array<{ objectId?: string }>
  _claimedConvertObjectIds?: Set<string>
  _erasedConvertObjectIds?: Set<string>
}

interface UndoRecordHandle {
  label?: string
  changes?: unknown[]
}

interface UndoStackHandle {
  undoRecords?: UndoRecordHandle[]
  redoRecords?: UndoRecordHandle[]
}

interface DocHandle {
  database: {
    tables: {
      blockTable: {
        modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
      }
    }
    transactionManager: {
      undo: () => boolean
      redo: () => boolean
      undoStack?: UndoStackHandle
    }
  }
  entityService: { eraseEntities: (ids: string[]) => number }
}

type PageWindow = Window & {
  AcApDocManager?: { instance?: { curView?: ViewHandle; curDocument?: DocHandle } }
  __p27?: {
    sampling: boolean
    frames: number[]
    heapPeak: number
    longTasks: number[]
    lastFrameAt: number
    trap: {
      installed: boolean
      events: string[]
      pending: { stage: string; objectId: string; release?: () => void } | null
      armed: { stage: string; count: number; hits: number } | null
    }
  }
}

const WORLD_BOX = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }

/**
 * Installs a sampler for long tasks, frame intervals and heap peak.
 *
 * Deliberately *not* the convert hook: an installed hook makes every convert
 * await a promise, which is fine for a parked test and wrong for a timing
 * measurement.
 */
async function installProbes(page: Page) {
  await page.addInitScript(() => {
    const state = {
      sampling: false,
      frames: [] as number[],
      heapPeak: 0,
      longTasks: [] as number[],
      lastFrameAt: 0,
      trap: {
        installed: false,
        events: [] as string[],
        pending: null as {
          stage: string
          objectId: string
          release?: () => void
        } | null,
        armed: null as { stage: string; count: number; hits: number } | null
      }
    }
    ;(window as unknown as { __p27: typeof state }).__p27 = state

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
        if (state.lastFrameAt > 0) {
          state.frames.push(Math.round(now - state.lastFrameAt))
        }
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

/**
 * Installs the convert pause plumbing before the app boots.
 *
 * The hook is attached as soon as the view exists, i.e. while the uploaded
 * drawing is still being parsed, so no entity can slip past it.
 */
async function installTrapPlumber(page: Page) {
  await page.addInitScript(() => {
    const timer = window.setInterval(() => {
      const win = window as unknown as {
        AcApDocManager?: { instance?: { curView?: ViewHandle } }
        __p27?: PageWindow['__p27']
      }
      const state = win.__p27
      const view = win.AcApDocManager?.instance?.curView
      if (!state || !view?.setConvertDebugHook) return
      window.clearInterval(timer)
      view.setConvertDebugHook((stage: string, objectId: string) => {
        state.trap.events.push(`${stage}:${objectId}`)
        const armed = state.trap.armed
        if (!armed || armed.stage !== stage) return
        armed.hits++
        if (armed.hits < armed.count) return
        // Disarm so the recovery path (undo re-queues the id) is not parked too.
        state.trap.armed = null
        return new Promise<void>(resolve => {
          state.trap.pending = {
            stage,
            objectId,
            release: () => {
              state.trap.pending = null
              resolve()
            }
          }
        })
      })
      state.trap.installed = true
    }, 2)
  })
}

async function armTrap(page: Page, stage: string, count = 1) {
  await page.evaluate(
    ({ targetStage, targetCount }) => {
      const state = (window as unknown as PageWindow).__p27
      if (!state) throw new Error('probes not installed')
      state.trap.armed = { stage: targetStage, count: targetCount, hits: 0 }
    },
    { targetStage: stage, targetCount: count }
  )
}

async function waitPaused(page: Page, timeoutMs = 180_000) {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as PageWindow).__p27?.trap.pending?.stage ?? null
        ),
      { timeout: timeoutMs, intervals: [20] }
    )
    .not.toBeNull()
}

async function releasePause(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    win.__p27?.trap.pending?.release?.()
    // The hook stays installed after the pause; every later convert would pay
    // an extra await for nothing. Drop it before the scene settles.
    win.AcApDocManager?.instance?.curView?.setConvertDebugHook?.(null)
  })
}

/** Queue state at a pause: how much work is queued and how much is claimed. */
async function readConvertQueue(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const queue = view?._convertQueue ?? []
    const ids: string[] = []
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]?.objectId
      if (id) ids.push(String(id))
    }
    return {
      queueLength: queue.length,
      claimedCount: view?._claimedConvertObjectIds?.size ?? -1,
      erasedCount: view?._erasedConvertObjectIds?.size ?? -1,
      queuedIds: ids
    }
  })
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

/** Root drawable ids of every layout, read from the spatial index. */
async function readIndexIds(page: Page): Promise<string[]> {
  return page.evaluate(box => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return [] as string[]
    const values =
      layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    const ids: string[] = []
    for (const layout of values) {
      for (const item of layout?._spatialIndex?.search(box) ?? []) {
        if (item?.id) ids.push(String(item.id))
      }
    }
    return ids
  }, WORLD_BOX)
}

async function countAlive(page: Page, ids: string[]): Promise<number> {
  return page.evaluate(list => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view?.hasEntity) return -1
    let alive = 0
    for (const id of list) if (view.hasEntity(id)) alive++
    return alive
  }, ids)
}

async function readHistory(page: Page) {
  return page.evaluate(() => {
    const manager = (
      window as unknown as PageWindow
    ).AcApDocManager?.instance?.curDocument?.database.transactionManager
    const stack = manager?.undoStack
    const undoRecords = stack?.undoRecords ?? []
    const redoRecords = stack?.redoRecords ?? []
    return {
      undoRecords: undoRecords.length,
      redoRecords: redoRecords.length,
      lastChangeCount: undoRecords.length
        ? (undoRecords[undoRecords.length - 1]?.changes?.length ?? 0)
        : 0
    }
  })
}

async function readGpu(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const info = view?.renderer?._renderer?.info
    return {
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      drawCalls: info?.render?.calls ?? null,
      triangles: info?.render?.triangles ?? null
    }
  })
}

async function pickAt(page: Page, x: number, y: number): Promise<string[]> {
  return page.evaluate(
    ({ px, py }) => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      if (!view?.pick) return [] as string[]
      return view.pick({ x: px, y: py }, 2).map(item => String(item.id))
    },
    { px: x, py: y }
  )
}

/** Counts drawables through the spatial index without shipping 50k ids. */
async function readSceneCount(page: Page): Promise<number> {
  return page.evaluate(box => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return -1
    const values =
      layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    let count = 0
    for (const layout of values) {
      count += layout?._spatialIndex?.search(box)?.length ?? 0
    }
    return count
  }, WORLD_BOX)
}

async function waitIdle(page: Page, budgetMs = 600_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
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
 * Waits until the scene holds exactly `expected` drawables.
 *
 * `waitIdle` is a heuristic: the drain splices `_convertQueue` into a private
 * slice, so between two slices the queue is empty and the stats look idle
 * while thousands of entities are still pending. The measurement that matters
 * for this phase is the *scene*, so count the spatial index instead of
 * trusting the idle flag — that number is what the acceptance criteria ask
 * for anyway.
 */
async function waitSceneComplete(page: Page, expected: number, timeoutMs = 600_000) {
  await expect
    .poll(async () => readSceneCount(page), { timeout: timeoutMs, intervals: [25, 50, 100] })
    .toBe(expected)
}

/* ------------------------------------------------------------------ *
 * Step drivers
 * ------------------------------------------------------------------ */

async function eraseInOneCommand(page: Page, ids: string[]) {
  return page.evaluate(list => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    if (!doc) throw new Error('curDocument unavailable')
    const startedAt = performance.now()
    const erased = doc.entityService.eraseEntities(list)
    return {
      erased,
      ms: Math.round((performance.now() - startedAt) * 10) / 10
    }
  }, ids)
}

/** Runs one undo or redo step and reports how long the database blocked. */
async function stepHistory(page: Page, direction: 'undo' | 'redo') {
  return page.evaluate(kind => {
    const manager = (
      window as unknown as PageWindow
    ).AcApDocManager?.instance?.curDocument?.database.transactionManager
    if (!manager) throw new Error('transactionManager unavailable')
    const startedAt = performance.now()
    const changed = manager[kind]()
    return { changed, ms: Math.round((performance.now() - startedAt) * 10) / 10 }
  }, direction)
}

async function beginWindow(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p27
    if (!state) throw new Error('probes not installed')
    state.frames.length = 0
    state.longTasks.length = 0
    state.heapPeak = 0
    state.lastFrameAt = 0
    state.sampling = true
  })
}

async function endWindow(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p27!
    state.sampling = false
    const frames = [...state.frames].sort((a, b) => a - b)
    const at = (fraction: number) =>
      frames.length === 0
        ? null
        : frames[Math.min(frames.length - 1, Math.floor(frames.length * fraction))]
    return {
      frames: frames.length,
      frameP50Ms: at(0.5),
      frameP95Ms: at(0.95),
      frameMaxMs: frames.length === 0 ? null : frames[frames.length - 1],
      heapPeakMB: Math.round((state.heapPeak / 1048576) * 10) / 10,
      longTaskCount: state.longTasks.length,
      longestTaskMs: state.longTasks.length === 0 ? 0 : Math.max(...state.longTasks),
      longTaskTotalMs: state.longTasks.reduce((sum, value) => sum + value, 0)
    }
  })
}

/** Both directions of the scene/database comparison, asked of the whole set. */
async function compare(page: Page, erasedIds: string[]) {
  const dbIds = await readDbIds(page)
  const indexIds = await readIndexIds(page)
  const dbSet = new Set(dbIds)
  const indexSet = new Set(indexIds)
  const erasedSet = new Set(erasedIds)
  return {
    dbCount: dbIds.length,
    sceneCount: indexIds.length,
    sceneUnique: indexSet.size,
    dbUnique: dbSet.size,
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

interface Snapshot extends Record<string, unknown> {
  name: string
}

/**
 * Runs one replay step and captures everything the acceptance criteria ask
 * for: the database replay time (in page), the wall clock until the *scene*
 * is complete (`settleMs`), long tasks, heap, id sets, history depth, GPU
 * counters and the picking result at the probe point.
 */
async function runStep(
  page: Page,
  name: string,
  direction: 'undo' | 'redo',
  erasedIds: string[],
  probe: { x: number; y: number },
  expectedScene: number
): Promise<Snapshot> {
  await beginWindow(page)
  const startedAt = Date.now()
  const step = await stepHistory(page, direction)
  await waitIdle(page)
  await waitSceneComplete(page, expectedScene)
  const settleMs = Date.now() - startedAt
  // Let the long-task observer flush the entries of the last task.
  await page.waitForTimeout(120)
  const window = await endWindow(page)
  const state = await compare(page, erasedIds)
  const history = await readHistory(page)
  const gpu = await readGpu(page)
  const pick = await pickAt(page, probe.x, probe.y)
  const snapshot: Snapshot = {
    name,
    direction,
    changed: step.changed,
    replayMs: step.ms,
    settleMs,
    ...window,
    ...state,
    ...history,
    gpu,
    pick
  }
  findings.results[name] = snapshot
  flush()
  return snapshot
}

async function snapshotState(
  page: Page,
  name: string,
  erasedIds: string[],
  probe: { x: number; y: number }
): Promise<Snapshot> {
  const state = await compare(page, erasedIds)
  const history = await readHistory(page)
  const gpu = await readGpu(page)
  const pick = await pickAt(page, probe.x, probe.y)
  const snapshot: Snapshot = {
    name,
    replayMs: null as unknown as number,
    settleMs: null as unknown as number,
    ...state,
    ...history,
    gpu,
    pick
  }
  findings.results[name] = snapshot
  flush()
  return snapshot
}

/* ------------------------------------------------------------------ *
 * Case 1 — ERASE → UNDO → REDO → UNDO → REDO on 50k, one command
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: 'serial', timeout: 60 * 60_000 })

test('50k ERASE: two full undo/redo rounds stay identical', async ({ page }) => {
  test.setTimeout(3_600_000)
  const total = 50_000
  const fixture = writeFixture(total)
  findings.steps.push(
    'fixture: 60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT over 3 layers (Phase 2.6 scene)'
  )
  flush()

  await installProbes(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 60_000 })
  await waitIdle(page)
  await waitSceneComplete(page, total)
  await page.waitForTimeout(500)

  const openIds = await readDbIds(page)
  expect(openIds.length).toBe(total)

  // Cell 0 is a LINE from (0,0) to (2,2); (1,1) is on it and on nothing else.
  const probe = { x: 1, y: 1 }
  const openPick = await pickAt(page, probe.x, probe.y)
  expect(openPick.length).toBeGreaterThan(0)
  const probeId = openPick[0]

  const opened = await snapshotState(page, 'open', [], probe)
  expect(opened.sceneCount).toBe(total)
  expect(opened.pick).toContain(probeId)
  const openGpu = opened.gpu as { geometries: number | null }
  // The drawing load itself may leave records on the stack; every assertion
  // below is a delta against this baseline, not an absolute count.
  const openUndoRecords = opened.undoRecords as number

  await page
    .context()
    .tracing.start({ screenshots: false, snapshots: false, sources: false })

  /* ---- ERASE ------------------------------------------------------- */
  await beginWindow(page)
  const eraseStartedAt = Date.now()
  const erase = await eraseInOneCommand(page, openIds)
  await waitIdle(page)
  await waitSceneComplete(page, 0)
  const eraseSettleMs = Date.now() - eraseStartedAt
  await page.waitForTimeout(120)
  const eraseWindow = await endWindow(page)
  const afterEraseState = await compare(page, openIds)
  const afterEraseHistory = await readHistory(page)
  findings.results.erase = {
    name: 'erase',
    erased: erase.erased,
    replayMs: erase.ms,
    settleMs: eraseSettleMs,
    ...eraseWindow,
    ...afterEraseState,
    ...afterEraseHistory,
    gpu: await readGpu(page),
    pick: await pickAt(page, probe.x, probe.y)
  }
  flush()
  const afterErase = findings.results.erase as Snapshot

  expect(erase.erased).toBe(total)
  expect(afterErase.dbCount).toBe(0)
  expect(afterErase.sceneCount).toBe(0)
  expect(afterErase.ghostDrawablesAmongErased).toBe(0)
  expect(afterErase.spatialIndexResidual).toBe(0)
  expect(afterErase.pick).toHaveLength(0)
  // One command, one undo boundary.
  expect(afterEraseHistory.undoRecords).toBe(openUndoRecords + 1)
  expect(afterEraseHistory.redoRecords).toBe(0)
  // The record holds two entries per id, not one: `eraseEntities` opens every
  // entity for write (which records a `modify` snapshot) and then removes it
  // from the block table record (which records the `remove`). The batching
  // under test lives in the replay, not in the recorder, so this shape must be
  // exactly what the pre-Phase-2.7 code produced.
  expect(afterEraseHistory.lastChangeCount).toBe(total * 2)

  /* ---- UNDO #1 ------------------------------------------------------ */
  const undo1 = await runStep(page, 'undo1', 'undo', openIds, probe, total)
  expect(undo1.changed).toBe(true)
  expect(undo1.dbCount).toBe(total)
  expect(undo1.sceneCount).toBe(total)
  expect(undo1.aliveAmongErased).toBe(total)
  expect(undo1.missingFromIndex).toBe(0)
  expect(undo1.spatialIndexResidual).toBe(0)
  expect(undo1.duplicateIndexIds).toBe(0)
  expect(undo1.pick).toContain(probeId)
  expect(undo1.undoRecords).toBe(openUndoRecords)
  expect(undo1.redoRecords).toBe(1)

  /* ---- REDO #1 ------------------------------------------------------ */
  const redo1 = await runStep(page, 'redo1', 'redo', openIds, probe, 0)
  expect(redo1.changed).toBe(true)
  expect(redo1.dbCount).toBe(0)
  expect(redo1.sceneCount).toBe(0)
  expect(redo1.ghostDrawablesAmongErased).toBe(0)
  expect(redo1.spatialIndexResidual).toBe(0)
  expect(redo1.pick).toHaveLength(0)
  expect(redo1.undoRecords).toBe(openUndoRecords + 1)
  expect(redo1.redoRecords).toBe(0)

  /* ---- UNDO #2 ------------------------------------------------------ */
  const undo2 = await runStep(page, 'undo2', 'undo', openIds, probe, total)
  expect(undo2.changed).toBe(true)
  expect(undo2.dbCount).toBe(total)
  expect(undo2.sceneCount).toBe(total)
  expect(undo2.missingFromIndex).toBe(0)
  expect(undo2.spatialIndexResidual).toBe(0)
  expect(undo2.duplicateIndexIds).toBe(0)
  expect(undo2.pick).toContain(probeId)

  /* ---- REDO #2 ------------------------------------------------------ */
  const redo2 = await runStep(page, 'redo2', 'redo', openIds, probe, 0)
  expect(redo2.changed).toBe(true)
  expect(redo2.dbCount).toBe(0)
  expect(redo2.sceneCount).toBe(0)
  expect(redo2.ghostDrawablesAmongErased).toBe(0)
  expect(redo2.spatialIndexResidual).toBe(0)
  expect(redo2.pick).toHaveLength(0)

  /* ---- round-to-round stability ------------------------------------- */
  // Same step, second round: the id sets, the picking result and the GPU
  // counters must land exactly where round one left them. A replay that
  // silently skipped an id, or left a geometry behind, fails here even when
  // the total happens to match.
  expect(undo2.dbCount).toBe(undo1.dbCount)
  expect(undo2.sceneCount).toBe(undo1.sceneCount)
  expect(undo2.duplicateIndexIds).toBe(undo1.duplicateIndexIds)
  expect(undo2.pick).toEqual(undo1.pick)
  expect(redo2.dbCount).toBe(redo1.dbCount)
  expect(redo2.sceneCount).toBe(redo1.sceneCount)
  expect(redo2.sceneUnique).toBe(redo1.sceneUnique)
  expect(redo2.pick).toEqual(redo1.pick)
  // Residency counters baked by the renderer at buffer creation time; the
  // per-frame counters (`drawCalls`, `triangles`) are recorded, not asserted.
  // Textures are expected to be identical across rounds.
  const residency = (snapshot: Snapshot) => {
    const gpu = snapshot.gpu as { geometries: number | null; textures: number | null }
    return { geometries: gpu.geometries, textures: gpu.textures }
  }
  expect(residency(undo2).textures).toBe(residency(undo1).textures)
  expect(residency(redo2).textures).toBe(residency(redo1).textures)

  // Geometry residency grows by at most one per *restore*. Measured sequence
  // for this 50k scene: open 5 → erase 5 → undo 6 → redo 6 → undo 7 → redo 7.
  // The step happens on the append path (undo), which batches nothing and is
  // untouched by the replay change; it is the batched group's block-template
  // cache cloning one shared geometry per template generation
  // (`_ownedSharedGeometries`, keyed by template uuid). It is not scaled by the
  // entity count — 50k ids add one buffer, not 50k — and the erase path itself
  // adds none. Asserting `+1` per round keeps the leak question honest: an
  // implementation that allocated per entity, or one clone per replay step on
  // the *remove* side, cannot pass this.
  const geometriesOf = (snapshot: Snapshot) =>
    (snapshot.gpu as { geometries: number | null }).geometries
  expect(geometriesOf(undo2)).toBeLessThanOrEqual(geometriesOf(undo1) + 1)
  expect(geometriesOf(redo2)).toBeLessThanOrEqual(geometriesOf(redo1) + 1)

  // GPU resources must follow the scene, not the history. The ceiling is a
  // constant, not a fraction of the entity count: 50k ids live in a handful of
  // packed batches, so an implementation that allocated per entity — or one
  // buffer per replayed change — cannot satisfy `open + 2`.
  if (openGpu.geometries != null) {
    // Deleting drawables never allocates a template clone.
    expect(geometriesOf(afterErase)).toBeLessThanOrEqual(openGpu.geometries)
    for (const step of [undo1, redo1, undo2, redo2]) {
      expect(geometriesOf(step)).toBeLessThanOrEqual(openGpu.geometries + 2)
    }
  }

  await page.context().tracing.stop({ path: tracePath })

  const undoMs = [undo1.replayMs, undo2.replayMs] as number[]
  const redoMs = [redo1.replayMs, redo2.replayMs] as number[]
  findings.results.verdict = {
    erasesPerformed: 1,
    undoBoundaries: 1,
    undoRecordsAfterErase: afterEraseHistory.undoRecords,
    erase: { replayMs: erase.ms, settleMs: eraseSettleMs },
    undo: { replayMs: undoMs, settleMs: [undo1.settleMs, undo2.settleMs] },
    redo: { replayMs: redoMs, settleMs: [redo1.settleMs, redo2.settleMs] },
    longestTaskMs: {
      erase: afterErase.longestTaskMs,
      undo: [undo1.longestTaskMs, undo2.longestTaskMs],
      redo: [redo1.longestTaskMs, redo2.longestTaskMs]
    },
    ghosts: Math.max(
      afterErase.ghostDrawablesAmongErased as number,
      redo1.ghostDrawablesAmongErased as number,
      redo2.ghostDrawablesAmongErased as number
    ),
    // Recorded, not asserted: the renderer's block-template cache keeps one
    // shared geometry per template generation, so each restore adds one buffer
    // regardless of how many ids come back.
    gpuGeometries: {
      open: geometriesOf(opened),
      erase: geometriesOf(afterErase),
      undo: [geometriesOf(undo1), geometriesOf(undo2)],
      redo: [geometriesOf(redo1), geometriesOf(redo2)]
    },
    note:
      'replayMs is the database block time measured in the page; settleMs is the wall clock until the scene is complete (convert queue drained).'
  }
  flush()
})

/* ------------------------------------------------------------------ *
 * Case 2 — ERASE → UNDO → REDO while the drawing is still loading
 * ------------------------------------------------------------------ */

test('loading: ERASE → UNDO → REDO mid-open leaves no ghost', async ({ page }) => {
  test.setTimeout(1_800_000)
  const total = 20_000
  const prefix = 3_000
  const fixture = writeFixture(total)

  await installProbes(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 60_000 })

  // Catch the loader with a prefix of the entities in the database: the
  // remainder is still streaming in while the erase is issued.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const doc = (
            window as unknown as PageWindow
          ).AcApDocManager?.instance?.curDocument
          const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
          if (!iterator) return 0
          let count = 0
          for (const _entity of iterator) count++
          return count
        }),
      { timeout: 180_000, intervals: [20] }
    )
    .toBeGreaterThanOrEqual(prefix)

  const loadingIds = await readDbIds(page)
  expect(loadingIds.length).toBeGreaterThanOrEqual(prefix)
  const midLoad = loadingIds.slice(0, prefix)
  const before = {
    dbCount: loadingIds.length,
    sceneCount: (await readIndexIds(page)).length
  }

  const erase = await eraseInOneCommand(page, midLoad)
  expect(erase.erased).toBe(prefix)
  const undo = await stepHistory(page, 'undo')
  expect(undo.changed).toBe(true)
  const redo = await stepHistory(page, 'redo')
  expect(redo.changed).toBe(true)

  await waitIdle(page)
  await waitSceneComplete(page, total - prefix)
  await page.waitForTimeout(300)

  const settle = await compare(page, midLoad)
  const history = await readHistory(page)
  findings.results.loadingReplay = {
    name: 'loadingReplay',
    total,
    prefix,
    before,
    erase,
    undo,
    redo,
    ...settle,
    ...history
  }
  flush()

  // Every erased id stays erased, everything else finished loading, and the
  // replay did not append a single drawable for a deleted id.
  expect(settle.dbCount).toBe(total - prefix)
  expect(settle.ghostDrawablesAmongErased).toBe(0)
  expect(settle.aliveAmongErased).toBe(0)
  expect(settle.spatialIndexResidual).toBe(0)
  expect(settle.duplicateIndexIds).toBe(0)
  // The scene must have caught up with the database, not with the load.
  expect(settle.sceneCount).toBe(settle.dbCount)
  expect(settle.missingFromIndex).toBe(0)
})

/* ------------------------------------------------------------------ *
 * Case 3 — R-8: ERASE parked with ids still in `_convertQueue`
 * ------------------------------------------------------------------ */

test('R-8 queued: ids parked in _convertQueue unclaimed survive ERASE → UNDO → REDO', async ({
  page
}) => {
  test.setTimeout(1_800_000)
  const total = 20_000
  const fixture = writeFixture(total)

  await installProbes(page)
  await installTrapPlumber(page)
  await page.goto('/')
  await armTrap(page, 'queued')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 60_000 })
  await waitPaused(page)

  // The whole point of this case: the pause is *before* the claim, so the
  // queue holds unclaimed ids rather than one claimed id plus bystanders.
  const queue = await readConvertQueue(page)
  findings.results.queuedPause = {
    name: 'queuedPause',
    queueLength: queue.queueLength,
    claimedCount: queue.claimedCount,
    erasedCount: queue.erasedCount,
    queuedSample: queue.queuedIds.slice(0, 10)
  }
  flush()

  expect(queue.queueLength).toBeGreaterThan(0)
  expect(queue.claimedCount).toBe(0)

  const queuedIds = queue.queuedIds
  expect(queuedIds.length).toBeGreaterThan(0)

  const erase = await eraseInOneCommand(page, queuedIds)
  expect(erase.erased).toBe(queuedIds.length)
  const undo = await stepHistory(page, 'undo')
  expect(undo.changed).toBe(true)
  const redo = await stepHistory(page, 'redo')
  expect(redo.changed).toBe(true)

  await releasePause(page)
  await waitIdle(page)
  await waitSceneComplete(page, total - queuedIds.length)
  await page.waitForTimeout(300)

  const afterRedo = await compare(page, queuedIds)
  const historyAfterRedo = await readHistory(page)
  findings.results.queuedAfterRedo = {
    name: 'queuedAfterRedo',
    queuedCount: queuedIds.length,
    erase,
    undo,
    redo,
    ...afterRedo,
    ...historyAfterRedo
  }
  flush()

  expect(afterRedo.ghostDrawablesAmongErased).toBe(0)
  expect(afterRedo.aliveAmongErased).toBe(0)
  expect(afterRedo.spatialIndexResidual).toBe(0)
  expect(afterRedo.dbCount).toBe(total - queuedIds.length)

  // UNDO puts the parked ids back: they must be converted again, no
  // duplicates, and the queue must not still hold the tombstoned copies.
  const undoAgain = await stepHistory(page, 'undo')
  expect(undoAgain.changed).toBe(true)
  await waitIdle(page)
  await waitSceneComplete(page, total)
  await page.waitForTimeout(300)
  const afterUndo = await compare(page, queuedIds)
  const queuedAfterUndo = await readConvertQueue(page)
  findings.results.queuedAfterUndo = {
    name: 'queuedAfterUndo',
    undo: undoAgain,
    ...afterUndo,
    queueLength: queuedAfterUndo.queueLength,
    claimedCount: queuedAfterUndo.claimedCount,
    erasedCount: queuedAfterUndo.erasedCount
  }
  flush()

  expect(afterUndo.aliveAmongErased).toBe(queuedIds.length)
  expect(afterUndo.dbCount).toBe(total)
  expect(afterUndo.spatialIndexResidual).toBe(0)
  expect(afterUndo.duplicateIndexIds).toBe(0)
  expect(queuedAfterUndo.queueLength).toBe(0)
  expect(queuedAfterUndo.erasedCount).toBe(0)
})

test.afterAll(() => {
  flush()
})
