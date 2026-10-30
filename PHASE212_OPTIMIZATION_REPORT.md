# PHASE212 — Optimization Report (Task D prototype)

**SPEC:** SPEC-CAD-001 · Phase 2.12 Task D
**Design:** [`PHASE212_CONVERSION_SCHEDULER_DESIGN.md`](./PHASE212_CONVERSION_SCHEDULER_DESIGN.md)
**Profile input:** [`PHASE212_MOVE_CONVERSION_AUDIT.md`](./PHASE212_MOVE_CONVERSION_AUDIT.md)

---

## 1. What was implemented

One file, one field, four public methods, one loop. Nothing else in the hot path changed.

### 1.1 `packages/cad-simple-viewer/src/view/AcTrConvertScheduler.ts` (new)

```ts
export interface AcTrConvertSchedulerOptions { enabled: boolean; budgetMs: number }

export const ACTR_CONVERT_SCHEDULER_DEFAULT: AcTrConvertSchedulerOptions = {
  enabled: false,   // off by default
  budgetMs: 16
}
```

| Member | Purpose |
| --- | --- |
| `configure(options)` | per-view arm switch; `{enabled, budgetMs}` |
| `resetStats()` | zero the counters without touching the schedule |
| `beginWave(now)` / `endWave(now)` | wave boundary; records `lastWaveMs` |
| `maybeYield(now)` | returns `true` **only if** it actually left the task and the epoch is still current |
| `recordSlice(ms, count)` | per-slice cost, `maxSliceMs`, `entities` |
| `stats` | `waves / slices / entities / yields / maxSliceMs / maxTaskMs / lastTaskMs / lastWaveMs / yieldPrimitive` |

The yield primitive is chosen once, in this order:

1. `scheduler.yield()` — continuation is prioritised by the browser; **used on the test machine**
   (`yieldPrimitive: "scheduler.yield"` in every recorded run).
2. `MessageChannel` — one shared channel for the page; **both ports are `unref`ed** so a Jest
   worker or a Node process can still exit (an un-unref'd `port2` was the cause of the
   "worker process has failed to exit gracefully" warning seen mid-task).
3. `setTimeout(0)` — last resort only, because Chromium clamps nested timers to ~4 ms after five
   levels (~390 ms over 98 slices).

`maybeYield` measures from `_lastResumeMs`, i.e. from **when the previous yield returned**, not
from when it was requested. That is what makes a budget meaningful: the clock does not pay for
time the browser spent on someone else's work.

### 1.2 `packages/cad-simple-viewer/src/view/AcTrView2d.ts` (modified)

The slice loop in `applyEntityUpdates` now owns the yield:

```ts
const sliceSize = Math.max(1, this._latencyExperiment.convertSliceMax)
const scheduler = this._convertScheduler
scheduler.beginWave(performance.now())
for (let offset = 0; offset < convertible.length; offset += sliceSize) {
  if (epoch !== this._convertEpoch) return
  // The slice loop owns the slices, so it must own the yield too: `await`
  // on `batchConvert` resumes in a microtask and leaves the task open for
  // the whole wave (98 slices, 2834 ms in the 50k profile).
  if (await scheduler.maybeYield(performance.now())) {
    if (epoch !== this._convertEpoch) return
  }
  const count = Math.min(sliceSize, convertible.length - offset)
  const sliceStarted = performance.now()
  await this.batchConvert(convertible.slice(offset, offset + sliceSize))
  scheduler.recordSlice(performance.now() - sliceStarted, count)
}
scheduler.endWave(performance.now())
```

Three details matter more than the shape:

* **The epoch is re-checked after the yield.** A document close or a second MOVE between two
  slices must abort the wave, and that check now happens at 98 places instead of one.
* **The inner 300 ms gate is left alone.** `batchConvert` still builds its own
  `AcCmUiYieldGate`; it never fires because a slice is 26 ms. Removing it would be a separate
  change with its own risk (it also guards the open-time drain); leaving it means the only new
  scheduling decision is the one this task is about.
* **The counters are diagnostics only.** Nothing downstream reads `stats`; a disabled scheduler
  reports all zeroes, so a baseline run cannot be mistaken for an after run.

New public surface on the view: `convertSchedulerOptions`, `setConvertScheduler()`,
`getConversionSchedulerMetrics()`, `resetConversionSchedulerMetrics()`.

### 1.3 Feature flag and fallback

* **Flag:** `view.setConvertScheduler({ enabled, budgetMs })`. Default
  `ACTR_CONVERT_SCHEDULER_DEFAULT = { enabled: false, budgetMs: 16 }`.
