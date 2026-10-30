import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.11 Task D/E — packed-slot lifecycle in a real browser.
 *
 * `phase210-batch-slot-attribution` proved the slot table grew by one record per
 * entity per round and that the free list was empty at every sample. It could
 * not say why: `_geometryInfo.length` and `_availableGeometryIds.length` are
 * both numbers, and a number cannot name the pass that dropped the id. Task B
 * answered that in source (`optimize()` cleared the pool and never filtered the
 * table) and Task C fixed it, so this spec has to prove three things the node
 * suite cannot:
 *
 *  1. The fix holds on a real drawing: capacity converges after warm-up instead
 *     of tracking the round count, and every reused slot is clean.
 *  2. Nothing else grew: shared batches, renderer geometries, scene objects and
 *     the database / scene / spatial-index id sets still agree round after
 *     round, including on 10k and 50k single-command ERASE and MOVE.
 *  3. The metadata that is *not* observable from a counter — stale boxes, stale
 *     hidden snapshots, ids in the pool twice — is zero, not "small".
 *
 * The measurement reads the slot tables themselves and cross-checks the sum
 * against `view.getSlotLifecycleMetrics()`, so a batch that falls out of the
 * scene walk cannot quietly shrink the total.
 *
 * Size / rounds are per-run so one matrix can be assembled from several runs:
 *
 *   $env:P211_SIZE='1000'; $env:P211_ROUNDS='100'
 *   $env:P211_OPS='erase,move'; $env:P211_SESSIONS='3'; $env:P211_TAG='k1'
 *   npx playwright test e2e/tests/phase211-slot-lifecycle.spec.ts
 *
 * Rows are merged into `reports/phase211/phase211-slot-lifecycle.json` keyed by
 * `tag/size/rounds/op/session`, so rerunning one cell never drops the others.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase211')

const SIZE = Number(process.env.P211_SIZE ?? 1_000)
const ROUNDS = Number(process.env.P211_ROUNDS ?? 100)
const SESSIONS = Number(process.env.P211_SESSIONS ?? 1)
const OPS = (process.env.P211_OPS ?? 'erase,move')
  .split(',')
  .map(value => value.trim())
  .filter((value): value is 'erase' | 'move' => value === 'erase' || value === 'move')
const TAG = (process.env.P211_TAG ?? 'run').replace(/[^\w.-]/g, '_')
/** Cleared per round so the heap slope is not dominated by retained history. */
const CLEAR_HISTORY = (process.env.P211_CLEAR_HISTORY ?? '1') !== '0'
/** MB per round a warmed-up session may still gain before it needs a heap diff. */
const HEAP_DRIFT_LIMIT_MB = Number(process.env.P211_HEAP_DRIFT_MB ?? 0.5)
/** `default` keeps the shipped setting; `on`/`off` force one arm of the A/B. */
const SHARING = (process.env.P211_SHARING ?? 'default').toLowerCase()
/**
 * Rounds whose post-GC sample also gets a V8 heap snapshot, e.g. `'10,100'`.
 * Empty by default: a full snapshot costs ~10 s on a 50k fixture and the point
 * of the pair is a retainer diff, so it is opt-in per run.
 */
const SNAPSHOT_ROUNDS = new Set(
  (process.env.P211_SNAPSHOT_ROUNDS ?? '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0)
)

test.use({ trace: 'off' })
test.setTimeout(3_600_000)
// Sessions measure the same machine; parallel sessions measure the scheduler.
test.describe.configure({ mode: 'serial' })

/** Phase 2.10's measured pre-fix slope, kept as the contrast value. */
const PHASE210_SLOTS_PER_ROUND = 1_800

interface SlotTableSample {
  allocatedSlots: number
  slotCapacity: number
  liveSlots: number
  freedSlots: number
  reusedSlots: number
  freeListSize: number
  freeListPushCount: number
  freeListPopCount: number
  deleteGeometryCalls: number
  deleteGeometrySkipped: number
  duplicateFreeAttempts: number
  liveBoundingBoxes: number
  inactiveBoundingBoxes: number
  retainedHiddenSnapshots: number
  slotHighWaterMark: number
  batchCount: number
  /** Pool entries that are duplicated, out of range or still active. */
  invalidSlots: number
  /** Non-zero when a freed record still holds a draw snapshot. */
  hiddenSnapshots: number
  /** Sum from `view.getSlotLifecycleMetrics()`, for the cross-check. */
  groupSlotCapacity: number
  batchIdsWithInvalidSlots: string[]
}

interface WorldSample {
  slots: SlotTableSample
  heapMB: number
  heapPeakMB: number
  renderer: { geometries: number | null; textures: number | null; programs: number | null }
  geometryBytes: number
  object3dNodes: number
  layoutGeometries: number
  renderables: number
  shared: Record<string, number>
  sharedSummary: { count: number; live: number; slots: number; empty: number }
  longestTaskMs: number | null
  longTaskCount: number
  history: { undo: number; redo: number; retainedChanges: number }
  ids: {
    db: number
    scene: number
    sceneUnique: number
    index: number
    missingFromScene: number
    residualInScene: number
    missingFromIndex: number
    residualInIndex: number
    hash: string
    sceneSource: string
    samples: { missing: string[]; residual: string[]; index: string[] }
  }
  convert: {
    queued: number
    claimed: number
    erasedTombstones: number
    generations: number
    stale: Record<string, number>
  }
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: Record<string, unknown>
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            undo: () => boolean
            redo: () => boolean
            undoStack?: { undoRecords?: unknown[]; redoRecords?: unknown[] }
          }
          runDatabaseEdit: (label: string, fn: () => void) => void
        }
        entityService: {
          eraseEntities: (ids: string[]) => number
          getEntitiesByIds: (ids: string[]) => unknown[]
          translateEntities: (
            entities: unknown[],
            displacement: { x: number; y: number; z: number }
          ) => number
        }
      }
    }
  }
  __p211LongTasks?: number[]
  __p211HeapPeak?: number
}

/**
 * Installs the long-task observer and a heap-peak sampler before the app boots.
 *
 * The peak sampler is a `requestAnimationFrame` loop reading
 * `performance.memory`, which Chromium exposes with coarse granularity; it is
 * reported as a peak *trend*, never as an exact allocation size.
 */
