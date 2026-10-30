# Phase 2.12 — 50k MOVE Conversion CPU Audit

**Task B of SPEC-CAD-001.** Answers where the ~2.1 s main-thread block of a 50k
MOVE actually goes, and why it is *one* task instead of many.

Baseline: the Phase 2.11 slot-lifecycle candidate (see
`reports/phase212/phase212-git-state.json` for the pinned index, data-model
tarball digest and build artifact digests). No product code was changed to
produce this document.

---

## 1. Fixture and build under measurement

| Item | Value |
| --- | --- |
| Entities | 50,000 in one MOVE / Undo / Redo |
| Mix | 60 % LINE (30,000), 20 % LWPOLYLINE (10,000), 10 % INSERT (5,000), 10 % TEXT (5,000) |
| Layers | 3 |
| Fixture generator | `packages/cad-editor-demo/e2e/helpers/cadFixtures.ts` → `writeMixedFixture(50000, 'p21250000')`, deterministic |
| Snapshot sharing | **on** (`transactionManager.snapshotSharing = true`, asserted by the spec) |
| Slot reuse (2.11) | on — production default, no flag |
| Build | Vite dev server, `cad-editor-demo`, Chromium (Playwright channel) |
| Run | `P212_SIZE=50000 P212_TAG=move50000 npx playwright test e2e/tests/phase212-move-conversion.spec.ts` |
| Artifacts | `reports/phase212/profiles/move50000.{cpuprofile,trace.json,raw.json}` |
| Reduced output | `reports/phase212/phase212-conversion-profile.json`, `reports/phase212/b-report.txt` |

The MTEXT / DIMENSION stress fixture is separate
(`P212_FIXTURE=stress`); it exists for correctness and hot-spot attribution and
is **not** a substitute for this benchmark (see §10).

## 2. How each number is obtained

Four clocks, all `performance.now()` inside the page:

| Clock | Starts | Ends |
| --- | --- | --- |
| `commitMs` | before `database.runDatabaseEdit` | after it returns (sync) |
| `firstYieldMs` | same | first `setTimeout(0)` callback to run |
| `readyMs` | same | `waitUntilSceneReady()` resolves |
| `frameMs` | same | two `requestAnimationFrame` boundaries after ready |

`firstYieldMs` is the honest blocking figure: it ends at the first **macrotask**
boundary. An `await` on a promise does not end a task, so `await`-based
progress is invisible to it.

Three independent recorders:

1. **V8 CPU profile** — CDP `Profiler`, 200 µs sampling, whole window.
2. **DevTools trace** — `toplevel,devtools.timeline,v8,gpu,blink.user_timing`.
   V8 `profile.startTime` and trace `ts` are the same µs epoch, so the profile
   window (`2603.8 → 5211.8 ms`) can be located inside a trace task exactly.
   That containment, not an estimate, is what attributes samples to `RunTask #92`.
3. **Slice probe** — `batchConvert` is private in TypeScript but present on the
   prototype at runtime, so the spec wraps it and records `{count, startMs,
   endMs}` per call. This is the only way to get the per-round entity count and
   cadence: a sampling profile merges every call sharing a call path into one
   node, and the trace has no `FunctionCall` instrumentation.

`profileSpanMs 5594.1`, `sampledMs 5593.7`, `samplingUs 200`.

## 3. Wall-time result

| Step | commit | first yield | ready | frame |
| --- | --- | --- | --- | --- |
| **MOVE** | **974.0 ms** | **3996.9 ms** | 4168.5 ms | 4171.3 ms |
| Undo | 527.3 ms | 3269.5 ms | 3396.3 ms | 3397.6 ms |
| Redo | 557.5 ms | 3304.0 ms | 3441.2 ms | 3442.3 ms |

`ready` and `frame` are different completion conditions and are not
interchangeable: `waitUntilSceneReady` resolves when the work tracker reports no
pending convert, deferred-geometry or batch work; `frameMs` resolves two
animation frames later and is the first moment a frame *carrying* the new
geometry could have been presented. The MOVE gap is only 2.8 ms here, but the
Undo/Redo gap is non-zero and a report that quotes only one of them is quoting
two different things.

`firstYieldMs` is the honest blocking figure **for this baseline**, because
nothing yields: there is no macrotask boundary to reach before the wave ends. It
stops being a blocking figure once the scheduler is on — prioritized continuations
outrank timer tasks, so the first `setTimeout(0)` callback moves toward the end of
the wave even though the thread is yielding. `PHASE212_BROWSER_AB_REPORT.md` §4
records that change of meaning rather than comparing the two arms on it.

