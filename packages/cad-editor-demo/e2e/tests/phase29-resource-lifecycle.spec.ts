import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { WORLD_BOX, writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.9 Task D — long-session resource lifecycle.
 *
 * This is `phase28-resource-lifecycle.spec.ts` with the two phase 2.9 additions
 * that spec could not make:
 *
 *  1. It records the *shared block-template batch* lifecycle (`created` /
 *     `reused` / `emptied` / `evicted` / `disposed`, empty batches, template
 *     UUIDs, slot capacity) instead of inferring retention from the renderer's
 *     total geometry count. Phase 2.8 could only say "geometry grew by one per
 *     round"; that number alone cannot distinguish a new template UUID from a
 *     material split, an origin split, or an empty batch nobody reclaimed.
 *  2. It waits with `waitUntilSceneReady()` and asserts immediately, with no
 *     "sleep 500 ms and hope" step. `waitUntilIdle()` observes queue depth and
 *     returns while a layout's block table record is still being collected.
 *
 * Judgement rules, stated up front:
 *
 *  - A growing undo stack is *retained history*, not a leak. `retainedChanges`
 *    is recorded and reported, never asserted against.
 *  - Renderer counters are alive-object counts (three decrements them on
 *    `dispose()`), so a flat count is strong evidence against a leak and a
 *    monotonic climb is conclusive. An object that is dropped without
 *    `dispose()` still counts, so the reverse direction is not claimed.
 *  - The hard gate is: after the grace period, empty shared batches reach zero,
 *    geometry stops climbing across the last ten rounds, and the database /
 *    scene / spatial-index id sets agree.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase29')

const size = Number(process.env.P29_ROUND_SIZE ?? 10_000)
const rounds = Number(process.env.P29_ROUNDS ?? 20)
const sessions = Number(process.env.P29_SESSIONS ?? 3)
const operations = (process.env.P29_ROUND_OPS ?? 'erase,move')
  .split(',')
  .map(value => value.trim())
  .filter(value => value === 'erase' || value === 'move')
const tag = (process.env.P29_TAG ?? 'run').replace(/[^\w.-]/g, '_')

test.use({ trace: 'off' })
test.setTimeout(3_600_000)
// Sessions measure the same machine; running them in parallel would measure the
// scheduler instead of the lifecycle.
test.describe.configure({ mode: 'serial' })

interface SharedBatchSnapshot {
  created: number
  reused: number
  emptied: number
  evicted: number
  disposed: number
  activeBatches: number
  emptyBatches: number
  activeInstances: number
  templateGeometryCount: number
  uniqueTemplateUUIDCount: number
  peakSlotCapacity: number
  missNewTemplateUuid: number
  missNoMergeableOrigin: number
  missEvictedTemplate: number
  missNewMaterialId: number
  missNewKind: number
}

interface RoundSample {
  round: number
  op: 'erase' | 'move'
  heapMB: number
  geometries: number | null
  textures: number | null
  programs: number | null
  /** Sum of every `BufferAttribute` byte length reachable from the layout. */
  geometryBytes: number
  /** `Object3D` children reachable from the layout root, all layers. */
  object3dNodes: number
  /** Distinct geometries the layout graph still holds. */
  layoutGeometries: number
  /** Renderable nodes (mesh/line/points) the layout graph still holds. */
  renderables: number
  /** Shared block-template batch lifecycle, phase 2.9. */
  shared: SharedBatchSnapshot
  /** Registered batch ids and their live/slot counts, for drift attribution. */
  sharedSummary: { count: number; live: number; slots: number; empty: number }
  claimed: number
  erased: number
  generation: number
  convertQueued: number
  db: number
  scene: number
  sceneUnique: number
  spatialIndex: number
  pickCount: number
  undoRecords: number
  redoRecords: number
  retainedChanges: number
  syncMs: number
  settleMs: number
  /** Longest main-thread task observed since page load (ms), or null. */
  longestTaskMs: number | null
  missingFromIndex: number
  residual: number
  readinessReasons: string[]
  readyAfterMs: number
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: ViewLike
      curDocument?: DocLike
    }
  }
}

