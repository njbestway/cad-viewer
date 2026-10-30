import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { WORLD_BOX, writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'
import {
  beginWindow,
  endWindow,
  installLatencyProbe,
  type LatencyWindow
} from '../helpers/latencyProbe'

/**
 * Phase 2.9 Task F — is the phase 2.8 latency regression real?
 *
 * Phase 2.8 added two scheduling behaviours: a redundant *modify wave* discard
 * and a cooperative yield in the deferred *geometry* pump. Its measurements
 * then showed ERASE +17 % and Redo +28 % against the phase 2.7 baseline, but a
 * single on-state cannot tell "caused by the feature" from "caused by the run".
 *
 * This spec turns both behaviours into runtime switches
 * (`view.setLatencyExperiment`) and measures the arms against each other inside
 * one page, one browser build, one hardware state and one fixture:
 *
 *  - `both-on`   — discard + yield, the phase 2.8 production defaults,
 *  - `both-off`  — neither: the plain convert pipeline,
 *  - `discard-only`, `yield-only` — each feature alone, so a regression can be
 *    attributed to one of them instead of the pair.
 *
 * Interleave: the cycle is built as `keys + reverse(keys)`, so every cycle is
 * `A → B → … → … → B → A`. An arm therefore never always runs first or always
 * runs last, and a monotone drift (heap growth, undo-stack growth, thermal
 * throttling) is shared between arms rather than charged to whichever arm
 * happened to run later. Cycles repeat until each arm holds
 * `P29AB_SAMPLES` valid measurements.
 *
 * What is *not* claimed: `both-off` is not literally the phase 2.7 build. The
 * phase 2.9 lifecycle work (instance-slot reuse, empty-batch eviction, scene
 * readiness) stays on in every arm, because it is not a scheduling option. The
 * comparison isolates the two phase 2.8 switches only.
 *
 * Exit rule: this spec measures. It asserts correctness invariants (id sets,
 * scene/index agreement, restore completeness, enough valid samples) and never
 * asserts a latency threshold — a threshold here would just encode whichever
 * machine ran first.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase29')

const size = Number(process.env.P29AB_SIZE ?? 50_000)
const samplesPerArm = Number(process.env.P29AB_SAMPLES ?? 5)
const operations = (process.env.P29AB_OPS ?? 'erase,move')
  .split(',')
  .map(value => value.trim())
  .filter(value => value === 'erase' || value === 'move')
const budgets = (process.env.P29AB_BUDGETS ?? '300,64,32')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)
const tag = (process.env.P29AB_TAG ?? 'run').replace(/[^\w.-]/g, '_')

test.use({ trace: 'off' })
test.setTimeout(5_400_000)
// Two samples of one browser session must not compete for the main thread.
test.describe.configure({ mode: 'serial' })

/* ------------------------------------------------------------------ *
 * Arms
 * ------------------------------------------------------------------ */

interface Arm {
  id: string
  discardRedundantModifyWave: boolean
  deferGeometryCooperativeYield: boolean
}

/** The runtime switches `view.setLatencyExperiment` accepts (Task F). */
interface ExperimentOptions {
  discardRedundantModifyWave?: boolean
  deferGeometryCooperativeYield?: boolean
  openConvertYieldBudgetMs?: number
  progressiveOpenYieldBudgetMs?: number
  convertSliceBudgetMs?: number
  convertSliceMax?: number
  deferredGeometryConcurrency?: number
  deferredGeometryYieldBudgetMs?: number
}

const ALL_ARMS: Record<string, Arm> = {
  both: {
    id: 'both-on',
    discardRedundantModifyWave: true,
    deferGeometryCooperativeYield: true
  },
  none: {
    id: 'both-off',
    discardRedundantModifyWave: false,
    deferGeometryCooperativeYield: false
  },
  discard: {
    id: 'discard-only',
    discardRedundantModifyWave: true,
    deferGeometryCooperativeYield: false
  },
  yield: {
    id: 'yield-only',
    discardRedundantModifyWave: false,
    deferGeometryCooperativeYield: true
  }
}

/** Arm keys to measure, in first-half order. `P29AB_ARMS=both,none` shortens a run. */
const armKeys = (process.env.P29AB_ARMS ?? 'both,none,discard,yield')
  .split(',')
  .map(value => value.trim())
  .filter(value => value in ALL_ARMS)
const arms = (armKeys.length > 0 ? armKeys : ['both', 'none']).map(key => ALL_ARMS[key])

/**
 * `A → B → … → … → B → A`.
 *
 * Reversed copy rather than a random permutation: the order is reproducible
 * from the report alone, and a two-arm run degenerates to exactly the
 * `A → B → B → A` sequence the spec asks for.
 */
function buildCycle(keys: string[]): string[] {
  return [...keys, ...[...keys].reverse()]
}

const cycle = buildCycle(arms.map(arm => arm.id))
/** Each arm appears twice per cycle, so half as many cycles as samples. */
const cycles = Math.max(1, Math.ceil(samplesPerArm / 2))

/* ------------------------------------------------------------------ *
 * Page surface
 * ------------------------------------------------------------------ */

interface SceneLike {
  _layouts?: Map<string, LayoutLike> | LayoutLike[]
  addEntity?: (...args: unknown[]) => unknown
  removeEntities?: (...args: unknown[]) => unknown
}

interface LayoutLike {
  _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> }
}