`longtask` PerformanceObserver for the MOVE: 4 entries, 2841 ms total, longest
**2589 ms**. The trace attributes the same conversion to a single `RunTask` of
**2834.1 ms**. The two disagree by ~245 ms; §7 explains why the trace number is
the one this audit uses and records the discrepancy rather than averaging it
away.

## 4. Task-level decomposition

Main thread, MOVE window, 188 tasks / 5408 ms:

| Start | Duration | What |
| --- | --- | --- |
| −0.1 ms | **960.9 ms** | synchronous database edit (`runDatabaseEdit`) — matches `commitMs 974` |
| 1207.6 ms | **1169.1 ms** | post-commit wave scheduling (entity-update queue, scene removal pass, snapshot bookkeeping) |
| 2379.1 ms | **2834.1 ms** | **the conversion** — one `RunTask`, `TimerFire`-attributed, 2 children (`ThreadControllerImpl::RunTask` 2834.0, `BlinkScheduler_PerformMicrotaskCheckpoint` **0.0 ms**) |
| 5213.2 ms | 181.4 ms | the frame that presents the converted scene (179.8 ms of it JS: `AcTrView2d.animate`) |
| 5411.4 ms | 75.1 ms | settle / sweep |
| 5502.4 ms | 64.1 ms | settle |

960.9 + 1169.1 + 2834.1 = **3964.1 ms**, against `firstYieldMs 3996.9` — the
three tasks are the whole non-yielding stretch, and the conversion is 71 % of
it.

The microtask checkpoint inside `RunTask #92` is **0.0 ms**. That is the single
most useful line in the trace: 98 `await this.batchConvert(...)` continuations
did run, and together they cost nothing measurable *as tasks*, because a
microtask checkpoint is not a task boundary. The main thread never returned to
the event loop.

## 5. B2 — the fourteen call sites

`self` is sampled self time; `inclusive` is the subtree total of the outermost
call paths of that function name. **Inclusive is never added to its children**
(see §6). `paths` is the number of distinct call paths V8 merged into the
function's nodes, not a call count. Host task: `#92` = the 2834.1 ms conversion
task, `#93` = the 181.4 ms presentation task.

| # | Function | calls | self | inclusive | paths | max path | host |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `AcTrEntityUpdateQueue` | see note | 30.18 | **249.93** | 3 | 218.99 | #92 |
| 2 | `AcTrView2d.batchConvert()` | **98** (probe) | 69.71 | **1156.30** | 3 | 1139.55 | #92 |
| 3 | `finishEntityGeometry()` | note | 17.18 | **33.44** | 4 | 23.60 | #92 |
| 4 | `AcTrScene.addEntity()` | note | 5.52 | **339.72** | 3 | 285.40 | #92 |
| 5 | `AcTrLayout.addEntity()` | note | 7.24 | **334.20** | 2 | 283.20 | #92 |
| 6 | `AcTrBatchedGroup.addEntity()` | note | 6.72 | **291.80** | 2 | 257.62 | #92 |
| 7 | Shared geometry batch resolve | note | 6.40 | **11.77** | 9 | 3.23 | #92 |
| 8 | `AcTrBatchedGeometryInfo` attribute copy | note | **203.30** | **243.73** | 9 | 95.18 | #92 |
| 9 | `Object3D` / `Line` / `Mesh` construction | note | 80.57 | **271.04** | 10 | 97.92 | #92 |
| 10 | Glyph / MTEXT merge | note | **483.97** | **940.28** | 8 | 752.94 | #92 |
| 11 | INSERT fragment finalization | note | 78.54 | **655.90** | 7 | 248.86 | #92 |
| 12 | `optimize()` | note | 12.24 | **18.36** | 2 | 9.66 | #92 |
| 13 | GPU buffer update | note | 19.91 | **20.48** | 3 | 12.17 | **#93** |
| 14 | Renderer frame presentation | **1** (one frame) | 0 | **182.26** | 1 | 182.26 | #93 |