async function installObservers(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __p211LongTasks?: number[]
      __p211HeapPeak?: number
    }
    win.__p211LongTasks = []
    win.__p211HeapPeak = 0
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          win.__p211LongTasks!.push(Math.round(entry.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is Chromium-only; a missing observer must not fail the run.
    }
    const sample = () => {
      const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
      const used = perf.memory?.usedJSHeapSize ?? 0
      if (used > (win.__p211HeapPeak ?? 0)) win.__p211HeapPeak = used
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

/**
 * Reads the slot tables, the resource counters and the three id sets.
 *
 * `hashIds` is FNV-1a over the sorted id list, so "the set came back" is a
 * single comparable string instead of fifty thousand transfers per round.
 */
async function readWorld(page: Page): Promise<WorldSample> {
  return page.evaluate(() => {
    const hashIds = (ids: string[]) => {
      let hash = 0x811c9dc5
      for (let index = 0; index < ids.length; index++) {
        const value = ids[index]
        for (let cursor = 0; cursor < value.length; cursor++) {
          hash ^= value.charCodeAt(cursor)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
        hash ^= 0x2c
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return `${hash.toString(16)}:${ids.length}`
    }
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView as
      | Record<string, unknown>
      | undefined
    const doc = win.AcApDocManager?.instance?.curDocument
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }

    // ---- slot tables ------------------------------------------------------
    const totals = {
      allocatedSlots: 0,
      slotCapacity: 0,
      liveSlots: 0,
      freedSlots: 0,
      reusedSlots: 0,
      freeListSize: 0,
      freeListPushCount: 0,
      freeListPopCount: 0,
      deleteGeometryCalls: 0,
      deleteGeometrySkipped: 0,
      duplicateFreeAttempts: 0,
      liveBoundingBoxes: 0,
      inactiveBoundingBoxes: 0,
      retainedHiddenSnapshots: 0,
      slotHighWaterMark: 0,
      batchCount: 0,
      invalidSlots: 0,
      hiddenSnapshots: 0
    }
    const offenders: string[] = []
    const layouts = (view as { _scene?: { _layouts?: Map<string, unknown> } })?._scene
      ?._layouts
    const layoutValues =
      layouts instanceof Map ? Array.from(layouts.values()) : layouts ? Array.from(layouts as unknown as unknown[]) : []

    const visit = (node: unknown) => {
      const batch = node as {
        id?: number
        _geometryInfo?: Array<{
          flags?: number
          boundingBox?: unknown
          hiddenDrawSnapshot?: unknown
          slotGeneration?: number
        }>
        _availableGeometryIds?: number[]
        getSlotLifecycleMetrics?: () => Record<string, number>
        children?: unknown[]
      }
      if (Array.isArray(batch._geometryInfo)) {
        totals.batchCount++
        const table = batch._geometryInfo
        const pool = batch._availableGeometryIds ?? []
        const metrics =
          typeof batch.getSlotLifecycleMetrics === 'function'
            ? batch.getSlotLifecycleMetrics()
            : null
        if (metrics) {
          totals.allocatedSlots += metrics.allocatedSlots ?? 0
          totals.liveSlots += metrics.liveSlots ?? 0
          totals.freedSlots += metrics.freedSlots ?? 0
          totals.reusedSlots += metrics.reusedSlots ?? 0
          totals.freeListSize += metrics.freeListSize ?? 0
          totals.freeListPushCount += metrics.freeListPushCount ?? 0
          totals.freeListPopCount += metrics.freeListPopCount ?? 0
          totals.deleteGeometryCalls += metrics.deleteGeometryCalls ?? 0
          totals.deleteGeometrySkipped += metrics.deleteGeometrySkipped ?? 0
          totals.duplicateFreeAttempts += metrics.duplicateFreeAttempts ?? 0
          totals.liveBoundingBoxes += metrics.liveBoundingBoxes ?? 0
          totals.inactiveBoundingBoxes += metrics.inactiveBoundingBoxes ?? 0
          totals.retainedHiddenSnapshots += metrics.retainedHiddenSnapshots ?? 0
          totals.slotHighWaterMark = Math.max(
            totals.slotHighWaterMark,
            metrics.slotHighWaterMark ?? 0,
            table.length
          )
        } else {
          // Fallback for a container that predates the counters: `Active` is bit 0.
          let live = 0
          let boxes = 0
          for (const slot of table) {
            if (((slot.flags ?? 0) & 1) === 1) live++
            if (slot.boundingBox) boxes++
          }
          totals.allocatedSlots += table.length
          totals.liveSlots += live
          totals.freedSlots += table.length - live
          totals.freeListSize += pool.length
          totals.liveBoundingBoxes += boxes
          totals.slotHighWaterMark = Math.max(totals.slotHighWaterMark, table.length)
        }
        totals.slotCapacity += table.length
        totals.hiddenSnapshots += table.filter(slot => slot?.hiddenDrawSnapshot).length
        // Invariants the fix has to hold: the pool may not contain an id twice,
        // an id that is out of range, or an id whose slot is still active.
        const seen = new Set<number>()
        let invalid = 0
        for (const id of pool) {
          if (!Number.isInteger(id) || id < 0 || id >= table.length) invalid++
          else if (seen.has(id)) invalid++
          else if (((table[id]?.flags ?? 0) & 1) === 1) invalid++
          seen.add(id)
        }
        for (let id = 0; id < table.length; id++) {
          const slot = table[id]
          if (!slot || ((slot.flags ?? 0) & 1) === 1) continue
          if (slot.boundingBox) invalid++
          if (slot.hiddenDrawSnapshot) invalid++
        }
        if (invalid > 0) {
          totals.invalidSlots += invalid
          if (offenders.length < 8) offenders.push(`${batch.id ?? '?'}:${invalid}`)
        }
      }
      for (const child of batch.children ?? []) visit(child)
    }
    for (const layout of layoutValues) {
      const root = (layout as { _group?: unknown })?._group
      if (root) visit(root)
    }
    const groupMetrics = (
      view as { getSlotLifecycleMetrics?: () => Record<string, number> }
    )?.getSlotLifecycleMetrics?.()

    // ---- renderer / scene resources --------------------------------------
    const info = (view as { renderer?: { _renderer?: { info?: Record<string, unknown> } } })
      ?.renderer?._renderer?.info as
      | {
          memory?: { geometries?: number; textures?: number }
          programs?: unknown[]
        }
      | undefined
    const geometrySet = new Set<unknown>()
    let object3dNodes = 0
    let renderables = 0
    for (const layout of layoutValues) {
      ;(layout as { _group?: { traverse: (fn: (node: unknown) => void) => void } })?._group?.traverse(
        node => {
          object3dNodes++
          const drawable = node as {
            isMesh?: boolean
            isLine?: boolean
            isPoints?: boolean
            geometry?: {
              attributes?: Record<string, { array?: { byteLength?: number } } | undefined>
            }
          }
          if (!drawable.isMesh && !drawable.isLine && !drawable.isPoints) return
          renderables++
          if (drawable.geometry) geometrySet.add(drawable.geometry)
        }
      )
    }
    let geometryBytes = 0
    for (const geometry of geometrySet) {
      const attributes = (geometry as { attributes?: Record<string, { array?: { byteLength?: number } }> })
        .attributes
      for (const attribute of Object.values(attributes ?? {})) {
        geometryBytes += attribute?.array?.byteLength ?? 0
      }
    }

    const shared = ((view as { getSharedBatchMetrics?: () => Record<string, number> })
      .getSharedBatchMetrics?.() ?? {}) as Record<string, number>
    const sharedEntries =
      (view as { getSharedBatchEntries?: () => Array<{ liveInstances: number; slotCapacity: number }> })
        .getSharedBatchEntries?.() ?? []

    // ---- id sets ----------------------------------------------------------
    const dbIds: string[] = []
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (iterator) {
      for (const entity of iterator) dbIds.push(String(entity.objectId))
    }
    const sceneIds: string[] = []
    let sceneSource = 'collectObjectIds'
    for (const layout of layoutValues) {
      const collect = (layout as { collectObjectIds?: () => Set<string> }).collectObjectIds
      if (typeof collect === 'function') {
        for (const id of collect.call(layout)) sceneIds.push(String(id))
        continue
      }
      sceneSource = 'layerEntitiesMap'
      const layers = (layout as { _layers?: Map<string, { _group?: { _entitiesMap?: Map<string, unknown> } }> })
        ._layers
      for (const layer of layers?.values?.() ?? []) {
        for (const id of layer?._group?._entitiesMap?.keys?.() ?? []) sceneIds.push(String(id))
      }
    }
    const indexIds: string[] = []
    for (const layout of layoutValues) {
      const index = (layout as {
        _spatialIndex?: { search: (box: Record<string, number>) => Array<{ id: string }> }
      })._spatialIndex
      for (const item of index?.search?.({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }) ?? []) {
        indexIds.push(String(item.id))
      }
    }
    const dbSet = new Set(dbIds)
    const sceneSet = new Set(sceneIds)
    const indexSet = new Set(indexIds)
    const missing = dbIds.filter(id => !sceneSet.has(id))
    const residual = sceneIds.filter(id => !dbSet.has(id))
    const missingIndex = sceneIds.filter(id => !indexSet.has(id))
    const residualIndex = indexIds.filter(id => !sceneSet.has(id))

    const stack = doc?.database.transactionManager.undoStack
    const undoRecords = (stack?.undoRecords ?? []) as Array<{ changes?: unknown[] }>
    const redoRecords = (stack?.redoRecords ?? []) as Array<{ changes?: unknown[] }>
    const sum = (records: Array<{ changes?: unknown[] }>) =>
      records.reduce((total, record) => total + (record.changes?.length ?? 0), 0)
    const longTasks = win.__p211LongTasks ?? []

    return {
      slots: {
        ...totals,
        groupSlotCapacity: Number(groupMetrics?.slotCapacity ?? -1),
        batchIdsWithInvalidSlots: offenders
      },
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      heapPeakMB: Math.round(((win.__p211HeapPeak ?? 0) / 1024 / 1024) * 10) / 10,
      renderer: {
        geometries: info?.memory?.geometries ?? null,
        textures: info?.memory?.textures ?? null,
        programs: info?.programs?.length ?? null
      },
      geometryBytes,
      object3dNodes,
      layoutGeometries: geometrySet.size,
      renderables,
      shared,
      sharedSummary: {
        count: sharedEntries.length,
        live: sharedEntries.reduce((total, entry) => total + entry.liveInstances, 0),
        slots: sharedEntries.reduce((total, entry) => total + entry.slotCapacity, 0),
        empty: sharedEntries.filter(entry => entry.liveInstances === 0).length
      },
      longestTaskMs: longTasks.length > 0 ? Math.max(...longTasks) : null,
      longTaskCount: longTasks.length,
      history: {
        undo: undoRecords.length,
        redo: redoRecords.length,
        retainedChanges: sum(undoRecords) + sum(redoRecords)
      },
      ids: {
        db: dbIds.length,
        scene: sceneIds.length,
        sceneUnique: sceneSet.size,
        index: indexSet.size,
        missingFromScene: missing.length,
        residualInScene: residual.length,
        missingFromIndex: missingIndex.length,
        residualInIndex: residualIndex.length,
        hash: hashIds([...new Set(dbIds)].sort()),
        sceneSource,
        samples: {
          missing: missing.slice(0, 5),
          residual: residual.slice(0, 5),
          index: missingIndex.slice(0, 5)
        }
      },
      convert: {
        queued: ((view as { _convertQueue?: unknown[] })._convertQueue ?? []).length,
        claimed: ((view as { _claimedConvertObjectIds?: Set<string> })._claimedConvertObjectIds ?? new Set())
          .size,
        erasedTombstones: (
          (view as { _erasedConvertObjectIds?: Set<string> })._erasedConvertObjectIds ?? new Set()
        ).size,
        generations: (
          (view as { _entityConvertGeneration?: Map<string, number> })._entityConvertGeneration ??
          new Map()
        ).size,
        stale: {
          ...((view as { _staleConvertRejections?: Record<string, number> })
            ._staleConvertRejections ?? {})
        }
      }
    }
  })
}

/** Waits until the scene is complete and reports how long it took. */
async function drain(page: Page, budgetMs = 900_000) {
  return page.evaluate(async budget => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView as unknown as {
      waitUntilSceneReady?: (options?: { timeoutMs?: number }) => Promise<{
        ready: boolean
        reasons?: string[]
      }>
    }
    const started = performance.now()
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: budget })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: (snapshot?.reasons ?? []) as string[],
      readyAfterMs: Math.round(performance.now() - started)
    }
  }, budgetMs)
}

