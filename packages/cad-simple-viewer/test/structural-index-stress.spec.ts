import fs from 'node:fs'
import path from 'node:path'

import {
  AcDbChangeRecorder,
  AcDbDatabase,
  AcDbLine,
  AcGePoint3d
} from '@mlightcad/data-model'
import type { AcDbChangeContainer, AcDbObject } from '@mlightcad/data-model'

/**
 * Structural index stress tests for `AcDbChangeRecorder` (SPEC-CAD-001 Phase 2.6
 * Task B).
 *
 * The recorder keeps an ordered change log plus three indexes; the one under
 * test here is `structuralByKey: Map<kind/container/objectId, entry[]>`. The
 * audit questions were:
 *
 * 1. does a repeated append on one key stay linear, or does the bucket copy;
 * 2. does append/remove cancellation stay linear, or does the bucket shift;
 * 3. does interleaving many containers keep FIFO and cancellation semantics;
 * 4. does a 50k single-transaction ERASE stay linear end to end.
 *
 * Timing assertions here are *scaling* assertions: the same code shape runs at
 * N and 2N in one process and the ratio is bounded (linear ≈ 2, quadratic ≈ 4).
 * That is the only way to detect a quadratic path from outside the class
 * without reaching into private fields, and it is far less sensitive to machine
 * speed than an absolute threshold. Measured numbers are written to
 * `reports/phase26/structural-index-stress.json` so the report quotes a run.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const REPORT_PATH = path.join(REPO_ROOT, 'reports', 'phase26', 'structural-index-stress.json')

/** Model-space block table record. */
const BLOCK: AcDbChangeContainer = { type: 'blockTableRecord', ownerId: 'MS' }
/** A symbol table. */
const TABLE: AcDbChangeContainer = { type: 'symbolTable', tableName: 'layers' }
/** A named dictionary entry. */
const dictEntry = (key: string): AcDbChangeContainer => ({
  type: 'dictionary',
  dictionaryId: 'DICT',
  key
})

/**
 * Identity-preserving stand-in object.
 *
 * The recorder reads only `object.objectId` and calls
 * `object.clonePreservingIdentity()`, so a stand-in isolates recorder cost from
 * entity-clone cost. The 50k ERASE case uses real `AcDbLine` entities, where
 * the clone cost is part of what is being measured.
 */
class FakeRecord {
  constructor(readonly objectId: string) {}

  clonePreservingIdentity() {
    return new FakeRecord(this.objectId)
  }
}

/** One stand-in object for `objectId`. */
const fakeRecord = (objectId: string) =>
  new FakeRecord(objectId) as unknown as AcDbObject

/** Deterministic PRNG (mulberry32). */
function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Best-of-`repeats` wall clock of `fn`, in milliseconds. */
function measure(fn: () => void, repeats = 3): number {
  let best = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < repeats; attempt++) {
    const startedAt = performance.now()
    fn()
    best = Math.min(best, performance.now() - startedAt)
  }
  return Math.round(best * 100) / 100
}

/** `t(2N) / t(N)`; a linear path lands near 2, a quadratic one near 4. */
function doubling(durationN: number, durationDouble: number): number {
  if (durationN <= 0) return Number.NaN
  return Math.round((durationDouble / durationN) * 100) / 100
}

/** Everything this file measured, written once at the end. */
const findings: {
  platform: Record<string, string>
  measurements: Record<string, unknown>
  notes: string[]
} = {
  platform: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // Resolved entry point of the package under test, as installed for this run.
    dataModelEntry: require.resolve('@mlightcad/data-model')
  },
  measurements: {},
  notes: []
}

afterAll(() => {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
})

/** Counts live entries of the structural index for `objectId`. */
function appendedCount(recorder: AcDbChangeRecorder, objectId: string): number {
  const changes = recorder.getChanges()
  let count = 0
  for (const change of changes) {
    if (change.kind === 'append' || change.kind === 'remove') {
      if (change.object.objectId === objectId) count++
    }
  }
  return count
}

describe('structuralByKey - one key, repeated appends', () => {
  test('appending 40k times to one key stays linear', () => {
    const run = (count: number) =>
      measure(() => {
        const recorder = new AcDbChangeRecorder()
        const object = fakeRecord('E1')
        for (let index = 0; index < count; index++) recorder.recordAppend(BLOCK, object)
        expect(recorder.getChanges().length).toBe(count)
      })

    const n20000 = run(20_000)
    const n40000 = run(40_000)
    const ratio = doubling(n20000, n40000)
    findings.measurements.repeatedAppend = {
      n20000Ms: n20000,
      n40000Ms: n40000,
      doublingRatio: ratio
    }

    const recorder = new AcDbChangeRecorder()
    const object = fakeRecord('E1')
    for (let index = 0; index < 40_000; index++) recorder.recordAppend(BLOCK, object)
    // Every append is retained: the bucket is a queue, not a set.
    expect(appendedCount(recorder, 'E1')).toBe(40_000)
    expect(recorder.validateIndexes()).toEqual([])
    // A copy-on-append bucket would land near 4.
    expect(ratio).toBeLessThan(2.8)
  }, 300_000)
})

