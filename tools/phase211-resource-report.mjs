/**
 * Phase 2.11 Task E/F — resource convergence report builder.
 *
 * Folds `reports/phase211/phase211-slot-lifecycle.json` (written by
 * `packages/cad-editor-demo/e2e/tests/phase211-slot-lifecycle.spec.ts`) into
 * `reports/phase211/phase211-resource-{baseline,after}.json`:
 *
 * - lifecycle cells (convergence loop) keep a trimmed per-round series plus a
 *   `band()` summary over the post-warm-up window,
 * - one-shot cells (close / race probes) are carried through whole, since they
 *   have no `final` / `convergence` block,
 * - a 3-round warm-up can consume the whole window, so those cells also get a
 *   `convergenceNote` telling the reader to use the rows instead of the summary.
 *
 *   node tools/phase211-resource-report.mjs
 */
import fs from 'node:fs'

const src = JSON.parse(
  fs.readFileSync('reports/phase211/phase211-slot-lifecycle.json', 'utf8')
)
const baseline = JSON.parse(
  fs.readFileSync('reports/phase210/phase210-batch-slots.json', 'utf8')
)
const heapSeries = JSON.parse(
  fs.readFileSync('reports/phase210/phase210-heap-series.json', 'utf8')
)

const KEEP_ROUND_KEYS = [
  'round',
  'heapMB',
  'heapPeakMB',
  'slotCapacity',
  'liveSlots',
  'freeListSize',
  'invalidSlots',
  'inactiveBoundingBoxes',
  'retainedHiddenSnapshots',
  'liveBoundingBoxes',
  'reusedSlots',
  'deleteGeometryCalls',
  'duplicateFreeAttempts',
  'slotHighWaterMark',
  'batches',
  'geometries',
  'object3dNodes',
  'activeSharedBatches',
  'emptySharedBatches',
  'undoRecords',
  'redoRecords',
  'syncMs',
  'undoMs',
  'redoMs',
  'settleMs',
  'readyAfterMs',
  'longestTaskMs',
  'db',
  'scene',
  'index',
  'missingFromScene',
  'residualInScene',
  'missingFromIndex',
  'residualInIndex'
]

const trimRow = row => {
  const out = {}
  for (const key of KEEP_ROUND_KEYS) out[key] = row[key]
  return out
}

const pick = (obj, keys) => {
  if (!obj) return null
  const out = {}
  for (const key of keys) out[key] = obj[key]
  return out
}

const FINAL_KEYS = [
  'slots',
  'heapMB',
  'renderer',
  'shared',
  'sharedSummary',
  'ids',
  'convert',
  'pick',
  'sweptEmptySharedBatches'
]

const lifecycle = []
const oneShot = []
for (const cell of src.cells) {
  const base = {
    key: cell.key,
    tag: cell.tag,
    size: cell.size,
    rounds: cell.rounds,
    op: cell.op,
    session: cell.session,
    sessions: cell.sessions,
    sharing: cell.sharing,
    fixture: cell.fixture,
    chrome: cell.chrome,
    hardwareConcurrency: cell.hardwareConcurrency,
    idsHash: cell.idsHash
  }
  if (cell.final && cell.convergence) {
    const shortWindow = (cell.rows ?? []).length <= 4
    lifecycle.push({
      ...base,
      convergence: cell.convergence,
      ...(shortWindow
        ? {
            convergenceNote:
              'band() skips a 3-round warm-up, so a 3/4-round cell reports an empty window; read rows instead'
          }
        : {}),
      final: pick(cell.final, FINAL_KEYS),
      rows: (cell.rows ?? []).map(trimRow)
    })
  } else {
    // close / race cells: keep their whole shape (minus rows, which are empty)
    const rest = { ...cell }
    delete rest.rows
    oneShot.push({ ...base, ...rest })
  }
}

/** Collapses the per-session cells into one convergence row per (size, op). */
function summarize(cells) {
  const groups = new Map()
  for (const cell of cells) {
    if (cell.tag === 'smoke') continue
    const key = `${cell.size}/${cell.op}`
    const group = groups.get(key) ?? { size: cell.size, op: cell.op, sessions: [] }
    group.sessions.push({
      key: cell.key,
      rounds: cell.rounds,
      sharing: cell.sharing,
      capacity: cell.convergence.capacity,
      live: cell.convergence.live,
      heap: cell.convergence.heap,
      geometries: cell.convergence.geometries,
      object3d: cell.convergence.object3d,
      capacityPerRound: cell.convergence.capacityPerRound,
      invalidSlots: cell.final.slots ? cell.final.slots.invalidSlots : null,
      freeListSize: cell.final.slots ? cell.final.slots.freeListSize : null,
      duplicateFreeAttempts: cell.final.slots ? cell.final.slots.duplicateFreeAttempts : null,
      retainedHiddenSnapshots: cell.final.slots ? cell.final.slots.retainedHiddenSnapshots : null,
      inactiveBoundingBoxes: cell.final.slots ? cell.final.slots.inactiveBoundingBoxes : null
    })
    groups.set(key, group)
  }
  return Array.from(groups.values()).sort(
    (a, b) => a.size - b.size || a.op.localeCompare(b.op)
  )
}

const after = {
  phase: '2.11',
  generatedAt: new Date().toISOString(),
  source: 'reports/phase211/phase211-slot-lifecycle.json',
  cellCount: src.cells.length,
  lifecycleCellCount: lifecycle.length,
  oneShotCellCount: oneShot.length,
  /** One row per (size, op), so a report can cite a convergence without a join. */
  summary: summarize(lifecycle),
  lifecycle,
  oneShot
}

const before = {
  phase: '2.11',
  task: 'E2 baseline',
  generatedAt: new Date().toISOString(),
  provenance: {
    slotArithmetic:
      'reports/phase210/phase210-batch-slots.json (phase 2.10 F1, pre-fix build)',
    heapSeries:
      'reports/phase210/phase210-heap-series.json (phase 2.10 F2, pre-fix build)',
    code: 'phase 2.10 tree: deleteGeometryById never repopulated the free list because optimize() cleared it, so reserveGeometryId always appended'
  },
  measured: {
    size: baseline.size,
    rounds: baseline.rounds,
    slotsPerRound: 1800,
    boundingBoxesPerRound: 200,
    freeListSizeEverySample: 0,
    note: baseline.note
  },
  rows: baseline.rows,
  heapSeriesKeys: Object.keys(heapSeries)
}

fs.writeFileSync(
  'reports/phase211/phase211-resource-baseline.json',
  JSON.stringify(before, null, 2) + '\n'
)
fs.writeFileSync(
  'reports/phase211/phase211-resource-after.json',
  JSON.stringify(after, null, 2) + '\n'
)

for (const cell of lifecycle) {
  const c = cell.convergence
  console.log(
    [
      cell.key.padEnd(30),
      `cap ${c.capacity.first}->${c.capacity.last}`,
      `live ${c.live.first}->${c.live.last}`,
      `heap ${c.heap.first}->${c.heap.last}`,
      `geo ${c.geometries.first}->${c.geometries.last}`,
      `o3d ${c.object3d.first}->${c.object3d.last}`,
      `drift ${
        c.capacityPerRound === undefined ? 'n/a' : c.capacityPerRound
      }/round`,
      `invalid ${cell.final.slots ? cell.final.slots.invalidSlots : 'n/a'}`
    ].join('  ')
  )
}
console.log(`\nlifecycle ${lifecycle.length} / oneShot ${oneShot.length}`)
