# PHASE210_CLOSEOUT — delivery index, risk, rollback

Phase 2.10 · Transaction Snapshot Sharing. Read this first; it points at
everything else and states what is still open.

**Status: complete, with three open items that are documented rather than fixed.**
`snapshotSharing` ships **off**; nothing in the shipped default behaviour of
either repository changed.

---

## 1. The result in four lines

| Question | Answer | Evidence |
| --- | --- | --- |
| Did deep clones drop? | 3N → 2N, exactly, −33.3 % at 1k / 10k / 50k / 100k | `PHASE210_PERFORMANCE_REPORT.md` §2 |
| Did time drop? | yes, 12–35 % of in-transaction edit time (prod), concentrated in `recordModify` | same, §3 |
| Did retained memory drop? | **no, and by construction** — the shared snapshot was never one of the retained two | same, §5 |
| Was correctness preserved? | 41 kernel tests + 44 browser runs (22 paired A/B samples), one MOVE = one undo record, geometry id sets equal | `PHASE210_TRANSACTION_CORRECTNESS.md` |

## 2. Deliverables

### Reports

| File | Contents |
| --- | --- |
| `PHASE210_SNAPSHOT_OWNERSHIP_AUDIT.md` | Task B — the three-snapshot model, lifecycle, the ten sharing-safety questions, and the measured clone counts (B1) |
| `PHASE210_SNAPSHOT_SHARING_DESIGN.md` | Task C — the implementation, file by file, the 9 constraints and how each is met, the 18-field metrics contract |
| `PHASE210_TRANSACTION_CORRECTNESS.md` | Tasks A2 / C3 / D — readiness gates (incl. the defect found), the 7 nested scenarios, the 20 regressions, undo-boundary evidence |
| `PHASE210_PERFORMANCE_REPORT.md` | Tasks E1 / E2 / E3 / E4 — node and browser A/B, the metrics contract, the E4 conditional handled explicitly |
| `PHASE210_HEAP_RETENTION_AUDIT.md` | Tasks F1 / F2 — five control experiments, retainer paths, and the slot arithmetic that names the owner |
| `PHASE210_CLOSEOUT.md` | this file |

### Machine-readable data

| File | Contents |
| --- | --- |
| `reports/phase210/phase210-baseline.json` | sharing-off aggregate across all harnesses |
| `reports/phase210/phase210-after.json` | sharing-on aggregate across all harnesses |
| `reports/phase210/phase210-browser-ab.json` | raw browser A/B, dev + prod, per sample |
| `reports/phase210/phase210-heap-series.json` | the five F2 experiments, per round, with counters |
| `reports/phase210/phase210-batch-slots.json` | the F1 slot arithmetic, 3 sample points per round |
| `reports/phase210/phase210-heap-diff.json` | constructor-level delta between r1 and r6 |
| `reports/phase210/phase210-heap-retainers.json` | retainer paths and immediate retainers |
| `reports/phase210/node/node-move-{1000,10000,50000,100000}.json` | raw node A/B, 5 samples per arm |
| `reports/phase210/phase210-summary.txt` | every table above as plain text |
| `reports/phase210/build-artifacts.json` | SHA256 of the artifacts that actually crossed the repo boundary |
| `reports/phase210/SPEC-CAD-001-phase210.txt` | the task text this phase was executed against (A1 traceability) |
| `reports/phase210/BASELINE_MANIFEST.txt` | A1 inventory: both HEADs, branch, dirty-file list, capture timestamp |
| `reports/phase210/cadviewer-baseline-tracked.diff` | A1 archive of the cad-viewer tracked worktree at Phase 2.10 start (256 KB) |
| `reports/phase210/cadviewer-baseline-untracked.tar.gz` + `.txt` | A1 archive of the untracked files (4.0 MB) and its listing |

> **Hand-off note:** `reports/` is gitignored (`.gitignore:74`), so none of the
> files above are staged by a plain `git add`. Hand them over with
> `git add -f reports/phase210` or as an archive next to the branch; the
> markdown reports are at the repository root and are unaffected.

