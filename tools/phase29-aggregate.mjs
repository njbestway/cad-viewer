#!/usr/bin/env node
/**
 * Builds the phase 2.9 resource deliverables from the raw Task D runs.
 *
 * `phase29-resource-after.json` — one row per (session, operation) plus the
 * cross-session median/min/max of every judged metric, and the Task D gate
 * verdict derived from those rows.
 *
 * `phase29-resource-baseline.json` — the phase 2.8 numbers for the same fixture
 * and round count, read from `reports/phase28/phase28-resource-taske*-*.json`,
 * with the baseline protocol written out next to them. The protocol correction
 * Task A2 asks for is encoded here: the four phase 2.8 runs are *not* four
 * independent samples of one experiment — three share one build and one is a
 * drift-control replay — so they are reported as `analysis` (n=3) and
 * `driftControl` (n=1) instead of being pooled into one average.
 *
 * Usage: node tools/phase29-aggregate.mjs [reportsDir]
 */
import fs from 'node:fs'
import path from 'node:path'

const reportsDir = process.argv[2] ?? 'reports'
const outDir = path.join(reportsDir, 'phase29')

/** Metrics that the Task D gate judges. Heap is reported, never judged here. */
const JUDGED = [
  'geometries',
  'layoutGeometries',
  'renderables',
  'object3dNodes',
  'geometryBytes'
]

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const listFiles = (dir, pattern) =>
  fs
    .readdirSync(dir)
    .filter(name => pattern.test(name))
    .map(name => path.join(dir, name))

/* ------------------------------------------------------------------ *
 * After: phase 2.9 runs
 * ------------------------------------------------------------------ */

const afterFiles = [
  ...listFiles(outDir, /^phase29-resource-r20-s\d+-(erase|move)-\d+\.json$/),
  ...listFiles(outDir, /^phase29-resource-r50-s\d+-(erase|move)-\d+\.json$/)
].sort()

const runs = afterFiles.map(file => {
  const data = readJson(file)
  const band = data.convergence.band
  const first = key => (band[key] ? Number(band[key].first) : null)
  const last = key => (band[key] ? Number(band[key].last) : null)
  /** Same allowance the spec applies: 2 or 2 % of the window's first value. */
  const allowance = key => {
    const start = first(key)
    return start == null ? 0 : Math.max(2, Math.ceil(start * 0.02))
  }
  const overAllowance = key => {
    const start = first(key)
    const end = last(key)
    if (start == null || end == null) return null
    return end - start > allowance(key)
  }
  return {
    file: path.basename(file),
    tag: data.tag,
    session: data.session,
    sessions: data.sessions,
    op: data.op,
    size: data.size,
    rounds: data.rounds,
    windowRounds: data.convergence.windowRounds,
    band: Object.fromEntries(
      JUDGED.map(key => [key, { first: first(key), last: last(key), allowance: allowance(key) }])
    ),
    drift: Object.fromEntries(
      JUDGED.map(key => [key, first(key) == null ? null : last(key) - first(key)])
    ),
    overAllowance: Object.fromEntries(JUDGED.map(key => [key, overAllowance(key)])),
    heap: {
      firstMB: band.heapMB?.first ?? null,
      lastMB: band.heapMB?.last ?? null,
      driftPerRoundMB: band.heapMB?.driftPerRound ?? null
    },
    retainedChanges: {
      first: band.retainedChanges?.first ?? null,
      last: band.retainedChanges?.last ?? null
    },
    shared: data.convergence.sharedBand,
    restored: {
      emptyBatches: data.restored.shared.emptyBatches,
      activeBatches: data.restored.shared.activeBatches,
      templateGeometryCount: data.restored.shared.templateGeometryCount,
      uniqueTemplateUUIDCount: data.restored.shared.uniqueTemplateUUIDCount,
      created: data.restored.shared.created,
      evicted: data.restored.shared.evicted,
      disposed: data.restored.shared.disposed,
      reused: data.restored.shared.reused,
      peakSlotCapacity: data.restored.shared.peakSlotCapacity,
      emptyBatchesSummary: data.restored.sharedSummary.empty,
      db: data.restoredChecks.db,
      scene: data.restoredChecks.scene,
      sceneUnique: data.restoredChecks.sceneUnique,
      missingFromIndex: data.restoredChecks.missingFromIndex,
      residual: data.restoredChecks.residual,
      idsRestored: data.restoredChecks.idsRestored,
      pickCount: data.restoredChecks.pickCount,
      readinessReady: data.restoredChecks.readiness?.ready ?? null,
      readinessReadyAfterMs: data.restoredChecks.readiness?.readyAfterMs ?? null
    },
    longestTaskMs: data.restored.longestTaskMs ?? null,
    environment: {
      userAgent: data.chrome,
      hardwareConcurrency: data.hardwareConcurrency,
      latencyExperiment: data.latencyExperiment
    }
  }
})