interface ViewLike {
  waitUntilSceneReady?: (options?: {
    timeoutMs?: number
  }) => Promise<{ ready: boolean; reasons: string[] }>
  getSceneReadiness?: () => { ready: boolean; reasons: string[] }
  setLatencyExperiment?: (options: ExperimentOptions) => void
  latencyExperiment?: Record<string, unknown>
  getOpenConvertStats?: () => Record<string, unknown>
  takeConvertPhaseTimings?: () => Record<string, number>
  getSharedBatchMetrics?: () => Record<string, number>
  pick?: (point: { x: number; y: number }, radius?: number) => Array<{ id: string }>
  clear?: () => void
  _scene?: SceneLike
  _claimedConvertObjectIds?: Set<string>
  _erasedConvertObjectIds?: Set<string>
  _entityConvertGeneration?: Map<string, number>
}

interface DocLike {
  database: {
    tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
    transactionManager: { undo: () => boolean; redo: () => boolean }
    runDatabaseEdit?: (label: string, fn: () => void) => void
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

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: { curView?: ViewLike; curDocument?: DocLike }
  }
}

interface Counters {
  sceneAdds: number
  sceneRemoves: number
}

/* ------------------------------------------------------------------ *
 * Page helpers
 * ------------------------------------------------------------------ */

async function installStepCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow & { __p29ab?: Counters }
    const scene = win.AcApDocManager?.instance?.curView?._scene
    if (!scene || win.__p29ab) return
    const counters: Counters = { sceneAdds: 0, sceneRemoves: 0 }
    win.__p29ab = counters
    const add = scene.addEntity?.bind(scene)
    const remove = scene.removeEntities?.bind(scene)
    if (add) {
      scene.addEntity = (...args: unknown[]) => {
        counters.sceneAdds += 1
        return add(...args)
      }
    }
    if (remove) {
      scene.removeEntities = (...args: unknown[]) => {
        counters.sceneRemoves += 1
        return remove(...args)
      }
    }
  })
}

async function resetStepCounters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counters = (window as unknown as { __p29ab?: Counters }).__p29ab
    if (!counters) return
    counters.sceneAdds = 0
    counters.sceneRemoves = 0
  })
}

async function readStepCounters(page: Page): Promise<Counters> {
  return page.evaluate(() => {
    const counters = (window as unknown as { __p29ab?: Counters }).__p29ab
    return { sceneAdds: counters?.sceneAdds ?? -1, sceneRemoves: counters?.sceneRemoves ?? -1 }
  })
}

