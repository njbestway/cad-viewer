import type { AcDbEntity } from '@mlightcad/data-model'

/**
 * Options for {@link AcTrEntityUpdateQueue}.
 */
export interface AcTrEntityUpdateQueueOptions {
  /**
   * Applies one coalesced wave of entities.
   *
   * The wave is already deduplicated by object id and never contains an entity
   * that was superseded by a later enqueue for the same id. `apply` may be
   * async; the queue awaits it before starting the next wave (unless
   * `maxConcurrentApplies` is raised).
   */
  apply: (entities: AcDbEntity[]) => void | Promise<void>
  /**
   * Called synchronously for every enqueue, before the wave is scheduled.
   *
   * Used to invalidate work that was started for an older revision of the
   * entity (convert generation bump, claim release, glyph cleanup) so a stale
   * conversion cannot commit after the scene entry was dropped.
   */
  onEnqueue?: (entity: AcDbEntity, objectId: string) => void
  /**
   * Upper bound on concurrently running `apply` calls. Defaults to `1`, which
   * makes a bulk update N entities wide and exactly one conversion chain deep.
   */
  maxConcurrentApplies?: number
  /**
   * Schedules the deferred flush. Defaults to `setTimeout(run, 0)`.
   *
   * A macrotask (not a microtask) is deliberate: a transaction commit
   * dispatches its `entityModified` fan-out synchronously, and every listener
   * call lands in `_pending` before the flush runs, so one commit produces one
   * wave. Injecting this makes the ordering deterministic in unit tests.
   */
  schedule?: (run: () => void) => void
}

/**
 * Counters describing how well enqueues coalesced.
 */
export interface AcTrEntityUpdateQueueStats {
  /** Waves handed to `apply` so far. */
  waveCount: number
  /** Entities handed to `apply` so far (before apply-level filtering). */
  appliedEntityCount: number
  /** Enqueues folded into an already queued id (revision superseded). */
  coalescedEnqueueCount: number
  /** Peak number of ids waiting in the pending map. */
  pendingHighWatermark: number
  /** Peak number of concurrently running `apply` calls. */
  maxConcurrentApplies: number
  /** Waves dropped because {@link AcTrEntityUpdateQueue.cancel} ran first. */
  cancelledWaveCount: number
  /**
   * Waves whose `apply` rejected. The drain keeps running: one bad wave must
   * not starve every entity queued behind it.
   */
  failedWaveCount: number
  /** `message` of the last rejected wave, for diagnostics. */
  lastErrorMessage: string | null
}

/**
 * Upper bound on entities per conversion slice.
 *
 * A queued wave still rebuilds geometry per entity, so it is converted in
 * slices of this size: one huge MOVE must yield to the event loop instead of
 * blocking the main thread for seconds. Slices that overrun their time budget
 * are halved by the caller, so heavy block references end up at 1.
 */
export const AC_TR_ENTITY_UPDATE_SLICE_MAX = 512

const DEFAULT_SCHEDULE = (run: () => void) => {
  setTimeout(run, 0)
}

/**
 * Coalesces `entityModified` notifications into bounded, deduplicated waves.
 *
 * Before this queue, every modified entity started its own
 * `removeEntity` → `batchConvert` → commit chain from
 * `AcTrView2d.updateEntity`. A MOVE of 50,000 entities therefore created
 * 50,000 independent async chains, each one removing a single id and each one
 * running its own convert loop that yielded to the event loop. The work itself
 * is unavoidable (each entity's geometry still has to be rebuilt), but the
 * *scheduling* is not: this class turns "N independent pipelines" into
 * "1 pipeline with N controlled entity conversions".
 *
 * Guarantees:
 * - **Dedup by object id.** A second enqueue for a queued id replaces the
 *   stored reference and is counted as coalesced; only the newest revision is
 *   applied.
 * - **Wave merging.** Every enqueue that happens in the same synchronous turn
 *   (one transaction commit, one undo/redo step) lands in one wave.
 * - **Bounded concurrency.** At most `maxConcurrentApplies` applies run at a
 *   time; `pendingHighWatermark` and `maxConcurrentApplies` are observable.
 * - **Revision invalidation.** `onEnqueue` fires for every id, so in-flight
 *   conversions for an older revision are invalidated even when the queue has
 *   not flushed yet.
 * - **Cancellation.** {@link cancel} drops queued work and releases idle
 *   waiters; a document close or view session swap must call it so no stale
 *   callback touches the next document's scene.
 *
 * This class holds no scene/view state and no WebGL dependency, so its
 * coalescing and cancellation behaviour is unit tested headlessly. Geometry is
 * still rebuilt per entity — removing that rebuild is the incremental
 * transform fast path, which is explicitly out of scope here.
 */
