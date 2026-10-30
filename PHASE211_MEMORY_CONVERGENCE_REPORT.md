# PHASE211 · Task E — Memory Convergence Report

**Verdict: PASS.** `_geometryInfo` no longer tracks the edit count. Slot capacity,
live slots, the free list, renderer geometries and the scene graph are flat from
the warm-up round to the last round on every fixture size, and the post-GC heap
of a 1k × 100-round session differs from its round-10 sample by **687 KB over
90 rounds (7.6 KB/round)**, none of which is app data.

Raw data:

| file | content |
| --- | --- |
| `reports/phase211/phase211-slot-lifecycle.json` | every cell, every round (39 cells) |
| `reports/phase211/phase211-resource-after.json` | Task E view: convergence bands, per-round trim, close/race cells |
| `reports/phase211/phase211-resource-baseline.json` | Phase 2.10 pre-fix baseline (+1800 slots/round) |
| `reports/phase211/phase211-heap-diff-r10-r100.json` | V8 heap diff, round 10 → round 100 |
| `reports/phase211/phase211-heap-retainers-r100.json` | retainer paths, round 100 |
| `reports/phase211/phase211-heap-snapshots.json` | snapshot SHA256 manifest |
| `reports/phase211/phase211-heap-hs1-1000-erase-r{10,100}.heapsnapshot.gz` | the two snapshots |

---

## 1. Matrix as run

| fixture | rounds | ops | sessions | tag(s) |
| --: | --: | --- | --: | --- |
| 1 000 | 100 | ERASE, MOVE | **4** (3 planned + 1 snapshot session) | `k1`, `k1b`, `k1c`, `hs1` |
| 10 000 | 50 | ERASE, MOVE | 2 | `k10`, `k10b` |
| 50 000 | 20 | ERASE, MOVE | 2 | `k50`, `k50b` |
| 50 000 | 6 | ERASE, MOVE | 2 × 2 arms (sharing on/off) | `f50`, `f50b` |
| 300 | 3/4 + close + 3 race | smoke, close, D16/D17/D18 | 1 | `smoke`, `close`, `race` |

`50k × 50` was **not** run: at ~2.5 min/round on this machine it needs ~2 h per
arm, and the deliverable value over `50k × 20` is a longer flat line of the same
measurement. That is a deliberate scope cut, recorded here rather than hidden by
shrinking a fixture.

Each round is `ERASE | MOVE → Undo → Redo → Undo`, sampled **after**
`HeapProfiler.collectGarbage`, with the undo history cleared first so the slope
cannot be dominated by retained undo records (Phase 2.10 experiment 2 already
proved the slot slope is history-independent).

Per round, all 15 required groups are recorded: GC heap, heap peak, slot
capacity, live slots, free list, invalid slots, active/empty shared batches,
renderer geometries, `Object3D` count, bounding-box count, hidden snapshots,
undo/redo history, DB/Scene/SpatialIndex id sets, longest event-loop gap and
scene-ready duration.

---

## 2. Contrast with the Phase 2.10 baseline

Phase 2.10 (`reports/phase210/phase210-batch-slots.json`, pre-fix build) on the
same 1k mixed fixture:

| metric | Phase 2.10 (pre-fix) | Phase 2.11 (1k × 100) |
| --- | --- | --- |
| slot capacity per round | **+1 800** | **+0** (900 → 900) |
| bounding boxes per round | **+200** | **+0** (100 live, lazy, flat) |
| free list size at every sample | **0** | 0 at rest, 900 between delete and reserve |
| reused slots over the run | 0 | 180 000 (ERASE) / 360 000 (MOVE) |
| `_geometryInfo` after 100 rounds | ~180 000 records (extrapolated from the measured slope) | **900** |

The two columns also explain each other: Phase 2.10's **+1 800 records/round is
exactly the 1 800 `deleteGeometryById()` calls one ERASE round issues** (900
entities × twice — the ERASE and the redo-ERASE). Every delete appended a record
because the pool was empty; now every delete feeds a reuse, and
`reusedSlots` = `deleteGeometryCalls` = 180 000 over the run.

