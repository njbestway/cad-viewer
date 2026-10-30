# PHASE210_HEAP_RETENTION_AUDIT — the ERASE residue, attributed

Phase 2.10 · Tasks F1 / F2. Design: `PHASE210_SNAPSHOT_SHARING_DESIGN.md`.
Numbers: `PHASE210_PERFORMANCE_REPORT.md`.

**Conclusion up front:** the per-round residue after an ERASE / Undo / Redo cycle
is **not** a transaction snapshot clone. It is renderer batch slot metadata: each
re-insert allocates fresh slots in `AcTrBatchedMixin._geometryInfo` instead of
reusing the freed ones, and 200 of every 1800 new slots materialise a `Box3` that
is then reachable only through that slot record. The residue is bounded per
document and disappears on document close (experiment 3 = 0.0 MB/round), so it is
a lifecycle bug in the batch layer, not a leak and not a snapshot-ownership
problem.

Nothing in `realdwg-web` was changed to produce this conclusion, and nothing in
the snapshot-sharing design was altered to work around it — the spec forbids both.

---

## 1. What was being explained

Phase 2.9 measured ~70 B/entity/round left behind after clearing the undo
history, with every renderer and scene counter flat. Phase 2.10 re-measured the
same cycle at 1 000 entities with a forced GC before every sample and got
314.6 B/entity/round (0.3 MB/round). The discrepancy is the fixture (`mixed`,
1000 entities vs the 2.9 5k/10k fixture), not a regression: the per-round growth
tracks the number of entities that get a bounding box, not the entity count.

## 2. F2 — the five control experiments

`e2e/tests/phase210-heap-series.spec.ts`, 1 000 entities, 6 rounds, every sample
taken after `HeapProfiler.collectGarbage` (`reports/phase210/phase210-heap-series.json`):

| # | Experiment | Slope (MB/round) | B/entity/round | Reads as |
| --- | --- | --- | --- | --- |
| 1 | erase/undo/redo/undo, history kept | 0.3 | 314.6 | the baseline residue |
| 2 | same, history cleared each round | 0.3 | 314.6 | residue is **not** undo history |
| 3 | same, history cleared **and** document closed | 0.0 | 0.0 | residue is **document-scoped**, freed on close |
| 4 | no edits, same volume of scene queries | 0.0 | 0.0 | residue is **not** a query cache |
| 5 | same, history + convert bookkeeping cleared | 0.3 | 314.6 | residue is **not** convert state |

Counters were flat across every round of every experiment: `sceneIds` 1000,
`sharedBatchEntries` 3, `pendingEntities` 0, `convertQueued` 0,
`pendingGeometryJobs` 0, `staleConvertRejections` all 0. So the residue is
invisible to every counter the scene layer exposes — which is exactly why
Phase 2.9 could not attribute it.

Experiment 3 is the sharpest result: closing the document each round takes the
slope to exactly zero. A global leak (listener, module-level cache, WeakMap
keyed by a leaked closure) would survive a document swap. This one does not.

Experiments 2 and 5 bracket the two most plausible suspects and eliminate both.
That leaves "something in the scene graph itself", which is what F1 attacked.

## 3. F1 — retainer analysis

### The heap diff

`tools/phase29-heap-diff.mjs` on the two snapshots taken at round 1 and round 6
of experiment 2 (`reports/phase210/phase210-heap-diff.json`):

| Class | Count Δ | Self size Δ |
| --- | --- | --- |
| `Object` | +8 965 | +358 280 B |
| `PropertyArray` | +9 003 | +180 084 B |
| `heap number` | +5 830 | +69 960 B |
| `_Vector3` | +2 015 | +48 360 B |
| `Box3` | +1 002 | +24 048 B |
| `InstructionStream` | +298 | +459 584 B |

Total delta 1 541 908 B / +35 946 nodes over 5 rounds. Note that ~460 KB of that
is JIT `InstructionStream` — code, not data, and not part of the slope's steady
state. The data-side signal is the trio `Object` + `PropertyArray` + `heap number`
(record + its hidden-class property array + boxed doubles), with `Box3` and
`_Vector3` riding along at 1 002 and 2 015 for 5 rounds — i.e. **~200 `Box3` and
~400 `_Vector3` per round**, where 200 is the polyline share of the fixture and
2 vectors are a box's `min`/`max`.

### Who holds them

`tools/phase210-heap-retainers.mjs` (new in this phase; reverse-edge index in
`Int32Array`, weak edges skipped, uniform sampling over the target population,
both a deep path walk and an immediate-retainer view) on the r6 snapshot:

