#!/usr/bin/env node
/**
 * Aggregate the phase 2.9 Task F raw runs into `phase29-latency-ab.json`.
 *
 * The Playwright specs write one raw file per (tag, op, size) and one per budget
 * sweep. Each raw file keeps every individual measurement; this tool only
 * re-derives the summary from those measurements, so the numbers in the Task G
 * deliverable can always be recomputed from the stored samples.
 *
 * Two aggregations happen here:
 *
 *  1. Toggle A/B (`phase29-ab-*.json`): per arm, per step (`op`/`undo`/`redo`),
 *     the metrics Task F names. `op` is the step whose stored name is the
 *     operation itself (`erase` / `move`) — the raw data always had it; an early
 *     version of the spec's own summariser keyed on the literal `'op'` and the
 *     two 50k runs therefore shipped a summary without it. Recomputing here,
 *     from the samples, restores that step without inventing any number.
 *
 *  2. Budget sweep (`phase29-budget-sweep-*.json`): per convert slice budget.
 *
 * Besides the metric medians this prints `blockRatio` — longest event-loop gap
 * divided by the synchronous transaction time of the same step. A ratio near 1
 * says the step's longest block *is* the synchronous database call, which is
 * what decides whether shrinking the convert slice can help at all.
 *
 * Usage: node tools/phase29-latency-ab.mjs [reportsDir]
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const repoRoot = path.resolve(import.meta.dirname, '..')
const reportsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'reports', 'phase29')
const outFile = path.join(reportsDir, 'phase29-latency-ab.json')

const round = value => Math.round(value * 10) / 10

function stats(values) {
  const clean = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  if (clean.length === 0) return { n: 0, median: null, min: null, max: null }
  const sorted = [...clean].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  return { n: sorted.length, median: round(median), min: round(sorted[0]), max: round(sorted.at(-1)) }
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function pct(value, base) {
  if (value == null || base == null || base === 0) return null
  return round(((value - base) / base) * 100)
}

/** Per step: the metrics Task F asks for, taken from the stored measurements. */
function stepSummary(steps) {
  const num = pick => stats(steps.map(pick))
  const defined = pick => stats(steps.map(pick).filter(value => value != null))
  const out = {
    syncMs: num(step => step.syncMs),
    settleMs: num(step => step.settleMs),
    longestLongTaskMs: num(step => step.window.longestTaskMs),
    maxEventLoopGapMs: num(step => step.window.maxBlockMs),
    frameP95Ms: num(step => step.window.frameP95Ms),
    frameMaxMs: num(step => step.window.frameMaxMs),
    heapPeakMB: num(step => step.window.heapPeakMB),
    sceneAdds: num(step => step.sceneAdds),
    sceneRemoves: num(step => step.sceneRemoves),
    glyphFinalizers: num(
      step => step.glyphs.glyphEntityCount + step.glyphs.mtextCount + step.glyphs.shapeCount
    ),
    longTaskCount: num(step => step.window.longTaskCount),
    framesMeasured: defined(step => step.window.frameCount)
  }
  // Does the longest block coincide with the synchronous transaction call?
  out.blockRatio =
    out.maxEventLoopGapMs.median != null && out.syncMs.median
      ? round(out.maxEventLoopGapMs.median / out.syncMs.median)
      : null
  return out
}

const STEP_NAMES = ['op', 'undo', 'redo']

function summariseToggle(raw) {
  const stepNameFor = (measurement, alias) => (alias === 'op' ? measurement.op : alias)
  const summary = {}
  for (const arm of raw.arms) {
    const valid = raw.measurements.filter(item => item.arm === arm.id && item.valid)
    const steps = {}
    for (const alias of STEP_NAMES) {
      const picked = valid
        .map(item => item.steps.find(step => step.name === stepNameFor(item, alias)))
        .filter(Boolean)
      if (picked.length === 0) continue
      steps[alias] = stepSummary(picked)
    }
    summary[arm.id] = {
      discardRedundantModifyWave: arm.discardRedundantModifyWave,
      deferGeometryCooperativeYield: arm.deferGeometryCooperativeYield,
      samples: valid.length,
      invalidSamples: raw.measurements.filter(item => item.arm === arm.id && !item.valid).length,
      steps,
      cycleSettleMs: stats(valid.map(item => item.cycleSettleMs)),
      retainedChanges: stats(valid.map(item => item.convert.retainedChanges)),
      heapMB: stats(valid.map(item => item.convert.heapMB)),
      dbFingerprints: [...new Set(valid.map(item => item.setsAfterRestore.dbFingerprint))],
      sceneFingerprints: [...new Set(valid.map(item => item.setsAfterRestore.sceneFingerprint))]
    }
  }
  return summary
}

function deltas(summary, baselineId) {
  const baseline = summary[baselineId]
  if (!baseline) return null
  const out = {}
  for (const [armId, entry] of Object.entries(summary)) {
    if (armId === baselineId) continue
    const perStep = {}
    for (const alias of STEP_NAMES) {
      for (const metric of ['syncMs', 'settleMs', 'maxEventLoopGapMs', 'heapPeakMB']) {
        perStep[`${alias}.${metric}`] = pct(
          entry.steps[alias]?.[metric]?.median ?? null,
          baseline.steps[alias]?.[metric]?.median ?? null
        )
      }
    }
    perStep.cycleSettleMs = pct(entry.cycleSettleMs.median, baseline.cycleSettleMs.median)
    out[armId] = perStep
  }
  return out
}

