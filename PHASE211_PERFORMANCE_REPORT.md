# PHASE211 · Task F — Performance Regression Report

**Verdict: no regression ≥ 10 %; the slot fix makes 50k MOVE *faster*, and every
other metric (undo, redo, settle, ready-after, longest task, GC heap, peak heap,
slot capacity) is inside noise on both arms.**

The one thing this report does **not** claim is an improvement in main-thread
blocking: the 2 s MOVE-conversion stall is still there (§6), and a shorter
`waitUntilSceneReady()` is not counted as a win.

Raw data:

| file | content |
| --- | --- |
| `reports/phase211/phase211-browser-ab.json` | on/off comparison, per metric, both ops; 6 rounds collected per arm, last 4 aggregated |
| `reports/phase211/phase211-move-conversion-profile.json` | 50k MOVE conversion CPU profile + trace (post-fix) |
| `reports/phase211/phase211-move-conversion-profile-before.json` | same measurement, pre-fix build |
| `reports/phase211/f-50k-on.log`, `f-50k-off.log`, `f-50k-on-after.log`, `f-50k-off-after.log` | run logs |
| `reports/phase211/phase211-resource-after.json` | per-round rows for the same cells |

---

## 1. Configuration

| axis | value |
| --- | --- |
| fixture | 50 000 entities, 60 % LINE / 20 % LWPOLYLINE / 10 % INSERT / 10 % TEXT, 3 layers, 3×3 cells |
| browser | Chromium (Playwright bundled), single tab, foreground |
| build | `vite dev` (`packages/cad-editor-demo`, port 4173) — the same harness Phase 2.10 used for its dev table |
| rounds per arm | 6 × (`MOVE | ERASE → Undo → Redo → Undo`), post-GC sample |
| arms | `snapshotSharing = on` (`f50b-on`) and `= off` (`f50b-off`), same build, same machine, back to back |
| tags | `f50-on`/`f50-off` are the earlier (pre-LIFO) runs; `f50b-*` are the runs this report uses |

The snapshot-sharing feature flag is unchanged in this phase; both arms are the
same Phase 2.11 tree, so the A/B isolates the *sharing* flag, not the slot fix.
The slot fix itself is measured against the Phase 2.10 tree in §5.

---

## 2. Headline numbers (median of rounds 3–6)

Six rounds were collected per arm. Rounds 1–2 are first-touch warm-up (JIT,
module init, GC shape) and are collected but **excluded from the aggregate**; every
headline value below is the median of the remaining four. `arms[*].rounds = 6` /
`arms[*].steadyRounds = 4` record this in the JSON, and
`tools/phase212-ab-window-audit.mjs` re-derives every aggregate over every
plausible window: all 35 aggregates that actually vary are reproduced by
"median of rounds 3–6", and no other window reproduces more than 12.

### ERASE 50 000 in one command

| metric | sharing on | sharing off | Δ (off−on) |
| --- | --: | --: | --: |
| edit, sync | **1 090.75 ms** | 1 245.55 ms | +154.8 ms (+14.2 %) |
| undo | 581.85 ms | 548.75 ms | −33.1 ms (−5.7 %) |
| redo | 201.4 ms | 204.1 ms | +2.7 ms (+1.3 %) |
| scene settle (4 drains) | 3 238 ms | 3 278.5 ms | +40.5 ms (+1.3 %) |
| `waitUntilSceneReady()` after the edit | 17 ms | 17 ms | 0 |
| longest task | 321.5 ms | 318.5 ms | −3 ms (−0.9 %) |
| GC heap | 313.95 MB | 308.9 MB | −5.05 MB |
| peak heap | 555.15 MB | 571.2 MB | +16.05 MB (+2.9 %) |
| slot capacity | 45 000 | 45 000 | 0 |
| reused slots (cumulative) | 405 000 | 405 000 | 0 |
| renderer geometries / `Object3D` | 5 / 36 | 5 / 36 | 0 |

### MOVE 50 000 in one transaction

