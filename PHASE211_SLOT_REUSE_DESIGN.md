# PHASE211 · Task C — Slot Reuse & Metadata Release Design

**Status:** implemented, measured, and gated by the Phase 2.11 regression suites.
**Scope:** `packages/three-renderer` (slot table only). No transaction, undo-record,
GPU fast-path or batching-architecture change is part of this design.

Related documents:

| document | question it answers |
| --- | --- |
| `PHASE211_SLOT_LIFECYCLE_AUDIT.md` | why the slot table grew (Task B) |
| `PHASE211_MEMORY_CONVERGENCE_REPORT.md` | does it still grow (Task E) |
| `PHASE211_CORRECTNESS_REPORT.md` | is reuse safe (Task D) |
| `PHASE211_PERFORMANCE_REPORT.md` | did it cost anything (Task F) |
| `PHASE211_MOVE_CONVERSION_PROFILE.md` | what the same code costs in MOVE (Task G) |

---

## 1. Non-goals (binding for this phase)

The following were explicitly *not* touched, and any of them appearing in a diff
means this design was violated:

* no `TransformUndo`;
* no change to the undo-record format;
* no GPU buffer translate fast path;
* no rewrite of the batch / instancing structure;
* no MOVE 2-second optimisation;
* no Worker / Wry / Rust migration;
* no fixture shrink used to hide growth.

---

## 2. The eight invariants

Task C1 asks for eight properties. Each is listed with the mechanism that makes
it hold *structurally* (cannot be violated by construction) or *defensively*
(detected and reported) and the test that fails if the mechanism is removed.

| # | Invariant | Mechanism | Kind | Test |
| --- | --- | --- | --- | --- |
| I1 | An active slot id is never in the free list | `rebuildAvailableGeometryIds()` derives the list from `flags` and skips active records; `reserveGeometryId()` pops before the record is installed | structural | `leaves the free list equal to the set of freed slots after compaction`; `reports a free list with no duplicates, no active ids and no stale ranges` |
| I2 | One slot id appears at most once in the free list | the rebuild pushes each index exactly once (loop over indices, not over records) | structural | same as I1 |
| I3 | A released slot is not usable by Picking / Selection | `deleteGeometryById()` clears `AcTrBatchGeometryFlags.Active` first, and `AcTrBatchedGroup.removeEntities()` drops `_entitiesMap[objectId]` *before* `optimize()` runs, so no objectId can reach the slot again | structural | `does not keep a removed slot pickable`; `clears selection and hover before the slot is handed to another entity`; `picks and bounds only the current owner of a reused slot` |
| I4 | A reused slot carries no state from its previous owner | the new record is a fresh object (`createGeometryState()`), assigned over the old one by `reserveGeometryId()`; nothing is merged in | structural | `hands a reused slot a record with no state from its previous owner` |
| I5 | The cached bounding box belongs to the current entity and geometry version | `releaseSlotMetadata()` sets `boundingBox = null`; every mutation path (`setGeometryAt`, `applyGeometryAt`, matrix writes) invalidates the cache before reuse | structural + invalidation | `drops the bounding box of a freed slot`; `survives MOVE → Undo → Redo with the geometry following the slot` |
| I6 | A hidden draw snapshot is not inherited | `releaseSlotMetadata()` deletes `hiddenDrawSnapshot`; a hidden slot that is released therefore cannot restore the previous owner's GPU slice | structural | `drops the hidden draw snapshot of a freed slot` |
| I7 | An async task cannot write a slot that now belongs to another entity | **enforced today by three existing gates only** — `_convertEpoch`, `_entityConvertGeneration`, `_erasedConvertObjectIds`. The new `slotGeneration` stamp is *not* part of the enforcement: no production call site reads it (see §7). It exists so that a future async writer can reject a captured `(batchId, slotGeneration)` in one local check | structural (gates) / reserved (stamp) | browser D16 / D17 / D18 (see correctness report) |
| I8 | After a batch is closed, no stale reference can update a slot | `clear()`/`reset()` empties `_geometryInfo` and the free list; `validateGeometryId()` throws on any out-of-range id | structural | `refuses a slot id after the batch has been reset`; `drops every slot record when the batch is reset`; browser `close document releases slot tables` |

`slotGeneration` is the only *new* state introduced. It is deliberately a
property of the container (a counter stamped by the reserve path) rather than a
contract its callers must remember, and it costs one integer per slot. It is a
**reserved hook**: nothing in the production commit path reads it yet (§7).

---

## 3. Root cause, one paragraph

`optimize()` on all four batched containers ended with
`this._availableGeometryIds.length = 0` — a line that was correct when the only
`optimize()` caller was a full rebuild, and wrong once MOVE/ERASE routes started
deleting individual slots and then compacting. Deleted ids were pushed by
`deleteGeometryById()` and dropped microseconds later by compaction, so
`reserveGeometryId()` never found a pooled id and always appended a new record.
The slot table therefore tracked the number of *inserts*, not the number of live
entities. Full evidence, including the six required findings, is in
`PHASE211_SLOT_LIFECYCLE_AUDIT.md`.