async function resetObservers(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    win.__p211LongTasks = []
    win.__p211HeapPeak = 0
  })
}

/** Reads the database id list; the page-side walk stays for the full set. */
async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const iterator = win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

/** Cell 0 of the mixed fixture is a LINE from (0,0) to (2,2). */
const PROBE = { x: 1, y: 1 }

async function pickAt(page: Page, point: { x: number; y: number }): Promise<number> {
  return page.evaluate(probe => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView as unknown as {
      pick?: (point: { x: number; y: number }, radius?: number) => unknown[]
    }
    return view?.pick?.(probe, 2).length ?? -1
  }, point)
}

async function step(page: Page, action: 'undo' | 'redo') {
  const result = await page.evaluate(name => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager
    const started = performance.now()
    const ok = name === 'undo' ? manager?.undo() : manager?.redo()
    return { ok, ms: Math.round((performance.now() - started) * 10) / 10 }
  }, action)
  expect(result.ok, `${action} was refused`).toBe(true)
  return result.ms
}

async function clearHistory(page: Page) {
  return page.evaluate(() => {
    const stack = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      ?.database.transactionManager.undoStack
    const undo = stack?.undoRecords?.length ?? 0
    const redo = stack?.redoRecords?.length ?? 0
    if (stack?.undoRecords) stack.undoRecords.length = 0
    if (stack?.redoRecords) stack.redoRecords.length = 0
    return { undo, redo }
  })
}

async function expectIdCount(page: Page, expected: number, timeoutMs = 900_000) {
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: timeoutMs, intervals: [100, 250, 500] })
    .toBe(expected)
}

/** Band statistics of the last `window` rounds after a warm-up. */
function band(samples: Array<Record<string, number>>, key: string, windowSize = 10, warmup = 3) {
  const start = Math.max(warmup, samples.length - windowSize)
  const values = samples.slice(start).map(sample => Number(sample[key] ?? 0))
  if (values.length === 0) return { first: 0, last: 0, min: 0, max: 0, driftPerRound: 0 }
  const first = values[0]
  const last = values[values.length - 1]
  return {
    first: Math.round(first * 100) / 100,
    last: Math.round(last * 100) / 100,
    min: Math.round(Math.min(...values) * 100) / 100,
    max: Math.round(Math.max(...values) * 100) / 100,
    driftPerRound:
      Math.round(((last - first) / Math.max(1, values.length - 1)) * 100) / 100
  }
}