async function applyArm(page: Page, arm: Arm): Promise<void> {
  await page.evaluate(options => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view?.setLatencyExperiment) throw new Error('setLatencyExperiment unavailable')
    view.setLatencyExperiment(options)
  }, arm)
}

/**
 * Waits for a *complete* scene, not a queue-idle one, and reports how long that
 * took plus the reason when it did not happen.
 */
async function drain(page: Page, budgetMs = 900_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const started = performance.now()
    if (!view?.waitUntilSceneReady) {
      return { ready: false, reasons: ['no-waitUntilSceneReady'], readyMs: 0 }
    }
    const snapshot = await view.waitUntilSceneReady({ timeoutMs: budget })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: (snapshot?.reasons ?? []) as string[],
      readyMs: Math.round(performance.now() - started)
    }
  }, budgetMs)
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

async function readSceneCount(page: Page): Promise<number> {
  return page.evaluate((box: typeof WORLD_BOX) => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return 0
    const values = layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    let total = 0
    for (const layout of values) total += layout?._spatialIndex?.search(box)?.length ?? 0
    return total
  }, WORLD_BOX)
}

/** FNV-1a over the sorted id list: cheap equality for a 50k set. */
function fingerprint(ids: string[]): string {
  const sorted = [...ids].sort()
  let hash = 0x811c9dc5
  for (const id of sorted) {
    for (let index = 0; index < id.length; index++) {
      hash ^= id.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x2c
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${sorted.length}:${hash.toString(16)}`
}

/**
 * Database / scene / spatial-index agreement, the correctness half of the A/B.
 *
 * A latency win is meaningless if an arm dropped or duplicated entities, so
 * every measurement carries this snapshot and the report compares fingerprints
 * across arms.
 */
async function readSets(page: Page) {
  const dbIds = await readDbIds(page)
  const sceneIds = await readSceneIds(page)
  const sceneSet = new Set(sceneIds)
  const dbSet = new Set(dbIds)
  return {
    db: dbIds.length,
    scene: sceneIds.length,
    sceneUnique: sceneSet.size,
    missingFromIndex: dbIds.filter(id => !sceneSet.has(id)).length,
    residual: sceneIds.filter(id => !dbSet.has(id)).length,
    dbFingerprint: fingerprint(dbIds),
    sceneFingerprint: fingerprint(sceneIds)
  }
}

async function readConvertState(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
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
    return {
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      erased: view?._erasedConvertObjectIds?.size ?? -1,
      generation: view?._entityConvertGeneration?.size ?? -1,
      convertStats: view?.getOpenConvertStats?.() ?? null,
      shared: view?.getSharedBatchMetrics?.() ?? null,
      undoRecords: undoRecords.length,
      redoRecords: redoRecords.length,
      retainedChanges: sum(undoRecords) + sum(redoRecords),
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10
    }
  })
}

/* ------------------------------------------------------------------ *
 * One measured step
 * ------------------------------------------------------------------ */

interface StepResult {
  name: string
  direction: 'erase' | 'move' | 'undo' | 'redo'
  syncMs: number
  /** Wall clock from the call until the scene held the expected count. */
  settleMs: number
  readyMs: number
  ready: boolean
  readinessReasons: string[]
  window: LatencyWindow
  sceneAdds: number
  sceneRemoves: number
  /** Glyph / INSERT finalizer counters the product accumulated during the step. */
  glyphs: Record<string, number>
  convertStats: Record<string, unknown> | null
}

const PROBE = { x: 1, y: 1 }

async function runStep(
  page: Page,
  name: string,
  direction: StepResult['direction'],
  ids: string[],
  expectedScene: number,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): Promise<StepResult> {
  await resetStepCounters(page)
  // Clear the product's convert timers so glyph/finalizer counts belong to this
  // step only.
  await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    view?.takeConvertPhaseTimings?.()
  })
  await beginWindow(page)

  const startedAt = Date.now()
  const sync = await page.evaluate(
    ({ kind, list, dx, dy }) => {
      const win = window as unknown as PageWindow
      const doc = win.AcApDocManager?.instance?.curDocument
      const manager = doc?.database.transactionManager
      if (!doc || !manager) throw new Error('document unavailable')
      const t0 = performance.now()
      let ok = true
      if (kind === 'erase') {
        doc.entityService.eraseEntities(list)
      } else if (kind === 'move') {
        const entities = doc.entityService.getEntitiesByIds(list)
        const apply = () =>
          doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
        if (doc.database.runDatabaseEdit) {
          doc.database.runDatabaseEdit('phase29-ab-move', apply)
        } else {
          apply()
        }
      } else {
        ok = kind === 'undo' ? manager.undo() : manager.redo()
      }
      return { ms: Math.round((performance.now() - t0) * 10) / 10, ok }
    },
    { kind: direction, list: ids, dx: offset.x, dy: offset.y }
  )
  expect(sync.ok, `${name}: transaction call failed`).toBe(true)

  const readiness = await drain(page)
  await expect
    .poll(() => readSceneCount(page), {
      timeout: 900_000,
      intervals: [50, 100, 250]
    })
    .toBe(expectedScene)
  const settleMs = Date.now() - startedAt

  const window = await endWindow(page)
  const counters = await readStepCounters(page)
  const glyphs = await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const phases = view?.takeConvertPhaseTimings?.() ?? {}
    return {
      glyphEntityCount: phases.glyphEntityCount ?? 0,
      mtextCount: phases.mtextCount ?? 0,
      shapeCount: phases.shapeCount ?? 0,
      sharedGlyphDrawCount: phases.sharedGlyphDrawCount ?? 0
    }
  })
  const state = await readConvertState(page)

  return {
    name,
    direction,
    syncMs: sync.ms,
    settleMs,
    readyMs: readiness.readyMs,
    ready: readiness.ready,
    readinessReasons: readiness.reasons,
    window,
    sceneAdds: counters.sceneAdds,
    sceneRemoves: counters.sceneRemoves,
    glyphs,
    convertStats: state.convertStats
  }
}

/* ------------------------------------------------------------------ *
 * One measured cycle: op → undo → redo → restore
 * ------------------------------------------------------------------ */

interface Measurement {
  arm: string
  cycle: number
  op: 'erase' | 'move'
  valid: boolean
  invalidReasons: string[]
  steps: StepResult[]
  /** The whole `op → undo → redo` round, wall clock. */
  cycleSettleMs: number
  setsBefore: Awaited<ReturnType<typeof readSets>>
  setsAfterRestore: Awaited<ReturnType<typeof readSets>>
  convert: Awaited<ReturnType<typeof readConvertState>>
  probePick: number
  experiment: Record<string, unknown> | null
}

async function measureCycle(
  page: Page,
  arm: Arm,
  cycleIndex: number,
  op: 'erase' | 'move',
  ids: string[],
  offset: { x: number; y: number }
): Promise<Measurement> {
  await applyArm(page, arm)
  const setsBefore = await readSets(page)
  const expectedAfterOp = op === 'erase' ? 0 : size

  const startedAt = Date.now()
  const steps: StepResult[] = []
  steps.push(await runStep(page, `${op}`, op, ids, expectedAfterOp, offset))
  steps.push(await runStep(page, 'undo', 'undo', ids, size))
  steps.push(await runStep(page, 'redo', 'redo', ids, expectedAfterOp))
  const cycleSettleMs = Date.now() - startedAt

  // Back to the base state so the next arm starts from the same drawing.
  await page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    doc?.database.transactionManager.undo()
  })
  const restoreReadiness = await drain(page)
  await expect
    .poll(() => readSceneCount(page), { timeout: 900_000, intervals: [50, 100, 250] })
    .toBe(size)

  const setsAfterRestore = await readSets(page)
  const convert = await readConvertState(page)
  const experiment = await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return (view?.latencyExperiment ?? null) as Record<string, unknown> | null
  })
  // The probe runs *after* the restore, so the entity is back at its fixture
  // position: probing at `PROBE + offset` would miss a moved entity.
  const probePick = await page.evaluate(
    probe => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      return view?.pick?.(probe, 2).length ?? -1
    },
    PROBE
  )

  const invalidReasons: string[] = []
  if (!restoreReadiness.ready) {
    invalidReasons.push(`restore-not-ready:${restoreReadiness.reasons.join(',')}`)
  }
  for (const step of steps) {
    if (!step.ready) invalidReasons.push(`${step.name}-not-ready:${step.readinessReasons.join(',')}`)
    if (step.window.hidden) invalidReasons.push(`${step.name}-tab-hidden`)
    // A step that never presented a frame measured nothing about frames; keep
    // the sample but exclude it from the frame percentiles' validity.
    if (step.window.frameCount === 0) invalidReasons.push(`${step.name}-no-frame`)
  }
  if (setsAfterRestore.missingFromIndex !== 0) {
    invalidReasons.push(`missing-from-index:${setsAfterRestore.missingFromIndex}`)
  }
  if (setsAfterRestore.residual !== 0) invalidReasons.push(`residual:${setsAfterRestore.residual}`)
  if (setsAfterRestore.sceneUnique !== setsAfterRestore.scene) {
    invalidReasons.push('scene-duplicates')
  }
  if (setsAfterRestore.db !== size) invalidReasons.push(`db-restore:${setsAfterRestore.db}`)
  if (probePick <= 0) invalidReasons.push('pick-after-restore')

  return {
    arm: arm.id,
    cycle: cycleIndex,
    op,
    valid: invalidReasons.length === 0,
    invalidReasons,
    steps,
    cycleSettleMs,
    setsBefore,
    setsAfterRestore,
    convert,
    probePick,
    experiment
  }
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function stats(values: number[]) {
  if (values.length === 0) return { n: 0, median: null, min: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  return {
    n: sorted.length,
    median: Math.round(median * 10) / 10,
    min: Math.round(sorted[0] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10
  }
}

/** Per arm, per step: the metrics Task F names. */
function summarise(measurements: Measurement[]) {
  const out: Record<string, unknown> = {}
  for (const arm of arms) {
    const valid = measurements.filter(item => item.arm === arm.id && item.valid)
    const steps: Record<string, unknown> = {}
    for (const name of ['op', 'undo', 'redo']) {
      // The op step is named after the operation itself (`erase` / `move`), so
      // `op` is a summary-side alias, not a stored step name.
      const picked = valid
        .map(item => item.steps.find(step => step.name === (name === 'op' ? item.op : name)))
        .filter((step): step is StepResult => Boolean(step))
      if (picked.length === 0) continue
      steps[name] = {
        syncMs: stats(picked.map(step => step.syncMs)),
        settleMs: stats(picked.map(step => step.settleMs)),
        longestLongTaskMs: stats(picked.map(step => step.window.longestTaskMs)),
        maxEventLoopGapMs: stats(picked.map(step => step.window.maxBlockMs)),
        frameP95Ms: stats(
          picked.map(step => step.window.frameP95Ms).filter((value): value is number => value != null)
        ),
        frameMaxMs: stats(
          picked.map(step => step.window.frameMaxMs).filter((value): value is number => value != null)
        ),
        heapPeakMB: stats(picked.map(step => step.window.heapPeakMB)),
        sceneAdds: stats(picked.map(step => step.sceneAdds)),
        sceneRemoves: stats(picked.map(step => step.sceneRemoves)),
        glyphFinalizers: stats(
          picked.map(
            step => step.glyphs.glyphEntityCount + step.glyphs.mtextCount + step.glyphs.shapeCount
          )
        ),
        longTaskCount: stats(picked.map(step => step.window.longTaskCount))
      }
    }
    out[arm.id] = {
      discardRedundantModifyWave: arm.discardRedundantModifyWave,
      deferGeometryCooperativeYield: arm.deferGeometryCooperativeYield,
      samples: valid.length,
      invalidSamples: measurements.filter(item => item.arm === arm.id && !item.valid).length,
      steps,
      cycleSettleMs: stats(valid.map(item => item.cycleSettleMs)),
      retainedChanges: stats(valid.map(item => item.convert.retainedChanges)),
      heapMB: stats(valid.map(item => item.convert.heapMB)),
      dbFingerprints: Array.from(
        new Set(valid.map(item => item.setsAfterRestore.dbFingerprint))
      ),
      sceneFingerprints: Array.from(
        new Set(valid.map(item => item.setsAfterRestore.sceneFingerprint))
      )
    }
  }
  return out
}

/**
 * Relative movement of one arm against the baseline, for the phase 2.8
 * question ("is ERASE +17 % / Redo +28 % real?").
 */
function deltas(summary: Record<string, unknown>, baselineId: string) {
  const baseline = summary[baselineId] as
    | { steps: Record<string, Record<string, { median: number | null }>> }
    | undefined
  if (!baseline) return null
  const out: Record<string, Record<string, number | null>> = {}
  for (const arm of arms) {
    if (arm.id === baselineId) continue
    const entry = summary[arm.id] as {
      steps: Record<string, Record<string, { median: number | null }>>
    }
    const perStep: Record<string, number | null> = {}
    for (const name of ['op', 'undo', 'redo']) {
      const base = baseline.steps[name]?.syncMs?.median ?? null
      const value = entry.steps[name]?.syncMs?.median ?? null
      perStep[`${name}.syncMs`] =
        base != null && value != null && base > 0
          ? Math.round(((value - base) / base) * 1000) / 10
          : null
      const baseSettle = baseline.steps[name]?.settleMs?.median ?? null
      const valueSettle = entry.steps[name]?.settleMs?.median ?? null
      perStep[`${name}.settleMs`] =
        baseSettle != null && valueSettle != null && baseSettle > 0
          ? Math.round(((valueSettle - baseSettle) / baseSettle) * 1000) / 10
          : null
      const baseBlock = baseline.steps[name]?.maxEventLoopGapMs?.median ?? null
      const valueBlock = entry.steps[name]?.maxEventLoopGapMs?.median ?? null
      perStep[`${name}.maxEventLoopGapMs`] =
        baseBlock != null && valueBlock != null && baseBlock > 0
          ? Math.round(((valueBlock - baseBlock) / baseBlock) * 1000) / 10
          : null
    }
    out[arm.id] = perStep
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Test 1 — the toggle A/B
 * ------------------------------------------------------------------ */

for (const op of operations) {
  test(`phase29 AB ${op}: ${arms.length} arms, ${cycle.length} interleaved slots × ${cycles} (${size} entities)`, async ({
    page
  }) => {
    fs.mkdirSync(reportsDir, { recursive: true })
    const fixture = writeMixedFixture(size, `p29ab${size}`)
    await installLatencyProbe(page)
    await page.goto('/')
    await uploadFixture(page, fixture)
    await expect
      .poll(async () => (await readDbIds(page)).length, { timeout: 1_200_000, intervals: [250] })
      .toBe(size)
    const opened = await drain(page)
    expect(opened.ready, `open readiness: ${opened.reasons.join(',')}`).toBe(true)
    await expect
      .poll(() => readSceneCount(page), { timeout: 900_000, intervals: [100, 250] })
      .toBe(size)
    await installStepCounters(page)

    const ids = await readDbIds(page)
    const measurements: Measurement[] = []
    let index = 0

    for (let cycleIndex = 1; cycleIndex <= cycles; cycleIndex++) {
      for (const armId of cycle) {
        const arm = arms.find(item => item.id === armId)!
        index += 1
        // Every arm sees the same displacement pattern; MOVE accumulates so the
        // drawing keeps changing rather than oscillating over one delta.
        const step = op === 'move' ? { x: 25 + index, y: 15 + index } : { x: 0, y: 0 }
        const measurement = await measureCycle(page, arm, cycleIndex, op, ids, step)
        measurements.push(measurement)
      }
    }

    const summary = summarise(measurements)
    const baselineId = arms.find(arm => !arm.discardRedundantModifyWave && !arm.deferGeometryCooperativeYield)?.id ?? arms[0].id
    const report = {
      tag,
      kind: 'toggle-ab',
      size,
      op,
      samplesPerArm,
      cycles,
      cycleOrder: cycle,
      arms: arms.map(arm => ({ ...arm })),
      baseline: baselineId,
      cyclenote:
        'both-off is the plain convert pipeline, not the phase 2.7 build: the phase 2.9 lifecycle work is not switchable and stays on in every arm.',
      environment: {
        userAgent: await page.evaluate(() => navigator.userAgent),
        hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
        deviceMemory: await page.evaluate(
          () => (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null
        ),
        viewport: page.viewportSize(),
        fixture: path.basename(fixture)
      },
      experiment: measurements[0]?.experiment ?? null,
      summary,
      deltasVsBaselinePercent: deltas(summary, baselineId),
      measurements
    }
    fs.writeFileSync(
      path.join(reportsDir, `phase29-ab-${tag}-${op}-${size}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    )

    // ---- gates: correctness and measurement sufficiency, never latency ----
    for (const arm of arms) {
      const valid = measurements.filter(item => item.arm === arm.id && item.valid)
      expect(
        valid.length,
        `${arm.id} produced ${valid.length} valid samples, need ${samplesPerArm}: ${measurements
          .filter(item => item.arm === arm.id)
          .flatMap(item => item.invalidReasons)
          .join(',')}`
      ).toBeGreaterThanOrEqual(samplesPerArm)
    }
    // Every arm must have restored the same drawing.
    const fingerprints = new Set(
      measurements.filter(item => item.valid).map(item => item.setsAfterRestore.sceneFingerprint)
    )
    expect(fingerprints.size, `arms restored different drawings: ${[...fingerprints].join(' | ')}`).toBe(1)
    expect(measurements.every(item => item.setsAfterRestore.db === size)).toBe(true)
    expect(measurements.every(item => item.probePick > 0)).toBe(true)

    const longest = Math.max(
      ...measurements.flatMap(item => item.steps.map(step => step.window.longestTaskMs))
    )
    const gap = Math.max(
      ...measurements.flatMap(item => item.steps.map(step => step.window.maxBlockMs))
    )
    console.log(
      `[phase29-ab] ${op} ${size}: longest long task ${longest} ms, max event-loop gap ${gap} ms`
    )
  })
}