interface ViewLike {
  waitUntilSceneReady?: (options?: {
    timeoutMs?: number
  }) => Promise<{ ready: boolean; reasons: string[] }>
  getSceneReadiness?: () => { ready: boolean; reasons: string[] }
  getSharedBatchMetrics?: () => SharedBatchSnapshot
  getSharedBatchEntries?: () => Array<{
    key: string
    liveInstances: number
    slotCapacity: number
    emptyForMs: number
  }>
  sweepEmptySharedBatches?: (graceMs?: number) => unknown
  clear?: () => void
  isProcessingEntities?: boolean
  pick?: (
    point: { x: number; y: number },
    radius?: number
  ) => Array<{ id: string }>
  getOpenConvertStats?: () => Record<string, number>
  renderer?: {
    _renderer?: {
      info?: {
        memory?: { geometries?: number; textures?: number }
        programs?: unknown[]
      }
    }
  }
  _convertQueue?: unknown[]
  _claimedConvertObjectIds?: Set<string>
  _erasedConvertObjectIds?: Set<string>
  _entityConvertGeneration?: Map<string, number>
  _scene?: {
    _layouts?: Map<string, LayoutLike> | LayoutLike[]
    _scene?: LayoutNode
  }
}

interface DocLike {
  database: {
    tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
    transactionManager: { undo: () => boolean; redo: () => boolean }
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

interface LayoutLike {
  _group?: { traverse: (fn: (node: LayoutNode) => void) => void }
  _layers?: Map<string, { _group?: { _entitiesMap?: Map<string, unknown> } }>
  _spatialIndex?: {
    search: (box: typeof WORLD_BOX) => Array<{ id: string }>
    hasChildIndex?: (objectId: string) => boolean
    getRootById?: (objectId: string) => unknown
  }
  collectObjectIds?: () => Set<string>
}

interface LayoutNode {
  children?: LayoutNode[]
  isMesh?: boolean
  isLine?: boolean
  isPoints?: boolean
  geometry?: {
    attributes?: Record<string, { array?: { byteLength?: number } } | undefined>
  }
}

/** Installs the long-task observer before the app boots. */
async function installLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as { __p29LongTasks?: number[] }
    win.__p29LongTasks = []
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          win.__p29LongTasks!.push(Math.round(entry.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is Chromium-only; a missing observer must not fail the run.
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

async function readSceneIds(page: Page): Promise<string[]> {
  return page.evaluate((box: typeof WORLD_BOX) => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return [] as string[]
    const values =
      layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    const ids: string[] = []
    for (const layout of values) {
      for (const item of layout?._spatialIndex?.search(box) ?? []) {
        ids.push(String(item.id))
      }
    }
    return ids
  }, WORLD_BOX)
}

/**
 * Waits for the scene to be *complete*, not merely queue-idle, and returns the
 * final readiness snapshot so a timeout can be attributed.
 *
 * No fixed post-wait sleep: `waitUntilSceneReady` verifies the database → scene
 * → spatial-index chain itself, and it restarts when the document lifecycle
 * epoch changes.
 */
async function drain(page: Page, budgetMs = 900_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const started = performance.now()
    if (!view?.waitUntilSceneReady) {
      return {
        ready: false,
        reasons: ['no-waitUntilSceneReady'],
        readyAfterMs: 0,
        missingFromIndexSamples: [] as string[]
      }
    }
    const snapshot = await view.waitUntilSceneReady({ timeoutMs: budget })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: (snapshot?.reasons ?? []) as string[],
      readyAfterMs: Math.round(performance.now() - started),
      // Ids the scene draws but the spatial index cannot answer, so a failing
      // readiness sample names the offender instead of only counting it.
      missingFromIndexSamples: (snapshot as unknown as {
        missingFromIndexSamples?: string[]
      })?.missingFromIndexSamples ?? []
    }
  }, budgetMs)
}

