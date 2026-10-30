import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.12 Task E — 50k MOVE production A/B, interleaved in one build.
 *
 * The Phase 2.11 A/B compared two builds, which cannot separate a scheduling
 * change from a build difference. The Phase 2.12 scheduler is behind
 * `view.setConvertScheduler({ enabled })`, defaulting to off, so both arms run
 * the *same* bundle and alternate round by round. That is the only shape in
 * which "After" means "the scheduler" and nothing else.
 *
 * Each round is one MOVE followed by one Undo (the Undo restores the geometry
 * the next round moves again, so round N+1 starts from the same state as round
 * 1). Measurements are taken per round:
 *
 * - `commitMs` — synchronous database edit,
 * - `firstYieldMs` — edit start → first `setTimeout(0)` callback. **Reading it
 *   changed with the fix**: on the baseline arm it is the length of the
 *   uninterrupted block, but once the wave yields, `scheduler.yield()`
 *   continuations outrank timer tasks, so the first timer callback lands near
 *   the end of the wave. It is a timer-ordering figure, *not* an input-latency
 *   figure; the trace gap between tasks (see the Task B profile) is the
 *   evidence that the thread is yielding. Do not quote it as responsiveness.
 * - `readyMs` — `waitUntilSceneReady()`,
 * - `frameMs` — two rAF boundaries after ready (different condition, see
 *   `PHASE212_MOVE_CONVERSION_AUDIT.md` §3),
 * - long tasks, frame intervals, heap, slot/shared-batch counters,
 * - scheduler counters (slices, yields, longest uninterrupted stretch),
 * - database / scene / spatial-index id sets, compared after every round.
 *
 * Arms come from `P212_AB_BUDGETS`; `baseline` (scheduler off) is always arm 0,
 * and `current` means the pre-2.12 path with the scheduler left disabled but
 * measured separately so the report can show it is the same as `baseline`.
 *
 *   $env:P212_AB_SIZE='50000'; $env:P212_AB_ROUNDS='10'
 *   $env:P212_AB_BUDGETS='16'; $env:P212_AB_TAG='e50k-after'
 *   npx playwright test e2e/tests/phase212-browser-ab.spec.ts
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const outDir = path.join(repoRoot, 'reports', 'phase212', 'ab')

const SIZE = Number(process.env.P212_AB_SIZE ?? 50_000)
const ROUNDS = Number(process.env.P212_AB_ROUNDS ?? 10)
const FIXTURE = process.env.P212_FIXTURE ?? 'mixed'
const TAG = (process.env.P212_AB_TAG ?? `e${SIZE}`).replace(/[^\w.-]/g, '_')
const BUDGETS = (process.env.P212_AB_BUDGETS ?? '16')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)

type Arm = {
  name: string
  enabled: boolean
  budgetMs: number
}

const ARMS: Arm[] = [
  { name: 'baseline', enabled: false, budgetMs: 0 },
  ...BUDGETS.map(budget => ({ name: `after${budget}`, enabled: true, budgetMs: budget }))
]

test.use({ trace: 'off' })
test.setTimeout(7_200_000)

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: Record<string, unknown> & {
        waitUntilSceneReady?: (options?: { timeoutMs?: number }) => Promise<{
          ready: boolean
          reasons?: string[]
        }>
        setConvertScheduler?: (options: { enabled?: boolean; budgetMs?: number }) => void
        getConversionSchedulerMetrics?: () => Record<string, number>
        resetConversionSchedulerMetrics?: () => void
        getSlotLifecycleMetrics?: () => Record<string, number>
        getSharedBatchMetrics?: () => Record<string, unknown>
        entityUpdateStats?: Record<string, number>
      }
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: { undo?: () => boolean; redo?: () => boolean }
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
}

