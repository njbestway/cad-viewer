# ERASE Undo Profile — where the 4.5 s went

Phase 2.8, Task B. Scenario: 50 000 mixed entities (60 % LINE / 20 % LWPOLYLINE /
10 % INSERT / 10 % TEXT over three layers), `ERASE → Undo → Redo → Undo`.
One command, one undo boundary.

Everything below is measured, not inferred from `settleMs`. The stage split comes
from wrapping the real methods on the live objects; the 1.9 s long task is
attributed from a V8 CPU profile of that exact window
(`reports/phase28/erase-undo.cpuprofile`, slice dump in
`reports/phase28/profile-slice.log`).

## Environment

| | |
| --- | --- |
| data-model | `@mlightcad/data-model@1.15.16-perf.3` (realdwg-web commit `9ca0264`) |
| browser | Chrome 147.0.7727.15 (UA; `userAgentData` brands report 155), headless, DPR 1, 1280×720 |
| CPU / GPU | AMD Ryzen 7 5800H (16 threads) / NVIDIA RTX 3050 Laptop, ANGLE D3D11 |
| Heap Limit | 4 192 MB |
| fixture | `p28-mixed-50000.dxf` (`writeMixedFixture`, Phase 2.6 scene, unchanged) |

## Stage split (baseline, task C not applied)

Medians over three clean runs (a fourth, drift-controlled run is listed in
`phase28-baseline.json`). All times are milliseconds.

| stage | erase | undo #1 | redo #2 | undo #3 |
| --- | --- | --- | --- | --- |
| synchronous call (JS, before first frame) | 1 010 | 992 | 244 | 960 |
| `AcDbChangeApplier.applyInverse()` | – | 423 | – | 425 |
| `AcDbBlockTableRecord.appendEntity()` | – | 78 | – | 69 |
| `dispatchUndoRedoEvents()` | – | 32 | 19 | 29 |
| `AcApContext.entityAppended` → `AcTrView2d.addEntity` | – | (inside batchConvert) | – | – |
| `endEventBatch()` (view fan-out) | – | 142 | 168 | 132 |
| `batchConvert()` drain (all passes) | – | 3 574 | – | 3 266 |
| ├ `finishEntityGeometry` | – | 6 825 | – | 6 250 |
| ├ of which `asyncDraw` (mtext-renderer) | – | 6 393 | – | 5 847 |
| └ `handleGroup` | – | 1 258 | – | 1 144 |
| glyph entities converted | – | 10 000 | – | 10 000 |
| **scene settle** | **1 215** | **4 992** | **561** | **4 467** |
| **longest long task** | 0 | **1 888** | 0 | **1 870** |
| max event-loop block | 974 | 2 016 | 382 | 1 992 |
| peak JS heap (MB) | 757 | 759 | 531 | 680 |

Reading notes:

* `finishEntityGeometry` exceeds the drain it sits in because it sums the
  *asynchronous* passes (glyph merge, deferred group jobs) that the drain only
  measures until the first quiescent point. It is an inclusive total across
  passes, not a wall-clock slice; do not add it to `batchConvert`.
* The database side is cheap and stable: replay + append + event dispatch is
  **~535 ms of the 4 992 ms**. 89 % of the user-visible latency is the view
  rebuilding drawables for entities that the database already restored.

## The 1.9 s long task, from the profile

The profiled window is 7 657 ms with 53 480 samples. One chunk contains
**1 976 ms with 3 440 samples** — a single synchronous stretch, no idle gaps
inside it:

```
=== chunk 1976 ms ===
  83.4 ms  _Object3D                       deps/chunk-V7KZFINS.js   (three.js ctor)
  57.3 ms  mergeMeshGeometriesUnprofiled   mtext-renderer/dist/index.js
  50.4 ms  batchConvert                    view/AcTrView2d.ts:3756
  47.3 ms  copy                            deps/chunk-V7KZFINS.js   (BufferAttribute)
  43.7 ms  copyAttributeData               batch/AcTrBatchedGeometryInfo.ts:20
  38.6 ms  generateUUID                    deps/chunk-V7KZFINS.js
  36.5 ms  (garbage collector)
  33.7 ms  min                             deps/chunk-V7KZFINS.js   (Box3.expandByObject)
  31.7 ms  getX                            deps/chunk-V7KZFINS.js   (Matrix4 element reads)
```

Inclusive time over the whole profile:

| function | inclusive |
| --- | --- |
| `batchConvert` (`AcTrView2d`) | 1 843 ms |
| `AcTrScene.addEntity` | 443 ms |
| `AcTrLayout.addEntity` | 440 ms |
| `AcTrBatchedGroup.addEntity` | 368 ms |
| `optimize()` (line/mesh batches) | 8 ms |
| `render` (layout view → renderer) | 35–38 ms |

So the long task is **not** batching, not `optimize()`, not GPU upload, and not
the transaction. It is the per-entity drawable construction inside a single
`batchConvert` pass: constructing `Object3D`/`Line` objects, merging glyph
geometry through mtext-renderer, and copying transformed attribute buffers. That
is O(entities) work with a large constant, executed without yielding.

Frame presentation is not the bottleneck either: `frameP95` during undo is
17 ms and the first frame after the call lands in 5–10 ms. The browser is
responsive *between* passes; one pass simply holds the thread for ~2 s.

## Why Phase 2.7 reported `longTaskCount = 0`

The Redo call was measured with `performance.now()` around a
`page.evaluate()` body. Work executed inside a single CDP `Runtime.evaluate`
does not surface as a PerformanceObserver *longtask* entry — the observer is
delivered after the task completes, and the evaluate result is returned with the
same task — while the wall clock still shows ~204 ms. Task A3 replaced that with
a probe that

* samples a monotonic heartbeat (`requestAnimationFrame` + `setTimeout(0)`) and
  derives both the maximum gap and the count of gaps ≥ 50 ms from it,
* keeps the `PerformanceObserver` long-task list as a second, independent source,
* records `syncMs` for the JS call, `frameP95`/`frameMax` for presentation and
  the first-frame latency after the call.

The two sources now agree within one frame interval, and the long task is
visible in all of them (`a3-probe.json`, `a3-probe.log`, and the
`window` block of every `erase-undo-profile-*.json`). A Chrome trace of the same
scenario is archived as `reports/phase28/erase-undo-trace.json`
(149 MB; `erase-undo-trace.json.gz`, 6.3 MB, SHA256
`3373C32DF32F7B2E0F4AD71FD22B1906FEF22ECB67CC8010AD38BADE82A120E3`).

## What this rules out

* **Database replay is not the problem.** 535 ms of 4 992 ms, and it is linear
  and stable (423–529 ms across runs).
* **Batching / compaction is not the problem.** `optimize()` totals 8 ms for
  50 k entity removal; the batched containers are not being rebuilt per entity.
* **GPU upload is not the problem.** `info.memory.geometries` stays at 5–6 and
  textures at 4 through the whole cycle; `render` is 35–38 ms.
* **Material creation is not the problem.** `AcTrMaterialManager.getMaterial`
  is 40 ms self time (0.5 %).

The one hotspot left is the volume of drawable construction that an undo
performs: **100 000 conversions for 50 000 entities in the baseline**, because
every restored entity is converted twice — once from the `entityModified` event
the redo/undo path emits for it, once from `entityAppended`. Task C removed the
duplicate (see `PHASE28_OPTIMIZATION_REPORT.md`); the remaining 5 000 glyph
merges per undo are genuine work and are the reason the 2 s target was not met.
