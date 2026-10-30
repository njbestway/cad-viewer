import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.12 Task B — 50k MOVE conversion profile, full window.
 *
 * Phase 2.11 Task G traced only the head of the conversion (4 s) and profiled
 * the whole thing. This spec traces the **entire** commit → conversion → settle
 * window instead, because the question changed: 2.11 needed to know which stage
 * dominated, 2.12 needs to know how the 2.1 s is distributed *inside and across
 * tasks*, which a 4 s window cannot answer.
 *
 * Measurements per step (MOVE / Undo / Redo), all inside one `page.evaluate` so
 * `performance.now()` is the only clock involved:
 *
 * - `commitMs` — the synchronous database edit,
 * - `firstYieldMs` — from the edit call to the first `setTimeout(0)` callback,
 *   i.e. how long the main thread runs before it yields at all,
 * - `readyMs` — `waitUntilSceneReady()` duration (queue drained),
 * - `frameMs` — two `requestAnimationFrame` boundaries after ready, i.e. when a
 *   frame containing the new geometry was actually presented.
 *
 * `readyMs` and `frameMs` are reported separately on purpose: Phase 2.9 showed
 * the ready promise can resolve before the last deferred geometry lands, so the
 * two completion conditions are not interchangeable and neither is a substitute
 * for the other.
 *
 * Artifacts (per tag):
 *   reports/phase212/profiles/<tag>.cpuprofile   V8 CPU profile, whole window
 *   reports/phase212/profiles/<tag>.trace.json   DevTools trace, whole window
 *   reports/phase212/profiles/<tag>.raw.json     wall times, counters, frames
 *
 *   $env:P212_SIZE='50000'; $env:P212_TAG='move50000'
 *   npx playwright test e2e/tests/phase212-move-conversion.spec.ts
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const outDir = path.join(repoRoot, 'reports', 'phase212', 'profiles')

const SIZE = Number(process.env.P212_SIZE ?? 50_000)
const TAG = (process.env.P212_TAG ?? `move${SIZE}`).replace(/[^\w.-]/g, '_')
const FIXTURE = process.env.P212_FIXTURE ?? 'mixed'
const SHARING = (process.env.P212_SHARING ?? 'on') !== 'off'
/** Sampling interval in µs; 200 µs is Chrome's DevTools default. */
const SAMPLING_US = Number(process.env.P212_SAMPLING_US ?? 200)
/**
 * Phase 2.12 Task D arm switch. Off = the pre-2.12 single-task conversion.
 *
 * The profile is what sizes the scheduler, so the After arm has to be profiled
 * with the same recorder as the baseline: a trace is the only way to compare
 * "longest RunTask" against the 2834.1 ms baseline instead of against a longtask
 * entry whose attribution is unclear.
 */
const SCHED = (process.env.P212_SCHED ?? '0') === '1'
const SCHED_BUDGET = Number(process.env.P212_SCHED_BUDGET ?? 16)

test.use({ trace: 'off' })
test.setTimeout(3_600_000)

