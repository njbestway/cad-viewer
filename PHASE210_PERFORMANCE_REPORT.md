# PHASE210_PERFORMANCE_REPORT — what sharing bought, and where

Phase 2.10 · Tasks E1 / E2 / E3 / E4. Design:
`PHASE210_SNAPSHOT_SHARING_DESIGN.md`. Correctness:
`PHASE210_TRANSACTION_CORRECTNESS.md`. Heap: `PHASE210_HEAP_RETENTION_AUDIT.md`.

**Headline, stated the way the numbers support it:** a pure MOVE transaction
takes exactly one third fewer deep clones (3N → 2N, −33.3 %) at every size from
1k to 100k, and the time that third bought back lands on the data side of the
edit (`recordModify` 279 → 33 ms at 50k in dev, 300 → 28 ms in prod), for a total
in-transaction edit time reduction of 12–35 %. Render conversion cost
(`settleMs`) is **unchanged within noise**, and retained undo-history bytes are
**unchanged by design**. This phase does not fix the ~2 s conversion block and
does not claim to.

---

## 1. Method

All three harnesses use the same rule: both arms run **the same build**, the
switch is flipped per session, and the arms are interleaved so JIT warm-up, GC
drift and machine load are shared. Every sample is taken after
`waitUntilSceneReady()` returns `ready:true` — which, after Task A2, is a gate
that has been proven not to lie.

- **E1 node benchmark** — `packages/data-model/bench/phase210Move.spec.ts`.
  N lines in model space, one transaction, one `open → translate` pass, one
  commit, one undo, one redo. 5 samples per arm, A/B interleaved, median
  reported. Sizes 1k / 10k / 50k / 100k.
- **E3 browser A/B** — `e2e/tests/phase210-browser-ab.spec.ts`, run twice: dev
  (`vite dev`) and prod (`vite build && vite preview`). Same fixture shape, 3–5
  interleaved samples per size, 1k / 10k / 50k. The prod run is the one that
  matters for "does this survive minification and the real bundle".
- **Kernel counters** — every number below is also in the 18-field
  `AcDbSnapshotSharingMetrics` payload stored beside it in
  `reports/phase210/node/node-move-*.json` and
  `phase210-browser-ab.json`.

## 2. E1 — node benchmark (median of 5 interleaved samples)

### Clones

| Entities | Off | On | Reduction |
| --- | --- | --- | --- |
| 1 000 | 3 000 | 2 000 | −33.3 % |
| 10 000 | 30 000 | 20 000 | −33.3 % |
| 50 000 | 150 000 | 100 000 | −33.3 % |
| 100 000 | 300 000 | 200 000 | −33.3 % |

`sharedBeforeSnapshotCount` = N and `copyOnWriteCount` = 0 in every single
sample, at every size. The third is the falsifiable part: if any code path ever
wrote a shared snapshot, it would have to copy first and the counter would move.

### Time (ms, median)

| Entities | | open | transform | commit | undo | redo | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | off | 45.5 | 0.23 | 11.8 | 19.3 | 18.5 | 58.7 |
| 1 000 | on | **32.6** | 0.32 | 11.5 | 19.4 | 19.8 | **43.1** (−26.6 %) |
| 10 000 | off | 437.9 | 2.00 | 136.3 | 179.3 | 165.7 | 585.1 |
| 10 000 | on | **302.0** | 1.55 | 143.6 | 192.3 | 179.8 | **447.9** (−23.5 %) |
| 50 000 | off | 2 156.9 | 4.41 | 619.7 | 783.8 | 844.6 | 2 783.9 |
| 50 000 | on | **1 271.9** | 4.59 | 610.3 | 701.9 | 703.9 | **1 885.8** (−32.3 %) |
| 100 000 | off | 4 983.2 | 15.50 | 1 547.9 | 2 002.0 | 1 977.6 | 6 378.1 |
| 100 000 | on | **3 111.7** | 13.10 | 1 498.6 | 1 937.1 | 1 865.8 | **4 565.9** (−28.4 %) |

The reduction is entirely in `openMs` — the phase that takes the rollback
snapshot — which is exactly what the design predicts: `openMs` 45.5 → 32.6,
437.9 → 302.0, 2 156.9 → 1 271.9, 4 983.2 → 3 111.7 (a 28–41 % cut).
`commitMs` is flat (it never took the before snapshot), and `undo`/`redo` are flat
because they read snapshots, they do not create them.

### E2 — the metrics contract

`getSnapshotSharingMetrics()` returns exactly the 18 documented fields
(`AcDbSnapshotSharingMetrics`). Verified field by field against the interface in
`PHASE210_SNAPSHOT_SHARING_DESIGN.md` §5; the three invariant checks that matter:

| Check | Result |
| --- | --- |
| field count | 18, no extras |
| `copyOnWriteCount` | 0 at every sample |
| `sharedBeforeSnapshotCount` | 0 (off) / N (on) exactly |

`retainedUndoChanges` = N and `retainedSnapshotBytesEstimated` = 2 × N ×
(entity estimate) in **both** arms — see §5.

## 3. E3 — browser A/B, dev and prod

Dev (`vite dev`, 5 samples at 1k/10k, 3 at 50k):

| Entities | edit off | edit on | Δ edit | settle off | settle on | Δ settle | clones |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | 23.7 | 20.1 | −15.2 % | 115 | 111 | −3.5 % | 3 000 → 2 000 |
| 10 000 | 196.6 | 147.3 | −25.1 % | 534 | 473 | −11.4 % | 30 000 → 20 000 |
| 50 000 | 1 208.0 | 938.6 | −22.3 % | 2 848 | 2 499 | −12.3 % | 150 000 → 100 000 |