---

## 4. The change

Four edits, all inside the slot-lifecycle helpers:

### 4.1 Rebuild the pool instead of clearing it

`AcTrBatchSlotLifecycleMetrics.rebuildAvailableGeometryIds(geometryInfo, pool, counters)`
replaces the four `_availableGeometryIds.length = 0` sites in
`AcTrBatchedMesh`, `AcTrBatchedLine`, `AcTrBatchedLine2` and
`AcTrBatchedPoint`:

```ts
availableGeometryIds.length = 0
for (let id = 0; id < geometryInfo.length; id++) {
  if (!isBatchGeometryActive(geometryInfo[id].flags)) availableGeometryIds.push(id)
}
```

Deriving the list rather than patching it is what makes I1 and I2 structural:
the loop cannot push an active id and cannot push one twice. The return value is
the number of ids the *previous* list held that the rebuild dropped — non-zero
only if a live slot had been pooled — and is accumulated in
`freeListDroppedByOptimize` so an audit can see that class of bug happen instead
of inferring it.

### 4.2 Release per-slot metadata on delete

`deleteGeometryById()` now calls `releaseSlotMetadata(info)` before pushing the id:

```ts
info.flags = AcTrBatchGeometryFlags.None
if (info.boundingBox !== undefined) info.boundingBox = null
delete info.hiddenDrawSnapshot
```

Those two references were the only retained objects Phase 2.10 could trace to a
freed slot (~200 `Box3` per round, plus hidden-slot GPU slices). **This is
release, not reuse** — the array entry itself stays, and capacity convergence
comes from §4.3, not from clearing boxes. Clearing a box while still appending a
record per round would have made the heap test pass and left `_geometryInfo`
growing; the audit note in Task C2 exists precisely to reject that.

### 4.3 Reuse the newest freed id (LIFO)

`reserveGeometryId()` pops from the pool (newest first) instead of sorting the
pool ascending and shifting. Two consequences, both wanted:

* the LIFO order keeps the *tail* of the table free, so the high-water mark
  stays put instead of being preserved by a hole in the middle;
* it removes an `O(k log k)` sort from the reserve path, which Task G measured
  as 13.9 s of a 15 s single-task block on a 50k MOVE (see
  `PHASE211_MOVE_CONVERSION_PROFILE.md`). Reuse order is not observable: packed
  ranges live in the slot record, never in the id.

The id is stamped with `nextSlotGeneration(previousRecord)`, and the previous
record is still in the table at that moment — no side table is needed to
recover the counter.

### 4.4 Observe it

`AcTrBatchSlotLifecycleCounters` (O(1) counters) and
`collectSlotLifecycleMetrics()` (gauges from one scan of the table) feed
`AcTrBatchedGroup.getSlotLifecycleMetrics()`, which sums per-container records
and is exposed to the browser suite as `view.getSlotLifecycleMetrics()`. The
metric record is the 16-field `BatchSlotLifecycleMetrics` required by Task B1
plus `batchCount`, `batchCountLive` and `batchCountAllFreed`.

Gauges are computed on demand; the hot path only increments integers, so the
diagnostic surface costs nothing when nobody reads it.

---

## 5. What "clearing the previous owner's state" actually covers

Task C2 asks for the full list, not just `boundingBox`. Written out:

| state | where it lives | reset by |
| --- | --- | --- |
| active flag | `slot.flags` | `releaseSlotMetadata()` → `None` |
| cached bounds | `slot.boundingBox` | `releaseSlotMetadata()` → `null` |
| hidden draw snapshot | `slot.hiddenDrawSnapshot` | `releaseSlotMetadata()` → `delete` |
| owner generation | `slot.slotGeneration` | `reserveGeometryId()` → `previous + 1` |
| packed vertex/index range | `slot.vertexStart/indexStart/vertexCount/indexCount` | overwritten by the fresh record; stale ranges are zero-filled by `copyGeometryAttributes()` |
| selection / hover mask | container mask attributes | `removeEntities()` clears `select`/`hover` **before** the records are released, one flush per container |
| objectId ↔ slot mapping | `AcTrBatchedGroup._entitiesMap` | `_entitiesMap.delete(objectId)` before `optimize()` |
| GPU instance index | the `batchId` in `_entitiesMap` items | dropped with the map entry; a reused id gets a new `batchId` from the reserve path |
| shared-batch membership | `AcTrSharedGeometryBatch` template slots | unchanged — the shared batch owns its own template slots and has its own eviction (Phase 2.9 behaviour, regression-tested here) |

Two things are deliberately **not** reset: the packed buffer bytes (overwritten
on next write, zero-filled on shrink) and the array slot itself (that is what
capacity convergence buys).

---

## 6. Capacity policy (Task C3)

* `_geometryInfo` never shrinks on delete. Compaction rewrites packed ranges and
  remaps indices; it does not `pop()` records, because a record's index *is* the
  slot id and truncating the tail would renumber live ids.
* Capacity therefore converges to the high-water mark of concurrent live slots
  for a scene. For the Phase 2.11 fixtures that is exactly the live count:
  900 / 9 000 / 45 000 slots for 1k / 10k / 50k entities, constant from the
  second round to the last (see the convergence report).
