#!/usr/bin/env node
/**
 * Rank a CDP `HeapProfiler.stopSampling` profile by self size.
 *
 * The sampling profile is a call tree where every node carries the bytes
 * *allocated* by that frame during the sampling window. It answers "which code
 * allocates the objects that pile up" — the retainer question itself is
 * answered by the history probe in `phase29-heap-attribution.spec.ts`.
 *
 * Note the asymmetry with a heap snapshot: sampling counts allocation, not
 * survival. An entry here still needs the snapshot diff to confirm the objects
 * are alive.
 *
 * Usage: node tools/phase29-heap-sampling.mjs <profile.json> [out.json] [top]
 */

import fs from 'node:fs'
import path from 'node:path'

const [, , input, output, topArg] = process.argv
if (!input) {
  console.error('usage: node tools/phase29-heap-sampling.mjs <profile.json> [out.json] [top]')
  process.exit(1)
}
const top = Number(topArg ?? 30)

const profile = JSON.parse(fs.readFileSync(input, 'utf8'))
const root = profile.profile ?? profile

const frames = new Map()
let totalBytes = 0
let nodeCount = 0

const walk = node => {
  nodeCount += 1
  const callFrame = node.callFrame ?? {}
  const url = String(callFrame.url ?? '')
  const key = `${callFrame.functionName || '(anonymous)'} @ ${url.replace(/^https?:\/\/[^/]+/, '')}:${
    (callFrame.lineNumber ?? -1) + 1
  }`
  const entry = frames.get(key) ?? { key, selfBytes: 0, nodes: 0 }
  entry.selfBytes += node.selfSize ?? 0
  entry.nodes += 1
  frames.set(key, entry)
  totalBytes += node.selfSize ?? 0
  for (const child of node.children ?? []) walk(child)
}
walk(root.head ?? root)

const ranked = [...frames.values()].sort((a, b) => b.selfBytes - a.selfBytes)
const report = {
  source: path.basename(input),
  nodeCount,
  totalAllocatedMB: Math.round((totalBytes / 1048576) * 10) / 10,
  top: ranked.slice(0, top).map(entry => ({
    frame: entry.key,
    allocatedMB: Math.round((entry.selfBytes / 1048576) * 100) / 100,
    sampleNodes: entry.nodes
  }))
}

if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`${report.source}: ${report.totalAllocatedMB} MB allocated across ${nodeCount} frames`)
for (const entry of report.top) {
  console.log(`  ${String(entry.allocatedMB).padStart(9)} MB  ${entry.frame}`)
}
if (output) console.log(`wrote ${output}`)