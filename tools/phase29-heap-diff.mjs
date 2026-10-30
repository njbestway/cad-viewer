#!/usr/bin/env node
/**
 * Diffs two V8 `.heapsnapshot` files by self-size and instance count.
 *
 * Phase 2.9 uses it to attribute a JS-heap slope that the resource counters
 * cannot explain on their own: with every graph counter flat and the post-GC
 * heap still climbing per round, the retainer has to be named from a snapshot,
 * not inferred from the renderer's totals.
 *
 * Usage:
 *   node tools/phase29-heap-diff.mjs before.heapsnapshot after.heapsnapshot [out.json]
 *
 * The output is a table of the largest positive deltas keyed by
 * `type:constructor`, plus the totals so the rows can be checked against the
 * measured heap growth. Retainer paths are not resolved here — identifying the
 * constructor is the step that decides where to look next.
 */
import fs from 'node:fs'

const [, , beforePath, afterPath, outPath] = process.argv
if (!beforePath || !afterPath) {
  console.error('usage: node tools/phase29-heap-diff.mjs <before> <after> [out.json]')
  process.exit(2)
}

/**
 * @param {string} file
 * @returns {{ rows: Map<string, { count: number, selfSize: number }>, total: number }}
 */
function summarise(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
  const meta = snapshot.snapshot.meta
  const fields = meta.node_fields.length
  const typeOffset = 0
  const nameOffset = meta.node_fields.indexOf('name')
  const sizeOffset = meta.node_fields.indexOf('self_size')
  const typeNames = meta.node_types[typeOffset]
  const strings = snapshot.strings
  const nodes = snapshot.nodes

  /** @type {Map<string, { count: number, selfSize: number }>} */
  const rows = new Map()
  let total = 0
  const nodeCount = nodes.length / fields
  for (let i = 0; i < nodeCount; i++) {
    const base = i * fields
    const type = typeNames[nodes[base + typeOffset]]
    const name = strings[nodes[base + nameOffset]]
    const selfSize = nodes[base + sizeOffset]
    total += selfSize
    const key = `${type}:${name}`
    const row = rows.get(key)
    if (row) {
      row.count++
      row.selfSize += selfSize
    } else {
      rows.set(key, { count: 1, selfSize })
    }
  }
  return { rows, total, nodeCount }
}

const before = summarise(beforePath)
const after = summarise(afterPath)

const keys = new Set([...before.rows.keys(), ...after.rows.keys()])
const deltas = []
for (const key of keys) {
  const a = before.rows.get(key) ?? { count: 0, selfSize: 0 }
  const b = after.rows.get(key) ?? { count: 0, selfSize: 0 }
  deltas.push({
    key,
    countDelta: b.count - a.count,
    selfSizeDelta: b.selfSize - a.selfSize,
    beforeCount: a.count,
    afterCount: b.count,
    beforeSize: a.selfSize,
    afterSize: b.selfSize
  })
}

const bySize = [...deltas].sort((x, y) => y.selfSizeDelta - x.selfSizeDelta)
const byCount = [...deltas].sort((x, y) => y.countDelta - x.countDelta)

const report = {
  before: { file: beforePath, totalSelfSize: before.total, nodeCount: before.nodeCount },
  after: { file: afterPath, totalSelfSize: after.total, nodeCount: after.nodeCount },
  totalDelta: after.total - before.total,
  nodeCountDelta: after.nodeCount - before.nodeCount,
  topBySelfSize: bySize.slice(0, 40),
  topByCount: byCount.slice(0, 40)
}

const print = rows => {
  for (const row of rows) {
    if (row.selfSizeDelta === 0 && row.countDelta === 0) continue
    const kb = Math.round(row.selfSizeDelta / 1024)
    console.log(
      `${String(kb).padStart(9)} KB  ${String(row.countDelta).padStart(9)}  ` +
        `${String(row.beforeCount).padStart(8)} -> ${String(row.afterCount).padStart(8)}  ${row.key}`
    )
  }
}

console.log(
  `total self size ${Math.round(before.total / 1024 / 1024)} MB -> ` +
    `${Math.round(after.total / 1024 / 1024)} MB (${Math.round(report.totalDelta / 1024)} KB)`
)
console.log(`nodes ${before.nodeCount} -> ${after.nodeCount}`)
console.log('\ntop by self size (KB delta, count delta, before -> after):')
print(bySize.slice(0, 40))
console.log('\ntop by instance count delta:')
print(byCount.slice(0, 40))

if (outPath) {
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\nwrote ${outPath}`)
}