### Profiles and logs

| File | Contents |
| --- | --- |
| `reports/phase210/phase210-heap-series-r1.heapsnapshot` | 419 MB, SHA256 `57A973EA…553A` (not committed) |
| `reports/phase210/phase210-heap-series-r6.heapsnapshot` | 423 MB, SHA256 `75C400E7…E035` (not committed) |
| `reports/phase210/a2-run.log` | 7 scene-readiness tests, 7 passed (1.1 m) |
| `reports/phase210/d-regression-run.log` | 3 suites / 41 tests / 10.5 s |
| `reports/phase210/d-full-data-model-suite.log` | 133 suites / 1100 tests / 48 s |
| `reports/phase210/f2-run.log` | the F2 run that produced the heap series |

### Diffs

| File | Contents |
| --- | --- |
| `reports/phase210/realdwg-web-phase210.diff` | the whole uncommitted change in `realdwg-web` (5 modified + 5 new files) |
| `reports/phase210/cadviewer-phase210-source.diff` | **only** the Phase 2.10 source delta in cad-viewer (one predicate in `AcTrView2d.getSceneReadiness`) |
| `reports/phase210/cadviewer-worktree.diff` | cad-viewer tracked worktree vs HEAD — spans Phase 2.6–2.10, for reference only |

The phase delta was isolated by checking out HEAD in a temporary worktree,
applying the archived Phase 2.10 baseline diff (`cadviewer-baseline-tracked.diff`,
captured by Task A1 at 2026-10-29 17:02), and diffing that against the current
file. The temporary worktree was removed; `git worktree list` shows only `main`.

## 3. Repository state

### realdwg-web — source of truth

```
HEAD    9ca026409971b27d806b2808ad1216a966369155
branch  perf/change-recorder-index
subject perf(data-model): restrict bulk remove replay to the undo/redo context
```

Modified (5 files, +364 −12):

| File | Δ |
| --- | --- |
| `packages/data-model/src/database/transaction/AcDbTransaction.ts` | +144 −12 |
| `packages/data-model/src/database/transaction/AcDbDatabaseTransactionManager.ts` | +127 −3 |
| `packages/data-model/src/database/transaction/AcDbChangeRecorder.ts` | +49 −2 |
| `packages/data-model/src/database/transaction/AcDbUndoStack.ts` | +46 −0 |
| `packages/data-model/src/database/transaction/AcDbDatabaseTransaction.ts` | +10 −2 |

New (5 files):

| File |
| --- |
| `packages/data-model/src/database/transaction/AcDbSnapshotSharingMetrics.ts` |
| `packages/data-model/__tests__/AcDbTransactionSnapshotFlow.spec.ts` |
| `packages/data-model/__tests__/AcDbTransactionSnapshotSharing.spec.ts` |
| `packages/data-model/__tests__/AcDbTransactionSnapshotSharingRegression.spec.ts` |
| `packages/data-model/bench/phase210Move.spec.ts` |

No commit was made: the user commits. `git diff` is captured verbatim in
`reports/phase210/realdwg-web-phase210.diff` so the change is reviewable without
the working tree.

### cad-viewer — integration verification

```
HEAD    73b4b4c4bf12ff8b3e3fe3b440499471d9c75ac6
branch  main
```

Phase 2.10 delta (7 files, 1 modified):

| File | SHA256 (first 16) | Lines |
| --- | --- | --- |
| `packages/cad-simple-viewer/src/view/AcTrView2d.ts` | modified predicate | 1 hunk |
| `packages/cad-editor-demo/e2e/tests/phase210-scene-readiness.spec.ts` | `A7B3A23495AE4BD5` | 436 |
| `packages/cad-editor-demo/e2e/tests/phase210-heap-series.spec.ts` | `C3D1434CD69602BC` | 342 |
| `packages/cad-editor-demo/e2e/tests/phase210-browser-ab.spec.ts` | `673C528693C6D56A` | 374 |
| `packages/cad-editor-demo/e2e/tests/phase210-batch-slot-attribution.spec.ts` | `7EED8882A520840D` | 203 |
| `tools/phase210-heap-retainers.mjs` | `6CDD59B6B1D21696` | 250 |
| `tools/phase210-summarize.mjs` | `4069584B00D3050` | 302 |
| `tools/phase210-artifact-hashes.mjs` | `A1A2D5A1B8521AE3` | 87 |