| Target | Live nodes | Immediate retainer | Share of 120 samples |
| --- | --- | --- | --- |
| `Box3` | 1 346 | `boundingBox` property of a plain `Object` | 116/120 (96.7 %) |
| `_Vector3` | 3 239 | `min` / `max` of a `Box3` | 100/120 (83.3 %) |

Classified with the five buckets the spec asks for, the `Box3` walk lands 34 of
its 50 counted paths in **invalidated-but-referenced**. The other 16 are walk
artefacts rather than retainers of the box: 12 V8 `Context`/`scope` frames and
constant-pool entries, 2 paths that climb out of `AcTrRenderer` into the dev
server's `listeners:ws` array (caught by the event-listener bucket), and 2 that
reach `AcTrLayoutView` (caught by the active-scene bucket). Those last four all
start at `_wcsBbox` on `AcTrDirectCapturePlaceholder` — a different object graph,
a capture placeholder, not a batch slot.

The `_Vector3` path view is noisier because that population also contains every
`THREE.Group.scale`: 55 of its 63 counted paths are `scale:Group` or `Context`
frames. Its immediate-retainer view is the informative one, and it is unambiguous:
100 of 120 resolve to `min`/`max` of a `Box3` (47 and 53).

**Why the deep walk is not the evidence here.** V8 records a WeakMap entry as an
internal `"<key> -> <value> pair"` edge, so a deep walk reports the ephemeron table
as the owner of everything it values; and a 6-level walk from a batch slot
regularly ends in a `Context`/`scope` chain that says nothing about the object. The
immediate-retainer view does not have that problem: it names the structure that
physically holds the object, which is the question F1 asks. So the report rests on
the immediate retainer plus the arithmetic in §4, not on a pretty 12-level path.

### Code the retainer names

`packages/three-renderer/src/batch/AcTrBatchedGeometryInfo.ts`:

```ts
export interface AcTrBatchGeometryState {
  /** Lazily computed per-geometry bounds used for culling/hit tests. */
  boundingBox: THREE.Box3 | null
  flags: number
  hiddenDrawSnapshot?: AcTrBatchDrawSnapshot
}
```

`AcTrBatchedMixin.deleteGeometryById()` sets `flags = None` and pushes the id into
`availableGeometryIds`, and nothing else:

```ts
geometryInfoList[geometryId].flags = AcTrBatchGeometryFlags.None
availableGeometryIds.push(geometryId)
```

`boundingBox` and `hiddenDrawSnapshot` are left in place. If the slot is never
reused, the record — and its box — stays reachable from `_geometryInfo` for the
life of the document. That is the retainer, exactly as sampled.

## 4. The decisive experiment: slot arithmetic

`e2e/tests/phase210-batch-slot-attribution.spec.ts` (new), 1 000 entities, 6
rounds, history cleared, GC forced before each sample, reading the slot tables
themselves out of the scene graph (it walks `layout._group` for any object with a
`_geometryInfo` array):

| Round | after erase (slots / boxes / free-list) | after undo | end of round | `geometries` |
| --- | --- | --- | --- | --- |
| 1 | 900 / 100 / 0 | 1 800 / 200 / 0 | 2 700 / 300 / 0 | 6 |
| 2 | 2 700 / 300 / 0 | 3 600 / 400 / 0 | 4 500 / 500 / 0 | 7 |
| 3 | 4 500 / 500 / 0 | 5 400 / 600 / 0 | 6 300 / 700 / 0 | 8 |
| 4 | 6 300 / 700 / 0 | 7 200 / 800 / 0 | 8 100 / 900 / 0 | 8 |
| 5 | 8 100 / 900 / 0 | 9 000 / 1 000 / 0 | 9 900 / 1 100 / 0 | 8 |
| 6 | 9 900 / 1 100 / 0 | 10 800 / 1 200 / 0 | 11 700 / 1 300 / 0 | 8 |

Read it as a difference table:

- **+1 800 slots per round**, always: two insert passes of 900, both allocating
  new ids.
- **+200 boxes per round**, always — which is precisely the ~200 `Box3`/round in
  the heap diff, to the unit.
- **Free list is 0 at all 18 sample points**, including the sample taken
  immediately after the erase, when 900 ids should have just been returned.

Three facts follow, none of which needed a snapshot:

1. The residue's owner is `_geometryInfo` — the slot array — and the `Object` in
   the retainer result is the slot record, not a snapshot and not an entity.
