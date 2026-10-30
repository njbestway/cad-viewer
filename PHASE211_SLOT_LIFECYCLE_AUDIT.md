# PHASE211 · Task B1 — `AcTrBatchedMixin` Slot Lifecycle Audit

**SPEC:** SPEC-CAD-001 · Phase 2.11 — Renderer Slot Lifecycle & Memory Convergence
**Repository:** `cad-viewer` (`packages/three-renderer`, `packages/cad-simple-viewer`)
**Status:** Task B complete — root cause proven by source + in-process counters. No Free List change was
made before this document existed.
**Baseline commit:** Phase 2.10 close-out (see `PHASE210_CLOSEOUT.md`)

---

## 0. TL;DR

`deleteGeometryById()` **does** run, and it **does** push the freed id into
`availableGeometryIds` — the push is correct. The ids are then thrown away by the very
next call to `optimize()`, because all four batched containers end compaction with:

```ts
this._availableGeometryIds.length = 0
```

`optimize()` compacts the *packed buffer* (it rewrites `vertexStart` / `indexStart` of the
active slots) but never compacts the *slot table* (`_geometryInfo`). The two data
structures therefore drift: the buffer shrinks back to the live extent, the id space grows
by one record per insert and the free list is emptied after every erase wave.

`AcTrBatchedGroup.removeEntities()` calls `optimize()` exactly once per affected container
on **every** erase wave (`AcTrBatchedGroup.ts:1939`). That makes the loss deterministic
rather than a race: after `ERASE`, the pool is not merely "unused", it is guaranteed empty.

Result: `_geometryInfo.length` grows by (entities erased) per round, and by
(entities erased × containers touched) when a wave splits across containers. The Phase 2.10
measurement of **+1800 slots/round on a 1000-entity fixture** is 900 entities × 2 containers
per round — an exact match, not an estimate.

The measured per-slot residue also explains the Phase 2.10 heap delta: the slot record
itself is tiny, but a freed record keeps its lazily-created `THREE.Box3` and, for slots
hidden via `setVisibleAt()`, a copy of its packed GPU range (`hiddenDrawSnapshot`).

**The defect is not a missing `boundingBox = null`.** Clearing the box alone would shrink
the heap delta while `_geometryInfo.length` kept climbing — explicitly forbidden by the
spec.

---

## 1. Method

1. Read every slot-lifecycle entry point in `packages/three-renderer/src/batch/` end to end:
   `AcTrBatchedMixin.ts` (mixin + `reserveGeometryId` / `deleteGeometryById` /
   `applyGeometryAt`), `AcTrBatchedGeometryInfo.ts` (record shape + flag helpers),
   the four containers (`AcTrBatchedLine`, `AcTrBatchedLine2`, `AcTrBatchedMesh`,
   `AcTrBatchedPoint`), `AcTrBatchedGroup` (`addEntity`, `removeEntities`, `clear`),
   `AcTrSharedGeometryBatch` (Phase 2.9 instance batches), and the `drawVisibility/`
   strategies that write `hiddenDrawSnapshot`.
2. Instrumented the two functions that own the lifecycle with the 16-field
   `BatchSlotLifecycleMetrics` contract (`AcTrBatchSlotLifecycleMetrics.ts`). Counters are
   plain `number` fields on the container; gauges are computed by scanning the slot table
   only when a caller asks for metrics, so the hot path cost is a handful of increments.
3. Traced the async conversion pipeline (`AcTrView2d.ts`) to decide whether a slot id can
   ever be held across an `await`.
4. Ran `__tests__/AcTrBatchSlotLifecycle.spec.ts` (node, real containers) to record the
   **pre-fix** numbers. Raw log: `reports/phase211/b1-prefix-slot-lifecycle.log`.

### 1.1 Instrumentation surface

