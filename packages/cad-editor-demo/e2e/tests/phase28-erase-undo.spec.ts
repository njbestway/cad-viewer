import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { WORLD_BOX, writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'
import {
  beginWindow,
  endWindow,
  installLatencyProbe,
  type LatencyWindow
} from '../helpers/latencyProbe'

/**
 * Phase 2.8 Task B — where the 4.5 s of an ERASE undo actually goes.
 *
 * Phase 2.7 measured one 50k `undo()` as 556–580 ms of database replay inside a
 * 4 425–4 675 ms wall clock, so ~4 s were spent outside `manager.undo()`. The
 * number alone says nothing about *what* was doing the work, and the phase-2.7
 * long-task counter reported `0` for exactly the steps that were driven through
 * `Runtime.evaluate` (see the A3 probe: those tasks are invisible to
 * `PerformanceObserver('longtask')`).
 *
 * This spec therefore measures every stage separately, from the replay to the
 * presented frame, and records a CDP CPU profile of the undo window so the
 * 1.9 s blocking interval can be attributed to real call frames instead of
 * being inferred from `settleMs`:
 *
 *  1. `AcDbChangeApplier.applyInverse` — database replay, plus the
 *     `appendEntity` share of it.
 *  2. `dispatchUndoRedoEvents` — change list → event derivation.
 *  3. `AcDbDatabase.endEventBatch` — the flush that hands every appended
 *     entity to the viewer (`AcApContext.entityAppended` → `AcTrView2d`).
 *  4. `AcTrView2d.runConvertDrain` / `batchConvert` — the async convert path.
 *  5. `takeConvertPhaseTimings()` — the product's own split of convert work
 *     (`addEntity`, `finishGeometry`, `handleGroup`, glyph jobs, …).
 *  6. Frames, blocking gaps, heap and GPU counters over the whole window.
 *
 * Nothing is monkey-patched in the page except instance methods recorded by the
 * test itself; the product code is untouched, so the numbers describe shipping
 * behaviour rather than an instrumented build.
 *
 * Output: `reports/phase28/erase-undo-profile-<P28_TAG>.json`, plus
 * `erase-undo-<P28_TAG>.cpuprofile` and `erase-undo-trace-<P28_TAG>.json` for
 * the undo window. `P28_TAG` defaults to `run`; the phase-2.8 report uses
 * `baseline` (Phase 2.7 code) and `after` (Task C applied) so the two sets
 * never overwrite each other.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase28')
const tag = (process.env.P28_TAG ?? 'run').replace(/[^\w.-]/g, '_')
// Repeat runs only need the numbers; a full trace is ~150 MB per run.
const writeTrace = process.env.P28_TRACE !== '0'

test.use({ trace: 'off' })
test.setTimeout(1_800_000)

/* ------------------------------------------------------------------ *
 * Page handles
 * ------------------------------------------------------------------ */

interface ViewHandle {
  hasEntity: (id: string) => boolean
  waitUntilIdle?: (timeoutMs?: number) => Promise<boolean>
  isProcessingEntities?: boolean
  getOpenConvertStats?: () => Record<string, number>
  takeConvertPhaseTimings?: () => Record<string, number>
  _convertQueue?: unknown[]
  _claimedConvertObjectIds?: Set<string>
  _erasedConvertObjectIds?: Set<string>
  _entityConvertGeneration?: Map<string, number>
  renderer?: { _renderer?: { info?: { memory?: { geometries?: number; textures?: number }; render?: { calls?: number; triangles?: number } } } }
  _scene?: {
    _layouts?: Map<string, { _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> } }> | Array<{ _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> } }>
  }
}

interface StageLog {
  ms: number
  calls: number
  /** Entities handed to the stage, summed over its calls (work volume). */
  items?: number
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: ViewHandle
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
            undo: () => boolean
            redo: () => boolean
            changeApplier?: Record<string, unknown>
            dispatchUndoRedoEvents?: unknown
            undoStack?: { undoRecords?: unknown[] }
          }
          endEventBatch?: unknown
          beginEventBatch?: unknown
        }
        entityService: { eraseEntities: (ids: string[]) => number }
      }
      layout?: unknown
    }
  }
  __p28?: {
    patched: boolean
    stages: Record<string, StageLog>
    notes: string[]
  }
  __lat?: unknown
}

/**
 * Wraps the stage boundaries the report needs.
 *
 * Every wrapper is an own-property override on the live instance, so it dies
 * with the page and cannot leak into another test.
 */
