# PHASE210_SNAPSHOT_OWNERSHIP_AUDIT — who owns the three transaction snapshots

Phase 2.10 / Task B. Sources read: `realdwg-web` @ `9ca0264` (`perf/change-recorder-index`),
`packages/data-model`, i.e. exactly the tree that produced
`mlightcad-data-model-1.15.16-perf.3.tgz` (SHA256 `E2349D26…09817B`).

The question this file answers is narrow and load-bearing: **may the rollback
snapshot and the undo `before` snapshot be the same object?** Everything in
Task C depends on the answer, and the answer has to come from the code plus a
runtime count, not from the model drawn in the spec.

---

## 1. The model, confirmed against the sources

```
Entity original state (live object, opened for write)
        │
        ├── clone #1  AcDbTransaction.getObject()          originalStates   → abort / rollback
        │                AcDbTransaction.ts:44, :55
        │
        ├── clone #2  recorder.recordModify(opened)         change.before    → undo
        │                AcDbChangeRecorder.ts:128
        │
        └── mutate the live object
                 │
                 └── clone #3  recorder.finalize(database)   change.after     → redo
                                  AcDbChangeRecorder.ts:219
```

The three call sites are the only ones that produce transaction snapshots:

| # | Site | Line | Owner |
| --- | --- | --- | --- |
| 1 | `AcDbTransaction.getObject`, already-opened branch | `AcDbTransaction.ts:44` | `transaction.originalStates` |
| 1 | `AcDbTransaction.getObject`, first-open branch | `AcDbTransaction.ts:55` | `transaction.originalStates` |
| 2 | `AcDbChangeRecorder.recordModify` | `AcDbChangeRecorder.ts:128` | `change.before` |
| 3 | `AcDbChangeRecorder.finalize` | `AcDbChangeRecorder.ts:219` | `change.after` |

`recordModify` has exactly two callers, both the lines above:

```
AcDbTransaction.ts:46   this.recorder.recordModify(opened)
AcDbTransaction.ts:57   this.recorder.recordModify(obj)
```

`finalize` runs once, only on the outermost commit (`AcDbDatabaseTransactionManager.ts:143`).

So for a pure-modify transaction over N distinct object ids the cost is **3N
deep clones**, and clone #1 is the one that is thrown away as soon as the
transaction commits.

---

## 2. Object lifecycle (what frees what)

```
startTransaction
  └─ AcDbDatabaseTransaction (no snapshots yet)

openObjectForWrite(id)            ← AcDbDatabase.ts:770 → :740 → AcDbTransaction.getObject
  ├─ openedObjects[id] = live object
  ├─ originalStates[id] = clone #1                     (only on the first write)
  └─ recorder.modifyById[id] = { before: clone #2 }     (only on the first write)

commitTransaction (nested)        ← manager:136-141
  ├─ parent.recorder.mergeFrom(child.recorder)   change objects move, not copy
  └─ child.commit()  → originalStates.clear(), openedObjects.clear()
        └─ clone #1 of the child becomes unreachable here

commitTransaction (outermost)     ← manager:143-150
  ├─ recorder.finalize(db)        → clone #3 per modify entry
  ├─ changes = recorder.getChanges()   the array itself, not a copy
  ├─ tr.commit() → originalStates.clear()
  │     └─ clone #1 becomes unreachable here            ← the wasted 1/3
  ├─ dispatchCommitEvents(changes)  entities / sysvars / layers only, no snapshot payload
  └─ enqueueUndoChanges(changes) → undoMark.pendingChanges → AcDbUndoStack.push

abortTransaction                  ← manager:158-177
  ├─ changes = [...recorder.getChanges()]     shallow copy, same change objects
  ├─ tr.abort()   → restoreFrom(clone #1) per entry, then clears both maps and the recorder
  └─ changeApplier.applyInverse(changes) → restoreFrom(change.before) per modify entry

undo                              ← manager:226-244
  └─ applyInverse(record.changes) → restoreFrom(change.before)
redo
  └─ applyForward(record.changes) → restoreFrom(change.after)
```

Note the abort path restores twice — once from `originalStates`, once from
`change.before`. Because both restores are `restoreFrom()` of the *same
original state*, the result is idempotent. This matters for Task C: after
sharing, both calls pass the same object, so the sequence is unchanged.

