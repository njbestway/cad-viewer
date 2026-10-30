# PHASE212 — Conversion Scheduler Design

**SPEC:** SPEC-CAD-001 · Phase 2.12 Task C
**Baseline:** Phase 2.11 slot-lifecycle candidate (Phase 2.10 snapshot sharing fixed)
**Input:** [`PHASE212_MOVE_CONVERSION_AUDIT.md`](./PHASE212_MOVE_CONVERSION_AUDIT.md) (Task B)
**Status:** design accepted for the Task D prototype; the last irreducible step (see §7) is designed but **not implemented**, by design.

---

## 1. What the profile says the problem is

The 50k MOVE conversion blocks the main thread for one 2834 ms `RunTask`. Task B traced that
number to two independent defects, and the fix has to address both:

| # | Defect | Location | Consequence |
| --- | --- | --- | --- |
| 1 | The slice loop awaits a promise, and a promise continuation is a *microtask*. The loop never leaves the task. | `AcTrView2d.applyEntityUpdates`, the `for (offset…)` loop | 98 slices, 1 task, 2834 ms |
| 2 | The yield gate is constructed per `batchConvert()` call, so its `_lastYieldCompletedAt` is the call's own start time. With a 300 ms budget and 26 ms slices it can never fire. | `batchConvert` → `new AcCmUiYieldGate(300)`; `AcCmUiYieldGate.maybeYield` | 98 checks, 0 yields |

Read together: **the outer loop owns the slices but not the yield; the inner function owns the
yield but no budget to reach it.** Lowering any existing budget makes (2) *worse*, not better,
which is why Task C cannot be satisfied by tuning numbers — the loop must be given a yield it
can actually take, and the gate must be given a budget that a slice can exhaust.

The measured effect of doing exactly that, with nothing else changed, is in
[`PHASE212_OPTIMIZATION_REPORT.md`](./PHASE212_OPTIMIZATION_REPORT.md): longest conversion task
2200 → 147 ms (production, 50k, 20 interleaved rounds).

---

## 2. Separation of the synchronous transaction from view work

The database transaction is never suspended. What becomes suspensible is the *view work that
follows it*, which starts only after the transaction closed:

```text
MOVE Command                                        (one task, uninterruptible)
    ├─ startUndoMark
    ├─ startTransaction
    ├─ modify entities                               ← 960.9 ms in the 50k profile
    ├─ commitTransaction
    └─ endUndoMark
          │
          ▼
    Committed Database State                        ← epoch N, authoritative
          │
          ▼
    View Update Work                                (N slices, N-1 yields)
          ├─ remove stale drawables   ─┐
          ├─ convert chunk 1           │  every step re-checks
          ├─ yield to browser          │  epoch + per-entity generation
          ├─ convert chunk 2           │  before committing a drawable
          ├─ yield to browser          │
          └─ convert remaining chunks ─┘
          │
          ▼
    Scene Consistent                                ← counters 0, scene == db == index
          │
          ▼
    Frame Presented                                 ← two rAFs after ready
```

Two rules make this safe:

1. **The epoch is read, not assumed.** The wave captures `_convertEpoch` before the first slice
   and re-reads it after every yield. A document close, a second MOVE, or an ERASE bumps it and
   the wave returns without committing anything.
2. **Nothing is written to the scene across a yield without a re-check.** The per-entity
   generation (`_entityConvertGeneration`) is verified at `claimed` and at `commit` by
   `isConvertCurrent()`, so a slice that resumes late cannot install geometry for a state that
   no longer exists.

The transaction never spans a yield. There is no open write transaction while the browser runs.

---

## 3. The unit of work: a *wave*, not a task

A wave is one `applyEntityUpdates()` invocation — one coalesced render-update batch produced by
`AcTrEntityUpdateQueue` for one command. It owns:

| Field | Meaning | Reset |
| --- | --- | --- |
| `_convertEpoch` | document/layout generation; bumped on close, on every bulk edit, on ERASE | per wave trigger |
| `_entityConvertGeneration[id]` | per-entity revision; bumped before converting | per entity update |
| `_erasedConvertObjectIds` | tombstones for ids erased while queued | per ERASE / Undo |
| `_claimedConvertObjectIds` | in-flight claims so two passes cannot both draw one id | per claim/commit |
| wave counters (`waves/slices/entities/yields/…`) | diagnostics only | `resetConversionSchedulerMetrics()` |

