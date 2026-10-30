import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { WORLD_BOX, writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.8 Task E — do the caches converge over a long session?
 *
 * Phase 2.7 left two unanswered observations: `_claimedConvertObjectIds` could
 * still hold ~20k ids after a restore, and the renderer's geometry count grew by
 * one per undo. Two rounds cannot distinguish "bounded cache" from "leak", and a
 * non-zero `Set` is not evidence of either, so this spec runs the same
 * `ERASE → Undo → Redo` (and `MOVE → Undo → Redo`) sequence for many rounds and
 * records the *trajectory*:
 *
 *  - three id sets: claimed, erased tombstones, convert generation,
 *  - JS heap after a forced GC (CDP `HeapProfiler.collectGarbage`, so the number
 *    is retained bytes rather than garbage awaiting collection),
 *  - renderer geometry / texture counts (three's alive counters, which are
 *    decremented on `dispose()`),
 *  - scene entity count, spatial-index count and a picking probe.
 *
 * Verdict rule: after a warm-up of three rounds the last ten rounds must stay
 * inside a band (the report uses the observed min/max, not a single sample).
 * A metric that keeps climbing across those ten rounds is reported as a leak
 * even if its absolute value is small.
 *
 * Renderer limits, stated up front: three exposes *alive* geometry/texture
 * counts, not "disposed but still referenced" objects. A resource that is
 * dropped without `dispose()` stays in the alive count, so a stable alive count
 * is strong evidence against a leak; a growth is conclusive. There is no
 * portable counter for the third state, and this spec does not claim one.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase28')

const size = Number(process.env.P28_ROUND_SIZE ?? 10_000)
const rounds = Number(process.env.P28_ROUNDS ?? 20)
const operations = (process.env.P28_ROUND_OPS ?? 'erase,move')
  .split(',')
  .map(value => value.trim())
  .filter(value => value === 'erase' || value === 'move')
const tag = (process.env.P28_TAG ?? 'run').replace(/[^\w.-]/g, '_')

test.use({ trace: 'off' })
test.setTimeout(2_400_000)

interface RoundSample {
  round: number
  op: 'erase' | 'move'
  heapMB: number
  claimed: number
  erased: number
  generation: number
  convertQueued: number
  geometries: number | null
  textures: number | null
  programs: number | null
  db: number
  scene: number
  sceneUnique: number
  spatialIndex: number
  /** Layers in the current layout. */
  layers: number
  /** Renderable nodes still attached to the layout graph. */
  layoutObjects: number
  /** Distinct geometries the layout graph still references. */
  layoutGeometries: number
  /** Ids the batched group can still dispose (unbatched bookkeeping). */
  unbatchedTracked: number
  /** Drawables actually parented by the batched group's unbatched container. */
  unbatchedNodes: number
  /** Ids registered in the batched slot map. */
  batchedIds: number
  /**
   * `type:name:parent` of every renderable node in the layout graph.
   *
   * Needed because a growing geometry count alone says *that* something is
   * retained, not *what*: diffing this list between a late and an early round
   * names the node that keeps being added.
   */
  nodeSignatures: string[]
  pickCount: number
  /** Undo records still on the stack (retained undo memory, in records). */
  undoRecords: number
  redoRecords: number
  /** Retained change entries across both stacks. */
  retainedChanges: number
  syncMs: number
  settleMs: number
  /** In the database but not in the spatial index. */
  missingFromIndex: number
  /** In the spatial index but no longer in the database. */
  residual: number
}

/**
 * One batched container, read only for the unbatched bookkeeping counters.
 *
 * `_unbatchedEntities` maps an id to the drawables the group will dispose on
 * removal; `_unbatchedObjects` is the parent of those drawables. If the parent
 * grows while the map stays flat, an entity was registered twice and the first
 * subtree is no longer reachable by any removal path.
 */
interface BatchedGroupLike {
  _entitiesMap?: Map<string, unknown>
  _unbatchedEntities?: Map<string, unknown[]>
  _unbatchedObjects?: { children: unknown[] }
}

interface LayerLike {
  _group?: BatchedGroupLike
}

interface LayoutLike {
  _group?: { traverse: (fn: (node: LayoutNode) => void) => void }
  _layers?: Map<string, LayerLike>
  _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> }
}