| Field | Source | Meaning |
| --- | --- | --- |
| `allocatedSlots` | counter, `reserveGeometryId` append branch | records ever appended |
| `slotCapacity` | gauge, `_geometryInfo.length` | table high-water (includes dead records) |
| `liveSlots` | gauge, `flags & Active` | slots a picking/selection path can reach |
| `freedSlots` | gauge, `flags === None` | soft-deleted but still resident |
| `reusedSlots` | counter, `reserveGeometryId` reuse branch | ids handed out from the pool |
| `freeListSize` | gauge, `availableGeometryIds.length` | ids currently reusable |
| `freeListPushCount` | counter, `deleteGeometryById` | successful `push` |
| `freeListPopCount` | counter, `reserveGeometryId` | successful `shift` |
| `deleteGeometryCalls` | counter, entry | every call, incl. no-ops |
| `deleteGeometrySkipped` | counter | out of range, or already inactive |
| `duplicateFreeAttempts` | counter | double-free signal |
| `liveBoundingBoxes` | gauge | active slots holding a `Box3` |
| `inactiveBoundingBoxes` | gauge | **dead slots holding a `Box3`** (residue) |
| `retainedHiddenSnapshots` | gauge | **dead slots holding a `hiddenDrawSnapshot`** (residue) |
| `slotHighWaterMark` | counter + gauge | max table length ever seen |
| `freeListDroppedByOptimize` | counter (internal) | ids a rebuild dropped because their slot was live |

`AcTrBatchedGroup.getSlotLifecycleMetrics()` folds the per-container records over the seven
origin batch maps (`_lineBatches`, `_lineWithIndexBatches`, `_line2Batches`, `_meshBatches`,
`_meshWithIndexBatches`, `_pointBatches`, `_pointSymbolBatches`) and adds
`batchCount` / `batchCountLive` / `batchCountAllFreed`.

---

## 2. Call graph — where a slot is born and where it dies

### 2.1 Append (`addEntity` → `addGeometry`)

```
AcTrBatchedGroup.addEntity(entity)
  └─ visitDrawable(leaf)
       ├─ tryAddSharedDrawable(...)          → AcTrSharedGeometryBatch (Phase 2.9 path)
       ├─ addLine / addLine2 / addMesh / addPoint
       │    └─ <Container>.addGeometry(...)
       │         ├─ reserveGeometryId(pool, _geometryInfo, _geometryCount, record)
       │         │    ├─ pool non-empty → sort + shift → _geometryInfo[id] = record   (REUSE)
       │         │    └─ pool empty     → _geometryInfo.push(record), _geometryCount++ (APPEND)
       │         ├─ setGeometryAt(id, geometry, null)          ← synchronous, same tick
       │         └─ _nextVertexStart += reservedVertexCount
       └─ applyBatchSlotVisibility(item, visible)
            └─ <Container>.setVisibleAt(id, visible)
                 └─ applyBatchSlotDrawVisibility(geometry, info, visible)
                      └─ <strategy>.collapse/restore → writes/deletes info.hiddenDrawSnapshot
```

`reserveGeometryId` replaces the **whole record** on reuse
(`geometryInfoList[geometryId] = geometryInfo`, `AcTrBatchedMixin.ts:254`), and the caller
always hands it a freshly built record from `createGeometryState()`
(`AcTrBatchedGeometryInfo.ts` / `AcTrBatchedMixin.ts:300`). Reuse therefore cannot inherit
`objectId`, `position`, `bboxIntersectionCheck` or `boundingBox` — that part of the contract
was already sound. What reuse *cannot* fix is a slot that is never handed out again.

### 2.2 ERASE (`removeEntities`)

```
AcTrView2d.removeEntity → AcTrScene.removeEntities → AcTrLayout.removeEntities
  → AcTrLayer.removeEntities → AcTrBatchedGroup.removeEntities(ids)
       ├─ dedupe ids (Set)                            AcTrBatchedGroup.ts:1881-1893
       ├─ setEntityHighlight(ids,'select'|'hover',false)   ← before the slots die
       ├─ for each id: forEachEntitySlot → batchedObject.deleteGeometry(item.batchId)
       │                                    └─ deleteGeometryById(id, _geometryInfo, pool)
       │                                         ├─ flags = None
       │                                         └─ pool.push(id)          ← THE PUSH HAPPENS
       ├─ _entitiesMap.delete(id)
       └─ affectedBatches.forEach(b => b.optimize())     ← EXACTLY ONCE PER CONTAINER
                                                            AcTrBatchedGroup.ts:1939
                 └─ ... this._availableGeometryIds.length = 0    ← THE PUSH IS UNDONE
```

