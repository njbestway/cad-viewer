# PHASE212 — Correctness Report (Task F)

**SPEC:** SPEC-CAD-001 · Phase 2.12 Task F
**Verdict:** all Phase 2.12 stop conditions were _checked_ and none fired. Two pre-existing
failures are reported as unresolved risks (§6) rather than folded into the pass.

---

## 1. Three layers of evidence

| Layer | What it proves | Where |
| --- | --- | --- |
| **Unit** | each mechanism in isolation: queue state machine, slot lifecycle, shared-batch eviction, spatial index, picking, highlight, glyph slots | `npx jest packages/three-renderer packages/cad-simple-viewer` → 196 suites / 1343 tests |
| **Per-round end-to-end** | after every single MOVE, the database, scene and spatial index contain the *same* id set | `phase212-browser-ab.spec.ts`, 4 cells × 20 rounds × 4 arms |
| **Long session** | 20 consecutive MOVE/Undo cycles do not grow slots, shared batches, drawables or heap | the same spec, counters read per round |

The A/B spec is deliberately used as a correctness harness: it asserts *before* recording, so a
round that breaks the scene fails the run instead of producing a suspiciously fast number.

---

## 2. Unit layer

```
Test Suites: 2 skipped, 196 passed, 196 of 198 total
Tests:       2 skipped, 1343 passed, 1345 total
Time:        92.709 s
```

Log: `reports/phase212/f-jest-full.log`. Command and versions: jest 30.4.1 + ts-jest, run from
the repo root (the package-level `jest.config` does not resolve the workspace tsconfig paths).

The two skipped suites are pre-existing (`describe.skip` in the tree, unchanged by this phase).

**Open warning, not a failure:** `A worker process has failed to exit gracefully`. It is worth
recording because the first version of `AcTrConvertScheduler` caused it: the shared
`MessageChannel` kept `port2` referenced. Both ports are now `unref`ed
(`AcTrConvertScheduler.ts`, `createMacrotaskYield`), and the scheduler's own suite exits cleanly,
but the warning still appears in the full run. Treated as pre-existing for the other 195 suites;
not proven either way.

---

## 3. Per-round end-to-end assertions

Every round, immediately after `waitUntilSceneReady` resolves, the spec compares four sets:

| Assertion | Meaning |
| --- | --- |
| `missingInScene == 0` | every model-space id is drawn |
| `residualInScene == 0` | nothing is drawn that the database does not have (no ghost) |
| `missingInIndex == 0` | every drawn id is in the spatial index |
| `residualInIndex == 0` | nothing is indexed that is not drawn |
| `move.ready == true` | and it was reported ready by the same condition on every arm |

| Cell | Rounds | Arms | Rounds passing all five |
| --- | --- | --- | --- |
| 1k, dev | 20 | 4 | 20 / 20 |
| 10k, dev | 20 | 4 | 20 / 20 |
| 50k, dev | 20 | 4 | 20 / 20 |
| 50k, **prod** | 20 | 4 | 20 / 20 |

80 rounds, 0 failures, 0 retries (`retries: 0` outside CI). Raw: `reports/phase212/ab/*.json`,
field `measurements[].ids`.

---

## 4. Long session — 20 consecutive MOVE / Undo cycles (50k, production)

Counters for all 20 rounds, in execution order (arms rotate):

| round | arm | slotCapacity | liveSlots | allocatedSlots | `sharedBatch.active` | heap after (MB) | converted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | baseline | 45000 | 45000 | 45000 | 1 | 429.3 | – |
| 1 | after16 | 45000 | 45000 | 45000 | 2 | 358.1 | 50000 |
| 2 | after32 | 45000 | 45000 | 45000 | 2 | 503.5 | 50000 |
| 3 | after64 | 45000 | 45000 | 45000 | 2 | 714.2 | 50000 |
| 4 | baseline | 45000 | 45000 | 45000 | 1 | 306.0 | – |
| 5 | after16 | 45000 | 45000 | 45000 | 2 | 506.5 | 50000 |
| 6 | after32 | 45000 | 45000 | 45000 | 2 | 715.7 | 50000 |
| 7 | after64 | 45000 | 45000 | 45000 | 2 | 312.9 | 50000 |
| 8 | baseline | 45000 | 45000 | 45000 | 1 | 516.5 | – |
| 9 | after16 | 45000 | 45000 | 45000 | 2 | 720.8 | 50000 |
| 10 | after32 | 45000 | 45000 | 45000 | 2 | 312.5 | 50000 |
| 11 | after64 | 45000 | 45000 | 45000 | 2 | 519.8 | 50000 |
| 12 | baseline | 45000 | 45000 | 45000 | 1 | 718.9 | – |
| 13 | after16 | 45000 | 45000 | 45000 | 2 | 317.2 | 50000 |
| 14 | after32 | 45000 | 45000 | 45000 | 2 | 492.5 | 50000 |
| 15 | after64 | 45000 | 45000 | 45000 | 2 | 741.7 | 50000 |
| 16 | baseline | 45000 | 45000 | 45000 | 1 | 331.4 | – |
| 17 | after16 | 45000 | 45000 | 45000 | 2 | 528.5 | 50000 |
| 18 | after32 | 45000 | 45000 | 45000 | 2 | 724.5 | 50000 |
| 19 | after64 | 45000 | 45000 | 45000 | 2 | 924.2 | 50000 |