Plus the five `PHASE210_*.md` reports and three thin driver scripts
(`tools/phase210-baseline.ps1`, `tools/phase210-collect-diffs.ps1`,
`tools/phase210-run-full-suite.ps1`), and the `reports/` tree. None of the
Phase 2.6–2.9 work was reverted or reformatted.

### Build artifacts the prod A/B actually ran against

| Artifact | SHA256 | Bytes |
| --- | --- | --- |
| `realdwg-web/packages/data-model/dist/data-model.cjs` | `0AD363FB250CA1DE798D957EEA77461998679B5E1A3358D43AF76A3F4BE1BAA9` | 1 100 026 |
| `…/lib/database/transaction/AcDbDatabaseTransactionManager.js` | `7E37DD39A2E901C21400599E8B1A58CCCA0B7B25529A1A43C72B26F71499CFF7` | 35 234 |
| `…/lib/database/transaction/AcDbSnapshotSharingMetrics.js` | `CC003E35CE92E1A1EC3FDD329FC994D9DE962A6D822A7CAF8534CE5A0708F97A` | 730 |
| cad-viewer store copy of the manager | `7E37DD39…4CFF7` (identical) | 35 234 |
| cad-viewer store copy of `data-model.cjs` | `0AD363FB…BAA9` (identical) | 1 100 026 |

`reports/phase210/build-artifacts.json` also records the freshness checks, all
three of which are `true`: `cad-simple-viewer/dist` newer than its source,
`three-renderer/dist` newer than its source, and the cad-viewer data-model copy
byte-identical to the realdwg-web build.

## 4. Version and dependency list

| Item | Version / value |
| --- | --- |
| `@mlightcad/data-model` | `1.15.16-perf.3` (declared `file:vendor/mlightcad-data-model-1.15.16-perf.3.tgz`) |
| vendored tarball SHA256 | `E2349D2697622160CC718FF31EA408FBDAF66EBC57DB7EB8236C24ECDB09817B` |
| node | v26.5.0 |
| pnpm | 10.33.4 |
| jest | 30 (`--testPathPatterns`) |
| Playwright | chromium 147.0.7727.15 |
| OS | Windows 11 25H2, x64 |
| cad-viewer HEAD | `73b4b4c4bf12ff8b3e3fe3b440499471d9c75ac6` |
| realdwg-web HEAD | `9ca026409971b27d806b2808ad1216a966369155` |

## 5. Test commands

```bash
# kernel: 3 suites / 41 tests
cd E:/rustpro/realdwg-web
npx jest --testPathPatterns "AcDbTransactionSnapshot" --verbose
npx jest packages/data-model                     # 133 suites / 1100 tests

# node A/B, 4 sizes
PHASE210_BENCH=1 PHASE210_SIZE=100000 PHASE210_SAMPLES=5 \
  PHASE210_OUT=E:/rustpro/cad-viewer/reports/phase210/node \
  npx jest --testPathPatterns "phase210Move"

# browser, dev and prod
cd E:/rustpro/cad-viewer/packages/cad-editor-demo
P210AB_SIZES=1000,10000,50000 npx playwright test e2e/tests/phase210-browser-ab.spec.ts
P210AB_MODE=prod P210AB_SIZES=1000,10000,50000 \
  npx playwright test --config playwright.prod.config.ts e2e/tests/phase210-browser-ab.spec.ts

# readiness, heap controls, slot attribution
npx playwright test e2e/tests/phase210-scene-readiness.spec.ts
P210H_SIZE=1000 P210H_ROUNDS=6 npx playwright test e2e/tests/phase210-heap-series.spec.ts --workers=1
P210S_SIZE=1000 P210S_ROUNDS=6 npx playwright test e2e/tests/phase210-batch-slot-attribution.spec.ts --workers=1

# regenerate the aggregates and the artifact fingerprints
cd E:/rustpro/cad-viewer
node tools/phase210-summarize.mjs
node tools/phase210-artifact-hashes.mjs
```

