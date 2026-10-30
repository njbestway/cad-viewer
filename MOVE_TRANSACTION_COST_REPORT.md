# MOVE synchronous transaction cost — Phase 2.8, Task D

Scenario: one `MOVE` over the whole selection, **one transaction, one undo
boundary**, no intermediate commit. 10 k / 50 k / 100 k entities.

Two independent harnesses measure the same code path:

* **Node** — `benchmarks/bulk-edit/phase28-move.bench.ts`, one process per run,
  `createDatabaseWithLines` fixture (Phase 2.6 unified fixture, `origin 512000`,
  `seed 20261028`), no view attached.
* **Browser** — `packages/cad-editor-demo/e2e/tests/phase28-move-cost.spec.ts`,
  real viewer, dev and production bundles, `--workers=1`.

Stage boundaries are real spans around the live methods
(`db.openEntityForWrite`, `entity.transformBy`, `recorder.finalize`,
`dispatchCommitEvents`, `enqueueUndoChanges`), not deltas inferred from the
total.

## Environment

| | |
| --- | --- |
| data-model | `@mlightcad/data-model@1.15.16-perf.3` (realdwg-web commit `9ca0264`) |
| runtime | Node v26.5.0 / pnpm 10.33.4 / win32 x64 |
| CPU / RAM | AMD Ryzen 7 5800H (16 threads) / 31.9 GB |
| browser | Chrome 147.0.7727.15 (UA; `userAgentData` brands report 155), headless, DPR 1, 1280×720 |
| GPU / Heap Limit | NVIDIA RTX 3050 Laptop, ANGLE D3D11 / 4 192 MB |
| three.js | 0.186.1 |

Raw data: `reports/phase28/phase28-move-node-taskc.json`,
`phase28-move-browser-dev-serial-{10000,50000}.json`,
`phase28-move-browser-prod-serial-{10000,50000}.json`,
logs `node-bench.log`, `move-cost-serial.log`, `move-cost-prod-serial.log`.

## Node: five samples per size

All times in ms. Samples are five independent transactions inside one process;
`total` is the whole `runDatabaseEdit` wall clock, `edit` is the callback body.

| size | metric | median | min | max | p95 | samples |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 10 k | total | **323.55** | 290.95 | 341.25 | 341.25 | 334.11 / 341.25 / 323.55 / 290.95 / 292.55 |
| 10 k | edit | 210.39 | 193.72 | 225.04 | 225.04 | – |
| 50 k | total | **1 520.54** | 1 473.24 | 1 553.10 | 1 553.10 | 1 550.06 / 1 553.10 / 1 520.54 / 1 473.24 / 1 513.12 |
| 50 k | edit | 1 012.35 | – | – | – | – |
| 100 k | total | **3 089.69** | 2 988.78 | 3 295.39 | 3 295.39 | 3 050.13 / 3 295.39 / 3 121.26 / 3 089.69 / 2 988.78 |
| 100 k | edit | 1 984.80 | – | – | – | – |

Scaling is linear (10 k → 50 k = ×4.70 on a ×5 workload, 50 k → 100 k = ×2.03).
There is no super-linear term to chase: the cost is per-entity and constant.

## Node: stage split

Medians, `stageMedian` from the same JSON. `%` is share of `total`.