### Retention

| Phase | originalStates | change.before | change.after |
| --- | --- | --- | --- |
| during the transaction | alive | alive | — |
| after commit | **unreachable** | alive (undo stack) | alive (undo stack) |
| after undo | — | alive (redo stack) | alive (redo stack) |
| after `maxDepth` trim (`AcDbUndoStack.ts:51-55`) | — | droppable | droppable |
| after `clearUndoStack()` | — | droppable | droppable |

**Consequence for Task E, stated up front:** sharing removes clone #1, which is
already dead at commit. It reduces *peak* memory during the transaction and the
clone count, but it **cannot** reduce the retained undo history — that history
holds one `before` and one `after` either way. Any claim that sharing lowers
retained snapshot memory would be wrong, and Task E reports it as such rather
than fitting the number to the goal.

---

## 3. B2 — the ten questions, answered from code

### Q1. Is the `originalStates` snapshot ever modified?

No. It is only read, by `AcDbTransaction.abort()` →
`obj.restoreFrom(snapshot)` (`AcDbTransaction.ts:75-80`). `restoreFrom` reads
the snapshot and writes `this`; see Q3. `commit()` only clears the map.

### Q2. Is `recordModify.before` ever modified by a caller?

No. Searching the whole `src` tree for assignments to `.before` finds only the
object literals in `recordModify` (`AcDbChangeRecorder.ts:125-129`) and the
sysvar variant (`:194-198`). The two read sites are:

- `AcDbChangeApplier.applyModify` → `object.restoreFrom(snapshot)`
  (`AcDbChangeApplier.ts:199-202`);
- `acdbCollectLayerModifications` → `acdbDiffLayerTableRecordAttrs(before, after)`,
  which only calls `getAttrWithoutException` (`AcDbChangeApplier.ts:486-494`).

### Q3. Does `restoreFrom()` modify the snapshot it is given?

No. `AcDbObject.restoreFrom` (`AcDbObject.ts:826-862`) reads `snapshot._attrs`,
`snapshot._xDataMap` and the own keys, and for each value writes
`target[key] = this.cloneValue(source[key])` — a deep copy into `this`. The only
assignments in the method are `this.objectId` and `this.database`, both writes to
the *target*. The helpers are the same shape:

- `restoreAttrsFrom` clones `source.attributes` before touching `this._attrs`
  (`AcDbObject.ts:725-739`);
- `restoreXDataMapFrom` builds a new map from cloned values (`:746-759`).

This is the single most important fact in the audit: a snapshot is an immutable
value object by construction, not by convention.

### Q4. Can an event listener reach a mutable snapshot?

Not through the commit/undo event payloads. `dispatchEntityModified` dispatches
`{ database, entity }` only (`AcDbDatabaseTransactionManager.ts:563-566`,
`:599-602`); appended/erased carry live entities; layer events carry a fresh
`Partial<attrs>` object; sysvar events carry primitive values. None of them
publishes `change.before`.

There is one convention-level exposure: `AcDbChangeRecorder.getChanges()`
returns the internal array ("callers should treat it as read-only",
`AcDbChangeRecorder.ts:78-86`), and any holder of the current transaction can
reach it. It has exactly three callers in this tree
(`mergeFrom`, `commitTransaction`, `abortTransaction`) and none mutates a
change. Sharing does not widen this surface — an undo record already keeps the
same `change` object alive indefinitely — but the read-only contract must be
stated in the design rather than assumed.

### Q5. Can a nested transaction overwrite the parent's before state?

No. `mergeFrom` → `mergeChange` only accepts a child modify entry when the
parent has no entry for that id yet (`AcDbChangeRecorder.ts:375-380`). The
parent's own entry (and therefore its own `before`) wins; the child's change
object is simply dropped, and the child's `originalStates` is cleared by
`tr.commit()`.

Order matters and both orders are safe:

- **parent writes first**, child writes the same id → child entry dropped,
  parent keeps its pair; the child's clone #1 dies with the child.
- **child writes first**, parent writes later → parent's `modifyById` already
  has the id (merged), so the parent does not clone again; the surviving
  `before` is the child's, and `parent.originalStates` has no entry for that id,
  so abort relies on `applyInverse` exactly as it does today.