### 2.3 Undo

Undo re-runs `addEntity` for the restored ids. Because the pool was emptied in 2.2, every
restored id takes the **append** branch: `_geometryInfo.push(...)`. The table grows by the
number of restored entities, forever, while the packed buffer is reused from offset 0.

---

## 3. Root cause — exact evidence

All four containers clear the pool at the end of compaction:

| Container | Line |
| --- | --- |
| `AcTrBatchedLine.optimize()` | `AcTrBatchedLine.ts:685` |
| `AcTrBatchedMesh.optimize()` | `AcTrBatchedMesh.ts:487` |
| `AcTrBatchedPoint.optimize()` | `AcTrBatchedPoint.ts:425` |
| `AcTrBatchedLine2.optimize()` | `AcTrBatchedLine2.ts:491` |

```ts
// AcTrBatchedLine.optimize(), tail
this._nextVertexStart = nextVertexStart
this._nextIndexStart = nextIndexStart
this._syncDrawRange()
this._availableGeometryIds.length = 0          // ← discards every id freed this wave
syncBatchDrawVisibilityAfterOptimize(geometry, this._geometryInfo)
return this
```

Compaction itself iterates only the active slots:

```ts
const entries = this._geometryInfo
  .map((info, id) => ({ info, id }))
  .filter(e => isBatchGeometryActive(e.info.flags))       // AcTrBatchedLine.ts:596-599
  .sort((a, b) => a.info.vertexStart - b.info.vertexStart)
```

so dead records are skipped, never removed, and `_geometryInfo.length` never decreases.
`AcTrBatchedMesh.optimize()` is the same shape (`AcTrBatchedMesh.ts:439-490`), as are the
Point and Line2 variants.

Two secondary consequences of "never removed":

1. A freed record keeps `boundingBox` — `getBoundingBoxAt()` materialises one `Box3` per
   slot on demand (`AcTrBatchedLine.ts:707-725`) and nothing clears it on delete.
2. A freed record keeps `hiddenDrawSnapshot` — `deleteGeometryById` only clears `flags`
   (`AcTrBatchedMixin.ts:412`). `syncBatchDrawVisibilityAfterOptimize()` skips inactive
   slots (`AcTrBatchDrawVisibility.ts:88-90`), so the snapshot survives too.

The only place the whole table is reclaimed is `AcTrBatchedGroup.clear()` →
`batch.dispose()` (`AcTrBatchedGroup.ts:836-844`), which is why Phase 2.10 observed the heap
residue vanish after the document closed.

---

## 4. Pre-fix measurements

`packages/three-renderer/__tests__/AcTrBatchSlotLifecycle.spec.ts`, node, real containers,
raw log `reports/phase211/b1-prefix-slot-lifecycle.log`
(`Tests: 6 failed, 4 passed, 10 total`).

| Case | Expected (invariant) | Measured | Verdict |
| --- | --- | --- | --- |
| 4 entities, erase 3 → `deleteGeometryCalls` | 3 | **3** | delete path is reached |
| same → `deleteGeometrySkipped` | 0 | **0** | no id rejected |
| same → `freedSlots` | 3 | **3** | `flags = None` is applied |
| 8 entities, erase 3 → `freeListSize` | 3 (`slotCapacity - liveSlots`) | **0** | pool emptied by `optimize()` |
| 8 entities × 5 rounds erase-all + undo-all → `slotCapacity` | 8 (converges) | **48** (8→16→24→32→40→48) | **+8 records/round** |
| 8 entities, erase 5 + double-free slot 5 → `freeListSize` vs `freedSlots` | 6 | **1** (`freedSlots` 6) | 5 of 6 ids lost |
| 6 entities with materialised boxes, erase 2 → `inactiveBoundingBoxes` | 0 | **2** | `Box3` residue |
| hidden slot erased → record's `hiddenDrawSnapshot` | `undefined` | **`{ indices: [0, 1] }`** | GPU-range copy residue |
| 10 entities, erase 6 → `freeListSize` | 6 | **0** | capacity holds, pool never refills |
| erased slot → `intersectWith` hits | 0 | **0** | picking already safe |
| metrics fold over 7 origin maps | 1 live container, capacity ≥ 5 | **pass** | aggregation correct |