type StepResult = {
  commitMs: number
  firstYieldMs: number
  readyMs: number
  ready: boolean
  reasons: string[]
  frameMs: number
  frames: number[]
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (options?: { timeoutMs?: number }) => Promise<{
          ready: boolean
          reasons?: string[]
        }>
        getSlotLifecycleMetrics?: () => Record<string, number>
        getSharedBatchMetrics?: () => Record<string, unknown>
        getGlyphBatchMetrics?: () => Record<string, number>
        entityUpdateStats?: Record<string, number>
        setConvertScheduler?: (options: { enabled?: boolean; budgetMs?: number }) => void
        getConversionSchedulerMetrics?: () => Record<string, number>
        resetConversionSchedulerMetrics?: () => void
      }
      curDocument?: {
        database: {
          tables: {
            blockTable: {
              modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
            }
          }
          transactionManager: {
            undo?: () => boolean
            redo?: () => boolean
            undoStack?: { undoRecords?: unknown[]; redoRecords?: unknown[] }
            getSnapshotSharingMetrics?: () => Record<string, unknown>
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
  __p212LongTasks?: number[]
  __p212Frames?: number[]
  __p212HeapPeak?: number
  __p212Slices?: SliceRecord[]
}

/** One `batchConvert` call: the unit the conversion loop actually iterates. */
type SliceRecord = {
  count: number
  startMs: number
  endMs: number
  ms: number
}

async function installObservers(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as PageWindow
    win.__p212LongTasks = []
    win.__p212Frames = []
    win.__p212HeapPeak = 0
    try {
      // Long tasks are delivered after the task ends, so the probe only reads
      // them once a real macrotask boundary has passed (phase 2.9 lesson).
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          win.__p212LongTasks!.push(Math.round(entry.duration * 10) / 10)
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is Chromium-only.
    }
    let previous = 0
    const sample = (now: number) => {
      if (previous > 0) win.__p212Frames!.push(Math.round((now - previous) * 10) / 10)
      previous = now
      const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
      const used = perf.memory?.usedJSHeapSize ?? 0
      if (used > (win.__p212HeapPeak ?? 0)) win.__p212HeapPeak = used
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

async function readDbIds(page: Page) {
  return page.evaluate(() => {
    const iterator = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument?.database
      .tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

async function setSharing(page: Page, on: boolean) {
  const applied = await page.evaluate(value => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument?.database
      .transactionManager as unknown as { snapshotSharing?: boolean } | undefined
    if (!manager) return null
    manager.snapshotSharing = value
    return manager.snapshotSharing
  }, on)
  return applied
}

/**
 * One command, measured end to end. `action` is `move`, `undo` or `redo`; the
 * clock starts inside the page so no cross-epoch conversion is involved.
 */
async function runStep(
  page: Page,
  action: 'move' | 'undo' | 'redo',
  payload: { list: string[]; dx: number; dy: number; budget: number }
): Promise<StepResult> {
  return page.evaluate(async ({ action, payload }) => {
    const win = window as unknown as PageWindow
    const instance = win.AcApDocManager?.instance
    const doc = instance?.curDocument
    if (!doc) throw new Error('document unavailable')
    const view = instance?.curView
    const manager = doc.database.transactionManager

    const frames: number[] = []
    let frameStop = false
    const frameProbe = (now: number) => {
      frames.push(now)
      if (!frameStop) requestAnimationFrame(frameProbe)
    }

    const started = performance.now()
    if (action === 'move') {
      doc.database.runDatabaseEdit('phase212-profile-move', () => {
        const entities = doc.entityService.getEntitiesByIds(payload.list)
        doc.entityService.translateEntities(entities, { x: payload.dx, y: payload.dy, z: 0 })
      })
    } else {
      const ok = action === 'undo' ? manager?.undo?.() : manager?.redo?.()
      if (!ok) throw new Error(`${action} was refused`)
    }
    const commitMs = performance.now() - started

    // First real macrotask boundary after the synchronous work: everything the
    // command does before this resolves ran without yielding.
    const firstYieldMs = await new Promise<number>(resolve => {
      setTimeout(() => resolve(performance.now() - started), 0)
    })

    requestAnimationFrame(frameProbe)
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    const readyMs = performance.now() - started

    // Two rAF boundaries: the frame that carries the new geometry, plus one so
    // the capture cannot land on the frame that merely started.
    const frameMs = await new Promise<number>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
    })
    frameStop = true

    return {
      commitMs: Math.round(commitMs * 10) / 10,
      firstYieldMs: Math.round(firstYieldMs * 10) / 10,
      readyMs: Math.round(readyMs * 10) / 10,
      ready: Boolean(snapshot?.ready),
      reasons: snapshot?.reasons ?? [],
      frameMs: Math.round(frameMs * 10) / 10,
      frames: frames.slice(-4).map(now => Math.round(now - started))
    }
  }, { action, payload })
}

async function readCounters(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const manager = win.AcApDocManager?.instance?.curDocument?.database.transactionManager
    const stack = manager?.undoStack
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
    const longTasks = win.__p212LongTasks ?? []
    const frames = win.__p212Frames ?? []
    const sorted = [...frames].sort((left, right) => left - right)
    const pct = (share: number) =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]
    return {
      slotLifecycle: view?.getSlotLifecycleMetrics?.() ?? null,
      sharedBatch: view?.getSharedBatchMetrics?.() ?? null,
      glyphBatch: view?.getGlyphBatchMetrics?.() ?? null,
      entityUpdateStats: view?.entityUpdateStats ?? null,
      snapshotSharing: manager?.getSnapshotSharingMetrics?.() ?? null,
      history: {
        undo: stack?.undoRecords?.length ?? 0,
        redo: stack?.redoRecords?.length ?? 0
      },
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      heapPeakMB: Math.round(((win.__p212HeapPeak ?? 0) / 1024 / 1024) * 10) / 10,
      frames: {
        samples: frames.length,
        p50: Math.round(pct(0.5) * 10) / 10,
        p95: Math.round(pct(0.95) * 10) / 10,
        p99: Math.round(pct(0.99) * 10) / 10,
        max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10
      },
      longTasks: {
        count: longTasks.length,
        totalMs: Math.round(longTasks.reduce((total, value) => total + value, 0) * 10) / 10,
        longestMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        over: {
          '50': longTasks.filter(value => value >= 50).length,
          '100': longTasks.filter(value => value >= 100).length,
          '500': longTasks.filter(value => value >= 500).length,
          '1000': longTasks.filter(value => value >= 1_000).length,
          '2000': longTasks.filter(value => value >= 2_000).length
        },
        sample: [...longTasks].sort((left, right) => right - left).slice(0, 30)
      }
    }
  })
}

async function resetObservers(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    win.__p212LongTasks = []
    win.__p212Frames = []
    win.__p212HeapPeak = 0
    win.__p212Slices = []
  })
}