/** Merges one measured cell into the shared report, keyed by its parameters. */
function writeReport(cell: Record<string, unknown>) {
  fs.mkdirSync(reportsDir, { recursive: true })
  const outputPath = path.join(reportsDir, 'phase211-slot-lifecycle.json')
  const existing: { cells: Array<Record<string, unknown>>; generatedAt?: string } = fs.existsSync(
    outputPath
  )
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : { phase: '2.11', task: 'E', cells: [] as Array<Record<string, unknown>> }
  const keyOf = (item: Record<string, unknown>) =>
    `${item.tag}/${item.size}/${item.rounds}/${item.op}/${item.session}`
  const key = keyOf(cell)
  existing.cells = existing.cells.filter(item => keyOf(item) !== key)
  existing.cells.push(cell)
  existing.cells.sort((left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.key).localeCompare(String(right.key))
  )
  existing.generatedAt = new Date().toISOString()
  fs.writeFileSync(outputPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}

/** Writes a full V8 heap snapshot for retainer-path analysis (`P211_SNAPSHOT_ROUNDS`). */
async function takeHeapSnapshot(cdp: CDPSession, file: string) {
  const chunks: string[] = []
  const onChunk = (event: { chunk: string }) => chunks.push(event.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, chunks.join(''), 'utf8')
  return { file: path.basename(file), bytes: fs.statSync(file).size }
}

/**
 * One `ERASE | MOVE → Undo → Redo` round, sampled after a forced GC.
 *
 * History is cleared before the sample (phase 2.10 experiment 2 proved the slot
 * slope is independent of it), so the heap delta can be attributed to scene
 * state rather than to the undo stack.
 */
async function runRound(
  page: Page,
  cdp: CDPSession,
  op: 'erase' | 'move',
  ids: string[],
  offset: { x: number; y: number },
  probe: { x: number; y: number }
) {
  await resetObservers(page)
  const expectedAfterOp = op === 'erase' ? 0 : ids.length
  const syncMs = await page.evaluate(
    ({ kind, list, dx, dy }) => {
      const win = window as unknown as PageWindow
      const doc = win.AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const started = performance.now()
      if (kind === 'erase') {
        doc.entityService.eraseEntities(list)
      } else {
        doc.database.runDatabaseEdit('phase211-round-move', () => {
          const entities = doc.entityService.getEntitiesByIds(list)
          doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
        })
      }
      return Math.round((performance.now() - started) * 10) / 10
    },
    { kind: op, list: ids, dx: offset.x, dy: offset.y }
  )
  const afterOp = await drain(page)
  expect(afterOp.ready, `after ${op}: ${afterOp.reasons.join(',')}`).toBe(true)
  await expectIdCount(page, expectedAfterOp)

  const undoMs = await step(page, 'undo')
  const afterUndo = await drain(page)
  expect(afterUndo.ready, `after undo: ${afterUndo.reasons.join(',')}`).toBe(true)
  await expectIdCount(page, ids.length)
  const pickCount = await pickAt(page, probe)

  const redoMs = await step(page, 'redo')
  const afterRedo = await drain(page)
  expect(afterRedo.ready, `after redo: ${afterRedo.reasons.join(',')}`).toBe(true)
  await expectIdCount(page, expectedAfterOp)
  // Back to the pre-round state so the next round starts where this one did.
  await step(page, 'undo')
  const restored = await drain(page)
  expect(restored.ready, `after redo-undo: ${restored.reasons.join(',')}`).toBe(true)
  await expectIdCount(page, ids.length)

  const history = CLEAR_HISTORY ? await clearHistory(page) : { undo: -1, redo: -1 }
  await cdp.send('HeapProfiler.collectGarbage')
  const world = await readWorld(page)
  return {
    syncMs,
    undoMs,
    redoMs,
    settleMs: afterOp.readyAfterMs + afterUndo.readyAfterMs + afterRedo.readyAfterMs + restored.readyAfterMs,
    readyAfterMs: afterOp.readyAfterMs,
    pickCount,
    historyCleared: history,
    world
  }
}

for (let session = 1; session <= SESSIONS; session++) {
  for (const op of OPS) {
    test(`phase 2.11 slot convergence: ${ROUNDS} × ${op} on ${SIZE} (session ${session}/${SESSIONS})`, async ({
      page
    }) => {
      const fixture = writeMixedFixture(SIZE, `p211slot${SIZE}`)
      await installObservers(page)
      await page.goto('/')
      await uploadFixture(page, fixture)
      await expectIdCount(page, SIZE)
      const initial = await drain(page)
      expect(initial.ready, `initial readiness: ${initial.reasons.join(',')}`).toBe(true)

      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.enable')
      const ids = await readDbIds(page)
      // Force one arm of the A/B when asked; otherwise the shipped default runs.
      const sharing = await page.evaluate(arm => {
        const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
          ?.database.transactionManager as unknown as { snapshotSharing?: boolean } | undefined
        if (arm === 'default' || !manager) return arm === 'default' ? 'default' : 'unavailable'
        if (typeof manager.snapshotSharing !== 'boolean') return 'unavailable'
        manager.snapshotSharing = arm === 'on'
        return manager.snapshotSharing === (arm === 'on') ? arm : 'unavailable'
      }, SHARING)
      expect(sharing, 'transactionManager.snapshotSharing is not toggleable').not.toBe('unavailable')
      const idsHash = (await readWorld(page)).ids.hash

      const rows: Array<Record<string, number>> = []
      const raw: unknown[] = []
      const snapshots: Array<{ round: number; file: string; bytes: number }> = []

      for (let round = 1; round <= ROUNDS; round++) {
        // A fixed displacement, undone at the end of every round: the session is
        // long, but the drawing stays inside the view it opened with, so a pick
        // failure means a stale slot rather than an entity dragged out of frame.
        const offset = op === 'move' ? { x: 25, y: 15 } : { x: 0, y: 0 }
        const probe = { x: PROBE.x, y: PROBE.y }
        const result = await runRound(page, cdp, op, ids, offset, probe)
        const { world } = result
        const row = {
          round,
          heapMB: world.heapMB,
          heapPeakMB: world.heapPeakMB,
          slotCapacity: world.slots.slotCapacity,
          liveSlots: world.slots.liveSlots,
          freedSlots: world.slots.freedSlots,
          reusedSlots: world.slots.reusedSlots,
          allocatedSlots: world.slots.allocatedSlots,
          freeListSize: world.slots.freeListSize,
          invalidSlots: world.slots.invalidSlots,
          inactiveBoundingBoxes: world.slots.inactiveBoundingBoxes,
          retainedHiddenSnapshots: world.slots.retainedHiddenSnapshots,
          hiddenSnapshots: world.slots.hiddenSnapshots,
          liveBoundingBoxes: world.slots.liveBoundingBoxes,
          deleteGeometryCalls: world.slots.deleteGeometryCalls,
          deleteGeometrySkipped: world.slots.deleteGeometrySkipped,
          duplicateFreeAttempts: world.slots.duplicateFreeAttempts,
          slotHighWaterMark: world.slots.slotHighWaterMark,
          batches: world.slots.batchCount,
          geometries: world.renderer.geometries ?? -1,
          layoutGeometries: world.layoutGeometries,
          object3dNodes: world.object3dNodes,
          geometryBytes: world.geometryBytes,
          activeSharedBatches: world.shared.activeBatches ?? -1,
          emptySharedBatches: world.shared.emptyBatches ?? -1,
          activeInstances: world.shared.activeInstances ?? -1,
          undoRecords: world.history.undo,
          redoRecords: world.history.redo,
          syncMs: result.syncMs,
          undoMs: result.undoMs,
          redoMs: result.redoMs,
          settleMs: result.settleMs,
          readyAfterMs: result.readyAfterMs,
          longestTaskMs: world.longestTaskMs ?? -1,
          pickCount: result.pickCount,
          db: world.ids.db,
          scene: world.ids.scene,
          index: world.ids.index,
          missingFromScene: world.ids.missingFromScene,
          residualInScene: world.ids.residualInScene,
          missingFromIndex: world.ids.missingFromIndex,
          residualInIndex: world.ids.residualInIndex
        }
        rows.push(row)
        raw.push({ ...row, ids: world.ids, slots: world.slots, convert: world.convert })
        if (SNAPSHOT_ROUNDS.has(round)) {
          const file = path.join(reportsDir, `phase211-heap-${TAG}-${SIZE}-${op}-r${round}.heapsnapshot`)
          const written = await takeHeapSnapshot(cdp, file)
          snapshots.push({ round, ...written })
          console.log(`[phase211] heap snapshot r${round}: ${written.file} ${written.bytes} B`)
        }
        if (round === 1 || round === ROUNDS || round % 10 === 0) {
          console.log(
            `[phase211] ${TAG} ${SIZE} ${op} s${session} r${round}: ` +
              `slots ${row.slotCapacity} live ${row.liveSlots} free ${row.freeListSize} ` +
              `reused ${row.reusedSlots} heap ${row.heapMB}MB`
          )
        }
      }

      // ---- verdicts -------------------------------------------------------
      const capacity = band(rows, 'slotCapacity')
      const live = band(rows, 'liveSlots')
      const allocated = band(rows, 'allocatedSlots')
      const heap = band(rows, 'heapMB')
      const geometries = band(rows, 'geometries')
      const object3d = band(rows, 'object3dNodes')
      const capacityAllowance = Math.max(2, Math.ceil(capacity.first * 0.01))
      const allocatedAllowance = Math.max(4, Math.ceil(allocated.first * 0.01))

      const restoreState = { x: PROBE.x, y: PROBE.y }
      const restoredPick = await pickAt(page, restoreState)
      // An empty shared batch is retained for the 500 ms grace period on purpose
      // (ERASE empties it, Undo refills it one wave later). Force the grace to
      // elapse, then judge the settled scene rather than whichever window the
      // run happened to end in.
      await page.evaluate(() => {
        const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView as unknown as {
          sweepEmptySharedBatches?: (graceMs?: number) => unknown
        }
        view?.sweepEmptySharedBatches?.(0)
      })
      const finalWorld = await readWorld(page)

      const cell = {
        key: `${TAG}/${SIZE}/${ROUNDS}/${op}/${session}`,
        tag: TAG,
        size: SIZE,
        rounds: ROUNDS,
        op,
        session,
        sessions: SESSIONS,
        clearHistory: CLEAR_HISTORY,
        sharing,
        fixture: path.basename(fixture),
        chrome: await page.evaluate(() => navigator.userAgent),
        hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
        idsHash,
        snapshots,
        convergence: {
          capacity,
          live,
          allocated,
          heap,
          geometries,
          object3d,
          /** Phase 2.10 measured +1800 slots/round on this fixture. */
          phase210SlotsPerRound: PHASE210_SLOTS_PER_ROUND,
          capacityPerRound:
            Math.round(((capacity.last - capacity.first) / Math.max(1, rows.length - 4)) * 100) / 100
        },
        final: {
          slots: finalWorld.slots,
          heapMB: finalWorld.heapMB,
          renderer: finalWorld.renderer,
          shared: finalWorld.shared,
          sharedSummary: finalWorld.sharedSummary,
          ids: finalWorld.ids,
          convert: finalWorld.convert,
          pick: restoredPick,
          sweptEmptySharedBatches: true
        },
        rows,
        raw
      }
      writeReport(cell)

      // E3.1 — the table must stop tracking the round count.
      expect(
        capacity.last - capacity.first,
        `slotCapacity grew ${capacity.last - capacity.first} across the last ${Math.min(10, ROUNDS)} rounds`
      ).toBeLessThanOrEqual(capacityAllowance)
      expect(
        allocated.last - allocated.first,
        `allocatedSlots (append path) grew ${allocated.last - allocated.first} after warm-up`
      ).toBeLessThanOrEqual(allocatedAllowance)
      expect(
        capacity.max,
        `slotCapacity peaked at ${capacity.max}, above the ${capacity.last} it settled on`
      ).toBe(capacity.last)
      // The mark is recorded on the reserve path only (glyph batches append
      // through their own allocator), so it may lag the table, never lead it.
      expect(
        Math.max(...rows.map(row => row.slotHighWaterMark)),
        'recorded high-water mark exceeds the resident table'
      ).toBeLessThanOrEqual(capacity.max)
      expect(live.max - live.min, `liveSlots swung ${live.min} → ${live.max}`).toBeLessThanOrEqual(
        Math.max(4, Math.ceil(live.max * 0.02))
      )

      // E3.2 — the pool never holds a duplicate, a live id or an out-of-range id.
      expect(rows.every(row => row.invalidSlots === 0), 'free list invariant violated').toBe(true)
      expect(rows.every(row => row.duplicateFreeAttempts === 0), 'double free observed').toBe(true)
      expect(rows.every(row => row.freeListSize === row.freedSlots), 'free list size ≠ freed slots').toBe(
        true
      )

      // E3.3 — a freed record keeps neither a box nor a draw snapshot.
      expect(rows.every(row => row.inactiveBoundingBoxes === 0), 'freed slot retained a Box3').toBe(true)
      expect(
        rows.every(row => row.retainedHiddenSnapshots === 0),
        'freed slot retained a hidden draw snapshot'
      ).toBe(true)

      // E3.4 — no attributable heap delta once the table has converged.
      expect(
        heap.driftPerRound,
        `heap grew ${heap.driftPerRound} MB/round (${heap.first} → ${heap.last}); ` +
          'a residual slope needs a heap diff, not a wider tolerance'
      ).toBeLessThanOrEqual(HEAP_DRIFT_LIMIT_MB)

      // E3.5 — the phase 2.9 convergence still holds.
      expect(finalWorld.shared.emptyBatches, 'empty shared batch survived the sweep').toBe(0)
      expect(finalWorld.sharedSummary.empty).toBe(0)
      expect(
        geometries.last - geometries.first,
        `renderer geometries grew ${geometries.first} → ${geometries.last}`
      ).toBeLessThanOrEqual(Math.max(2, Math.ceil(geometries.first * 0.02)))
      expect(
        object3d.last - object3d.first,
        `object3d nodes grew ${object3d.first} → ${object3d.last}`
      ).toBeLessThanOrEqual(Math.max(4, Math.ceil(object3d.first * 0.02)))

      // E3.6 — correctness: the three id sets agree on every sampled round.
      expect(rows.every(row => row.db === SIZE)).toBe(true)
      expect(rows.every(row => row.missingFromScene === 0), 'database id missing from the scene').toBe(true)
      expect(rows.every(row => row.residualInScene === 0), 'scene id without a database object').toBe(true)
      expect(rows.every(row => row.missingFromIndex === 0), 'scene id missing from the spatial index').toBe(
        true
      )
      expect(rows.every(row => row.residualInIndex === 0), 'index id not in the scene').toBe(true)
      expect(rows.every(row => row.index === row.scene)).toBe(true)
      expect(rows.every(row => row.pickCount > 0), 'undo left a scene that cannot be picked').toBe(true)
      expect(finalWorld.ids.hash).toBe(idsHash)

      // The scene walk has to see every container the group counts; otherwise a
      // batch could drift out of view and shrink the measured total.
      expect(finalWorld.slots.groupSlotCapacity).toBe(finalWorld.slots.slotCapacity)
      expect(restoredPick).toBeGreaterThan(0)
    })
  }
}

/**
 * Task D19 — a document close during a pending conversion must not leave the
 * previous session's slot tables behind.
 *
 * `view.clear()` is the path a document close takes. It must drop the batches
 * (`getSlotLifecycleMetrics().batchCount === 0`), and the slot tables must not be
 * resurrected by a convert task that was still queued when the document went
 * away.
 */
test('phase 2.11 close document releases slot tables', async ({ page }) => {
  const size = Math.min(SIZE, 5_000)
  const fixture = writeMixedFixture(size, `p211close${size}`)
  await installObservers(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expectIdCount(page, size)
  expect((await drain(page)).ready).toBe(true)

  const before = await readWorld(page)
  expect(before.slots.batchCount).toBeGreaterThan(0)
  expect(before.slots.slotCapacity).toBeGreaterThan(0)

  // Park the convert pipeline with a hook, close the document while a job is
  // still queued, then release it: the session epoch check must discard it.
  await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView as unknown as {
      setConvertDebugHook?: (
        hook: ((stage: string, objectId: string) => void | Promise<void>) | null
      ) => void
    }
    const win = window as unknown as { __p211Gate?: { release: () => void; hits: string[] } }
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const hits: string[] = []
    win.__p211Gate = { release, hits }
    view?.setConvertDebugHook?.(async stage => {
      hits.push(stage)
      if (stage === 'queued' && hits.length === 1) await gate
    })
  })

  // A MOVE is enough to put a job through the queue.
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const doc = win.AcApDocManager?.instance?.curDocument
    if (!doc) throw new Error('document unavailable')
    doc.database.runDatabaseEdit('phase211-close', () => {
      const iterator = doc.database.tables.blockTable.modelSpace.newIterator()
      const entities: unknown[] = []
      let count = 0
      for (const entity of iterator) {
        if (count++ > 200) break
        entities.push(entity)
      }
      doc.entityService.translateEntities(entities, { x: 3, y: 4, z: 0 })
    })
  })

  await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView as unknown as {
      clear?: () => void
    }
    view?.clear?.()
  })
  const cleared = await readWorld(page)
  await page.evaluate(() => {
    ;(window as unknown as { __p211Gate?: { release: () => void } }).__p211Gate?.release()
  })
  // Let anything the released task resurrects run to completion.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 1_000)))
  const settled = await readWorld(page)
  const hookHits = await page.evaluate(
    () => (window as unknown as { __p211Gate?: { hits: string[] } }).__p211Gate?.hits ?? []
  )

  const cell = {
    key: `${TAG}/${size}/close/close/1`,
    tag: TAG,
    size,
    rounds: 0,
    op: 'close',
    session: 1,
    before: { slots: before.slots, heapMB: before.heapMB, shared: before.shared },
    cleared: { slots: cleared.slots, heapMB: cleared.heapMB, shared: cleared.shared },
    settled: { slots: settled.slots, heapMB: settled.heapMB, shared: settled.shared },
    hookHits
  }
  writeReport(cell)

  expect(cleared.slots.batchCount).toBe(0)
  expect(cleared.slots.slotCapacity).toBe(0)
  expect(settled.slots.batchCount).toBe(0)
  expect(settled.slots.slotCapacity).toBe(0)
  expect(settled.slots.liveSlots).toBe(0)
  expect(settled.slots.groupSlotCapacity).toBe(0)
  expect(settled.ids.scene).toBe(0)
  expect(settled.ids.index).toBe(0)
})