export class AcTrEntityUpdateQueue {
  private readonly _apply: AcTrEntityUpdateQueueOptions['apply']
  private readonly _onEnqueue: AcTrEntityUpdateQueueOptions['onEnqueue']
  private readonly _schedule: (run: () => void) => void
  private readonly _maxConcurrent: number
  /** Queued ids → latest known entity instance for that id. */
  private readonly _pending = new Map<string, AcDbEntity>()
  private readonly _idleWaiters: Array<() => void> = []
  private _scheduled = false
  private _draining = false
  /**
   * Bumped by {@link cancel}. An apply that resolves with a stale epoch must
   * neither continue draining nor schedule a follow-up flush.
   */
  private _epoch = 0
  private readonly _stats: AcTrEntityUpdateQueueStats = {
    waveCount: 0,
    appliedEntityCount: 0,
    coalescedEnqueueCount: 0,
    pendingHighWatermark: 0,
    maxConcurrentApplies: 0,
    cancelledWaveCount: 0,
    failedWaveCount: 0,
    lastErrorMessage: null
  }

  constructor(options: AcTrEntityUpdateQueueOptions) {
    this._apply = options.apply
    this._onEnqueue = options.onEnqueue
    this._schedule = options.schedule ?? DEFAULT_SCHEDULE
    const max = options.maxConcurrentApplies ?? 1
    this._maxConcurrent = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
  }

  /**
   * Queues entities for a render update.
   *
   * Entities without an object id are ignored: they cannot be deduplicated,
   * removed from the scene, or invalidated, so converting them would only add
   * unaddressable geometry.
   */
  enqueue(entity: AcDbEntity | AcDbEntity[]) {
    const entities = Array.isArray(entity) ? entity : [entity]
    if (entities.length === 0) return

    let queued = 0
    for (let i = 0; i < entities.length; i++) {
      const item = entities[i]
      const objectId = String(item?.objectId ?? '')
      if (!objectId) continue
      if (this._pending.has(objectId)) {
        this._stats.coalescedEnqueueCount++
      }
      // `Map.set` on an existing key keeps the original insertion position, so
      // a superseded id does not jump ahead of ids queued before it.
      this._pending.set(objectId, item)
      this._onEnqueue?.(item, objectId)
      queued++
    }
    if (queued === 0) return

    if (this._pending.size > this._stats.pendingHighWatermark) {
      this._stats.pendingHighWatermark = this._pending.size
    }
    this.scheduleFlush()
  }

  /**
   * Drops queued ids from the next wave and reports how many were dropped.
   *
   * Used when a notification that arrives later in the same turn already
   * guarantees a full reconvert of the id — an undo/redo step notifies
   * `entityModified` for every entity in the record and then appends the very
   * same ids. Keeping the queued update would let the wave remove the drawable
   * the append just committed and rebuild it, so the same geometry is built
   * twice. Ids that are not pending are ignored, which makes this a no-op on
   * every path that is not a batch replay.
   *
   * @param ids - Object ids to remove from the pending wave
   * @returns Number of ids that were actually pending
   */
  discard(ids: Iterable<string>): number {
    let dropped = 0
    for (const id of ids) {
      if (this._pending.delete(id)) dropped += 1
    }
    return dropped
  }

