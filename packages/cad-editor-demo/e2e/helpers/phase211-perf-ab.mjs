/**
 * Phase 2.11 Task F — folds the 50k On/Off cells into one A/B summary.
 *
 * Reads the cells the slot-lifecycle spec wrote (`f50-on` / `f50-off` tags) and
 * writes `reports/phase211/phase211-browser-ab.json`: per-arm, per-op medians,
 * the delta between arms, and the raw per-round series the report quotes.
 *
 * Usage: node e2e/helpers/phase211-perf-ab.mjs [--baseline-tag=f50-on] [--after-tag=f50-off]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase211')
const sourcePath = path.join(reportsDir, 'phase211-slot-lifecycle.json')
const outputPath = path.join(reportsDir, 'phase211-browser-ab.json')

const args = new Map(
  process.argv.slice(2).map(raw => {
    const [key, value = ''] = raw.replace(/^--/, '').split('=')
    return [key, value]
  })
)
const baselineTag = args.get('baseline-tag') ?? 'f50-on'
const afterTag = args.get('after-tag') ?? 'f50-off'

const METRICS = [
  ['syncMs', 'edit (sync) ms'],
  ['undoMs', 'undo ms'],
  ['redoMs', 'redo ms'],
  ['settleMs', 'scene settle ms (4 drains)'],
  ['readyAfterMs', 'waitUntilSceneReady ms'],
  ['longestTaskMs', 'longest task ms'],
  ['heapMB', 'GC heap MB'],
  ['heapPeakMB', 'heap peak MB'],
  ['slotCapacity', 'slot capacity'],
  ['reusedSlots', 'reused slots'],
  ['geometries', 'renderer geometries'],
  ['object3dNodes', 'object3d nodes']
]

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function round(value) {
  return Math.round(value * 100) / 100
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

function summarise(cell) {
  const rows = cell.rows ?? []
  // Rounds 1-2 include the first-time convert of every batch and glyph cache
  // fill; they are the calibrating rounds, not the steady state.
  const steady = rows.slice(2)
  const sample = steady.length > 0 ? steady : rows
  const summary = { rounds: rows.length, steadyRounds: sample.length, metrics: {} }
  for (const [key, label] of METRICS) {
    const values = sample.map(row => Number(row[key] ?? 0)).filter(value => Number.isFinite(value))
    summary.metrics[key] = {
      label,
      median: round(median(values)),
      p90: round(percentile(values, 0.9)),
      min: round(Math.min(...values)),
      max: round(Math.max(...values))
    }
  }
  return summary
}

const source = fs.readFileSync(sourcePath, 'utf8')
const data = JSON.parse(source)
const cells = (data.cells ?? []).filter(cell => cell.tag === baselineTag || cell.tag === afterTag)
if (cells.length === 0) {
  throw new Error(`no cells tagged ${baselineTag}/${afterTag} in ${sourcePath}`)
}

const arms = { [baselineTag]: {}, [afterTag]: {} }
const series = {}
for (const cell of cells) {
  arms[cell.tag][cell.op] = summarise(cell)
  series[`${cell.tag}/${cell.op}`] = {
    sharing: cell.sharing,
    key: cell.key,
    rows: (cell.rows ?? []).map(row => ({
      round: row.round,
      syncMs: row.syncMs,
      undoMs: row.undoMs,
      redoMs: row.redoMs,
      settleMs: row.settleMs,
      readyAfterMs: row.readyAfterMs,
      longestTaskMs: row.longestTaskMs,
      heapMB: row.heapMB,
      heapPeakMB: row.heapPeakMB,
      slotCapacity: row.slotCapacity,
      reusedSlots: row.reusedSlots,
      geometries: row.geometries,
      object3dNodes: row.object3dNodes,
      pickCount: row.pickCount
    }))
  }
}

const comparison = {}
for (const op of Object.keys(arms[baselineTag] ?? {})) {
  const before = arms[baselineTag][op]
  const after = arms[afterTag]?.[op]
  if (!after) continue
  comparison[op] = {}
  for (const [key, label] of METRICS) {
    const a = before.metrics[key].median
    const b = after.metrics[key].median
    comparison[op][key] = {
      label,
      [baselineTag]: a,
      [afterTag]: b,
      delta: round(b - a),
      deltaPercent: a === 0 ? null : round(((b - a) / a) * 100)
    }
  }
}

const report = {
  phase: '2.11',
  task: 'F',
  source: path.relative(repoRoot, sourcePath),
  baselineTag,
  afterTag,
  sharingArms: cells.reduce((accumulator, cell) => {
    accumulator[cell.tag] = cell.sharing ?? 'unknown'
    return accumulator
  }, {}),
  definition: {
    syncMs: 'wall time of the single transaction commit (ERASE or MOVE of the whole fixture)',
    undoMs: 'transactionManager.undo() wall time',
    redoMs: 'transactionManager.redo() wall time',
    settleMs: 'sum of the four waitUntilSceneReady drains in one round',
    readyAfterMs: 'waitUntilSceneReady after the edit only',
    longestTaskMs: 'longest PerformanceObserver longtask entry seen in the round',
    baselineReference: {
      note: 'Phase 2.10 reference: snapshot sharing on 831.2 ms / off 1,286.2 ms for 50k prod MOVE',
      onMs: 831.2,
      offMs: 1286.2
    }
  },
  arms,
  comparison,
  series
}

fs.mkdirSync(reportsDir, { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const lines = [`phase 2.11 Task F — 50k A/B (${baselineTag} vs ${afterTag})`]
for (const [op, metrics] of Object.entries(comparison)) {
  lines.push(`\n[${op}]`)
  for (const key of ['syncMs', 'undoMs', 'redoMs', 'settleMs', 'readyAfterMs', 'longestTaskMs', 'heapMB', 'heapPeakMB']) {
    const entry = metrics[key]
    const percent = entry.deltaPercent === null ? 'n/a' : `${entry.deltaPercent > 0 ? '+' : ''}${entry.deltaPercent}%`
    lines.push(
      `  ${key.padEnd(14)} ${String(entry[baselineTag]).padStart(10)} → ${String(entry[afterTag]).padStart(10)}  (${percent})`
    )
  }
}
lines.push(`\nwrote ${path.relative(repoRoot, outputPath)}`)
console.log(lines.join('\n'))