## 6. Open risks

### R-1 (high, blocking a clean hand-off) — the vendored tarball no longer matches the verified build

`vendor/mlightcad-data-model-1.15.16-perf.3.tgz` hashes to `E2349D26…`, but its
`lib/database/transaction/AcDbDatabaseTransactionManager.js` extracts to
`0F52A391162B04943895F7C892C15AEDAB5E5277B7BB4B1C9C4823DAD081FE59`, while the
build that every measurement in this report used is `7E37DD39…`. In other words:
**the verification is valid, but the reproducible artifact is stale.** A fresh
`pnpm install` in cad-viewer would install the old bundle and the A/B would come
out at 3N → 3N.

Remediation (do this before merging anything):

```bash
cd E:/rustpro/realdwg-web/packages/data-model
pnpm build && pnpm pack            # produces mlightcad-data-model-1.15.16-perf.4.tgz
cp mlightcad-data-model-1.15.16-perf.4.tgz E:/rustpro/cad-viewer/vendor/

cd E:/rustpro/cad-viewer
# point package.json at perf.4, then:
pnpm install                       # updates pnpm-lock.yaml integrity
node tools/phase210-artifact-hashes.mjs   # every freshness check must be true
```

Then re-run `npx playwright test e2e/tests/phase210-scene-readiness.spec.ts` as a
smoke test: if the bundle is right, 7 pass. The tarball was deliberately **not**
repacked in this session because overwriting a `file:` dependency invalidates the
lockfile integrity and the safe repair requires a `pnpm install` that could
reshuffle a working store. That is the user's call, not the harness's.

### R-2 (medium) — the prod bundle chain is stale by default

The prod A/B failed twice before it ran, for one reason: `@mlightcad/cad-simple-viewer`
and `@mlightcad/three-renderer` are consumed through their `dist/` builds, and both
`dist/` trees were older than their sources (no `waitUntilSceneReady`,
`collectObjectIds` missing). Both were rebuilt for this round. **Anyone who runs a
prod-mode test after touching those packages' sources must `pnpm build` first**, or
they will measure a bundle that predates their change. `dist/` is gitignored, so
nothing in the diff warns them.

### R-3 (medium) — batch slot metadata is retained per edit, not per entity

`PHASE210_HEAP_RETENTION_AUDIT.md` §4: each erase/undo/redo cycle allocates
1 800 fresh slots for 1 000 entities, the free list stays empty, and 200 `Box3`
per round become unreachable-but-referenced. Bounded per document, freed on close,
and not a transaction defect — but it is a real bug in the batch layer, and it is
**not fixed here** because the spec scopes Phase 2.10 to snapshot sharing.
Suggested as the next ticket, with the regression test from §6 of that report.

### R-4 (low) — sample counts are uneven

3 samples per size in prod and at 50k in dev; 5 at 1k/10k in dev. Enough for a
12–35 % effect, not enough to resolve ±10 %. The undo/redo deltas of ±11 % in
prod are noise and are labelled as such.

### R-5 (low) — the readiness fix is one predicate in a large dirty file

`AcTrView2d.ts` carries 818 uncommitted lines from Phases 2.6–2.9. The Phase 2.10
delta is one hunk, isolated in `cadviewer-phase210-source.diff`, but a reviewer
looking at `git diff` on that file sees 900 lines. Review the isolated diff.

### R-6 (informational) — heap snapshots are not in the repository

Two files, 842 MB total. Hashes are recorded in §2 and in
`PHASE210_HEAP_RETENTION_AUDIT.md` §7; they are reproducible from the spec with
`P210H_SNAPSHOT` left at its default.

### R-7 (informational) — three lint-only edits landed after the measurements

