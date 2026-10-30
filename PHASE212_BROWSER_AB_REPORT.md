# PHASE212 — Browser A/B Report (Task E)

**SPEC:** SPEC-CAD-001 · Phase 2.12 Task E / E1 / E2 / E3
**Arms:** `baseline` (scheduler off) vs `after16` / `after32` / `after64` (scheduler on, budget in ms)
**Design:** [`PHASE212_CONVERSION_SCHEDULER_DESIGN.md`](./PHASE212_CONVERSION_SCHEDULER_DESIGN.md)

---

## 1. Method

| Item | Value |
| --- | --- |
| Spec | `packages/cad-editor-demo/e2e/tests/phase212-browser-ab.spec.ts` |
| Driver | `packages/cad-editor-demo/e2e/helpers/run-phase212.ps1` |
| Design | **Interleaved**: round *n* uses `ARMS[n % 4]`; all arms run in **one page, one bundle, one session**, so a build difference cannot be mistaken for an effect |
| Rounds | 20 per fixture (5 valid samples per arm) |
| Arm order | `baseline → after16 → after32 → after64 → …` (deterministic, not randomised: a fixed rotation keeps the warm-up round of each arm at the same position) |
| Fixture | `writeMixedFixture(size)` internals are deterministic — 60 % LINE / 20 % LWPOLYLINE / 10 % INSERT / 10 % TEXT, 3 layers, **no RNG / no seed** |
| Snapshot sharing | on (Phase 2.10 build, `A8223C11…9F87`, `perf.4`) |
| Slot reuse | on (Phase 2.11) |
| Per round | one MOVE of all entities, wait for ready, read all counters, assert, then Undo to reset |
| Ready condition | **identical for every arm**: `waitUntilSceneReady({ timeoutMs })` resolving `ready: true` **and** `missingInScene / residualInScene / missingInIndex / residualInIndex == 0` in the same observation |
| Command | `powershell -NoProfile -File e2e\helpers\run-phase212.ps1 -Preset e50k -Serve prod -Suffix prod -Budgets '16,32,64' -Rounds 20` |

### Environment (fixed for every cell below)

| | |
| --- | --- |
| Browser | Microsoft Edge **156.0.4314.50** (Playwright `channel: 'msedge'` — stable, decided by `playwright.config.ts`) |
| Playwright | 1.59.1 |
| Node | v26.5.0 |
| pnpm | 10.33.4 |
| CPU | AMD Ryzen 7 5800H |
| RAM | 31.9 GB |
| GPU | reported as `i4RemoteIddDriver` (headless; no discrete GPU path exercised) |
| Viewport | Playwright `Desktop Chrome` device profile, headless |
| Artifacts | `reports/phase212/ab/{smoke1k,e1k,e10k,e50k,e50k-prod}.json` |

### 1.1 The production arm needed three fixes before it could run at all

The first two attempts failed at `initial open never settled`. The diagnostics added to the spec
turned that into a one-line answer, and the third attempt exposed the real cause. Recorded here
because none of it is obvious from the SPEC:

| Attempt | Failure | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `initial open never settled: reasons=[]` | `dist/` had been built but `copy:workers` never ran, so no `.worker.js` / `.wasm` existed | `run-phase212.ps1 -Serve prod` now runs `vite build` **and** `pnpm run copy:workers` |
| 2 | same | `window.AcApDocManager` is exposed only when `import.meta.env.DEV` **or** `VITE_E2E_EXPOSE_MANAGER === 'true'` (`App.vue:171`) — a plain production build keeps it private by design | set `VITE_E2E_EXPOSE_MANAGER=true` **before** `vite build` (it is inlined at build time) |
| 3 | `the build has no convert scheduler to switch` | `vite build` does **not** use the `command === 'serve'` alias that maps `@mlightcad/cad-simple-viewer` to `../cad-simple-viewer/src`; it bundles `packages/cad-simple-viewer/dist`, which was built on 2026-10-29 and predates the scheduler | rebuild the package dist (`pnpm --filter @mlightcad/cad-simple-viewer build`) before building the demo |

**This is a finding in its own right:** the dev server and the production bundle consume
different code for the same package. Any dev-only A/B in this repo is measuring `src`, and any
`vite build` is measuring whatever `dist` happens to be on disk. Task E would have silently
reported a dev/prod difference caused by a stale artifact.

---

## 2. Results — dev build

### 2.1 1k MOVE (all values are medians of 5)