/* ------------------------------------------------------------------------- *
 * Task D16/D17/D18 — the convert-versus-erase race, made deterministic.
 *
 * `setConvertDebugHook` pauses the pipeline at a named stage; this is the only
 * way to observe "the task was queued" and "the task had claimed the slot" as
 * separate states instead of racing the scheduler. Each test parks one job,
 * erases its entity, and then lets the job finish: it must be discarded, not
 * committed into a slot that no longer belongs to it.
 * ------------------------------------------------------------------------- */

interface RaceState {
  hasEntity: boolean | null
  /** Ids returned by `pick` at each requested point, in order. */
  picked: string[][]
  /** Active slot records that still name the target object id. */
  slotsOfTarget: number
  /** Every slot record reachable from the scene, active or not. */
  slotsInTable: number
  /** Free-list violations plus records that kept state after release. */
  invalidSlots: number
  /** Centres of the packed geometry each target slot holds, in world space. */
  centroids: Array<{ x: number; y: number }>
  stale: Record<string, number>
  generation: number
  queued: number
  erased: boolean | null
}

/** The convert hook stages reached so far, in order. */
async function gateHits(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __p211Race?: { hits: Array<{ stage: string; id: string }> } })
        .__p211Race?.hits ?? []
  )
}

/** Asserts one recorded point equals another, within `eps`. */
function expectNear(
  actual: { x: number; y: number } | undefined,
  expected: { x: number; y: number },
  label: string,
  eps = 0.05
) {
  expect(actual, `${label}: no position was recorded`).toBeDefined()
  const dx = (actual?.x ?? NaN) - expected.x
  const dy = (actual?.y ?? NaN) - expected.y
  expect(Math.hypot(dx, dy), `${label}: (${actual?.x},${actual?.y}) ≠ (${expected.x},${expected.y})`).toBeLessThanOrEqual(
    eps
  )
}

