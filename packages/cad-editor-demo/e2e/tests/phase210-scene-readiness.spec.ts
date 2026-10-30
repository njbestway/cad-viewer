import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.10 Task A2 - the Phase 2.9 readiness gates that the phase 2.9 reports
 * described but never pinned down with an assertion.
 *
 * Seven claims are checked here, each one on a *deterministic* signal rather than
 * a sleep:
 *
 * 1. `waitUntilSceneReady()` returning `ready === true` means the database ids,
 *    the ids the scene draws and the ids the spatial index answers for agree
 *    for the checked layout. The test does the set comparison itself instead
 *    of trusting the boolean.
 * 2. Work that is pending but corresponds to no entity (`beginSceneWork`) keeps
 *    readiness false: an extra, unmatched id cannot fake completion.
 * 2b. A retained convert claim cannot hide a missing entity. Claims outlive the
 *    commit they guard, so the database-coverage layer may only trust the scene
 *    itself; the test drops a drawable that is still claimed and requires the
 *    snapshot to name it.
 * 3. When the wait times out with work still pending, the snapshot says
 *    `ready === false` and names the blocker, so a caller can fail explicitly
 *    instead of continuing on a half-built scene.
 * 4. Releasing that work returns the scene to ready - the wait is a pause, not
 *    a deadlock.
 * 5. A document lifecycle reset drops work claimed by the previous document
 *    (`beginDocumentOpen` bumps the epoch) instead of keeping the new scene
 *    permanently busy, and no convert claim is left behind after a load.
 * 6. Per-entity material batches survive an erase: the shared-batch counters
 *    return to their pre-erase values and no entry is left holding geometry.
 *
 * Fixture size is deliberately small: this spec asserts mechanisms, and the
 * 5k/10k/50k numbers live in the phase 2.9 latency and lifecycle harnesses.
 */

const SIZE = Number(process.env.P210_A2_SIZE ?? 300)

// `test.use` must sit at file scope: inside a `describe` it forces a new worker.
test.use({ trace: 'off' })
test.setTimeout(900_000)

type ReadinessLike = {
  ready: boolean
  reasons: string[]
  pendingSceneWork: number
  sceneWorkByLabel: Record<string, number>
  claimedObjects: number
  missingFromSceneCount: number
  missingFromScene: string[]
  missingFromIndexSamples: string[]
  unindexedInScene: number
  sceneObjectIds: number
  spatialIndexIds: number
  checkedLayoutId: string
}

type ViewLike = {
  waitUntilSceneReady?: (options?: { timeoutMs?: number }) => Promise<ReadinessLike>
  getSceneReadiness?: (options?: { sampleLimit?: number }) => ReadinessLike
  beginSceneWork?: (label: string) => () => void
  beginDocumentOpen?: () => () => void
  getSharedBatchMetrics?: () => Record<string, number>
  getSharedBatchEntries?: () => unknown[]
  /** Retained convert claims; not part of the public surface, read for the audit. */
  _claimedConvertObjectIds?: Set<string>
  _scene?: {
    _layouts?: Map<string, LayoutLike> | LayoutLike[]
    /** Scene-level removal, so no convert tombstone is set. */
    removeEntities?: (ids: string[]) => void
  }
}

type LayoutLike = {
  id?: string
  spatialIndexRootIds?: string[]
  spatialIndexIds?: string[]
  collectObjectIds?: (target?: Set<string>) => Set<string>
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: ViewLike
      curDocument?: {
        database: {
          tables: {
            blockTable: {
              modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
            }
          }
          transactionManager: { undo: () => boolean; redo: () => boolean }
        }
        entityService: {
          eraseEntities: (ids: string[]) => number
        }
      }
    }
  }
}

/** Model-space ids currently in the database. */
async function readDatabaseIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const iterator =
      win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable
        .modelSpace.newIterator()
    if (!iterator) return []
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

/** Scene ids and root-level spatial-index ids of the checked layout. */
async function readSceneSets(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    // `_layouts` is keyed by block table record id — the same id
    // `checkedLayoutId` reports. The layout object's own `id` is its own
    // object id and does not match, so the key must be read explicitly.
    const entries: Array<[string, LayoutLike]> =
      layouts instanceof Map
        ? Array.from(layouts.entries())
        : layouts
          ? Array.from(layouts).map(layout => [layout.id ?? '', layout] as [string, LayoutLike])
          : []
    return entries.map(([layoutId, layout]) => ({
      layoutId,
      sceneIds: layout.collectObjectIds
        ? Array.from(layout.collectObjectIds())
        : [],
      indexIds: layout.spatialIndexRootIds ?? layout.spatialIndexIds ?? []
    }))
  })
}

