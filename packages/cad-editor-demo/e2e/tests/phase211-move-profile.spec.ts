import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type CDPSession, expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.11 Task G — where the MOVE conversion time actually goes.
 *
 * This spec collects evidence, it does not optimise anything: a V8 CPU profile
 * spanning one 50k single-command MOVE plus its settle, a DevTools trace of the
 * synchronous commit and the head of the conversion, and the queue / batch
 * counters that say how many calls ran. `e2e/helpers/phase211-profile-report.mjs`
 * turns those files into `phase211-move-conversion-profile.json`.
 *
 * The commit and conversion windows are **not** separated with page clocks:
 * `performance.now()` and CDP `MonotonicTime` are different epochs, and a
 * mis-aligned window would produce a confident wrong answer. The profile tree
 * itself carries the boundary — everything under the committed transaction is
 * the commit, everything else is view work — so the split is exact.
 *
 *   $env:P211_G_SIZE='50000'
 *   $env:P211_G_TAG='move50000'
 *   npx playwright test e2e/tests/phase211-move-profile.spec.ts
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const outDir = path.join(repoRoot, 'reports', 'phase211', 'profiles')

const SIZE = Number(process.env.P211_G_SIZE ?? 50_000)
const TAG = (process.env.P211_G_TAG ?? `move${SIZE}`).replace(/[^\w.-]/g, '_')
/** How much of the conversion the trace covers; the profile covers all of it. */
const TRACE_WINDOW_MS = Number(process.env.P211_G_TRACE_MS ?? 4_000)

test.use({ trace: 'off' })
test.setTimeout(3_600_000)

type ViewHandle = {
  waitUntilSceneReady?: (options?: { timeoutMs?: number }) => Promise<{
    ready: boolean
    reasons?: string[]
  }>
  getSlotLifecycleMetrics?: () => Record<string, number>
  getSharedBatchMetrics?: () => Record<string, unknown>
  entityUpdateStats?: Record<string, number>
  getConvertingEntityCount?: () => number
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: ViewHandle
      curDocument?: {
        database: {
          tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
          transactionManager: {
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
  __p211LongTasks?: number[]
  __p211HeapPeak?: number
}

async function installObservers(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as { __p211LongTasks?: number[]; __p211HeapPeak?: number }
    win.__p211LongTasks = []
    win.__p211HeapPeak = 0
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          win.__p211LongTasks!.push(Math.round(entry.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is Chromium-only.
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

async function waitUntilReady(page: Page, budgetMs = 900_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const started = performance.now()
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: budget })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: snapshot?.reasons ?? [],
      ms: Math.round((performance.now() - started) * 10) / 10
    }
  }, budgetMs)
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

/** Reads the counters that attribute calls, not just time. */
async function readCounters(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const manager = win.AcApDocManager?.instance?.curDocument?.database.transactionManager
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
    const longTasks = win.__p211LongTasks ?? []
    return {
      entityUpdateStats: view?.entityUpdateStats ?? null,
      slotLifecycle: view?.getSlotLifecycleMetrics?.() ?? null,
      sharedBatch: view?.getSharedBatchMetrics?.() ?? null,
      snapshotSharing: manager?.getSnapshotSharingMetrics?.() ?? null,
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      heapPeakMB: Math.round(((win.__p211HeapPeak ?? 0) / 1024 / 1024) * 10) / 10,
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((total, value) => total + value, 0),
        longestMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        over: {
          '50': longTasks.filter(value => value >= 50).length,
          '100': longTasks.filter(value => value >= 100).length,
          '500': longTasks.filter(value => value >= 500).length,
          '1000': longTasks.filter(value => value >= 1_000).length
        },
        sample: longTasks.slice(0, 40)
      }
    }
  })
}

/** `ReportEvents` hands the events back inline; `ReturnAsStream` needs IO.read. */
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
      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data)
    }
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: complete.stream })
  const text = chunks.join('')
  try {
    const parsed = JSON.parse(text) as { traceEvents?: unknown[] }
    return parsed.traceEvents ?? []
  } catch {
    return []
  }
}