/** Parks the convert pipeline on `stage` for one object id, once. */
async function installConvertGate(page: Page, stage: string, objectId: string) {
  await page.evaluate(
    ({ stage, objectId }) => {
      const win = window as unknown as PageWindow & {
        __p211Race?: { hits: Array<{ stage: string; id: string }>; blocked: boolean; release: () => void }
      }
      const view = win.AcApDocManager?.instance?.curView as unknown as {
        setConvertDebugHook?: (
          hook: ((stage: string, objectId: string) => void | Promise<void>) | null
        ) => void
      }
      let release = () => {}
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const state = { hits: [] as Array<{ stage: string; id: string }>, blocked: false, release }
      win.__p211Race = state
      view?.setConvertDebugHook?.(async (hitStage, hitId) => {
        state.hits.push({ stage: hitStage, id: hitId })
        if (!state.blocked && hitStage === stage && hitId === objectId) {
          state.blocked = true
          await gate
        }
      })
    },
    { stage, objectId }
  )
}

async function waitForGate(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __p211Race?: { blocked: boolean } }).__p211Race?.blocked ?? false
        ),
      { timeout: 120_000, intervals: [25, 50, 100, 250] }
    )
    .toBe(true)
}

async function releaseGate(page: Page) {
  await page.evaluate(
    () => (window as unknown as { __p211Race?: { release: () => void } }).__p211Race?.release()
  )
}

