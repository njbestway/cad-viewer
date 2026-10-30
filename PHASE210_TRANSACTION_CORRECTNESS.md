# PHASE210_TRANSACTION_CORRECTNESS — what must stay true

Phase 2.10 · Tasks A2 / C3 / D. Design: `PHASE210_SNAPSHOT_SHARING_DESIGN.md`.
Numbers: `PHASE210_PERFORMANCE_REPORT.md`.

---

## 1. The standard used here

"Correct" for this phase means three separate things, and none of them is
implied by the others:

1. **Scene readiness tells the truth.** `waitUntilSceneReady()` returning
   `ready:true` must mean the database, the scene and the spatial index agree,
   because every performance number in this phase is sampled after that call.
   A lying readiness gate would make the benchmarks measure the wrong instant.
2. **Undo/redo semantics are unchanged.** Same number of undo records per edit,
   same ordering of change entries, same restore result, including nested
   transactions and structural (append/remove) changes crossing a modify.
3. **The geometry that comes back is the geometry that left.** Not just "the
   test passed": entity id sets are compared before and after each round, and a
   transform is read back from the database to prove it landed.

## 2. Task A2 — scene readiness gates

`packages/cad-editor-demo/e2e/tests/phase210-scene-readiness.spec.ts`,
7 tests, **7 passed (1.1 m)** (`reports/phase210/a2-run.log`):

| Spec item | Test |
| --- | --- |
| `ready=true` ⇒ strictly compare DB / scene / index root id sets | `ready=true means the database, scene and index agree` |
| Inject a missing (claimed but undrawn) id ⇒ must not report ready | `a retained convert claim cannot hide a missing entity` |
| Inject extra / unmatched pending work ⇒ must not report ready | `unmatched pending work keeps readiness false` |
| Timeout must surface `ready=false` with a reason to the caller | `a timed-out wait reports ready=false with the blocking reason` |
| Deterministic pause for claimed-but-unfinished geometry | `releasing held work unblocks a wait in flight` |
| Document closed ⇒ late tasks from the old document cannot commit | `a document lifecycle reset drops the previous document claims` |
| per-entity material + batch eviction returns to baseline | `erasing returns shared batches to their baseline` |

Readiness is checked in three layers, and the order matters: layer 1 reads the
counters (`_numOfEntitiesToProcess`, `_pendingGeometryJobs`, `isProcessingEntities`),
layer 2 compares the database against the scene, layer 3 compares against the
spatial index roots. Layers 2 and 3 only run when layer 1 is clean, so their
results are never excused by "something is still in flight".

### The defect this task found

`getSceneReadiness()` used `isEntityConvertScheduled(objectId)` as layer 2's
coverage predicate. That predicate also accepts a **retained convert claim**, and
claims are deliberately kept after a successful commit — they are the "already
handled" marker that export deduplication depends on. So a stale claim made a
missing entity look covered.

Found by a throwaway probe, then reproduced as a permanent test:

1. load 120 entities, `ready:true`, `claimedCount = 120`, `claimedNotInScene = 0`;
2. remove one entity from the scene layer only (the database still has it);
3. before the fix: readiness **still** `ready:true` although `sceneObjectIds` was
   119 — the claim masked the gap;
4. after the fix: `ready:false`, `reasons: ["not-in-scene:1"]`,
   `missingFromScene: ["1F"]`; re-adding the claim does not mask it again.

The fix is one predicate in
`packages/cad-simple-viewer/src/view/AcTrView2d.ts` (diff:
`reports/phase210/cadviewer-phase210-source.diff`):

```ts
-        objectId => this.isEntityConvertScheduled(objectId),
+        objectId => this.hasEntity(objectId),
```

`ensureEntitiesConvertedForExport()` keeps using `isEntityConvertScheduled` —
export deduplication genuinely wants the claim. Only the readiness gate is
strict, because it is the one that claims "everything is on screen".