async function installObservers(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as PageWindow
    win.__p212LongTasks = []
    win.__p212Frames = []
    win.__p212HeapPeak = 0
    try {
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

/** One command with the four clocks; identical to the Task B spec. */
async function runMove(page: Page, list: string[], dx: number, dy: number) {
  return page.evaluate(
    async ({ list, dx, dy }) => {
      const win = window as unknown as PageWindow
      const instance = win.AcApDocManager?.instance
      const doc = instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const view = instance?.curView
      const manager = doc.database.transactionManager

      const started = performance.now()
      doc.database.runDatabaseEdit('phase212-ab-move', () => {
        const entities = doc.entityService.getEntitiesByIds(list)
        doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
      })
      const commitMs = performance.now() - started

      const firstYieldMs = await new Promise<number>(resolve => {
        setTimeout(() => resolve(performance.now() - started), 0)
      })

      const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 1_800_000 })
      const readyMs = performance.now() - started
      const frameMs = await new Promise<number>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
      })

      return {
        commitMs: Math.round(commitMs * 10) / 10,
        firstYieldMs: Math.round(firstYieldMs * 10) / 10,
        readyMs: Math.round(readyMs * 10) / 10,
        ready: Boolean(snapshot?.ready),
        reasons: snapshot?.reasons ?? [],
        frameMs: Math.round(frameMs * 10) / 10
      }
    },
    { list, dx, dy }
  )
}

/** Undo back to the pre-round state. No clocks: this arm is not being compared. */
async function undo(page: Page) {
  return page.evaluate(async () => {
    const win = window as unknown as PageWindow
    const instance = win.AcApDocManager?.instance
    const manager = instance?.curDocument?.database.transactionManager
    const view = instance?.curView
    const ok = manager?.undo?.()
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 1_800_000 })
    return { ok: Boolean(ok), ready: Boolean(snapshot?.ready), reasons: snapshot?.reasons ?? [] }
  })
}

async function setArm(page: Page, arm: Arm) {
  return page.evaluate(options => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view?.setConvertScheduler) return null
    view.setConvertScheduler({ enabled: options.enabled, budgetMs: options.budgetMs })
    view.resetConversionSchedulerMetrics?.()
    return true
  }, arm)
}

async function resetObservers(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    win.__p212LongTasks = []
    win.__p212Frames = []
    win.__p212HeapPeak = 0
  })
}

/**
 * Everything E2 asks for that is readable after the scene settled, plus the
 * three id sets. Scene and index sets come from the same accessors the phase
 * 2.11 slot matrix uses (`layout.collectObjectIds`, `_spatialIndex.search`).
 */