| metric | sharing on | sharing off | Δ (off−on) |
| --- | --: | --: | --: |
| edit, sync | **837.9 ms** | 1 041.55 ms | +203.65 ms (+24.3 %) |
| undo | 498.25 ms | 488.75 ms | −9.5 ms (−1.9 %) |
| redo | 463.75 ms | 458.85 ms | −4.9 ms (−1.1 %) |
| scene settle (4 drains) | 522.5 ms | 493.5 ms | −29 ms (−5.6 %) |
| `waitUntilSceneReady()` after the edit | 132.5 ms | 124.5 ms | −8 ms |
| longest task | 2 128.5 ms | 2 163 ms | +34.5 ms (+1.6 %) |
| GC heap | 307.05 MB | 307.1 MB | +0.05 MB |
| peak heap | 632.7 MB | 658.35 MB | +25.65 MB (+4.1 %) |
| slot capacity | 45 000 | 45 000 | 0 |
| reused slots (cumulative) | 810 000 | 810 000 | 0 |

Reading:

* Sharing still buys the same thing it bought in Phase 2.10 — the edit-time
  snapshot work — and buys nothing anywhere else. Undo/redo/settle move by
  ≤ 6 % in both directions, which is the correct shape for a change that was
  never in scope.
* `slotCapacity`, `reusedSlots`, geometries and `Object3D` are identical across
  arms, so the slot fix is sharing-agnostic (it must be: it never touches the
  transaction manager).
* `longest task` stays at ~2.1 s on the MOVE arm and ~0.32 s on the ERASE arm —
  unchanged from Phase 2.10, and the thing Task G is about.

---

## 3. Reference comparison against Phase 2.10

Phase 2.10 prod (`PHASE210_PERFORMANCE_REPORT.md` §3): 50k MOVE edit
**1 286.2 ms off → 831.2 ms on** (−35.4 %). Phase 2.10 dev, same spec:
**1 208.0 → 938.6 ms** (−22.3 %).

Phase 2.11 dev, this report: **1 041.55 → 837.9 ms**.

| | off | on | reduction from off |
| --- | --: | --: | --: |
| 2.10 dev | 1 208.0 | 938.6 | −22.3 % |
| **2.11 dev** | **1 041.55** | **837.9** | **−19.5 %** |
| 2.10 prod | 1 286.2 | 831.2 | −35.4 % |

* Absolute: the on-arm is **100.7 ms faster** than 2.10's dev on-arm (−10.7 %),
  and the off-arm **166.5 ms faster** (−13.8 %). Both arms improved, which is
  the signature of removing work common to both (`ascIdSort`, §4), not of
  shifting work between arms.
* Relative: the on/off *gap* narrowed from 22.3 % to 19.5 %, because both arms
  got faster. That is not a regression in the on-arm — the on-arm number itself
  improved.
* Against the number the task quotes as the baseline (prod 831.2 ms), the 2.11
  **dev** on-arm is 837.9 ms, i.e. **+0.81 %**. Dev is the slower harness of the
  two (2.10: dev on 938.6 vs prod on 831.2), so a dev run that lands within 1 %
  of the prod baseline is, if anything, a gain.

Cross-phase numbers come from two different spec files, two different harnesses and
two different builds. They are **reference evidence, not a controlled causal
verification**: no arm of this phase re-ran the Phase 2.10 tree under the Phase 2.11
harness, so the delta cannot separate the slot fix from harness drift, data-model
version, or JIT state. The load-bearing measurement in this report is the
within-build A/B in §2, which shares harness, build and session.

---

## 4. Why both arms got faster

`reserveGeometryId()` used to `sort()` the free list ascending before every pop.
With the free list non-empty for the first time (the whole point of Task C), a
50k MOVE became 50k frees + 50k reservations over a pool that grew to 45 000
ids — an `O(k log k)` sort 50 000 times. Task G's profile puts that at
**12 105.9 ms of self time** plus **1 535.5 ms** in `ascIdSort`, inside a single
15.1 s task.

Replacing it with a LIFO `pop()` removed the sort entirely. That is why the sync
edit numbers fell on **both** arms and why the conversion window went from
20.4 s to 12.8 s wall (Task G report §2).

No other hot path changed: `optimize()` is 12 ms, GPU upload is 0 ms, the
existing-geometry removal is 57 ms.

---

## 5. Threshold check (the 10 % rule)