| arm | commit | firstYield | ready | frame | **longest task** | frames p95 | frames max | yields | maxSlice | heap after | heap peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 23.4 | 66.8 | 103.4 | 131.0 | 0 (max 91) | 33.5 | 33.5 | 0 | 0 | 267.8 | 288.3 |
| after16 | 22.9 | 67.2 | 102.7 | 125.3 | 0 | 33.5 | 33.5 | 1 | 20.9 | 277.0 | 277.0 |
| after32 | 21.4 | 70.4 | 105.3 | 132.1 | 0 (max 57) | 49.9 | 49.9 | 0 | 22.5 | 284.4 | 284.4 |
| after64 | 20.2 | 64.9 | 100.3 | 119.3 | 0 | 33.4 | 33.4 | 0 | 21.4 | 263.3 | 285.0 |

At 1k there was never a long task to remove; the scheduler is neutral (all deltas inside the
run-to-run spread) and it does not fire at all in the 64 ms arm. This is the case the design
document cites against adopting an adaptive budget prematurely.

### 2.2 10k MOVE

| arm | commit | firstYield | ready | frame | **longest task** | frames p95 | yields | maxSlice | heap after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 210.7 | 657.0 | 701.5 | 712.5 | **417** | 449.9 | 0 | 0 | 465.0 |
| after16 | 216.0 | 665.4 | 716.7 | 734.3 | **0** | 216.6 | 18 | 24.9 | 514.5 |
| after32 | 212.2 | 650.5 | 696.3 | 716.1 | 62 | 216.6 | 9 | 27.6 | 540.6 |
| after64 | 222.4 | 666.2 | 715.2 | 725.6 | 96 | 216.7 | 5 | 27.0 | 433.9 |

### 2.3 50k MOVE — the acceptance scale

| arm | commit | firstYield | ready | frame | **longest task** | frames p95 | frames max | yields | maxSlice | maxTask | heap after | heap peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1112.8 | 3405.0 | 3537.6 | 3539.1 | **2149** | 1283.3 | 2300.1 | 0 | 0 | 0 | 917.5 | 932.1 |
| after16 | 1151.8 | 3768.7 | 3964.1 | 3967.1 | **160** | **150.0** | 1333.3 | 94 | 32.3 | 36.3 | 941.8 | 1035.3 |
| after32 | 1122.1 | 3738.6 | 3892.4 | 3893.5 | **174** | 183.4 | 1283.2 | 48 | 30.8 | 55.1 | 736.1 | 1141.3 |
| after64 | 1095.6 | 3465.5 | 3614.4 | 3615.5 | **209** | 216.6 | 1249.9 | 26 | 27.9 | 87.2 | 740.5 | 927.3 |

Spread, not just medians (baseline vs after16, longest task): baseline 2067–2459,
after16 142–176. The two distributions do not overlap.

---

## 3. Results — production build, 50k (the primary acceptance cell)

| arm | commit | firstYield | ready | frame | **longest task** | frames p95 | frames max | yields | maxSlice | maxTask | heap after | heap peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1123.3 | 3477.1 | 3639.8 | 3640.8 | **2200** | 1283.3 | 2349.9 | 0 | 0 | 0 | 429.3 | 718.9 |
| after16 | 1054.3 | 3503.0 | 3691.2 | 3691.5 | **147** | **150.0** | 1200.0 | 90 | 29.2 | 36.7 | 506.5 | 661.9 |
| after32 | 1108.4 | 3486.7 | 3622.6 | 3623.6 | **171** | 166.7 | 1266.7 | 48 | 28.1 | 50.7 | 503.5 | 719.5 |
| after64 | 1080.0 | 3455.4 | 3585.0 | 3586.0 | **211** | 216.7 | 1250.0 | 26 | 32.4 | 86.1 | 714.2 | 720.9 |

Ranges (baseline → after16):

| Metric | baseline | after16 |
| --- | --- | --- |
| longest task | 1670 – 2277 ms | **130 – 158 ms** |
| ready | 2914 – 3784 ms | 2938 – 3914 ms |
| commit (untouched by the flag) | 951 – 1223 ms | 900 – 1122 ms |

**The production build confirms the dev result and does so with a smaller total cost** (+1.4 %
ready vs +12 % in dev), which is the opposite of the usual minification story and worth stating
plainly: the dev server's module graph costs more per slice, so an interruptible wave pays more
there.

### 3.1 100k — attempted, not achieved

`-Preset e100k` fails before any measurement:

```
Error: expect(received).toBe(expected)
Expected: 100000
Received: 0            ← the model space iterator yields nothing
```

The same symptom appears in the Phase 2.11 ERASE matrix at 10k (§5 of the correctness report), and
the flag is off at that point, so it is a fixture-capacity / open-path limit, not a scheduling
regression. **50k is the acceptance scale and is covered; 100k is not covered and is not claimed.**

---

## 4. `firstYieldMs` — a corrected definition

