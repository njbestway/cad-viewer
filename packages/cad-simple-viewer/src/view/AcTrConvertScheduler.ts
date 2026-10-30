/**
 * Phase 2.12 Task D — convert-wave scheduler.
 *
 * The Phase 2.12 profile (`PHASE212_MOVE_CONVERSION_AUDIT.md` §7) found that a
 * 50k MOVE converts in 98 slices of 512 entities, ~26 ms each, inside a single
 * 2834 ms `RunTask`: the outer loop slices but never leaves the task, and the
 * per-call `AcCmUiYieldGate` is constructed at the top of every `batchConvert`
 * call, so its 300 ms budget is compared against one 26 ms slice 98 times and
 * never fires.
 *
 * This scheduler moves the budget to the loop that actually iterates. It is
 * off by default: with `enabled: false` every method is a no-op and the
 * conversion behaves exactly as it did before, which is what makes an
 * interleaved A/B in one build possible.
 *
 * Two properties matter more than the budget itself:
 *
 * - the yield must be a **macrotask**, so the renderer and input can run. A
 *   `setTimeout(0)` chain is clamped to ~4 ms after five nesting levels, which
 *   across 98 slices would add ~390 ms of pure waiting; `scheduler.yield()` and
 *   `MessageChannel` postMessage both give a task boundary without the clamp.
 * - the yield must **not** be taken after the work it was supposed to prevent.
 *   The budget is checked before a slice, never after one.
 */