async function installStagePatches(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const doc = win.AcApDocManager?.instance?.curDocument
    const view = win.AcApDocManager?.instance?.curView
    const manager = doc?.database.transactionManager
    if (!doc || !view || !manager) throw new Error('view/document not ready')

    const state = (win.__p28 ??= { patched: false, stages: {}, notes: [] })
    const record = (name: string, ms: number) => {
      const entry = (state.stages[name] ??= { ms: 0, calls: 0 })
      entry.ms += ms
      entry.calls += 1
    }
    /** Adds work volume to a stage, so "196 calls" can be read as "50 000 entities". */
    const recordItems = (name: string, items: number) => {
      const entry = (state.stages[name] ??= { ms: 0, calls: 0 })
      entry.items = (entry.items ?? 0) + items
    }
    /** Wraps a method so its synchronous duration is charged to `name`. */
    const wrap = (
      target: Record<string, unknown>,
      method: string,
      name: string
    ): boolean => {
      const original = target[method]
      if (typeof original !== 'function') {
        state.notes.push(`missing:${method}`)
        return false
      }
      const fn = original as (...args: unknown[]) => unknown
      target[method] = function patched(this: unknown, ...args: unknown[]) {
        const startedAt = performance.now()
        try {
          return fn.apply(this, args)
        } finally {
          record(name, performance.now() - startedAt)
        }
      }
      return true
    }

    const applier = manager.changeApplier
    if (!applier) throw new Error('changeApplier unavailable')
    wrap(applier, 'applyInverse', 'db.applyInverse')
    wrap(applier, 'applyRemoveBatch', 'db.applyRemoveBatch')
    wrap(applier, 'applyRemove', 'db.applyRemove')
    wrap(applier, 'applyAppend', 'db.applyAppend')
    wrap(manager as unknown as Record<string, unknown>, 'dispatchUndoRedoEvents', 'db.dispatchUndoRedoEvents')
    wrap(doc.database as unknown as Record<string, unknown>, 'endEventBatch', 'db.endEventBatch')
    wrap(view as unknown as Record<string, unknown>, 'runConvertDrain', 'view.runConvertDrain')
    wrap(view as unknown as Record<string, unknown>, 'applyEntityUpdates', 'view.applyEntityUpdates')
    wrap(view as unknown as Record<string, unknown>, 'finishEntityGeometry', 'view.finishEntityGeometry')
    wrap(
      view as unknown as Record<string, unknown>,
      'pumpDeferredGeometryQueue',
      'view.pumpDeferredGeometryQueue'
    )

    // `batchConvert` is async, so the synchronous wrapper above would only time
    // its head. It is wrapped here instead to record the entity count (the work
    // actually handed over) and the full settle time of each call.
    const batchConvert = (view as unknown as Record<string, unknown>).batchConvert
    if (typeof batchConvert === 'function') {
      const original = batchConvert as (
        entities: unknown,
        ...rest: unknown[]
      ) => Promise<void>
      ;(view as unknown as Record<string, unknown>).batchConvert = function (
        this: unknown,
        entities: unknown,
        ...rest: unknown[]
      ) {
        recordItems('view.batchConvert', Array.isArray(entities) ? entities.length : 0)
        const startedAt = performance.now()
        return original.call(this, entities, ...rest).finally(() => {
          record('view.batchConvertFull', performance.now() - startedAt)
        })
      }
    } else {
      state.notes.push('missing:batchConvert')
    }

    // `appendEntity` lives on the block table record prototype and is shared by
    // model space and every block definition, so it is patched once there.
    const modelSpace = doc.database.tables.blockTable.modelSpace as unknown as Record<string, unknown>
    const btrProto = Object.getPrototypeOf(modelSpace) as Record<string, unknown>
    wrap(btrProto, 'appendEntity', 'db.appendEntity')

    state.patched = true
  })
}

async function resetStages(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p28
    if (!state) throw new Error('stage patches not installed')
    state.stages = {}
    state.notes.length = 0
  })
}

async function readStages(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as PageWindow).__p28!
    const out: Record<string, StageLog> = {}
    for (const [name, entry] of Object.entries(state.stages)) {
      out[name] = {
        ms: Math.round(entry.ms * 10) / 10,
        calls: entry.calls,
        ...(entry.items === undefined ? {} : { items: entry.items })
      }
    }
    return { stages: out, notes: [...state.notes] }
  })
}

/** Adds a page-measured duration to the current latency window. */
async function reportSync(page: Page, name: string, ms: number) {
  await page.evaluate(
    ({ stepName, durationMs }) => {
      const state = (window as unknown as { __lat?: { syncSteps: Array<{ name: string; ms: number }> } }).__lat
      if (state) state.syncSteps.push({ name: stepName, ms: Math.round(durationMs * 10) / 10 })
    },
    { stepName: name, durationMs: ms }
  )
}

/* ------------------------------------------------------------------ *
 * Read-only handles
 * ------------------------------------------------------------------ */

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

