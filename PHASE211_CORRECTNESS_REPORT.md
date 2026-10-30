# PHASE211 · Task D — Correctness & Race Report

**Verdict: PASS on 19 of the 20 required items; item 11 is covered for
LINE / LWPOLYLINE / INSERT / TEXT but not MTEXT** (see §5), which is recorded as
a residual gap rather than claimed.

Nothing in the reuse change moves an `ObjectId` mapping, a pick result, a
selection, an async write or an undo/redo outcome. The suites that prove this do
**not** rely on `renderer.info.memory.geometries` staying flat — every round
compares the complete id set of the database, the scene and the spatial index,
and every round performs a pick at a fixed world point.

---

## 1. Test inventory

| suite | tests | runs in |
| --- | --: | --- |
| `packages/three-renderer/__tests__/AcTrBatchSlotLifecycle.spec.ts` | 12 | node (jest) |
| `packages/three-renderer/__tests__/AcTrBatchSlotReuseRegression.spec.ts` | 13 | node (jest) |
| `packages/cad-editor-demo/e2e/tests/phase211-slot-lifecycle.spec.ts` | 5 test *bodies*: convergence matrix (per size × op × session), close, D16, D17, D18 | browser (Playwright, Chromium) |

Logs: `reports/phase211/d1-node-regression.log`,
`reports/phase211/e1-*.log` (convergence cells),
`reports/phase211/d-race.log`, `reports/phase211/d-close-after.log`,
`reports/phase211/e3-heap-snapshot.log`.

Node result: **25 passed / 25**. Browser result: **5 passed** per convergence run
(the matrix body expands to 1 test per size × op × session), 1.7–2.3 min per
session.

---

## 2. The 20 required items

Legend: **N** = node suite, **B** = browser suite, **cell** = a cell in
`phase211-slot-lifecycle.json`.

| # | requirement | covered by | what is asserted |
| --: | --- | --- | --- |
| 1 | consecutive add / remove on one batch | N `holds capacity across consecutive add/remove on one batch` | 200 add/remove cycles: capacity stops growing, free list never exceeds the freed set, every re-add gets a reused id |
| 2 | rebuild the same `ObjectId` right after removing it | N `rebuilds the same ObjectId immediately after it was removed` | the re-added entity lands in a reused slot, is pickable at its **new** position and not at the old one |
| 3 | ERASE → Undo → Redo → Undo | N `survives ERASE → Undo → Redo → Undo without growing the slot table`; B every cell round | N: table length unchanged across the 4 steps. B: per-round id-set equality plus a pick after each step |
| 4 | MOVE → Undo → Redo | N `survives MOVE → Undo → Redo with the geometry following the slot`; B `move` cells | the slot's packed geometry follows the matrix; the undo restores the pre-move centroid within 0.05 |
| 5 | 10k / 50k single-command ERASE | B cells `k10*`, `k50*` (erase) | 1 command erases the whole fixture; id set empty → full → empty → full across the round; slot capacity constant |
| 6 | 10k / 50k single-command MOVE | B cells `k10*`, `k50*` (move) | same, with 9 000 / 45 000 entities translated in one transaction |
| 7 | repeated delete of one object, duplicate notifications | N `absorbs repeated delete notifications for the same object` | second delete is a no-op: `deleteGeometrySkipped`/`duplicateFreeAttempts` +1, the id is **not** pushed twice, `freeListSize` unchanged |
| 8 | many layers sharing one material | N `keeps layers that share one material on independent slots` | two layers, one material: distinct slots, deleting one leaves the other live and pickable |
| 9 | mixed batch types | N `mixes line, mesh, point and wide-line containers` | four container classes in one group; every delete is routed to the right container, per-container metrics sum to the group total |
| 10 | per-entity material stress | N `keeps per-entity materials from spawning replacement batches` | N entities with N materials do not create a container per entity; the batched container count stays constant |
| 11 | LINE / LWPOLYLINE / INSERT / TEXT / MTEXT | B fixture (60 % LINE, 20 % LWPOLYLINE, 10 % INSERT, 10 % TEXT) | see §5 — **MTEXT not covered** |
| 12 | multi-level INSERT fragments | N `frees every fragment slot of a multi-level INSERT` | a 2-level block reference frees one slot per fragment; re-inserting reuses exactly those ids |
| 13 | selection / hover / highlight / grip | N `clears selection and hover before the slot is handed to another entity`; B per-round picks | masks are cleared **before** the records are released, so a reused slot never shows the previous owner's highlight; a grip is dropped with the entity |
| 14 | picking and bounding box | N `picks and bounds only the current owner of a reused slot`; B every round | raycast hits the new owner only; `getBoundingBoxAt` returns the new owner's box; the freed record's box is null |
| 15 | spatial index complete id set | B every round (`ids.index`, `missingFromIndex`, `residualInIndex`) | index id set equals the DB id set after every step of every round; missing/residual are 0 |
| 16 | async geometry queued but not committed | B **D16** | see §3 |
| 17 | old task still running when ERASE lands | B **D17** | see §3 |
| 18 | old async task returns after the slot was recycled | B **D18** | see §3 |
| 19 | late conversion after the document is closed | B `close document releases slot tables` | batches 0, capacity 0, live 0, scene/index id sets 0 — and still 0 one second after the parked job is released |
| 20 | Phase 2.9 empty shared batch eviction | N `leaves phase 2.9 shared-batch metrics untouched by slot reuse`; B cells (`sweepEmptySharedBatches(0)`) | after the sweep `emptySharedBatches = 0`, `activeBatches = 1`; the eviction counter still increments per round |

