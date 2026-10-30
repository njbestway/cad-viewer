import type { Page } from '@playwright/test'

/**
 * Main-thread latency probe for the Phase 2.8 browser measurements.
 *
 * Four independent signals, because no single one is trustworthy on its own:
 *
 * - `syncSteps` — `performance.now()` deltas reported by the page itself around
 *   the call under test. Exact for the synchronous part, blind to everything
 *   the call schedules.
 * - `maxBlockMs` / `blockingGapsMs` — gaps between successive `MessageChannel`
 *   ticks. This is the literal definition of "the main thread was blocked for X
 *   ms" and it sees blocking from *any* source.
 * - `longTasks` — `PerformanceObserver('longtask')`. Corroborates, but only for
 *   tasks the renderer attributes: work issued through CDP `Runtime.evaluate`
 *   (which is how every step in these specs is driven) produces **no** entry,
 *   while the identical work in a timer task produces one. Phase 2.7 read the
 *   resulting zeros as "no blocking"; that is exactly what this probe fixes.
 * - `frames` — rAF intervals, i.e. whether anything reached the screen. A
 *   window with no frames means the scene settled without ever presenting, so
 *   the frame numbers stay `null` rather than being reported as fast.
 *
 * Every window records `hidden`, because a background tab throttles rAF into
 * multi-second gaps that would otherwise look like blocking.
 */

export interface LatencyWindow {
  windowMs: number
  hidden: boolean
  /** Synchronous durations reported by the page inside this window. */
  syncSteps: Array<{ name: string; ms: number }>
  /** Sum of all sync steps, i.e. the work the caller measured itself. */
  syncTotalMs: number
  /** Gaps between heartbeat ticks; only gaps >= 50 ms are kept. */
  blockingGapsMs: number[]
  blockingCount: number
  blockingTotalMs: number
  maxBlockMs: number
  tickCount: number
  longTaskCount: number
  longTaskTotalMs: number
  longestTaskMs: number
  frameCount: number
  frameP50Ms: number | null
  frameP95Ms: number | null
  frameMaxMs: number | null
  /** True when at least one frame was presented inside the window. */
  framePresented: boolean
  heapPeakMB: number
}

interface ProbeState {
  sampling: boolean
  hidden: boolean
  windowStart: number
  ticks: number
  gaps: number[]
  frames: number[]
  longTasks: number[]
  syncSteps: Array<{ name: string; ms: number }>
  heapPeak: number
  lastTickAt: number
  lastFrameAt: number
}

/** Installs the heartbeat, the rAF sampler and the long-task observer. */
export async function installLatencyProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __lat?: ProbeState }
    if (win.__lat) return
    const state: ProbeState = {
      sampling: false,
      hidden: false,
      windowStart: 0,
      ticks: 0,
      gaps: [],
      frames: [],
      longTasks: [],
      syncSteps: [],
      heapPeak: 0,
      lastTickAt: 0,
      lastFrameAt: 0
    }
    win.__lat = state

    document.addEventListener('visibilitychange', () => {
      state.hidden = document.visibilityState === 'hidden'
      // Re-baseline so a throttled period cannot be charged to the next window.
      state.lastTickAt = performance.now()
      state.lastFrameAt = 0
    })

    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      const now = performance.now()
      state.ticks++
      if (state.lastTickAt > 0) {
        const gap = now - state.lastTickAt
        if (state.sampling && gap >= 50) state.gaps.push(Math.round(gap))
      }
      state.lastTickAt = now
      if (state.sampling) {
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } })
          .memory?.usedJSHeapSize
        if (typeof heap === 'number' && heap > state.heapPeak) state.heapPeak = heap
      }
      channel.port2.postMessage(0)
    }
    channel.port2.postMessage(0)

    const onFrame = () => {
      const now = performance.now()
      if (state.sampling && state.lastFrameAt > 0) {
        state.frames.push(Math.round((now - state.lastFrameAt) * 10) / 10)
      }
      state.lastFrameAt = now
      requestAnimationFrame(onFrame)
    }
    requestAnimationFrame(onFrame)

    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (state.sampling) state.longTasks.push(Math.round(entry.duration))
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // Not supported: `longTaskCount` stays 0 and the heartbeat carries the
      // blocking claim on its own.
    }
  })
}

/** Opens a measurement window. */
export async function beginWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __lat?: ProbeState }).__lat
    if (!state) throw new Error('latency probe not installed')
    state.sampling = false
    state.gaps.length = 0
    state.frames.length = 0
    state.longTasks.length = 0
    state.syncSteps.length = 0
    state.heapPeak = 0
    state.windowStart = performance.now()
    state.lastFrameAt = 0
    state.sampling = true
  })
}

/**
 * Closes the window and summarizes it.
 *
 * The trailing wait is a real macrotask tick: long-task entries are delivered
 * *after* the task that produced them ends, so reading immediately loses the
 * last one — which is always the interesting one.
 */
export async function endWindow(page: Page): Promise<LatencyWindow> {
  await page.waitForTimeout(150)
  return page.evaluate(() => {
    const state = (window as unknown as { __lat?: ProbeState }).__lat
    if (!state) throw new Error('latency probe not installed')
    state.sampling = false
    const windowMs = Math.round((performance.now() - state.windowStart) * 10) / 10
    const sorted = [...state.frames].sort((a, b) => a - b)
    const at = (fraction: number) =>
      sorted.length === 0
        ? null
        : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    const gaps = [...state.gaps].sort((a, b) => b - a)
    const syncTotal = state.syncSteps.reduce((sum, step) => sum + step.ms, 0)
    return {
      windowMs,
      hidden: state.hidden,
      syncSteps: [...state.syncSteps],
      syncTotalMs: Math.round(syncTotal * 10) / 10,
      blockingGapsMs: gaps,
      blockingCount: gaps.length,
      blockingTotalMs: gaps.reduce((sum, gap) => sum + gap, 0),
      maxBlockMs: gaps.length === 0 ? 0 : gaps[0],
      tickCount: state.ticks,
      longTaskCount: state.longTasks.length,
      longTaskTotalMs: state.longTasks.reduce((sum, value) => sum + value, 0),
      longestTaskMs: state.longTasks.length === 0 ? 0 : Math.max(...state.longTasks),
      frameCount: sorted.length,
      frameP50Ms: at(0.5),
      frameP95Ms: at(0.95),
      frameMaxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
      framePresented: sorted.length > 0,
      heapPeakMB: Math.round((state.heapPeak / 1048576) * 10) / 10
    }
  })
}