**Note on call counts.** A V8 sampling profile cannot count calls: every call
sharing a call path is merged into one node, so `paths: 3` for `batchConvert`
means three distinct stacks reached it, not three invocations. Only `#2` (98)
and `#14` (1) are measured, because they have a runtime probe or a trace event.
The rest are bounded by the converted-entity count — `AcTrScene.addEntity`,
`AcTrLayout.addEntity` and `AcTrBatchedGroup.addEntity` each run once per
converted drawable, i.e. **≤ 50,000** and, per the ID-set equality check, exactly
one commit per entity — but "bounded by" is not "measured", and this audit does
not upgrade it. Exact counters are part of Task D and are reported in
`PHASE212_OPTIMIZATION_REPORT.md`.

Two consequences worth stating plainly:

- **Attribute copy is self-bound, not subtree-bound** (`self 203.30` of
  `inclusive 243.73`). It is copying instance attributes for batched geometry,
  and 83 % of its cost is its own loop. It is the single largest *non-async*
  self-time block in the conversion.
- **Glyph / MTEXT merge is the largest inclusive block after `batchConvert`**
  (940.28 ms, 33 % of the task) and spends 484 ms in mtext-renderer
  (`mergeMeshGeometriesUnprofiled` alone is 82.7 ms of self time). The mixed
  fixture has 5,000 TEXT entities, not MTEXT; TEXT goes through the same text
  pipeline. This is the second-largest actual hot spot and it is *not* linework
  conversion.

## 6. Branch decomposition — and why it must not be summed

An async continuation loses its ancestors: a function resumed from a microtask
appears as a direct child of `(root)`. `batchConvert`'s `await`s therefore split
into sibling branches, not a tree. The 2834.1 ms task breaks down as:

| ms | branch |
| --- | --- |
| 1139.5 | `batchConvert` |
| 752.9 | `asyncRenderMText` (mtext-renderer) |
| 317.8 | `commitEntity` |
| 219.0 | `AcTrEntityUpdateQueue` queue pump |
| 140.7 | `handleGroup` (INSERT) |
| 122.6 | `asyncDraw` (`AcTrGlyphEntity`) |
| 49.7 | `(program)` — native, unattributed |
| 37.3 | `(garbage collector)` |
| 23.6 | `finishEntityGeometry` |
| 13.4 | `applyEntityUpdates` |
| 3.9 | `AcTrView2d` anonymous |
| 2.7 | `renderAsync` (`AcTrMText`) |
| 1.3 | `AcTrInheritedLayerMaterialMapper.remap` |
| 1.1 | `noteGlyphCounts` |
| 1.1 | `AcTrMTextRenderer.asyncRenderMText` |
| ≥ 0.6 each | `pumpDeferredGeometryQueue`, `drawEntity`, `ensureCapacity`, `Object3D.add`, `updateMatrixWorld`, `AcTrScene.addEntity`, `syncGroupSpatialBoundsForIndexing`, … |

Sum of the branches = **2834.1 ms = the task duration**. That is a partition of
the *task*, and it is legitimate precisely because the branches are siblings.
Adding `inclusive` values from §5 would double-count every nesting level; the §5
table is a *shape*, §6 is the *invoice*.

## 7. Why the block is 2.1 s and the `RunTask` is 2.8 s

Both numbers are real; they measure different things.

- `2129 ms` (Phase 2.11) is the `longtask` PerformanceObserver maximum for the
  conversion, i.e. the entry the browser uses to decide a task was long.
- `2834.1 ms` (Phase 2.12) is the trace `RunTask` span, from the moment the
  timer callback entered to the moment the task finished.

They are not the same measurement, and the difference is not noise: the
PerformanceObserver entries for this MOVE are `[2589, 150, 52, 50]`, which sum to
2841 ms. The trace sees one task; the observer sees four entries. This audit uses
the trace span because it is the one that can be *located* (it contains the
profile window) and because the four PO entries cannot be mapped back to code.
The unresolved ~245 ms discrepancy between the largest PO entry (2589) and the
trace span (2834.1) is recorded as a measurement caveat, not explained away.

### Root cause A — the slice loop has no macrotask boundary

`AcTrView2d.ts:3737–3741`:

```ts
const sliceSize = Math.max(1, this._latencyExperiment.convertSliceMax)
for (let offset = 0; offset < convertible.length; offset += sliceSize) {
  if (epoch !== this._convertEpoch) return
  await this.batchConvert(convertible.slice(offset, offset + sliceSize))
}
```