**Generation, not identity.** An id is not an identity: `ERASE → Undo` restores the *same*
`ObjectId`, and a conversion started before the erase must still be discarded. That is why the
check is a tuple `(epoch, generation)` and not a membership test. This is unchanged from Phase
2.11 — Phase 2.12 relies on it rather than re-deriving it.

---

## 4. Where an interruption is actually possible

The single most important design input from Task B is the list of places where a `yield` can
land, measured rather than assumed:

| Granularity | Cost per unit | Interruptible? | Note |
| --- | --- | --- | --- |
| one entity convert | 0.3–0.6 ms | yes | finest safe unit; 50k units |
| `convertSliceMax` entities (512) | 26 ms median, 55 ms max | yes | the shipped slice |
| one shared-batch resolve | < 1 ms | yes | already amortised (2.4 % of window) |
| **`_scene.removeEntities(50k)`** | **≈ 90 ms** | **no, as written** | one compaction per container; see §7 |
| **wave prefix loops (dedupe / generation bump)** | **≈ 55 ms** | **no, as written** | four O(n) loops; see §7 |
| one `mergeGeometry` into an existing batch | up to 55 ms | no | inside one `batchConvert` call |
| `AcDbObject.cloneValue` on Undo restore | 1334 ms | **no, and out of scope** | database snapshot clone, not conversion |

The first three are inside the loop and are already sliced. The last three are the reason the
residual longest task after the prototype is 147–176 ms rather than under 100 ms.

---

## 5. Five chunking strategies compared

Task C asks for five candidates to be compared on the real hotspot. "Effective yield interval"
is the observed distance between two yields; "responsiveness" is what a user or a PING can
observe during the wave.

| Strategy | Effective yield interval | Yields per 50k op | Total conversion wall | Verdict |
| --- | --- | --- | --- | --- |
| **Fixed entity count** (512, current) | 26 ms median / 55 ms max | 0 (no yield of its own) | 2825 ms | Keeps slice cost predictable and lets one slice finish a shared batch; **kept as the inner unit**. Cannot bound the prefix or the removal pass. |
| **Time budget** (16 / 32 / 64 ms) | 33 / 31 / 28 ms per yield | 94 / 48 / 26 | +8 % (dev) / +2 % (prod) | **The shipping mechanism.** Not a replacement for slicing: a budget can only be tested *between* slices, so slice size still bounds it. |
| **By entity type** | line ≈ 12 ms, text ≈ 90 ms, insert ≈ 40 ms per 512 | varies | not measured | Rejected as a *primary* split: it reorders work away from the batch/material grouping, so it increases drawable construction. Useful only for isolating a slow type in a fixture. |
| **By batch / material group** | one group per yield | 2 (50k fixture) | n/a on this fixture | Already the effective grouping — the fixture collapses to 2 batches. Cannot be the yield trigger: with 2 groups there are 2 opportunities for 50k entities. **This is why "group by batch" is not a scheduler.** |
| **Adaptive** (start at 16 ms, grow while slices are fast, shrink on a long slice) | 28–37 ms observed | ~98–294 (unchanged) | +6–8 % | What the prototype actually behaves like, because the measured slice cost dominates the budget. Worth formalising later; **not** adopted in 2.12 because it needs its own A/B and can regress the 1k case where a single slice is the whole wave. |

**Conclusion.** Time budget is the outer trigger, fixed count is the inner unit, and the two
compose. Type-based and batch-based grouping are diagnostic tools, not schedulers. Adaptive is
promising but unproven, so it stays out with the flag off by default.

### Why a single over-budget step must be split, not merely checked afterwards

`batchConvert(512)` can take 55 ms while the budget is 16 ms. A scheduler that only tests the
budget *after* the call cannot do better than 55 ms, and the measured maximum slice (53.7 ms) is
exactly that ceiling. Splitting *inside* `batchConvert` at the per-entity level is possible but
would break shared-batch merge locality (each entity would re-open the batch it feeds), so the
split is deliberately kept at the slice boundary and the 55 ms residual is reported rather than
hidden.

---

## 6. Scheduling constraints — requirement to implementation

Every constraint in Task C2/C3, and where it is satisfied. "Existing" means Phase 2.11 already
provided it and Phase 2.12 only had to not break it.

