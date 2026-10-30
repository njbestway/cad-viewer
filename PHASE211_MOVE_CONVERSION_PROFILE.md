# PHASE211 · Task G — MOVE Conversion Profile (pre-review, no optimisation shipped)

**Scope: analysis only.** No production optimisation for MOVE is part of Phase
2.11. The single code change that this profiling did produce — the LIFO
`reserveGeometryId()` — is a slot-reuse fix (Task C) that happened to remove a
quadratic sort, and it is measured here because it changed the profile the task
asks about.

**Headline:** the ~2 s MOVE stall is not a single function. It is **one timer
callback that runs a chain of ~88 synchronous convert slices**; each slice is
small, but nothing between slices yields to the event loop, so the whole chain
counts as one long task. Removing the `reserveGeometryId()` sort cut the callback
from **13.15 s to 2.82 s** and the conversion window from 20.4 s to 12.8 s, but
the callback is still seconds long because the yield budget is reset per slice
instead of being shared across the wave.

Artifacts:

| file | content |
| --- | --- |
| `reports/phase211/profiles/move50000-before.{cpuprofile,trace.json,raw.json}` | pre-fix build |
| `reports/phase211/profiles/move50000.{cpuprofile,trace.json,raw.json}` | post-fix build |
| `reports/phase211/phase211-move-conversion-profile-before.json` | stage buckets + trace summary (pre-fix) |
| `reports/phase211/phase211-move-conversion-profile.json` | stage buckets + trace summary (post-fix) |
| `reports/phase211/g-50k.log`, `g-50k-after.log`, `g-smoke.log` | run logs |

Reproduce:

```
$env:P211_PROFILE='move'; $env:P211_SIZE='50000'
npx playwright test e2e/tests/phase211-move-profile.spec.ts
node packages/cad-editor-demo/e2e/helpers/phase211-profile-report.mjs
```

---

## 1. What is measured

50 000 mixed entities (60 % LINE / 20 % LWPOLYLINE / 10 % INSERT / 10 % TEXT,
3 layers), one `translateEntities()` inside `runDatabaseEdit`, dev build,
Chromium, CPU profile at 200 µs sampling plus a DevTools trace.

Three regions:

* **commit** — the synchronous transaction (`openEntityForWrite` → snapshot →
  `transformBy` → `finalize` → `commit`).
* **conversion** — everything after the commit until `waitUntilSceneReady()`
  resolves: the update queue, the removal pass, the per-entity rebuild and the
  batch re-insertion.
* **presentation** — GPU upload and the frames that show the result.

---

## 2. Wall clock and long tasks

| | pre-fix | post-fix |
| --- | --: | --: |
| commit (sync) | 1 371.1 ms | 1 308.1 ms |
| settle (`waitUntilSceneReady`) | 129.3 ms | 142.2 ms |
| total | 1 500.4 ms | 1 450.3 ms |
| conversion window (profile) | **20 382.9 ms** | **12 847.3 ms** |
| trace coverage | 21 146 ms / 315 tasks | 5 783.5 ms / 1 915 tasks |
| long tasks (`PerformanceObserver`, edit window) | **16**, total 18 422 ms | **3**, total 3 044 ms |
| longest single task | **13 150.5 ms** (`RunTask` → `TimerFire`) | **2 816.9 ms** (`RunTask` → `TimerFire`) |
| second longest | 1 557.5 ms (JS task, 48 `MinorGC` children) | 1 486.9 ms (JS task, 48 `MinorGC` children) |
| third longest | 1 020.3 ms | 871.9 ms |

The trace coverage difference (21 s vs 5.8 s) is not a speed-up of the trace
window: the pre-fix run had to keep recording across a 13 s block, so more of the
window was covered. The post-fix trace has fewer events because the work is
shorter. (The trace itself counts 18 tasks over 50 ms pre-fix and 5 post-fix over
the same window; the table above uses the page-side observer, which brackets the
edit rather than the whole recording.)

**Both runs end in the same shape**: one `TimerFire` of several seconds. The
difference is 13.15 s → 2.82 s.

---

## 3. Where the CPU goes (self time, post-fix)

`(idle)` 8 255 ms of 14 079 ms sampled — i.e. **59 % of the sampled conversion
window is the main thread waiting**, because the batch-level GPU work and the
paint are elsewhere. The remaining 5.8 s:

| frame | self ms | samples |
| --- | --: | --: |
| `(program)` — code without a JS frame attribution | 1 318 | 1 809 |
| `(garbage collector)` | 270 | 417 |
| `batchConvert` | 64 | 114 |
| `mergeMeshGeometriesUnprofiled` | 63 | 111 |
| `copyAttributeData` | 63 | 110 |
| `proto.draw` (WebGL draw) | 55 | 83 |
| `clone` | 43 | 75 |
| `safeApplyMatrix4` | 42 | 75 |
| `_BufferGeometry` (construction) | 34 | 59 |
| `getX` (packed attribute read) | 33 | 58 |
| `shouldConvert` | 32 | 56 |
| `min` | 31 | 53 |
| `applyMatrix4` ×2 | 55 | 97 |

