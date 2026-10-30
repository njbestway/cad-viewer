/**
 * Snapshot of everything that separates the current scene from a completely
 * loaded drawing.
 *
 * Produced by `AcTrView2d.getSceneReadiness`; `reasons` is the only field a
 * decision should use, the rest exists so a failure can be attributed instead
 * of guessed at.
 */
export interface AcTrSceneReadiness {
  /** True when every reason list is empty. */
  ready: boolean
  /** Machine-readable causes, e.g. `not-in-scene:412`, `queue-busy`. */
  reasons: string[]
  /** Scene lifecycle epoch at sample time. */
  epoch: number
  /** Unreleased {@link AcTrSceneWorkTracker} tokens. */
  pendingSceneWork: number
  /** Token breakdown by label (`document-open`, `layout-load`, …). */
  sceneWorkByLabel: Record<string, number>
  /** Layouts whose entity list is still being collected/converted. */
  layoutLoadsInFlight: number
  /** Layer-visibility reconvert passes still running. */
  layerConvertsInFlight: number
  /** Ids claimed by an in-flight convert and not yet committed. */
  claimedObjects: number
  /** First N database ids that are drawable but not in the scene. */
  missingFromScene: string[]
  /** Total drawable-but-missing ids (not capped by the sample). */
  missingFromSceneCount: number
  /** First N scene ids the checked layout's spatial index cannot answer. */
  missingFromIndexSamples: string[]
  /** Scene ids of the checked layout that its spatial index cannot answer. */
  unindexedInScene: number
  /** Ids the scene can draw, all layouts. */
  sceneObjectIds: number
  /** Ids the checked layout's spatial index holds. */
  spatialIndexIds: number
  /** Layout the database/index checks ran against. */
  checkedLayoutId: string
}

/**
 * Tracks scene work that is *registered* but not yet visible to the convert
 * queues.
 *
 * `waitUntilIdle()` observes queues: `_convertQueue`, the entity update queue
 * and the deferred glyph/INSERT jobs. That is enough for work the view has
 * already accepted — `addEntity` pushes synchronously — but not for the windows
 * before it:
 *
 * - a document open is streaming entities out of the database and has not
 *   dispatched `entityAppended` for the remaining ones yet,
 * - a layout's entity list is being collected (`loadLayoutEntitiesIfNeeded`
 *   awaits the BTR iterator before it enqueues anything),
 * - an export pass was started fire-and-forget and only schedules its convert
 *   on the next microtask.
 *
 * In every one of those windows all queue counters are zero, so a readiness
 * poll answered "settled" and callers papered over it with a fixed sleep. This
 * tracker closes the gap with an explicit token instead of a delay: whoever
 * starts such a piece of work takes a token and releases it when the work is in
 * a queue (or done), and readiness cannot be observed while a token is held.
 *
 * Token release is idempotent and epoch-checked, so a double release, a late
 * release after {@link reset}, or a token dropped by a failed open cannot drive
 * the counter negative or keep a dead scene busy forever.
 *
 * @example
 * ```ts
 * const release = view.beginSceneWork('document-open')
 * try {
 *   await db.read(file)
 * } finally {
 *   release()
 * }
 * ```
 */
export class AcTrSceneWorkTracker {
  /** Bumped by {@link reset}; tokens from an older epoch are inert. */
  private _epoch = 0
  private _pending = 0
  private readonly _byLabel = new Map<string, number>()
  private _waiters: Array<() => void> = []

  /** Current scene lifecycle epoch. Changes only through {@link reset}. */
  get epoch() {
    return this._epoch
  }

  /** Number of unreleased tokens. */
  get pending() {
    return this._pending
  }

  /** True while any registered work has not been released. */
  get isBusy() {
    return this._pending > 0
  }

  /**
   * Registers pending work.
   *
   * @param label - Why the work is pending (`document-open`, `layout-load`,
   *   `export-convert`, …). Aggregated in {@link snapshot} so a stuck scene can
   *   be attributed instead of guessed.
   * @returns Idempotent release function; call it once the work is queued or
   *   finished.
   */
  begin(label: string) {
    const epoch = this._epoch
    this._pending++
    this._byLabel.set(label, (this._byLabel.get(label) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      // A reset already closed this lifecycle; its counters describe a scene
      // that no longer exists and must not be decremented from here.
      if (epoch !== this._epoch) return
      this._pending = Math.max(0, this._pending - 1)
      const count = (this._byLabel.get(label) ?? 0) - 1
      if (count > 0) this._byLabel.set(label, count)
      else this._byLabel.delete(label)
      if (this._pending === 0) this.releaseWaiters()
    }
  }

  /**
   * Closes the current lifecycle: bumps the epoch, drops every outstanding
   * token and resolves waiters.
   *
   * Called when the view is cleared for a new document, so a hung open cannot
   * keep the next scene's readiness false, and a late release from the old
   * scene cannot decrement the new one's counter.
   */
  reset() {
    this._epoch++
    this._pending = 0
    this._byLabel.clear()
    this.releaseWaiters()
  }

  /** Diagnostic snapshot; safe to log or assert on. */
  snapshot() {
    return {
      epoch: this._epoch,
      pending: this._pending,
      byLabel: Object.fromEntries(this._byLabel) as Record<string, number>
    }
  }

  /** Resolves once no token is held (or after {@link reset}). */
  whenIdle(): Promise<void> {
    if (this._pending === 0) return Promise.resolve()
    return new Promise<void>(resolve => this._waiters.push(resolve))
  }

  private releaseWaiters() {
    if (this._waiters.length === 0) return
    const waiters = this._waiters.splice(0, this._waiters.length)
    for (const resolve of waiters) resolve()
  }
}
