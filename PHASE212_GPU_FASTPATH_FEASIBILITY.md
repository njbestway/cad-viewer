# PHASE212 — GPU Fast Path Feasibility (Task G)

**SPEC:** SPEC-CAD-001 · Phase 2.12 Task G
**Scope: architecture assessment only. Nothing here is implemented.**
**Basis:** the 50k MOVE CPU profile and trace recorded in Task B
(`reports/phase212/profiles/move50000.{cpuprofile,trace.json,raw.json}`), attributed with
`tools/phase212-profile-analyze.mjs`. Every number below comes from that data; none is a claim
about theoretical GPU throughput.

---

## 0. The number this has to beat

| Metric (50k MOVE, baseline) | Value |
| --- | --- |
| conversion window (union of `batchConvert` tasks) | **2822.7 ms** |
| synchronous DB commit (separate task) | 960.9 ms |
| frame-presentation task (`AcTrView2d.animate`) | 181.4 ms, of which ~179.8 ms JS |
| GPU upload inside that task (`bufferSubData`) | **11.7 ms** |
| `gpuBufferUpdate` self time inside the conversion | ~0 ms |

**Read that table again before continuing.** The main-thread block is 2822.7 ms of *CPU geometry
work*. GPU work on the same command is 11.7 ms of upload plus a 181.4 ms frame. A GPU fast path
can only win if it removes *CPU* work, and the only CPU work it can remove is the work that
exists because of the batching model — not because of the GPU.

---

## 1. Which entity types can be translated on the GPU

The question is not "can the GPU translate a vertex" (it obviously can) but "does this entity's
geometry live in a buffer whose contents are position-independent".

In this renderer, a batched drawable's vertices are **baked into batch/world space** when the
entity is merged (`mergeMeshGeometriesUnprofiled`, `copyAttributeData`,
`setFromBufferAttribute`). Merging 50,000 entities into 2 batches is exactly why `drawEntity` is
only 358.7 ms and `renderables` is 3 for 50k entities. The price is that moving one entity
requires rewriting its run of vertices.

| Entity type | Can a pure translation be done on the GPU? | Why |
| --- | --- | --- |
| **INSERT instance backed by a shared batch** | **Yes** | Already the shape a GPU path needs: one template geometry plus a per-instance matrix (`sharedBatch.templateGeometryCount 1`, `uniqueTemplateUUIDCount 1`, 5000 instances on this fixture). A translation is a matrix update. |
| LINE / LWPOLYLINE in a plain batch | **No, not without a model change** | Both endpoints are baked into the batch buffer. A translation is a rewrite of the entity's vertex run, i.e. the same 26 ms-per-512-slice work, just relocated. |
| TEXT / MTEXT (glyph) | **No** | Glyph geometry is produced by the MTEXT renderer from layout, not from a fixed vertex set; `asyncRenderMText` / glyph merge is 875.8 ms inclusive and is *generation*, not transformation. Screen-space metrics also depend on position. |
| DIMENSION | **No** | Geometry depends on the measured points; a translation can change text placement, arrows and extension-line lengths. |
| HATCH | **No** | Pattern origin and scale are anchored to the entity's own space, not the world. |
| Whole-block / whole-layout rigid move | **Yes in principle** | If every member shares one transform, a single matrix on the group node suffices. Not exercised by this fixture (entities are independently selected). |

On the acceptance fixture this leaves **5000 of 50000 entities** (the INSERT instances), and their
resolve path already costs only `sharedBatchResolve` **8.8 ms inclusive** — i.e. the work a GPU
path would eliminate is 0.3 % of the window.

## 2. What must still rebuild CPU geometry

Everything that is merged into a plain batch, plus anything whose geometry is a function of
position rather than only of a matrix: LINE, LWPOLYLINE, TEXT, MTEXT, DIMENSION, HATCH, and any
entity whose layer/material grouping changes the batch it merges into.

Measured share of the window that is generation rather than transformation:

| Function | inclusive (baseline) |
| --- | --- |
| `batchConvert` | 1139.3 ms |
| glyph / MTEXT merge | 875.8 ms |
| `drawEntity` | 358.7 ms |
| `commitEntity` | 319.6 ms |
| entity-update queue pump | 253.0 ms |
| INSERT fragment finalize | 158.3 ms |
| (of which) attribute copy, self | 158.3 ms |
| `optimize()` | 21.6 ms |
| shared batch resolve | 8.8 ms |

The only line a GPU translation shortens is the last one.

## 3. Pure translation vs other transforms