/** Resolves ids to their database type, so a coverage gap can be attributed. */
async function readIdTypes(page: Page, ids: string[]) {
  if (ids.length === 0) return { tally: {} as Record<string, number>, entities: [] }
  return page.evaluate(list => {
    const win = window as unknown as PageWindow
    const doc = win.AcApDocManager?.instance?.curDocument
    const found = doc?.entityService.getEntitiesByIds(list) ?? []
    const resolved = found.map(entity => {
      const record = entity as unknown as {
        objectId?: string
        type?: string
        dxfTypeName?: string
        wcsBbox?: { min?: { x: number; y: number }; max?: { x: number; y: number } }
      }
      const bbox = record.wcsBbox
      return {
        id: String(record.objectId ?? ''),
        type:
          record.type ??
          record.dxfTypeName ??
          (entity as { constructor?: { name?: string } }).constructor?.name ??
          '?',
        bboxFinite:
          !!bbox?.min &&
          !!bbox?.max &&
          Number.isFinite(bbox.min.x) &&
          Number.isFinite(bbox.min.y) &&
          Number.isFinite(bbox.max.x) &&
          Number.isFinite(bbox.max.y)
      }
    })
    const tally: Record<string, number> = {}
    for (const item of resolved) tally[item.type] = (tally[item.type] ?? 0) + 1
    return { tally, entities: resolved.slice(0, 12) }
  }, ids)
}

/**
 * Inspects *why* an id the scene can draw is absent from the spatial index.
 *
 * The interesting distinction is whether the index never saw the entity or saw
 * it but could not place it: a block reference registered through the lazy child
 * source inserts a root box only when its `wcsBbox` is finite at `addEntity`
 * time, so a group whose geometry is generated afterwards can end up with a
 * child source and no root box.
 */
async function readIndexGapDetail(page: Page, ids: string[]) {
  if (ids.length === 0) return []
  return page.evaluate(list => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    const values = layouts instanceof Map ? Array.from(layouts.values()) : []
    const details: Array<Record<string, unknown>> = []
    for (const id of list) {
      let found: Record<string, unknown> = { id, inLayout: false }
      for (const layout of values) {
        const sceneIds = layout?.collectObjectIds?.() ?? new Set<string>()
        if (!sceneIds.has(id)) continue
        const index = layout?._spatialIndex as unknown as {
          hasChildIndex?: (objectId: string) => boolean
          getRootById?: (objectId: string) => unknown
        }
        let renderEntity: Record<string, unknown> | null = null
        for (const layer of layout?._layers?.values?.() ?? []) {
          const candidate = layer?._group?._entitiesMap?.get(id) as Record<string, unknown> | undefined
          if (candidate) renderEntity = candidate
        }
        const bbox = renderEntity?.wcsBbox as
          | { min?: { x: number; y: number }; max?: { x: number; y: number } }
          | undefined
        const userData = (renderEntity?.userData ?? {}) as Record<string, unknown>
        const lazy = userData.lazySpatialChildren as { boxes?: unknown[] } | undefined
        found = {
          id,
          inLayout: true,
          hasChildIndex: index?.hasChildIndex?.(id) ?? null,
          hasRootBox: Boolean(index?.getRootById?.(id)),
          lazyChildBoxes: lazy?.boxes?.length ?? 0,
          wcsChildBoxes: (renderEntity?.wcsChildBoxes as unknown[] | undefined)?.length ?? 0,
          hasInsertLayerName: Boolean(userData.insertLayerName),
          hasSpatialIndexChildBoxes: Array.isArray(userData.spatialIndexChildBoxes),
          wcsBboxFinite:
            !!bbox?.min &&
            !!bbox?.max &&
            Number.isFinite(bbox.min.x) &&
            Number.isFinite(bbox.min.y) &&
            Number.isFinite(bbox.max.x) &&
            Number.isFinite(bbox.max.y),
          wcsBbox: bbox
            ? { min: [bbox.min?.x, bbox.min?.y], max: [bbox.max?.x, bbox.max?.y] }
            : null
        }
        break
      }
      details.push(found)
    }
    return details
  }, ids)
}