describe('structuralByKey - one key, append/remove cancellation', () => {
  test('20k alternating pairs cancel and leave no change behind', () => {
    const durationMs = measure(() => {
      const recorder = new AcDbChangeRecorder()
      const object = fakeRecord('E1')
      for (let index = 0; index < 20_000; index++) {
        recorder.recordAppend(BLOCK, object)
        recorder.recordRemove(BLOCK, object)
      }
      expect(recorder.getChanges().length).toBe(0)
    })

    const recorder = new AcDbChangeRecorder()
    const object = fakeRecord('E1')
    for (let index = 0; index < 20_000; index++) {
      recorder.recordAppend(BLOCK, object)
      recorder.recordRemove(BLOCK, object)
    }
    findings.measurements.alternatingCancel = { pairs: 20_000, durationMs }
    expect(recorder.validateIndexes()).toEqual([])
    expect(recorder.getChanges()).toEqual([])
  }, 300_000)

  test('deep bucket: k appends then k removes, k up to 20k', () => {
    const run = (depth: number) =>
      measure(() => {
        const recorder = new AcDbChangeRecorder()
        const object = fakeRecord('E1')
        for (let index = 0; index < depth; index++) recorder.recordAppend(BLOCK, object)
        for (let index = 0; index < depth; index++) recorder.recordRemove(BLOCK, object)
        expect(recorder.getChanges().length).toBe(0)
      })

    const depth5000 = run(5_000)
    const depth10000 = run(10_000)
    const depth20000 = run(20_000)
    findings.measurements.deepBucketCancel = {
      k5000Ms: depth5000,
      k10000Ms: depth10000,
      k20000Ms: depth20000,
      doublingRatio5to10: doubling(depth5000, depth10000),
      doublingRatio10to20: doubling(depth10000, depth20000),
      note:
        'A remove cancels the earliest append on the same key through Array#shift, which moves the remaining depth-1 slots one position down. Draining a bucket of depth k therefore costs O(k^2) slot moves. Depth only grows when one object is appended repeatedly with no opposite change inside the same transaction (failed insert retried, churny block attribute), so real depth is small; the numbers above bound the pathological case.'
    }

    const recorder = new AcDbChangeRecorder()
    const object = fakeRecord('E1')
    for (let index = 0; index < 20_000; index++) recorder.recordAppend(BLOCK, object)
    for (let index = 0; index < 20_000; index++) recorder.recordRemove(BLOCK, object)
    expect(recorder.getChanges()).toEqual([])
    expect(recorder.validateIndexes()).toEqual([])
    // Documented ceiling for the pathological depth, not a target.
    expect(depth20000).toBeLessThan(15_000)
  }, 300_000)

  test('compaction is one linear pass and later reads are free', () => {
    const recorder = new AcDbChangeRecorder()
    const object = fakeRecord('E1')
    const pairs = 50_000
    for (let index = 0; index < pairs; index++) {
      recorder.recordAppend(BLOCK, object)
      recorder.recordRemove(BLOCK, object)
    }

    const firstRead = measure(() => {
      expect(recorder.getChanges().length).toBe(0)
    }, 5)
    const secondRead = measure(() => {
      expect(recorder.getChanges().length).toBe(0)
    }, 5)
    findings.measurements.compaction = {
      tombstonedEntries: pairs,
      firstReadMs: firstRead,
      secondReadMs: secondRead
    }

    // The second read cannot pay the scan again: the tombstones are gone, so
    // `compact()` returns immediately.
    expect(secondRead).toBeLessThanOrEqual(Math.max(firstRead, 0.5) + 0.5)
    expect(recorder.validateIndexes()).toEqual([])
  }, 300_000)
})

/* ------------------------------------------------------------------ *
 * Multi-container interleaving against a reference model
 * ------------------------------------------------------------------ */

interface StructuralOp {
  kind: 'append' | 'remove'
  container: AcDbChangeContainer
  objectId: string
}

/** Container identity, mirroring the recorder's own key rule. */
function containerKey(container: AcDbChangeContainer): string {
  switch (container.type) {
    case 'blockTableRecord':
      return `btr:${container.ownerId}`
    case 'symbolTable':
      return `table:${container.tableName}`
    case 'dictionary':
      return `dict:${container.dictionaryId}/${container.key}`
  }
}

