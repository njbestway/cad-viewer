import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { WORLD_BOX, writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'
import {
  beginWindow,
  endWindow,
  installLatencyProbe
} from '../helpers/latencyProbe'

/**
 * Phase 2.8 Task D — the synchronous cost of one MOVE transaction.
 *
 * Phase 2.5 measured `moveMs` for the whole call. That number cannot answer
 * "where", and the answer decides whether a cheaper implementation is even
 * possible: the transaction writes a before snapshot for every entity
 * (`recordModify` → `clonePreservingIdentity`), applies the transform, then
 * writes an after snapshot for every entity again (`finalize`), dispatches one
 * `entityModified` per entity and finally pushes the undo record.
 *
 * This spec drives the production path —
 * `db.runDatabaseEdit('Move', () => entityService.translateEntities(...))` —
 * and charges every one of those boundaries separately, so the report can say
 * which share is the transform, which share is snapshotting, and which share
 * is the event fan-out into the view.
 *
 * Invariants asserted per size (a timing without them is worthless):
 *  - exactly one undo record, and one `manager.undo()` restores every position;
 *  - the scene keeps the same entity set, no duplicates, no ghost ids;
 *  - the spatial index still answers, and picking still hits;
 *  - `recordModify` and both snapshot counters equal the moved entity count.
 *
 * Sizes come from `P28_MOVE_SIZES` (default `10000,50000`); add `100000`
 * explicitly because it needs a larger heap budget.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase28')
const tag = (process.env.P28_TAG ?? 'run').replace(/[^\w.-]/g, '_')
const sizes = (process.env.P28_MOVE_SIZES ?? '10000,50000')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)

test.use({ trace: 'off' })
test.setTimeout(1_500_000)

interface StageLog {
  ms: number
  calls: number
}

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: ViewHandle
      curDocument?: {
        database: DatabaseHandle
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
  __p28move?: {
    stages: Record<string, StageLog>
    counters: {
      recordModify: number
      recordModifyClones: number
      before: number
      after: number
      modified: number
    }
    note: string[]
  }
  __lat?: unknown
}

interface DatabaseHandle {
  tables: {
    blockTable: {
      modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
      getEntityById: (id: string) => unknown
    }
  }
  transactionManager: Record<string, unknown>
  runDatabaseEdit: (label: string, fn: () => void) => void
  endEventBatch?: unknown
  openEntityForWrite: (entityOrId: unknown) => unknown
  events: { entityModified: { addEventListener: (fn: () => void) => void; removeEventListener: (fn: () => void) => void } }
}

interface ViewHandle {
  batchConvert?: unknown
  applyEntityUpdates?: unknown
  waitUntilIdle?: (timeoutMs?: number) => Promise<boolean>
  pick?: (point: { x: number; y: number }, radius?: number) => Array<{ id: string }>
  renderer?: { _renderer?: { info?: { memory?: { geometries?: number; textures?: number } } } }
  _scene?: {
    _layouts?:
      | Map<string, { _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> } }>
      | Array<{ _spatialIndex?: { search: (box: typeof WORLD_BOX) => Array<{ id: string }> } }>
  }
}

/** Installs the stage wrappers on the live document. */
async function installStagePatches(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const doc = win.AcApDocManager?.instance?.curDocument
    const view = win.AcApDocManager?.instance?.curView
    if (!doc || !view) throw new Error('document not ready')
    const db = doc.database
    const manager = db.transactionManager as Record<string, unknown>

    const state = (win.__p28move ??= {
      stages: {},
      counters: { recordModify: 0, recordModifyClones: 0, before: 0, after: 0, modified: 0 },
      note: []
    })
    const record = (name: string, ms: number) => {
      const entry = (state.stages[name] ??= { ms: 0, calls: 0 })
      entry.ms += ms
      entry.calls += 1
    }
    const wrap = (target: Record<string, unknown>, key: string, name: string) => {
      const original = target[key]
      if (typeof original !== 'function') {
        state.note.push(`missing:${key}`)
        return () => undefined
      }
      const fn = original as (...args: unknown[]) => unknown
      const patched = function patched(this: unknown, ...args: unknown[]) {
        const startedAt = performance.now()
        try {
          return fn.apply(this, args)
        } finally {
          record(name, performance.now() - startedAt)
        }
      }
      target[key] = patched
      return () => {
        target[key] = original
      }
    }

    const restore: Array<() => void> = []
    restore.push(wrap(db as unknown as Record<string, unknown>, 'runDatabaseEdit', 'tx.runDatabaseEdit'))
    for (const key of [
      'startUndoMark',
      'endUndoMark',
      'startTransaction',
      'commitTransaction',
      'dispatchCommitEvents',
      'enqueueUndoChanges'
    ]) {
      restore.push(wrap(manager, key, `tx.${key}`))
    }
    restore.push(
      wrap(db as unknown as Record<string, unknown>, 'openEntityForWrite', 'tx.openEntityForWrite')
    )

    // Reach the recorder through one throwaway transaction so its prototype can
    // be wrapped; `finalize` is where the after snapshots are taken.
    //
    // These three were already replaced by `wrap()` above, so the saved
    // references are thunks that forward `this` - they must be called with the
    // manager as receiver or the manager's own fields are unreachable.
    const startTransaction = manager.startTransaction as () => void
    const currentTransaction = manager.currentTransaction as
      | (() => { recorder: object } | undefined)
      | undefined
    const abortTransaction = manager.abortTransaction as () => void
    if (!currentTransaction) {
      state.note.push('missing:currentTransaction')
    } else {
      startTransaction.call(manager)
      const recorder = currentTransaction.call(manager)?.recorder
      if (!recorder) {
        state.note.push('missing:recorder')
      } else {
        const proto = Object.getPrototypeOf(recorder) as Record<string, unknown>
        restore.push(wrap(proto, 'finalize', 'tx.finalize'))
        const originalRecordModify = proto.recordModify as (...args: unknown[]) => unknown
        proto.recordModify = function patched(this: unknown, ...args: unknown[]) {
          state.counters.recordModify += 1
          const before = state.counters.after
          try {
            return originalRecordModify.apply(this, args)
          } finally {
            // Clones inside `recordModify` are the undo `before` snapshot; the
            // transaction's `originalStates` snapshot happens in `getObject`
            // before this call, so the two are separable by this mark.
            state.counters.recordModifyClones += state.counters.after - before
          }
        }
        restore.push(() => {
          proto.recordModify = originalRecordModify
        })
      }
      abortTransaction.call(manager)
    }

    // Clone counter: `recordModify` clones the before state, `finalize` the
    // after state; the counters are separated by the caller re-basing them
    // around the commit.
    const firstEntity = Array.from(db.tables.blockTable.modelSpace.newIterator())[0] as
      | object
      | undefined
    const ownerProto = (start: object, key: string): Record<string, unknown> | null => {
      let proto: object | null = Object.getPrototypeOf(start)
      while (proto) {
        if (Object.prototype.hasOwnProperty.call(proto, key)) {
          return proto as Record<string, unknown>
        }
        proto = Object.getPrototypeOf(proto)
      }
      return null
    }
    const cloneOwner = firstEntity ? ownerProto(firstEntity, 'clonePreservingIdentity') : null
    if (cloneOwner) {
      const originalClone = cloneOwner.clonePreservingIdentity as (...args: unknown[]) => unknown
      cloneOwner.clonePreservingIdentity = function patched(this: unknown, ...args: unknown[]) {
        // The split between before and after snapshots is decided by the caller:
        // it reads `before` while the edit callback runs and `after` afterwards.
        state.counters.after += 1
        return originalClone.apply(this, args)
      }
      restore.push(() => {
        cloneOwner.clonePreservingIdentity = originalClone
      })
    } else {
      state.note.push('missing:clonePreservingIdentity')
    }

    const transformOwner = firstEntity ? ownerProto(firstEntity, 'transformBy') : null
    if (transformOwner) restore.push(wrap(transformOwner, 'transformBy', 'tx.transformBy'))

    restore.push(wrap(view as unknown as Record<string, unknown>, 'batchConvert', 'view.batchConvert'))

    // One counting listener proves the fan-out size independently of the
    // wrapped dispatcher.
    db.events.entityModified.addEventListener(() => {
      state.counters.modified += 1
    })

    ;(win as unknown as { __p28moveRestore?: () => void }).__p28moveRestore = () => {
      for (const fn of restore.reverse()) fn()
    }
  })
}