/** Forced-GC heap plus every lifecycle counter phase 2.9 tracks. */
async function readState(page: Page, cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage')
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const doc = win.AcApDocManager?.instance?.curDocument
    const info = view?.renderer?._renderer?.info
    const stack = doc?.database.transactionManager as unknown as {
      undoStack?: {
        undoRecords?: Array<{ changes?: unknown[] }>
        redoRecords?: Array<{ changes?: unknown[] }>
      }
    }
    const undoRecords = stack.undoStack?.undoRecords ?? []
    const redoRecords = stack.undoStack?.redoRecords ?? []
    const sum = (records: Array<{ changes?: unknown[] }>) =>
      records.reduce((total, record) => total + (record.changes?.length ?? 0), 0)
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }

    const layouts = view?._scene?._layouts
    const values =
      layouts instanceof Map ? Array.from(layouts.values()) : layouts ? Array.from(layouts) : []
    let spatialIndex = 0
    for (const layout of values) {
      spatialIndex +=
        layout?._spatialIndex?.search({
          minX: -1e6,
          minY: -1e6,
          maxX: 1e6,
          maxY: 1e6
        })?.length ?? 0
    }

    const geometrySet = new Set<unknown>()
    let object3dNodes = 0
    let renderables = 0
    for (const layout of values) {
      layout?._group?.traverse(node => {
        object3dNodes += 1
        if (!node?.isMesh && !node?.isLine && !node?.isPoints) return
        renderables += 1
        if (node.geometry) geometrySet.add(node.geometry)
      })
    }
    let geometryBytes = 0
    for (const geometry of geometrySet) {
      const attributes = (geometry as { attributes?: Record<string, { array?: { byteLength?: number } }> })
        .attributes
      for (const attribute of Object.values(attributes ?? {})) {
        geometryBytes += attribute?.array?.byteLength ?? 0
      }
    }

    const metrics = view?.getSharedBatchMetrics?.()
    const entries = view?.getSharedBatchEntries?.() ?? []
    const shared = metrics ?? {
      created: -1,
      reused: -1,
      emptied: -1,
      evicted: -1,
      disposed: -1,
      activeBatches: -1,
      emptyBatches: -1,
      activeInstances: -1,
      templateGeometryCount: -1,
      uniqueTemplateUUIDCount: -1,
      peakSlotCapacity: -1,
      missNewTemplateUuid: -1,
      missNoMergeableOrigin: -1,
      missEvictedTemplate: -1,
      missNewMaterialId: -1,
      missNewKind: -1
    }
    const longTasks = ((window as unknown as { __p29LongTasks?: number[] }).__p29LongTasks ?? [])

    return {
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      programs: info?.programs?.length ?? null,
      geometryBytes,
      object3dNodes,
      layoutGeometries: geometrySet.size,
      renderables,
      shared,
      sharedSummary: {
        count: entries.length,
        live: entries.reduce((total, entry) => total + entry.liveInstances, 0),
        slots: entries.reduce((total, entry) => total + entry.slotCapacity, 0),
        empty: entries.filter(entry => entry.liveInstances === 0).length
      },
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      erased: view?._erasedConvertObjectIds?.size ?? -1,
      generation: view?._entityConvertGeneration?.size ?? -1,
      convertQueued: view?._convertQueue?.length ?? -1,
      undoRecords: undoRecords.length,
      redoRecords: redoRecords.length,
      retainedChanges: sum(undoRecords) + sum(redoRecords),
      spatialIndex,
      longestTaskMs: longTasks.length > 0 ? Math.max(...longTasks) : null
    }
  })
}

/** Cell 0 of the mixed fixture is a LINE from (0,0) to (2,2). */
const PROBE = { x: 1, y: 1 }