async function readRoundCounters(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const doc = win.AcApDocManager?.instance?.curDocument
    const longTasks = win.__p212LongTasks ?? []
    const frames = [...(win.__p212Frames ?? [])].sort((left, right) => left - right)
    const pct = (share: number) =>
      frames.length === 0 ? 0 : frames[Math.min(frames.length - 1, Math.floor(frames.length * share))]
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }

    const dbIds: string[] = []
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (iterator) for (const entity of iterator) dbIds.push(String(entity.objectId))

    const layouts = (view as { _scene?: { _layouts?: Map<string, unknown> } })?._scene?._layouts
    const layoutValues = layouts instanceof Map ? Array.from(layouts.values()) : []

    const sceneIds: string[] = []
    const indexIds: string[] = []
    let renderables = 0
    let object3dNodes = 0
    const geometrySet = new Set<unknown>()
    for (const layout of layoutValues) {
      const collect = (layout as { collectObjectIds?: () => Set<string> }).collectObjectIds
      if (typeof collect === 'function') {
        for (const id of collect.call(layout)) sceneIds.push(String(id))
      }
      const index = (layout as {
        _spatialIndex?: { search: (box: Record<string, number>) => Array<{ id: string }> }
      })._spatialIndex
      for (const item of index?.search?.({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }) ?? []) {
        indexIds.push(String(item.id))
      }
      ;(
        layout as { _group?: { traverse: (fn: (node: unknown) => void) => void } }
      )?._group?.traverse(node => {
        object3dNodes++
        const drawable = node as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; geometry?: unknown }
        if (!drawable.isMesh && !drawable.isLine && !drawable.isPoints) return
        renderables++
        if (drawable.geometry) geometrySet.add(drawable.geometry)
      })
    }

    const dbSet = new Set(dbIds)
    const sceneSet = new Set(sceneIds)
    const indexSet = new Set(indexIds)
    const renderer = (view as { renderer?: { _renderer?: { info?: Record<string, unknown> } } })
      ?.renderer?._renderer?.info as { memory?: { geometries?: number } } | undefined

    return {
      longTasks: {
        count: longTasks.length,
        totalMs: Math.round(longTasks.reduce((total, value) => total + value, 0) * 10) / 10,
        longestMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        over50: longTasks.filter(value => value >= 50).length,
        over200: longTasks.filter(value => value >= 200).length,
        over1000: longTasks.filter(value => value >= 1000).length
      },
      frames: {
        samples: frames.length,
        p50: Math.round(pct(0.5) * 10) / 10,
        p95: Math.round(pct(0.95) * 10) / 10,
        max: Math.round((frames[frames.length - 1] ?? 0) * 10) / 10
      },
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      heapPeakMB: Math.round(((win.__p212HeapPeak ?? 0) / 1024 / 1024) * 10) / 10,
      scheduler: view?.getConversionSchedulerMetrics?.() ?? null,
      slotLifecycle: view?.getSlotLifecycleMetrics?.() ?? null,
      sharedBatch: view?.getSharedBatchMetrics?.() ?? null,
      entityUpdateStats: view?.entityUpdateStats ?? null,
      renderer: {
        geometries: renderer?.memory?.geometries ?? null,
        object3dNodes,
        renderables,
        uniqueGeometry: geometrySet.size
      },
      ids: {
        db: dbIds.length,
        scene: sceneIds.length,
        index: indexIds.length,
        missingInScene: dbIds.filter(id => !sceneSet.has(id)).length,
        residualInScene: sceneIds.filter(id => !dbSet.has(id)).length,
        missingInIndex: sceneIds.filter(id => !indexSet.has(id)).length,
        residualInIndex: indexIds.filter(id => !sceneSet.has(id)).length
      }
    }
  })
}

