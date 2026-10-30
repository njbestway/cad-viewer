/**
 * Phase 2.13 Task B - real input latency probe.
 *
 * Why this exists: Phase 2.12 reported `firstYieldMs` as if it were input
 * latency. It is not - it is when a `setTimeout(0)` callback ran, and with
 * prioritized continuations that moves *later*, not earlier. Task A3 of this
 * phase retires that number. Responsiveness now comes from three independent
 * sources, none of which is a timer:
 *
 * 1. **Event Timing API** (`PerformanceObserver`, `type: 'event'`). For each
 *    trusted input event Chromium reports `startTime` (the browser queued it),
 *    `processingStart` (the handler began), `processingEnd` (the last listener
 *    returned) and `duration` (until the next frame containing the response was
 *    presented). So one entry already contains the four page-side points of
 *    Task B1: browser-received, listener-start, handler-end, response-painted.
 *    No page-side timer is involved, so a blocked main thread cannot distort
 *    them.
 * 2. **JS listeners** on pointerdown / pointermove / keydown / wheel / click,
 *    recording `event.timeStamp` (same clock as `performance.now()` for trusted
 *    events) and when the capture listener ran. This is the cross-check for
 *    `processingStart`, and the drop / reorder detector. It deliberately does
 *    not report a handler *duration*: a passive capture listener returns
 *    immediately, so the only honest handler-end value is the Event Timing
 *    `processingEnd` above.
 * 3. **Node-side task pings**: `Runtime.evaluate` fired at ~20 ms without
 *    awaiting, so a round trip that takes 500 ms means the main thread could
 *    not run a trivial task for 500 ms. This is the "maximum event-loop gap"
 *    figure; it is measured from outside the blocked thread, which is the only
 *    way to see a gap the page cannot report.
 *
 * Events are dispatched through CDP `Input.*` from the *browser* process, i.e.
 * they go through the real input pipeline (hit testing, pointer capture,
 * coalescing), not through `dispatchEvent`.
 */

import type { CDPSession, Page } from '@playwright/test'

export type InputProbeStats = {
  eventTiming: {
    count: number
    /** `processingStart - startTime`: how long the event waited behind script. */
    delayP50: number
    delayP95: number
    delayMax: number
    /** `processingEnd - processingStart`: the handler work itself. */
    processingP95: number
    processingMax: number
    /** `duration`: until the response frame was presented. */
    responseP50: number
    responseP95: number
    responseMax: number
    byType: Record<string, { count: number; delayMax: number; delayP95: number }>
  }
  handlers: {
    count: number
    delayP50: number
    delayP95: number
    delayMax: number
    byType: Record<string, { count: number; delayP50: number; delayP95: number; delayMax: number }>
  }
  /** Events the page saw per type, to prove nothing was dropped or reordered. */
  order: {
    count: number
    outOfOrder: number
    duplicates: number
    outOfOrderByType: Record<string, number>
    /** Cross-stream inversions: normal for mouse vs keyboard, recorded for evidence. */
    outOfOrderCrossType: number
  }
  raw: Array<{ type: string; timeStamp: number; handlerStart: number; delay: number }>
}