/**
 * Per-slice probe for `batchConvert`.
 *
 * `batchConvert` is private in TypeScript but lives on the prototype at
 * runtime, so wrapping it measures the real slice cadence — how many entities
 * per call, when each call started and ended — without touching product code.
 * A MOVE makes 98 calls, so the wrapper's own cost is noise.
 *
 * This is the only way to answer "how many entities per batchConvert round and
 * when did each round run" for the baseline: neither the sampling profile (V8
 * merges calls by call path) nor the trace (no FunctionCall instrumentation)
 * can.
 */
async function installSliceProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    win.__p212Slices = []
    const view = win.AcApDocManager?.instance?.curView as unknown as
      | (Record<string, unknown> & { batchConvert?: (...args: unknown[]) => Promise<unknown> })
      | undefined
    if (!view) return false
    const proto = Object.getPrototypeOf(view) as {
      batchConvert?: (this: unknown, entities: unknown[]) => Promise<unknown>
      __p212Wrapped?: boolean
    }
    if (!proto.batchConvert) return false
    if (proto.__p212Wrapped) return true
    const original = proto.batchConvert
    proto.batchConvert = async function patched(this: unknown, entities: unknown[]) {
      const started = performance.now()
      try {
        return await original.call(this, entities)
      } finally {
        const ended = performance.now()
        win.__p212Slices!.push({
          count: Array.isArray(entities) ? entities.length : 0,
          startMs: Math.round(started * 10) / 10,
          endMs: Math.round(ended * 10) / 10,
          ms: Math.round((ended - started) * 10) / 10
        })
      }
    }
    proto.__p212Wrapped = true
    return true
  })
}