The first version of this spec (and of the audit) called `firstYieldMs` "the input-latency
figure: no input can be dispatched before the owning task ends". **That is only true with the
scheduler off.** With `scheduler.yield()` the continuation is prioritised above timer tasks, so
the first `setTimeout(0)` callback is pushed to the end of the wave — the number goes *up*
(3405 → 3769 ms in dev) while the longest task falls by 93 %.

Consequences, applied throughout:

* `firstYieldMs` stays in the JSON as a task-ordering datum. It is **not** compared across arms.
* Responsiveness evidence is `longestTask`, `frames.p95`, `frames.max`.
* All five A/B JSON files carry an amended `note` plus a `noteAmended` field; the original text is
  preserved in `noteSuperseded`. No measurement was changed.

---

## 5. E2 metric coverage

| # | E2 metric | Where it is | Note |
| --- | --- | --- | --- |
| 1 | synchronous DB commit | `move.commitMs` | |
| 2 | conversion work wall time | `move.readyMs − move.commitMs` | includes the render-update queue and the wave |
| 3 | longest single long task | `longTasks.longestMs` (LongTask observer) | |
| 4 | maximum event-loop gap | trace-only: 17.3 ms baseline → 16.3 ms after | not in the A/B JSON; the A/B uses `frames.max` as the observable proxy |
| 5 | frame p95 / max | `frames.p95` / `frames.max` | rAF interval sampling |
| 6 | input-event response latency | **not measured directly** | `longestTask` bounds it from above (no input can be dispatched inside a task); a synthetic input probe is the honest next step |
| 7 | scene ready duration | `move.readyMs` | |
| 8 | frame presented duration | `move.frameMs` (two rAFs after ready) | |
| 9 | total command lifecycle | `move.frameMs − move.commitMs` start | |
| 10 | converted entity count | `scheduler.entities` | after arms only; 50000 per op |
| 11 | geometry rebuild count | `entityUpdateStats.appliedEntityCount` | **monotonic across rounds**, so use it to confirm full application, not to compare arms |
| 12 | CPU / GPU buffer allocation | `renderer.geometries`, `renderer.uniqueGeometry`, `slotLifecycle.allocatedSlots` | GPU bytes not measurable without vendor counters; `bufferSubData` appears in the trace at 11.7 ms |
| 13 | JS heap peak / post-GC heap | `heapPeakMB` / `heapMB` | |
| 14 | slot capacity | `slotLifecycle.slotCapacity` = 45000, `reusedSlots` 45000 | no growth across 20 rounds |
| 15 | shared batch count | `sharedBatch.activeBatches` = 1 baseline, 2 after | after arms hold one extra live batch; `evicted` 1, no net growth |

Items 4 and 6 are the two gaps, both stated rather than estimated.

---

## 6. E3 targets, scored

| # | Target | Result | Verdict |
| --- | --- | --- | --- |
| 1 | longest conversion task **< 200 ms** | 147 ms (prod) / 160 ms (dev) at 16 ms budget | **met** |
| 2 | further, **< 100 ms** | not met — 147 ms floor | **not met**, residual stack reported (§7 of the design doc, §5 of the optimization report) |
| 3 | total scene update must not grow unacceptably | +1.4 % (prod ready), +12 % (dev ready) | met in prod; dev growth is real, unexplained beyond locality, and accepted for research arms only |
| 4 | synchronous MOVE transaction must not regress | −6.1 % (prod), +3.5 % (dev) — the flag is not on the commit path at all | met (deltas are noise, and the code path is provably untouched) |
| 5 | no acceleration by returning ready early | every round asserts `ready === true` **and** four id-difference counts `== 0` in the same observation | met |
| 6 | database and scene correctness fully pass | 20 rounds × 4 arms, all `idsOK` | met |

**Why 100 ms is not reachable at this layer.** The floor is set by two atomic steps: one
512-entity `batchConvert` slice (29.2 ms max measured) and the wave prefix that unwraps 50,000
entities from the scene and the spatial index (261.8 ms in the dev profile, and the dominant term
in the 147 ms production task). Neither can be interrupted without changing either batch-merge
locality or the ordering guarantees of a spatial-index query mid-removal. The design for the
prefix split exists (§7) and is a ~7 % win on total wave time; the GPU question is answered in
[`PHASE212_GPU_FASTPATH_FEASIBILITY.md`](./PHASE212_GPU_FASTPATH_FEASIBILITY.md) and does not
touch either term.

---

## 7. What this report does not claim

* **No 100k claim.** Attempted, fixture does not open (see §3.1).
* **No absolute cross-version claim.** The Phase 2.10 → 2.11 edit numbers are reference evidence,
  not a controlled comparison (Task A2 item 4). This report only compares within one bundle.
* **No input-latency number.** `firstYieldMs` was withdrawn as a latency metric (§4).
* **No GPU attribution.** `bufferSubData` at 11.7 ms is the only GPU-side datum in the trace.