async function readSceneCount(page: Page): Promise<number> {
  return page.evaluate((box: typeof WORLD_BOX) => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return -1
    const values = layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    let count = 0
    for (const layout of values) count += layout?._spatialIndex?.search(box)?.length ?? 0
    return count
  }, WORLD_BOX)
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

async function readInternalState(page: Page) {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return {
      convertQueued: view?._convertQueue?.length ?? -1,
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      erasedTombstones: view?._erasedConvertObjectIds?.size ?? -1,
      convertGeneration: view?._entityConvertGeneration?.size ?? -1,
      stats: view?.getOpenConvertStats?.() ?? {}
    }
  })
}

async function takeConvertPhases(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view?.takeConvertPhaseTimings) return null
    const raw = view.takeConvertPhaseTimings()
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number') out[key] = Math.round(value * 10) / 10
    }
    return out
  })
}

async function waitSceneComplete(page: Page, expected: number, timeoutMs = 600_000) {
  await expect
    .poll(async () => readSceneCount(page), { timeout: timeoutMs, intervals: [25, 50, 100] })
    .toBe(expected)
}

/* ------------------------------------------------------------------ *
 * CDP capture
 * ------------------------------------------------------------------ */

/** Starts the V8 sampling profiler; returns a stopper that yields the profile. */
async function startCpuProfile(cdp: CDPSession) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  return async () => {
    const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
    await cdp.send('Profiler.disable')
    return profile
  }
}

/** Starts a Chrome performance trace; returns a stopper that yields the events. */
async function startTrace(cdp: CDPSession) {
  const events: unknown[] = []
  cdp.on('Tracing.dataCollected', (payload: { value?: unknown[] }) => {
    if (payload.value) events.push(...payload.value)
  })
  const done = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()))
  await cdp.send('Tracing.start', {
    // `toplevel` is what emits `RunTask`, i.e. the task boundaries this phase
    // has to prove blocking against. `v8` is deliberately absent: it emits a
    // `FunctionCall` slice per JS call (200k+ for this drawing), which is both
    // huge and — as measured — truncated inside the timer callbacks that matter.
    // Per-frame stacks come from the CPU profile instead.
    categories: 'toplevel,devtools.timeline,blink.user_timing',
    transferMode: 'ReportEvents'
  })
  return async () => {
    await cdp.send('Tracing.end')
    await done
    return events
  }
}

/* ------------------------------------------------------------------ *
 * Step drivers
 * ------------------------------------------------------------------ */

interface StepResult {
  name: string
  direction: 'erase' | 'undo' | 'redo'
  /** Synchronous time of the call under test, measured in the page. */
  syncMs: number
  /** Wall clock until the scene holds the expected drawables. */
  settleMs: number
  window: LatencyWindow
  stages: Record<string, StageLog>
  convertPhases: Record<string, number> | null
  internal: Record<string, unknown>
  gpu: Record<string, number | null>
  dbCount: number
  sceneCount: number
  sceneUnique: number
  missingFromIndex: number
  spatialIndexResidual: number
  /** First rAF timestamp after the step returned, relative to the step start. */
  firstFrameAfterCallMs: number | null
}

/** Measures the first animation frame that follows the settled scene. */
async function firstFrameAfter(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>(resolve => {
        const startedAt = performance.now()
        requestAnimationFrame(() => resolve(Math.round((performance.now() - startedAt) * 10) / 10))
      })
  )
}

/** Stops the CDP samplers that were started for one step. */
interface Capture {
  stopProfile: () => Promise<unknown>
  stopTrace: () => Promise<unknown[]>
}