async function pickAt(page: Page, point: { x: number; y: number }): Promise<number> {
  return page.evaluate(probe => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return view?.pick?.(probe, 2).length ?? -1
  }, point)
}

async function waitSceneCount(page: Page, expected: number, timeoutMs = 900_000) {
  await expect
    .poll(async () => (await readSceneIds(page)).length, {
      timeout: timeoutMs,
      intervals: [20, 50, 100, 250]
    })
    .toBe(expected)
}

/** One `ERASE|MOVE → Undo → Redo` round. */
async function runRound(
  page: Page,
  op: 'erase' | 'move',
  ids: string[],
  offset: { x: number; y: number },
  probe: { x: number; y: number }
): Promise<{ syncMs: number; settleMs: number; pickAfterUndo: number }> {
  const expectedAfterOp = op === 'erase' ? 0 : ids.length
  const startedAt = Date.now()
  const syncMs = await page.evaluate(
    ({ kind, list, dx, dy }) => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const started = performance.now()
      if (kind === 'erase') {
        doc.entityService.eraseEntities(list)
      } else {
        const entities = doc.entityService.getEntitiesByIds(list)
        ;(
          doc.database as unknown as { runDatabaseEdit: (label: string, fn: () => void) => void }
        ).runDatabaseEdit('phase29-round-move', () => {
          doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
        })
      }
      return Math.round((performance.now() - started) * 10) / 10
    },
    { kind: op, list: ids, dx: offset.x, dy: offset.y }
  )
  await drain(page)
  await waitSceneCount(page, expectedAfterOp)

  await page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    doc?.database.transactionManager.undo()
  })
  await drain(page)
  await waitSceneCount(page, ids.length)
  const pickAfterUndo = await pickAt(page, probe)

  await page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    doc?.database.transactionManager.redo()
  })
  await drain(page)
  await waitSceneCount(page, expectedAfterOp)

  return { syncMs, settleMs: Date.now() - startedAt, pickAfterUndo }
}

/**
 * Turns the per-round trajectory into a convergence verdict.
 *
 * The band covers the last ten rounds after a three-round warm-up. `driftPerRound`
 * is the slope that matters: a cache that reached its ceiling shows a flat band,
 * a leak shows a slope of roughly one per round. `retainedChanges` is recorded
 * but never judged: an undo stack that grows with the number of edits is doing
 * its job.
 */