### 4.1 Reconciliation with Phase 2.10

| Phase 2.10 observation | Explanation |
| --- | --- |
| `+1,800` slots/round on the 1k fixture | 900 erased entities × 2 containers; the spec's 8-entity node case shows the same slope (+8 = 8 erased × 1 container) |
| Free list 0 at all 18 sampling points | every sample was taken after an erase wave; `optimize()` runs inside the wave |
| `~200` new `Box3`/round | freed records keep their lazily materialised box; only a fraction of slots had one materialised |
| Heap residue disappears when the document closes | only `AcTrBatchedGroup.clear()` reclaims the table |

---

## 5. The six required findings

### Q1 — Does a delete reach `deleteGeometryById()`?

**Yes, always.** `deleteGeometryCalls = 3`, `deleteGeometrySkipped = 0`, `freedSlots = 3`
for a 3-entity erase. The path is
`AcTrBatchedGroup.removeEntities → forEachEntitySlot → <Container>.deleteGeometry →
deleteGeometryById`. The container is resolved through `getOriginBatch(item.batchedObjectId)`
and the slot through `item.batchId`, both taken from `_entitiesMap`, which is the same map
that `addEntity` populated — there is no id translation that could send the delete elsewhere.

### Q2 — Which condition prevents the id from being returned to the pool?

**None at delete time; the return is undone afterwards.** `deleteGeometryById` pushes the id
(`freeListPushCount` increments) and the id is in the pool when `removeEntities` returns from
its per-entity loop. `optimize()` then executes `this._availableGeometryIds.length = 0`
before any `addGeometry` can pop it. The pool is therefore empty not because a guard
rejected the id, but because compaction discards the list wholesale.

### Q3 — Are there slots already marked `None` that never entered the free list?

**Yes — this is the whole defect, and it is measurable.**
`stuck = freedSlots - freeListSize`:

| Case | `freedSlots` | `freeListSize` | stuck |
| --- | ---: | ---: | ---: |
| 8 entities, erase 3 | 3 | 0 | 3 |
| 8 entities, erase 5 + double free | 6 | 1 | 5 |
| 10 entities, erase 6 | 6 | 0 | 6 |

Once stuck, a record is permanently unreachable: `reserveGeometryId` only ever writes
through the pool, and nothing else scans the table for `None` records.

### Q4 — Do different batch types take different delete paths?

**No — the bug is identical in all four, and the fix must land in all four.**
`AcTrBatchedLine`, `AcTrBatchedMesh`, `AcTrBatchedPoint`, `AcTrBatchedLine2` each own an
`optimize()` that compacts packed ranges and then zeroes the pool
(`AcTrBatchedLine.ts:685`, `AcTrBatchedMesh.ts:487`, `AcTrBatchedPoint.ts:425`,
`AcTrBatchedLine2.ts:491`). Their storage differs (indexed / non-indexed / segment pair /
point symbol), so only the buffer rewrites differ, not the lifecycle.

`AcTrSharedGeometryBatch` is a **different** design and is *not* affected: it owns a
per-kind instance buffer, recycles through `releaseSlot()`, and already clears per-slot state
on delete (`_hiddenMatrices.delete`, `_objectIds[id] = undefined`, `_bboxOnly[id] = 0` —
`AcTrSharedGeometryBatch.ts:282-305`). Phase 2.9 eviction of empty shared batches stays as
is.

### Q5 — Can async conversion or bulk delete free the same slot twice?