/** Moves one entity in a transaction, which enqueues exactly one convert job. */
async function moveOne(page: Page, id: string, dx: number, dy: number) {
  await page.evaluate(
    ({ id, dx, dy }) => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      doc.database.runDatabaseEdit('p211-race-move', () => {
        const entities = doc.entityService.getEntitiesByIds([id])
        doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
      })
    },
    { id, dx, dy }
  )
}

async function eraseOne(page: Page, id: string) {
  return page.evaluate(list => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    return doc?.entityService.eraseEntities(list) ?? 0
  }, [id])
}

async function undoOnce(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument?.database
        .transactionManager.undo() ?? false
  )
}

/**
 * Slot occupancy, box geometry and pick behaviour of one entity, plus the
 * reject counters. The box centre is the only value that tells one geometry
 * version of an id from another, so it is what a stale convert has to move.
 */
async function readRaceState(
  page: Page,
  id: string,
  points: Array<{ x: number; y: number }>
): Promise<RaceState> {
  return page.evaluate(
    ({ target, points }) => {
      const win = window as unknown as PageWindow
      const view = win.AcApDocManager?.instance?.curView as unknown as {
        hasEntity?: (id: string) => boolean
        pick?: (point: { x: number; y: number }, radius?: number) => Array<{ id?: unknown }>
        _scene?: { _layouts?: Map<string, unknown> }
        _staleConvertRejections?: Record<string, number>
        _entityConvertGeneration?: Map<string, number>
        _erasedConvertObjectIds?: Set<string>
        _convertQueue?: unknown[]
      }
      const layouts = view?._scene?._layouts
      const values = layouts instanceof Map ? Array.from(layouts.values()) : []
      let slotsOfTarget = 0
      let slotsInTable = 0
      let invalidSlots = 0
      const centroids: Array<{ x: number; y: number }> = []
      /**
       * Centroid of the packed geometry a slot holds, in world space.
       *
       * `slot.boundingBox` is lazily computed and mostly null, so it cannot
       * tell two geometry versions apart. The packed vertices can: they are
       * stored relative to the batch origin, which is the node's own position.
       */
      const readCentroid = (node: unknown, slot: {
        vertexStart?: number
        vertexCount?: number
        indexStart?: number
        indexCount?: number
      }) => {
        const batch = node as {
          position?: { x: number; y: number }
          geometry?: {
            attributes?: Record<
              string,
              { count?: number; getX?: (i: number) => number; getY?: (i: number) => number }
            >
          }
        }
        const attributes = batch.geometry?.attributes
        if (!attributes) return null
        const origin = { x: batch.position?.x ?? 0, y: batch.position?.y ?? 0 }
        const start = slot.vertexStart ?? slot.indexStart ?? 0
        const count = slot.vertexCount ?? slot.indexCount ?? 0
        if (count <= 0) return null
        // Wide-line batches keep one instance per segment; its first endpoint is
        // a stable fingerprint of the geometry version.
        const segments = attributes.instanceStart
        if (segments?.getX && segments?.getY) {
          return {
            x: origin.x + segments.getX(start),
            y: origin.y + segments.getY(start)
          }
        }
        const position = attributes.position
        if (!position?.getX || !position?.getY) return null
        const available = Math.min(count, 64, (position.count ?? 0) - start)
        if (available <= 0) return null
        let sx = 0
        let sy = 0
        for (let i = 0; i < available; i++) {
          sx += position.getX(start + i)
          sy += position.getY(start + i)
        }
        return { x: origin.x + sx / available, y: origin.y + sy / available }
      }
      const visit = (node: unknown) => {
        const batch = node as {
          _geometryInfo?: Array<{
            flags?: number
            objectId?: string
            vertexStart?: number
            vertexCount?: number
            indexStart?: number
            indexCount?: number
            boundingBox?: unknown
            hiddenDrawSnapshot?: unknown
          }>
          _availableGeometryIds?: number[]
          children?: unknown[]
        }
        const table = batch._geometryInfo
        if (Array.isArray(table)) {
          slotsInTable += table.length
          const pool = Array.isArray(batch._availableGeometryIds)
            ? batch._availableGeometryIds
            : []
          const seen = new Set<number>()
          for (const freeId of pool) {
            if (!Number.isInteger(freeId) || freeId < 0 || freeId >= table.length) invalidSlots++
            else if (seen.has(freeId)) invalidSlots++
            else if (((table[freeId]?.flags ?? 0) & 1) === 1) invalidSlots++
            seen.add(freeId)
          }
          for (let slotId = 0; slotId < table.length; slotId++) {
            const slot = table[slotId]
            if (((slot?.flags ?? 0) & 1) !== 1) {
              if (slot && (slot.boundingBox || slot.hiddenDrawSnapshot)) invalidSlots++
              continue
            }
            if (String(slot.objectId ?? '') !== target) continue
            slotsOfTarget++
            const centroid = readCentroid(node, slot)
            if (centroid) centroids.push(centroid)
          }
        }
        for (const child of batch.children ?? []) visit(child)
      }
      for (const layout of values) visit((layout as { _group?: unknown })?._group)
      return {
        hasEntity: view?.hasEntity?.(target) ?? null,
        picked: points.map(point =>
          (view?.pick?.(point, 2) ?? []).map(hit => String(hit?.id ?? ''))
        ),
        slotsOfTarget,
        slotsInTable,
        invalidSlots,
        centroids,
        stale: { ...(view?._staleConvertRejections ?? {}) },
        generation: view?._entityConvertGeneration?.get(target) ?? -1,
        queued: (view?._convertQueue ?? []).length,
        erased: view?._erasedConvertObjectIds?.has(target) ?? null
      }
    },
    { target: id, points }
  )
}

/**
 * Task D16 — the id is queued for conversion and erased before the drain
 * claims it.
 *
 * `queued` only exists on the append path (`_convertQueue`); a MOVE goes
 * through `_entityUpdateQueue → applyEntityUpdates → batchConvert` and never
 * enters that queue. Undo of an ERASE re-appends the id, which is exactly the
 * "queued but unclaimed" state an ERASE used to miss.
 */