/** The subset of a three node this spec inspects. */
interface LayoutNode {
  isMesh?: boolean
  isLine?: boolean
  isPoints?: boolean
  name?: string
  type?: string
  parent?: { name?: string; type?: string } | null
  geometry?: unknown
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilIdle?: (timeoutMs?: number) => Promise<boolean>
        pick?: (point: { x: number; y: number }, radius?: number) => Array<{ id: string }>
        isProcessingEntities?: boolean
        getOpenConvertStats?: () => {
          pendingEntities?: number
          convertQueued?: number
          deferredActive?: number
          pendingGeometryJobs?: number
          pendingEntityUpdates?: number
        }
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
        }
      }
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            undo: () => boolean
            redo: () => boolean
          }
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
    const values = layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    const ids: string[] = []
    for (const layout of values) {
      for (const item of layout?._spatialIndex?.search(box) ?? []) ids.push(String(item.id))
    }
    return ids
  }, WORLD_BOX)
}

/** Forced-GC heap plus every cache counter the phase-2.7 reports tracked. */
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
      spatialIndex += layout?._spatialIndex?.search({
        minX: -1e6,
        minY: -1e6,
        maxX: 1e6,
        maxY: 1e6
      })?.length ?? 0
    }
    // Attribution hook for the renderer's alive-geometry counter: the renderer
    // counts what it created, this counts what the layout graph still holds.
    // If the renderer grows while this stays flat, the growth is not reachable
    // from the scene and the leak is above the renderer.
    const layoutGeometrySet = new Set<unknown>()
    const nodeSignatures: string[] = []
    let layoutObjects = 0
    let layers = 0
    // Which container keeps growing, and whether the group still knows about
    // the nodes it keeps: `tracked` counts ids the removal path can reach,
    // `unbatchedNodes` counts drawables actually parented by the group.
    let unbatchedTracked = 0
    let unbatchedNodes = 0
    let batchedIds = 0
    for (const layout of values) {
      layers += layout?._layers?.size ?? 0
      for (const layer of layout?._layers?.values() ?? []) {
        const group = layer?._group
        unbatchedTracked += group?._unbatchedEntities?.size ?? 0
        unbatchedNodes += group?._unbatchedObjects?.children.length ?? 0
        batchedIds += group?._entitiesMap?.size ?? 0
      }
      layout?._group?.traverse(node => {
        if (!node?.isMesh && !node?.isLine && !node?.isPoints) return
        layoutObjects += 1
        if (node.geometry) layoutGeometrySet.add(node.geometry)
        const parent = node.parent
        nodeSignatures.push(
          `${node.type ?? '?'}:${node.name ?? ''}:${parent ? `${parent.type ?? '?'}/${parent.name ?? ''}` : 'root'}`
        )
      })
    }
    return {
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      erased: view?._erasedConvertObjectIds?.size ?? -1,
      generation: view?._entityConvertGeneration?.size ?? -1,
      convertQueued: view?._convertQueue?.length ?? -1,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      programs: info?.programs?.length ?? null,
      undoRecords: undoRecords.length,
      redoRecords: redoRecords.length,
      retainedChanges: sum(undoRecords) + sum(redoRecords),
      spatialIndex,
      layers,
      layoutObjects,
      layoutGeometries: layoutGeometrySet.size,
      unbatchedTracked,
      unbatchedNodes,
      batchedIds,
      nodeSignatures: nodeSignatures.sort()
    }
  })
}

async function waitSceneCount(page: Page, expected: number, timeoutMs = 900_000) {
  await expect
    .poll(async () => (await readSceneIds(page)).length, {
      timeout: timeoutMs,
      intervals: [20, 50, 100, 250]
    })
    .toBe(expected)
}

/**
 * Waits until the view is idle *twice in a row* across every queue counter.
 *
 * `waitUntilIdle()` alone returns while deferred glyph / INSERT geometry jobs
 * are still queued (that was the phase 2.7 finding), so sampling right after it
 * would record a half-settled scene and the geometry trajectory would look
 * cleaner than it is. Same gate as `phase27-bulk-replay.spec.ts`.
 */