| Transform | GPU-viable? | Note |
| --- | --- | --- |
| Pure translation (this phase's MOVE) | yes, for matrix-carried geometry | the cheapest case, and the one under test |
| Rotation / uniform scale | yes for matrix-carried geometry, **no** for text and hatch | glyph rasterisation and pattern spacing are not rigid |
| Non-uniform scale / mirror | no | normals and line widths must be recomputed; dashed-line phase breaks |
| Grip drag (continuous) | preview-only today | the existing preview GPU transform is exactly this, and it is why the preview looks smooth |

## 4. INSERT and glyph: the boundaries

* **INSERT** is the one type where a GPU path is already half-built: shared-batch templates plus
  per-instance matrices. Extending it to translation means deciding who owns the matrix
  (instance attribute vs node transform) and keeping the spatial index in step (§5).
* **Glyph / MTEXT** is out of scope for translation. Glyph instances are world-batched per glyph
  (`AcTrMeshGlyphWorldBatch`, `removeMeshGlyphInstances`, `AcTrGlyphEntity.asyncDraw`), and the
  batch is *shared by glyph identity*, not by entity. Translating a glyph instance is possible;
  translating "the text of an MTEXT because the MTEXT moved" is not, because reflow can change
  which glyphs exist. Task A2's glyph slot lifecycle spec exists precisely because that batch has
  its own lifetime rules.

## 5. Picking and spatial index synchronisation

A GPU translation changes what is on screen without touching the scene graph, so everything that
answers "what is at this point" needs a second source of truth:

| Consumer | Today | With GPU translation |
| --- | --- | --- |
| `Picking` (`AcTrBatchedLinePick`, `AcTrPickResultUtil`) | reads baked geometry | must read the same matrix the GPU uses, or pick against a stale position |
| Spatial index (`AcTrHierarchicalSpatialIndex`, rbush) | updated during the wave prefix | must be updated on translate-complete, not at remove time |
| Selection / Grip | uses entity bounds | must use transformed bounds |
| `getSceneReadiness` | walks scene ids and the index | needs a "translation pending" state, or it reports ready while the index is stale |
| Export / HTML | walks geometry | needs the transformed matrix applied |

The cheapest sound design is *still a full wave*: translate on the GPU for pixels, and run the
index/bounds update asynchronously. That does not remove the 253 ms queue pump or the `removeEntities`
pass — it only removes the geometry rebuild for matrix-carried entities.

## 6. Undo / Redo restoration

Undo restores by database snapshot clone (`AcDbObject.cloneValue` /
`copySnapshotStateTo` / `captureOriginalState` — 1334 ms in the after profile, entirely outside the
conversion window). A GPU translation is a *renderer* state, not a database state, so:

* Undo must restore the matrix, not the geometry. If the matrix lives on the instance attribute,
  that is one attribute write per entity — cheap.
* The snapshot clone path is unchanged either way. **GPU translation does not touch the 1334 ms
  Undo cost**, which is why Task 2.13/Phase 3 cannot use it as an Undo optimisation.

## 7. Buffer ownership

Whoever translates must own the buffer, and today nobody does at entity granularity:

* Batched geometry is owned by the batch (`AcTrBatchedGroup`), compacted on removal
  (`optimize()`, `_condense`), and shared across entities via slots (`AcTrSharedGeometryBatch`).
* A translation that writes into a batch's vertex run without going through the slot lifecycle
  would desynchronise `slotGeneration`, `availableGeometryIds` and the Phase 2.11 free list.
* So a GPU path must own **per-instance matrices**, not vertex ranges — which again only fits the
  shared-batch/INSERT shape.

## 8. Reuse of the existing preview GPU transform

The Move command already draws a GPU-transformed preview during the drag
(`AcApMovePreviewJig`, `AcTrEntityPreview`, `AcApEntityPreviewConvertor`). That machinery is real
and reusable for the *visual* part of the answer. It is not reusable for the *state* part: a
preview is transient and never enters the index, the slot lifecycle, or the undo stack. Reusing it
means promoting a preview-style transform into a committed one, which is exactly §5 + §6 + §7 —
not a rendering change.

## 9. Realistic CPU time it can remove on this fixture

Upper bound, assuming a perfect implementation that keeps the batch model intact:

| Term | Window share | Removable by GPU translation? |
| --- | --- | --- |
| geometry generation (`batchConvert`, `drawEntity`, glyph merge) | ~2373 ms | no — this *is* the work |
| INSERT fragment finalize + attribute copy | ~316 ms | no (still CPU) |
| entity-update queue pump + removal prefix | ~253 ms + remove pass | **partially** — an INSERT-only fast path still has to update the index |
| shared batch resolve | 8.8 ms | yes, and it is already 8.8 ms |
| frame presentation + upload | 181.4 + 11.7 ms | already GPU-side; not the block |

**Realistic saving on the 50k mixed fixture: under 10 ms of the 2822.7 ms window (< 0.4 %).**
On an INSERT-dominated drawing the picture changes completely — there a GPU translation would
remove most of `batchConvert` — but this phase's fixture is 60 % LINE and 20 % LWPOLYLINE by
design, and that is the acceptance fixture.

## 10. Fallback for unsupported cases

Any GPU path must be additive, not a replacement:

1. Matrix-carried, GPU-translatable → update matrix, defer index/bounds.
2. Everything else → the existing `applyEntityUpdates` wave, with the Phase 2.12 scheduler on.
3. Mixed selection → split the selection by capability, run both, and do **not** report ready
   until both settle (the readiness counters already support this: they are counts, not booleans).
4. Any transform other than translation → straight to (2).

---

## 11. Conclusion for the decision record

* The measured block is CPU geometry generation for **batched** geometry, and batching is what
  makes `renderables == 3` for 50,000 entities. A GPU translation cannot shorten work that exists
  because of batching; it can only help the minority of entities already modelled as
  template + matrix.
* On the Task E acceptance fixture that minority is 10 % of entities and **0.3 % of the conversion
  window**. Projected saving: **< 10 ms of 2822.7 ms**.
* The 11.7 ms of GPU upload and 181.4 ms of frame presentation are already outside the block.
* Therefore: **not a viable way to close the 147 ms residual, and not a substitute for the wave-prefix
  split** designed in [`PHASE212_CONVERSION_SCHEDULER_DESIGN.md`](./PHASE212_CONVERSION_SCHEDULER_DESIGN.md) §7.

If a GPU investment is still wanted, the target is a different one: **INSTANCE-dominated drawings**,
where the shared-batch template already exists. That should be measured on an INSERT-heavy fixture
before any implementation decision, and it is Phase 3 scope, not Phase 2.12.
