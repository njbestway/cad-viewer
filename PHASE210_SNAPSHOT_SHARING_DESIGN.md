# PHASE210_SNAPSHOT_SHARING_DESIGN — one before state, two readers

Phase 2.10 · Task C. Companion documents: `PHASE210_SNAPSHOT_OWNERSHIP_AUDIT.md`
(why sharing is safe), `PHASE210_TRANSACTION_CORRECTNESS.md` (what must not
change), `PHASE210_PERFORMANCE_REPORT.md` (what it bought),
`PHASE210_HEAP_RETENTION_AUDIT.md` (what it did not).

---

## 1. The change in one paragraph

A first write to an object used to take two deep clones of the same unmodified
state: one into `AcDbTransaction.originalStates` for abort, one into
`AcDbModifyChange.before` for undo. Phase 2.10 takes the rollback snapshot and
hands *that same object* to the recorder, so the pair shares one immutable
snapshot. A pure modify transaction therefore drops from 3N to 2N deep clones,
where N is the number of distinct object ids opened for write. Nothing is
removed: the rollback snapshot still exists, the undo record still holds a
`before`, and the `after` snapshot taken by `finalize()` is untouched.

The shared object is never written after creation. `restoreFrom()` copies *from*
it, the change applier copies *from* it, and no other path has a reason to touch
it — see the ownership audit for the ten cases that establish this.

## 2. Why the decision lives in the transaction, not the recorder

`AcDbChangeRecorder.recordModify(object)` cannot know whether its caller already
holds an equivalent snapshot, so it has to clone. `AcDbTransaction` is the only
place that owns both consumers (`originalStates` and `recorder`), so the sharing
decision is made there and passed down as an explicit argument:

```ts
// AcDbTransaction.captureOriginalState()
const snapshot = object.clonePreservingIdentity()   // clone #1, always
this.originalStates.set(object.objectId, snapshot)
this.recorder.recordModify(object, this.shareBeforeSnapshot ? snapshot : undefined)
```

`recordModify(object, beforeSnapshot?)` keeps its old signature semantics: with
no second argument it clones exactly as before. Every other caller in the
codebase keeps omitting it, so their behaviour is bit-for-bit unchanged. This is
deliberate — the switch has one consumer, and `grep` proves it.

## 3. File-by-file

### `AcDbTransaction.ts` (+144 −12)

- `AcDbTransactionOptions` adds exactly two knobs: `shareBeforeSnapshot`
  (default `false`) and `estimateSnapshotBytes` (default undefined).
- New private `captureOriginalState(object)` is now the single place that clones
  the original state and registers it with both consumers. Both `openObject`
  paths (cached and freshly loaded) call it instead of open-coding
  `clone → set → recordModify`.
- Per-transaction counters: `openedForWrite`, `uniqueModifiedObjects`,
  `rollbackSnapshotClones`, `snapshotCloneMs`, `recordModifyMs`,
  `snapshotBytes`, and the read-only `isSnapshotSharingEnabled`.

Repeated opens of the same id still take one snapshot: the `originalStates.has()`
guard is unchanged, and a repeat now only bumps `openedForWrite`. This is what
keeps the "3× opened → 2 clones" property from the audit.

### `AcDbChangeRecorder.ts` (+49 −2)

- `recordModify(object, beforeSnapshot?)` — uses the supplied snapshot when
  present, otherwise clones. New counters `sharedBeforeSnapshotCount`,
  `beforeSnapshotClones`, `afterSnapshotClones`.
- `mergeFrom(other)` rolls the child's recorder counters into the parent. Without
  this a nested child commit would silently lose its accounting when the child
  recorder is discarded.

### `AcDbDatabaseTransaction.ts` (+10 −2)

Forwards `AcDbTransactionOptions` to the base constructor. No behaviour change
when the options are absent.

### `AcDbDatabaseTransactionManager.ts` (+127 −3)

- `snapshotSharing` (default `false`) and `snapshotSizeEstimator` (default
  `undefined`), read **once** in `startTransaction()`. Flipping the flag never
  changes a transaction that is already open — that is asserted by a test, not
  just documented.
- `getSnapshotSharingMetrics()` / `resetSnapshotSharingMetrics()` /
  `addSnapshotTransformMs(ms)`; see §5.
- `commitTransaction`, `abortTransaction`, `undo`, `redo` gained `performance.now()`
  brackets for `commitMs`, `finalizeMs`, `abortMs`, `undoMs`, `redoMs`.
- `absorbTransactionCounters(tr, includeRecorder)` folds a leaving transaction's
  counters into the manager. A nested commit passes `includeRecorder = false`
  because `mergeFrom` already rolled the recorder counters up — counting them
  twice would have been the one easy way to make the metrics lie.

### `AcDbUndoStack.ts` (+46 −0)

`retainedChangeCount`, `undoChangeCount`, `redoChangeCount` and
`forEachChange(visit)`. The stacks are otherwise opaque, and both the retained
byte estimate and the harness need to walk them. Read-only.

