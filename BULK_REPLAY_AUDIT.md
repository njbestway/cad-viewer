# BULK_REPLAY_AUDIT — replay order and event semantics

SPEC-CAD-001 · Phase 2.7 · Task A. Source audited:
`realdwg-web/packages/data-model/src/database/transaction/` at
`@mlightcad/data-model@1.15.16-perf.1`.

**Verdict: consecutive same-container removals are interchangeable, and the
only reason the old code was Θ(k·m) is that `applyRemove` was called once per
change. Collapsing a maximal run of consecutive removes that share one block
table record into a single `btr.removeEntity(ids)` preserves the resulting
database state, the recorded change list, the event order, the event count and
the event payloads. Nothing else in the record may be reordered.**

The audit below answers the eight questions in the SPEC one by one. Every claim
cites the code that backs it.

---

## 0. The replay pipeline in one page

```
user command ──► AcDbDatabaseTransactionManager.runUndoable(label, fn)
                    │  startUndoMark → startTransaction → fn → commitTransaction
                    │     └─ recorder.recordAppend/recordRemove per mutation
                    │  endUndoMark → undoStack.push({ label, changes })
                    ▼
              AcDbUndoRecord { label, changes: AcDbDatabaseChange[] }
                    │
   undo() ──────────┤────────── redo()
   popUndo()        │           popRedo()
   beginEventBatch  │           beginEventBatch
   _applyingUndoRedo = true      _applyingUndoRedo = true
                    ▼
        changeApplier.applyInverse(changes)   /   applyForward(changes)
                    │                                   │
                    │  i = n-1 … 0                      │  i = 0 … n-1
                    │  applyChange(changes[i], false)   │  applyChange(changes[i], true)
                    ▼                                   ▼
        dispatchUndoRedoEvents(changes, true/false)  ← walks `changes` again,
                    │                                  in array order, after replay
   endEventBatch → flush queued entity/layer/dict events
   undoStack.pushRedo(record) / pushUndo(record)
```

`abortTransaction()` uses the same inverse path but dispatches no events at all
(`AcDbDatabaseTransactionManager.ts:158-177`).

---

## 1. Forward and inverse traversal order

| Direction | Entry point | Order | Code |
| --- | --- | --- | --- |
| Redo (forward) | `applyForward` | `i = 0 … n-1`, ascending | `AcDbChangeApplier.ts:38-42` |
| Undo, abort (inverse) | `applyInverse` | `i = n-1 … 0`, descending | `AcDbChangeApplier.ts:51-55` |

Per-change dispatch (`AcDbChangeApplier.ts:63-86`):

| `change.kind` | forward | inverse |
| --- | --- | --- |
| `modify` | `object.restoreFrom(after)` | `object.restoreFrom(before)` |
| `append` | `applyAppend(container, object)` | `applyRemove(container, object)` |
| `remove` | `applyRemove(container, object)` | `applyAppend(container, object)` |
| `sysvar` | `setVar(name, after)` | `setVar(name, before)` |

Consequences:

* **Redo is the expensive direction for a bulk ERASE**, because the record for
  an ERASE holds exactly *n* `remove` entries and forward replay turns each of
  them into one `applyRemove` → one `btr.removeEntity(single)`.
* **Undo is cheap**, because inverse replay turns the same entries into
  `appendEntity(single)` calls, which are amortised O(1)
  (`AcDbBlockTableRecord.ts:426-477`: one `push` per entity).
* Inverse replay is also *reversed*, so any batching applied there would have
  to build its runs backwards. It is not needed; see §3.

## 2. Can repeated removes from one BTR be merged safely?

Yes, and the proof is short enough to write down.

Let `S` be the array `btr._entities` before the run, and let `R` be the multiset
of ids carried by the run's `remove` changes. The single-call implementation
(`AcDbBlockTableRecord.ts:495-537`) performs one **stable** compaction:

```
survivors(S, R) = [e for e in S if e.objectId ∉ set(R)]
```

Sequential per-id calls apply that same filter once per id, in run order:

```
survivors(...survivors(survivors(S, {r1}), {r2})..., {rk})
  = [e for e in S if e.objectId ∉ {r1..rk}]
```

Both reduce to the same sequence, so **the surviving entity order is identical**
— which matters, because `newIterator()` walks `_entities` and layout/regeneration
order is observable. Duplicates inside `R` collapse in both cases: the batched
form uses `new Set(ids)` (`:510`), the sequential form finds nothing left on the
second attempt.

What is *not* identical is the intermediate state and the side effects the loop
triggers, so the run has to be justified against each of them:

| Side effect in the loop | Sequential | Batched | Equivalent? |
| --- | --- | --- | --- |
| `manager.recordRemove(container, entity)` (`:516-521`) | called per removed entity | called per removed entity, in `_entities` order | **No call at all during replay**: `recordRemove` is a no-op unless `isRecording()` (`AcDbDatabaseTransactionManager.ts:315-320`), and `isRecording()` is false while `_applyingUndoRedo` (`:91-93`). |
| `database.releaseObjectHandle(entity)` (`:523`) | run order | `_entities` order | Yes for results: the registry is `Map<objectId, object>` and `releaseObjectHandle` only deletes the exact object's key (`AcDbDatabase.ts:1181-1189`). Deletion order is unobservable, and there is no free list — new handles come from a monotonic counter (`:1100-1106`, `_maxHandle++` at `:1091`). |
| `database.notifyEntityErased(entities)` (`:529-535`) | per call, **once per removed entity** | per call, once for the whole batch | Guarded by `!manager.isRecording() && !manager.isApplyingUndoRedo()`. During replay both are false, so **neither form dispatches here**. Undo/redo events are produced separately, after the replay, from the change list (§6). |
| `strictMode` guard (`:497-503`) | throws before mutating | throws before mutating | Identical: the check is the first statement and no partial mutation can precede it. |

The one thing the merge changes is *how many times the array is walked*:
Θ(k·m) → Θ(m + k). That is the entire point of the change.

## 3. Ordering barriers

A change must be replayed in place, and therefore **flushes the pending run**,
when any of the following hold:

| Barrier | Why it cannot be deferred |
| --- | --- |
| `kind === 'modify'` | `applyModify` does `database.getObjectById(objectId)` and restores a snapshot. Moving a remove across it would change whether the object is still resolvable. |
| `kind === 'sysvar'` | Ordered against everything else by `acdbCollectChangeEntities` / `dispatchUndoRedoEvents`; also observable by listeners. |
| `kind === 'append'` | Re-appending an entity that a later remove expects to be present (Insert → Erase) must happen first. |
| `kind === 'remove'` with `container.type !== 'blockTableRecord'` | Symbol table and dictionary removals use `removeId` and have no bulk API (`AcDbChangeApplier.ts:185-201`). They stay per-change. |
| `kind === 'remove'` in a **different** `ownerId` | Different array; merging would only merge across containers, which the SPEC forbids without a proof, and buys nothing (one scan per container instead of per entity is already the win). |
| End of the change list | Trivial flush. |

Runs are therefore *maximal consecutive* same-`ownerId` sequences of
`blockTableRecord` removes — exactly the "continuous Remove run + flush on
barrier" strategy the SPEC allows.

Note what is **not** a barrier: two removes of *different* ids in the same
container. That is the case the fix targets.

## 4. Cross-BTR dependencies

`applyRemove` resolves the container lazily, per change, with
`database.tables.blockTable.getIdAt(container.ownerId)` (`:179`). Flushing at
every `ownerId` change means a run resolves the BTR exactly once instead of once
per change, and each of those resolutions would have returned the same object,
because nothing inside a run can add or remove a block table record.

The one real dependency is a record that removes a **BTR from the block table**
(`container.type === 'symbolTable'`, `tableName === 'blockTable'`) and then
removes entities owned by it. That is a symbol-table change, so it is a barrier:
the run is flushed before it, and the following entity removes still resolve
`getIdAt(ownerId)` on the post-removal block table — i.e. exactly what the old
per-change code would have done.

No other cross-container ordering exists: a remove touches only its own BTR's
`_entities` array and the handle registry.

## 5. One object id in several structural changes

The recorder already prevents the common case: `recordStructuralChange`
(`AcDbChangeRecorder.ts:337-364`) cancels an `append`/`remove` pair for the same
`(kind-opposite, container, objectId)` and drops both, so a record never holds
"remove X, then append X back into the same container".

What can still appear:

1. **The same id twice in one container run.** Only reachable when the same
   entity is erased twice across a nested-transaction merge. `new Set(ids)`
   collapses it; the sequential form's second call is a no-op. Same result.
2. **Remove from BTR *and* append to a dictionary** (e.g. a symbol-table style
   move). Different containers, therefore different runs, therefore ordered
   against each other by the barrier rule. Unchanged behaviour.
3. **Remove from BTR, modify, remove again.** A `modify` is a barrier, so the
   second remove starts a new run. Unchanged.
4. **Remove for an id that no longer exists** (already removed by an earlier
   change in the same record — only possible via hand-built records). Both forms
   are silent no-ops (`removeEntity` returns `false`,
   `AcDbBlockTableRecord.ts:536`).

## 6. Does replay create new recorder entries?

No. Both `recordAppend` and `recordRemove` early-return unless
`isRecording()` (`AcDbDatabaseTransactionManager.ts:300-320`), and
`isRecording()` is `hasTransaction() && !_applyingUndoRedo` (`:91-93`).
`undo()`, `redo()` and `abortTransaction()` all set `_applyingUndoRedo = true`
for the duration of the replay (`:233`, `:258`, `:167`). There is also no
transaction on the stack while replaying, so even without the flag
`currentTransaction()` would be `undefined`.

The undo record is therefore *the same array object* before and after a replay;
`redo()` moves it between the two stacks (`AcDbUndoStack.ts:62-82`) without
touching `changes`. This is what makes "Undo/Redo must be strictly identical to
the old implementation" a mechanical, not a statistical, claim.

