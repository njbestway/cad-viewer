#!/usr/bin/env node
/**
 * Phase 2.12 Task B — conversion-window CPU profile attributor.
 *
 * Reads one `reports/phase212/profiles/<tag>.cpuprofile` plus its sibling
 * `<tag>.trace.json` / `<tag>.raw.json` and prints the tables the audit needs:
 *
 *   1. wall clock (from the spec's own steps, not from the profiler)
 *   2. RunTask list with the self-time leaders inside each task
 *   3. the B2 function table (self / inclusive / samples)
 *   4. the branch table (which sibling branch the samples belong to)
 *   5. slice rhythm and GC
 *
 * Two rules the numbers depend on, both stated in the audit:
 *
 *   - V8 profile node ids are keyed by *function plus call path*, so a node's
 *     sample count is not a call count. `calls` is left empty on purpose.
 *   - Async continuations lose their ancestors, so the conversion shows up as
 *     several *sibling* branches. Branch totals may be summed; function
 *     inclusive times may not (they nest inside each other).
 *
 * Self time of a function = samples whose *leaf* frame is that function.
 * Inclusive time = samples that have that function anywhere in their stack.
 *
 * The analysis window is not the whole profile. It is the union of every
 * RunTask that contains at least one `batchConvert` sample, i.e. "the
 * conversion". Before the scheduler existed that union was one 2834 ms task;
 * after it is one leader task plus 98 post-yield fragments. Using the same
 * rule for both arms keeps the branch table comparable.
 *
 *   node tools/phase212-profile-analyze.mjs move50000 move50000-after
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const profileDir = path.join(repoRoot, 'reports', 'phase212', 'profiles')

/**
 * The B2 function classes. `match` is applied to `functionName`; `file` narrows
 * to a module when the same name exists in several places.
 */
const CLASSES = [
  { id: 'batchConvert', label: 'AcTrView2d.batchConvert', match: /^batchConvert$/, file: /AcTrView2d/ },
  { id: 'finishEntityGeometry', label: 'finishEntityGeometry', match: /^finishEntityGeometry$/ },
  { id: 'sceneAddEntity', label: 'AcTrScene.addEntity', match: /^addEntity$/, file: /AcTrScene/ },
  { id: 'layoutAddEntity', label: 'AcTrLayout.addEntity', match: /^addEntity$/, file: /AcTrLayout/ },
  { id: 'groupAddEntity', label: 'AcTrBatchedGroup.addEntity', match: /^addEntity$/, file: /AcTrBatchedGroup/ },
  { id: 'sharedBatchResolve', label: 'Shared Geometry Batch Resolve', match: /sharedBatch|SharedBatch|resolveShared|acquireShared/i },
  { id: 'attributeCopy', label: 'AcTrBatchedGeometryInfo Attribute Copy', match: /copyAttribute|copyFromGeometryInfo|applyGeometryInfo|_copyGeometryInfo|setFrom/i },
  { id: 'object3dConstruction', label: 'Object3D / Line / Mesh construction', match: /^(createObject3D|createLine|createMesh|newLine|newMesh)$|^AcTrBatched(Line|Mesh|Point)s?$/ },
  { id: 'glyphMtextMerge', label: 'Glyph / MTEXT merge', match: /asyncRenderMText|renderAsync|mergeGlyph|GlyphBatch|glyphMerge|asyncDraw/i },
  { id: 'insertFragmentFinalize', label: 'INSERT fragment finalization', match: /handleGroup|finalizeFragment|finalizeInsert|handleInsert/i },
  { id: 'optimize', label: 'optimize()', match: /^(optimize|optimizeGroup|optimizeIndices)$/ },
  { id: 'gpuBufferUpdate', label: 'GPU buffer update', match: /^(updateBuffer|uploadBuffer|commitBuffer|syncBuffer)$/ },
  { id: 'framePresent', label: 'Renderer frame presentation', match: /^(animate|onAnimationFrame|renderFrame|_animate)$/ },
  { id: 'entityUpdateQueue', label: 'AcTrEntityUpdateQueue pump', match: /^(pump|applyEntityUpdates|applyWave)$|AcTrEntityUpdateQueue/i }
]