/** Slice census for one step, plus the distribution the report quotes. */
async function readSlices(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const record = win.__p212Slices ?? []
    const durations = record.map(entry => entry.ms).sort((left, right) => left - right)
    const gaps = []
    for (let index = 1; index < record.length; index++) {
      gaps.push(Math.round((record[index].startMs - record[index - 1].endMs) * 10) / 10)
    }
    const sortedGaps = [...gaps].sort((left, right) => right - left)
    return {
      calls: record.length,
      entities: record.reduce((total, entry) => total + entry.count, 0),
      maxEntitiesPerCall: record.reduce((max, entry) => Math.max(max, entry.count), 0),
      totalMs: Math.round(durations.reduce((total, value) => total + value, 0) * 10) / 10,
      maxMs: durations[durations.length - 1] ?? 0,
      medianMs: durations[Math.floor(durations.length / 2)] ?? 0,
      p95Ms: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? 0,
      // Gap between one slice's end and the next slice's start: a positive gap
      // means something ran between two slices (microtask drain, or a real
      // macrotask boundary).
      maxGapMs: sortedGaps[0] ?? 0,
      firstStartMs: record[0]?.startMs ?? 0,
      lastEndMs: record[record.length - 1]?.endMs ?? 0,
      spans: record.slice(0, 200)
    }
  })
}

/** `ReturnAsStream` is the transfer mode current Chromium honours. */
async function resolveTrace(
  cdp: CDPSession,
  complete: { value?: unknown[]; stream?: string }
): Promise<unknown[]> {
  if (Array.isArray(complete.value)) return complete.value
  if (!complete.stream) return []
  const chunks: string[] = []
  for (;;) {
    const chunk = (await cdp.send('IO.read', { handle: complete.stream })) as {
      data?: string
      base64Encoded?: boolean
      eof?: boolean
    }
    if (chunk.data) {
      chunks.push(
        chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
      )
    }
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: complete.stream })
  try {
    const parsed = JSON.parse(chunks.join('')) as { traceEvents?: unknown[] }
    return parsed.traceEvents ?? []
  } catch {
    return []
  }
}