/** Drives one MOVE and splits the transaction around the commit. */
async function runMove(page: Page, ids: string[], dx: number, dy: number) {
  return page.evaluate(
    ({ list, offsetX, offsetY }) => {
      const win = window as unknown as PageWindow
      const doc = win.AcApDocManager?.instance?.curDocument
      if (!doc) throw new Error('document unavailable')
      const state = win.__p28move!
      state.stages = {}
      state.note.length = 0
      state.counters = { recordModify: 0, recordModifyClones: 0, before: 0, after: 0, modified: 0 }

      // `after` counts every clone. Reading it at the end of the edit callback
      // (which runs before the commit inside `runUndoable`) separates the
      // before snapshots from the commit-time after snapshots.
      let beforeClones = 0
      const startedAt = performance.now()
      doc.database.runDatabaseEdit('phase28-move', () => {
        const entities = doc.entityService.getEntitiesByIds(list)
        doc.entityService.translateEntities(entities, { x: offsetX, y: offsetY, z: 0 })
        beforeClones = state.counters.after
      })
      const totalMs = performance.now() - startedAt
      const editClones = beforeClones
      const stages = state.stages
      const round = (value: number) => Math.round(value * 10) / 10
      const out: Record<string, { ms: number; calls: number }> = {}
      for (const [name, entry] of Object.entries(stages)) {
        out[name] = { ms: round(entry.ms), calls: entry.calls }
      }
      return {
        totalMs: round(totalMs),
        stages: out,
        recordModify: state.counters.recordModify,
        originalStateClones: editClones - state.counters.recordModifyClones,
        recordModifyClones: state.counters.recordModifyClones,
        afterClones: state.counters.after - editClones,
        entityModified: state.counters.modified,
        note: [...state.note]
      }
    },
    { list: ids, offsetX: dx, offsetY: dy }
  )
}