test('phase 2.11 erase while the convert is queued (D16)', async ({ page }) => {
  const size = Math.min(SIZE, 300)
  const fixture = writeMixedFixture(size, `p211queued${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expectIdCount(page, size)
  expect((await drain(page)).ready).toBe(true)

  const ids = await readDbIds(page)
  const target = ids[0]
  const probe = [{ x: PROBE.x, y: PROBE.y }]

  // Put the id in the state Undo will restore it from.
  expect(await eraseOne(page, target)).toBe(1)
  expect((await drain(page, 300_000)).ready).toBe(true)
  expect((await readRaceState(page, target, probe)).hasEntity).toBe(false)

  await installConvertGate(page, 'queued', target)
  expect(await undoOnce(page)).toBe(true)
  await waitForGate(page)
  // Restored in the database, queued for the scene, claimed by nobody yet.
  expect(await eraseOne(page, target), 'the queued id was no longer erasable').toBe(1)
  await releaseGate(page)
  expect((await drain(page, 300_000)).ready).toBe(true)

  const state = await readRaceState(page, target, probe)
  const hits = await gateHits(page)
  writeReport({
    key: `${TAG}/${size}/race-queued/queued/1`,
    tag: TAG,
    size,
    rounds: 0,
    op: 'race-queued',
    session: 1,
    hits,
    state
  })

  expect(
    hits.some(hit => hit.stage === 'queued' && hit.id === target),
    `the hook never paused the queue: ${JSON.stringify(hits)}`
  ).toBe(true)
  expect(state.hasEntity, 'a drained-then-erased id was committed anyway').toBe(false)
  expect(state.slotsOfTarget, 'a freed slot record still names the erased id').toBe(0)
  expect(state.erased).toBe(true)
  expect(state.queued, 'the queue was not drained after the release').toBe(0)
  expect(state.picked[0], 'the erased id is still pickable').not.toContain(target)
  expect(state.invalidSlots, 'free list / released-record invariant violated').toBe(0)
})

/**
 * Task D17 — the id was claimed and its geometry is being built when the ERASE
 * lands. The convert must not commit into a slot nobody owns any more.
 */
test('phase 2.11 erase while the convert is claimed (D17)', async ({ page }) => {
  const size = Math.min(SIZE, 300)
  const fixture = writeMixedFixture(size, `p211claimed${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expectIdCount(page, size)
  expect((await drain(page)).ready).toBe(true)

  const ids = await readDbIds(page)
  const target = ids[0]
  const probe = [{ x: PROBE.x, y: PROBE.y }]
  const before = await readRaceState(page, target, probe)
  expect(before.slotsOfTarget).toBe(1)

  await installConvertGate(page, 'claimed', target)
  await moveOne(page, target, 150, 150)
  await waitForGate(page)

  expect(await eraseOne(page, target), 'the claimed id was no longer erasable').toBe(1)
  await releaseGate(page)
  expect((await drain(page, 300_000)).ready).toBe(true)

  const state = await readRaceState(page, target, probe)
  const hits = await gateHits(page)
  writeReport({
    key: `${TAG}/${size}/race-claimed/claimed/1`,
    tag: TAG,
    size,
    rounds: 0,
    op: 'race-claimed',
    session: 1,
    hits,
    state
  })

  expect(
    hits.some(hit => hit.stage === 'claimed' && hit.id === target),
    `the hook never paused the claim: ${JSON.stringify(hits)}`
  ).toBe(true)
  expect(state.hasEntity).toBe(false)
  expect(state.slotsOfTarget, 'the claimed job committed a slot for an erased id').toBe(0)
  expect(state.picked[0], 'the erased id is still pickable').not.toContain(target)
  expect(state.invalidSlots).toBe(0)
  expect(
    Object.values(state.stale).reduce((total, value) => total + value, 0),
    `no stale-convert rejection was recorded: ${JSON.stringify(state.stale)}`
  ).toBeGreaterThan(0)
})

/**
 * Task D18 — the job was paused mid-claim, its entity was erased and then
 * restored (same id, new life), and the slot table was refilled for the
 * restored entity. The stale job must not overwrite that slot.
 *
 * Both positions are distinguishable by the packed geometry the slot holds:
 * the parked job holds the second MOVE, the restored entity ends up back where
 * the first MOVE left it. A committed stale job would either add a second slot
 * for the id or change what the slot's vertices say.
 */
test('phase 2.11 late convert cannot write a reused slot (D18)', async ({ page }) => {
  const size = Math.min(SIZE, 300)
  const fixture = writeMixedFixture(size, `p211late${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expectIdCount(page, size)
  expect((await drain(page)).ready).toBe(true)

  const ids = await readDbIds(page)
  const target = ids[0]
  // Cell 0 is a LINE (0,0)-(2,2). One committed MOVE puts its packed geometry at
  // (5,5)-(7,7); the parked second one would put it at (10,10)-(12,12).
  const committedProbe = { x: 6, y: 6 }
  const staleProbe = { x: 11, y: 11 }

  await moveOne(page, target, 5, 5)
  expect((await drain(page, 300_000)).ready).toBe(true)
  const committed = await readRaceState(page, target, [committedProbe])
  expect(committed.slotsOfTarget, 'the committed move never reached the slot table').toBe(1)
  expect(committed.centroids.length, 'the committed slot holds no readable geometry').toBe(1)
  const committedGeometry = committed.centroids[0]
  expect(committed.picked[0], 'the committed geometry is not pickable').toContain(target)

  await installConvertGate(page, 'claimed', target)
  await moveOne(page, target, 5, 5)
  await waitForGate(page)

  // Same id, new life: Undo re-appends the erased entity, then rewinds the MOVE
  // as well, so the committed position is the one below the parked job.
  expect(await eraseOne(page, target)).toBe(1)
  expect(await undoOnce(page), 'undo refused the ERASE').toBe(true)
  expect(await undoOnce(page), 'undo refused the MOVE').toBe(true)

  await releaseGate(page)
  expect((await drain(page, 300_000)).ready).toBe(true)

  const state = await readRaceState(page, target, [committedProbe, staleProbe])
  const hits = await gateHits(page)
  writeReport({
    key: `${TAG}/${size}/race-late/late/1`,
    tag: TAG,
    size,
    rounds: 0,
    op: 'race-late',
    session: 1,
    committedGeometry,
    hits,
    state
  })

  expect(state.hasEntity).toBe(true)
  expect(state.slotsOfTarget, 'the reused slot does not belong to the restored id').toBe(1)
  expect(state.centroids.length, 'the restored slot holds no readable geometry').toBe(1)
  expectNear(state.centroids[0], committedGeometry, 'the slot holds the stale geometry version')
  expect(state.picked[0], 'the restored geometry is not pickable').toContain(target)
  expect(state.picked[1], 'the stale job committed its geometry at (11,11)').not.toContain(target)
  expect(
    hits.filter(hit => hit.stage === 'claimed' && hit.id === target).length,
    `the parked job never claimed the id: ${JSON.stringify(hits)}`
  ).toBeGreaterThan(0)
  expect(
    Object.values(state.stale).reduce((total, value) => total + value, 0),
    `the stale job was not rejected: ${JSON.stringify(state.stale)}`
  ).toBeGreaterThan(0)
  expect(state.invalidSlots).toBe(0)
})