/** Installs the observers before the document is opened. */
export async function installInputProbe(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>
    const state = {
      events: [] as Array<{ type: string; timeStamp: number; handlerStart: number; delay: number }>,
      timing: [] as Array<{ name: string; startTime: number; processingStart: number; processingEnd: number; duration: number }>,
      lastTimeStamp: 0,
      lastByType: {} as Record<string, number>,
      outOfOrder: 0,
      outOfOrderByType: {} as Record<string, number>,
      // Recorded but never asserted: see the ordering note below.
      outOfOrderCrossType: 0,
      duplicates: new Set<string>(),
      duplicateCount: 0,
      installed: true
    }
    win.__p213Input = state

    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries() as Array<PerformanceEventTiming>) {
          state.timing.push({
            name: entry.name,
            startTime: Math.round(entry.startTime * 10) / 10,
            processingStart: Math.round(entry.processingStart * 10) / 10,
            processingEnd: Math.round(entry.processingEnd * 10) / 10,
            duration: Math.round(entry.duration * 10) / 10
          })
        }
      }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit)
    } catch {
      // Older engines: the JS listeners below still produce a delay figure.
    }

    const TYPES = ['pointerdown', 'pointerup', 'pointermove', 'click', 'keydown', 'keyup', 'wheel']
    for (const type of TYPES) {
      // Capture phase + passive where possible: the probe must not change what
      // the app sees, and it must still record an event whose handler is slow.
      window.addEventListener(
        type,
        event => {
          const handlerStart = performance.now()
          const stamp = Number(event.timeStamp)
          const key = `${type}:${stamp}`
          if (state.duplicates.has(key)) state.duplicateCount++
          else state.duplicates.add(key)
          // Ordering is only defined *within* one input stream. Mouse and
          // keyboard events travel separate routes into the renderer, so the
          // interleaving of a mousemove and a keydown from two CDP calls has no
          // promised order - counting that as "reordered input" would flag the
          // browser for behaving normally. Per-type monotonicity is the real
          // question: did a pointermove that was dispatched after another
          // pointermove get handled before it.
          const previous = state.lastByType[type] ?? 0
          if (stamp < previous) {
            state.outOfOrder++
            state.outOfOrderByType[type] = (state.outOfOrderByType[type] ?? 0) + 1
          }
          state.lastByType[type] = stamp
          if (stamp < state.lastTimeStamp) state.outOfOrderCrossType += 1
          state.lastTimeStamp = stamp
          state.events.push({
            type,
            timeStamp: Math.round(stamp * 10) / 10,
            handlerStart: Math.round(handlerStart * 10) / 10,
            delay: Math.round((handlerStart - stamp) * 10) / 10
          })
        },
        { capture: true, passive: true }
      )
    }
  })
}

type RawEvent = { type: string; timeStamp: number; handlerStart: number; delay: number }
type RawTiming = { name: string; startTime: number; processingStart: number; processingEnd: number; duration: number }

const pct = (values: number[], share: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] * 10) / 10
}