async function readSceneIds(page: Page): Promise<string[]> {
  return page.evaluate((box: typeof WORLD_BOX) => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return [] as string[]
    const values = layouts instanceof Map ? Array.from(layouts.values()) : Array.from(layouts)
    const ids: string[] = []
    for (const layout of values) {
      for (const item of layout?._spatialIndex?.search(box) ?? []) ids.push(String(item.id))
    }
    return ids
  }, WORLD_BOX)
}

/** First entity X coordinate (object space), used to prove the transform landed. */
async function readFirstX(page: Page, id: string): Promise<number> {
  return page.evaluate((objectId: string) => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const entity = doc?.database.tables.blockTable.getEntityById(objectId) as
      | { startPoint?: { x: number }; position?: { x: number } }
      | undefined
    return entity?.startPoint?.x ?? entity?.position?.x ?? Number.NaN
  }, id)
}

async function readInternal(page: Page) {
  return page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const info = view?.renderer?._renderer?.info
    const undoStack = doc?.database.transactionManager.undoStack as
      | { undoRecords?: unknown[]; _undoRecords?: unknown[] }
      | undefined
    return {
      undoRecords: (undoStack?.undoRecords ?? undoStack?._undoRecords ?? []).length,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null
    }
  })
}

async function waitSceneComplete(page: Page, expected: number, timeoutMs = 900_000) {
  await expect
    .poll(async () => (await readSceneIds(page)).length, { timeout: timeoutMs, intervals: [50, 100, 250] })
    .toBe(expected)
}