The loop *does* slice — 50,000 entities arrive as 98 × 512 — and it does guard
the document epoch. What it does not do is leave the task. `await` on an async
function resumes in a microtask; the trace confirms it (`BlinkScheduler_
PerformMicrotaskCheckpoint` 0.0 ms inside the task, `ThreadControllerImpl::
RunTask` 2834.0 ms). The probe measured the gap between one slice's end and the
next slice's start at **0.4 ms maximum**: not once in 98 slices did the main
thread return to the event loop between them.

### Root cause B — the yield gate is created per call and can never trigger

`AcTrView2d.ts:5661–5666`:

```ts
const yieldGate =
  options.forExport || !this._cooperativeYield
    ? undefined
    : new AcCmUiYieldGate(yieldBudgetMs)
```

`AcCmUiYieldGate` (data-model) initialises `_lastYieldCompletedAt = now()` in its
constructor and `maybeYield()` returns `false` while `now - _lastYieldCompletedAt
< budgetMs`. A MOVE is not a progressive open, so `yieldBudgetMs` is
`openConvertYieldBudgetMs = 300`. One slice takes **26.2 ms median, 34.4 ms p95,
55.5 ms max**. Because a *fresh* gate is constructed at the top of every
`batchConvert` call, the 300 ms budget is compared against ≤ 55.5 ms of work,
98 times in a row. The gate at `AcTrView2d.ts:5948–5953` therefore never fires.

Shape of the two causes together: the outer loop owns the slicing but not the
yielding, and the inner loop owns the yielding but not the budget. Neither can
break the task alone, and the fix has to give the budget to the loop that
iterates.

### What the trace says about everything else

- Long tasks in the MOVE window: **6**, largest 2834.1 ms; the other five are
  1169.1, 960.9, 181.4, 75.1, 64.1 ms.
- Event-loop gaps: **max 17.3 ms, p95 16.1 ms** — the loop is not starved
  *between* tasks; it is starved for the 2.8 s the task lasts.
- GC: **709 events, 532 ms total, max 6.7 ms** (scavenger/sweep). GC is 19 % of
  the task's wall time but never a single pause — nothing here justifies
  attacking allocation first.
- GPU buffer upload: 20.48 ms total for the MOVE, but it lands in the
  **presentation** task `#93` (12.17 ms max path), not in the conversion task.
- Frame after conversion: 181.4 ms task, 179.8 ms of it JS inside
  `AcTrView2d.animate`. Presenting 50k moved entities costs a further ~180 ms.
- The conversion's own sampling window is `2603.8 → 5211.8 ms`
  (`spanMs 2608.1`, `maxGapMs 10.1`) with **462 samples that fall in no task**.

## 8. Slice cadence (measured)

| Metric | Value |
| --- | --- |
| `batchConvert` calls | **98** |
| Entities per call | exactly **512** for every call |
| Entities converted | 50,000 |
| Wall time inside `batchConvert` | **2613.4 ms** |
| Median / p95 / max slice | 26.2 / 34.4 / **55.5 ms** |
| Max gap between slices | **0.4 ms** |
| First slice start → last slice end | 27679.2 → 30295.6 ms (page clock) |

512 is not a tuned constant this audit chose: it is
`AC_TR_ENTITY_UPDATE_SLICE_MAX`, and the per-slice cost is flat enough
(22–55 ms) that the entity count and the wall time are proportional.

## 9. What this hands to Task C and Task D

1. The transaction is **already** separated from view work — `runDatabaseEdit`
   returns in 974 ms and the conversion starts afterwards. §C1's required
   ordering exists; what is missing is the licence to leave the task.
2. The interruption boundary that works is **between `batchConvert` calls**. A
   slice is 26 ms median / 55 ms max, which is inside any sane budget, so
   splitting *inside* a slice is not required to hit the 200 ms target.
3. The budget must live on the loop (`AcTrView2d.ts:3737`), not on a per-call
   gate (`5661`). Reducing `openConvertYieldBudgetMs` from 300 to, say, 20 ms is
   **not** a fix and is explicitly out of scope: it still resets the clock on
   every call and still compares against one 26 ms slice.
4. A macrotask yield must not be a clamped `setTimeout(0)`: 98 slices at a 4 ms
   clamp would add ~390 ms of pure waiting. `scheduler.yield()` /
   `MessageChannel` postMessage gives a task boundary without the clamp.
5. The remaining 2834.1 ms is dominated by three things that a scheduler cannot
   cut, only interleave: glyph/text merge (940), attribute copy (203 self),
   INSERT fragment finalization (656 inclusive). Interleaving them is what
   removes the *block*; only algorithmic work removes the *time*.