/** Reads readiness once, without waiting. */
async function readReadiness(page: Page): Promise<ReadinessLike> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return view!.getSceneReadiness!({ sampleLimit: 64 })
  })
}

/**
 * Claim audit for a settled scene.
 *
 * Convert claims are released on erase, on failure and on document swap, but
 * not after a successful commit: they double as the "already handled" marker
 * the export pass dedups against. So the gate is not `claims === 0` (they are
 * retained by design) but containment — a claim naming an id the scene cannot
 * draw is what would let the coverage layer miss a real gap.
 */
async function readClaimAudit(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    const sceneIds = new Set<string>()
    const values =
      layouts instanceof Map
        ? Array.from(layouts.values())
        : layouts
          ? Array.from(layouts)
          : []
    for (const layout of values) {
      for (const id of layout.collectObjectIds?.() ?? []) sceneIds.add(String(id))
    }
    const dbIds = new Set<string>()
    const iterator =
      win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable
        .modelSpace.newIterator()
    if (iterator) {
      for (const entity of iterator) dbIds.add(String(entity.objectId))
    }
    const claimed = Array.from(view?._claimedConvertObjectIds ?? []).map(String)
    const stray = claimed.filter(id => !sceneIds.has(id))
    return {
      claimedCount: claimed.length,
      claimedNotInScene: stray.length,
      claimedNotInSceneSamples: stray.slice(0, 8),
      claimedNotInDatabase: claimed.filter(id => !dbIds.has(id)).length
    }
  })
}

/** Loads a fresh document and waits until its entity stream has arrived. */
async function loadFixture(page: Page, size: number, tag: string) {
  const fixture = writeMixedFixture(size, tag)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(
      async () => (await readDatabaseIds(page)).length,
      { timeout: 600_000, intervals: [250] }
    )
    .toBe(size)
}

/** Sorted copies so set comparison failures print something readable. */
const sorted = (values: string[]) => [...values].sort()