export async function readInputProbe(
  page: Page,
  /** Page-clock window (`performance.now()`) the samples must fall into. */
  window?: { from: number; to: number }
): Promise<InputProbeStats> {
  const raw = await page.evaluate(() => {
    const state = (window as unknown as Record<string, unknown>).__p213Input as
      | {
          events: Array<{ type: string; timeStamp: number; handlerStart: number; delay: number }>
          timing: Array<{
            name: string
            startTime: number
            processingStart: number
            processingEnd: number
            duration: number
          }>
          outOfOrder: number
          outOfOrderByType: Record<string, number>
          outOfOrderCrossType: number
          duplicateCount: number
        }
      | undefined
    return {
      events: state?.events ?? [],
      timing: state?.timing ?? [],
      outOfOrder: state?.outOfOrder ?? 0,
      outOfOrderByType: state?.outOfOrderByType ?? {},
      outOfOrderCrossType: state?.outOfOrderCrossType ?? 0,
      duplicateCount: state?.duplicateCount ?? 0
    }
  })

  const allEvents = raw.events as RawEvent[]
  // Delay statistics are windowed (see above); delivery and ordering are not.
  // Filtering *those* would turn "handled slightly after the window closed" into
  // a reported event loss, which is a measurement artefact, not a dropped event.
  const events = allEvents.filter(
    entry => !window || (entry.handlerStart >= window.from && entry.handlerStart <= window.to)
  )
  // Event Timing entries are batched per frame, so a blocked main thread hands
  // them over late. Without the window a round would inherit entries for events
  // that belong to the previous one.
  const timing = (raw.timing as RawTiming[]).filter(
    entry => !window || (entry.startTime >= window.from && entry.startTime <= window.to)
  )
  const delays = timing.map(entry => Math.max(0, entry.processingStart - entry.startTime))
  const processing = timing.map(entry => Math.max(0, entry.processingEnd - entry.processingStart))
  const response = timing.map(entry => Math.max(0, entry.duration))
  const grouped: Record<string, number[]> = {}
  for (const entry of timing) {
    const key = entry.name
    grouped[key] = grouped[key] ?? []
    grouped[key].push(Math.max(0, entry.processingStart - entry.startTime))
  }

  const handlerByType: Record<string, number[]> = {}
  for (const event of events) {
    handlerByType[event.type] = handlerByType[event.type] ?? []
    handlerByType[event.type].push(event.delay)
  }

  return {
    eventTiming: {
      count: timing.length,
      delayP50: pct(delays, 0.5),
      delayP95: pct(delays, 0.95),
      delayMax: delays.length > 0 ? Math.max(...delays) : 0,
      processingP95: pct(processing, 0.95),
      processingMax: processing.length > 0 ? Math.max(...processing) : 0,
      responseP50: pct(response, 0.5),
      responseP95: pct(response, 0.95),
      responseMax: response.length > 0 ? Math.max(...response) : 0,
      byType: Object.fromEntries(
        Object.entries(grouped).map(([name, values]) => [
          name,
          { count: values.length, delayMax: Math.max(...values), delayP95: pct(values, 0.95) }
        ])
      )
    },
    handlers: {
      count: events.length,
      delayP50: pct(
        events.map(entry => entry.delay),
        0.5
      ),
      delayP95: pct(
        events.map(entry => entry.delay),
        0.95
      ),
      delayMax: events.length > 0 ? Math.max(...events.map(entry => entry.delay)) : 0,
      byType: Object.fromEntries(
        Object.entries(handlerByType).map(([name, values]) => [
          name,
          {
            count: values.length,
            delayP50: pct(values, 0.5),
            delayP95: pct(values, 0.95),
            delayMax: Math.max(...values)
          }
        ])
      )
    },
    order: {
      count: allEvents.length,
      outOfOrder: raw.outOfOrder as number,
      duplicates: raw.duplicateCount as number,
      outOfOrderByType: raw.outOfOrderByType as Record<string, number>,
      outOfOrderCrossType: raw.outOfOrderCrossType as number
    },
    raw: allEvents
  }
}

export async function resetInputProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as Record<string, unknown>).__p213Input as
      | {
          events: unknown[]
          timing: unknown[]
          outOfOrder: number
          outOfOrderByType: Record<string, number>
          outOfOrderCrossType?: number
          duplicateCount: number
          lastTimeStamp: number
          lastByType: Record<string, number>
        }
      | undefined
    if (!state) return
    state.events.length = 0
    state.timing.length = 0
    state.outOfOrder = 0
    state.outOfOrderByType = {}
    state.outOfOrderCrossType = 0
    state.duplicateCount = 0
    state.lastTimeStamp = 0
    state.lastByType = {}
  })
}

/**
 * Fires a stream of real input events at the browser while the page is busy.
 *
 * The promises are deliberately *not* awaited in the loop: awaiting would
 * serialise the driver behind the blocked renderer and hide the delay that the
 * probe is supposed to measure.
 */
