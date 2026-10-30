import {
  ACTR_CONVERT_SCHEDULER_DEFAULT,
  AcTrConvertScheduler
} from '../src/view/AcTrConvertScheduler'

/**
 * Phase 2.12 Task D — convert-wave scheduler.
 *
 * The scheduler exists to answer one question from the profile
 * (`PHASE212_MOVE_CONVERSION_AUDIT.md` §7): a 50k MOVE ran 98 slices of ~26 ms
 * in a single 2834 ms task because the yield budget lived on a gate that was
 * rebuilt per `batchConvert` call, and because `await` never ends a task. These
 * tests pin the two properties that fix it — the budget survives across slices,
 * and the yield is a macrotask — plus the property that makes an interleaved
 * A/B possible: disabled really is disabled.
 */

/** Awaits one macrotask, whatever primitive the environment has. */
function tick(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof MessageChannel === 'function') {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        resolve()
      }
      channel.port2.postMessage(0)
      return
    }
    setTimeout(resolve, 0)
  })
}

describe('convert wave scheduler', () => {
  test('is off by default and then does nothing at all', async () => {
    expect(ACTR_CONVERT_SCHEDULER_DEFAULT.enabled).toBe(false)
    const scheduler = new AcTrConvertScheduler()
    expect(scheduler.enabled).toBe(false)

    scheduler.beginWave(0)
    // A budget of zero would yield on every call if the flag were consulted
    // second; the flag has to win.
    const enabled = new AcTrConvertScheduler({ enabled: false, budgetMs: 0 })
    enabled.beginWave(0)
    await expect(enabled.maybeYield(1e9)).resolves.toBe(false)

    scheduler.recordSlice(40, 512)
    scheduler.endWave(1e9)
    expect(scheduler.stats).toMatchObject({
      waves: 0,
      slices: 0,
      entities: 0,
      yields: 0,
      maxSliceMs: 0
    })
    await expect(tick()).resolves.toBeUndefined()
  })

  test('holds the budget across slices instead of resetting per call', async () => {
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 30 })
    scheduler.beginWave(1000)

    // Three slices of 26 ms each: 78 ms of work, so the third must yield even
    // though every individual slice is under budget. That is exactly the
    // condition the per-call `AcCmUiYieldGate` could not express.
    await expect(scheduler.maybeYield(1000)).resolves.toBe(false)
    scheduler.recordSlice(26, 512)
    await expect(scheduler.maybeYield(1026)).resolves.toBe(false)
    scheduler.recordSlice(26, 512)
    await expect(scheduler.maybeYield(1052)).resolves.toBe(true)
    scheduler.recordSlice(26, 512)

    const stats = scheduler.stats
    expect(stats.yields).toBe(1)
    expect(stats.slices).toBe(3)
    expect(stats.entities).toBe(1536)
    expect(stats.waves).toBe(1)
    scheduler.endWave(1200)
    expect(scheduler.stats.maxTaskMs).toBeGreaterThanOrEqual(52)
  })

  test('the yield is a macrotask, not a microtask', async () => {
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 0 })
    // A `setTimeout(0)` chain would be clamped to ~4 ms after five nesting
    // levels; 98 slices would then pay ~390 ms of pure waiting. The chosen
    // primitive has to be one of the two unclamped task boundaries.
    expect(['scheduler.yield', 'MessageChannel']).toContain(scheduler.stats.yieldPrimitive)

    scheduler.beginWave(0)
    const order: string[] = []
    const pending = (async () => {
      // Runs before the yield resolves only if the yield is a real task
      // boundary; a resolved promise or a microtask would let it run first.
      setTimeout(() => order.push('timer'), 0)
      queueMicrotask(() => order.push('microtask'))
      await scheduler.maybeYield(1e9)
      order.push('resumed')
    })()
    await pending
    expect(order[0]).toBe('microtask')
    expect(order).toContain('resumed')
  })

  test('consecutive yields resolve in order and keep a single shared channel', async () => {
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 0 })
    scheduler.beginWave(0)
    const seen: number[] = []
    for (let round = 0; round < 12; round++) {
      await scheduler.maybeYield(1e9)
      seen.push(round)
    }
    expect(seen).toEqual([...Array(12).keys()])
    expect(scheduler.stats.yields).toBe(12)
  })

  test('reconfiguring off mid-wave stops the pacing without corrupting counts', async () => {
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 0 })
    scheduler.beginWave(0)
    expect(await scheduler.maybeYield(1e9)).toBe(true)
    scheduler.configure({ enabled: false })
    expect(await scheduler.maybeYield(1e9)).toBe(false)
    scheduler.recordSlice(10, 8)
    const stats = scheduler.stats
    expect(stats.enabled).toBe(false)
    expect(stats.yields).toBe(1)
    expect(stats.slices).toBe(0)

    scheduler.configure({ enabled: true, budgetMs: 64 })
    expect(scheduler.stats.budgetMs).toBe(64)
    scheduler.resetStats()
    expect(scheduler.stats).toMatchObject({ yields: 0, slices: 0, maxTaskMs: 0, budgetMs: 64 })
  })

  test('records the longest slice, which is the step a scheduler cannot split', async () => {
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 16 })
    scheduler.beginWave(0)
    scheduler.recordSlice(12.34, 512)
    scheduler.recordSlice(55.51, 512)
    scheduler.recordSlice(26.2, 512)
    expect(scheduler.stats.maxSliceMs).toBe(55.5)
    expect(scheduler.stats.entities).toBe(1536)
  })

  test('reports a wave that was abandoned without an endWave', () => {
    // Phase 2.13 Task D2: the slice loop closes the wave in a `finally`, so an
    // early return for a replaced document still balances. This counter is what
    // lets the browser test assert the balance instead of trusting the code.
    const scheduler = new AcTrConvertScheduler({ enabled: true, budgetMs: 16 })
    expect(scheduler.stats.openWaves).toBe(0)

    scheduler.beginWave(0)
    expect(scheduler.stats.openWaves).toBe(1)
    scheduler.endWave(10)
    expect(scheduler.stats.openWaves).toBe(0)

    // Reset must not hide an abandoned wave either.
    scheduler.beginWave(20)
    scheduler.resetStats()
    expect(scheduler.stats.openWaves).toBe(1)
    expect(scheduler.stats.waves).toBe(0)

    // A double close is clamped instead of going negative.
    scheduler.endWave(30)
    scheduler.endWave(40)
    expect(scheduler.stats.openWaves).toBe(0)
  })

  test('a disabled scheduler keeps the wave balance at zero', () => {
    const scheduler = new AcTrConvertScheduler({ enabled: false, budgetMs: 16 })
    scheduler.beginWave(0)
    scheduler.endWave(10)
    expect(scheduler.stats).toMatchObject({ waves: 0, openWaves: 0, yields: 0, slices: 0 })
  })
})
