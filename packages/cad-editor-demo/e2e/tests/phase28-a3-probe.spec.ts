import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

const REPORT_DIR = resolve(process.cwd(), '../../reports/phase28')

/**
 * Phase 2.8 Task A3 probe 鈥?is the long-task signal trustworthy for work that
 * arrives through `Runtime.evaluate`?
 *
 * Phase 2.7 measured `replayMs = 204 ms` for one 50k redo while the same window
 * reported `longestTaskMs = 0`, and 1 889 ms for the undo convert drain in the
 * same spec. Before any latency work is judged on those numbers the probe has
 * to answer three questions on this exact browser:
 *
 *   1. Is `longtask` a supported entry type here?
 *   2. Does a busy loop issued from `page.evaluate` produce an entry?
 *   3. Does the same loop, driven by a `setTimeout`, produce an entry?
 *
 * It also measures the gap between successive `MessageChannel` heartbeat ticks,
 * which is what "main thread blocked for X ms" actually means and does not
 * depend on the performance timeline at all.
 *
 * Results go to `reports/phase28/a3-probe.json`.
 */

test('longtask observability for evaluate vs timer driven work', async ({ page }) => {
  await page.goto('/')

  const report = await page.evaluate(async () => {
    const entries: Array<{ duration: number; name: string; source: string }> = []
    const supported = (
      PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }
    ).supportedEntryTypes
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        entries.push({ duration: Math.round(entry.duration), name: entry.name, source: 'po' })
      }
    })
    let observed = true
    try {
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observed = false
    }

    /** Gaps between heartbeat ticks: the literal definition of blocking. */
    const gaps: number[] = []
    let running = true
    let last = performance.now()
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      if (!running) return
      const now = performance.now()
      gaps.push(Math.round(now - last))
      last = now
      channel.port2.postMessage(0)
    }
    channel.port2.postMessage(0)

    const busy = (ms: number) => {
      const started = performance.now()
      while (performance.now() - started < ms) {
        // spin
      }
      return performance.now() - started
    }

    // 1. blocking issued by this very task (`Runtime.evaluate`)
    const evaluateBusy = busy(300)

    // let the observer and heartbeat settle
    await new Promise(resolve => setTimeout(resolve, 250))
    const afterEvaluate = entries.length
    const gapsAfterEvaluate = gaps.length

    // 2. the same amount of blocking, but inside a timer task
    await new Promise<void>(resolve => {
      setTimeout(() => {
        busy(300)
        resolve()
      }, 0)
    })
    await new Promise(resolve => setTimeout(resolve, 250))

    running = false
    observer.disconnect()

    const max = (values: number[]) => (values.length ? Math.max(...values) : 0)
    return {
      supportedEntryTypes: supported ? [...supported] : null,
      observerAccepted: observed,
      evaluateBusyMs: Math.round(evaluateBusy),
      entriesAfterEvaluate: afterEvaluate,
      entriesTotal: entries.length,
      entries,
      heartbeatTicksAfterEvaluate: gapsAfterEvaluate,
      heartbeatTicks: gaps.length,
      heartbeatMaxGapMs: max(gaps),
      // Only the blocking ticks matter; the full tick list is 100 KiB of zeroes.
      blockingGapsMs: gaps.filter(gap => gap >= 50)
    }
  })

  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(
    resolve(REPORT_DIR, 'a3-probe.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  )
   
  console.log(
    `[a3] longtaskSupported=${String(report.supportedEntryTypes?.includes('longtask'))} ` +
      `entriesAfterEvaluate=${report.entriesAfterEvaluate} entriesTotal=${report.entriesTotal} ` +
      `maxGap=${report.heartbeatMaxGapMs} blockingGaps=${JSON.stringify(report.blockingGapsMs)}`
  )
  expect(report.evaluateBusyMs).toBeGreaterThanOrEqual(290)
  expect(report.heartbeatMaxGapMs).toBeGreaterThanOrEqual(250)
})