/* ------------------------------------------------------------------ */

const files = fs.readdirSync(reportsDir).filter(name => name.endsWith('.json')).sort()
const toggleFiles = files.filter(name => /^phase29-ab-.*\.json$/.test(name))
const budgetFiles = files.filter(name => /^phase29-budget-sweep-.*\.json$/.test(name))

const toggle = []
for (const name of toggleFiles) {
  const file = path.join(reportsDir, name)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const summary = summariseToggle(raw)
  const baseline = raw.baseline ?? 'both-off'
  toggle.push({
    source: name,
    sourceSha256: sha256(file),
    sourceBytes: fs.statSync(file).size,
    tag: raw.tag,
    op: raw.op,
    size: raw.size,
    samplesPerArm: raw.samplesPerArm,
    cycles: raw.cycles,
    cycleOrder: raw.cycleOrder,
    baseline,
    environment: raw.environment,
    experiment: raw.experiment,
    summary,
    deltasVsBaselinePercent: deltas(summary, baseline)
  })
}

const budgetSweeps = []
for (const name of budgetFiles) {
  const file = path.join(reportsDir, name)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const perBudget = {}
  const ordered = [...raw.budgets].sort((a, b) => b - a)
  const reference = ordered[0]
  for (const budgetMs of raw.budgets) {
    const valid = raw.samples.filter(item => item.budgetMs === budgetMs && item.valid)
    const entry = {
      samples: valid.length,
      eraseSyncMs: stats(valid.map(item => item.step.syncMs)),
      eraseSettleMs: stats(valid.map(item => item.step.settleMs)),
      undoSettleMs: stats(valid.map(item => item.undo.settleMs)),
      redoSettleMs: stats(valid.map(item => item.redo.settleMs)),
      cycleSettleMs: stats(valid.map(item => item.cycleSettleMs)),
      longestLongTaskMs: stats(valid.map(item => item.step.window.longestTaskMs)),
      maxEventLoopGapMs: stats(valid.map(item => item.step.window.maxBlockMs)),
      frameP95Ms: stats(valid.map(item => item.step.window.frameP95Ms)),
      frameMaxMs: stats(valid.map(item => item.step.window.frameMaxMs)),
      heapPeakMB: stats(valid.map(item => item.step.window.heapPeakMB)),
      sceneAdds: stats(valid.map(item => item.step.sceneAdds))
    }
    entry.blockRatio =
      entry.maxEventLoopGapMs.median != null && entry.eraseSyncMs.median
        ? round(entry.maxEventLoopGapMs.median / entry.eraseSyncMs.median)
        : null
    perBudget[`${budgetMs}`] = entry
  }
  const referenceEntry = perBudget[`${reference}`]
  for (const entry of Object.values(perBudget)) {
    entry.vsReferencePercent = {
      reference: `${reference} ms`,
      cycleSettleMs: pct(entry.cycleSettleMs.median, referenceEntry.cycleSettleMs.median),
      undoSettleMs: pct(entry.undoSettleMs.median, referenceEntry.undoSettleMs.median),
      maxEventLoopGapMs: pct(
        entry.maxEventLoopGapMs.median,
        referenceEntry.maxEventLoopGapMs.median
      ),
      heapPeakMB: pct(entry.heapPeakMB.median, referenceEntry.heapPeakMB.median)
    }
  }
  budgetSweeps.push({
    source: name,
    sourceSha256: sha256(file),
    sourceBytes: fs.statSync(file).size,
    tag: raw.tag,
    size: raw.size,
    samplesPerArm: raw.samplesPerArm,
    cycleOrder: raw.cycleOrder,
    budgets: raw.budgets,
    deferredPumpUnchanged: raw.deferredPumpUnchanged,
    environment: raw.environment,
    perBudget
  })
}

const report = {
  kind: 'phase29-latency-ab',
  generatedBy: 'tools/phase29-latency-ab.mjs',
  note:
    'Non-production measurement. Every arm carries the phase 2.9 lifecycle work; the arms only toggle the two phase 2.8 scheduling behaviours. Latency thresholds are deliberately not asserted anywhere.',
  toggle,
  budgetSweeps
}

fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`wrote ${path.relative(repoRoot, outFile)}`)
for (const run of toggle) {
  for (const [armId, entry] of Object.entries(run.summary)) {
    const op = entry.steps.op
    const undo = entry.steps.undo
    const redo = entry.steps.redo
    console.log(
      `[ab] ${run.tag} ${run.op}/${run.size} ${armId.padEnd(13)} n=${entry.samples} ` +
        `op ${op?.settleMs.median}/${op?.maxEventLoopGapMs.median} ms ` +
        `undo ${undo?.settleMs.median} redo ${redo?.settleMs.median} ` +
        `adds ${op?.sceneAdds.median}/${undo?.sceneAdds.median}`
    )
  }
}
for (const sweep of budgetSweeps) {
  for (const [budgetMs, entry] of Object.entries(sweep.perBudget)) {
    console.log(
      `[budget] ${sweep.tag} ${budgetMs} ms n=${entry.samples} ` +
        `erase ${entry.eraseSettleMs.median} undo ${entry.undoSettleMs.median} ` +
        `cycle ${entry.cycleSettleMs.median} gap ${entry.maxEventLoopGapMs.median} ` +
        `p95 ${entry.frameP95Ms.median} heap ${entry.heapPeakMB.median}`
    )
  }
}