test(`phase 2.12 MOVE conversion profile (${SIZE} ${FIXTURE})`, async ({ page }) => {
  const fixture = writeMixedFixture(SIZE, `p212${SIZE}`)
  await installObservers(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  const initialReady = await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 900_000 })
    return { ready: Boolean(snapshot?.ready), reasons: snapshot?.reasons ?? [] }
  })
  expect(initialReady.ready, `initial open never settled: ${initialReady.reasons.join(',')}`).toBe(true)

  const sharingApplied = await setSharing(page, SHARING)
  expect(sharingApplied, 'snapshotSharing is not settable on this build').toBe(SHARING)
  expect(await installSliceProbe(page), 'could not wrap batchConvert for the slice probe').toBe(true)

  if (SCHED) {
    const applied = await page.evaluate(budgetMs => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      if (!view?.setConvertScheduler) return null
      view.setConvertScheduler({ enabled: true, budgetMs })
      view.resetConversionSchedulerMetrics?.()
      return view.getConversionSchedulerMetrics?.() ?? null
    }, SCHED_BUDGET)
    expect(applied, 'this build has no convert scheduler').not.toBeNull()
  }

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLING_US })
  // Categories: `toplevel` for RunTask, `devtools.timeline` for FunctionCall /
  // TimerFire, `v8` for GC, `gpu` for upload/present, `blink.user_timing` for
  // the marks the view emits.
  await cdp.send('Tracing.start', {
    categories:
      'toplevel,devtools.timeline,v8,gpu,blink.user_timing,disabled-by-default-devtools.timeline',
    transferMode: 'ReturnAsStream'
  })
  const tracingComplete = new Promise<{ value?: unknown[]; stream?: string }>(resolve => {
    cdp.once('Tracing.tracingComplete', event => resolve(event as never))
  })

  const ids = await readDbIds(page)
  expect(ids.length).toBe(SIZE)
  const before = await readCounters(page)
  await resetObservers(page)

  // The profile covers the MOVE only: one command, one conversion, one settle.
  await cdp.send('Profiler.start')
  const move = await runStep(page, 'move', { list: ids, dx: 20, dy: 10, budget: 900_000 })
  const moveCounters = await readCounters(page)
  const moveSlices = await readSlices(page)
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }

  await cdp.send('Tracing.end')
  const trace = await tracingComplete
  const events = await resolveTrace(cdp, trace)

  // Undo / Redo are measured for wall time and correctness, not profiled: the
  // question is whether the prototype changes them, not where they spend time.
  await resetObservers(page)
  const undo = await runStep(page, 'undo', { list: ids, dx: 0, dy: 0, budget: 900_000 })
  const undoCounters = await readCounters(page)
  const undoSlices = await readSlices(page)
  await resetObservers(page)
  const redo = await runStep(page, 'redo', { list: ids, dx: 0, dy: 0, budget: 900_000 })
  const redoCounters = await readCounters(page)
  const redoSlices = await readSlices(page)

  const after = await readCounters(page)
  const dbIds = await readDbIds(page)

  fs.mkdirSync(outDir, { recursive: true })
  const profilePath = path.join(outDir, `${TAG}.cpuprofile`)
  fs.writeFileSync(profilePath, JSON.stringify(profile))
  const tracePath = path.join(outDir, `${TAG}.trace.json`)
  fs.writeFileSync(tracePath, JSON.stringify({ traceEvents: events }))

  const raw = {
    phase: '2.12',
    task: 'B',
    op: 'move',
    fixture: FIXTURE,
    size: SIZE,
    tag: TAG,
    sharing: SHARING ? 'on' : 'off',
    samplingUs: SAMPLING_US,
    sched: SCHED ? { enabled: true, budgetMs: SCHED_BUDGET } : { enabled: false },
    schedulerMetrics: await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView?.getConversionSchedulerMetrics?.() ?? null
    ),
    traceEventCount: events.length,
    steps: { move, undo, redo },
    slices: { move: moveSlices, undo: undoSlices, redo: redoSlices },
    counters: { before, move: moveCounters, undo: undoCounters, redo: redoCounters, after },
    dbIdCount: dbIds.length,
    dbIdHash: `${dbIds.length}:${String(ids.length)}`,
    artifacts: {
      profile: path.relative(repoRoot, profilePath),
      trace: path.relative(repoRoot, tracePath)
    }
  }
  fs.writeFileSync(path.join(outDir, `${TAG}.raw.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  // Only assertions that make the artifacts meaningful; the report script owns
  // the thresholds.
  expect(move.commitMs, 'the commit did not run').toBeGreaterThan(0)
  expect(events.length, 'the trace is empty').toBeGreaterThan(5_000)
  expect(move.ready, `scene never settled: ${move.reasons.join(',')}`).toBe(true)
  expect(moveCounters.longTasks.count, 'no long task during the conversion').toBeGreaterThan(0)
  expect(moveSlices.calls, 'the slice probe saw no batchConvert call').toBeGreaterThan(1)
  expect(dbIds.length).toBe(SIZE)

  console.log(
    `[phase212-b] ${TAG} commit ${move.commitMs}ms firstYield ${move.firstYieldMs}ms ` +
      `ready ${move.readyMs}ms frame ${move.frameMs}ms | undo ${undo.commitMs}/${undo.readyMs} ` +
      `redo ${redo.commitMs}/${redo.readyMs} | longTask max ${moveCounters.longTasks.longestMs}ms ` +
      `frames p95 ${moveCounters.frames.p95}ms | slices ${moveSlices.calls}×${moveSlices.maxEntitiesPerCall} ` +
      `total ${moveSlices.totalMs}ms max ${moveSlices.maxMs}ms gap ${moveSlices.maxGapMs}ms | traceEvents ${events.length}`
  )
})