| # | Constraint | Where | Status |
| --- | --- | --- | --- |
| 1 | Yield must let the browser run other events and paint | `AcTrConvertScheduler.createMacrotaskYield` (`scheduler.yield` → `MessageChannel` → `setTimeout`) | New. `setTimeout(0)` alone was rejected: after 5 nested levels it clamps to ~4 ms, adding ~390 ms over 98 slices. |
| 2 | The task must carry document epoch / entity generation | `_convertEpoch`, `_entityConvertGeneration` | Existing, re-checked after every new yield (§2 rule 1). |
| 3 | No stale geometry may be committed after ERASE | `_erasedConvertObjectIds` + `isConvertCurrent(…, 'commit')` | Existing. |
| 4 | A new MOVE must supersede a pending conversion of the same entity | generation bump in `invalidateEntityConversion` and again immediately before converting | Existing, and the second bump exists because a pass could re-claim the id in between. |
| 5 | Selection / Highlight / Grip must not point at stale geometry | `selectedIds` re-collected per wave; `highlight()` / `_gripManager.refresh()` run after all slices | Existing ordering; a yield does not split them. |
| 6 | Picking must not hit a deleted or invalid entity | spatial-index removal happens in the wave prefix, before any new drawable is committed | Existing. A partially removed scene is measured as *not ready* (constraint 7), so a picking caller that respects readiness never sees it. |
| 7 | Pending view update must not report ready | `getSceneReadiness` returns `pending-entities` / `deferred-jobs` / `queue-busy` before it walks the scene | Existing. This is what makes slicing observable-safe: `_numOfEntitiesToProcess` is incremented *before* the first slice and decremented per commit, so a sliced wave is never mistaken for a settled one. |
| 8 | One entity must not produce two drawables across waves | `_claimedConvertObjectIds` claim/release + tombstone | Existing. |
| 9 | Document close must invalidate old commits | epoch bump on close; wave returns on mismatch after every yield | Existing, now with more yield points to check at. |
| 10 | Not satisfiable by `setTimeout(0)` or a fixed wait | §6.1 | Satisfied by construction: yields are counted (`scheduler.yields`) and asserted in the A/B spec, and readiness is *polled*, not timed. |

### 6.1 Why "just `setTimeout(0)`" was rejected

`setTimeout(0)` is a real macrotask, so it does end the task. But Chromium clamps nested timers
to 4 ms after five levels, and microtask/timer ordering also pushes the *first* timer callback
behind every already-queued continuation. With 98 slices that is ~390 ms of added latency for no
gain in responsiveness. The prototype therefore prefers `scheduler.yield()` (the browser
prioritises the continuation correctly), falls back to a shared `MessageChannel` (both ports
`unref`ed so tests and Node exit), and only then to `setTimeout(0)`. The primitive in use is
reported in every measurement as `yieldPrimitive`.

### 6.2 The trade-off the design accepts

Yielding raises wall-clock conversion time by ~8 % (dev) / ~2 % (prod) because the work loses
warm-cache locality between slices. That is the documented price of an interruptible wave, it is
measured in both builds, and it is bounded — see the E3 discussion in
[`PHASE212_BROWSER_AB_REPORT.md`](./PHASE212_BROWSER_AB_REPORT.md) §6.

---

## 7. The irreducible step that remains (designed, not implemented)

After the prototype the longest conversion task is 261.8 ms in the dev profile and 147–176 ms in
the production A/B. It is **not** geometry work. Its self-time leaders are:

| ms (of 261.8) | Function |
| --- | --- |
| 34.1 + 19.1 + 14.5 + 7.5 | `removeEntities` in `AcTrBatchedGroup` / `AcTrLayout` / `AcTrScene` / `AcTrLayer` |
| 19.1 | `applyEntityUpdates` itself (dedupe + generation bump) |
| 13.3 | `forEachEntitySlot` |
| 11.6 + 9.2 + 6.4 + 6.4 + 4.6 | `rbush.remove` / `removeByIds` / `removeIndexedById` / `extend` / `_condense` |
| 8.7 + 2.9 | `optimize()` on the batched mesh / line |
| 6.9 + 2.9 | highlight-state clearing |

In other words: **the wave prefix — "unwrap 50,000 entities out of the scene and the spatial
index" — is one synchronous step, and it now dominates.** Splitting it is the next design, and
it is feasible:

```text
applyEntityUpdates(entities)
  ├─ phase A: dedupe + classify        → CHUNK ids, yield      (≈ 20 ms per 4096)
  ├─ phase B: hasEntity scan           → CHUNK ids, yield      (≈ 10 ms per 4096)
  ├─ phase C: removeEntities           → CHUNK ids, yield      (≈ 12 ms per 4096)
  ├─ phase D: generation bump          → CHUNK ids, yield      (≈ 15 ms per 4096)
  └─ phase E: convert slices           → unchanged (512 / budget)
```

Why it is safe: a partially removed scene is *precisely* the state the readiness tracker already
reports as not-ready (constraint 7), picking callers that respect readiness cannot observe it,
and the tombstones are already in place before phase C begins, so no stale convert can win. The
only new requirement is a wave-level in-progress marker so that a `getSceneReadiness` call during
phase A–D reports `wave-prefix:pending` instead of falling through to the O(n) scene walk.

Why it is **not** in 2.12: it changes the ordering guarantees of the wave prefix (a highlight or
spatial-index query arriving mid-removal now sees a half-updated index), which is a correctness
surface with its own regression matrix. It needs its own A/B (the prefix is only 261 ms of a
3.5 s wave, so it is a 7 % win) and it overlaps the GPU Fast Path question in Task G. Reporting
it as the documented residual is the honest outcome; the SPEC's E3 clause asks for exactly that
when 100 ms is not reachable.

Measured floor if phase A–E were sliced with a 16 ms budget: one 512-entity slice, 53.7 ms
observed maximum → **~55 ms longest task**, still above the 16 ms budget because a slice is
atomic. Getting below that requires splitting `batchConvert` per entity, which the §5 analysis
rejects for locality reasons.

---

## 8. Failure modes and how each is detected

| Failure | Detection built into the measurement | Asserted in |
| --- | --- | --- |
| Ghost geometry (drawable for a deleted entity) | `residualInScene` count after ready | `phase212-browser-ab.spec.ts`, every round |
| Missing entity (conversion dropped by a yield) | `missingInScene`, `missingInIndex` after ready | same |
| Stale drawable winning after ERASE | `staleConvertRejections` counters (`session` / `revision` / `erased` / `notInDatabase`) | `phase212-move-conversion.spec.ts`, `phase211-slot-lifecycle.spec.ts` |
| Readiness reported early | `ready` must be `true` **and** all four id-difference counts `0` in the same observation | A/B spec, every round |
| Duplicate drawable across waves | `entityUpdateStats.maxConcurrentApplies`, `cancelledWaveCount`, `failedWaveCount`; renderer `uniqueGeometry` vs `renderables` | A/B spec JSON |
| Document close leaving a live task | epoch mismatch return path; `activeInstances` / `slotCapacity` / `sharedBatch.activeBatches` after close | phase 2.11 slot matrix |
| Total conversion regressing | `readyMs` and conversion wall recorded on both arms of the same run | A/B spec, §6 of the A/B report |

The stop criteria in the SPEC are all covered by a row above; none of them fired in 2.12 (see
[`PHASE212_CORRECTNESS_REPORT.md`](./PHASE212_CORRECTNESS_REPORT.md)).

---

## 9. Alignment with the Phase 2.12 prohibitions

| Prohibition | Status |
| --- | --- |
| Do not refactor the transaction snapshot | untouched |
| Do not implement `TransformUndo` | untouched; Undo still restores by snapshot clone (§4, last row) |
| No write transaction held across an event loop | §2: the wave starts after `commitTransaction` returns |
| No full GPU buffer-translate fast path | untouched; GPU feasibility is a separate document |
| No `ObjectId` / `Handle` / `OwnerId` change | untouched |
| No change to the Phase 3 scope | this document stops at the CPU scheduler |
| No Worker / Wry / Rust migration | untouched |

---

## 10. Summary

*The design is "give the loop the yield, give the yield a budget", plus a correctness model that
already existed and had to be re-verified at every new yield point.* The shipping mechanism is a
16 ms budget over 512-entity slices with `scheduler.yield()`; the measured result is a 2200 → 147 ms
longest conversion task in the production build. The residual 147–261 ms is the wave prefix, whose
split is designed here (§7) and deliberately deferred. The GPU question is answered on its own
terms in [`PHASE212_GPU_FASTPATH_FEASIBILITY.md`](./PHASE212_GPU_FASTPATH_FEASIBILITY.md), and the
answer is that it does not remove this residual.