`phase210-browser-ab.spec.ts` (removed two unused `const` bindings and one unused
helper) and `tools/phase210-heap-retainers.mjs` (removed an unused helper) were
cleaned up to pass `eslint` after the runs. The edits delete dead assignments and
cannot change behaviour; the spec file was re-checked with
`tsc --noEmit -p tsconfig.e2echeck.json` afterwards (clean), but the A/B numbers
were not re-measured because re-running one size would overwrite the merged
per-size JSON. `eslint` and `tsc` are both clean on all seven new files.

### R-8 (informational) — the data files are outside version control

`reports/` is gitignored, so `phase210-baseline.json`, `phase210-after.json`,
the browser/heap series and the diffs live on disk only. They are reproducible
from §5's commands in ~10 minutes, but the reviewer must either force-add the
directory or receive it as an archive. The six markdown reports are at the
repository root and travel with the change normally.

## 7. Rollback

Three independent layers, each revertible on its own:

**a) Ship the old behaviour (no code change).**
`AcDbDatabaseTransactionManager.snapshotSharing` already defaults to `false`, so
the current build behaves exactly like `1.15.16-perf.3`. Nothing to do.

**b) Revert the cad-viewer readiness fix.**
```bash
cd E:/rustpro/cad-viewer
git apply -R reports/phase210/cadviewer-phase210-source.diff
pnpm --filter @mlightcad/cad-simple-viewer build
npx playwright test e2e/tests/phase210-scene-readiness.spec.ts   # expect 1 failure: the claim test
```
If that test starts failing again, the regression is back — which is the point of
keeping it.

**c) Revert the data-model change entirely.**
```bash
cd E:/rustpro/realdwg-web
git checkout -- packages/data-model/src/database/transaction/
rm packages/data-model/src/database/transaction/AcDbSnapshotSharingMetrics.ts
rm -r packages/data-model/__tests__/AcDbTransactionSnapshot*.spec.ts \
      packages/data-model/bench
pnpm --filter @mlightcad/data-model build
npx jest packages/data-model
```
Then rebuild and reinstall the dependency in cad-viewer (§R-1 procedure). The
change is additive: 5 modified files, no deletions of existing behaviour, no
schema or record-format change, so reverting cannot orphan data.

**d) Revert the cad-viewer verification assets.** They are new files only —
delete `packages/cad-editor-demo/e2e/tests/phase210-*.spec.ts`,
`tools/phase210-*.{mjs,ps1}`, and the `PHASE210_*.md` reports. Nothing tracked was
modified apart from `AcTrView2d.ts` (item b).

## 8. Acceptance gates — self-assessment

| # | Gate | Verdict |
| --- | --- | --- |
| 1 | No TransformUndo / inverse matrix | ✅ |
| 2 | No GPU fast path | ✅ |
| 3 | Undo record structure unchanged | ✅ no change to `AcDbUndoRecord` or change kinds |
| 4 | No transaction splitting, no cross-turn open transaction | ✅ |
| 5 | 3N → 2N proven, not inferred | ✅ measured at 4 sizes in 2 harnesses |
| 6 | Correctness: 20 regressions + nested + abort + undo boundary | ✅ 41 tests, 44 browser runs |
| 7 | A2 supplements added without widening the kernel change | ✅ all 7 in cad-viewer; the one fix is in the readiness gate |
| 8 | Performance claims separate transaction gain from render conversion cost | ✅ `settleMs` reported separately and labelled noise |
| 9 | Heap residue attributed, not assumed | ✅ 5 controls + retainer + slot arithmetic; and it is **not** a transaction clone |
| 10 | Deliverables, diffs, SHAs, risks and rollback present | ✅ this file (+ R-1 open) |

**Gate 10 is met only after R-1 is resolved.** The reports describe a bundle whose
vendor tarball does not yet match it.

## 9. Stop

Phase 2.10 ends here, as the spec requires. No work has started on TransformUndo,
GPU Incremental Translate, or Worker/Wry/Rust migration, and none should start
from this branch without a new spec.