function analyse(samples: RoundSample[]) {
  const warmup = Math.min(3, Math.max(0, samples.length - 1))
  const window = samples.slice(Math.max(warmup, samples.length - 10))
  const metrics = [
    'heapMB',
    'geometries',
    'textures',
    'programs',
    'geometryBytes',
    'object3dNodes',
    'layoutGeometries',
    'renderables',
    'claimed',
    'erased',
    'generation',
    'convertQueued',
    'spatialIndex',
    'db',
    'scene',
    'retainedChanges'
  ] as const

  const band: Record<string, Record<string, number | boolean>> = {}
  for (const metric of metrics) {
    const values = window.map(sample => Number(sample[metric] ?? 0))
    if (values.length === 0) continue
    const first = values[0]
    const last = values[values.length - 1]
    band[metric] = {
      first: Math.round(first * 10) / 10,
      last: Math.round(last * 10) / 10,
      min: Math.round(Math.min(...values) * 10) / 10,
      max: Math.round(Math.max(...values) * 10) / 10,
      driftPerRound:
        Math.round(((last - first) / Math.max(1, values.length - 1)) * 100) / 100,
      monotonicGrowth:
        values.length > 2 &&
        values.every((value, index) => index === 0 || value >= values[index - 1])
    }
  }

  const sharedBand = {
    firstCreated: window.length > 0 ? window[0].shared.created : 0,
    lastCreated: window.length > 0 ? window[window.length - 1].shared.created : 0,
    firstEvicted: window.length > 0 ? window[0].shared.evicted : 0,
    lastEvicted: window.length > 0 ? window[window.length - 1].shared.evicted : 0,
    /**
     * `created` alone is not a leak signal: an `ERASE → Undo` round empties the
     * batch, the grace period expires, the batch is evicted, and the undo builds
     * a new one. That churn shows up as `created +1` per round *with* a matching
     * `evicted +1`.
     *
     * The unbounded case is `created` rising while `evicted` stays flat, which is
     * why the gate is on the difference.
     */
    firstNetCreated: window.length > 0 ? window[0].shared.created - window[0].shared.evicted : 0,
    lastNetCreated:
      window.length > 0
        ? window[window.length - 1].shared.created - window[window.length - 1].shared.evicted
        : 0,
    firstActiveBatches: window.length > 0 ? window[0].shared.activeBatches : 0,
    lastActiveBatches:
      window.length > 0 ? window[window.length - 1].shared.activeBatches : 0,
    maxActiveBatches: Math.max(...window.map(sample => sample.shared.activeBatches)),
    maxEmptyBatches: Math.max(...window.map(sample => sample.shared.emptyBatches)),
    maxTemplateGeometries: Math.max(
      ...window.map(sample => sample.shared.templateGeometryCount)
    ),
    createdPerRound:
      window.length > 1
        ? Math.round(
            ((window[window.length - 1].shared.created - window[0].shared.created) /
              (window.length - 1)) *
              100
          ) / 100
        : 0,
    evictedPerRound:
      window.length > 1
        ? Math.round(
            ((window[window.length - 1].shared.evicted - window[0].shared.evicted) /
              (window.length - 1)) *
              100
          ) / 100
        : 0,
    /** Slope of (created - evicted): the retained-batch count over time. */
    netCreatedPerRound:
      window.length > 1
        ? Math.round(
            ((window[window.length - 1].shared.created -
              window[window.length - 1].shared.evicted -
              (window[0].shared.created - window[0].shared.evicted)) /
              (window.length - 1)) *
              100
          ) / 100
        : 0
  }

  return { windowRounds: window.length, warmupRounds: warmup, band, sharedBand }
}