* Growth is only re-entered when a genuinely new high-water mark appears
  (amortised via `growCapacityIfNeeded`), which is what an edit that adds more
  simultaneous instances than ever before must do.
* We explicitly did not add a "shrink after idle" compaction: it would move
  every packed range and renumber every live id for a bounded, already-flat
  table, i.e. exactly the large repeated allocation the task warns against.

`slotHighWaterMark` is reported separately from `slotCapacity` so a future
reviewer can tell "the table is at its historical maximum" from "the table
grew this round".

---

## 7. Async safety

Slot ids do not cross an `await` in the shipped conversion path: a convert job
claims an objectId, converts, and commits inside one slice. The reuse work does
not relax that, and does not rely on it either:

* `_erasedConvertObjectIds` is a tombstone set consulted at commit, so an ERASE
  that lands after a job was queued still rejects the commit (D16);
* `_entityConvertGeneration` makes a newer job for the same object supersede an
  older one (D17);
* `slotGeneration` makes "this slot was reused while you were away"
  *detectable* rather than merely unlikely. D18 asserts the late job's geometry
  never becomes pickable at its own position — but note that D18 passes because of
  the three gates above, **not** because of `slotGeneration`.

**`slotGeneration` has no production consumer in Phase 2.11.** It is stamped on the
record (`reserveGeometryId()`), exposed through `isSlotGenerationCurrent(info,
generation)`, asserted in the node spec and persisted in the metrics payload — and
that is all. The node spec calls the helper directly, so the guarantee it provides
today is "the field is correct and the predicate is available", not "asynchronous
commit is isolated". The isolation that *is* relied on comes from the epoch /
generation / tombstone gates, which are consulted at the production commit site.
Any later claim that `slotGeneration` closes a race must first show the call site
that reads it.

If a future change does introduce an await between reserve and commit,
`isSlotGenerationCurrent(info, generation)` is the check that has to be added at
the commit site — the field and the helper exist so that change is local.

---

## 8. Diagnostics contract

`view.getSlotLifecycleMetrics()` returns, summed over every batched container
reachable from the active layout:

```
allocatedSlots slotCapacity liveSlots freedSlots reusedSlots
freeListSize freeListPushCount freeListPopCount
deleteGeometryCalls deleteGeometrySkipped duplicateFreeAttempts
liveBoundingBoxes inactiveBoundingBoxes retainedHiddenSnapshots slotHighWaterMark
batchCount batchCountLive batchCountAllFreed
```

Health rules used by the suites:

* `freedSlots === freeListSize` after an `optimize()` (I1 + I2, given the rebuild);
* `duplicateFreeAttempts` and `deleteGeometrySkipped` are 0 outside a
  deliberately repeated delete;
* `inactiveBoundingBoxes` and `retainedHiddenSnapshots` are 0 (I5, I6);
* `slotCapacity` constant across rounds once warmed, `liveSlots` equal to the
  expected entity count.

---

## 9. Rejected alternatives

| alternative | why rejected |
| --- | --- |
| Keep `length = 0` and re-derive ids by scanning at reserve time | turns every reserve into an `O(n)` scan; 50k MOVE would rescan 50k slots 50k times |
| `splice()` the freed record out of `_geometryInfo` | renumbers every id above it — invalidates `_entitiesMap`, masks, picking and any captured id |
| Trim the tail after `optimize()` | only helps when the tail is already free; LIFO reuse makes that the common case, so trimming adds movement for no bounded benefit |
| Free-list as a `Set` | loses LIFO locality, allocates per operation; the array is already duplicate-free by construction |
| Per-slot `WeakRef` to the entity | the slot record is the only owner; a weak ref would make reuse non-deterministic for no memory win |
| Release metadata but keep appending records ("fix the heap, not the table") | explicitly forbidden by Task C2 — it hides the growth instead of removing it |

---

## 10. Diff surface

Production files changed under `packages/three-renderer/src/batch/`:

* `AcTrBatchSlotLifecycleMetrics.ts` *(new)* — counters, rebuild, gauges, group totals.
* `AcTrBatchedGeometryInfo.ts` — `slotGeneration`, `nextSlotGeneration`, `isSlotGenerationCurrent`.
* `AcTrBatchedMixin.ts` — LIFO reserve, generation stamping, `releaseSlotMetadata` in delete, `getSlotLifecycleMetrics()`.
* `AcTrBatchedMesh.ts`, `AcTrBatchedLine.ts`, `AcTrBatchedLine2.ts`, `AcTrBatchedPoint.ts` — rebuild instead of clear in `optimize()`.
* `AcTrBatchedGroup.ts` — `getSlotLifecycleMetrics()` aggregation.

Tests: `__tests__/AcTrBatchSlotLifecycle.spec.ts` (12),
`__tests__/AcTrBatchSlotReuseRegression.spec.ts` (13),
`packages/cad-editor-demo/e2e/tests/phase211-slot-lifecycle.spec.ts`
(convergence matrix, close, D16/D17/D18).