/* ------------------------------------------------------------------ *
 * Test 2 — convert slice budget sweep (300 / 64 / 32 ms)
 * ------------------------------------------------------------------ */

/**
 * The deferred pump configuration is deliberately *not* varied here: the sweep
 * moves the three model-space convert yield budgets together
 * (`openConvertYieldBudgetMs`, `progressiveOpenYieldBudgetMs`,
 * `convertSliceBudgetMs`) so the run answers one question — does a smaller
 * convert slice shorten the longest main-thread block without an unacceptable
 * total-time or memory cost?
 *
 * Production defaults are untouched by this spec; a follow-up PR would change
 * them only after these numbers exist.
 */
test(`phase29 budget sweep: ${budgets.join('/')} ms (${size} entities)`, async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(size, `p29budget${size}`)
  await installLatencyProbe(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 1_200_000, intervals: [250] })
    .toBe(size)
  const opened = await drain(page)
  expect(opened.ready, `open readiness: ${opened.reasons.join(',')}`).toBe(true)
  await expect
    .poll(() => readSceneCount(page), { timeout: 900_000, intervals: [100, 250] })
    .toBe(size)
  await installStepCounters(page)

  const ids = await readDbIds(page)
  const budgetCycle = buildCycle(budgets.map(value => `${value}`))
  const budgetCycles = Math.max(1, Math.ceil(samplesPerArm / 2))
  const samples: Array<{
    budgetMs: number
    step: StepResult
    undo: StepResult
    redo: StepResult
    cycleSettleMs: number
    valid: boolean
    sets: Awaited<ReturnType<typeof readSets>>
  }> = []

  for (let cycleIndex = 1; cycleIndex <= budgetCycles; cycleIndex++) {
    for (const budgetKey of budgetCycle) {
      const budgetMs = Number(budgetKey)
      // Deferred pump stays at its production values: only convert slicing
      // changes, otherwise the comparison would mix two schedulers.
      await page.evaluate(value => {
        const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        view?.setLatencyExperiment?.({
          discardRedundantModifyWave: true,
          deferGeometryCooperativeYield: true,
          openConvertYieldBudgetMs: value,
          progressiveOpenYieldBudgetMs: value,
          convertSliceBudgetMs: value
        })
      }, budgetMs)

      const startedAt = Date.now()
      const step = await runStep(page, 'op', 'erase', ids, 0)
      const undo = await runStep(page, 'undo', 'undo', ids, size)
      const redo = await runStep(page, 'redo', 'redo', ids, 0)
      const cycleSettleMs = Date.now() - startedAt
      await page.evaluate(() => {
        const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
        doc?.database.transactionManager.undo()
      })
      const restore = await drain(page)
      await expect
        .poll(() => readSceneCount(page), { timeout: 900_000, intervals: [50, 100, 250] })
        .toBe(size)
      const sets = await readSets(page)
      const valid =
        restore.ready &&
        step.ready &&
        undo.ready &&
        redo.ready &&
        sets.missingFromIndex === 0 &&
        sets.residual === 0 &&
        sets.db === size &&
        !step.window.hidden
      samples.push({ budgetMs, step, undo, redo, cycleSettleMs, valid, sets })
    }
  }

  const perBudget: Record<string, unknown> = {}
  for (const budgetMs of budgets) {
    const valid = samples.filter(item => item.budgetMs === budgetMs && item.valid)
    perBudget[`${budgetMs}`] = {
      samples: valid.length,
      eraseSyncMs: stats(valid.map(item => item.step.syncMs)),
      eraseSettleMs: stats(valid.map(item => item.step.settleMs)),
      undoSettleMs: stats(valid.map(item => item.undo.settleMs)),
      redoSettleMs: stats(valid.map(item => item.redo.settleMs)),
      cycleSettleMs: stats(valid.map(item => item.cycleSettleMs)),
      longestLongTaskMs: stats(valid.map(item => item.step.window.longestTaskMs)),
      maxEventLoopGapMs: stats(valid.map(item => item.step.window.maxBlockMs)),
      frameP95Ms: stats(
        valid
          .map(item => item.step.window.frameP95Ms)
          .filter((value): value is number => value != null)
      ),
      frameMaxMs: stats(
        valid
          .map(item => item.step.window.frameMaxMs)
          .filter((value): value is number => value != null)
      ),
      heapPeakMB: stats(valid.map(item => item.step.window.heapPeakMB)),
      sceneAdds: stats(valid.map(item => item.step.sceneAdds))
    }
  }

  fs.writeFileSync(
    path.join(reportsDir, `phase29-budget-sweep-${tag}-eraseredo-${size}.json`),
    `${JSON.stringify(
      {
        tag,
        kind: 'budget-sweep',
        size,
        samplesPerArm,
        cycleOrder: budgetCycle,
        budgets,
        deferredPumpUnchanged: true,
        environment: {
          userAgent: await page.evaluate(() => navigator.userAgent),
          hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
          viewport: page.viewportSize()
        },
        perBudget,
        samples
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  for (const budgetMs of budgets) {
    const valid = samples.filter(item => item.budgetMs === budgetMs && item.valid)
    expect(
      valid.length,
      `budget ${budgetMs} ms produced ${valid.length} valid samples, need ${samplesPerArm}`
    ).toBeGreaterThanOrEqual(samplesPerArm)
  }
  const longest = Math.max(
    ...samples.filter(item => item.valid).map(item => item.step.window.longestTaskMs)
  )
  console.log(`[phase29-budget] longest long task across sweep: ${longest} ms`)
})