for (let session = 1; session <= sessions; session++) {
  for (const op of operations) {
    test(`phase29 resource lifecycle: ${rounds} × ${op} on ${size} (session ${session}/${sessions})`, async ({
      page
    }) => {
      fs.mkdirSync(reportsDir, { recursive: true })
      const fixture = writeMixedFixture(size, `p29life${size}`)
      await installLongTaskObserver(page)
      await page.goto('/')
      await uploadFixture(page, fixture)
      await expect
        .poll(async () => (await readDbIds(page)).length, {
          timeout: 900_000,
          intervals: [200]
        })
        .toBe(size)
      const initialDrain = await drain(page)
      expect(initialDrain.ready, `initial readiness: ${initialDrain.reasons.join(',')}`).toBe(true)
      await waitSceneCount(page, size)

      const cdp = await page.context().newCDPSession(page)
      await cdp.send('HeapProfiler.enable')
      const ids = await readDbIds(page)
      const samples: RoundSample[] = []

      let cumulative = { x: 0, y: 0 }
      let lastOffset = { x: 0, y: 0 }
      for (let round = 1; round <= rounds; round++) {
        const offset =
          op === 'move' ? { x: 25 + round, y: 15 + round } : { x: 0, y: 0 }
        const probe = { x: PROBE.x + cumulative.x, y: PROBE.y + cumulative.y }
        const timing = await runRound(page, op, ids, offset, probe)
        if (op === 'move') {
          cumulative = { x: cumulative.x + offset.x, y: cumulative.y + offset.y }
          lastOffset = offset
        }
        const readiness = await drain(page)
        const state = await readState(page, cdp)
        const dbIds = await readDbIds(page)
        const sceneIds = await readSceneIds(page)
        const sceneSet = new Set(sceneIds)
        const dbSet = new Set(dbIds)
        samples.push({
          round,
          op,
          ...state,
          db: dbIds.length,
          scene: sceneIds.length,
          sceneUnique: sceneSet.size,
          pickCount: timing.pickAfterUndo,
          missingFromIndex: dbIds.filter(id => !sceneSet.has(id)).length,
          residual: sceneIds.filter(id => !dbSet.has(id)).length,
          syncMs: timing.syncMs,
          settleMs: timing.settleMs,
          readinessReasons: readiness.reasons,
          readyAfterMs: readiness.readyAfterMs
        })
      }

      // Last look with everything restored: the state a user actually sits in.
      await page.evaluate(() => {
        const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
        doc?.database.transactionManager.undo()
      })
      await drain(page)
      await waitSceneCount(page, size)
      const restoredReadiness = await drain(page)
      const beforeSweep = await readState(page, cdp)

      // Force the grace period to elapse so the "settles to zero empty batches"
      // requirement is asserted on a settled scene rather than on whichever
      // 500 ms window the run happened to end in.
      await page.evaluate(() => {
        const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        view?.sweepEmptySharedBatches?.(0)
      })
      const restored = await readState(page, cdp)
      const restoredIds = await readDbIds(page)
      const restoredScene = await readSceneIds(page)
      const restoredSceneSet = new Set(restoredScene)
      const restoredDbSet = new Set(restoredIds)

      const restoredState = {
        x: PROBE.x + cumulative.x - lastOffset.x,
        y: PROBE.y + cumulative.y - lastOffset.y
      }

      const convergence = analyse(samples)
      const band = convergence.band
      const overCap =
        convergence.sharedBand.maxActiveBatches >
        Math.max(8, convergence.sharedBand.maxTemplateGeometries * 4)

      const out = {
        tag,
        session,
        sessions,
        size,
        rounds,
        op,
        fixture: path.basename(fixture),
        chrome: await page.evaluate(() => navigator.userAgent),
        hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
        warmupRounds: Math.min(3, rounds),
        latencyExperiment: await page.evaluate(() => {
          const view = (window as unknown as PageWindow).AcApDocManager?.instance
            ?.curView as unknown as { latencyExperiment?: unknown }
          return view?.latencyExperiment ?? null
        }),
        convergence,
        beforeSweep: {
          shared: beforeSweep.shared,
          sharedSummary: beforeSweep.sharedSummary
        },
        samples,
        restored,
        restoredChecks: {
          db: restoredIds.length,
          scene: restoredScene.length,
          sceneUnique: restoredSceneSet.size,
          missingFromIndex: restoredIds.filter(id => !restoredSceneSet.has(id)).length,
          residual: restoredScene.filter(id => !restoredDbSet.has(id)).length,
          pickCount: await pickAt(page, restoredState),
          pickProbe: restoredState,
          idsRestored: restoredIds.length === size,
          readiness: restoredReadiness,
          readinessGapTypes: await readIdTypes(
            page,
            restoredReadiness.missingFromIndexSamples.slice(0, 40)
          ),
          readinessGapDetail: await readIndexGapDetail(
            page,
            restoredReadiness.missingFromIndexSamples.slice(0, 3)
          )
        }
      }
      fs.writeFileSync(
        path.join(reportsDir, `phase29-resource-${tag}-s${session}-${op}-${size}.json`),
        `${JSON.stringify(out, null, 2)}\n`,
        'utf8'
      )

      // Task E gate: readiness must not have timed out anywhere in the run.
      expect(initialDrain.ready).toBe(true)
      expect(samples.every(sample => sample.readinessReasons.length === 0)).toBe(true)
      expect(restoredReadiness.ready).toBe(true)

      // Task D1: no empty shared batch survives a settled scene.
      expect(restored.shared.emptyBatches).toBe(0)
      expect(restored.sharedSummary.empty).toBe(0)

      // Task D5 / C: the template geometries the batches owned are released
      // with them, so the count tracks the live instances rather than history.
      expect(restored.shared.templateGeometryCount).toBe(
        restored.shared.uniqueTemplateUUIDCount
      )

      // Task D2/D3: geometry must not climb across the last ten rounds.
      for (const metric of ['geometries', 'layoutGeometries', 'geometryBytes'] as const) {
        const entry = band[metric]
        if (!entry) continue
        const first = Number(entry.first)
        const allowance = Math.max(2, Math.ceil(first * 0.02))
        expect(
          Number(entry.last) - first,
          `${metric} grew across the last ${convergence.windowRounds} rounds: ${first} → ${entry.last}`
        ).toBeLessThanOrEqual(allowance)
      }

      // Task C: batch *churn* (create → empty → evict → create) is legitimate;
      // unbounded *retention* is not. Judge the difference, not `created`.
      expect(
        Math.abs(convergence.sharedBand.netCreatedPerRound),
        `retained shared batches grew ${convergence.sharedBand.netCreatedPerRound}/round ` +
          `(created ${convergence.sharedBand.createdPerRound}/round, ` +
          `evicted ${convergence.sharedBand.evictedPerRound}/round)`
      ).toBeLessThanOrEqual(0.5)
      expect(
        convergence.sharedBand.lastActiveBatches - convergence.sharedBand.firstActiveBatches
      ).toBeLessThanOrEqual(1)

      expect(overCap).toBe(false)

      // Task D6: database / scene / spatial index agree after every round.
      expect(samples.every(sample => sample.missingFromIndex === 0)).toBe(true)
      expect(samples.every(sample => sample.residual === 0)).toBe(true)
      expect(samples.every(sample => sample.sceneUnique === sample.scene)).toBe(true)

      // Task D7: every undo restored a complete, duplicate-free set.
      expect(samples.every(sample => sample.pickCount > 0)).toBe(true)
      expect(out.restoredChecks.idsRestored).toBe(true)
      expect(out.restoredChecks.scene).toBe(size)
      expect(out.restoredChecks.sceneUnique).toBe(size)
      expect(out.restoredChecks.missingFromIndex).toBe(0)
      expect(out.restoredChecks.residual).toBe(0)
      expect(out.restoredChecks.pickCount).toBeGreaterThan(0)

      // Longest main-thread block, reported as a number rather than a count.
      if (restored.longestTaskMs != null) {
        console.log(
          `[phase29] longest main-thread task ${restored.longestTaskMs} ms (${op}, ${size}, session ${session})`
        )
      }
    })
  }
}