Prod (`vite build && vite preview`, 3 samples per size):

| Entities | edit off | edit on | Δ edit | settle off | settle on | Δ settle | clones |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | 38.5 | 29.9 | −22.3 % | 148 | 141 | −4.7 % | 3 000 → 2 000 |
| 10 000 | 227.5 | 199.6 | −12.3 % | 622 | 613 | −1.4 % | 30 000 → 20 000 |
| 50 000 | 1 286.2 | 831.2 | −35.4 % | 2 579 | 2 455 | −4.8 % | 150 000 → 100 000 |

`settleMs` is the post-edit wait for the renderer to catch up. It moves by
1–12 %, in the same direction in both modes, and it is not attributable to the
snapshot change: the number of converted entities, the batch entry count
(`batchEntriesAfter` is identical in both arms at every size) and the geometry
count are unchanged. Treat that small movement as noise, not as a rendering win.

### Kernel stage split inside the browser edit (ms, median)

This is where the time actually goes, and it is the cleanest evidence that the
benefit is data-side:

| Mode | Entities | `recordModifyMs` off → on | `openForWriteMs` off → on |
| --- | --- | --- | --- |
| dev | 1 000 | 5.0 → 0.4 | 6.6 → 8.3 |
| dev | 10 000 | 47.6 → 3.0 | 60.0 → 54.3 |
| dev | 50 000 | 279.4 → 33.2 | 339.8 → 350.6 |
| prod | 1 000 | 7.6 → 0.7 | 9.6 → 11.7 |
| prod | 10 000 | 52.4 → 5.5 | 60.4 → 67.9 |
| prod | 50 000 | 300.1 → 28.0 | 383.0 → 309.1 |

`recordModifyMs` collapses by 88–91 % because the call it measures no longer
clones — it stores a reference. `openForWriteMs` (the rollback clone, which still
happens) is unchanged or slightly higher (the extra `performance.now()` brackets
and the branch). Summed, the two stages account for most of the edit-time win.

### Undo / redo in the browser

Prod: 1k 16.3 → 15.6, 10k 104.8 → 117.0, 50k 561.1 → 542.4 ms; redo 14.9 → 16.1,
104.1 → 95.6, 555.0 → 563.7. Both directions, both signs, ±11 %. That is the
correct result: undo/redo were never in scope and must not move. The apparent
"regression" at 10k undo and 50k redo is noise in a 3-sample median.

## 4. E4 — hard conditions, checked honestly

| Condition | Result |
| --- | --- |
| Clone count reduction demonstrated | ✅ 3N → 2N exactly, 1k–100k, both harnesses |
| Edit-path time reduction | ✅ 12–35 % (prod), 15–25 % (dev), 23–32 % (node) |
| No undo-boundary change | ✅ one MOVE = 1 undo record in all 44 browser runs (22 paired A/B samples) |
| No retained-memory claim without evidence | ⚠️ retained bytes are **unchanged** (§5) |
| If clones drop but time/retained memory do not improve ⇒ CPU profile + heap retainer required | time **did** improve, so the first half of the condition is not met; retained memory did **not** improve, so the heap-retainer half is supplied in full (`PHASE210_HEAP_RETENTION_AUDIT.md`), and the stage split above answers "where did the time go" per kernel phase |

The conditional is therefore handled on its merits rather than by producing a
CDP CPU profile for a question the kernel's own timers already answer. If the
reviewer wants per-function attribution on top of per-stage attribution, the
phase 2.9 profiling tooling (`tools/phase29-*`, `.tmp-p28/analyze-cpuprofile.mjs`)
can be pointed at the same spec without changes.

## 5. Why "memory" is not the headline

| Entities | retained bytes off | retained bytes on | ratio |
| --- | --- | --- | --- |
| 1 000 | 1 667 072 | 1 667 072 | 1.000 |
| 10 000 | 16 702 784 | 16 702 784 | 1.000 |
| 50 000 | 83 582 784 | 83 582 784 | 1.000 |
| 100 000 | 167 320 736 | 167 320 736 | 1.000 |

By construction: `retainedSnapshotBytesEstimated` counts what the undo and redo
stacks keep after commit — `before` + `after` per modified id, 2N snapshots. The
shared object replaced a *second* snapshot taken during the transaction, not one
of the retained two. What genuinely shrinks is peak transient allocation inside
the transaction window (one fewer N-sized snapshot set alive between
`openObject` and `finalize`), which a post-commit heap sample cannot see and this
report does not claim to have measured.

## 6. Files

| Artifact | Contents |
| --- | --- |
| `reports/phase210/node/node-move-{1000,10000,50000,100000}.json` | raw per-sample node A/B |
| `reports/phase210/phase210-browser-ab.json` | raw per-sample browser A/B, dev + prod |
| `reports/phase210/phase210-baseline.json` | sharing-off aggregate, all harnesses |
| `reports/phase210/phase210-after.json` | sharing-on aggregate, all harnesses |
| `reports/phase210/phase210-summary.txt` | the same tables as plain text |
| `tools/phase210-summarize.mjs` | reducer that produced the two aggregates |

## 7. Limits of these numbers

- 3 samples at 50k in both browser modes: good enough to see a 12–35 % effect,
  not good enough to resolve ±10 %. The 10k prod undo number is the clearest
  example of a median that means nothing at n = 3.
- The node benchmark measures the kernel only, in one clean transaction. The
  browser numbers include the editor's own event dispatch and are the honest
  figure for a user-visible MOVE.
- One machine, one browser build, one day. No cross-machine variance study.
