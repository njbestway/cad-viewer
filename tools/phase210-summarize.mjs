#!/usr/bin/env node
/**
 * Phase 2.10 deliverable reducer.
 *
 * Reads the raw Phase 2.10 artifacts and emits the two comparison snapshots the
 * spec asks for (`phase210-baseline.json` = sharing off, `phase210-after.json` =
 * sharing on) plus a compact text table used while writing the markdown reports.
 *
 * Nothing here re-runs a benchmark: it only reshapes what the runners already
 * wrote, so the numbers in the reports stay traceable to a single source file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const outDir = path.join(repoRoot, 'reports', 'phase210')
const nodeDir = path.join(outDir, 'node')

const round = (value, digits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const ratio = (after, before) => (before ? round(after / before, 4) : null)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function loadNodeBenchmarks() {
  const rows = []
  for (const file of fs.readdirSync(nodeDir)) {
    const match = /^node-move-(\d+)\.json$/.exec(file)
    if (!match) continue
    const data = readJson(path.join(nodeDir, file))
    const off = data.arms.sharingOff
    const on = data.arms.sharingOn
    rows.push({
      size: Number(match[1]),
      generatedAt: data.generatedAt,
      runtime: data.runtime,
      samplesPerArm: data.fixture.samplesPerArm,
      off: {
        openMs: round(off.openMs.median, 3),
        transformMs: round(off.transformMs.median, 3),
        commitMs: round(off.commitMs.median, 3),
        undoMs: round(off.undoMs.median, 3),
        redoMs: round(off.redoMs.median, 3),
        totalMs: round(off.totalMs.median, 3),
        clones:
          off.rollbackSnapshotClones +
          off.beforeSnapshotClones +
          off.afterSnapshotClones,
        beforeSnapshotClones: off.beforeSnapshotClones,
        afterSnapshotClones: off.afterSnapshotClones,
        rollbackSnapshotClones: off.rollbackSnapshotClones,
        sharedBeforeSnapshotCount: off.sharedBeforeSnapshotCount,
        copyOnWriteCount: off.copyOnWriteCount,
        retainedSnapshotBytesEstimated: off.retainedSnapshotBytesEstimated,
        retainedUndoChanges: off.retainedUndoChanges
      },
      on: {
        openMs: round(on.openMs.median, 3),
        transformMs: round(on.transformMs.median, 3),
        commitMs: round(on.commitMs.median, 3),
        undoMs: round(on.undoMs.median, 3),
        redoMs: round(on.redoMs.median, 3),
        totalMs: round(on.totalMs.median, 3),
        clones:
          on.rollbackSnapshotClones + on.beforeSnapshotClones + on.afterSnapshotClones,
        beforeSnapshotClones: on.beforeSnapshotClones,
        afterSnapshotClones: on.afterSnapshotClones,
        rollbackSnapshotClones: on.rollbackSnapshotClones,
        sharedBeforeSnapshotCount: on.sharedBeforeSnapshotCount,
        copyOnWriteCount: on.copyOnWriteCount,
        retainedSnapshotBytesEstimated: on.retainedSnapshotBytesEstimated,
        retainedUndoChanges: on.retainedUndoChanges
      }
    })
  }
  rows.sort((a, b) => a.size - b.size)
  return rows
}

function reduceNode(rows) {
  return {
    kind: 'node-benchmark',
    fixture: 'model-space lines, one MOVE transaction per sample',
    samplesPerArm: rows[0]?.samplesPerArm ?? null,
    interleaved: true,
    sizes: Object.fromEntries(
      rows.map(row => [
        row.size,
        {
          size: row.size,
          runtime: row.runtime,
          generatedAt: row.generatedAt,
          sharingOff: row.off,
          sharingOn: row.on,
          delta: {
            clonesRatio: ratio(row.on.clones, row.off.clones),
            cloneReductionPct: round((1 - row.on.clones / row.off.clones) * 100, 1),
            totalMsRatio: ratio(row.on.totalMs, row.off.totalMs),
            openMsRatio: ratio(row.on.openMs, row.off.openMs),
            commitMsRatio: ratio(row.on.commitMs, row.off.commitMs),
            retainedBytesRatio: ratio(
              row.on.retainedSnapshotBytesEstimated,
              row.off.retainedSnapshotBytesEstimated
            )
          }
        }
      ])
    )
  }
}

function median(values) {
  const clean = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (!clean.length) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2
}

function loadBrowser() {
  const file = path.join(outDir, 'phase210-browser-ab.json')
  if (!fs.existsSync(file)) return null
  const data = readJson(file)
  const out = { kind: 'browser-ab', modes: {} }
  for (const [mode, modeData] of Object.entries(data.modes ?? {})) {
    const sizes = {}
    for (const [sizeKey, entry] of Object.entries(modeData.sizes ?? {})) {
      const runs = entry.runs ?? []
      const off = runs.filter(r => r.sharing === false)
      const on = runs.filter(r => r.sharing === true)
      const pick = (list, path) =>
        median(list.map(r => path.split('.').reduce((acc, key) => acc?.[key], r)))
      const build = list => ({
        samples: list.length,
        editMs: round(pick(list, 'editMs'), 1),
        settleMs: round(pick(list, 'settleMs'), 1),
        undoMs: round(pick(list, 'undoMs'), 1),
        redoMs: round(pick(list, 'redoMs'), 1),
        recordModifyMs: round(pick(list, 'kernelMs.recordModifyMs'), 1),
        commitMs: round(pick(list, 'kernelMs.commitMs'), 1),
        openForWriteMs: round(pick(list, 'kernelMs.openForWriteMs'), 1),
        clones:
          (pick(list, 'clones.rollbackSnapshotClones') ?? 0) +
          (pick(list, 'clones.beforeSnapshotClones') ?? 0) +
          (pick(list, 'clones.afterSnapshotClones') ?? 0),
        sharedBeforeSnapshotCount: pick(list, 'clones.sharedBeforeSnapshotCount'),
        copyOnWriteCount: pick(list, 'clones.copyOnWriteCount'),
        batchEntriesAfter: pick(list, 'batchEntriesAfter')
      })
      const offAgg = build(off)
      const onAgg = build(on)
      sizes[sizeKey] = {
        size: entry.size,
        userAgent: entry.userAgent,
        generatedAt: modeData.generatedAt,
        sharingOff: offAgg,
        sharingOn: onAgg,
        delta: {
          editMsRatio: ratio(onAgg.editMs, offAgg.editMs),
          editMsReductionPct: round((1 - onAgg.editMs / offAgg.editMs) * 100, 1),
          settleMsRatio: ratio(onAgg.settleMs, offAgg.settleMs),
          settleMsReductionPct: round((1 - onAgg.settleMs / offAgg.settleMs) * 100, 1),
          undoMsRatio: ratio(onAgg.undoMs, offAgg.undoMs),
          redoMsRatio: ratio(onAgg.redoMs, offAgg.redoMs),
          clonesRatio: ratio(onAgg.clones, offAgg.clones),
          cloneReductionPct: round((1 - onAgg.clones / offAgg.clones) * 100, 1)
        }
      }
    }
    out.modes[mode] = { mode, generatedAt: modeData.generatedAt, sizes }
  }
  return out
}

function loadHeap() {
  const seriesFile = path.join(outDir, 'phase210-heap-series.json')
  const diffFile = path.join(outDir, 'phase210-heap-diff.json')
  const retainersFile = path.join(outDir, 'phase210-heap-retainers.json')
  const slotsFile = path.join(outDir, 'phase210-batch-slots.json')
  const out = { kind: 'heap-retention', series: null, diff: null, retainers: null, slots: null }
  if (fs.existsSync(seriesFile)) out.series = readJson(seriesFile)
  if (fs.existsSync(diffFile)) out.diff = readJson(diffFile)
  if (fs.existsSync(retainersFile)) out.retainers = readJson(retainersFile)
  if (fs.existsSync(slotsFile)) out.slots = readJson(slotsFile)
  return out
}

function loadA2() {
  const file = path.join(outDir, 'a2-run.log')
  if (!fs.existsSync(file)) return null
  // `Tee-Object` writes UTF-16LE, so reading it as UTF-8 leaves a NUL between
  // every character; strip those before matching. (`fromCharCode(0)` rather than
  // a `\u0000` literal keeps the lint rule about control characters quiet.)
  const text = fs.readFileSync(file, 'utf8').split(String.fromCharCode(0)).join('')
  const passed = /(\d+)\s+passed/.exec(text)
  const failed = /(\d+)\s+failed/.exec(text)
  const passedCount = passed ? Number(passed[1]) : null
  return {
    log: path.relative(repoRoot, file).replace(/\\/g, '/'),
    passed: passedCount,
    // Jest omits the `N failed` fragment entirely on a clean run, so a nonzero
    // `passed` with no `failed` match means zero failures — not "unknown".
    failed: failed ? Number(failed[1]) : passedCount === null ? null : 0
  }
}

const nodeRows = loadNodeBenchmarks()
const browser = loadBrowser()
const heap = loadHeap()
const a2 = loadA2()

const shared = {
  phase: '2.10',
  feature: 'Transaction Snapshot Sharing',
  dependency: '@mlightcad/data-model@1.15.16-perf.3',
  generatedAt: new Date().toISOString(),
  nodeBenchmark: reduceNode(nodeRows),
  browserAb: browser,
  heapRetentionAudit: {
    series: heap.series ? { experiments: heap.series.experiments ?? heap.series } : null,
    diffTop: heap.diff?.topByCount ?? heap.diff?.top ?? null,
    retainers: heap.retainers,
    batchSlots: heap.slots ? { size: heap.slots.size, rows: heap.slots.rows } : null
  },
  sceneReadinessSupplement: a2
}

const baseline = {
  ...shared,
  arm: 'sharing-off',
  description: 'Snapshot Sharing disabled: every transaction materialises rollback + before + after snapshots (3N clones).'
}
const after = {
  ...shared,
  arm: 'sharing-on',
  description: 'Snapshot Sharing enabled: the before snapshot aliases the live object state (2N clones), copy-on-write is used for later writes.'
}

fs.writeFileSync(path.join(outDir, 'phase210-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'phase210-after.json'), `${JSON.stringify(after, null, 2)}\n`)

// Compact console table so the report numbers can be copied without re-parsing.
const pad = (value, width) => String(value ?? '-').padStart(width)
// The reports write a speed-up as a negative delta ("−15.2 %"); keep the same
// convention here so the plain-text table can be copied without sign flipping.
const delta = (pct) =>
  typeof pct === 'number' && Number.isFinite(pct)
    ? `${pct >= 0 ? '-' : '+'}${Math.abs(pct).toFixed(1)}%`
    : '-'
const lines = []
lines.push('NODE BENCHMARK (median of 5 samples, interleaved)')
lines.push(
  [
    pad('size', 7),
    pad('clones off', 11),
    pad('clones on', 10),
    pad('dClones', 8),
    pad('total off', 10),
    pad('total on', 9),
    pad('dTotal%', 8),
    pad('open off', 9),
    pad('open on', 8),
    pad('dOpen%', 8),
    pad('retained ratio', 15)
  ].join(' ')
)
for (const row of nodeRows) {
  lines.push(
    [
      pad(row.size, 7),
      pad(row.off.clones, 11),
      pad(row.on.clones, 10),
      pad(delta(round((1 - row.on.clones / row.off.clones) * 100, 1)), 8),
      pad(row.off.totalMs, 10),
      pad(row.on.totalMs, 9),
      pad(delta(round((1 - row.on.totalMs / row.off.totalMs) * 100, 1)), 8),
      pad(row.off.openMs, 9),
      pad(row.on.openMs, 8),
      pad(delta(round((1 - row.on.openMs / row.off.openMs) * 100, 1)), 8),
      pad(round(row.on.retainedSnapshotBytesEstimated / row.off.retainedSnapshotBytesEstimated, 3), 15)
    ].join(' ')
  )
}

if (browser) {
  lines.push('')
  lines.push('BROWSER A/B (CAD editor demo, 3-5 interleaved samples per size)')
  for (const [mode, modeData] of Object.entries(browser.modes)) {
    lines.push(
      [
        pad(mode, 5),
        pad('size', 7),
        pad('edit off', 10),
        pad('edit on', 9),
        pad('dEdit', 7),
        pad('settle off', 11),
        pad('settle on', 10),
        pad('dSettle%', 9),
        pad('undo off/on', 13),
        pad('redo off/on', 13),
        pad('clones', 16)
      ].join(' ')
    )
    for (const [sizeKey, entry] of Object.entries(modeData.sizes)) {
      const d = entry.delta
      lines.push(
        [
          pad('', 5),
          pad(sizeKey, 7),
          pad(entry.sharingOff.editMs, 10),
          pad(entry.sharingOn.editMs, 9),
          pad(delta(d.editMsReductionPct), 7),
          pad(entry.sharingOff.settleMs, 11),
          pad(entry.sharingOn.settleMs, 10),
          pad(delta(d.settleMsReductionPct), 9),
          pad(`${entry.sharingOff.undoMs}/${entry.sharingOn.undoMs}`, 13),
          pad(`${entry.sharingOff.redoMs}/${entry.sharingOn.redoMs}`, 13),
          pad(`${entry.sharingOff.clones}->${entry.sharingOn.clones}`, 16)
        ].join(' ')
      )
    }
  }
}

const table = lines.join('\n')
fs.writeFileSync(path.join(outDir, 'phase210-summary.txt'), `${table}\n`)
console.log(table)