/**
 * Task D5 — a closed document must not keep the previous session's batches.
 *
 * Separate from the convergence run because it tears the scene down: `clear()`
 * is the path a document close takes, and it has to drop both the instance
 * buffers and the template geometries they referenced.
 */
test('phase29 close document releases shared batches', async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(Math.min(size, 5_000), `p29close${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
    .toBe(Math.min(size, 5_000))
  await drain(page)

  const before = await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return {
      metrics: view?.getSharedBatchMetrics?.() ?? null,
      entries: view?.getSharedBatchEntries?.()?.length ?? -1
    }
  })
  expect(before.entries).toBeGreaterThan(0)

  await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    view?.clear?.()
  })

  const after = await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const metrics = view?.getSharedBatchMetrics?.()
    const entries = view?.getSharedBatchEntries?.() ?? []
    return {
      activeBatches: metrics?.activeBatches ?? -1,
      emptyBatches: metrics?.emptyBatches ?? -1,
      templateGeometryCount: metrics?.templateGeometryCount ?? -1,
      entries: entries.length,
      readiness: view?.getSceneReadiness?.()?.reasons ?? []
    }
  })

  fs.writeFileSync(
    path.join(reportsDir, `phase29-close-${tag}-${size}.json`),
    `${JSON.stringify({ before, after }, null, 2)}\n`,
    'utf8'
  )

  expect(after.entries).toBe(0)
  expect(after.activeBatches).toBe(0)
  expect(after.emptyBatches).toBe(0)
  expect(after.templateGeometryCount).toBe(0)
})