/** A macrotask boundary that is not throttled like nested timers. */
function createMacrotaskYield(): () => Promise<void> {
  const scope = globalThis as {
    scheduler?: { yield?: () => Promise<void> }
  }
  if (typeof scope.scheduler?.yield === 'function') {
    const yieldNow = scope.scheduler.yield.bind(scope.scheduler)
    return () => yieldNow()
  }
  if (typeof MessageChannel === 'function') {
    // One channel for the whole process: a channel per yield would allocate a
    // port pair 98 times per MOVE.
    let channel: MessageChannel | null = null
    const waiting: Array<() => void> = []
    return () => {
      if (!channel) {
        channel = new MessageChannel()
        channel.port1.onmessage = () => {
          const next = waiting.shift()
          if (next) next()
        }
        // `unref` exists on the Node port only; the browser port ignores it.
        // Both ends are unref'd so a unit-test process can exit while the shared
        // channel is still open.
        ;(channel.port1 as unknown as { unref?: () => void }).unref?.()
        ;(channel.port2 as unknown as { unref?: () => void }).unref?.()
      }
      const active = channel
      return new Promise<void>(resolve => {
        waiting.push(resolve)
        active.port2.postMessage(0)
      })
    }
  }
  return () => new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Options for {@link AcTrConvertScheduler}. */
export interface AcTrConvertSchedulerOptions {
  /**
   * Master switch. `false` (the default) restores the pre-2.12 behaviour where
   * a whole convert wave runs in one task.
   */
  enabled: boolean
  /**
   * Wall time the main thread may stay in a wave before it must leave the
   * task. Checked between slices, so the overshoot is bounded by one slice
   * (~26 ms median, 55 ms max at 50k), not by the budget.
   */
  budgetMs: number
}

/** Counters for one measurement run; see `getConversionSchedulerMetrics()`. */
export interface AcTrConvertSchedulerStats {
  enabled: boolean
  budgetMs: number
  /** Convert waves that went through the scheduler. */
  waves: number
  /** `batchConvert` calls the scheduler paced. */
  slices: number
  /** Entities handed to those slices. */
  entities: number
  /** Macrotask boundaries taken. Zero means the wave still ran in one task. */
  yields: number
  /** Longest single slice, i.e. an irreducible step the scheduler cannot split. */
  maxSliceMs: number
  /** Longest uninterrupted stretch between two yields. */
  maxTaskMs: number
  /** Last completed wave's uninterrupted stretch. */
  lastTaskMs: number
  /** Last completed wave's total duration, yields included. */
  lastWaveMs: number
  /** Yield primitive actually used. */
  yieldPrimitive: 'scheduler.yield' | 'MessageChannel' | 'setTimeout'
}

/** Production default: the scheduler is research-gated until an A/B lands. */
export const ACTR_CONVERT_SCHEDULER_DEFAULT: AcTrConvertSchedulerOptions = {
  enabled: false,
  budgetMs: 16
}

/**
 * Paces one convert wave so it cannot hold the main thread for its whole
 * duration.
 *
 * Not a work queue: it holds no entities and owns no ordering. The caller keeps
 * iterating its own slice list and asks this object whether it is time to leave
 * the task. That keeps every existing cancel/epoch/claim rule exactly where it
 * was.
 */
export class AcTrConvertScheduler {
  private _options: AcTrConvertSchedulerOptions = { ...ACTR_CONVERT_SCHEDULER_DEFAULT }
  private readonly _yield: () => Promise<void>
  private readonly _primitive: AcTrConvertSchedulerStats['yieldPrimitive']

  private _waveStartMs = 0
  private _lastResumeMs = 0
  private _stats: AcTrConvertSchedulerStats = {
    enabled: false,
    budgetMs: ACTR_CONVERT_SCHEDULER_DEFAULT.budgetMs,
    waves: 0,
    slices: 0,
    entities: 0,
    yields: 0,
    maxSliceMs: 0,
    maxTaskMs: 0,
    lastTaskMs: 0,
    lastWaveMs: 0,
    yieldPrimitive: 'setTimeout'
  }

  constructor(options: Partial<AcTrConvertSchedulerOptions> = {}) {
    this._yield = createMacrotaskYield()
    const scope = globalThis as { scheduler?: { yield?: () => Promise<void> } }
    this._primitive =
      typeof scope.scheduler?.yield === 'function'
        ? 'scheduler.yield'
        : typeof MessageChannel === 'function'
          ? 'MessageChannel'
          : 'setTimeout'
    this.configure(options)
  }

  get enabled(): boolean {
    return this._options.enabled
  }

  get budgetMs(): number {
    return this._options.budgetMs
  }

  /** Applies a partial change; used by an A/B arm between steps. */
  configure(options: Partial<AcTrConvertSchedulerOptions>): void {
    if (options.enabled !== undefined) this._options.enabled = options.enabled
    if (options.budgetMs !== undefined) {
      this._options.budgetMs = Math.max(0, options.budgetMs)
    }
    this._stats.enabled = this._options.enabled
    this._stats.budgetMs = this._options.budgetMs
  }

  /** Zeroes the counters without touching the configuration. */
  resetStats(): void {
    this._stats = {
      enabled: this._options.enabled,
      budgetMs: this._options.budgetMs,
      waves: 0,
      slices: 0,
      entities: 0,
      yields: 0,
      maxSliceMs: 0,
      maxTaskMs: 0,
      lastTaskMs: 0,
      lastWaveMs: 0,
      yieldPrimitive: this._primitive
    }
  }

  /** Snapshot for tests and reports. */
  get stats(): Readonly<AcTrConvertSchedulerStats> {
    return { ...this._stats, yieldPrimitive: this._primitive }
  }

  /**
   * Marks the start of a wave. A disabled scheduler does nothing, so a
   * production build pays one boolean check per wave.
   */
  beginWave(now: number): void {
    if (!this._options.enabled) return
    this._waveStartMs = now
    this._lastResumeMs = now
    this._stats.waves++
  }

  /**
   * Leaves the macrotask when the current stretch has spent its budget.
   *
   * Returns `true` when a yield actually happened, so the caller can re-check
   * its document epoch before doing more work.
   */
  async maybeYield(now: number): Promise<boolean> {
    if (!this._options.enabled) return false
    if (now - this._lastResumeMs < this._options.budgetMs) return false
    this.recordTaskSpan(now)
    await this._yield()
    this._stats.yields++
    // The budget restarts when the wave resumes, not when it yields: otherwise
    // a busy event loop would let the next stretch run budget + delay.
    this._lastResumeMs = performance.now()
    return true
  }

  /** Records one `batchConvert` slice. */
  recordSlice(ms: number, entities: number): void {
    if (!this._options.enabled) return
    this._stats.slices++
    this._stats.entities += entities
    if (ms > this._stats.maxSliceMs) this._stats.maxSliceMs = Math.round(ms * 10) / 10
  }

  /** Closes a wave and records the last uninterrupted stretch. */
  endWave(now: number): void {
    if (!this._options.enabled) return
    this.recordTaskSpan(now)
    this._stats.lastTaskMs = Math.round((now - this._lastResumeMs) * 10) / 10
    this._stats.lastWaveMs = Math.round((now - this._waveStartMs) * 10) / 10
  }

  private recordTaskSpan(now: number): void {
    const span = now - this._lastResumeMs
    if (span > this._stats.maxTaskMs) this._stats.maxTaskMs = Math.round(span * 10) / 10
  }
}