2. `deleteGeometryById` is not returning ids on this path: the erase leaves the
   free list empty while the array keeps its length. Either the slot is already
   `None` when erase reaches it, or the erase never reaches `deleteGeometry`.
   Distinguishing those two needs a focused patch + test in `three-renderer`,
   which is out of scope here.
3. Because the ids are never reused, each undo inserts a *new* slot with a *new*
   lazily-computed `Box3`, and the previous one becomes unreachable garbage that
   nothing collects because the slot record that holds it is still in the array.

This is why the residual memory is per *edit*, not per entity, and why it
disappears when the document does: the array lives in the document's scene graph.

## 5. Classification, using the five required buckets

| Bucket | Verdict for this residue |
| --- | --- |
| Active scene object | No — the slots are `flags = None` (soft-deleted), and `geometries` stays at 6–8 |
| Retained undo history | No — experiment 2 clears the history and the slope is unchanged |
| Bounded cache | No — experiment 4 (queries only) is exactly 0.0 MB/round |
| Unreleased transaction / event reference | No — experiment 5 clears the convert bookkeeping; the slope is unchanged, and the retainer is a renderer object |
| **Invalidated but still referenced** | **Yes** — 34 of the 50 counted retainer paths, with `boundingBox` on a freed slot record the immediate retainer in 116/120 samples |

## 6. What a fix would look like (not applied)

Per the spec, this is proposed as a separate change, not folded into 2.10:

1. `AcTrBatchedMixin.deleteGeometryById()` — clear `boundingBox` and
   `hiddenDrawSnapshot` when the slot is freed. Two lines, and it caps the
   residue at "records exist" instead of "records + geometry metadata".
2. The real fix is (2), not (1): make the erase path actually return ids to
   `availableGeometryIds`, so `reserveGeometryId()` reuses them and the array stops
   growing. `reserveGeometryId` already implements correct reuse; nothing is
   feeding it.
3. Add the slot arithmetic of §4 as a regression test (`slots` and `free list`
   must return to their pre-edit values after an undo/redo cycle), because every
   existing counter is blind to this.

Estimated effect at 1 000 entities: the 0.3 MB/round becomes 0 MB/round, and the
`Box3`/`_Vector3` share of the heap disappears with it.

## 7. Reproduce

```bash
cd E:/rustpro/cad-viewer/packages/cad-editor-demo

# five control experiments (~2.4 min), writes phase210-heap-series.json
P210H_SIZE=1000 P210H_ROUNDS=6 \
  npx playwright test e2e/tests/phase210-heap-series.spec.ts --workers=1

# slot arithmetic (~43 s), writes phase210-batch-slots.json
P210S_SIZE=1000 P210S_ROUNDS=6 \
  npx playwright test e2e/tests/phase210-batch-slot-attribution.spec.ts --workers=1

# diff the two snapshots (r1 vs r6 of experiment 2)
node tools/phase29-heap-diff.mjs \
  reports/phase210/phase210-heap-series-r1.heapsnapshot \
  reports/phase210/phase210-heap-series-r6.heapsnapshot

# retainer paths
node --max-old-space-size=8192 tools/phase210-heap-retainers.mjs \
  reports/phase210/phase210-heap-series-r6.heapsnapshot \
  reports/phase210/phase210-heap-retainers.json \
  --targets=Box3,_Vector3 --samples=120 --depth=6 --branch=3
```

The two snapshots are 419 MB and 423 MB and are **not** committed:

| File | Bytes | SHA256 |
| --- | --- | --- |
| `phase210-heap-series-r1.heapsnapshot` | 419 392 488 | `57A973EAA6F8548409B7C6AC16A071725642B2870F851915245297CF4161553A` |
| `phase210-heap-series-r6.heapsnapshot` | 423 251 399 | `75C400E7335EC6E7780678A800C771BE39AF90D9456F54156A7F66024BF8E035` |

## 8. Limits

- The slot attribution ran at 1 000 entities only. The growth is arithmetic
  (+1 800/round) rather than size-dependent, so it should scale linearly, but
  that is an inference, not a measurement.
- `slots` counts `_geometryInfo` array length across every batch found under the
  layout's group. A batch reachable only through a layer group that is not under
  `_group` would be missed; `geometries` staying at 6–8 argues nothing was missed.
- The 1.54 MB diff includes ~460 KB of JIT code. Subtracting it leaves ~1.08 MB of
  data growth over 5 rounds, which is consistent with 0.3 MB/round × 5 within the
  precision of a snapshot diff.