## 7. Recovery when replay fails

There is none, and this is pre-existing behaviour that the fix does not change:

* `undo()`/`redo()` pop the record **before** applying it (`:227`, `:252`), so a
  throw loses the record from both stacks.
* `applyForward`/`applyInverse` have no try/catch and no snapshot to roll back
  to. A throw in the middle leaves every change applied so far in place.
* The `finally` blocks still reset `_applyingUndoRedo` and close the event
  batch, so queued events for the partially applied subset *are* flushed.
* `btr.removeEntity(ids)` cannot throw partially: the `strictMode` guard is the
  first statement, and the loop below it is array compaction plus `Map.delete`
  (`AcDbBlockTableRecord.ts:495-537`). A batched call is therefore *safer* than
  a sequence of calls, not less safe — either all ids are removed or none is.

## 8. Event order, count and payloads

All undo/redo notifications are produced **after** the replay, by
`dispatchUndoRedoEvents` (`:463-533`), which walks `changes` in array order:

```
acdbCollectChangeEntities(database, changes)   // AcDbChangeApplier.ts:245-285
  modify  → resolve live object, push to `modified`
  append  → push to `appended`
  remove  → push `change.object` (the stored snapshot) to `erased`
```

Then, forward direction (`inverse === false`):

```
for modified:  dispatchEntityModified(e)          // one per entity
appended > 0:  notifyEntityAppended(appended)     // ONE dispatch, array payload
erased   > 0:  notifyEntityErased(erased)         // ONE dispatch, array payload
dictSet / dictErased: one dispatch per entry
sysvar: one dispatch per entry
layer mods: acdbCollectLayerModifications(...)
```

and inverse swaps `erased`/`appended` (a redo-erase shows up as an append on
undo). `dispatchEntityModified` and `dispatchLayerModified` coalesce through
`_pendingEntityModified` / `_pendingLayerModified` while
`database.isEventBatched()` (`:558-573`, `:538-541`), and
`notifyEntity*` queue into `_pendingEntityAppended` / `_pendingEntityErased`
(`AcDbDatabase.ts:935-962`).

Since every one of those walks `changes` — never the execution order — **the
event stream is a pure function of the change list**. Batching executes the same
list in the same order with the same result and does not touch the list, so the
stream is bit-identical: same number of dispatches, same array payloads, same
payload order, same time (after the replay, not during).

Measured confirmation, `n = 1000`, one record, five repetitions
(`reports/phase27/replay-baseline.json`):

| direction | `entityErased` | `entityAppended` |
| --- | --- | --- |
| undo | 0 dispatches / 0 entities | 1 dispatch / 1000 entities |
| redo | 1 dispatch / 1000 entities | 0 dispatches / 0 entities |

The same table is asserted for every size as a regression guard in
`benchmarks/bulk-edit/replay.bench.ts`.

---

## 9. Why the cost is Θ(k·m), and where the fix belongs

`AcDbBlockTableRecord.removeEntity` always walks the whole array once
(`:514-527`), so *k* single-id calls on an array of *m* entities cost
Σ(m − i) ≈ k·m. Measured on the baseline build, model space, one transaction,
one undo record, median of 5:

| n | redo median | `removeEntity` calls | slots walked |
| --- | --- | --- | --- |
| 1 000 | 25.1 ms | 1 000 | 500 500 |
| 5 000 | 512.9 ms | 5 000 | 12 502 500 |
| 20 000 | 10 138.7 ms | 20 000 | 200 010 000 |
| 50 000 | 58 814.7 ms | 50 000 | 1 250 025 000 |

`slots walked` is `n(n+1)/2` to within a rounding, i.e. the whole cost is the
repeated scan. Everything else in the replay — `acdbCollectChangeEntities`, the
single batch dispatch, `endEventBatch` — is linear and shows up as the ~1 ms per
5 000 entities of the undo direction.

The fix is therefore a **call-count** fix, not an algorithm change: collapse a
maximal run of same-container removes into one call and the same 50 000 ids cost
one walk instead of 50 000. See `BULK_REPLAY_OPTIMIZATION_REPORT.md`.

## 10. What the audit rules out

| Candidate | Verdict |
| --- | --- |
| Batch by collecting *all* removes to the end of the record | **Rejected.** Not provably safe (§3) and the SPEC forbids it. Maximal consecutive runs give the same asymptotic win for a real bulk ERASE, where all removes are contiguous. |
| Batch across containers | **Rejected.** No proof of independence, and the win is already achieved per container. |
| Batch appends (undo direction) | **Not needed.** `appendEntity` is amortised O(1); measured undo is 113 ms at 50k. Left per-change to keep the diff minimal. |
| Add a batch entry to `removeId` for symbol tables / dictionaries | **Out of scope.** Those are not on the ERASE hot path. |
| Suppress events during replay to save time | **Forbidden** by the SPEC and unnecessary: `beginEventBatch` already collapses the payload into one dispatch. |
| Touch `btr._entities` from the applier | **Forbidden** by the SPEC and unnecessary: the public batch API is enough. |