test(`phase 2.11 MOVE conversion profile (${SIZE})`, async ({ page }) => {
  const fixture = writeMixedFixture(SIZE, `p211g${SIZE}`)
  await installObservers(page)
  await page.goto('/')
  await uploadFixture(page, fixture)
  expect((await waitUntilReady(page)).ready).toBe(true)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    // `ReturnAsStream` is the mode current Chromium honours; `ReportEvents` is
    // silently dropped by some channel builds, which looks like a failed trace.
    transferMode: 'ReturnAsStream'
  })
  const tracingComplete = new Promise<{ value?: unknown[]; stream?: string }>(resolve => {
    cdp.once('Tracing.tracingComplete', event => resolve(event as never))
  })

  const ids = await readDbIds(page)
  expect(ids.length).toBe(SIZE)
  const before = await readCounters(page)

  // The census must describe this MOVE only.
  await page.evaluate(() => {
    ;(window as unknown as PageWindow).__p211LongTasks = []
    ;(window as unknown as PageWindow).__p211HeapPeak = 0
  })

  await cdp.send('Profiler.start')
  const commitMs = await page.evaluate(
    ({ list, dx, dy }) => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const started = performance.now()
      doc.database.runDatabaseEdit('phase211-profile-move', () => {
        const entities = doc.entityService.getEntitiesByIds(list)
        doc.entityService.translateEntities(entities, { x: dx, y: dy, z: 0 })
      })
      return Math.round((performance.now() - started) * 10) / 10
    },
    { list: ids, dx: 20, dy: 10 }
  )

  // Trace only the head of the conversion: the tail is the same stacks.
  await page.evaluate(
    windowMs => new Promise<void>(resolve => setTimeout(resolve, windowMs)),
    TRACE_WINDOW_MS
  )
  await cdp.send('Tracing.end')
  const trace = await tracingComplete

  const settle = await waitUntilReady(page)
  expect(settle.ready, `scene never settled: ${settle.reasons.join(',')}`).toBe(true)
  const traceEnd = await page.evaluate(() => performance.now())
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
  const after = await readCounters(page)

  fs.mkdirSync(outDir, { recursive: true })
  const profilePath = path.join(outDir, `${TAG}.cpuprofile`)
  fs.writeFileSync(profilePath, JSON.stringify(profile))
  const events = await resolveTrace(cdp, trace)
  if (events.length === 0) {
    console.log(`[phase211-g] empty trace payload: ${JSON.stringify(Object.keys(trace))}`)
  }
  const tracePath = path.join(outDir, `${TAG}.trace.json`)
  fs.writeFileSync(tracePath, JSON.stringify({ traceEvents: events }))

  const raw = {
    phase: '2.11',
    task: 'G',
    op: 'move',
    size: SIZE,
    tag: TAG,
    commitMs,
    settleMs: settle.ms,
    totalMs: Math.round((commitMs + settle.ms) * 10) / 10,
    traceWindowMs: TRACE_WINDOW_MS,
    traceEventCount: events.length,
    traceRequestedAt: Math.round(traceEnd),
    entities: ids.length,
    before,
    after,
    profile: path.relative(repoRoot, profilePath),
    trace: path.relative(repoRoot, tracePath)
  }
  fs.writeFileSync(path.join(outDir, `${TAG}.raw.json`), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  // The only assertions here are the ones that make the artifacts meaningful.
  expect(commitMs, 'the commit did not run').toBeGreaterThan(0)
  expect(events.length, 'the trace is empty, so the task census would be vacuous').toBeGreaterThan(
    1_000
  )
  expect(after.longTasks.count, 'no long task was observed during the conversion').toBeGreaterThan(0)
  expect(
    (after.entityUpdateStats?.waveCount ?? 0) > (before.entityUpdateStats?.waveCount ?? 0),
    'the MOVE did not reach the entity update queue'
  ).toBe(true)

  console.log(
    `[phase211-g] ${TAG} commit ${commitMs}ms settle ${settle.ms}ms ` +
      `longTasks ${after.longTasks.count} (max ${after.longTasks.longestMs}ms) ` +
      `waves ${after.entityUpdateStats?.waveCount ?? '?'} traceEvents ${events.length}`
  )
})
