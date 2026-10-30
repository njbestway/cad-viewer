# STRUCTURAL_INDEX_STRESS_REPORT — `AcDbChangeRecorder.structuralByKey`

SPEC-CAD-001 · Phase 2.6 · Task B. Baseline: `@mlightcad/data-model`
`1.15.16-perf.1`. Source audited: `realdwg-web/packages/data-model/src/database/
transaction/AcDbChangeRecorder.ts` (499 lines).

**Verdict: the main paths are already linear. One O(k²) residual remains, in a
path whose real depth is 1.** The residual is `opposite.shift()` on a deep
bucket. It needs no fix this round — it is bounded at 36.7 ms in the
pathological case — but it should be fixed in an independent change, not
together with R-8, exactly as the SPEC requires. A second, unrelated cost was
measured here and is much larger than the index: **replaying the redo of a 50k
ERASE takes 43.1 s** because the applier removes entities one id at a time.

| SPEC question | answer |
| --- | --- |
| `structuralByKey` data structure | `Map<string, AcDbStructuralChange[]>`, one bucket per `kind/container/objectId`, bucket in insertion order |
| does `opposite.shift()` exist | **yes**, line 346 — this is the O(k²) residual |
| does an append copy the existing array | **no**, `bucket.push(change)` (line 359); the array is only created on first insert |
| many operations on one structural key | linear for append (2.04× per doubling) and for append/remove pairs (15.8 ms / 20k pairs) |
| `compact()` trigger frequency | only on read: `getChanges()` (84), `finalize()` (214), `validateIndexes()` (238); no-op when nothing was cancelled |
| index correctness after cancellation and nested transactions | exact match against a reference model over 20k interleaved ops; nested commit cancels a parent append correctly; `validateIndexes()` empty in every case |

Test file: `packages/cad-simple-viewer/test/structural-index-stress.spec.ts`
(10 cases, 56 s). Raw data: `reports/phase26/structural-index-stress.json`.

Why the test lives in this repo: `realdwg-web` is outside this workspace
(`code 45405` on write), so the spec drives the *linked* package instead —
`require.resolve('@mlightcad/data-model')` points at the same
`dist/data-model.cjs` this app loads. Nothing is re-implemented; every call is
the shipped `AcDbChangeRecorder`.

---

## 1. What the recorder actually does

```ts
// AcDbChangeRecorder.ts:68
private readonly structuralByKey = new Map<string, AcDbStructuralChange[]>()
// AcDbChangeRecorder.ts:76
private readonly cancelledStructurals = new Set<AcDbDatabaseChange>()
```

```ts
// AcDbChangeRecorder.ts:337 — record one append/remove
const opposite = this.structuralByKey.get(oppositeKey)
if (opposite && opposite.length > 0) {
  const cancelled = opposite.shift()          // <-- the only super-linear call
  if (opposite.length === 0) this.structuralByKey.delete(oppositeKey)
  if (cancelled) this.cancelledStructurals.add(cancelled)
  return                                       // the new change is dropped too
}
const key = structuralKey(change.kind, change.container, objectId)
const bucket = this.structuralByKey.get(key)
if (bucket) bucket.push(change)                // no array copy
else this.structuralByKey.set(key, [change])
this.changes.push(change)
```

Three properties follow, and all three are good:

1. **`Map` lookup, O(1) per operation.** The pre-index implementation scanned
   `changes` linearly to find a cancel partner, making a transaction with n
   structural changes O(n²). That is gone.
2. **Cancelled entries are never appended to `changes`.** A pair cancels at
   record time, so the log does not grow at all for churn — only the tombstone
   set does.
3. **`compact()` is one in-place pass and is skipped when nothing was
   cancelled.** It rewrites `changes` in place (`this.changes[write++] =
   change`), so an array reference previously returned by `getChanges()` keeps
   observing the live set. That invariant is what allows callers to hold the
   array across a commit.

### 1.1 The one remaining hot spot

`opposite.shift()` removes the **head** of the bucket. V8 implements `shift()`
on a small array by moving every remaining element down one slot, so draining a
bucket of depth k costs k + (k-1) + … + 1 ≈ k²/2 slot moves.

Depth k only rises when the *same* object is appended to the *same* container
repeatedly with no opposite change in between, inside one transaction. Real
paths that can do that: a failed insert retried in a loop, a churny block
attribute rewritten per iteration, an undo-record replay that re-appends before
removing. Normal drawing edits keep depth 1–2.

Measured (`deepBucketCancel`):