**No double-free was observed, and the known producers cannot produce one.**

* Bulk delete: `removeEntities` dedupes with a `Set` before touching slots
  (`AcTrBatchedGroup.ts:1881-1893`) and removes the entity from `_entitiesMap` in the same
  synchronous block, so a repeated notification finds no slot and
  `deleteGeometryCalls` does not even increment.
* `deleteGeometryById` is idempotent by construction: the second call sees
  `flags === None` and returns `false` with `deleteGeometrySkipped++` /
  `duplicateFreeAttempts++`. The spec asserts `duplicateFreeAttempts === 1` for exactly one
  deliberate double free.
* Async conversion: a slot id is a **local variable** inside one synchronous
  `addGeometry` call. `setGeometryAt` / `setGeometryInfo` are only ever called from
  `addGeometry` and its container-specific siblings — verified by grepping every call site
  in `packages/`; no call site holds an id across an `await`.
* The conversion pipeline is additionally gated at object level, four ways, before any scene
  write: `_convertEpoch` (session), `_entityConvertGeneration` (per-object revision),
  `_erasedConvertObjectIds` (ERASE tombstone), and a database registry probe at the commit
  edge (`isConvertCurrent`, `AcTrView2d.ts:3500-3528`). Deferred glyph/group jobs re-check
  the epoch at enqueue, at pump and in `.then` (`AcTrView2d.ts:5357-5450`).

The one gap the spec asks to close anyway: **there is no slot-level validity token**. Today
the safety argument is "no id outlives its call", which is true but is a property of the
current call sites, not of the container. Task C closes it with a per-slot generation
stamped on reuse.

### Q6 — Does a discarded batch keep slot metadata?

**Origin batches are never discarded individually.** `AcTrBatchedGroup` only ever calls
`_originBatchById.set(...)` (`:3609`) and `_originBatchById.clear()` (`:862`); there is no
`delete` of a single origin batch anywhere in the class. An origin batch that lost all of
its entities therefore keeps

* its `_geometryInfo` table (all records now `flags = None`),
* its packed `BufferGeometry` and both attributes at the high-water size,
* its material and its place in the scene graph,

until `AcTrBatchedGroup.clear()` (`:836-872`) runs on document close. With a correct free
list this becomes a *capacity* cost (bounded by the peak concurrency of that
material/attribute combination), which Task C3 accepts; without reuse it was an unbounded
*record* cost. Shared geometry batches keep the Phase 2.9 behaviour: empty ones are released
by `sweepEmptySharedBatches()` after `SHARED_BATCH_EMPTY_GRACE_MS = 500`
(`AcTrBatchedGroup.ts:530`, `:3226`), so they do not accumulate.

---

## 6. What Task C must change (and what it must not)

Derived from the above, the minimal repair is:

1. **Repopulate the pool after compaction.** Replace the four
   `this._availableGeometryIds.length = 0` lines with a rebuild that re-derives the pool from
   the slot table (`rebuildAvailableGeometryIds`). Rebuilding instead of patching makes the
   three free-list invariants structural: no active id (active slots are skipped), no
   duplicate (one push per slot), no out-of-range id (indices come from the array).
2. **Release slot metadata on delete.** `deleteGeometryById` must call
   `releaseSlotMetadata()` — clear `flags`, drop `boundingBox`, delete
   `hiddenDrawSnapshot` — instead of only clearing `flags`. This is a *consequence* of the
   fix, not a substitute for it: on its own it would not stop `_geometryInfo.length` from
   growing, which is exactly the failure mode the spec forbids.
3. **Stamp a slot generation on reuse** so a future writer that does hold an id across an
   `await` can prove the slot still belongs to it. Cheap (one number on the record, bumped
   from the record being replaced), and it turns today's "no id outlives its call" argument
   into an enforced invariant.
4. **Do not** shrink `_geometryInfo` on delete. Capacity must converge to the high-water
   mark, not chase the live count; compacting the array would re-allocate on the next Undo
   wave, which C3 explicitly rules out.

