import type { AcDbEntity } from '@mlightcad/data-model'

import { AcTrEntityUpdateQueue } from '../src/view/AcTrEntityUpdateQueue'

/**
 * Drives the Phase 2 render-update scheduler directly.
 *
 * The class holds no scene state, so these tests assert the structural
 * guarantees that make a bulk MOVE cheap — one wave per commit, deduplication
 * by object id, bounded conversion concurrency, revision invalidation and
 * cancellation — without needing a WebGL context.
 */

/** Minimal stand-in: the queue only reads `objectId` and passes the object through. */
function makeEntity(objectId: string, marker?: string) {
  return { objectId, marker } as unknown as AcDbEntity
}

interface ManualClock {
  /** Runs every scheduled flush immediately, in FIFO order. */
  flushAll(): void
  readonly pendingFlushCount: number
  readonly schedule: (run: () => void) => void
}

/**
 * Replaces `setTimeout` so a test decides exactly when a wave is applied.
 * The queue must merge everything enqueued in one synchronous turn, so the
 * test drives one flush per turn explicitly.
 */
function createManualClock(): ManualClock {
  const queue: Array<() => void> = []
  return {
    schedule: (run: () => void) => {
      queue.push(run)
    },
    get pendingFlushCount() {
      return queue.length
    },
    flushAll() {
      while (queue.length > 0) {
        const run = queue.shift()
        run?.()
      }
    }
  }
}

/** Lets pending microtasks (the drain loop) settle. */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

/**
 * A one-shot gate the test opens to let an in-flight `apply` finish.
 *
 * Object-wrapped so TypeScript does not narrow the captured variable to `null`
 * at the call site.
 */
function createGate() {
  const gate: { open: (() => void) | null } = { open: null }
  return {
    wait(): Promise<void> {
      return new Promise<void>(resolve => {
        gate.open = resolve
      })
    },
    release() {
      gate.open?.()
      gate.open = null
    }
  }
}