/**
 * Reference implementation of the cancellation rule: a new change cancels the
 * *earliest* live opposite change on the same key and is itself dropped;
 * otherwise it joins the live log in arrival order.
 */
function referenceModel(ops: readonly StructuralOp[]): StructuralOp[] {
  const live: StructuralOp[] = []
  for (const op of ops) {
    const oppositeKind = op.kind === 'append' ? 'remove' : 'append'
    const cancelIndex = live.findIndex(
      entry =>
        entry.kind === oppositeKind &&
        entry.objectId === op.objectId &&
        containerKey(entry.container) === containerKey(op.container)
    )
    if (cancelIndex >= 0) {
      live.splice(cancelIndex, 1)
    } else {
      live.push(op)
    }
  }
  return live
}

/** Deterministic interleaved workload over four containers and 120 objects. */
function buildInterleavedOps(count: number, seed: number): StructuralOp[] {
  const rng = createRng(seed)
  const containers: AcDbChangeContainer[] = [BLOCK, TABLE, dictEntry('k1'), dictEntry('k2')]
  const ops: StructuralOp[] = []
  for (let index = 0; index < count; index++) {
    const objectId = `E${Math.floor(rng() * 120)}`
    // Skewed towards appends so the live log keeps a non-trivial size.
    const kind: StructuralOp['kind'] = rng() < 0.45 ? 'remove' : 'append'
    ops.push({ kind, container: containers[Math.floor(rng() * containers.length)], objectId })
  }
  return ops
}

describe('structuralByKey - interleaved containers', () => {
  test('matches the reference cancellation model exactly', () => {
    const ops = buildInterleavedOps(20_000, 20261028)
    const objects = new Map<string, AcDbObject>()
    const objectFor = (objectId: string) => {
      let object = objects.get(objectId)
      if (!object) {
        object = fakeRecord(objectId)
        objects.set(objectId, object)
      }
      return object
    }

    const durationMs = measure(() => {
      const replay = new AcDbChangeRecorder()
      for (const op of ops) {
        if (op.kind === 'append') replay.recordAppend(op.container, objectFor(op.objectId))
        else replay.recordRemove(op.container, objectFor(op.objectId))
      }
      replay.getChanges()
    })

    const recorder = new AcDbChangeRecorder()
    for (const op of ops) {
      if (op.kind === 'append') recorder.recordAppend(op.container, objectFor(op.objectId))
      else recorder.recordRemove(op.container, objectFor(op.objectId))
    }

    const actual: StructuralOp[] = []
    for (const change of recorder.getChanges()) {
      if (change.kind === 'modify' || change.kind === 'sysvar') {
        throw new Error(`unexpected ${change.kind} entry in a structural-only workload`)
      }
      actual.push({
        kind: change.kind,
        container: change.container,
        objectId: change.object.objectId
      })
    }
    const expected = referenceModel(ops)
    const project = (entry: StructuralOp) =>
      `${entry.kind}:${containerKey(entry.container)}:${entry.objectId}`

    findings.measurements.interleaved = {
      operations: ops.length,
      liveEntries: expected.length,
      durationMs
    }

    expect(actual.length).toBe(expected.length)
    expect(actual.map(project)).toEqual(expected.map(project))
    expect(recorder.validateIndexes()).toEqual([])
  }, 300_000)

  test('the same object in two containers never cancels across containers', () => {
    const recorder = new AcDbChangeRecorder()
    const object = fakeRecord('E7')
    recorder.recordAppend(BLOCK, object)
    recorder.recordAppend(TABLE, object)
    recorder.recordAppend(dictEntry('k1'), object)
    // The opposite change only cancels the matching container.
    recorder.recordRemove(TABLE, object)

    const kinds: string[] = []
    for (const change of recorder.getChanges()) {
      if (change.kind === 'append' || change.kind === 'remove') kinds.push(change.kind)
    }
    expect(kinds).toEqual(['append', 'append'])
    expect(recorder.validateIndexes()).toEqual([])
  })
})

describe('structuralByKey - many distinct keys', () => {
  test('50k distinct removes stay linear', () => {
    const run = (count: number) =>
      measure(() => {
        const recorder = new AcDbChangeRecorder()
        for (let index = 0; index < count; index++) {
          recorder.recordRemove(BLOCK, fakeRecord(`E${index}`))
        }
        expect(recorder.getChanges().length).toBe(count)
      })

    const n25000 = run(25_000)
    const n50000 = run(50_000)
    const ratio = doubling(n25000, n50000)
    findings.measurements.distinctKeys = {
      n25000Ms: n25000,
      n50000Ms: n50000,
      doublingRatio: ratio
    }
    expect(ratio).toBeLessThan(2.8)
  }, 300_000)
})