for (const size of sizes) {
  test(`MOVE ${size}: transaction stage split`, async ({ page }) => {
    fs.mkdirSync(reportsDir, { recursive: true })
    const fixture = writeMixedFixture(size, `p28move${size}`)

    await installLatencyProbe(page)
    await page.goto('/')
    await uploadFixture(page, fixture)
    const readDbIds = () =>
      page.evaluate(() => {
        const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
        const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
        if (!iterator) return [] as string[]
        const ids: string[] = []
        for (const entity of iterator) ids.push(String(entity.objectId))
        return ids
      })
    await expect
      .poll(async () => (await readDbIds()).length, { timeout: 900_000, intervals: [200] })
      .toBe(size)
    await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      if (view?.waitUntilIdle) await view.waitUntilIdle(900_000)
    })
    await waitSceneComplete(page, size)

    await installStagePatches(page)
    const ids = await readDbIds()
    const probeId = ids[0]
    const beforeX = await readFirstX(page, probeId)
    const beforeScene = await readSceneIds(page)
    const beforeInternal = await readInternal(page)

    await beginWindow(page)
    const move = await runMove(page, ids, 120, 90)
    await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      if (view?.waitUntilIdle) await view.waitUntilIdle(900_000)
    })
    await waitSceneComplete(page, size)
    const window = await endWindow(page)

    const afterX = await readFirstX(page, probeId)
    const afterScene = await readSceneIds(page)
    const afterInternal = await readInternal(page)
    const afterSceneSet = new Set(afterScene)
    const dbIdSet = new Set(ids)

    // Undo must restore the geometry, not just the counts.
    await page.evaluate(() => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.database.transactionManager.undo()
    })
    await page.evaluate(async () => {
      const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
      if (view?.waitUntilIdle) await view.waitUntilIdle(900_000)
    })
    await waitSceneComplete(page, size)
    const undoX = await readFirstX(page, probeId)

    const pick = await page.evaluate(
      ({ x, y }) => {
        const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
        return view?.pick?.({ x, y }, 2).map(item => String(item.id)) ?? []
      },
      { x: 1, y: 1 }
    )

    const record = {
      size,
      move,
      window,
      counts: {
        db: ids.length,
        sceneBefore: beforeScene.length,
        sceneAfter: afterScene.length,
        sceneAfterUnique: afterSceneSet.size,
        missingFromIndex: ids.filter(id => !afterSceneSet.has(id)).length,
        spatialIndexResidual: afterScene.filter(id => !dbIdSet.has(id)).length
      },
      transform: { beforeX, afterX, undoX, dx: 120, dy: 90 },
      undoRecordsAfterMove: afterInternal.undoRecords,
      gpu: { before: beforeInternal, after: afterInternal },
      pick,
      chrome: await page.evaluate(() => navigator.userAgent)
    }

    const outDir = path.join(reportsDir, `phase28-move-browser-${tag}-${size}.json`)
    fs.writeFileSync(outDir, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    expect(move.recordModify).toBe(size)
    expect(move.originalStateClones).toBe(size)
    expect(move.recordModifyClones).toBe(size)
    expect(move.afterClones).toBe(size)
    expect(move.entityModified).toBe(size)
    expect(afterInternal.undoRecords).toBe(1)
    expect(Math.abs(afterX - beforeX - 120)).toBeLessThan(1e-6)
    expect(Math.abs(undoX - beforeX)).toBeLessThan(1e-6)
    expect(record.counts.sceneAfter).toBe(size)
    expect(record.counts.sceneAfterUnique).toBe(size)
    expect(record.counts.missingFromIndex).toBe(0)
    expect(record.counts.spatialIndexResidual).toBe(0)
    expect(pick.length).toBeGreaterThan(0)
  })
}