test(`phase 2.12 MOVE A/B (${SIZE} ${FIXTURE})`, async ({ page }) => {
  const fixture = writeMixedFixture(SIZE, `p212ab${SIZE}`)
  await installObservers(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  const opened = await page.evaluate(async () => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance
    const view = manager?.curView
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 1_800_000 })
    // Diagnostics for the production-build cell: a bare `ready:false` with no
    // reasons means the helper itself was missing, not that the scene failed to
    // settle. Keep them in the assertion message so a failing arm is debuggable
    // without a re-run.
    return {
      ready: Boolean(snapshot?.ready),
      reasons: snapshot?.reasons ?? [],
      hasManager: Boolean(manager),
      hasDocument: Boolean(manager?.curDocument),
      hasView: Boolean(view),
      hasWait: typeof view?.waitUntilSceneReady === 'function',
      readyState: document.readyState
    }
  })
  expect(
    opened.ready,
    `initial open never settled: reasons=[${opened.reasons.join(',')}] ` +
      `manager=${opened.hasManager} doc=${opened.hasDocument} view=${opened.hasView} ` +
      `wait=${opened.hasWait} readyState=${opened.readyState}`
  ).toBe(true)

  const ids = await page.evaluate(() => {
    const iterator = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument?.database
      .tables.blockTable.modelSpace.newIterator()
    const out: string[] = []
    if (iterator) for (const entity of iterator) out.push(String(entity.objectId))
    return out
  })
  expect(ids.length).toBe(SIZE)

  const rounds: Array<Record<string, unknown>> = []
  for (let round = 0; round < ROUNDS; round++) {
    const arm = ARMS[round % ARMS.length]
    const applied = await setArm(page, arm)
    expect(applied, 'the build has no convert scheduler to switch').toBe(true)
    await resetObservers(page)

    // Alternate the displacement direction so a MOVE never lands on the exact
    // place it started from (which would make a ghost unobservable).
    const step = (round + 1) * 10
    const move = await runMove(page, ids, round % 2 === 0 ? step : -step, step)
    const counters = await readRoundCounters(page)

    rounds.push({ round, arm: arm.name, budgetMs: arm.budgetMs, move, ...counters })

    // Every round is asserted immediately: a ghost or a missing drawable must
    // fail the round that produced it, not the end of the run.
    expect(move.ready, `round ${round} (${arm.name}) never settled: ${move.reasons.join(',')}`).toBe(true)
    expect(counters.ids.missingInScene, `round ${round} (${arm.name}) lost ${counters.ids.missingInScene} drawables`).toBe(0)
    expect(counters.ids.residualInScene, `round ${round} (${arm.name}) keeps ${counters.ids.residualInScene} ghosts`).toBe(0)
    expect(counters.ids.missingInIndex, `round ${round} (${arm.name}) index misses ${counters.ids.missingInIndex} entities`).toBe(0)
    expect(counters.ids.residualInIndex, `round ${round} (${arm.name}) index keeps ${counters.ids.residualInIndex} stale entries`).toBe(0)

    const back = await undo(page)
    expect(back.ready, `round ${round} undo never settled: ${back.reasons.join(',')}`).toBe(true)
  }

  const payload = {
    phase: '2.12',
    task: 'E',
    fixture: FIXTURE,
    size: SIZE,
    rounds: ROUNDS,
    arms: ARMS,
    interleaved: true,
    note:
      'Both arms run the same bundle; the only difference is view.setConvertScheduler({ enabled }). ' +
      'firstYieldMs is a timer-ordering figure: with the scheduler on, prioritized continuations delay ' +
      'the first setTimeout(0) callback, so a larger value does not mean a longer block. Longest-task and ' +
      'frame-interval columns are the responsiveness evidence.',
    measurements: rounds
  }
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${TAG}.json`)
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const summary = ARMS.map(arm => {
    const armRounds = rounds.filter(entry => entry.arm === arm.name) as Array<{
      move: { firstYieldMs: number; readyMs: number; commitMs: number }
      longTasks: { longestMs: number }
      scheduler: { yields?: number; maxTaskMs?: number; maxSliceMs?: number } | null
    }>
    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right)
      return sorted.length === 0 ? 0 : Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10
    }
    return {
      arm: arm.name,
      budgetMs: arm.budgetMs,
      samples: armRounds.length,
      firstYieldMs: median(armRounds.map(entry => entry.move.firstYieldMs)),
      readyMs: median(armRounds.map(entry => entry.move.readyMs)),
      commitMs: median(armRounds.map(entry => entry.move.commitMs)),
      longestTaskMs: median(armRounds.map(entry => entry.longTasks.longestMs)),
      yields: median(armRounds.map(entry => entry.scheduler?.yields ?? 0)),
      maxTaskMs: median(armRounds.map(entry => entry.scheduler?.maxTaskMs ?? 0))
    }
  })

  console.log(`[phase212-e] ${TAG} ${SIZE} x ${ROUNDS} rounds, arms ${ARMS.map(a => a.name).join('/')}`)
  for (const row of summary) {
    console.log(
      `  ${row.arm.padEnd(10)} budget ${String(row.budgetMs).padStart(3)}ms  n=${row.samples}  ` +
        `commit ${row.commitMs}  firstYield ${row.firstYieldMs}  ready ${row.readyMs}  ` +
        `longestTask ${row.longestTaskMs}  yields ${row.yields}  maxStretch ${row.maxTaskMs}`
    )
  }
  console.log(`  wrote ${path.relative(repoRoot, outFile).replace(/\\/g, '/')}`)
})