Out of scope by spec: TransformUndo, Undo-record format, GPU buffer-translate fast path,
batch/instancing re-architecture, the MOVE conversion stall, worker/wry/rust migration.

---

## 7. Residual risks carried into Task C/D

| # | Risk | Mitigation |
| --- | --- | --- |
| B-R1 | `optimize()` advances `_nextVertexStart` by **reserved** spans, so a reused id writes at the compacted end while the freed buffer gap stays dead until the next compaction | capacity converges; buffer waste is bounded by the peak working set, not by round count — verify in Task E |
| B-R2 | A batch that peaked at N slots keeps N records after everything is erased (Q6) | accepted by C3 as capacity, provided `liveSlots + freeListSize === slotCapacity` and metadata of dead slots is released |
| B-R3 | `syncBatchDrawVisibilityAfterOptimize()` re-collapses hidden active slots; a slot hidden *and* freed in the same wave must not be re-collapsed | Task D hidden/visibility cases + `duplicateFreeAttempts` / `retainedHiddenSnapshots` gauges |
| B-R4 | `_geometryCount` only grows, so `getBoundingBoxAt` / `computeAggregateBoundingSphere` / `ensureLineDistanceAttribute` still loop to the high-water id | keep `isBatchGeometryActive` filters (already present) — verify no O(capacity) hot-path regression in Task F |

---

## 8. Post-fix cross-validation (Tasks C/D/E)

§4 measured the defect and §5 answered the six questions against the **pre-fix** tree. This
section replays both on the shipped tree, so none of the conclusions above survives on a stale
snapshot. Three independent measurements: the node harness (the same ten cases, now twelve),
the 25 browser cells, and the heap retainer walk.

### 8.1 Unit level — the cases that failed now pass

`reports/phase211/b1-prefix-slot-lifecycle.log` (Task C stashed) and
`reports/phase211/d1-node-regression.log` (shipped tree) run the same spec,
`packages/three-renderer/__tests__/AcTrBatchSlotLifecycle.spec.ts`:

| # | test | pre-fix | post-fix |
| --- | --- | --- | --- |
| 1 | counts the delete calls that the ERASE path issues | pass | pass |
| 2 | leaves the free list equal to the set of freed slots after compaction | **fail** `Expected: 3, Received: 0` | pass |
| 3 | converges slot capacity across repeated ERASE / Undo rounds | **fail** `Expected: 8, Received: 48` | pass |
| 4 | reports a free list with no duplicates, no active ids and no stale ranges | **fail** `Expected: 6, Received: 1` | pass |
| 5 | drops the bounding box of a freed slot | **fail** `Expected: 0, Received: 2` | pass |
| 6 | drops the hidden draw snapshot of a freed slot | **fail** `Received: {"indices": [0, 1]}` | pass |
| 7 | hands a reused slot a record with no state from its previous owner | pass | pass |
| 8 | keeps slot capacity at the high-water mark, not at the live count | **fail** `Expected: 6, Received: 0` | pass |
| 9 | does not keep a removed slot pickable | pass | pass |
| 10 | folds per-batch metrics into group totals | pass | pass |
| 11 | stamps a new generation on the id handed to the next owner | n/a (added with the fix) | pass |
| 12 | refuses a slot id after the batch has been reset | n/a | pass |

Pre-fix totals `6 failed / 4 passed / 10`; post-fix `25 passed / 25` across this spec (12) and
the Task D reuse spec (13), 16.253 s.

Rows 2, 3, 4, 6 and 8 are §4's table replayed as assertions — 3 freed ids with an empty pool,
capacity 8 → 48 (+8/round), 6 freed but only 1 pooled, a `hiddenDrawSnapshot` surviving the
delete, a 2-box residue. Every number in §4 is therefore reproducible without the ad-hoc probe
that produced it.

### 8.2 Browser level — 25 cells, 1 035 rounds, zero violations

From `reports/phase211/phase211-resource-after.json`, aggregated over every **per-round** row
rather than the finals:

| check | value |
| --- | --- |
| rows / cells | 1 035 / 25, 7 size-op groups (`300`, `1k`, `10k`, `50k` × erase/move) |
| `liveSlots + freeListSize === slotCapacity` | **1 035 / 1 035 rows** |
| `reusedSlots === deleteGeometryCalls` | every row |
| `duplicateFreeAttempts` Σ | 0 |
| `invalidSlots` Σ | 0 |
| `inactiveBoundingBoxes` Σ | 0 |
| `retainedHiddenSnapshots` Σ | 0 |
| missing / residual in scene, missing / residual in index | 0 / 0 / 0 / 0 |

Finals (one metric set per cell) fold these counters over all seven origin batch types:
`reusedSlots = deleteGeometryCalls = freeListPushCount = freeListPopCount = 24 483 780`,
`deleteGeometrySkipped = 0`, and `slotCapacity` is a single value per fixture/op (`270`, `900`,
`9 000`, `45 000`) instead of climbing per round — `convergence.capacity.driftPerRound === 0` on
all 25 cells.

### 8.3 The six questions, re-checked

| Q | pre-fix answer | post-fix evidence |
| --- | --- | --- |
| Q1 delete reaches `deleteGeometryById` | yes | `deleteGeometryCalls = 24 483 780`, `skipped 0` — unchanged; the call path was never the defect |
| Q2 which condition drops the id | `optimize()` zeroing the pool | the pool is now rebuilt instead of zeroed; the proof is per-cell `freeListPushCount === freeListPopCount` (`freeListDroppedByOptimize` is not surfaced in the e2e report, so it is not cited as zero) |
| Q3 slots `None` but not pooled | yes, `stuck = freed - freeList` up to 6 | `reusedSlots === deleteGeometryCalls` on every row; a `None` record missing from the pool would break that equality at the next reservation |
| Q4 per-type divergence | identical in all four containers | the 25 cells aggregate 7 origin batch types with the same zero-violation result, and the D spec adds `mixes line, mesh, point and wide-line containers` |
| Q5 double free | none observed | `duplicateFreeAttempts = 0` across 1 035 browser rows, while the node spec deliberately double-frees once and asserts `1`, so the counter is live rather than dead |
| Q6 discarded batch keeps metadata | yes, capacity only | `slotCapacity` constant per cell and `_geometryInfo` never shrinks (C3); shared batches keep the 2.9 eviction — 50k ERASE cell: `created 13 / emptied 12 / evicted 12 / emptyBatches 0` |

### 8.4 `freeListSize` is still 0 at every sample — and that is now expected

This is the one place where the same number as Phase 2.10 could be mistaken for "not fixed".
Every row samples at the end of a full round (`erase → undo → redo → undo`, `move → undo → redo`),
i.e. after the re-add wave has already popped what it needs. With 900 erased and 900 re-added the
pool leaves at 0 **by construction**; pre-fix it was also 0 because compaction had thrown the ids
away. The two states are indistinguishable by that field alone.

So `freeListSize` stays a non-discriminator, exactly as `copyOnWriteCount = 0` is for snapshot
mutation. The load-bearing signals are pairwise:

* `reusedSlots === deleteGeometryCalls` — every freed slot came back through the pool,
* `freeListPushCount === freeListPopCount` — nothing was pushed and then dropped,
* `liveSlots + freeListSize === slotCapacity` — the pool is the complement of the live set, not a
  subset of it,
* `slotCapacity` constant, `inactiveBoundingBoxes` / `retainedHiddenSnapshots` 0.

Each of those breaks the moment a slot goes `None` without entering the pool, which is why they
replace the Phase 2.10 signal rather than supplement it.

### 8.5 Heap retainer cross-check

`reports/phase211/phase211-heap-retainers-r100.json` walks r100 of the 1k/100-round ERASE cell
for `Box3`. **Object counts and reference-path counts are reported separately from here on:**
one `Box3` averages **45.3 distinct retainer paths**, so the two units differ by more than an
order of magnitude and are never interchangeable. Quoting a path count as an object count
inflates the population by that factor.