describe('AcTrEntityUpdateQueue', () => {
  it('merges one synchronous commit into a single wave', () => {
    const clock = createManualClock()
    const waves: AcDbEntity[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: entities => {
        waves.push(entities)
      },
      schedule: clock.schedule
    })

    const count = 10_000
    for (let index = 0; index < count; index++) {
      // One enqueue per `entityModified` dispatch, exactly like the transaction
      // commit fan-out.
      queue.enqueue(makeEntity(`E${index}`))
    }

    expect(queue.pendingCount).toBe(count)
    expect(clock.pendingFlushCount).toBe(1)

    clock.flushAll()

    expect(waves).toHaveLength(1)
    expect(waves[0]).toHaveLength(count)
    const stats = queue.getStats()
    expect(stats.waveCount).toBe(1)
    expect(stats.appliedEntityCount).toBe(count)
    expect(stats.pendingHighWatermark).toBe(count)
    // The point of the phase: 10k entities, 1 pipeline.
    expect(stats.pendingHighWatermark).toBeGreaterThan(1)
  })

  it('deduplicates by object id and keeps the newest revision', () => {
    const clock = createManualClock()
    const waves: AcDbEntity[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: entities => {
        waves.push(entities)
      },
      schedule: clock.schedule
    })

    const first = makeEntity('A', 'v1')
    const second = makeEntity('A', 'v2')
    const other = makeEntity('B', 'v1')
    queue.enqueue(first)
    queue.enqueue(second)
    queue.enqueue(other)

    expect(queue.pendingCount).toBe(2)
    clock.flushAll()

    expect(waves).toHaveLength(1)
    expect(waves[0]).toHaveLength(2)
    // Only the final revision of A is applied.
    const applied = waves[0].find(entity => entity.objectId === 'A') as unknown as {
      marker: string
    }
    expect(applied.marker).toBe('v2')
    expect(queue.getStats().coalescedEnqueueCount).toBe(1)
  })

  it('runs at most one apply at a time and queues the next burst behind it', async () => {
    const gate = createGate()
    let running = 0
    let observedMax = 0
    const waves: string[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: async entities => {
        running++
        observedMax = Math.max(observedMax, running)
        waves.push(entities.map(entity => String(entity.objectId)))
        if (waves.length === 1) {
          await gate.wait()
        }
        running--
      },
      schedule: run => run()
    })

    queue.enqueue([makeEntity('A'), makeEntity('B')])
    await settle()
    expect(waves).toHaveLength(1)

    // A second burst arrives while the first apply is still running.
    queue.enqueue([makeEntity('C')])
    queue.enqueue([makeEntity('D')])
    await settle()
    expect(waves).toHaveLength(1)

    gate.release()
    await settle()
    await queue.whenIdle()

    expect(waves).toHaveLength(2)
    expect(waves[1]).toEqual(['C', 'D'])
    expect(observedMax).toBe(1)
    expect(queue.getStats().maxConcurrentApplies).toBe(1)
  })

  it('reports a pending high-water mark and drains to idle', async () => {
    const gate = createGate()
    const queue = new AcTrEntityUpdateQueue({
      apply: async () => {
        await gate.wait()
      },
      schedule: run => run()
    })

    queue.enqueue([makeEntity('A'), makeEntity('B'), makeEntity('C')])
    await settle()
    expect(queue.isBusy).toBe(true)

    const idle = queue.whenIdle()
    gate.release()
    await idle

    expect(queue.isBusy).toBe(false)
    expect(queue.getStats().pendingHighWatermark).toBe(3)
  })

  it('drops queued work on cancel and stays usable afterwards', async () => {
    const clock = createManualClock()
    const waves: string[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: entities => {
        waves.push(entities.map(entity => String(entity.objectId)))
      },
      schedule: clock.schedule
    })

    queue.enqueue([makeEntity('DOC-1-A'), makeEntity('DOC-1-B')])
    const idle = queue.whenIdle()
    // A document close / session swap lands before the flush tick.
    queue.cancel()
    await idle
    clock.flushAll()

    expect(waves).toHaveLength(0)
    expect(queue.pendingCount).toBe(0)
    expect(queue.getStats().cancelledWaveCount).toBe(1)

    // The queue is reusable for the next document.
    queue.enqueue([makeEntity('DOC-2-A')])
    clock.flushAll()
    expect(waves).toEqual([['DOC-2-A']])
  })

  it('keeps draining after one wave rejects', async () => {
    const waves: string[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: entities => {
        const ids = entities.map(entity => String(entity.objectId))
        waves.push(ids)
        if (ids[0] === 'BOOM') {
          throw new Error('convert failed')
        }
      },
      schedule: run => run()
    })

    queue.enqueue([makeEntity('BOOM')])
    await settle()
    queue.enqueue([makeEntity('OK')])
    await settle()
    await queue.whenIdle()

    expect(waves).toEqual([['BOOM'], ['OK']])
    expect(queue.getStats().failedWaveCount).toBe(1)
    expect(queue.getStats().lastErrorMessage).toBe('convert failed')
  })

  it('ignores entities without an object id', () => {
    const clock = createManualClock()
    const waves: AcDbEntity[][] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: entities => {
        waves.push(entities)
      },
      schedule: clock.schedule
    })

    queue.enqueue([{ objectId: '' } as unknown as AcDbEntity])
    expect(queue.pendingCount).toBe(0)
    expect(clock.pendingFlushCount).toBe(0)

    queue.enqueue([makeEntity('A')])
    clock.flushAll()
    expect(waves).toEqual([[expect.objectContaining({ objectId: 'A' })]])
  })

  it('invalidates conversions synchronously via onEnqueue', () => {
    const clock = createManualClock()
    const invalidated: string[] = []
    const queue = new AcTrEntityUpdateQueue({
      apply: () => {},
      onEnqueue: (_entity, objectId) => {
        invalidated.push(objectId)
      },
      schedule: clock.schedule
    })

    queue.enqueue([makeEntity('A'), makeEntity('B')])
    // Invalidation happens before the wave flush, so an in-flight convert for
    // the previous revision can no longer commit.
    expect(invalidated).toEqual(['A', 'B'])
    expect(queue.getStats().waveCount).toBe(0)
    clock.flushAll()
  })
})