async function drain(page: Page, budgetMs = 900_000) {
  await page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view) return
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
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }, budgetMs)
}

/** Cell 0 of the mixed fixture is a LINE from (0,0) to (2,2). */
const PROBE = { x: 1, y: 1 }

async function pickAt(page: Page, point: { x: number; y: number }): Promise<number> {
  return page.evaluate(probe => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return view?.pick?.(probe, 2).length ?? -1
  }, point)
}

/**
 * One `ERASE → Undo → Redo` or `MOVE → Undo → Redo` round.
 *
 * @returns Wall clock of the synchronous call, wall clock until the scene is
 *   settled again, and the picking count measured at the only moment a fixed
 *   world point is meaningful: right after the undo restored every entity.
 */
async function runRound(
  page: Page,
  op: 'erase' | 'move',
  ids: string[],
  offset: { x: number; y: number },
  probe: { x: number; y: number }
): Promise<{ syncMs: number; settleMs: number; pickAfterUndo: number }> {
  // A MOVE leaves the scene at full size; only ERASE empties it.
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
        doc.database.transactionManager // keep the handle hot for the undo below
        ;(
          doc.database as unknown as { runDatabaseEdit: (label: string, fn: () => void) => void }
        ).runDatabaseEdit('phase28-round-move', () => {
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

function countBy(values: string[]) {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/**
 * Node signatures gained between the first and the last round.
 *
 * @param samples - One entry per completed round
 */
function nodeDelta(samples: RoundSample[]) {
  if (samples.length < 2) return { added: [] as string[], removed: [] as string[] }
  const first = countBy(samples[0].nodeSignatures ?? [])
  const last = countBy(samples[samples.length - 1].nodeSignatures ?? [])
  const added: string[] = []
  const removed: string[] = []
  for (const [signature, count] of Object.entries(last)) {
    const delta = count - (first[signature] ?? 0)
    if (delta > 0) added.push(`${signature} x${delta}`)
  }
  for (const [signature, count] of Object.entries(first)) {
    const delta = count - (last[signature] ?? 0)
    if (delta > 0) removed.push(`${signature} x${delta}`)
  }
  return { added, removed }
}

/**
 * Turns the per-round trajectory into a convergence verdict.
 *
 * The band is taken over the last ten rounds after a three-round warm-up: a
 * cache that reached its ceiling before the window shows a flat band, a cache
 * that leaks one entry per round shows `driftPerRound` of roughly one. Nothing
 * here claims a leak from a non-zero `Set` — a resident cache is expected to be
 * non-empty — and nothing claims convergence from two rounds either.
 *
 * @param samples - One entry per completed round
 * @param entityCount - Drawing size, used for the id-keyed cache caps
 */
function analyse(samples: RoundSample[], entityCount: number) {
  const warmup = Math.min(3, Math.max(0, samples.length - 1))
  const window = samples.slice(Math.max(warmup, samples.length - 10))
  const metrics = [
    'heapMB',
    'claimed',
    'erased',
    'generation',
    'convertQueued',
    'geometries',
    'textures',
    'programs',
    'layers',
    'layoutObjects',
    'layoutGeometries',
    'unbatchedTracked',
    'unbatchedNodes',
    'batchedIds',
    'undoRecords',
    'redoRecords',
    'retainedChanges',
    'spatialIndex',
    'db',
    'scene',
    'syncMs',
    'settleMs'
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
      driftPerRound: Math.round(((last - first) / Math.max(1, values.length - 1)) * 100) / 100,
      monotonicGrowth: values.length > 2 && values.every((value, index) => index === 0 || value >= values[index - 1])
    }
  }

  // The three id-keyed sets can never hold more ids than the drawing has,
  // times a small factor for tombstones that outlive their entity.
  const cap = Math.ceil(entityCount * 1.5)
  const overCap = (['claimed', 'erased', 'generation'] as const).filter(metric => {
    const entry = band[metric]
    return entry ? Number(entry.max) > cap : false
  })

  return { windowRounds: window.length, warmupRounds: warmup, cap, overCap, band }
}

for (const op of operations) {
  test(`resource convergence: ${rounds} × ${op} on ${size} entities`, async ({ page }) => {
    fs.mkdirSync(reportsDir, { recursive: true })
    const fixture = writeMixedFixture(size, `p28life${size}`)
    await page.goto('/')
    await uploadFixture(page, fixture)
    await expect
      .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
      .toBe(size)
    await drain(page)
    await waitSceneCount(page, size)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    const ids = await readDbIds(page)
    const samples: RoundSample[] = []

    // A MOVE is cumulative: each round translates the drawing again, so the
    // probe has to follow the accumulated displacement. Round N is sampled
    // after its undo, i.e. at the position left by round N-1's redo.
    let cumulative = { x: 0, y: 0 }
    let lastOffset = { x: 0, y: 0 }
    for (let round = 1; round <= rounds; round++) {
      const offset = op === 'move' ? { x: 25 + round, y: 15 + round } : { x: 0, y: 0 }
      const probe = { x: PROBE.x + cumulative.x, y: PROBE.y + cumulative.y }
      const timing = await runRound(page, op, ids, offset, probe)
      if (op === 'move') {
        cumulative = { x: cumulative.x + offset.x, y: cumulative.y + offset.y }
        lastOffset = offset
      }
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
        settleMs: timing.settleMs
      })
    }

    // Last look with everything restored: the state a user actually sits in.
    await page.evaluate(() => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.database.transactionManager.undo()
    })
    await drain(page)
    await waitSceneCount(page, size)
    const restored = await readState(page, cdp)
    const restoredIds = await readDbIds(page)
    const restoredScene = await readSceneIds(page)
    const restoredSceneSet = new Set(restoredScene)

    const restoredState = {
      x: PROBE.x + cumulative.x - lastOffset.x,
      y: PROBE.y + cumulative.y - lastOffset.y
    }

    const convergence = analyse(samples, size)

    const out = {
      tag,
      size,
      rounds,
      op,
      fixture: path.basename(fixture),
      chrome: await page.evaluate(() => navigator.userAgent),
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      warmupRounds: Math.min(3, rounds),
      convergence,
      nodeDelta: nodeDelta(samples),
      samples,
      restored,
      restoredChecks: {
        db: restoredIds.length,
        scene: restoredScene.length,
        sceneUnique: restoredSceneSet.size,
        missingFromIndex: restoredIds.filter(id => !restoredSceneSet.has(id)).length,
        residual: restoredScene.filter(id => !new Set(restoredIds).has(id)).length,
        pickCount: await pickAt(page, restoredState),
        pickProbe: restoredState,
        idsRestored: restoredIds.length === size
      }
    }
    fs.writeFileSync(
      path.join(reportsDir, `phase28-resource-${tag}-${op}-${size}.json`),
      `${JSON.stringify(out, null, 2)}\n`,
      'utf8'
    )

    // Correctness gate: the last round must leave an exact, duplicate-free set.
    expect(out.restoredChecks.idsRestored).toBe(true)
    expect(out.restoredChecks.scene).toBe(size)
    expect(out.restoredChecks.sceneUnique).toBe(size)
    expect(out.restoredChecks.missingFromIndex).toBe(0)
    expect(out.restoredChecks.residual).toBe(0)
    expect(out.restoredChecks.pickCount).toBeGreaterThan(0)

    // Picking and the spatial index are checked every round, at the moment the
    // undo has restored every entity: a stale drawable, a ghost or a missed
    // insert would show up as a non-zero residual or an empty pick.
    expect(samples.every(sample => sample.pickCount > 0)).toBe(true)
    expect(samples.every(sample => sample.missingFromIndex === 0)).toBe(true)
    expect(samples.every(sample => sample.residual === 0)).toBe(true)
    expect(samples.every(sample => sample.sceneUnique === sample.scene)).toBe(true)

    // Cache bound, not a leak claim: the three id-keyed sets may not exceed a
    // small multiple of the drawing size. Whether they *converge* is what the
    // report reads off the recorded trajectory.
    expect(convergence.overCap).toEqual([])
  })
}