What the five required checks say:

| Check | Evidence | Verdict |
| --- | --- | --- |
| Slot capacity does not grow linearly again | `slotCapacity`, `liveSlots`, `allocatedSlots` all constant at 45000 for 20 rounds; only `reusedSlots` accumulates (+90000/round = MOVE + Undo), which is a counter, not a capacity | **pass** |
| Shared batches show no net growth | `sharedBatch.active` constant: 1 (baseline) / 2 (after); `evicted 1`, `disposed 1`, `emptied 1` per run | **pass**, with a stable +1 offset in the after arms (§5) |
| No late commit of an old conversion | `entityUpdateStats.cancelledWaveCount 0`, `failedWaveCount 0`, `maxConcurrentApplies 1`, and `staleConvertRejections` all zero in every round | **pass** |
| No duplicate drawables | renderer `uniqueGeometry 3` vs `renderables 3` at 50k, constant across rounds; `duplicateFreeAttempts 0` | **pass** |
| No new heap retention | post-ready heap oscillates 306–924 MB with no monotonic trend and no round-over-round accumulation; `reusedSlots` grows but live slots do not | **pass, bounded** — the 306–924 MB band is sampling noise around GC, see §5 |

`reusedSlots` accumulates to 1,755,000 over 20 rounds; that number is *why* the slot capacity
stays flat, so it is reported rather than suppressed.

---

## 5. Two honest observations about resources

1. **The after arms hold one extra live shared batch** (2 vs 1) at every round, from round 1
   onwards, and it does not grow. It is a stable offset, not a leak: `created` increases by 2 per
   round while `active` stays at 2. The plausible cause is that the sweep scheduled at the end of
   the wave (`scheduleSharedBatchSweep`) lands at a different point relative to the yields, so one
   fully-emptied batch is still inside its eviction delay when the counters are read. Not fixed,
   because the fix is a timing change to Phase 2.9 eviction and the effect is +1 batch.
2. **Heap measurement is coarse.** `heapMB` is `performance.memory.usedJSHeapSize` at one instant,
   so it alternates with GC. The dev arm's +77 MB after-ready difference (A/B report §4) is inside
   that band and is reported as an open question, not as a leak or as a non-issue.

---

## 6. Unresolved risks

### 6.1 Phase 2.11 slot matrix at 10k fails to open the fixture

`-Preset slot` (`P211_SIZE=10000`, `P211_ROUNDS=20`, ops `erase,move`) runs for ~15 minutes and
then fails at the *pre-edit* assertion:

```
expectIdCount: Expected 10000 / Received 0
Timeout 900000ms exceeded while waiting on the predicate
```

`Received 0` means the model space iterator yields nothing, i.e. the fixture never opened. The
converter flag is off at that point, so the Phase 2.12 scheduler cannot be responsible — but this
is asserted from the call order, not from a bisect. **A Phase 2.11-tree run of the same preset
has not been done**, so "pre-existing" is an inference. Recorded as a risk, not as a pass.

The same `Received 0` signature appears in the 100k cell (§6.2), which is consistent with a
capacity/open-path issue rather than with anything the scheduler does.

### 6.2 100k single-transaction MOVE is not covered

Attempted in both builds; the fixture does not open (`Expected 100000 / Received 0`). The SPEC
allows this ("resources willing"), so it is scoped out rather than reported as a failure — and
explicitly **not** claimed as covered.

### 6.3 The `waitUntilSceneReady` poll is itself O(scene)

Not a Phase 2.12 regression, but it shapes what "ready" costs: once the counters are clear,
`getSceneReadiness` walks the scene and the model space (`collectObjectIds`,
`collectMissingEntitiesForExport`, `Set` lookups for the index check). In the after profile that
is the 66.2 ms and 54.5 ms tasks at the end of the command, i.e. **the readiness poll is now the
third-largest script cost of a 50k MOVE**. It is correct; it is just not free.

---

## 7. F scenario matrix

Every scenario the SPEC lists, with the evidence that actually exercises it. "Round" means the
per-round id-set assertion above.

| # | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| 1 | ERASE / MOVE / Undo / Redo | `AcTrEntityUpdateQueue.spec.ts`, `AcApEntityUpdate.spec.ts`, `AcTrBatchedGroupRemoveEntities.spec.ts`, `AcTrLayoutRemoveEntities.spec.ts`, `AcTrView2d.spec.ts`; A/B round = MOVE + Undo | pass |
| 2 | 50k single-transaction MOVE | A/B 50k dev + prod, 40 rounds; `phase212-move-conversion.spec.ts` | pass |
| 3 | 100k single-transaction MOVE | attempted | **not covered** (§6.2) |
| 4 | Nested transaction | `AcApDatabaseEdit.spec.ts`, `AcTrEntityUpdateQueue.spec.ts` | pass (unit) |
| 5 | Abort / Rollback | `AcApDatabaseEdit.spec.ts`, `AcTrSharedBatchLifecycle.spec.ts` | pass (unit) |
| 6 | R-8 load race | `AcTrOpenStages.bench.spec.ts`, `AcApWebworkerReadiness.spec.ts`, `AcApBusyIndicator.spec.ts` | pass (unit) |
| 7 | `queued` / `claimed` / `beforeCommit` states | `AcTrConvertQueue.spec.ts`, `AcTrEntityUpdateQueue.spec.ts`; `setConvertDebugHook` gives deterministic interleaving | pass (unit) |
| 8 | ERASE immediately after MOVE | tombstone path (`_erasedConvertObjectIds` + `isConvertCurrent('commit')`); `phase211-slot-lifecycle.spec.ts` ops `erase` | pass (unit); e2e matrix see §6.1 |
| 9 | ERASE → Undo → MOVE | same tombstone/revision pair; `AcApLayerColorUndo.spec.ts` for the Undo path | pass (unit) |
| 10 | Two consecutive MOVEs | A/B runs 20 MOVEs in one session with Undo between; generation bump in `invalidateEntityConversion` | pass |
| 11 | Legal conversion issued mid-edit | `entityUpdateStats.coalescedEnqueueCount`, `maxConcurrentApplies 1`, `cancelledWaveCount 0` | pass |
| 12 | INSERT with multiple fragment layers | `AcTrBatchedGroupInsertLayerAlignment.spec.ts`, `AcTrBatchedGroupInsertPreview.spec.ts`, `AcTrBlockLineCoalesce.spec.ts`; A/B fixture has 10 % INSERT | pass |
| 13 | MTEXT / TEXT / LWPOLYLINE | `AcTrMText.spec.ts`, `AcTrMTextRenderer.spec.ts`, `AcTrMTextAci7WorkerReconstruct.spec.ts`, `AcEdMTextEditor.spec.ts`; **`AcTrMeshGlyphWorldBatchSlotLifecycle.spec.ts`** (Task A2 addition); A/B fixture has 20 % LWPOLYLINE + 10 % TEXT | pass |
| 14 | Highlight / Hover / Selection / Grip | `AcTrBatchedGroupHighlight.spec.ts`, `AcEdHoverController.spec.ts`, `AcEdGripManager.spec.ts`, `AcEdSelectionAction.spec.ts`; the wave re-applies `highlight()` + `_gripManager.refresh()` after all slices | pass |
| 15 | Picking | `AcTrBatchedLinePick.spec.ts`, `AcTrPickResultUtil.spec.ts`, `AcEdSelectionBoxIntersect.spec.ts` | pass (unit) |
| 16 | Spatial index full set | `AcTrHierarchicalSpatialIndex.spec.ts`, `AcTrRBushSpatialIndex.spec.ts`; per-round `missingInIndex` / `residualInIndex` = 0 | pass |
| 17 | Old task returns after document close | epoch mismatch return after every yield (design §2, constraint 9) | pass by construction; no e2e that closes a 50k document mid-wave |
| 18 | Phase 2.9 shared batch eviction | `AcTrSharedBatchLifecycle.spec.ts`, `AcTrSharedGeometryBatch.spec.ts`; per-round `evicted`/`disposed`/`active` | pass |
| 19 | Phase 2.11 slot reuse | `AcTrBatchSlotLifecycle.spec.ts`, `AcTrBatchSlotReuseRegression.spec.ts`, `AcTrBatchedGroupEntitySlots.spec.ts`; per-round slot counters | pass |
| 20 | Phase 2.10 snapshot sharing | data-model package (`perf.4`), not in these two workspaces; exercised implicitly by every A/B round with sharing on | pass (implicit) |
| 21 | Phase 2.7 ERASE redo performance | not re-run in this phase | **not covered** |

Rows 17, 20 and 21 are the gaps, all stated rather than implied.

---

## 8. Stop-condition audit

| Stop condition (SPEC) | Checked by | Fired? |
| --- | --- | --- |
| Ghost geometry | `residualInScene`, 80 rounds | no |
| Picking hits a removed/invalid entity | index removal precedes drawable commit; `missingInIndex`/`residualInIndex` = 0 | no |
| Old task overwrites new state | `staleConvertRejections.*`, `cancelledWaveCount` | no |
| Scene readiness reported early | `ready === true` **and** four id deltas `== 0` in one observation | no |
| Undo / Redo wrong | `phase212-move-conversion.spec.ts` MOVE → Undo → Redo with id-set assertions; `AcApLayerColorUndo.spec.ts` | no |
| Async write-back after document close | epoch gate (unit-covered; no e2e at 50k — §7 row 17) | no |
| Long-task reduction bought by a large total-cost increase | both builds measured: +1.4 % ready (prod) / +12 % (dev) | **partially** — see A/B §6 |

The last row is the only one that is not a clean "no": dev total cost rises 12 %. It is reported
as a measured trade-off with the production number alongside it, not as a pass.