---

## 3. The convert-versus-erase races (D16 / D17 / D18)

These are the only tests that make the race *deterministic*:
`view.setConvertDebugHook(stage, objectId)` parks the pipeline at `queued`,
`claimed` or `beforeCommit`, so "the job is in flight" is a state the test holds,
not a timing guess.

Common setup: a 300-entity mixed fixture, cell 0 is a `LINE (0,0)-(2,2)`, probe
A at `(6,6)` (committed position) and probe B at `(11,11)` (the position only a
stale, non-rejected job could produce).

### D16 — ERASE while the job is `queued`

`queued` only exists on the *append* path (`_convertQueue`); a MOVE goes through
`_entityUpdateQueue` and never enters it. So the test builds the state
deliberately:

1. `ERASE` the entity and drain (the id now lives only in the undo record);
2. `Undo`, parking the re-append at `queued` — restored in the database, queued
   for the scene, claimed by nobody;
3. `ERASE` it again **while it is queued**;
4. release the job, drain.

Asserted: the hook did pause at `queued` for that id; the entity is not restored
(`hasEntity === false`); `slotsOfTarget === 0`; the tombstone set contains the
id; the queue is empty after the release; the pick misses; `invalidSlots === 0`.

### D17 — ERASE while the job is `claimed`

A MOVE is parked at `claimed` — the job already holds a slot id — and the entity
is then erased. Asserted: the hook paused at `claimed`, `hasEntity === false`,
`slotsOfTarget === 0` (the claimed job did **not** commit a slot for an erased
id), the pick misses, `invalidSlots === 0`, and the stale-convert rejection
counter is **non-zero** — the job was rejected by a gate, not merely forgiven by
timing.

### D18 — the late job returns after the slot was recycled

1. commit a MOVE to `(5,5)`, verify the slot holds `(5,5)-(7,7)` and is pickable
   at `(6,6)`;
2. park a second MOVE at `claimed`;
3. `ERASE` → `Undo` (re-appends the entity → **reuses the slot**) → `Undo` (rewinds
   the first MOVE);
4. release the parked job.

Asserted: the slot belongs to the restored id (`slotsOfTarget === 1`), its packed
geometry is the **committed** version (`expectNear(centroid, committedGeometry)`),
it is pickable at `(6,6)`, **not** pickable at `(11,11)` (the parked job's
position), the stale counter is non-zero (the job *was* rejected, not merely
lucky), and `invalidSlots === 0`.

This is the case `slotGeneration` exists for: the id is the same array index, but
the generation the parked job captured is no longer current.

---

## 4. What the per-round id-set check actually does

Every round, in every cell, the suite reads:

* the DB id set from `modelSpace.newIterator()` (300 / 1 000 / 10 000 / 50 000);
* the scene id set from the layout's `collectObjectIds()`;
* the spatial-index id set from `spatialIndexRootIds`.

It then compares them **as sets** after each of the four steps (edit, undo, redo,
undo) and records `db`, `scene`, `index`, `missingFromScene`, `residualInScene`,
`missingFromIndex`, `residualInIndex` per round. Across the 25 lifecycle cells
(**1 035 measured rounds**) all four mismatch counters are **0** in every round.