### Q6. Does clearing `originalStates` on commit break the undo record?

No, and this is the whole point of Task C. Without sharing, clone #1 has no
reader after `commit()` and is collected. With sharing, the object is still
referenced by `change.before` inside the undo record; `originalStates.clear()`
removes a map entry, not the object.

### Q7. Do shared objects free correctly when undo history is trimmed?

Yes. `AcDbUndoStack.trimUndoRecords` drops the oldest record with `shift()`
(`AcDbUndoStack.ts:51-55`). A record's only references are its `changes` array
and each change's `before`/`after`; after sharing the `before` object has no
second owner (the transaction map is already cleared). `clearUndoStack()` is the
same story.

### Q8. Is `before` created only once when one entity is modified repeatedly?

Yes, twice guarded: `originalStates.has(objectId)` (`AcDbTransaction.ts:42`) and
`modifyById.has(objectId)` (`AcDbChangeRecorder.ts:122`). The second and later
opens return the cached live object and do not clone.

### Q9. After an abort, does re-editing the same ObjectId see a stale snapshot?

No. `abort()` clears `originalStates`, `openedObjects` and the recorder
(`AcDbTransaction.ts:82-84`); the shallow `changes` copy in
`abortTransaction` (`manager:164`) is a local that dies with the call. The next
transaction clones from the restored live state.

### Q10. Does mixing append/remove with modify change snapshot ownership?

No. Structural changes clone the object at the moment of the structural
operation (`AcDbChangeRecorder.ts:156-179`) and that clone is the replay payload
for re-inserting or removing it; it is a *different* object from the modify
`before`, produced at a different time from different state. A single entity
that is removed and then modified gets both snapshots, unshared. Sharing is
restricted to `kind: 'modify'` and does not touch the structural payloads.

---

## 4. Shareability contract

Sharing is allowed only under all of the following invariants. They are written
so Task C can be checked against them line by line.

| # | Invariant | Current status |
| --- | --- | --- |
| I1 | The shared object is `clonePreservingIdentity()` of the live object at its first write in *this* transaction | holds (`AcDbTransaction.ts:44/:55`) |
| I2 | After creation the object is never written: no field assignment, no `restoreFrom` into it, no `close()`/`transformBy` on it | holds — §3 Q1–Q3 |
| I3 | `restoreFrom(snapshot)` stays read-only | holds (`AcDbObject.ts:826-862`) |
| I4 | No event payload or public API hands out a mutable `before` reference | holds for events; `getChanges()` is internal-API and documented read-only |
| I5 | A nested child's shared snapshot moves with the change object, never outlives it | holds (`mergeFrom` transfers the change) |
| I6 | `commit()` / `abort()` only drop map entries, never the snapshot object | holds (`AcDbTransaction.ts:66-85`) |
| I7 | No new long-lived strong reference is introduced | holds — the object is already referenced by the undo record |
| I8 | Copy-on-write is *not* required, because no writer exists | holds — but see §6 |

**Verdict for Task B: the before snapshot is safe to share with the rollback
snapshot.** Conditions: the sharing must happen inside
`AcDbTransaction.getObject` (the only place that owns both), must be gated by a
switchable experiment flag, and must not change what `recordModify` does for any
other caller — it keeps cloning when no snapshot is supplied.

---

## 5. What sharing must not touch

- `append` / `remove` payloads: separate clones, separate semantics (§3 Q10).
- sysvar entries: primitive values, no clone at all.
- The `after` snapshot: still required by redo, still produced by `finalize`.
- Change order inside `changes`: unchanged, so undo/redo replay order and the
  event stream derived from it are unchanged.
- `objectId` / `ownerId` / `database`: `clonePreservingIdentity` already
  preserves them, and `restoreFrom` restores around them.

---

## 6. The one thing that would forbid sharing

If any code path mutated a `before` snapshot, sharing would silently corrupt
the rollback state of an *unrelated* lifetime (the abort of the transaction
would hand the undo record a modified object, or vice versa). Nothing in the
tree does that today, and §3 Q3 shows the mutating direction is structurally
impossible for the restore path.