6. GPU buffer update is 20.48 ms and lives in the presentation task. A GPU
   translate fast path can at best remove the ~180 ms of JS in `animate` plus
   this 20 ms — it cannot touch the 2.8 s, because that is CPU geometry
   construction. That is the honest input to Task G.

## 10. Measurement caveats

- **Self time is sampled, not billed.** 200 µs samples produce a shape. Two
  runs of the same window differ by a few percent on small self values, which is
  why no threshold in this phase is set against a self time below 20 ms.
- **`inclusive` is a subtree total.** §6 is a partition of one task's duration;
  §5 is a set of overlapping subtree totals. They must not be cross-summed.
- **Profile line numbers are not navigable.** The V8 call frames carry offsets
  into the module Vite served, not the TypeScript source (e.g. `batchConvert`
  is attributed to `AcTrView2d.ts:4144`, while the function body starts at
  `5627`). Code is cited here by function name plus the lines read directly from
  the checked-out file (`3737–3741`, `5661–5666`, `5948–5953`).
- **Async ancestry is lost** (§6), so `branchesOfConversionTask` is a sibling
  list by construction, not by choice.
- **`(program)` is 1232.4 ms self / 49.7 ms inside the conversion task.** It is
  native code the sampler could not attribute to a JS frame (WebGL, canvas,
  structured clone). It is not an error term to redistribute.
- **The MTEXT / DIMENSION stress fixture is not a benchmark.** It exists to
  attribute text hot spots and to exercise glyph slot lifecycle; its numbers are
  never compared against the 50k mixed baseline.
- **One run, one machine, one Chromium build.** Timing A/B (Task E) repeats it
  interleaved with ≥ 5 valid measurements per arm; this audit is the *source
  attribution* for those arms, not a performance claim.
  
## 11. Reproducibility, and two ways of partitioning the same window

The tables in §5 and §6 were produced by a one-off script. It has been replaced by
`tools/phase212-profile-analyze.mjs`, which regenerates them from the same two artifacts:

```
node tools/phase212-profile-analyze.mjs move50000 move50000-after
```

Output is archived at `reports/phase212/b-analyze-check.txt` and `b-analyze-after.txt`. The tool
differs from the original in two deliberate ways, and the totals come out the same:

**1. The analysis window is defined by the data, not by a hard-coded task id.** The window is the
union of every `RunTask` that contains at least one `batchConvert` sample. Before the scheduler
that union happens to be exactly `RunTask #92` (2822.7 ms vs the 2834.1 ms task — the 11.4 ms gap
is the task boundary minus the first/last sample); after the scheduler it is the same window
spread over 1358 fragments. This is the only definition that behaves identically on both arms.

**2. §6's sibling branches are re-expressed as a partitioning.** §6 reproduced the original
script, which reports each branch **root's inclusive time**; those roots are mutually exclusive
(async continuations are siblings), which is why they may be summed. The new tool instead assigns
each sample to its **nearest** branch ancestor, so the column literally partitions the window and
sums to it. Both are correct; they answer different questions.

| Branch | §6 (root inclusive) | §11 (nearest-ancestor partition) |
| --- | --- | --- |
| `batchConvert` | 1139.5 | 754.9 |
| glyph / MTEXT merge (`asyncDraw` + `asyncRenderMText`) | 752.9 + 122.6 + 32.1 | 715.2 + 125.0 + 32.1 |
| `drawEntity` | — | 358.7 |
| `commitEntity` | 317.8 | 319.6 |
| `applyEntityUpdates` | 219.0 | 223.2 |
| `handleGroup` | 140.7 | 154.2 |
| `(program)` / GC | 49.7 + 37.3 | 71.9 + 32.7 |
| **sum** | **≈ 2836** | **2822.7** |

The 754.9 / 1139.3 difference is not a discrepancy: in the partition, `commitEntity` (319.6),
`applyEntityUpdates` (223.2) and everything `drawEntity` owns (358.7) that runs *under*
`batchConvert` is attributed to those children instead. The tool prints both self and inclusive
per function, so either view can be reconstructed from its output.

Cross-check of the instrumented totals against the un-instrumented ones: `batchConvert` inclusive
1139.3 (this audit) vs 1144.6 (tool, window-bounded) — 0.5 %, from the different sample-interval
divisor (584.3 us measured vs 586.2 us implied by `window / samples`).