| stage | 10 k | % | 50 k | % | 100 k | % | µs/entity @50 k |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openEntityForWrite` (rollback snapshot + `recordModify`) | 187.92 | 58.1 | 935.54 | 61.5 | 1 833.96 | 59.4 | 18.7 |
| `transformBy` (actual geometry) | 4.95 | 1.5 | 22.42 | 1.5 | 44.68 | 1.4 | 0.45 |
| `recorder.finalize` (after snapshot) | 86.37 | 26.7 | 432.52 | 28.4 | 914.31 | 29.6 | 8.65 |
| `dispatchCommitEvents` | 16.34 | 5.1 | 73.28 | 4.8 | 162.27 | 5.3 | 1.47 |
| `enqueueUndoChanges` (record push) | 0.11 | 0.0 | 0.62 | 0.0 | 1.79 | 0.1 | 0.01 |
| `commitTransaction` (contains the three above) | 101.32 | 31.3 | 508.15 | 33.4 | 1 091.79 | 35.3 | 10.2 |
| un-instrumented remainder (transaction setup, undo mark) | 29.36 | 9.1 | 54.43 | 3.6 | 119.26 | 3.9 | 1.09 |

`finalize` + `dispatchCommitEvents` + `enqueueUndoChanges` are **inside**
`commitTransaction`; do not add the rows together.

Snapshot work = `openEntityForWrite` + `finalize` = **84.8 % / 90.0 % / 88.9 %**
of the synchronous cost. The geometric transform is **1.5 %**. Any optimisation
that makes `transformBy` faster cannot move this number; only the snapshots can.

## Node: clones and retained memory

`originalStateClones / recordModifyClones / afterClones` are counted by wrapping
`clonePreservingIdentity`; all five runs report exactly `N / N / N`:

| size | clones (total) | heap Δ after commit | max RSS |
| --- | ---: | ---: | ---: |
| 10 k | 30 000 | 20.38 MB (min −2.63, max 21.98) | 2 127.67 MB |
| 50 k | 150 000 | 89.70 MB (p95 –) | 2 231.85 MB |
| 100 k | 300 000 | 166.51 MB | 2 899.63 MB |

Three deep clones per entity: `AcDbTransaction.getObject(kForWrite)` stores one
in `originalStates`, the recorder stores a second as the undo `before`, and
`finalize` stores a third as the undo `after`. The recorded undo record is one
entry with `N` changes for every size (`undoRecordCount = 1`,
`undoChangeCount = N`), so the undo boundary is not fragmented.

The heap Δ is the post-GC net growth of the process across the whole run, **not**
the retained size of the snapshots — the snapshots are live only for the
duration of the transaction plus the retained undo record. Treat it as an
upper-bound sanity number, not a per-entity byte count.

## Browser: dev vs production bundle

Serial runs (`--workers=1`), one fixture per size, one transaction. Times in ms.

| build | size | total | open | transform | finalize | dispatch | commit | longest long task | max block | frame p95 | heap peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dev | 10 k | 200.2 | 104.9 | 1.4 | 34.7 | 36.8 | 72.6 | 461 | 494 | 233.3 | 285 MB |
| dev | 50 k | 1 032.0 | 524.4 | 9.6 | 226.2 | 178.3 | 406.3 | 2 096 | 2 237 | 140.5 | 594 MB |
| prod | 10 k | 198.6 | 102.6 | 2.1 | 34.7 | 33.4 | 68.7 | 459 | 495 | 223.6 | 217 MB |
| prod | 50 k | 1 284.6 | 638.7 | 11.4 | 311.1 | 201.8 | 515.2 | 2 120 | 2 284 | 164.5 | 601.5 MB |

The browser is **~1.5× cheaper than Node** at 10 k and **~1.5× cheaper** at
50 k (`open` 524 vs 936 ms); V8 in the page keeps the same per-entity shape.
Correctness in all four runs: `db = sceneBefore = sceneAfter = sceneAfterUnique`
(10 000 / 50 000), `missingFromIndex = 0`, `spatialIndexResidual = 0`,
`pick` non-empty, `undoRecordsAfterMove = 1`, geometry count 5 → 6, textures 4.

Caveats, stated so they are not read as findings:

* `transform` counts **60 %** of the entities (6 000/10 000, 30 000/50 000)
  because the probe wraps `transformBy` on the prototype of the *first* entity
  only (`AcDbLine`), while the fixture is mixed. The stage is therefore a
  **lower bound**; the un-instrumented 40 % is inside `openEntityForWrite`.
  The Node number (all-LINE fixture, 10 000/10 000 calls) puts the true share at
  1.5 %, so the measurement gap does not change the conclusion.
* dev vs prod differ by 1.6 ms at 10 k and by 252 ms at 50 k. Each is a single
  run in a non-crossed design; the 50 k gap is not attributed to the bundler.
* 100 k was **not** run in the browser. Peak heap at 50 k is 601 MB against a
  4 192 MB limit, so 100 k is feasible but was left to Node to keep the GPU and
  scene assertions inside a sane budget.

## What the cost is, in one line per item

* Open-for-write is the dominant term: 18.7 µs per entity at every size. It
  performs the rollback snapshot **and** the undo `before` snapshot on the same
  object at the same instant.
* `finalize` is the second term: 8.65–9.14 µs per entity, one `after` clone.
* Event fan-out is 1.47 µs per entity, and it is the only part that touches the
  scene.
* Geometry, undo-record push and transaction bookkeeping are noise.

## Optimisation opportunities that keep transaction semantics

None of these are implemented in Phase 2.8. They are costed against the table
above so the architecture review can choose.

1. **Share the two snapshots taken at the same instant.** `originalStates` and
   the recorder's `before` are produced one after the other inside
   `getObject(kForWrite)` and describe the same pre-edit state. Making the undo
   record reference the same immutable snapshot instance would take clones from
   3 N to 2 N and cut `openEntityForWrite` by up to a third (≈ 310 ms at 50 k).
   Constraint: the shared instance must never be mutated by `abort()`; `abort()`
   restores *from* it and then drops its own reference, so this holds today.
   This is the only change with a large, provable win, and it must be validated
   against nested transactions before it is accepted.
2. **Cache handle → object lookups for the transaction.** The same objects are
   resolved once when opened and again at `finalize`. A per-transaction
   `Map<objectId, AcDbObject>` removes the second lookup. Expected < 5 % of
   `finalize`.
3. **Pre-size the change and state collections** from the selection size.
   Removes repeated `Map`/array growth during open. Expected < 3 %.
4. **Do not touch `originalSnapshots`.** Rollback requires them; the retained
   cost is the price of abort correctness. Any proposal that removes them is
   rejected by construction.

## TransformUndo

A full design is in `reports/phase28/TRANSFORM_UNDO_DESIGN.md`: pure-translation
preconditions, abort path without `originalStates`, nested-transaction merging
(whole-transaction downgrade on mixed modify), mixed `MODIFY/APPEND/ERASE`
handling, float precision via single-point restore, `ObjectId`/handle
invariants, retained-heap projection and a rollback plan.

**It is not merged, and Phase 2.8 does not merge it.** The projection it offers
(3 N → O(1)/entity, i.e. the whole 90 % snapshot share) is exactly why the next
review has to decide whether the added semantic surface is acceptable before any
code is written.

## Reproduction

```
# Node, repo root
npx jest --runInBand benchmarks/bulk-edit/phase28-move.bench.ts benchmarks/bulk-edit/phase28-undo.bench.ts

# Browser, packages/cad-editor-demo
npx playwright test e2e/tests/phase28-move-cost.spec.ts --workers=1
npx playwright test -c playwright.prod.config.ts e2e/tests/phase28-move-cost.spec.ts --workers=1
```

The production run uses `playwright.prod.config.ts`, which builds the bundle and
serves it through `vite preview` before the same spec runs against it.