### `AcDbSnapshotSharingMetrics.ts` (new, 87 lines)

The 18-field measurement contract, plus `acdbCreateSnapshotSharingMetrics()` so
the manager and the tests agree on the shape. `copyOnWriteCount` exists to be
falsifiable: sharing needs no copy-on-write because no code path writes a
snapshot, so the counter must stay at zero; if it ever moves, this design is
wrong.

## 4. Constraints from the spec, and how each is met

| C2 constraint | How it is met |
| --- | --- |
| Sharing only within one transaction, same entity, same original state | The shared object is the transaction's own `originalStates` entry for the id being opened; no cross-transaction path exists |
| No cross-transaction sharing by default | `snapshotSharing` is per-manager and off by default; each transaction reads it at creation |
| Explicit ownership, not convention-based | Ownership is stated in `AcDbTransactionOptions` and enforced by the audit: the transaction owns the snapshot for the transaction's lifetime, the recorder holds a read-only alias |
| Copy-on-write only if measured | Not implemented. `copyOnWriteCount` is asserted to stay 0 |
| Dev-mode assertion allowed, no production deep freeze | Not implemented (no mutation was found to guard); the property is asserted instead |
| Must not delete the `after` snapshot `finalize()` needs | `finalize()` is untouched; `afterSnapshotClones` = N in every arm |
| Must not change change ordering | `recordModify` still appends to `changes` in the same order; `mergeFrom` order unchanged |
| Must not change ObjectId / Handle / OwnerId | `clonePreservingIdentity()` is still the only clone used |
| Must not change event count/order/payload | Commit/abort dispatch untouched; `absorbTransactionCounters` only moves numbers |

## 5. The metrics contract

Exactly 18 fields, matching `AcDbSnapshotSharingMetrics`:

| # | Field | Kind |
| --- | --- | --- |
| 1 | `openedForWrite` | counter |
| 2 | `uniqueModifiedObjects` | counter |
| 3 | `rollbackSnapshotClones` | counter |
| 4 | `beforeSnapshotClones` | counter |
| 5 | `afterSnapshotClones` | counter |
| 6 | `sharedBeforeSnapshotCount` | counter |
| 7 | `copyOnWriteCount` | invariant (must be 0) |
| 8 | `snapshotBytesEstimated` | estimator-driven |
| 9 | `openForWriteMs` | timer |
| 10 | `recordModifyMs` | timer |
| 11 | `transformMs` | caller-reported |
| 12 | `finalizeMs` | timer |
| 13 | `commitMs` | timer |
| 14 | `undoMs` | timer |
| 15 | `redoMs` | timer |
| 16 | `abortMs` | timer |
| 17 | `retainedUndoChanges` | sampled |
| 18 | `retainedSnapshotBytesEstimated` | sampled |

`transformMs` and `snapshotBytesEstimated` are fed in from outside
(`addSnapshotTransformMs`, `snapshotSizeEstimator`) instead of being invented by
the kernel: the kernel cannot see a caller's transform, and it must not walk
every snapshot on the production path. Both are 0/undefined unless a harness sets
them.

`retainedUndoChanges` and `retainedSnapshotBytesEstimated` are sampled at call
time (from `AcDbUndoStack`), not accumulated, so they answer "what does the
history hold right now" rather than "what did it ever hold".

## 6. Why the retained-byte number does not move

`retainedSnapshotBytesEstimated` counts what the undo *and redo* stacks keep
after commit: `before` + `after` per modified id, i.e. 2N snapshots. Sharing
removes the *transient* duplicate that exists between `openObject` and
`finalize` — it never removed anything from the history, so 2N stays 2N and the
ratio is exactly 1.0 at every size.

This is the honest reading of the A/B and it is why the peak, not the
steady-state, is where the win is. It is also exactly the situation the spec's
E4 warns about: clone count dropped by a third while retained bytes did not
improve, so the report has to carry a heap retainer analysis instead of claiming
a memory win. That analysis is `PHASE210_HEAP_RETENTION_AUDIT.md`, and its
conclusion is that the residual 0.3 MB/round is *not* a transaction snapshot at
all — it is batch slot metadata on the renderer side, and it is bounded per
document.

## 7. Rollout state

`snapshotSharing` defaults to `false` in the data-model build, so shipping this
build changes no behaviour. Turning it on is a one-line change in
`AcDbDatabaseTransactionManager` once the reviewer accepts the A/B in
`PHASE210_PERFORMANCE_REPORT.md`. The switch exists for exactly one reason: both
arms of every measurement run the same binary, so the comparison isolates the
design rather than the build.

## 8. What this design deliberately does not do

- No transform/inverse-matrix undo.
- No GPU incremental translate.
- No change to the undo record structure or its persistence.
- No transaction splitting, no open write transaction across an event-loop turn.
- No worker/Rust/Wry migration.
- No attempt to move the 3N → 2N result into "memory saved" territory. The
  retained history is unchanged by construction; claiming otherwise would be
  false.