Pre-fix, the same list was dominated by two frames that no longer exist:

| frame | self ms (pre-fix) |
| --- | --: |
| `reserveGeometryId` | **12 105.9** |
| `ascIdSort` | **1 535.5** |
| `(program)` | 1 328.6 |
| `(idle)` | 451.1 |
| `(garbage collector)` | 230.0 |

`reserveGeometryId` spent 12.1 s sorting a free list that grew to 45 000 ids,
50 000 times. That is the whole of the pre-fix 15 s block, and it was a direct
consequence of the free list finally being populated (Task C) — which is why the
same fix that removed the leak also removed the stall's dominant cost.

---

## 4. The nine stages

Buckets are disjoint: a frame belongs to the first stage whose name or URL
matches. They are a shape, not an invoice: the unattributed remainder is the
`(program)`/GC/idle mass above.

| stage | pre-fix ms | share | post-fix ms | share |
| --- | --: | --: | --: | --: |
| entity update queue (`enqueue`, `takeWave`, `resolveSceneUpdateEntities`) | 32 | 0.15 % | 36 | 0.25 % |
| existing geometry removal (`removeEntities`, `deleteGeometryById`) | 62 | 0.28 % | 57 | 0.40 % |
| drawable construction (`drawEntity`, `createGeometryState`) | 18 | 0.08 % | 7 | 0.05 % |
| `finishEntityGeometry` | 20 | 0.09 % | 19 | 0.13 % |
| glyph / INSERT finalizer (`transformBy`, `subWorldDraw`, `finalize`) | 175 | 0.81 % | 107 | 0.76 % |
| `AcTrBatchedGroup.addEntity` (+ bbox, visibility) | 230 | 1.06 % | 157 | 1.12 % |
| buffer attribute copy (`fromArray`, `AcGeVector3d.copy`, `AcGeMatrix3d.fromArray`) | 216 | 1.00 % | 124 | 0.88 % |
| `optimize()` | 11 | 0.05 % | 12 | 0.09 % |
| GPU upload / frame presentation (`drawElements`, `CSS2DRenderer.render`) | 1 | 0.01 % | 0 | 0 % |
| **sum of stages** | **765** | 3.5 % | **519** | 3.7 % |
| conversion total | 20 382.9 | 100 % | 12 847.3 | 100 % |

Per slot: 12 847 ms / 45 000 = **0.29 ms per slot** for the whole conversion.

Two stage readings matter:

* `optimize()` is **12 ms**. Compaction is not the problem at this fixture's
  ratio of live-to-deleted slots (45 000 live, 45 000 freed, one pass).
* `gpuUploadAndPresent` is **0 ms** in the profile window, because the draw
  happens in frames the profile window does not cover. Upload cost must be read
  from the trace, not from this table.

---

## 5. The six questions

### Q1 — Is the blocking one unsplittable function, or a chain of synchronous functions?

**A chain.** The trace attributes the stall to a single `RunTask` whose only
child is one `TimerFire` (13 150 ms pre-fix, 2 817 ms post-fix). Inside that
timer callback, `applyEntityUpdates()` loops over the wave and awaits
`batchConvert(slice)` with `sliceSize = convertSliceMax = 512`
(`AcTrEntityUpdateQueue.ts`), i.e. **45 000 / 512 ≈ 88 awaits**. Each `await`
resumes on a microtask, so 88 slices still belong to the *same* macrotask.

`batchConvert()` does own a yield gate (`AcCmUiYieldGate`), but the gate is
constructed **per slice** with a 300 ms budget; a 512-entity slice finishes
before the budget expires, so the gate never fires. Zero macrotask yields in the
whole wave → one multi-second task.

### Q2 — Is it the same hot spot as ERASE Undo's `Object3D` / glyph construction?

**Mostly yes, and the difference is instructive.** The stages that remain after
the sort is gone — `glyphInsertFinalizer` 107 ms, `addEntity` 157 ms,
`bufferAttributeCopy` 124 ms — are exactly the per-entity rebuild the ERASE undo
path also performs when it re-appends entities (`ERASE_UNDO_PROFILE.md`), because
both paths reconstruct a drawable from the database entity.

The asymmetry: ERASE *does not* rebuild for the deleted entities (it removes
slots and compacts), so its blocking is dominated by one `optimize()` pass over
50k slots, whereas MOVE rebuilds all 45 000 slots. That is why a MOVE costs
0.29 ms/slot of conversion and an ERASE does not.

### Q3 — Can post-commit view work be split without changing transaction semantics?

**Yes, and it is the cheapest lever found in this phase.** The conversion is
already strictly post-commit: `runDatabaseEdit` returns before any of it runs,
the undo record is complete, and the view only consumes `AcDbEntity` snapshots.
Splitting it is a view-side scheduling change.