export async function driveInput(
  cdp: CDPSession,
  page: Page,
  durationMs: number,
  stopWhen?: () => boolean
) {
  const started = Date.now()
  const pending: Array<Promise<unknown>> = []
  const sentByType: Record<string, number> = {}
  const sendErrors: Record<string, number> = {}
  // Counted on *success*, not on the call: a rejected `Input.dispatch*` never
  // reached the browser, so counting it as sent would report it as a dropped
  // event later.
  const fire = (type: string, promise: Promise<unknown>) => {
    pending.push(
      promise
        .then(() => {
          sentByType[type] = (sentByType[type] ?? 0) + 1
        })
        .catch(() => {
          sendErrors[type] = (sendErrors[type] ?? 0) + 1
        })
    )
  }
  let sent = 0
  let step = 0
  while (Date.now() - started < durationMs && !stopWhen?.()) {
    const x = 40 + (step % 40)
    const y = 40 + (step % 20)
    fire(
      'pointermove',
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    )
    sent++
    if (step % 7 === 0) {
      fire('keydown', cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 65, key: 'a' }))
      fire('keyup', cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, key: 'a' }))
      sent += 2
    }
    if (step % 13 === 0) {
      // Task B1 asks for wheel input too. Wheel is coalescable: our capture
      // listener is passive, and a passive wheel listener lets the renderer fold
      // pending wheel events into one dispatch at the frame boundary. So wheel is
      // only bounded, never required to arrive one for one - the discrete types
      // below (`pointerdown`/`pointerup` plus `keydown`/`keyup`) carry the
      // delivery check.
      fire(
        'wheel',
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX: 0,
          deltaY: step % 2 === 0 ? 40 : -40
        })
      )
      sent++
    }
    if (step % 11 === 0) {
      fire(
        'pointerdown',
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 1
        })
      )
      fire(
        'pointerup',
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 0
        })
      )
      sent += 2
    }
    step++
    // 8 ms is below one frame: the intent is to keep the input queue non-empty
    // for the whole conversion, not to saturate it.
    await new Promise(resolve => setTimeout(resolve, 8))
  }
  // Drain without letting a rejected send escape.
  await Promise.allSettled(pending)
  void page
  // Only counts are returned. Task B1 point 1 ("event submitted") lives on the
  // driver clock, and the driver clock has its own origin: subtracting it from
  // any page timestamp would be a clock mix-up, not a measurement. Everything
  // after submission is dated by the browser's Event Timing instead.
  //
  // `sentByType` exists because `sent` alone cannot prove delivery: the renderer
  // coalesces `mousemove` (N moves in, fewer `pointermove` out by design) and
  // folds passive `wheel` the same way, so a raw sent/received ratio would read
  // as "events dropped". `pointerdown`/`pointerup`/`keydown`/`keyup` are the
  // types that must arrive one for one, which is what the delivery check uses.
  return { sent, sentByType, sendErrors, steps: step, elapsedMs: Date.now() - started }
}

/**
 * Node-side event-loop gap probe.
 *
 * Each ping is a fire-and-forget `Runtime.evaluate`; the round trip can only
 * complete when the renderer's main thread takes a task. `maxRttMs` is
 * therefore the longest stretch during which the page could not run *anything*
 * - which is what a long task actually costs, measured from outside.
 */
export class TaskPingProbe {
  private readonly samples: Array<{ at: number; rtt: number }> = []
  private stopped = false
  private loop: Promise<void> | null = null

  constructor(
    private readonly cdp: CDPSession,
    private readonly intervalMs = 20
  ) {}

  start() {
    this.loop = (async () => {
      while (!this.stopped) {
        const sentAt = performance.now()
        const pending = this.cdp
          .send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true })
          .then(() => {
            this.samples.push({ at: Math.round(sentAt), rtt: Math.round((performance.now() - sentAt) * 10) / 10 })
          })
          .catch(() => undefined)
        // Do not await: the next ping goes out while this one is still queued.
        void pending
        await new Promise(resolve => setTimeout(resolve, this.intervalMs))
      }
    })()
  }

  async stop() {
    this.stopped = true
    await this.loop
    // Let the last in-flight pings land.
    await new Promise(resolve => setTimeout(resolve, 250))
    const values = this.samples.map(sample => sample.rtt)
    return {
      samples: values.length,
      p50: pct(values, 0.5),
      p95: pct(values, 0.95),
      maxRttMs: values.length > 0 ? Math.max(...values) : 0
    }
  }
}