The 1 800/round figure is preserved in every cell as
`convergence.phase210SlotsPerRound` so the contrast cannot be lost.

---

## 3. Convergence per cell

`capacity` / `live` are the band statistics of the last 10 rounds (3-round
warm-up); `heap` is the post-GC heap in the same window.

| cell | slot capacity | live slots | free list | invalid | duplicate frees | heap first → last (MB) |
| --- | --- | --: | --: | --: | --: | --- |
| `k1/1000/100/erase` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.4 → 196.3 |
| `k1b/1000/100/erase` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.3 → 196.3 |
| `k1c/1000/100/erase` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.3 → 196.3 |
| `hs1/1000/100/erase` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.3 → 196.3 |
| `k1/1000/100/move` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.4 → 196.4 |
| `k1b/1000/100/move` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.4 → 196.4 |
| `k1c/1000/100/move` | 900 → 900 | 900 → 900 | 0 | 0 | 0 | 196.5 → 196.5 |
| `k10/10000/50/erase` | 9 000 → 9 000 | 9 000 → 9 000 | 0 | 0 | 0 | 214.8 → 214.6 |
| `k10b/10000/50/erase` | 9 000 → 9 000 | 9 000 → 9 000 | 0 | 0 | 0 | 214.9 → 214.8 |
| `k10/10000/50/move` | 9 000 → 9 000 | 9 000 → 9 000 | 0 | 0 | 0 | 214.2 → 214.3 |
| `k10b/10000/50/move` | 9 000 → 9 000 | 9 000 → 9 000 | 0 | 0 | 0 | 213.9 → 213.8 |
| `k50/50000/20/erase` | 45 000 → 45 000 | 45 000 → 45 000 | 0 | 0 | 0 | 314.0 → 314.8 |
| `k50b/50000/20/erase` | 45 000 → 45 000 | 45 000 → 45 000 | 0 | 0 | 0 | 313.8 → 314.7 |
| `k50/50000/20/move` | 45 000 → 45 000 | 45 000 → 45 000 | 0 | 0 | 0 | 306.8 → 307.3 |
| `k50b/50000/20/move` | 45 000 → 45 000 | 45 000 → 45 000 | 0 | 0 | 0 | 307.2 → 307.5 |

`invalidSlots = inactiveBoundingBoxes = retainedHiddenSnapshots = 0` in every
cell. `deleteGeometryCalls` equals `reusedSlots` in every cell (180 000 / 360 000
at 1k, 900 000 / 1 800 000 at 10k, 1 800 000 / 3 600 000 at 50k × 20), i.e. every
delete produced exactly one reusable id, and no delete was a duplicate.

`renderer.info.memory.geometries` is 5 at the end of every lifecycle cell and
`Object3D` nodes are 36 (1k: 40–46, see §5) — flat, but that is *not* the proof
of this task: the slot table itself is (column 2, and the free-list arithmetic).

### Capacity is at the high-water mark, not at the live count

`slotCapacity = liveSlots` here only because these fixtures never have a
transient overlap between a delete and an insert. `slotHighWaterMark` is
reported separately and matches capacity. An edit that holds more simultaneous
instances than ever before may still grow the table once; it may not grow it per
round, and it does not (see §4).

---

## 4. Heap: the attributable slot increment is gone

Same session, 1k, ERASE × 100, two forced-GC snapshots — round 10 (warmed) and
round 100 — compared with `tools/phase29-heap-diff.mjs`:

```
total self size 247,066,850 B -> 247,769,866 B   (+687 KB, +0.28%)
nodes            3,126,448     -> 3,129,299       (+2,851, +0.09%)
90 editing rounds                                (+7.6 KB/round)
```

Largest positive deltas, by count:

| key | count delta | self-size delta | what it is |
| --- | --: | --: | --- |
| `code:system / InstructionStream` | +193 | +299 KB | V8 JIT/compile output |
| `native:system / WeakArrayList` | +379 | +95 KB | V8 weak-ref bookkeeping |
| `code:system / Code` | +193 | +14 KB | ditto |
| `native:PerformanceLongAnimationFrameTiming` | +152 | +27 KB | browser perf buffer |
| `native:WebGLProgram` | +104 | +10 KB | shader program cache |
| `object:Object` | +8 | 0 KB | — |
| `number:heap number` | +34 | 0.4 KB | — |

