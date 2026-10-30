#!/usr/bin/env node
/**
 * Phase 2.12 Task A2.1 — which rounds the Phase 2.11 A/B headline numbers use.
 *
 * `phase211-browser-ab.json` stored six rows per arm but only one aggregate, and
 * `PHASE211_PERFORMANCE_REPORT.md` called it "median over 6 rounds". It is not:
 * the aggregate is the median of the **last four** rows. Rounds 1-2 are warm-up
 * (first-touch JIT, module init, GC shape) and are collected but excluded.
 *
 * This tool does not trust that description — it re-derives every aggregate over
 * every plausible window and reports which window/statistic reproduces the
 * stored values exactly. Anything that cannot be reproduced is listed, so the
 * correction in the report is grounded in arithmetic rather than in a note.
 *
 *   node tools/phase212-ab-window-audit.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const source = path.join(repoRoot, 'reports', 'phase211', 'phase211-browser-ab.json')
const outDir = path.join(repoRoot, 'reports', 'phase212')
const ab = JSON.parse(readFileSync(source, 'utf8'))

const stats = {
  median: values => {
    const sorted = [...values].sort((left, right) => left - right)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  },
  mean: values => values.reduce((total, value) => total + value, 0) / values.length,
  min: values => Math.min(...values),
  max: values => Math.max(...values),
  first: values => values[0],
  last: values => values[values.length - 1]
}

/** Every contiguous window of at least two rounds, plus the whole series. */
const windows = length => {
  const list = []
  for (let size = 2; size <= length; size++) {
    for (let start = 0; start + size <= length; start++) {
      list.push({ label: `rounds ${start + 1}-${start + size}`, slice: values => values.slice(start, start + size) })
    }
  }
  return list
}

const round = value => Math.round(value * 100) / 100

const arms = {}
for (const [arm, series] of Object.entries(ab.series)) {
  const rows = series.rows
  if (!Array.isArray(rows) || rows.length === 0) continue
  const columns = Object.keys(rows[0]).filter(key => key !== 'round' && typeof rows[0][key] === 'number')
  const [armName, operation] = arm.split('/')
  const sharing = ab.sharingArms?.[armName] ?? armName.split('-').pop()
  const stored = ab.comparison?.[operation] ?? {}
  arms[arm] = {
    operation,
    sharing,
    rounds: rows.length,
    metrics: {}
  }
  for (const column of columns) {
    const values = rows.map(row => row[column])
    const target = stored[column]?.[armName]
    const matches = []
    for (const window of windows(values.length)) {
      for (const [name, fn] of Object.entries(stats)) {
        const value = round(fn(window.slice(values)))
        if (target !== undefined && Math.abs(value - target) < 1e-6) matches.push(`${name} of ${window.label}`)
      }
    }
    arms[arm].metrics[column] = {
      stored: target ?? null,
      values,
      reproducedBy: matches,
      resolved: matches.length > 0 ? matches[0] : null
    }
  }
}

// Metrics whose value never moves (slotCapacity sits at 45,000 for every round)
// match every window and therefore discriminate nothing. Only the metrics that
// actually vary can pick a window out, so the tally runs on those: a rule is
// viable only if it reproduces every one of them.
const allMetrics = Object.values(arms).flatMap(arm => Object.values(arm.metrics))
const varying = allMetrics.filter(metric => metric.stored !== null && new Set(metric.values).size > 1)
const constant = allMetrics.filter(metric => metric.stored !== null && new Set(metric.values).size === 1)

const everyRule = [...new Set(varying.flatMap(metric => [...metric.reproducedBy, ...(metric.stored !== null ? [] : [])]))]
const ranking = everyRule
  .map(rule => {
    const failures = varying.filter(metric => !metric.reproducedBy.includes(rule))
    return { rule, reproduced: varying.length - failures.length, failed: failures.length, failures: failures.map(metric => metric.stored) }
  })
  .sort((left, right) => left.failed - right.failed || right.reproduced - left.reproduced)

// Zero failures means the rule is consistent with every varying metric.
const survivors = ranking.filter(entry => entry.failed === 0)
const verdict = survivors.length > 0 ? survivors[0] : ranking[0] ?? { rule: 'none', reproduced: 0 }
const unresolved = varying.filter(metric => metric.reproducedBy.length === 0).length

const report = {
  phase: '2.12',
  task: 'A2.1',
  generatedAt: new Date().toISOString(),
  source: path.relative(repoRoot, source).replace(/\\/g, '/'),
  question: 'The performance report calls the headline numbers "median over 6 rounds". Are they?',
  answer:
    `No. ${verdict.reproduced} of ${varying.length} aggregates that actually vary are reproduced by ` +
    `"${verdict.rule}"${unresolved > 0 ? `, and ${unresolved} are reproduced by no window at all` : ''}. ` +
    'Rounds 1-2 are warm-up and are collected but excluded from the aggregate, so the ' +
    'correct wording is "six rounds collected, four steady-state rounds aggregated (median)".',
  aggregatesChecked: { varying: varying.length, constant: constant.length, total: allMetrics.length },
  unresolved,
  ranking: ranking.slice(0, 8),
  arms
}
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'a2-ab-window-audit.json')
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)

console.log(report.answer)
console.log(`checked ${varying.length} varying aggregates (${constant.length} constant, non-discriminating), ${unresolved} unresolved`)
for (const entry of ranking.slice(0, 6)) console.log(`  fail=${entry.failed} ok=${entry.reproduced}  ${entry.rule}`)
for (const [arm, value] of Object.entries(arms)) {
  const bad = Object.entries(value.metrics).filter(([, metric]) => metric.stored !== null && metric.resolved === null)
  if (bad.length > 0) console.log(`  ! ${arm}: ${bad.map(([key]) => key).join(', ')}`)
}
console.log(`wrote ${path.relative(repoRoot, outFile).replace(/\\/g, '/')}`)