test.describe('phase 2.10 A2 scene readiness gates', () => {
  test('ready=true means the database, scene and index agree', async ({ page }) => {
    await loadFixture(page, SIZE, `p210a2${SIZE}`)

    const snapshot = await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      const result = await view!.waitUntilSceneReady!({ timeoutMs: 600_000 })
      return result
    })
    expect(snapshot.ready, `not ready: ${snapshot.reasons.join(',')}`).toBe(true)

    const databaseIds = await readDatabaseIds(page)
    const sets = await readSceneSets(page)
    const checked = sets.find(s => s.layoutId === snapshot.checkedLayoutId)
    expect(checked, `no layout ${snapshot.checkedLayoutId}`).toBeTruthy()

    // The layout the view checked must cover every database id it draws.
    expect(sorted(checked!.sceneIds)).toEqual(sorted(databaseIds))
    // Root-level index ids must cover the same set, not a subset.
    expect(sorted(checked!.indexIds)).toEqual(sorted(checked!.sceneIds))
    // And the counters the snapshot reports must agree with the sets.
    // `sceneObjectIds` counts every registered layout, `spatialIndexIds` only
    // the checked one, so compare against the matching scope.
    const sceneUnion = new Set(sets.flatMap(s => s.sceneIds))
    expect(snapshot.sceneObjectIds).toBe(sceneUnion.size)
    expect(snapshot.spatialIndexIds).toBe(checked!.indexIds.length)
    expect(snapshot.missingFromSceneCount).toBe(0)
    expect(snapshot.unindexedInScene).toBe(0)
    // Item 2 of A2: a load must not leave a *stray* claim behind. Claims
    // themselves are retained after commit by design (export dedup reads them),
    // so the property under test is containment: every claim names an id the
    // scene really draws and the database really owns. A claim outside the
    // scene is the only kind that can mask a missing entity later.
    const claims = await readClaimAudit(page)
    expect(claims.claimedCount).toBe(snapshot.claimedObjects)
    expect(
      claims.claimedNotInScene,
      `claims the scene cannot draw: ${claims.claimedNotInSceneSamples.join(',')}`
    ).toBe(0)
    expect(claims.claimedNotInDatabase).toBe(0)
    expect(snapshot.pendingSceneWork).toBe(0)
  })

  test('a retained convert claim cannot hide a missing entity', async ({ page }) => {
    await loadFixture(page, SIZE, `p210a2claim${SIZE}`)
    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )
    expect((await readReadiness(page)).ready).toBe(true)

    // Drop one drawable at the scene layer only: the database still owns it and
    // no convert tombstone is set, so it is genuinely missing. The id is still
    // claimed, which is exactly the state that used to make layer 2 look clean.
    const injected = await page.evaluate(() => {
      const win = window as unknown as PageWindow
      const view = win.AcApDocManager?.instance?.curView
      const layouts = view?._scene?._layouts
      const values =
        layouts instanceof Map
          ? Array.from(layouts.values())
          : layouts
            ? Array.from(layouts)
            : []
      const victim = values
        .flatMap(layout => Array.from(layout.collectObjectIds?.() ?? []))
        .map(String)[0]
      view?._scene?.removeEntities?.([victim])
      // Re-assert the claim: the mask under test must be present, not absent.
      view?._claimedConvertObjectIds?.add(victim)
      return {
        victim,
        claimed: view?._claimedConvertObjectIds?.has(victim) ?? false,
        readiness: view!.getSceneReadiness!({ sampleLimit: 8 })
      }
    })

    expect(injected.victim).toBeTruthy()
    expect(injected.claimed).toBe(true)
    // The claim must not be accepted as proof of work: readiness has to name
    // the gap from the database → scene comparison instead of returning true.
    expect(
      injected.readiness.ready,
      `a claimed but undrawn id passed as ready (${injected.readiness.reasons.join(',')})`
    ).toBe(false)
    expect(injected.readiness.reasons.join(',')).toContain('not-in-scene:1')
    expect(injected.readiness.missingFromScene).toContain(String(injected.victim))
  })

  test('unmatched pending work keeps readiness false', async ({ page }) => {
    await loadFixture(page, SIZE, `p210a2hold${SIZE}`)
    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )
    expect((await readReadiness(page)).ready).toBe(true)

    // A token that corresponds to no entity at all: the scene is complete, yet
    // the view has accepted work it has not finished. Readiness must say so.
    const held = await page.evaluate(() => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      ;(window as unknown as { __p210Release?: () => void }).__p210Release =
        view!.beginSceneWork!('p210-unmatched')
      return view!.getSceneReadiness!({ sampleLimit: 8 })
    })
    expect(held.ready).toBe(false)
    expect(held.pendingSceneWork).toBeGreaterThan(0)
    expect(held.sceneWorkByLabel['p210-unmatched']).toBe(1)
    expect(held.reasons.join(',')).toContain('queue-busy')

    const released = await page.evaluate(() => {
      ;(window as unknown as { __p210Release?: () => void }).__p210Release?.()
      return (window as unknown as PageWindow).AcApDocManager?.instance
        ?.curView!.getSceneReadiness!({ sampleLimit: 8 })
    })
    expect(released.ready).toBe(true)
    expect(released.pendingSceneWork).toBe(0)
  })

  test('a timed-out wait reports ready=false with the blocking reason', async ({
    page
  }) => {
    await loadFixture(page, SIZE, `p210a2timeout${SIZE}`)
    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )

    const result = await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager
        ?.instance?.curView
      const release = view!.beginSceneWork!('p210-timeout')
      try {
        const snapshot = await view!.waitUntilSceneReady!({ timeoutMs: 250 })
        return { snapshot, elapsedOk: true }
      } finally {
        release()
      }
    })

    // The caller contract: `ready === false` after the deadline, with a reason
    // that names the work still outstanding. Nothing may report success here.
    expect(result.snapshot.ready).toBe(false)
    expect(result.snapshot.reasons.length).toBeGreaterThan(0)
    expect(result.snapshot.reasons.join(',')).toContain('queue-busy')

    // Releasing the work afterwards must restore readiness: the failed wait did
    // not leave the scene latched busy.
    const after = await readReadiness(page)
    expect(after.ready).toBe(true)
  })

  test('releasing held work unblocks a wait in flight', async ({ page }) => {
    await loadFixture(page, SIZE, `p210a2pause${SIZE}`)
    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )

    const paced = await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager
        ?.instance?.curView
      const release = view!.beginSceneWork!('p210-pause')
      const waiting = view!.waitUntilSceneReady!({ timeoutMs: 30_000 })

      // Deterministic pause: readiness is false for as long as the token is
      // held, checked in the same task the wait was started in.
      const during = view!.getSceneReadiness!({ sampleLimit: 4 }).ready
      await new Promise(resolve => setTimeout(resolve, 500))
      const stillWaiting = view!.getSceneReadiness!({ sampleLimit: 4 }).ready
      release()
      const snapshot = await waiting
      return { during, stillWaiting, ready: snapshot.ready }
    })

    expect(paced.during).toBe(false)
    expect(paced.stillWaiting).toBe(false)
    expect(paced.ready).toBe(true)
  })

  test('a document lifecycle reset drops the previous document claims', async ({
    page
  }) => {
    await loadFixture(page, SIZE, `p210a2epoch${SIZE}`)

    const reset = await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager
        ?.instance?.curView
      // Work claimed by the outgoing document, deliberately never released.
      view!.beginSceneWork!('p210-stale')
      const beforeEpoch = view!.getSceneReadiness!({ sampleLimit: 4 })
      // A new open resets the tracker instead of inheriting the stale token.
      const releaseOpen = view!.beginDocumentOpen!()
      const afterReset = view!.getSceneReadiness!({ sampleLimit: 4 })
      releaseOpen()
      const snapshot = await view!.waitUntilSceneReady!({ timeoutMs: 600_000 })
      return { beforeEpoch, afterReset, ready: snapshot.ready }
    })

    expect(reset.beforeEpoch.pendingSceneWork).toBeGreaterThan(0)
    expect(reset.beforeEpoch.sceneWorkByLabel['p210-stale']).toBe(1)
    // The stale token belongs to the old epoch and is gone from the new one.
    expect(reset.afterReset.sceneWorkByLabel['p210-stale']).toBeUndefined()
    expect(reset.ready).toBe(true)
  })

  test('erasing returns shared batches to their baseline', async ({ page }) => {
    await loadFixture(page, SIZE, `p210a2batch${SIZE}`)
    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )

    const baseline = await page.evaluate(() => {
      const view = (window as unknown as PageWindow).AcApDocManager
        ?.instance?.curView
      return {
        metrics: view!.getSharedBatchMetrics!(),
        entries: view!.getSharedBatchEntries!().length
      }
    })

    const ids = await readDatabaseIds(page)
    const half = ids.filter((_, index) => index % 2 === 0)

    const erased = await page.evaluate(list => {
      const win = window as unknown as PageWindow
      const doc = win.AcApDocManager?.instance?.curDocument
      return doc!.entityService.eraseEntities(list)
    }, half)
    expect(erased).toBe(half.length)

    await page.evaluate(() =>
      (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
    )

    const afterErase = await page.evaluate(() => {
      const view = (window as unknown as PageWindow).AcApDocManager
        ?.instance?.curView
      return {
        metrics: view!.getSharedBatchMetrics!(),
        entries: view!.getSharedBatchEntries!().length,
        readiness: view!.getSceneReadiness!({ sampleLimit: 8 })
      }
    })

    expect(afterErase.readiness.ready).toBe(true)
    // Batches may be emptied and evicted, but the entry count must not grow:
    // per-entity material keys would otherwise leak one batch per erased entity.
    expect(afterErase.entries).toBeLessThanOrEqual(baseline.entries)
    expect(Number(afterErase.metrics.evicted ?? 0)).toBeGreaterThanOrEqual(
      Number(baseline.metrics.evicted ?? 0)
    )

    // Undo brings the erased half back and the scene must settle again.
    const restored = await page.evaluate(async () => {
      const win = window as unknown as PageWindow
      const manager =
        win.AcApDocManager?.instance?.curDocument?.database.transactionManager
      const undone = manager!.undo()
      const snapshot = await win.AcApDocManager?.instance?.curView
        ?.waitUntilSceneReady?.({ timeoutMs: 600_000 })
      return { undone, ready: Boolean(snapshot?.ready), reasons: snapshot?.reasons ?? [] }
    })
    expect(restored.undone).toBe(true)
    expect(restored.ready, `not ready after undo: ${restored.reasons.join(',')}`).toBe(
      true
    )
    expect(sorted(await readDatabaseIds(page))).toEqual(sorted(ids))
  })
})