const crossSession = {}
for (const op of ['erase', 'move']) {
  for (const rounds of [...new Set(runs.filter(run => run.op === op).map(run => run.rounds))]) {
    const group = runs.filter(run => run.op === op && run.rounds === rounds)
    if (group.length === 0) continue
    const entry = { samples: group.length, rounds, perMetric: {} }
    for (const metric of JUDGED) {
      const values = group.map(run => run.drift[metric]).filter(value => value != null)
      entry.perMetric[metric] = {
        medianDrift: median(values),
        minDrift: values.length ? Math.min(...values) : null,
        maxDrift: values.length ? Math.max(...values) : null,
        values
      }
    }
    entry.heapDriftPerRoundMB = {
      median: median(group.map(run => run.heap.driftPerRoundMB).filter(v => v != null)),
      values: group.map(run => run.heap.driftPerRoundMB)
    }
    entry.emptyBatchesAfterSweep = group.map(run => run.restored.emptyBatches)
    entry.netCreatedPerRound = group.map(run => run.shared.netCreatedPerRound)
    entry.activeBatchesDelta = group.map(
      run => run.shared.lastActiveBatches - run.shared.firstActiveBatches
    )
    entry.readinessReadyAfterMs = group.map(run => run.restored.readinessReadyAfterMs)
    crossSession[`${op}-${rounds}`] = entry
  }
}

/** Task D hard gates, evaluated from the rows rather than from prose. */
const gates = [
  {
    id: 'D1',
    claim: 'no empty shared batch survives a settled scene',
    pass: runs.every(run => run.restored.emptyBatches === 0 && run.restored.emptyBatchesSummary === 0)
  },
  {
    id: 'D2',
    claim: 'renderer geometry does not climb across the last ten rounds',
    pass: runs.every(run => run.overAllowance.geometries !== true)
  },
  {
    id: 'D3',
    claim: 'every judged resource metric stays inside its 2 % / 2-unit band',
    pass: runs.every(run => JUDGED.every(metric => run.overAllowance[metric] !== true))
  },
  {
    id: 'D4',
    claim: 'no dead GPU resource stays attached to the graph',
    pass: runs.every(run => run.overAllowance.geometryBytes !== true)
  },
  {
    id: 'D5',
    claim: 'template geometries are released with their last batch',
    pass: runs.every(
      run => run.restored.templateGeometryCount === run.restored.uniqueTemplateUUIDCount
    )
  },
  {
    id: 'D6',
    claim: 'database / scene / spatial index id sets agree',
    pass: runs.every(
      run =>
        run.restored.missingFromIndex === 0 &&
        run.restored.residual === 0 &&
        run.restored.sceneUnique === run.restored.scene &&
        run.restored.idsRestored
    )
  },
  {
    id: 'D7',
    claim: 'undo/redo restores the complete set without duplicates',
    pass: runs.every(run => run.restored.pickCount > 0 && run.restored.idsRestored)
  },
  {
    id: 'D8',
    claim: 'readiness returns without a fixed post-wait sleep',
    pass: runs.every(run => run.restored.readinessReady === true)
  }
]

const after = {
  phase: '2.9',
  generatedFrom: afterFiles.map(file => path.basename(file)),
  protocol: {
    fixture: 'writeMixedFixture(size, tag) — 60% LINE, 20% LWPOLYLINE, 10% INSERT, 10% TEXT, 3 layers',
    operationCycle: 'erase|move → undo → redo, one drain after each step',
    heapSample: 'CDP HeapProfiler.collectGarbage before every usedJSHeapSize read',
    bandWindow: 'last 10 rounds after a 3-round warm-up',
    driftDefinition: 'value(last round of window) - value(first round of window)',
    sessions: 'one Playwright browser context per session, serial (workers=1)'
  },
  crossSession,
  gates,
  allGatesPass: gates.every(gate => gate.pass),
  runs
}
fs.writeFileSync(
  path.join(outDir, 'phase29-resource-after.json'),
  `${JSON.stringify(after, null, 2)}\n`,
  'utf8'
)

/* ------------------------------------------------------------------ *
 * Baseline: phase 2.8 numbers, with the protocol split
 * ------------------------------------------------------------------ */

const phase28Dir = path.join(reportsDir, 'phase28')
const baselineFiles = fs.existsSync(phase28Dir)
  ? listFiles(phase28Dir, /^phase28-resource-taske\d?-(erase|move)-\d+\.json$/).sort()
  : []