* **Fallback:** the untouched original path. With `enabled: false` the loop is
  `for … { if (epoch…) return; await batchConvert(slice) }` — byte-for-byte the Phase 2.11
  behaviour, still 98 slices, still one task. Every A/B arm in Task E runs the same bundle and
  switches only this flag, so the comparison cannot be confounded by a build difference.
* **Instant rollback:** ship with the default (off). No second code path to delete.

---

## 2. The five Task D priorities, honestly

Task D lists five priorities. The profile decided which of them were worth doing, and four of
them were *not* done. The reason for each:

| # | Priority | Status | Evidence / reason |
| --- | --- | --- | --- |
| 1 | Avoid processing too many entities in one `batchConvert` call | **Already satisfied** (512 per call since Phase 2.11), and the *loop* was the problem, not the slice size | 98 calls, slice 26 ms median / 55 ms max — the slice is not too big; the task was |
| 2 | Identify and split a single over-long synchronous step | **Identified, not split** | The 261.8 ms wave prefix (removal + index + generation) is the residual; its split is designed in the scheduler document §7 and deferred with a stated reason |
| 3 | Reduce provably redundant drawable construction | **Not done — no evidence of redundancy** | `entityUpdateStats.maxConcurrentApplies: 1`, `cancelledWaveCount: 0`, renderer `uniqueGeometry 3` / `renderables 3` on 50k entities. There is no second construction to remove |
| 4 | Reuse existing geometry where correctness allows | **Already present** (shared batch templates + slot reuse), not extended in 2.12 | `sharedBatch.created 2 / reused 9998`, `slotLifecycle.reusedSlots 45000`, `deleteGeometryCalls 45000` with `deleteGeometrySkipped 0` |
| 5 | Reduce repeated attribute copy in batch containers | **Measured, not changed** | Attribute copy is 158 ms self (baseline) / 201 ms (after) inside the conversion. Changing it means changing how `AcTrBatchedGeometryInfo` stores attributes, i.e. the batch container format — outside a "restricted prototype" and outside the SPEC's prohibitions only by letter, not by intent |

The single change that was implemented is therefore priority 1+2's *prerequisite*: make the
existing slices interruptible. That is what the profile pointed at.

**Attribute copy note.** It is the largest single self-time item after glyph merge (158 / 201 ms
of a 2823 / 3487 ms window, i.e. 5.6 %). It is a candidate for Phase 3, not for this phase: it
would need a container-format change, and the measured ceiling is 5.6 % of the conversion, not
the main thread block.

---

## 3. Measured effect

All numbers below are medians over interleaved rounds of the **same bundle**, switching only the
flag. Full tables, hardware, and the per-arm spread are in
[`PHASE212_BROWSER_AB_REPORT.md`](./PHASE212_BROWSER_AB_REPORT.md).

### 3.1 Longest conversion task (the metric this phase exists for)

| Fixture | Build | Baseline | After 16 ms | After 32 ms | After 64 ms |
| --- | --- | --- | --- | --- | --- |
| 1k MOVE | dev | 0 (45 ms max) | 0 | 0 | 0 |
| 10k MOVE | dev | **417 ms** | **0** | 62 ms | 96 ms |
| 50k MOVE | dev | **2149 ms** | **160 ms** | 174 ms | 209 ms |
| 50k MOVE | **prod** | **2200 ms** | **147 ms** | 171 ms | 211 ms |

50k is the acceptance scale: **2149 → 160 ms (dev, −92.6 %)** and **2200 → 147 ms (prod,
−93.3 %)**. The SPEC's first target (<200 ms) is met on both builds and at every budget
measured. The second target (<100 ms) is **not** met; the reason and the remaining call stack
are §7 of the design document and §5 below.

### 3.2 What it costs

| Metric | Baseline (prod) | After 16 ms (prod) | Delta |
| --- | --- | --- | --- |
| synchronous DB commit | 1123.3 ms | 1054.3 ms | −6.1 % (noise; the flag cannot touch it) |
| `waitUntilSceneReady` | 3639.8 ms | 3691.2 ms | **+1.4 %** |
| frame p95 | — | — | 2349.9 → 1200.0 ms (worst case halved) |
| heap after ready | 429.3 MB | 506.5 MB | +77 MB (see §4) |

Dev shows a larger total-cost increase (+12 % ready, +8 % conversion wall). That is the
warm-cache/locality price of an interruptible wave, and it is bounded — the SPEC's condition
("must not let total scene update time grow unacceptably") is discussed against both builds in
the A/B report §6.

### 3.3 After-profile: where the 2.8 s task went

| | Baseline | After (16 ms) |
| --- | --- | --- |
| conversion `RunTask` | 1 task × 2834.1 ms | 98 fragments, longest **261.8 ms** |
| `RunTask` count in trace | 188 | 389 |
| max event-loop gap | 17.3 ms | 16.3 ms |
| conversion window (same rule, both arms) | 2822.7 ms / 838 tasks | 3487.4 ms / 1358 tasks |
| frame p95 (profile run) | 1283 ms | 150 ms |