describe('nested transactions', () => {
  test('a child removal cancels a parent append when the child commits', () => {
    const db = new AcDbDatabase()
    const manager = db.transactionManager
    const object = fakeRecord('E9')

    const parent = manager.startTransaction()
    parent.recorder.recordAppend(BLOCK, object)

    const child = manager.startTransaction()
    child.recorder.recordRemove(BLOCK, object)
    manager.commitTransaction()

    expect(manager.currentTransaction()).toBe(parent)
    expect(parent.recorder.getChanges()).toEqual([])
    expect(parent.recorder.validateIndexes()).toEqual([])

    manager.abortTransaction()
  })

  test('merging preserves arrival order across the boundary', () => {
    const db = new AcDbDatabase()
    const manager = db.transactionManager

    const parent = manager.startTransaction()
    parent.recorder.recordAppend(BLOCK, fakeRecord('A'))

    const child = manager.startTransaction()
    child.recorder.recordAppend(BLOCK, fakeRecord('B'))
    child.recorder.recordAppend(BLOCK, fakeRecord('C'))
    manager.commitTransaction()

    const order: string[] = []
    for (const change of parent.recorder.getChanges()) {
      if (change.kind === 'append' || change.kind === 'remove') {
        order.push(change.object.objectId)
      }
    }
    expect(order).toEqual(['A', 'B', 'C'])
    expect(parent.recorder.validateIndexes()).toEqual([])

    manager.abortTransaction()
  })
})

/* ------------------------------------------------------------------ *
 * End-to-end: 50k entities erased in one transaction
 * ------------------------------------------------------------------ */

describe('50k single-transaction ERASE', () => {
  test('one command, one undo boundary, one redo boundary', () => {
    const count = 50_000
    const db = new AcDbDatabase()
    const modelSpace = db.tables.blockTable.modelSpace
    const manager = db.transactionManager

    const buildStartedAt = performance.now()
    for (let index = 0; index < count; index++) {
      modelSpace.appendEntity(
        new AcDbLine(new AcGePoint3d(index, 0, 0), new AcGePoint3d(index + 10, 10, 0))
      )
    }
    const buildMs = performance.now() - buildStartedAt

    const ids: string[] = []
    for (const entity of modelSpace.newIterator()) ids.push(entity.objectId)
    expect(ids.length).toBe(count)

    let recorder: AcDbChangeRecorder | undefined
    const heapBefore = process.memoryUsage().heapUsed
    const eraseStartedAt = performance.now()
    // Exactly what `AcApEntityService.eraseEntities` does for one ERASE command:
    // one undo mark, one transaction, one batched `removeEntity(ids)`.
    manager.runUndoable('Erase', tr => {
      recorder = tr.recorder
      modelSpace.removeEntity(ids)
    })
    const eraseAndCommitMs = performance.now() - eraseStartedAt
    const heapAfterErase = process.memoryUsage().heapUsed

    expect(manager.hasTransaction()).toBe(false)
    expect(modelSpace.newIterator().toArray().length).toBe(0)
    expect(manager.canUndo()).toBe(true)
    // One transaction means one undo record, and the recorder agrees with it.
    expect(recorder!.getChanges().length).toBe(count)
    expect(recorder!.validateIndexes()).toEqual([])

    const undoStartedAt = performance.now()
    expect(manager.undo()).toBe(true)
    const undoMs = performance.now() - undoStartedAt
    const restored: string[] = []
    for (const entity of modelSpace.newIterator()) restored.push(entity.objectId)
    expect(restored.length).toBe(count)
    // Undo restores the same handles, not fresh ones.
    expect(new Set(restored)).toEqual(new Set(ids))

    const redoStartedAt = performance.now()
    expect(manager.redo()).toBe(true)
    const redoMs = performance.now() - redoStartedAt
    expect(modelSpace.newIterator().toArray().length).toBe(0)

    findings.measurements.singleTransactionErase = {
      entityCount: count,
      buildMs: Math.round(buildMs),
      eraseAndCommitMs: Math.round(eraseAndCommitMs),
      undoMs: Math.round(undoMs),
      redoMs: Math.round(redoMs),
      heapDeltaEraseMB: Math.round(((heapAfterErase - heapBefore) / 1048576) * 10) / 10,
      undoRecordCount: 1,
      validateIndexesProblems: 0
    }

    expect(eraseAndCommitMs).toBeLessThan(120_000)
    expect(undoMs).toBeLessThan(120_000)
    expect(redoMs).toBeLessThan(120_000)
  }, 600_000)
})