There is **no** slot record, packed range, `Box3`, `Vector3`, batch, shared-batch
or geometry class in the top-40 by size or by count. The two ~193/round entries
are the same class as the baseline session and are compilation artifacts of
running 90 more rounds, not retention of the drawing.

For reference, Phase 2.10 measured ~70 B/entity/round of unexplained residue with
every counter flat. 7.6 KB/round across a 1 000-entity drawing is 9 KB/round
*better* than that, and it is attributable.

### Retainer paths (round 100, `tools/phase210-heap-retainers.mjs`)

Sampled populations, immediate retainers and path signatures:

> **Units.** Every number below is a count of *objects* unless it says "paths". The same
> `Box3` population resolves to **45.3 reference paths per object** (6 659 paths for 147
> objects), and an object reachable by several chains is counted in each chain. Path counts
> are only meaningful for shape ("which chain holds it"); they must never be quoted as
> population sizes.

* **`Box3` — 147 live objects** (24 B each). Immediate retainers: 100 ×
  `boundingBox:object:Object` (slot records), 6 × `_cachedBox:AcTrLayer`
  (bounded cache), 5 × `boundingBox:_BufferGeometry`. Every resolved path
  terminates at
  `(object elements) <- elements:Array <- table:Map <- _meshWithIndexBatches:AcTrBatchedGroup <- parent:Group`.
  That is the slot table inside the live batch: bounded, and it is the only
  retainer. Compare Phase 2.10, where the same population grew by ~200 per round.
* **`AcTrSharedGeometryBatch` — 6 live nodes.** Retained only by
  `_sharedGeometryBatches:AcTrBatchedGroup`, plus the scope captured by their own
  `_onEmpty` callbacks. No global registry, no `WeakMap` root, no timer.
* `AcTrBatchGeometryState` / `AcTrBatchedGeometryInfo` resolve to 0 nodes by
  class name: slot records are plain object literals (`Object`), which is why the
  counters in §3, not the snapshot, are the load-bearing evidence for the table.

Snapshots are stored gzipped (60 MB each, from 417 MB raw) with SHA256 of both
the raw and the compressed file in `phase211-heap-snapshots.json`, so the pair
can be re-analysed without committing 835 MB.

### Why the last 10 rounds, not round 1

The heap is not flat from round 1: `194.6 → 196.3 MB` over 100 rounds. Rounds
1–20 are warm-up (lazy batch creation, glyph atlas growth, IC/JIT warm-up); from
round 20 on the series is 196.3, 196.3, 196.3 … with ±0.1 MB jitter. Which is
why the verdict uses the **last 10 rounds** band, as the task requires, and why
the snapshot pair starts at round 10 rather than round 1.

---

## 5. The two non-flat counters, explained

`renderer.geometries` and `Object3D` count are flat *per cell* but oscillate
between rounds in the MOVE cells (8–10 geometries, 42–46 nodes at 1k; final 5 /
36 after the settling sweep). The oscillation is not growth:

* it is periodic, not monotonic — the values return to the same set of levels
  every round, so the maximum over 100 rounds equals the maximum over the first
  10;
* it tracks whether a highlight/grip batch currently exists (a MOVE round leaves
  a transient drawable that the next drain collapses);
* the settled value at the end of every cell (`final.renderer.geometries = 5`) is
  identical to the value before the first round.

A linear leak cannot produce a series that returns to its starting level 10
times in 100 rounds; a transient container can.

---

## 6. Shared batches and the Phase 2.9 behaviour

`activeSharedBatches` stays at 1 in every lifecycle cell; `emptySharedBatches` is
0 after the settling sweep (`sweepEmptySharedBatches(0)`), and `evicted` grows
linearly with the round count (200 at 1k × 100 ERASE, 400 for MOVE, 40/80 at
50k × 20) — i.e. the grace-period eviction from Phase 2.9 is doing the reclaiming,
not the slot table. The Phase 2.9 eviction regression is part of the node suite
(`leaves phase 2.9 shared-batch metrics untouched by slot reuse`).