A reused slot that still pointed at a dead entity, or a live entity whose slot
was silently dropped, changes the scene set — which is why this, and not the
renderer's geometry count, is the acceptance criterion.

---

## 5. Coverage gap: MTEXT

The browser fixture is 60 % `LINE` / 20 % `LWPOLYLINE` / 10 % `INSERT` /
10 % `TEXT` across three layers. `MTEXT` is not in it, and the node suites use
synthetic `BufferGeometry` payloads rather than parsed entities, so **MTEXT has
no end-to-end slot-lifecycle test in this phase.**

Why it is nonetheless low risk: MTEXT reaches the slot API through the same
glyph/mesh path as TEXT (`AcTrMeshGlyphWorldBatch` → `addGeometry` /
`deleteGeometry`), and the slot logic is entity-type agnostic — it sees only
`(geometryId, flags, ranges)`. The INSERT and TEXT cells exercise the glyph
finalizer and the fragment path.

Why it stays in the report: "same code path" is an argument, not a measurement.
Recommendation for Phase 2.12: add `MTEXT` and a `DIMENSION` (anonymous block) to
`writeMixedFixture` at ~2 % and re-run the 1k × 100 cell.

---

## 6. Node suite detail (25/25)

`AcTrBatchSlotLifecycle.spec.ts` — 12:

```
counts the delete calls that the ERASE path issues
leaves the free list equal to the set of freed slots after compaction
converges slot capacity across repeated ERASE / Undo rounds
reports a free list with no duplicates, no active ids and no stale ranges
drops the bounding box of a freed slot
drops the hidden draw snapshot of a freed slot
hands a reused slot a record with no state from its previous owner
keeps slot capacity at the high-water mark, not at the live count
does not keep a removed slot pickable
stamps a new generation on the id handed to the next owner
refuses a slot id after the batch has been reset
folds per-batch metrics into group totals
```

`AcTrBatchSlotReuseRegression.spec.ts` — 13:

```
holds capacity across consecutive add/remove on one batch
rebuilds the same ObjectId immediately after it was removed
survives ERASE → Undo → Redo → Undo without growing the slot table
survives MOVE → Undo → Redo with the geometry following the slot
absorbs repeated delete notifications for the same object
keeps layers that share one material on independent slots
keeps per-entity materials from spawning replacement batches
mixes line, mesh, point and wide-line containers
frees every fragment slot of a multi-level INSERT
clears selection and hover before the slot is handed to another entity
picks and bounds only the current owner of a reused slot
drops every slot record when the batch is reset
leaves phase 2.9 shared-batch metrics untouched by slot reuse
```

---

## 7. Regression outside this phase's scope

These were re-run because the slot change touches the batch containers that
Phase 2.9/2.10 rely on:

| suite | result |
| --- | --- |
| `phase210-scene-readiness.spec.ts` | 7/7 passed (1.2 min) |
| `phase210` slot attribution / A-B prod build (`playwright.prod.config.ts`) | 1 passed, prod bundle |
| Phase 2.11 `close` preset (browser, prod build) | 1 passed (27.1 s) |
| realdwg-web `AcDbTransactionSnapshot*` | 4 suites / 51 tests (41 + 10 new integrity tests) |

The transaction-side suites are Phase 2.10 closeout evidence, not Phase 2.11
slot evidence; they are listed because the same session's data-model tarball is
used by both.

---

## 8. Residual risks

1. **MTEXT / DIMENSION** — see §5.
2. **`slotGeneration` is not consulted at the production commit site.** It is
   stamped and assertable (`isSlotGenerationCurrent`) and the D18 race is
   rejected by the existing epoch/generation/tombstone gates; the slot-level
   check is currently exercised only by tests. If a future change introduces an
   `await` between reserve and commit, the check must be added — the audit's Q5
   explains why it is not needed today.
3. **`removeEntities()` clears highlight before releasing**, and `optimize()`
   then rewrites masks. A container that is emptied and refilled inside the same
   task could show a one-frame stale mask; no test observes it because the mask
   attributes are rewritten in the same task.
4. **The 12 s `optimize()` compaction on 50k** is unchanged and remains the
   largest single synchronous cost in ERASE (performance report §4). Reuse makes
   it *correct*, not cheap.