**Scope note.** This is inside the readiness gate, not inside the transaction
kernel, which is what the spec required ("must not widen the transaction kernel
change because of these supplements"). No line in `realdwg-web` was touched for
Task A2.

## 3. Task C3 — nested transactions

Seven scenarios in `AcDbTransactionSnapshotSharing.spec.ts`
(`C3 nested transactions`), all green. They exist because a child commit merges
its recorder into the parent, which is the only place a shared `before` snapshot
could acquire a second owner:

| # | Scenario | What it proves |
| --- | --- | --- |
| 1 | child modify → child commit keeps the parent before state | merge does not overwrite the parent's `before` |
| 2 | child abort restores its own starting state | a child abort cannot roll back to the parent's snapshot |
| 3 | child writes first, parent writes afterwards | the second writer still gets its own before state |
| 4 | same id written on three levels keeps the outermost before state | depth 3 does not drift |
| 5 | child commit then parent abort rolls everything back | parent abort restores the pre-child state |
| 6 | different entities on different levels | no aliasing between ids |
| 7 | append + remove + modify mixed across levels | structural changes merge in order |

Scenario 4 is the one that would break under a naive "share the first snapshot
you see" implementation: the innermost `before` is the one that must lose.

## 4. Task D — the 20 regressions

`AcDbTransactionSnapshotSharingRegression.spec.ts`, 20 tests, all green. Mapped
to the spec's numbered items:

| # | Item | Test |
| --- | --- | --- |
| 1 | single entity commit/undo/redo round-trip | `round-trips one entity through commit, undo and redo` |
| 2 | repeated transforms of one entity = one undo step | `treats repeated transforms of one entity as a single undo step` |
| 3 | multi-entity transaction restores all | `restores every entity modified in one transaction` |
| 4 | append then modify | `handles append then modify` |
| 5 | modify then remove | `handles modify then remove` |
| 6 | remove then append of a different entity | `handles remove then append of a different entity` |
| 7 | remove and re-append of the same id collapses | `collapses a remove and re-append of the same id` |
| 8 | append + removal of the same id cancels out | `cancels out a structural append and removal of the same id` |
| 9 | (item 6–9 group) structural/modify interleaving order | covered by items 4–8 |
| 10 | nested child commit merges into the parent undo step | `merges a committed child into the parent undo step` |
| 11 | nested child abort leaves the parent intact | `discards a child abort without disturbing the parent` |
| 12 | caller throws ⇒ every entity rolls back | `rolls every entity back when the caller throws` |
| 13 | new edit after undo clears redo | `clears the redo stack when a new edit follows an undo` |
| 14 | five undo/redo rounds stay exact | `stays exact across five undo / redo rounds` |
| 15 | history exhaustion drops the oldest records | `drops the oldest records when the history is exhausted` |
| 16 | clearing the history releases every retained snapshot | `releases every retained snapshot when the history is cleared` |
| 17 | LINE / LWPOLYLINE / INSERT / TEXT / MTEXT round-trip | `round-trips LINE / LWPOLYLINE / INSERT / TEXT / MTEXT` |
| 18 | locked layer keeps its flag and its entity state | `keeps the locked flag and the entity state it guards` |
| 19 | entity inside a block definition round-trips | `round-trips an entity inside a block definition` |
| 20 | Phase 2.7 batch erase redo (2k batch) | `restores and re-erases a 2k batch with identical geometry` |

Item 20 also runs the geometry equivalence check the spec asks for: the same
2000-entity batch is erased, undone, redone, and the second erase is compared
against the first by id set, proving a bulk redo does not resample geometry.

Plus one test that is not an item but is the whole premise of the design:
`never mutates the shared before snapshot` — after a commit, abort and undo, the
object reachable from `originalStates` and from `change.before` is the *same*
object and its fields are unchanged.

**Suite totals:** 3 suites / 41 tests / 10.5 s
(`d-regression-run.log`), and the full data-model package is
133 suites / 1100 tests / 48 s with 1 skipped (`d-full-data-model-suite.log`).

## 5. The undo boundary is unchanged, in the browser

The unit tests prove the kernel's contract; the browser A/B proves it survives
the real editor path. In every sample of `phase210-browser-ab.spec.ts` — 1k,
10k, 50k entities, dev and prod, sharing off and on — one MOVE produces:

| Assertion | Off arm | On arm |
| --- | --- | --- |
| `undoRecords` after the edit | 1 | 1 |
| `redoRecords` after the edit | 0 | 0 |
| `undoRecords` after undo | 0 | 0 |
| `redoRecords` after undo | 1 | 1 |

44 runs (2 build modes × 3 sizes, 3 or 5 interleaved samples each, 2 arms),
no exception. A single MOVE is still one undo step.

## 6. Geometry equivalence

Two independent checks, both in the A2 / E3 harnesses:

1. **Id sets.** After `waitUntilSceneReady()`, the database id set, the union of
   `layout.collectObjectIds()` over every layout and the flattened spatial index
   id set are compared. A count match without an id match would not pass.
2. **Transform landing.** Each A/B sample reads `startPoint.x` back from the
   database after the MOVE and asserts it moved by `dx`; the undo sample asserts
   it returns to the original value.

## 7. What is still not proven

Honest limits of this round:

- The A2 readiness gate is verified in the **demo** editor path, not against a
  pathological document (very large block references, proxy entities). The
  three-layer check is sound, but the coverage of layer 2/3 cost at 100k entities
  is not measured.
- `entmake`-style programmatic edits that never call `openObject` bypass
  `captureOriginalState`, so they keep the old two-clone behaviour. That is
  correct (they never shared), but it means the clone reduction is bounded by
  the share of edits that go through the transaction, not by "all edits".
- Nested transactions are proven to depth 3. Nothing in the code suggests a
  depth limit, but depth 4+ is untested.