---

## 7. Close the document, keep nothing

`reports/phase211/phase211-slot-lifecycle.json` → `close/300/close/close/1`:
with a convert job parked in the `queued` stage, `view.clear()` is called and then
the job is released one second later.

| sample | batches | slot capacity | live slots | scene ids | index ids | heap |
| --- | --: | --: | --: | --: | --: | --: |
| before | 2 | 270 | 270 | 300 | 300 | 275.1 |
| after `clear()` | **0** | **0** | **0** | 0 | 0 | 282.8 |
| after the parked job runs | **0** | **0** | **0** | 0 | 0 | — |

The heap *rises* 7.7 MB across `clear()` (the GC has not run yet at that sample);
the load-bearing part is that the tables are empty and stay empty after the
released job has had a full second to resurrect them.

---

## 8. Task E3 acceptance, item by item

| # | requirement | result | evidence |
| --- | --- | --- | --- |
| 1 | `_geometryInfo` no longer grows linearly with rounds | **PASS** — capacity constant from round 2 in all 15 lifecycle cells | §3 |
| 2 | free list has no duplicate / active / out-of-range id | **PASS** — `invalidSlots 0`, `duplicateFreeAttempts 0`, `freeListDroppedByOptimize 0` everywhere; node suite asserts the set equality | §3, node suite |
| 3 | invalid slots keep no old `Box3` / hidden snapshot | **PASS** — `inactiveBoundingBoxes 0`, `retainedHiddenSnapshots 0` | §3 |
| 4 | the attributable slot heap increment is gone | **PASS** — +687 KB / 90 rounds, all of it V8/Blink, no app class in the diff | §4 |
| 5 | shared batches and renderer geometries stay convergent | **PASS** — 1 active batch, 5 geometries, 0 empty after sweep | §5, §6 |
| 6 | ERASE / MOVE / Undo / Redo correctness unchanged | **PASS** — id-set equality per round, picks per round, plus the D suites | correctness report |
| 7 | no new long-lived GPU references | **PASS** — geometry count and bytes flat; `WebGLProgram` growth is the shader cache of 90 rounds of draws, +10 KB | §4 |
| 8 | closing the document leaves no previous-session slot metadata | **PASS** | §7 |
| 9 | no new heap peak, sync stall or scene-settle regression | **PASS** — peaks flat vs Phase 2.10 per size; settle and ready-after unchanged (performance report) | performance report |

### The escaped clause

> If total heap still grows, a heap diff and retainer-path analysis must explain
> whether another independent source remains; slot capacity alone may not be
> declared sufficient.

The total heap does still grow: **7.6 KB/round**, and §4 names it — V8 code
objects (193/round, from the closures and helper functions that `optimize()`,
`collectSlotLifecycleMetrics()` and the convert path keep re-creating), V8
`WeakArrayList` bookkeeping, and Blink's `PerformanceLongAnimationFrameTiming` /
`WebGLProgram` buffers. Those are engine-side per-execution artifacts of running
90 more rounds, not retained drawing state: none of them holds a slot, a box, a
geometry or an entity.

They are, however, a *second independent growth source* in the sense the task
means, so it is stated explicitly: **the Phase 2.11 verdict covers the slot
lifecycle only.** Killing the remaining 7.6 KB/round would mean reducing the
number of long-lived closures in the conversion path (hoisting the arrow
functions in `optimize()`/`batchConvert` into module scope), which is a
maintainability change with no measurable user-facing benefit at this scale, and
is **not** part of this phase.

---

## 9. Known limits of this report

* Heap numbers are Chromium `usedJSHeapSize` after an explicit GC; they are not
  V8's `heapUsed` from a snapshot, so a ±0.1 MB jitter is noise, not drift.
* Peak heap on the 50k ERASE cells is strongly bimodal (639–857 MB across four
  sessions of the same cell). The 50k peak is dominated by the ERASE undo replay
  and a GC that may or may not land inside the window; it is reported, not used
  for any verdict.
* `50k × 50` is not measured (see §1).
* Safari / Firefox are not covered; all runs are Chromium on one machine.