The concrete defect is the **per-slice budget reset**: `applyEntityUpdates()`
creates a new gate per `batchConvert()` call, so the elapsed time is forgotten
between slices. Carrying one deadline across the loop (or inserting
`await new Promise(r => setTimeout(r, 0))` when the accumulated slice time
exceeds ~50 ms) splits the 2.8 s callback into ~50 ms tasks **without touching
the transaction, the undo record or the commit boundary**.

Not implemented in this phase — it is a MOVE-conversion optimisation, and the
phase forbids shipping one. It is recorded as the highest-value, lowest-risk
follow-up.

### Q4 — Which entities are good candidates for drawable reuse?

Based on the stage split and the entity mix:

* **LINE / LWPOLYLINE without style change** — geometry is a pure translate;
  the packed vertices are already in the buffer. Best candidates, 80 % of the
  fixture.
* **TEXT / MTEXT whose string and style are unchanged** — the glyph atlas entry
  is reusable; only the placement matrix changes. The `glyphInsertFinalizer`
  bucket (107 ms) is exactly this work, and it is avoidable when the glyph set
  does not change.
* **INSERT whose block definition did not change** — the fragment slots are the
  same, only the transform differs (this is what `AcTrSharedGeometryBatch` was
  built for; it already reuses template geometry across instances).
* **Not candidates:** entities whose geometry actually changed (layer/font/width
  change, block redefinition, grip edit that moves a vertex), and any entity
  whose *batch* changes (a style change moves it to another container).

### Q5 — How much CPU would a GPU in-place translate avoid?

Measured, from the post-fix stage table, the per-entity work a translate fast
path would remove:

| stage | ms | removable? |
| --- | --: | --- |
| `addEntity` (re-insert into a container) | 157 | yes, if the slot is kept |
| `bufferAttributeCopy` | 124 | yes (no re-upload) |
| `glyphInsertFinalizer` | 107 | yes for unchanged text |
| `existingGeometryRemoval` | 57 | yes (nothing is removed) |
| `finishEntityGeometry` | 19 | yes |
| `optimize()` | 12 | yes (no free/alloc cycle) |
| `drawableConstruction` | 7 | yes |
| **total** | **≈ 483 ms** | of 12 847 ms wall (3.8 %) |

So the *CPU* upside is ~0.5 s of a 12.8 s window — and, more importantly, it
would remove the need for the 2.8 s callback entirely for pure translates, since
no per-entity work would remain to run inside it. The upside is therefore mostly
**latency/jank**, not throughput: the frame after the commit could show the moved
drawing without waiting for a rebuild.

Two caveats that must be settled before it can be approved:
undo/redo of a translate would then be a matrix write, which collides with the
explicitly forbidden `TransformUndo`; and a per-slot matrix changes the packing
format the picking/bbox code reads.

### Q6 — Do preview and committed states need different presentation policies?

They already differ, and the difference should be preserved rather than unified:

* a **preview** (drag/ghost) is drawn from a transient overlay that never enters
  the batch containers or the undo stack, and it must be allowed to run at
  interactive cadence with no scene-ready barrier;
* a **committed** edit must be atomic in the database and may be *presented*
  incrementally — that is exactly what the slicing in `applyEntityUpdates()`
  already intends, and what the missing macrotask yield currently defeats.

The policy recommendation is therefore not "different rendering for preview",
but "**one presentation budget for the committed wave**": the same 50 ms
`DEFERRED_GEOMETRY_YIELD_BUDGET_MS` discipline that Phase 2.8 introduced for
deferred geometry should bound the update wave.

---

## 6. Attribution summary

| cost | pre-fix | post-fix | attributed to |
| --- | --: | --: | --- |
| 13.15 s single task | 100 % | — | `reserveGeometryId` sort (12.1 s) + `ascIdSort` (1.5 s) |
| 2.82 s single task | — | 100 % | 88 microtask-chained convert slices, no macrotask yield |
| 0.48 s CPU | 3.5 % of 20.4 s | 3.8 % of 12.8 s | per-entity rebuild (add/copy/glyph/finish) |
| 12 ms | 0.05 % | 0.09 % | `optimize()` compaction |
| ~0 ms | 0.01 % | 0 % | GPU upload inside the profile window |
| 8.3 s idle | 2 % | 59 % | main thread waiting between/inside slices |

---

## 7. What this phase did **not** do, deliberately

* No yield-budget change (`applyEntityUpdates` still has the per-slice reset).
* No GPU translate fast path.
* No `TransformUndo`.
* No drawable reuse.
* No change to the slice size or the wave mechanism.

Everything in §5 Q3–Q6 is a candidate for Phase 2.12 and requires its own
approval, its own correctness suite (a translate fast path has to reproduce
every D16–D18 race) and its own A/B before it can land.