By immediate retainer — one row per holding field, so these are object counts and they sum to
the population:

| retainer | objects | reading |
| --- | ---: | --- |
| `boundingBox` on a slot record | 100 | live slots only — the gauge reports 0 inactive |
| `AcTrLayer._cachedBox` | 6 | layer-level cache, bounded |
| `_BufferGeometry.boundingBox` | 5 | one per renderer geometry |
| `AcTrSharedGeometryBatch._localBox` | 4 | per-instance scratch box |
| constant-pool / verifier noise | 32 | not application state |
| **total** | **147** | no path through a freed slot record |

By holding chain (`byClassifierObjects` / `byClassifier` — an object is counted in every class
it reaches, so the object column does **not** sum to 147):

| holder chain | objects | reference paths | reading |
| --- | ---: | ---: | --- |
| batch slot table (`_geometryInfo`) | 124 | 1 003 | a box inside a slot record is held by the slot that owns it |
| unclassified | 26 | 4 871 | constant pools, `InstructionStream`, ephemeron edges |
| transaction / event | 18 | 531 | undo history, bounded and reclaimed by eviction |
| active scene object | 9 | 76 | spatial index / layout |
| bounded cache | 2 | 174 | `_cachedBox` |

Two corrections to how this table must be read:

* **`slot-held` is not a finding.** A `Box3` reached through `_geometryInfo` is held by the
  live slot that owns it, which is the intended ownership. The finding would be a box held by
  a *freed* slot record, and `releaseSlotMetadata()` sets `boundingBox = null`, so a freed
  record cannot hold one. The signal is therefore the immediate-retainer column (100 boxes
  held by `boundingBox`), not the chain column.
* **The previous classifier was wrong at the top of the chain.** The old bucket
  `invalidated-but-referenced` matched the object's own `boundingBox` field, so *every* `Box3`
  matched it and the label carried no information about invalidation. `classify()` now runs on
  the holder chain with the first hop removed, and it is tallied over **all** signatures
  instead of the truncated top 25 (that truncation summed to 1 657 "paths" over a population of
  147 objects). The corrected walk over the same snapshot is
  `reports/phase212/a2-heap-retainers-r100.json`, produced by
  `node --max-old-space-size=8192 tools/phase210-heap-retainers.mjs <r100 snapshot> <out.json> --targets=Box3 --samples=300`.

Pre-fix, the same probe over a 2-entity erase found 2 boxes owned by dead records (§4, row 5 of
the b1 table). Post-fix the only `boundingBox` owners that remain are live slots: releasing
metadata on delete removed the class, and reuse bounds the count by the live set instead of by
the number of rounds.

The heap diff for the same cell (`r10 → r100`) grows 247 066 850 → 247 769 866 B, **+687 KB over
90 rounds ≈ 7.6 KB/round**, and none of it is `Box3`, slot records, batch objects or geometry —
it is `InstructionStream`, `Code`, `WeakArrayList`, `WebGLProgram` and
`PerformanceLongAnimationFrameTiming`. That residue is a second, independent source
(`PHASE211_MEMORY_CONVERGENCE_REPORT.md` §9) and is not claimed as solved here.

### 8.6 What this cross-validation does not cover

* The node harness drives `AcTrBatchedLine` only. The other three containers are covered by the
  browser cells (7 batch types folded) and by the D spec's mixed-container case, not by a
  per-container unit matrix.
* Glyph / MTEXT slots have no slot-level e2e; the 10 % TEXT share goes through the shared geometry
  batch, which is a different lifecycle (Q4).
* `slotGeneration` is stamped, asserted in the node spec and persisted on the record, but no
  production call site consumes it yet. It is a guard for future async writers, not an active
  check; the current safety argument remains "no id outlives its call" (§5 Q5).
* The "capacity, not leak" reading for B-R1/B-R2 is bounded by each fixture's peak concurrency;
  the load-bearing numbers for that claim are the per-cell capacity series in the convergence
  report, not the single `slotCapacity` value quoted here.
