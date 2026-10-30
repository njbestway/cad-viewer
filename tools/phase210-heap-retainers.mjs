#!/usr/bin/env node
/**
 * Phase 2.10 Task F1 - retainer paths from a V8 `.heapsnapshot`.
 *
 * `phase29-heap-diff.mjs` answers *which constructor* grew; it deliberately
 * stops there. This tool answers *who keeps it alive*: for a sample of nodes of
 * the requested types it walks the reverse edge graph to a GC root and
 * aggregates the resulting paths, so a slope can be classified instead of
 * guessed (active scene object / retained undo history / bounded cache /
 * unreleased transaction or event reference / invalidated-but-referenced).
 *
 * Usage:
 *   node --max-old-space-size=8192 tools/phase210-heap-retainers.mjs \
 *     <snapshot.heapsnapshot> <out.json> [--targets=Object,PropertyArray,HeapNumber]
 *     [--samples=200] [--depth=12] [--branch=3]
 *
 * Sampling is uniform over the target population: the goal is a *proportion*
 * per retainer signature, and the first N nodes of a snapshot are ordered by
 * allocation, which is not representative.
 */
import fs from 'node:fs'

const [, , snapshotPath, outPath, ...rest] = process.argv
if (!snapshotPath || !outPath) {
  console.error(
    'usage: node tools/phase210-heap-retainers.mjs <snapshot> <out.json> ' +
      '[--targets=Object,PropertyArray] [--samples=200] [--depth=12] [--branch=3]'
  )
  process.exit(2)
}