The window definition is "union of `RunTask`s containing a `batchConvert` sample", chosen because
it behaves the same before and after scheduling. Reproduce with:

```
node tools/phase212-profile-analyze.mjs move50000 move50000-after
```

Raw output: `reports/phase212/b-analyze-check.txt`, `reports/phase212/b-analyze-after.txt`.

---

## 4. Resource behaviour

The scheduler allocates nothing per yield: no promises beyond the ones the yield primitive
creates, no timers when `scheduler.yield()` is available, and one shared `MessageChannel` for the
whole page in the fallback path.

* **Slot capacity** unchanged and non-growing across rounds: 45000 / 45000 at 50k,
  `reusedSlots 45000`, `duplicateFreeAttempts 0`.
* **Shared batches** unchanged: `activeBatches 1`, `evicted 1`, `disposed 1`, no net growth.
* **Heap** is the one metric that moved: +77 MB after ready in the production arm. It is not a
  leak — the 20-round series in the A/B report shows no monotonic trend — but the after arm holds
  more live objects at the moment `ready` is reported. The plausible cause is that yields let the
  browser run other work (and GC) at different points relative to the conversion, so the peak and
  the post-GC reading decouple. Recorded as an open question, not as a resolved one.

---

## 5. The residual, stated for the record

After the prototype the longest conversion task is **147–176 ms** (production) / **261.8 ms**
(dev profile). It is the wave *prefix*: unwrapping 50,000 entities out of the scene and the
spatial index before the first slice can run. Its composition is measured in the audit (§7 of the
design document) and its split is designed but not implemented, deliberately, because:

* it changes the ordering guarantees a spatial-index or highlight query can observe,
* it is a ~7 % win against the whole wave,
* and the SPEC asks for the irreducible call stack to be *reported* when 100 ms is not reachable.

**Irreducible stack, bottom-up (dev, 50k):**

```text
applyEntityUpdates                        (wave prefix, 261.8 ms task)
├─ dedupe / classify loop           ~55 ms   2 × 50,000 iterations
├─ _scene.removeEntities(50k)       ~90 ms   one compaction per container, by design
│   ├─ AcTrBatchedGroup.removeEntities
│   ├─ AcTrLayout / AcTrScene / AcTrLayer.removeEntities
│   ├─ forEachEntitySlot
│   └─ rbush.remove / removeByIds / _condense
├─ generation bump loop             ~30 ms   50,000 × Map.set + Map.delete
└─ first convert slice (512)        ~28 ms   atomic by design
```

Getting below this needs one of: (a) chunked removal with a wave-in-progress marker (designed,
§7), (b) an incremental spatial index rebuild, or (c) not removing the drawables at all — which is
the GPU translation question, answered in
[`PHASE212_GPU_FASTPATH_FEASIBILITY.md`](./PHASE212_GPU_FASTPATH_FEASIBILITY.md).

---

## 6. Prohibitions, checked

| Prohibition | Status |
| --- | --- |
| No new Undo record format | none touched |
| No GPU buffer translate | none touched; 2.3 ms `gpuBufferUpdate` self time is the pre-existing upload path |
| No Worker / Wry / Rust migration | none |
| Original synchronous path preserved as fallback | flag off = Phase 2.11 behaviour exactly |
| `ObjectId` / `Handle` / `OwnerId` unchanged | unchanged |

---

## 7. Files touched

| File | Change |
| --- | --- |
| `packages/cad-simple-viewer/src/view/AcTrConvertScheduler.ts` | new, 231 lines |
| `packages/cad-simple-viewer/src/view/index.ts` | one export line |
| `packages/cad-simple-viewer/src/view/AcTrView2d.ts` | import, field, 4 getters/setters, 9 lines in the slice loop |
| `packages/cad-simple-viewer/__tests__/AcTrConvertScheduler.spec.ts` | new, 6 cases |
| `packages/cad-editor-demo/e2e/tests/phase212-browser-ab.spec.ts` | new, 20-round interleaved A/B |
| `packages/cad-editor-demo/e2e/tests/phase212-move-conversion.spec.ts` | `P212_SCHED` / `P212_SCHED_BUDGET` arms |
| `packages/cad-editor-demo/e2e/helpers/run-phase212.ps1` | `-Serve prod`, `-Budgets`, `-Rounds` |
| `packages/cad-editor-demo/playwright.config.ts` | `P212_SERVE=prod` → `vite preview` |
| `tools/phase212-profile-analyze.mjs` | new; the Task B attributor, now reproducible |