| k | time | doubling ratio |
| --- | --- | --- |
| 5,000 | 3.79 ms | — |
| 10,000 | 7.44 ms | 1.96 (linear-ish, small-array fast path) |
| 20,000 | 36.70 ms | **4.93 → quadratic** |

At k = 20k the quadratic term dominates and the ratio doubles. The absolute
number is the reason this is not a Phase 2.6 blocker: 36.7 ms is one frame
budget at the pathological depth, and reaching that depth requires 20k
append-only repeats of a single object id.

**Recommended fix (independent change, not applied here):** replace the array
with a head pointer, i.e. keep `Map<string, { items: T[]; head: number }>` and
read `items[head++]` instead of `shift()`, compacting the bucket only when
`head > items.length / 2`. FIFO order is preserved exactly (`shift()` *is* FIFO
head removal), cancellation semantics are unchanged, and memory is bounded by a
`head` field. Alternative, if the bucket is allowed to be a linked list: swap in
a deque. Either way this is ~20 lines in `AcDbChangeRecorder.ts` and needs the
existing 10 cases to stay green.

---

## 2. Measurements

Node v26.5.0, win32 x64. All timings are wall clock around the call under test,
best of three runs (`measure(fn)` in the spec). The large ratios — the ones the
conclusions rest on — are insensitive to warm-up; the sub-millisecond rows are
quantised by the timer, not by the code.

### 2.1 Same key, repeated append (no cancellation)

| appends | time | doubling ratio |
| --- | --- | --- |
| 20,000 | 8.10 ms | — |
| 40,000 | 16.55 ms | **2.04** |

Linear. `push()` amortises, the `Map` lookup is O(1), and the bucket is never
copied.

### 2.2 Same key, append/remove pairs (cancellation)

| pairs | time | resulting `changes.length` | `structuralByKey` after |
| --- | --- | --- | --- |
| 20,000 | 15.83 ms | 0 | empty |

Each pair costs two `Map` lookups plus one `shift()` on a bucket of depth 1 —
which is `arr.shift()` on a one-element array, i.e. O(1). This is the case that
matters in production and it is linear.

### 2.3 Deep bucket — see §1.1

### 2.4 `compact()` cost

50,000 pairs, so 50,000 tombstoned entries in the ordered log:

| read | time |
| --- | --- |
| first `getChanges()` | 0.03 ms |
| second `getChanges()` | 0.03 ms |

The first read pays the linear pass over 50k entries; the second returns
immediately because `cancelledStructurals.size === 0` short-circuits it. Two
consequences worth keeping in mind for Phase 3:

- `finalize()` compacts *before* cloning `after` snapshots, so a cancelled pair
  never causes an object clone. That is the right order — the reverse would
  clone objects whose state did not change.
- `getChanges()` compacts *and* hands out the internal array. Any caller that
  caches the array across a second `getChanges()` sees the in-place result,
  which is the documented invariant of `compact()`.

### 2.5 Many distinct keys

| distinct removes | time | doubling ratio |
| --- | --- | --- |
| 25,000 | 21.94 ms | — |
| 50,000 | 52.39 ms | **2.39** |

Slightly above 2.0 because 50k buckets grow the `Map` past several rehash
thresholds. Not a complexity problem: the extra 0.39 is allocation, and a
bucket that reaches length 1 is deleted immediately (`structuralByKey.delete`),
so memory does not accumulate.

### 2.6 Interleaved containers, checked against a reference model

20,000 random operations (append/remove, 4 containers, seeded mulberry32) →
2,976 live entries, 13.68 ms, and the result is **element-for-element identical**
to a naive reference implementation that does the same linear scan the old code
did. This is the test that actually protects FIFO order and per-container
isolation; a faster structure that changed which duplicate gets cancelled would
fail it.

A second case asserts the obvious-but-easy-to-break rule: the same object id in
two different containers never cancels across containers, because the container
is part of `structuralKey`.

### 2.7 50k ERASE in a single transaction

```ts
manager.runUndoable('Erase', tr => {
  recorder = tr.recorder
  modelSpace.removeEntity(ids)     // one call, 50k ids, one undo boundary
})
```

| phase | time |
| --- | --- |
| build 50k entities | 263 ms |
| erase + commit (records 50k structural changes + 1 modify-free log) | 586 ms |
| undo (restore all 50k) | 81 ms |
| **redo (erase all 50k again)** | **43,136 ms** |
| heap delta for the erase pass | +49.6 MB |
| undo records produced | 1 |
| `validateIndexes()` problems | 0 |