function option(name, fallback) {
  const hit = rest.find(arg => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const targets = option('targets', 'Object,PropertyArray,HeapNumber,Vector3,Box3')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const samples = Number(option('samples', '200'))
const maxDepth = Number(option('depth', '12'))
const maxBranch = Number(option('branch', '3'))

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const { meta, node_count: nodeCount, edge_count: edgeCount } = snapshot.snapshot
const nodeFields = meta.node_fields.length
const edgeFields = meta.edge_fields.length
const typeOffset = meta.node_fields.indexOf('type')
const nameOffset = meta.node_fields.indexOf('name')
const sizeOffset = meta.node_fields.indexOf('self_size')
const edgeCountOffset = meta.node_fields.indexOf('edge_count')
const edgeTypeOffset = meta.edge_fields.indexOf('type')
const edgeNameOffset = meta.edge_fields.indexOf('name_or_index')
const edgeToOffset = meta.edge_fields.indexOf('to_node')
const nodeTypeNames = meta.node_types[typeOffset]
const edgeTypeNames = meta.edge_types[edgeTypeOffset]
const strings = snapshot.strings
const nodes = snapshot.nodes
const edges = snapshot.edges

const nameOf = index => strings[nodes[index * nodeFields + nameOffset]]
const typeOf = index => nodeTypeNames[nodes[index * nodeFields + typeOffset]]
const sizeOf = index => nodes[index * nodeFields + sizeOffset]

/**
 * Reverse adjacency in flat typed arrays: `firstRetainer[node]` is an edge
 * index, `nextRetainer[edge]` the next edge keeping the same node alive. A
 * 4.7M-node snapshot needs this to stay off the JS object heap.
 */
const firstRetainer = new Int32Array(nodeCount).fill(-1)
const nextRetainer = new Int32Array(edgeCount).fill(-1)
const retainerFrom = new Int32Array(edgeCount)
const retainerName = new Int32Array(edgeCount)
let offset = 0
for (let node = 0; node < nodeCount; node++) {
  const count = nodes[node * nodeFields + edgeCountOffset]
  for (let i = 0; i < count; i++, offset += edgeFields) {
    const edgeType = edgeTypeNames[edges[offset + edgeTypeOffset]]
    // Weak edges do not keep the target alive; following them would invent
    // retainers that the collector itself does not honour.
    if (edgeType === 'weak') continue
    const to = edges[offset + edgeToOffset] / nodeFields
    retainerFrom[offset / edgeFields] = node
    retainerName[offset / edgeFields] = edges[offset + edgeNameOffset]
    nextRetainer[offset / edgeFields] = firstRetainer[to]
    firstRetainer[to] = offset / edgeFields
  }
}

const edgeNameOf = edgeIndex => {
  const raw = retainerName[edgeIndex]
  const edgeType = edgeTypeNames[edgeOf(edgeIndex)]
  // Property names are string indices; element/internal edges carry numbers.
  return edgeType === 'element' || edgeType === 'hidden' ? `[${raw}]` : strings[raw]
}
const edgeOf = edgeIndex =>
  edges[edgeIndex * edgeFields + edgeTypeOffset]

/** Uniform sample of node indices whose name is in `targets`. */
function sampleTargets(targetName) {
  const found = []
  for (let node = 0; node < nodeCount; node++) {
    if (nameOf(node) !== targetName) continue
    found.push(node)
  }
  if (found.length <= samples) return { total: found.length, picked: found }
  const step = found.length / samples
  const picked = []
  for (let i = 0; i < samples; i++) picked.push(found[Math.floor(i * step)])
  return { total: found.length, picked }
}

/**
 * The buckets Task F1 asks for, in priority order.
 *
 * Order is load-bearing. A path is classified by its first match, and a `Box3`
 * reached through a batch slot physically passes `_geometryInfo` on the way, so
 * the bucket has to describe *why the object is held*, not *which field names
 * it*. The first hop (`boundingBox:Object`) is therefore blanked out before the
 * match: otherwise every `Box3` in the heap matches the `boundingBox` pattern and
 * lands in `invalidated-but-referenced` whether it is live or not.
 */
const CLASSIFIERS = [
  // Only reachable from an immediate-retainer row, where the owner string is the
  // holder itself and starts with the field name. Array paths never start with
  // `boundingBox:` because the first hop is stripped.
  ['object-bounding-box', /^boundingBox:object:/],
  ['retained-undo-history', /undoRecords|redoRecords|undoStack|redoStack|AcDbUndoStack|AcDbChangeRecorder|AcDbModifyChange|AcDbStructuralChange|originalStates/],
  ['unreleased-transaction-or-event', /transactionManager|AcDbTransaction|openTransactions|eventBus|listener|Listener|_handlers|addEventListener|signal/],
  ['convert-state', /_erasedConvertObjectIds|_claimedConvertObjectIds|_entityConvertGeneration|_staleConvertRejections|_deferredGeometryQueue|_pendingGeometryJobs/],
  ['freed-slot', /availableGeometryIds|geometryInfoList|_freedGeometryIds|_releasedSlots/],
  ['bounded-cache', /_missedImages|_viewportRepairOwnerIds|_transientDrawGeneration|_initializedLayouts|cache|Cache/],
  ['active-scene-object', /spatialIndex|rbush|_spatial|_layouts|AcTrLayout|_entitiesMap|AcTrScene|entityDisplay/],
  ['slot-held', /_geometryInfo|AcTrBatchedGeometryInfo|AcTrBatchedGroup|_meshWithIndexBatches|_instancedBatches/],
  ['stale-bounds', /_wcsBbox|_previousBounds|hiddenDrawSnapshot|(?:min|max):object:Box3/]
]

/**
 * Classify a retainer path by the chain that holds the object.
 *
 * `hops[0]` is the edge that names the object itself (`boundingBox:Object`), so
 * matching on it would answer "what field is this?" instead of "who keeps it
 * alive?". The remainder is used, and `boundingBox` is additionally stripped
 * from the residual.
 *
 * Immediate-retainer rows pass a single `field:type:name` string instead of an
 * array; there the string *is* the holder, so it is used whole.
 */
function classify(path) {
  const chain = Array.isArray(path)
    ? path.slice(1).join(' ').replace(/boundingBox/g, '')
    : String(path)
  for (const [label, pattern] of CLASSIFIERS) {
    if (pattern.test(chain)) return label
  }
  return 'unclassified'
}

/**
 * Walks retainers upwards. Each level is a set of nodes; the path signature is
 * the last `maxDepth` hops, which is stable enough to aggregate while staying
 * readable ("_undoRecords <- AcDbUndoStack <- transactionManager <- ...").
 */
function retainerPaths(startNode) {
  const results = []
  const queue = [{ node: startNode, path: [], seen: new Set([startNode]) }]
  while (queue.length) {
    const current = queue.shift()
    if (current.path.length >= maxDepth) {
      results.push(current.path)
      continue
    }
    const retainers = []
    for (
      let edge = firstRetainer[current.node];
      edge !== -1 && retainers.length < maxBranch;
      edge = nextRetainer[edge]
    ) {
      retainers.push(edge)
    }
    if (retainers.length === 0) {
      // No retainer: either a GC root or an unattributed native node.
      results.push([...current.path, `${current.node === 0 ? 'GC-root' : 'no-retainer'}:${nameOf(current.node)}`])
      continue
    }
    for (const edge of retainers) {
      const from = retainerFrom[edge]
      if (current.seen.has(from)) continue
      const nextSeen = new Set(current.seen)
      nextSeen.add(from)
      queue.push({
        node: from,
        path: [...current.path, `${edgeNameOf(edge)}:${nameOf(from)}`],
        seen: nextSeen
      })
    }
  }
  return results
}

/**
 * Immediate retainers only.
 *
 * V8 records a WeakMap entry as an internal `"<key> -> <value> pair"` edge, so a
 * deep walk through one reports the ephemeron table as the owner of everything
 * it values. The first hop does not have that problem: it names the structure
 * that physically holds the object (`_items:Array`, `_wcsBbox:AcTrBatchedGroup`),
 * which is the question F1 asks.
 */
function immediateRetainers(node) {
  const rows = []
  for (let edge = firstRetainer[node]; edge !== -1; edge = nextRetainer[edge]) {
    const from = retainerFrom[edge]
    rows.push(`${edgeNameOf(edge)}:${typeOf(from)}:${nameOf(from)}`)
  }
  return rows
}

const perTarget = []
for (const targetName of targets) {
  const { total, picked } = sampleTargets(targetName)
  if (total === 0) {
    perTarget.push({ target: targetName, total: 0 })
    continue
  }
  let selfSize = 0
  const signatures = new Map()
  const immediate = new Map()
  // One object can be reachable by several paths, and each path can carry a
  // different classifier. Both totals are therefore kept: `paths` answers "how
  // many references are there", `objects` answers "how many things are alive".
  // Quoting one as the other was the defect this distinction exists to stop.
  const pathByClassifier = new Map()
  const objectsByClassifier = new Map()
  for (const node of picked) {
    selfSize += sizeOf(node)
    for (const key of immediateRetainers(node)) {
      immediate.set(key, (immediate.get(key) ?? 0) + 1)
    }
    for (const path of retainerPaths(node)) {
      const key = path.slice(-6).join(' <- ')
      const entry = signatures.get(key) ?? {
        count: 0,
        objects: new Set(),
        classifier: classify(path),
        sample: path
      }
      entry.count++
      entry.objects.add(node)
      signatures.set(key, entry)

      pathByClassifier.set(entry.classifier, (pathByClassifier.get(entry.classifier) ?? 0) + 1)
      if (!objectsByClassifier.has(entry.classifier)) objectsByClassifier.set(entry.classifier, new Set())
      objectsByClassifier.get(entry.classifier).add(node)
    }
  }
  const immediateRanked = Array.from(immediate.entries())
    .map(([owner, count]) => ({ owner, count, classifier: classify(owner) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
  const ranked = Array.from(signatures.entries())
    .map(([signature, entry]) => ({ signature, ...entry, objects: entry.objects.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)

  // Both maps are built from *every* signature, not from the top 25: an earlier
  // version tallied only the truncated ranking, so its per-class totals summed to
  // more than the population they described.
  const byClassifier = Object.fromEntries([...pathByClassifier.entries()].sort((a, b) => b[1] - a[1]))
  const byClassifierObjects = Object.fromEntries(
    [...objectsByClassifier.entries()].map(([label, set]) => [label, set.size]).sort((a, b) => b[1] - a[1])
  )
  const totalPaths = [...pathByClassifier.values()].reduce((total, value) => total + value, 0)

  perTarget.push({
    target: targetName,
    total,
    sampled: picked.length,
    sampledSelfSize: selfSize,
    averageSelfSize: Math.round(selfSize / picked.length),
    /** Reference-path counts. One object can contribute several. */
    byClassifier,
    /** Distinct objects per class. Sums to at most `sampled`, never more. */
    byClassifierObjects,
    pathsPerObject: picked.length === 0 ? 0 : Math.round((totalPaths / picked.length) * 10) / 10,
    /** Who holds the object directly; unaffected by ephemeron-table edges. */
    topImmediateRetainers: immediateRanked,
    topRetainerPaths: ranked
  })
}

const report = {
  snapshot: snapshotPath,
  generatedAt: new Date().toISOString(),
  nodeCount,
  edgeCount,
  options: { targets, samples, maxDepth, maxBranch },
  perTarget
}
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(
  `[heap-retainers] ${nodeCount} nodes, ${edgeCount} edges -> ${outPath}\n` +
    perTarget
      .filter(entry => entry.total > 0)
      .map(
        entry =>
          `  ${entry.target}: ${entry.total} nodes, ${entry.pathsPerObject} paths/object, ` +
          `objects ${JSON.stringify(entry.byClassifierObjects)}`
      )
      .join('\n')
)