  /** Number of ids waiting for the next wave. */
  get pendingCount() {
    return this._pending.size
  }

  /** True while a wave is queued or an apply is still running. */
  get isBusy() {
    return this._pending.size > 0 || this._scheduled || this._draining
  }

  /** A snapshot of the coalescing counters (safe to display / assert). */
  getStats(): AcTrEntityUpdateQueueStats {
    return { ...this._stats }
  }

  /** Resolves once the queue is empty and no apply is in flight. */
  whenIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve()
    return new Promise<void>(resolve => this._idleWaiters.push(resolve))
  }

  /**
   * Drops queued work and invalidates the running drain.
   *
   * Called when the client scene is torn down (document close, session swap,
   * `clear`), so no queued wave converts entities into a scene that no longer
   * represents the database. The queue stays usable afterwards.
   */
  cancel() {
    this._epoch++
    if (this._pending.size > 0) {
      this._stats.cancelledWaveCount++
    }
    this._pending.clear()
    this._scheduled = false
    this.releaseIdleWaiters()
  }

  /** Schedules one deferred flush unless a drain is already running. */
  private scheduleFlush() {
    // A running drain re-checks `_pending` after every settled apply, so it
    // picks the new wave up without a second timer (no timer storm).
    if (this._scheduled || this._draining) return
    this._scheduled = true
    this._schedule(() => {
      this._scheduled = false
      void this.drain()
    })
  }

  /** Moves the pending map into a wave and clears it for the next one. */
  private takeWave(): AcDbEntity[] {
    if (this._pending.size === 0) return []
    const wave: AcDbEntity[] = []
    for (const entity of this._pending.values()) {
      wave.push(entity)
    }
    this._pending.clear()
    return wave
  }

  /**
   * Runs waves until the pending map stays empty.
   *
   * At most `maxConcurrentApplies` applies are in flight, so the whole burst
   * exposes a single, explicit conversion concurrency instead of one pipeline
   * per entity.
   */
  private async drain(): Promise<void> {
    if (this._draining) return
    this._draining = true
    const epoch = this._epoch
    const active = new Set<Promise<void>>()
    try {
      for (;;) {
        if (this._epoch !== epoch) break
        while (active.size < this._maxConcurrent) {
          const wave = this.takeWave()
          if (wave.length === 0) break
          this._stats.waveCount++
          this._stats.appliedEntityCount += wave.length
          let started: Promise<void>
          try {
            started = Promise.resolve(this._apply(wave))
          } catch (error) {
            started = Promise.reject(error)
          }
          const task: Promise<void> = started
            // A rejected wave must not stop the drain; record it and continue
            // with the entities queued behind it.
            .catch((error: unknown) => {
              this._stats.failedWaveCount++
              this._stats.lastErrorMessage =
                error instanceof Error ? error.message : String(error)
            })
            .finally(() => {
              active.delete(task)
            })
          active.add(task)
          if (active.size > this._stats.maxConcurrentApplies) {
            this._stats.maxConcurrentApplies = active.size
          }
        }
        if (active.size === 0) break
        // `apply` is not cancellable; `cancel()` stops the loop at the next
        // boundary and the caller is responsible for dropping stale commits
        // (the view re-checks its convert epoch).
        await Promise.race(active)
      }
    } finally {
      this._draining = false
      if (this._epoch !== epoch) {
        this.releaseIdleWaiters()
      } else if (this._pending.size > 0) {
        this.scheduleFlush()
      } else {
        this.releaseIdleWaiters()
      }
    }
  }

  /** Resolves every `whenIdle` waiter. */
  private releaseIdleWaiters() {
    if (this._idleWaiters.length === 0) return
    const waiters = this._idleWaiters.splice(0, this._idleWaiters.length)
    for (const resolve of waiters) {
      resolve()
    }
  }
}