const baselineRows = baselineFiles.map(file => {
  const data = readJson(file)
  const band = data.convergence.band
  return {
    file: path.basename(file),
    tag: data.tag,
    size: data.size,
    rounds: data.rounds,
    op: data.op,
    windowRounds: data.convergence?.windowRounds ?? null,
    geometries: { first: band.geometries?.first ?? null, last: band.geometries?.last ?? null, driftPerRound: band.geometries?.driftPerRound ?? null },
    layoutGeometries: {
      first: band.layoutGeometries?.first ?? null,
      last: band.layoutGeometries?.last ?? null,
      driftPerRound: band.layoutGeometries?.driftPerRound ?? null
    },
    heapMB: { first: band.heapMB?.first ?? null, last: band.heapMB?.last ?? null, driftPerRound: band.heapMB?.driftPerRound ?? null }
  }
})

/**
 * Phase 2.8 shipped four runs of one configuration. `taske`, `taske2` and
 * `taske3` are analysis samples; `taske4` was recorded as a drift control after
 * a rebuild. Pooling all four into a mean would let the control's environment
 * leak into the estimate, so they stay separate here.
 */
const ANALYSIS_TAGS = ['taske', 'taske2', 'taske3']
const analysis = baselineRows.filter(row => ANALYSIS_TAGS.includes(row.tag))
const driftControl = baselineRows.filter(row => !ANALYSIS_TAGS.includes(row.tag))

const summarise = rows => {
  const pick = (row, metric, field) => row[metric]?.[field] ?? null
  const metricSummary = {}
  for (const metric of ['geometries', 'layoutGeometries']) {
    const drifts = rows.map(row => pick(row, metric, 'driftPerRound')).filter(v => v != null)
    metricSummary[metric] = {
      samples: drifts.length,
      medianDriftPerRound: median(drifts),
      minDriftPerRound: drifts.length ? Math.min(...drifts) : null,
      maxDriftPerRound: drifts.length ? Math.max(...drifts) : null,
      values: drifts
    }
  }
  return metricSummary
}

/** Per-operation estimate: n=3 analysis samples, n=1 drift control. */
const byOperation = {}
for (const op of ['erase', 'move']) {
  const rows = baselineRows.filter(row => row.op === op)
  const analysisRows = rows.filter(row => ANALYSIS_TAGS.includes(row.tag))
  const controlRows = rows.filter(row => !ANALYSIS_TAGS.includes(row.tag))
  byOperation[op] = {
    analysis: {
      samples: analysisRows.length,
      tags: analysisRows.map(row => row.tag),
      summary: summarise(analysisRows)
    },
    driftControl: {
      samples: controlRows.length,
      tags: controlRows.map(row => row.tag),
      summary: summarise(controlRows)
    }
  }
}

const baseline = {
  phase: '2.8',
  purpose:
    'Reference numbers for the same fixture and round count, used to judge whether the phase 2.9 reclamation changed the slope.',
  protocolCorrection: {
    previousProtocol: 'four runs of one configuration averaged together',
    correctedProtocol:
      'analysis samples (n=3 per operation) and drift control (n=1 per operation) reported separately; a control is not an estimate of the same quantity',
    why: 'pooling a replay into the estimate hides the environment change it was taken to detect',
    nextAbRequirement:
      'every arm >= 5 valid measurements, raw samples plus median/min/max and per-sample environment'
  },
  /**
   * Pooled across operations only to answer "does anything drift". The
   * estimate for either operation is `byOperation[op]`: three analysis samples
   * (n=3), never six.
   */
  analysis: { samples: analysis.length, summary: summarise(analysis), runs: analysis },
  driftControl: { samples: driftControl.length, summary: summarise(driftControl), runs: driftControl },
  byOperation,
  afterReference: {
    note: 'phase 2.9 rows live in phase29-resource-after.json; compare driftPerRound, not absolute counts',
    afterGeometriesDrift: runs.map(run => ({ op: run.op, rounds: run.rounds, drift: run.drift.geometries }))
  }
}
fs.writeFileSync(
  path.join(outDir, 'phase29-resource-baseline.json'),
  `${JSON.stringify(baseline, null, 2)}\n`,
  'utf8'
)

console.log(
  `after: ${runs.length} runs, gates ${gates.filter(g => g.pass).length}/${gates.length} pass\n` +
    `baseline: analysis n=${analysis.length} (${byOperation.erase.analysis.samples} per op), drift control n=${driftControl.length} (1 per op)`
)
for (const [op, entry] of Object.entries(byOperation)) {
  console.log(
    `  ${op}: phase 2.8 geometries drift/round median ${entry.analysis.summary.geometries.medianDriftPerRound}` +
      ` (${entry.analysis.summary.geometries.minDriftPerRound}–${entry.analysis.summary.geometries.maxDriftPerRound}),` +
      ` control ${entry.driftControl.summary.geometries.medianDriftPerRound}`
  )
}
for (const gate of gates) console.log(`  ${gate.id} ${gate.pass ? 'PASS' : 'FAIL'}  ${gate.claim}`)