async function runStep(
  page: Page,
  name: string,
  direction: StepResult['direction'],
  ids: string[],
  expectedScene: number,
  capture?: Capture
): Promise<StepResult & { profile?: unknown; trace?: unknown[] }> {
  await resetStages(page)
  await takeConvertPhases(page) // clear the product's convert timers
  await beginWindow(page)

  const startedAt = Date.now()
  const sync = await page.evaluate(
    ({ kind, list }) => {
      const win = window as unknown as PageWindow
      const doc = win.AcApDocManager?.instance?.curDocument
      const manager = doc?.database.transactionManager
      if (!doc || !manager) throw new Error('document unavailable')
      const t0 = performance.now()
      let ok = true
      if (kind === 'erase') {
        doc.entityService.eraseEntities(list)
      } else {
        ok = kind === 'undo' ? manager.undo() : manager.redo()
      }
      return { ms: Math.round((performance.now() - t0) * 10) / 10, ok }
    },
    { kind: direction, list: ids }
  )
  expect(sync.ok).toBe(true)
  await reportSync(page, `${name}:call`, sync.ms)

  await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (view?.waitUntilIdle) await view.waitUntilIdle(600_000)
  })
  await waitSceneComplete(page, expectedScene)
  const settleMs = Date.now() - startedAt
  const firstFrameAfterCallMs = await firstFrameAfter(page)

  const window = await endWindow(page)
  // Stop the samplers before the 50 000-id bookkeeping below: walking the model
  // space and the spatial index is test overhead, not part of the step, and it
  // used to land in the profile (and inflate `batchConvert`'s inclusive time).
  const captured = capture
    ? { profile: await capture.stopProfile(), trace: await capture.stopTrace() }
    : {}
  const { stages, notes } = await readStages(page)
  if (notes.length > 0) window.syncSteps.push({ name: `missing:${notes.join(',')}`, ms: 0 })
  const convertPhases = await takeConvertPhases(page)
  const internal = await readInternalState(page)
  const gpu = await readGpu(page)

  const dbIds = await readDbIds(page)
  const sceneIds = await readSceneIds(page)
  const dbSet = new Set(dbIds)
  const sceneSet = new Set(sceneIds)

  return {
    name,
    direction,
    syncMs: sync.ms,
    settleMs,
    window,
    stages,
    convertPhases,
    internal,
    gpu,
    dbCount: dbIds.length,
    sceneCount: sceneIds.length,
    sceneUnique: sceneSet.size,
    missingFromIndex: dbIds.filter(id => !sceneSet.has(id)).length,
    spatialIndexResidual: sceneIds.filter(id => !dbSet.has(id)).length,
    firstFrameAfterCallMs,
    ...captured
  }
}

/* ------------------------------------------------------------------ *
 * Test
 * ------------------------------------------------------------------ */

test('50k ERASE undo: stage split and CPU profile', async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(50_000, 'p28')

  await installLatencyProbe(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(async () => (await readDbIds(page)).length, { timeout: 900_000, intervals: [200] })
    .toBe(50_000)
  await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (view?.waitUntilIdle) await view.waitUntilIdle(900_000)
  })
  await waitSceneComplete(page, 50_000)

  await installStagePatches(page)

  const eraseIds = await readDbIds(page)
  const probePoint = { x: 1, y: 1 }
  const results: StepResult[] = []
  const cpuProfiles: Record<string, unknown> = {}
  const traces: Record<string, unknown[]> = {}

  const cdp = await page.context().newCDPSession(page)

  results.push(await runStep(page, 'erase', 'erase', eraseIds, 0))

  for (const [index, direction] of (['undo', 'redo', 'undo'] as const).entries()) {
    const stopProfile = await startCpuProfile(cdp)
    const stopTrace = await startTrace(cdp)
    const expectedScene = direction === 'undo' ? 50_000 : 0
    const step = await runStep(page, `${direction}${index + 1}`, direction, eraseIds, expectedScene, {
      stopProfile,
      stopTrace
    })
    cpuProfiles[step.name] = step.profile
    traces[step.name] = step.trace ?? []
    // The profile and the trace are written to their own files; keeping them in
    // the step list would inline a 700 KB tree into the results JSON.
    const stepData: StepResult = { ...step }
    delete (stepData as { profile?: unknown }).profile
    delete (stepData as { trace?: unknown[] }).trace
    results.push(stepData)
  }

  // Picking must still resolve the probe point after two full round trips.
  const pick = await page.evaluate(
    ({ x, y }) => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView as unknown as {
        pick?: (point: { x: number; y: number }, radius?: number) => Array<{ id: string }>
      }
      return view?.pick?.({ x, y }, 2).map(item => String(item.id)) ?? []
    },
    probePoint
  )

  fs.writeFileSync(
    path.join(reportsDir, `erase-undo-profile-${tag}.json`),
    `${JSON.stringify({ tag, fixture: { entities: 50_000, file: path.basename(fixture) }, steps: results, pick, chrome: await page.evaluate(() => navigator.userAgent) }, null, 2)}\n`,
    'utf8'
  )
  fs.writeFileSync(
    path.join(reportsDir, `erase-undo-${tag}.cpuprofile`),
    JSON.stringify(cpuProfiles.undo2 ?? cpuProfiles.undo1),
    'utf8'
  )
  const traceEvents = Object.values(traces).flat()
  if (writeTrace) {
    fs.writeFileSync(
      path.join(reportsDir, `erase-undo-trace-${tag}.json`),
      JSON.stringify({ traceEvents }),
      'utf8'
    )
  }

  const undoStep = results.find(step => step.name === 'undo1')!
  // The scene has to come back completely, or the timing is meaningless.
  expect(undoStep.sceneCount).toBe(50_000)
  expect(undoStep.missingFromIndex).toBe(0)
  expect(undoStep.spatialIndexResidual).toBe(0)
  expect(undoStep.window.hidden).toBe(false)
  // The probe's blocking claim must be corroborated by a frame gap.
  expect(undoStep.window.maxBlockMs).toBeGreaterThan(0)
})