The recorder itself is fine here: 50k changes recorded in the commit phase that
is already inside the 586 ms. `validateIndexes()` — which walks the whole log
and compares every index — reports nothing, so the index agrees with the log
after a bulk erase.

---

## 3. The 43 s redo — a separate finding, reported not fixed

The redo column is three orders of magnitude away from undo, and it is **not**
the change recorder. It is the replay applier:

```ts
// AcDbChangeApplier.ts:173
private applyRemove(container, object) {
  switch (container.type) {
    case 'blockTableRecord': {
      const btr = this.database.tables.blockTable.getIdAt(container.ownerId)
      if (btr) {
        btr.removeEntity(object.objectId)     // ONE id per call
      }
```

and the target of that call scans the whole entity array on every invocation:

```ts
// AcDbBlockTableRecord.ts:495 — accepts AcDbObjectId | AcDbObjectId[]
const ids = Array.isArray(objectId) ? objectId : [objectId]
const idSet = new Set(ids)
...
for (const entity of this._entities) { ... }   // full scan per call
```

`removeEntity` is a batch API, but the applier feeds it one id per change, so
replaying k removals against a record of m entities is Θ(k·m). For k = m =
50,000 that is 1.25 × 10⁹ loop iterations → 43.1 s. Undo is 81 ms because
`applyAppend` calls `btr.appendEntity(object)` in a loop and append is O(1)
amortised.

Consequences:

- Redo of a bulk erase is effectively unusable in the product (43 s of blocked
  main thread on 50k entities), while undo of the same command is instant.
- The view is not the cause: `AcDbDatabaseTransactionManager` batches the
  notifications after the replay (`notifyEntityErased(erased)` once, lines
  420/481/500), so `AcApContext` receives the full erased array in one event.

**Recommended fix (realdwg-web, independent change):** group the changes by
container inside the applier and call the batch API once per container —
`btr.removeEntity(ids)` already exists and already does one pass. That turns
Θ(k·m) into Θ(m + k). Expected effect at 50k: 43 s → tens of milliseconds,
which would put redo on par with undo. This is a two-line change in
`applyRemove` (accumulate, then apply at the end of the loop that walks
`changes`) plus the equivalent grouping in `applyAppend` if append ever becomes
the hot side.

It is deliberately **not** applied in this round: the SPEC says not to mix
kernel changes with the R-8 view-layer fix, and this is a kernel change with
its own blast radius (undo-record ordering, container identity checks,
`applyAppend` symmetry). It is listed as a Phase 3 blocker candidate in §6 below.

---

## 4. Correctness after cancellation and nesting

| case | assertion |
| --- | --- |
| append then remove, same object, same container | log empty, index empty, one tombstone consumed |
| remove then append (reverse order) | identical, because cancellation is order-agnostic on the pair |
| same object in two containers | never cancels across containers |
| nested transaction commits a removal inside a parent append | parent's append is cancelled, log reflects the commit order |
| nested merge boundary | arrival order across the boundary preserved (the case that would break if merge appended instead of `recordStructuralChange`) |
| 20k interleaved ops | identical to the reference model, including which duplicate is cancelled |
| 50k single-transaction erase | `validateIndexes()` empty |

The nested cases matter because `mergeChange()` routes structural entries
through `recordStructuralChange()` (line 391) rather than pushing them. A
child's removal therefore cancels a parent's append, which is what keeps a
savepoint rollback from leaving a stale entry behind.

---

## 5. What this report does not cover

1. **`realdwg-web` CI.** The 10 cases run against the linked build from this
   repo. They should be moved into `realdwg-web` as its own suite; the code is
   copy-ready, only the `require.resolve` bootstrap is repo-specific.
2. **Multiple concurrent transactions.** Everything here is one transaction at
   a time; `AcDbDatabaseTransactionManager` does not run two writers in
   parallel, so this matches the product.
3. **Memory of a long-lived database.** The 49.6 MB heap delta is for the erase
   pass (50k entity objects + 50k change entries + snapshots). It is not a
   leak measurement.
4. **The `shift()` fix.** Not implemented, by design (§1.1).

---

## 6. Conclusion for Phase 2.6

- R-1 style "the index is a hidden O(n²)" is **not** the case any more: every
  production path measured here is linear, and the pre-index linear scan is
  gone.
- The residual O(k²) is real but confined to a pathological depth that normal
  editing does not reach. Fix it separately (§1.1), keep the 10 cases as the
  guard.
- The transaction kernel's **redo** path is the actual large cost around bulk
  erase (43.1 s vs 586 ms for the erase itself). This belongs to Phase 3 and
  should not be mixed into the R-8 view-layer change.