The residual risk is future code: `getChanges()` is public and hands out change
objects. The design therefore proposes a development-time assertion (mutation
probe behind a flag) rather than a production `Object.freeze` — freezing 50k
snapshot graphs would cost more than the clone it saves, and the spec forbids an
unmeasured default.

**Copy-on-write is not needed and must not be added speculatively:** with no
writer, a CoW layer would add a check on every restore and a copy on the first
write of a shared snapshot — and that first write never happens. Task E measures
`copyOnWriteCount` as a hard zero so the claim is checkable.

---

## 7. B1 — the clone counts, measured

The audit above is static; the 3N → 2N claim is now measured rather than
inferred. Two independent harnesses spy on
`AcDbObject.prototype.clonePreservingIdentity` and read the kernel's own
counters (§`AcDbSnapshotSharingMetrics`):

| Scenario | Baseline (sharing off) | After sharing | Where |
| --- | --- | --- | --- |
| N objects, one write each, commit | 3N (N rollback + N before + N after) | 2N (N rollback/shared-before + N after) | `AcDbTransactionSnapshotFlow.spec.ts`, `phase210Move.spec.ts` |
| Same object opened for write 3× | 2 (one pair only) | 2 (one pair only) | `AcDbTransactionSnapshotFlow.spec.ts` |
| Abort | 2N, no `after` | N, no `after` | `AcDbTransactionSnapshotFlow.spec.ts` |
| Undo / redo replay | 0 clones | 0 clones | both |
| Nested child commit then parent commit | 3N | 2N | `AcDbTransactionSnapshotSharing.spec.ts` (C3) |
| `sharedBeforeSnapshotCount` | 0 | N | both |
| `copyOnWriteCount` | 0 | **0 (must stay 0)** | both |

Measured at 1k / 10k / 50k / 100k entities: `cloneCountBefore` = 3N and
`cloneCountAfter` = 2N in every size, i.e. exactly −33.3 %, with
`sharedBeforeSnapshotCount` = N and `copyOnWriteCount` = 0 throughout. The raw
per-sample numbers are in `reports/phase210/node/node-move-*.json`.

The fifth row is the one that could have failed quietly: a child transaction
commits its changes into the parent, so the parent's `before` snapshot has two
possible owners. The C3 suite proves the outermost `before` survives all three
levels and that the child never overwrites it — see
`PHASE210_TRANSACTION_CORRECTNESS.md` §3.

---

## 8. Reproduce

```bash
# data-model: kernel + sharing + regression (3 suites / 41 tests)
cd E:/rustpro/realdwg-web
git rev-parse HEAD                      # 9ca026409971b27d806b2808ad1216a966369155
npx jest --testPathPatterns "AcDbTransactionSnapshot" --verbose

# whole data-model package: 133 suites / 1100 tests
npx jest packages/data-model

# clone counts at scale (interleaved A/B, 5 samples per arm)
PHASE210_BENCH=1 PHASE210_SIZE=50000 PHASE210_SAMPLES=5 \
  PHASE210_OUT=E:/rustpro/cad-viewer/reports/phase210/node \
  npx jest --testPathPatterns "phase210Move"

# production bundle A/B in the browser (dev + prod)
cd E:/rustpro/cad-viewer/packages/cad-editor-demo
P210AB_SIZES=1000,10000,50000 npx playwright test e2e/tests/phase210-browser-ab.spec.ts
P210AB_MODE=prod P210AB_SIZES=1000,10000,50000 \
  npx playwright test --config playwright.prod.config.ts e2e/tests/phase210-browser-ab.spec.ts

# scene-readiness supplement (Task A2)
npx playwright test e2e/tests/phase210-scene-readiness.spec.ts

# heap residue controls (Task F2) and slot attribution (Task F1)
npx playwright test e2e/tests/phase210-heap-series.spec.ts --workers=1
npx playwright test e2e/tests/phase210-batch-slot-attribution.spec.ts --workers=1
```

Baseline before any Phase 2.10 edit: the three existing suites
(`AcDbTransaction`, `AcDbDatabaseTransactionManager`, `AcDbChangeRecorder`) were
green at 3 suites / 57 tests / 11.8 s. After the change the three *new* suites
cover 41 tests in 10.5 s, and the whole package is 133 suites / 1100 tests in
48 s.