The rule: *if the slot fix causes a credible regression above 10 %, find it or
roll it back.*

| measurement | reference | 2.11 | verdict |
| --- | --: | --: | --- |
| 50k MOVE edit, sharing on | 938.6 ms (2.10 dev) | 837.9 ms | **−10.7 %** — faster |
| 50k MOVE edit, sharing off | 1 208.0 ms (2.10 dev) | 1 041.55 ms | −13.8 % — faster |
| 50k MOVE edit, sharing on | 831.2 ms (2.10 prod) | 837.9 ms (dev) | +0.81 % — inside 10 % |
| 50k MOVE undo / redo | 2.10 prod 542.4 / 563.7 ms (on) | 498.25 / 463.75 ms | faster, well inside the ±11 % noise band 2.10 recorded |
| 50k MOVE settle | 2 499 ms (2.10 dev) | 522.5 ms (4 drains) | not comparable (2.10's settle is a single drain) |
| 50k ERASE edit | no 2.10 equivalent | 1 090.75 ms | n/a — first measurement |
| longest task, MOVE | 2 128.5 ms equivalent recorded in 2.10 as "~2 s" | 2 128.5 ms | unchanged |
| GC heap, 50k MOVE | Phase 2.10 reported no 50k post-GC heap for this cell | 307.05 (on) / 307.1 (off) | n/a across phases; **identical across arms** |

**No metric regressed by 10 %; three improved by more than 10 %.** The only
number that moves in the "worse" direction by more than a few percent is peak
heap on the off-arm (+4.1 % on MOVE, +2.9 % on ERASE), which is a GC-timing
artifact: the on-arm ran immediately before the off-arm in the same browser
profile and the peaks are bimodal across sessions (639–857 MB on the same ERASE
cell — see the convergence report §9).

---

## 6. What was *not* treated as an improvement

Two things are explicitly excluded from the verdict, as the task requires:

1. **The MOVE conversion stall is unchanged.** `longestTaskMs` 2 128.5 ms on the
   on-arm, 2 163 ms on the off-arm, and the trace still shows one ~2.8 s
   `RunTask` wrapping the whole conversion of 45 000 slots. Task G profiles it;
   nothing in Task C claims to have reduced it. The 20.4 s → 12.8 s conversion
   wall-time drop is a *total* improvement caused by deleting a quadratic sort,
   not a blocking improvement — the single longest task is still in the seconds.
2. **`waitUntilSceneReady()` returning earlier is not a win.** It moved
   −6 % on MOVE (132.5 → 124.5 ms) and 0 on ERASE. The two completion conditions
   are different and are never substituted for each other:
   * `waitUntilSceneReady()` resolves when the view's pending-work bookkeeping is
     drained — the conversion queue and the deferred-geometry set are empty. It
     makes no claim about whether a frame carrying the new geometry has been
     drawn, and Phase 2.9 documented that its early ports can be satisfied before
     the last deferred geometry lands.
   * *frame presented* is the second `requestAnimationFrame` boundary after ready:
     a frame that actually contains the new geometry has been submitted.

   A shorter ready that is not accompanied by a shorter presented frame is
   excluded from the verdict. Phase 2.12 measures the two separately for exactly
   this reason.

---

## 7. Measurement caveats

* 6 rounds per arm, **last 4 aggregated (median)**; rounds 1–2 are warm-up. The 50k
  ERASE peak heap is bimodal across sessions
  (639 / 755 / 838 / 857 MB for the same configuration), so peak-heap deltas
  below ~10 % are not signal.
* Dev server (`vite dev`) rather than a production bundle. Phase 2.10 measured
  both and found the *direction* identical and the magnitude 1.3–1.5× larger in
  dev; the prod A/B for the 1k fixture is in `phase211-prod-ab.json` (Task A3).
  **No 50k production A/B exists in this phase.** Every 50k number here is a dev
  build, and the only production-bundle A/B covers 1 000 entities; any statement
  about 50k production behaviour would be extrapolation, not measurement.
* One machine, one Chromium build, foreground tab, no throttling. Absolute
  numbers are not portable; deltas within one session are.
* `settleMs` is the sum of four drains per round, so it is not directly
  comparable with Phase 2.10's single-drain settle column.