/**
 * Branch labels: the nearest ancestor frame that carries one of these names owns
 * the sample. Order matters only for ties within the same frame name.
 */
const BRANCHES = [
  /^asyncRenderMText$/,
  /^batchConvert$/,
  /^commitEntity$/,
  /^pump$|^applyEntityUpdates$/,
  /^handleGroup$/,
  /^asyncDraw$/,
  /^finishEntityGeometry$/,
  /^animate$/,
  /^drawEntity$/
]

const fileOf = frame => {
  const url = frame.url || ''
  if (!url) return ''
  return url.split('?')[0]
}

const shortFile = frame => {
  const file = fileOf(frame)
  if (!file) return ''
  const parts = file.split('/')
  return parts.slice(-2).join('/')
}

const nameOf = frame => frame.functionName || '(anonymous)'

const labelOf = frame => `${nameOf(frame)} ${shortFile(frame)}:${(frame.lineNumber ?? -1) + 1}`

function load(tag) {
  const profile = JSON.parse(readFileSync(path.join(profileDir, `${tag}.cpuprofile`), 'utf8'))
  const traceRaw = JSON.parse(readFileSync(path.join(profileDir, `${tag}.trace.json`), 'utf8'))
  const raw = JSON.parse(readFileSync(path.join(profileDir, `${tag}.raw.json`), 'utf8'))
  return { profile, trace: traceRaw.traceEvents ?? traceRaw, raw }
}

/** Rebuild absolute timestamps and parent links for every sample. */
function prepare(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }
  const samples = []
  let clock = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) {
    clock += profile.timeDeltas[i]
    samples.push({ id: profile.samples[i], ts: clock })
  }
  const intervalUs = samples.length > 1
    ? (samples[samples.length - 1].ts - samples[0].ts) / (samples.length - 1)
    : 0
  return { nodes, parent, samples, intervalUs }
}

const ms = (samples, intervalUs) => Math.round((samples * intervalUs) / 100) / 10
const round1 = value => Math.round(value * 10) / 10

/** Walk from the leaf up to the root, yielding node ids. */
function* ancestry(id, nodes, parent) {
  let current = id
  while (current !== undefined && current !== null) {
    yield current
    current = parent.get(current)
  }
}

/** True when the sample has a `batchConvert` frame anywhere in its stack. */
function inConversion(profile, nodes, parent, sampleId) {
  for (const id of ancestry(sampleId, nodes, parent)) {
    const node = nodes.get(id)
    if (node && nameOf(node.callFrame) === 'batchConvert') return true
  }
  return false
}

function analyse(tag) {
  const { profile, trace, raw } = load(tag)
  const { nodes, parent, samples, intervalUs } = prepare(profile)

  const out = []
  out.push(`===== ${tag} (${raw.size} entities, sampling ${raw.samplingUs} us, measured ${intervalUs.toFixed(1)} us/sample)`)

  // ---- 1. wall clock ------------------------------------------------------
  const steps = raw.steps ?? {}
  for (const [op, step] of Object.entries(steps)) {
    out.push(
      `  wall ${op.padEnd(5)} commit ${round1(step.commitMs)} -> firstYield ${round1(step.firstYieldMs)} -> ` +
        `ready ${round1(step.readyMs)} -> frame ${round1(step.frameMs)} (ready=${step.ready})`
    )
  }
  if (raw.schedulerMetrics) {
    const s = raw.schedulerMetrics
    out.push(
      `  sched enabled=${s.enabled} budget=${s.budgetMs}ms waves=${s.waves} slices=${s.slices} ` +
        `entities=${s.entities} yields=${s.yields} maxSlice=${s.maxSliceMs}ms maxTask=${s.maxTaskMs}ms ` +
        `lastWave=${s.lastWaveMs}ms primitive=${s.yieldPrimitive}`
    )
  }

  // ---- 2. RunTask list ----------------------------------------------------
  const tasks = trace
    .filter(event => event.name === 'RunTask' && event.dur)
    .map(event => ({ ...event, end: event.ts + event.dur }))
    .sort((left, right) => left.ts - right.ts)
  const sortedByDur = [...tasks].sort((left, right) => right.dur - left.dur)
  out.push(
    `  trace ${tasks.length} RunTask, sum ${round1(tasks.reduce((total, task) => total + task.dur, 0) / 1000)} ms, ` +
      `span ${round1((tasks[tasks.length - 1].end - tasks[0].ts) / 1000)} ms`
  )
  out.push(`  long tasks >50ms: ${sortedByDur.filter(task => task.dur > 50000).length} ` +
    sortedByDur.filter(task => task.dur > 50000).slice(0, 8).map(task => round1(task.dur / 1000)).join(', '))

  const gaps = []
  for (let i = 1; i < tasks.length; i++) gaps.push((tasks[i].ts - tasks[i - 1].end) / 1000)
  const gapSorted = [...gaps].sort((left, right) => right - left)
  out.push(`  max event-loop gap ${round1(gapSorted[0] ?? 0)} ms, p95 ${round1(gapSorted[Math.floor(gapSorted.length * 0.05)] ?? 0)} ms`)

  out.push('  top tasks, self-time leaders inside each:')
  for (const task of sortedByDur.slice(0, 6)) {
    const inside = samples.filter(sample => sample.ts >= task.ts && sample.ts < task.end)
    const agg = new Map()
    for (const sample of inside) {
      const node = nodes.get(sample.id)
      if (!node) continue
      const label = labelOf(node.callFrame)
      agg.set(label, (agg.get(label) ?? 0) + 1)
    }
    const leaders = [...agg.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
    out.push(
      `    ${round1(task.dur / 1000).toString().padStart(7)} ms  ${inside.length} samples  ` +
        `@${round1((task.ts - tasks[0].ts) / 1000)}ms  ` +
        leaders.map(([label, count]) => `${label}=${ms(count, intervalUs)}`).join(' | ')
    )
  }

  // ---- conversion window -------------------------------------------------
  // Union of the RunTasks that carry conversion samples. Chosen because it is
  // the only window definition that behaves the same pre- and post-scheduling.
  const conversionTs = []
  for (const sample of samples) {
    if (inConversion(profile, nodes, parent, sample.id)) conversionTs.push(sample.ts)
  }
  const conversionTasks = tasks.filter(task => {
    const low = conversionTs.length ? conversionTs[0] : 0
    const high = conversionTs.length ? conversionTs[conversionTs.length - 1] : 0
    return task.end > low && task.ts < high
  })
  const windowStart = conversionTasks.length ? conversionTasks[0].ts : samples[0]?.ts ?? 0
  const windowEnd = conversionTasks.length
    ? conversionTasks[conversionTasks.length - 1].end
    : samples[samples.length - 1]?.ts ?? 0
  out.push(
    `  conversion window: ${round1((windowStart - samples[0].ts) / 1000)} -> ` +
      `${round1((windowEnd - samples[0].ts) / 1000)} ms (origin = profile start), ` +
      `${round1((windowEnd - windowStart) / 1000)} ms across ${conversionTasks.length} RunTasks, ` +
      `${conversionTs.length} conversion samples`
  )
  const windowSamples = samples.filter(sample => sample.ts >= windowStart && sample.ts < windowEnd)

  // ---- 3. B2 function table ----------------------------------------------
  const selfSamples = new Map()
  const inclusiveSamples = new Map()
  for (const sample of windowSamples) {
    let leaf = null
    for (const id of ancestry(sample.id, nodes, parent)) {
      const node = nodes.get(id)
      if (!node) continue
      leaf ??= node.callFrame
      // Inclusive: every class this frame belongs to, once per sample.
      for (const klass of CLASSES) {
        const frame = node.callFrame
        if (!klass.match.test(nameOf(frame))) continue
        if (klass.file && !klass.file.test(fileOf(frame))) continue
        if (!inclusiveSamples.has(klass.id)) inclusiveSamples.set(klass.id, new Set())
        inclusiveSamples.get(klass.id).add(sample.ts)
      }
    }
    if (!leaf) continue
    for (const klass of CLASSES) {
      if (!klass.match.test(nameOf(leaf))) continue
      if (klass.file && !klass.file.test(fileOf(leaf))) continue
      selfSamples.set(klass.id, (selfSamples.get(klass.id) ?? 0) + 1)
    }
  }

  out.push('  B2 function table (self = leaf samples, inclusive = stack samples, calls not measurable):')
  out.push('    ' + 'function'.padEnd(42) + 'self'.padStart(10) + 'inclusive'.padStart(12))
  for (const klass of CLASSES) {
    const selfCount = selfSamples.get(klass.id) ?? 0
    const inclusiveCount = inclusiveSamples.get(klass.id)?.size ?? 0
    out.push(
      '    ' +
        klass.label.padEnd(42) +
        `${ms(selfCount, intervalUs)} ms`.padStart(10) +
        `${ms(inclusiveCount, intervalUs)} ms`.padStart(12)
    )
  }

  // ---- 4. branch table ---------------------------------------------------
  const branches = new Map()
  for (const sample of windowSamples) {
    let label = '(program) / other'
    let leaf = null
    for (const id of ancestry(sample.id, nodes, parent)) {
      const node = nodes.get(id)
      if (!node) continue
      leaf ??= node.callFrame
      if (BRANCHES.some(pattern => pattern.test(nameOf(node.callFrame)))) {
        label = labelOf(node.callFrame)
        break
      }
    }
    if (label === '(program) / other' && leaf) {
      const name = nameOf(leaf)
      if (name === '(garbage collector)') label = '(garbage collector)'
      else if (name === '(program)') label = '(program) / other'
    }
    branches.set(label, (branches.get(label) ?? 0) + 1)
  }
  out.push('  sibling branches (summable, unlike inclusive times):')
  for (const [label, count] of [...branches.entries()].sort((left, right) => right[1] - left[1]).slice(0, 14)) {
    out.push(`    ${(`${ms(count, intervalUs)} ms`).padStart(10)}  ${label}`)
  }

  // ---- 5. slices and GC --------------------------------------------------
  const slices = raw.slices ?? {}
  for (const [op, list] of Object.entries(slices)) {
    if (!Array.isArray(list) || list.length === 0) continue
    const durations = list.map(entry => (typeof entry === 'number' ? entry : entry.ms ?? entry.duration ?? 0))
    const sorted = [...durations].sort((left, right) => left - right)
    const total = round1(durations.reduce((sum, value) => sum + value, 0))
    out.push(
      `  slices ${op}: ${durations.length} x ${list.length ? (list[0].count ?? '?') : '?'} entities, wall ${total} ms, ` +
        `median ${round1(sorted[sorted.length >> 1])} p95 ${round1(sorted[Math.floor(sorted.length * 0.95)])} max ${round1(sorted[sorted.length - 1])}`
    )
  }
  const gc = trace.filter(event => /GC/.test(event.name || '') && event.dur)
  out.push(`  gc ${gc.length} events, ${round1(gc.reduce((sum, event) => sum + event.dur, 0) / 1000)} ms total`)

  return out.join('\n')
}

const tags = process.argv.slice(2)
if (tags.length === 0) {
  console.error('usage: node tools/phase212-profile-analyze.mjs <tag> [tag...]')
  process.exit(1)
}
for (const tag of tags) console.log(analyse(tag) + '\n')
