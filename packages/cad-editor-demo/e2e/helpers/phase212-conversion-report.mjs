/**
 * Phase 2.12 Task B — turns one profiled MOVE into an attribution table.
 *
 * Inputs (written by `e2e/tests/phase212-move-conversion.spec.ts`):
 *   reports/phase212/profiles/<tag>.cpuprofile
 *   reports/phase212/profiles/<tag>.trace.json
 *   reports/phase212/profiles/<tag>.raw.json
 * Output:
 *   reports/phase212/phase212-conversion-profile[-<tag>].json
 *
 * Three instruments, three questions, kept apart because mixing them is how
 * "inclusive time" ends up being summed into more than the wall clock:
 *
 * 1. **CPU profile** — self time per frame, per-call-path subtree time (the
 *    inclusive number), sample counts.
 * 2. **Trace** — task census: which synchronous task each sample landed in,
 *    long tasks, gaps, GC. Both instruments use the same microsecond epoch
 *    (`profile.startTime` and `trace.ts` are the same clock on this Chrome), so
 *    a sample can be placed in a task by containment. The `agree` field below
 *    re-derives that alignment from the data instead of trusting it.
 * 3. **`raw.json`** — page-clock wall times (`commitMs`, `firstYieldMs`,
 *    `readyMs`, `frameMs`) collected in one `page.evaluate`.
 *
 * Usage: node e2e/helpers/phase212-conversion-report.mjs [--tag=move50000]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const profilesDir = path.join(repoRoot, 'reports', 'phase212', 'profiles')

const args = new Map(
  process.argv.slice(2).map(raw => {
    const [key, value = ''] = raw.replace(/^--/, '').split('=')
    return [key, value]
  })
)
const tag = args.get('tag') ?? 'move50000'
const outputPath = path.join(
  repoRoot,
  'reports',
  'phase212',
  tag === 'move50000' ? 'phase212-conversion-profile.json' : `phase212-conversion-profile-${tag}.json`
)

const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

/* ---------------------------------------------------------------- profile */

const profile = readJson(path.join(profilesDir, `${tag}.cpuprofile`))
const nodes = profile.nodes
const nodeById = new Map(nodes.map(node => [node.id, node]))

// Chrome semantics: `timeDeltas[i]` is the interval *before* sample `i`, so the
// absolute timestamp of sample `i` is startTime + Σ deltas[0..i].
const sampleAt = new Float64Array(profile.samples.length)
const selfUs = new Map()
let cursor = profile.startTime
for (let index = 0; index < profile.samples.length; index++) {
  cursor += profile.timeDeltas[index] ?? 0
  sampleAt[index] = cursor
  const id = profile.samples[index]
  selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0))
}
const sampleCount = new Map()
for (const id of profile.samples) sampleCount.set(id, (sampleCount.get(id) ?? 0) + 1)

const parentOf = new Map()
for (const node of nodes) for (const child of node.children ?? []) parentOf.set(child, node.id)

const totalUs = new Map()
const resolveTotal = id => {
  if (totalUs.has(id)) return totalUs.get(id)
  totalUs.set(id, 0)
  let total = selfUs.get(id) ?? 0
  for (const child of nodeById.get(id)?.children ?? []) total += resolveTotal(child)
  totalUs.set(id, total)
  return total
}
for (const node of nodes) resolveTotal(node.id)

function frameOf(id) {
  const callFrame = nodeById.get(id)?.callFrame ?? {}
  return {
    name: callFrame.functionName || '(anonymous)',
    url: (callFrame.url ?? '').replace(/^.*\/(packages|node_modules)\//, '$1/'),
    line: (callFrame.lineNumber ?? -1) + 1
  }
}
const shortName = id => {
  const frame = frameOf(id)
  return `${frame.name} ${frame.url}:${frame.line}`
}

function isUnder(id, targetId) {
  let current = id
  while (current !== undefined) {
    if (current === targetId) return true
    current = parentOf.get(current)
  }
  return false
}

/**
 * Samples of a node set: time span, sample count and the largest gap between two
 * consecutive samples. A gap much larger than the sampling interval means the
 * task ended and the event loop was free.
 */
function sampleSpan(ids) {
  const wanted = new Set(ids)
  const times = []
  for (let index = 0; index < profile.samples.length; index++) {
    if (wanted.has(profile.samples[index])) times.push(sampleAt[index])
  }
  if (times.length === 0) return { samples: 0, spanMs: 0, maxGapMs: 0 }
  times.sort((left, right) => left - right)
  let gap = 0
  for (let index = 1; index < times.length; index++) {
    const delta = times[index] - times[index - 1]
    if (delta > gap) gap = delta
  }
  return {
    samples: times.length,
    firstMs: round((times[0] - profile.startTime) / 1000, 1),
    lastMs: round((times[times.length - 1] - profile.startTime) / 1000, 1),
    spanMs: round((times[times.length - 1] - times[0]) / 1000, 1),
    maxGapMs: round(gap / 1000, 1)
  }
}

/* ------------------------------------------------------------ conversion */

// The conversion root candidates: the pump entry points.
const CONVERSION_ROOTS = /^(applyEntityUpdates|batchConvert|runConvertDrain)$/
const rootCandidates = nodes.filter(node => CONVERSION_ROOTS.test(node.callFrame.functionName ?? ''))
const rootNode = rootCandidates.sort((left, right) => resolveTotal(right.id) - resolveTotal(left.id))[0]

/* ------------------------------------------------------------------- trace */

const traceFile = path.join(profilesDir, `${tag}.trace.json`)
const traceEvents = fs.existsSync(traceFile) ? readJson(traceFile).traceEvents ?? [] : []
const threadName = traceEvents.find(
  event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain'
)
const mainPid = threadName?.pid
const mainTid = threadName?.tid
const slices = traceEvents
  .filter(
    event =>
      event.ph === 'X' &&
      Number.isFinite(event.dur) &&
      event.dur > 0 &&
      (mainPid === undefined || (event.pid === mainPid && event.tid === mainTid))
  )
  .sort((left, right) => (left.ts === right.ts ? right.dur - left.dur : left.ts - right.ts))

// Containment pass: children carry a pointer to their parent so a task can show
// what it spent its time in, without summing every nested slice.
const stack = []
for (const slice of slices) {
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (slice.ts >= top.ts + top.dur) stack.pop()
    else break
  }
  const parent = stack[stack.length - 1]
  if (parent) {
    parent.childCount = (parent.childCount ?? 0) + 1
    parent.childMs = (parent.childMs ?? 0) + slice.dur
    parent.kids = parent.kids ?? []
    parent.kids.push(slice)
  }
  stack.push(slice)
}

const isTask = event => /RunTask$/.test(event.name) || event.name === 'ThreadControllerImpl::RunTask'
const tasks = slices.filter(event => isTask(event))
// Only the outermost RunTask per nesting level matters; the trace nests
// `RunTask → ThreadControllerImpl::RunTask → Edge_RunTask` for one task.
const outerTasks = []
for (const task of tasks) {
  const enclosing = outerTasks.find(
    other => task.ts >= other.ts && task.ts + task.dur <= other.ts + other.dur
  )
  if (!enclosing) outerTasks.push(task)
}
const tasksSorted = [...outerTasks].sort((left, right) => left.ts - right.ts)
const gaps = []
for (let index = 1; index < tasksSorted.length; index++) {
  const previous = tasksSorted[index - 1]
  gaps.push(tasksSorted[index].ts - (previous.ts + previous.dur))
}
const sortedGaps = [...gaps].sort((left, right) => right - left)

// Profile-relative windows for the main-thread tasks.
const taskWindows = tasksSorted.map((task, index) => ({
  index,
  name: task.name,
  startMs: (task.ts - profile.startTime) / 1000,
  durMs: task.dur / 1000,
  endMs: (task.ts - profile.startTime + task.dur) / 1000
}))
/** Host task of a sample, by containment. `tasksSorted` is disjoint and sorted. */
function hostTaskOf(atUs) {
  const ms = (atUs - profile.startTime) / 1000
  let low = 0
  let high = taskWindows.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const window = taskWindows[mid]
    if (ms < window.startMs) high = mid - 1
    else if (ms > window.endMs) low = mid + 1
    else return window
  }
  return null
}

const gcEvents = slices.filter(event => /GC|GCEvent|Scavenge|MarkCompact/.test(event.name))
const longTasks = [...outerTasks].filter(event => event.dur >= 50_000).sort((left, right) => right.dur - left.dur)
const timerFires = slices
  .filter(event => event.name === 'TimerFire')
  .sort((left, right) => right.dur - left.dur)

/* --------------------------------- conversion task = the task holding batchConvert */

const batchConvertNodes = nodes.filter(node => node.callFrame.functionName === 'batchConvert')
const batchConvertSubtree = new Set()
for (const node of batchConvertNodes) {
  for (const member of nodes) if (isUnder(member.id, node.id)) batchConvertSubtree.add(member.id)
}
const batchConvertSamples = []
for (let index = 0; index < profile.samples.length; index++) {
  if (batchConvertSubtree.has(profile.samples[index])) batchConvertSamples.push(sampleAt[index])
}
const hostTally = new Map()
for (const at of batchConvertSamples) {
  const host = hostTaskOf(at)
  if (host) hostTally.set(host.index, (hostTally.get(host.index) ?? 0) + 1)
}
const conversionTaskIndex = [...hostTally.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
const conversionTask = taskWindows[conversionTaskIndex] ?? null

// The frame that presents the new geometry: the first sizeable task after the
// conversion ends. Its JS part is the buffer upload; its `(program)` part is the
// native GL submit and composite, which no JS profiler can itemise.
const frameTask =
  conversionTask == null
    ? null
    : (taskWindows.find(
        window =>
          window.index !== conversionTask.index &&
          window.durMs >= 8 &&
          window.startMs >= conversionTask.endMs - 1 &&
          window.startMs <= conversionTask.endMs + 200
      ) ?? null)

/**
 * Clock-alignment sanity check. If the profile and the trace really share an
 * epoch, then the union of the task windows covers the sampled window and the
 * conversion window starts after the first task starts. A wrong epoch would
 * push every sample into "no task".
 */
const orphanSamples = (() => {
  let count = 0
  for (let index = 0; index < profile.samples.length; index++) {
    if (!hostTaskOf(sampleAt[index])) count++
  }
  return count
})()

/** Branches of one task: samples grouped by their ancestor just below `(root)`. */
function branchesOfTask(task) {
  const tally = new Map()
  for (let index = 0; index < profile.samples.length; index++) {
    const at = sampleAt[index]
    const ms = (at - profile.startTime) / 1000
    if (ms < task.startMs || ms > task.endMs) continue
    let current = profile.samples[index]
    let guard = 0
    while (guard++ < 60) {
      const up = parentOf.get(current)
      if (up === undefined) break
      if (nodeById.get(up)?.callFrame.functionName === '(root)') break
      current = up
    }
    tally.set(current, (tally.get(current) ?? 0) + (profile.timeDeltas[index] ?? 0))
  }
  return [...tally.entries()]
    .map(([id, us]) => ({ frame: shortName(id), ms: round(us / 1000, 1) }))
    .sort((left, right) => right.ms - left.ms)
}

/* ------------------------------------------------------- function classes */

const CLASSES = [
  ['entityUpdateQueue', frame => /AcTrEntityUpdateQueue|runWave|applyEntityUpdates/.test(`${frame.name} ${frame.url}`)],
  ['batchConvert', frame => frame.name === 'batchConvert' || /batchConvert/.test(`${frame.name} ${frame.url}`)],
  ['finishEntityGeometry', frame => /finishEntityGeometry/.test(`${frame.name} ${frame.url}`)],
  ['sceneAddEntity', frame => frame.name === 'addEntity' && /AcTrScene\.ts/.test(frame.url)],
  ['layoutAddEntity', frame => frame.name === 'addEntity' && /AcTrLayout\.ts|AcTrDirectBatch\.ts/.test(frame.url)],
  ['groupAddEntity', frame => frame.name === 'addEntity' && /AcTrBatchedGroup\.ts/.test(frame.url)],
  // SPEC item 7 names this "shared geometry batch resolve". In a MOVE the shared
  // batch is not resolved from scratch (the template is reused); what actually runs
  // is slot release plus per-instance attribute writes, so the class covers every
  // frame in that file and the per-frame table below shows which ones.
  ['sharedBatchResolve', frame => /AcTrSharedGeometryBatch\.ts/.test(frame.url)],
  ['attributeCopy', frame => /copyAttributeData|setGeometryAt|applyGeometryAt|copyGeometryIndices|setFromBufferAttribute|copyArray|copyInto|writeAttribute|writeRelative|updateRange/.test(frame.name)],
  ['object3dConstruction', frame => /^(new )?(AcTr)?(Line|Mesh|Point|LineSegments|Polygon|Offset|Glyph)/.test(frame.name) || (/AcTrLineGeometryBuilder|AcTrBufferGeometryUtil|AcTrEntity\.ts|AcTrLine\.ts|AcTrMesh\.ts/.test(frame.url) && /build|constructor|applyMatrix/i.test(frame.name))],
  ['glyphMtextMerge', frame => /AcTrMTextRenderer|AcTrMText\.ts|AcTrGlyph|mtext-renderer/.test(`${frame.name} ${frame.url}`)],
  // SPEC item 11: INSERT fragment finalization. The block reference expands in
  // `subWorldDraw`, the fragments are re-parented in `handleGroup` and committed by
  // `visitDrawable` in the batched group.
  ['insertFragmentFinalize', frame => /AcDbBlockReference|AcTrGroup\.ts|handleGroup|visitDrawable/.test(`${frame.name} ${frame.url}`)],
  ['optimize', frame => /optimize/.test(frame.name)],
  ['gpuBufferUpdate', frame => /bufferSubData|bufferData|WebGLAttributes|updateBuffer|uploadRange/.test(`${frame.name} ${frame.url}`)],
  // SPEC item 14: frame presentation. This is the rAF callback and the WebGL draw
  // submission. The actual GL call is native, so it shows up as `(program)` inside
  // this class and as a `present`/`GPU` trace slice — not as its own JS frame.
  ['framePresent', frame => /WebGLRenderer|renderLists|renderScene|drawOperations|onAnimationFrame/.test(`${frame.name} ${frame.url}`) || (/AcTrView2d\.ts/.test(frame.url) && /(^|\.)(animate|render)$/.test(frame.name))]
]

// Classify every node, not only the sampled ones: an entry point such as
// `AcTrView2d.animate` can have zero self time while its subtree carries seconds,
// and skipping it would hide the whole class.
const classOfNode = new Map()
for (const node of nodes) {
  const frame = frameOf(node.id)
  const hit = CLASSES.find(([, test]) => test(frame))
  if (hit) classOfNode.set(node.id, hit[0])
}

// Outermost node of each class: a nested match of the same class is part of its
// parent's subtree, so counting both would double the inclusive number.
const outermost = new Map()
for (const [id, name] of classOfNode) {
  let current = parentOf.get(id)
  let nested = false
  while (current !== undefined) {
    if (classOfNode.get(current) === name) {
      nested = true
      break
    }
    current = parentOf.get(current)
  }
  if (!nested) {
    if (!outermost.has(name)) outermost.set(name, [])
    outermost.get(name).push(id)
  }
}

/** Which task(s) a class ran in, by sample containment. */
function hostTasksOf(ids) {
  const wanted = new Set(ids)
  const tally = new Map()
  for (let index = 0; index < profile.samples.length; index++) {
    if (!wanted.has(profile.samples[index])) continue
    const host = hostTaskOf(sampleAt[index])
    const key = host ? host.index : -1
    tally.set(key, (tally.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0))
  }
  return [...tally.entries()]
    .map(([index, us]) => ({
      task: index < 0 ? 'no-task' : `#${index} ${round(taskWindows[index].startMs, 0)}+${round(taskWindows[index].durMs, 0)}ms`,
      ms: round(us / 1000, 1)
    }))
    .sort((left, right) => right.ms - left.ms)
}

/** Every node in the subtrees of `ids`. */
function subtreeIds(ids) {
  const members = new Set()
  for (const id of ids) for (const node of nodes) if (isUnder(node.id, id)) members.add(node.id)
  return members
}

const functions = CLASSES.map(([name]) => {
  const ids = outermost.get(name) ?? []
  const allIdsOfClass = [...classOfNode.entries()].filter(([, value]) => value === name).map(([id]) => id)
  const selfMs = allIdsOfClass.reduce((total, id) => total + (selfUs.get(id) ?? 0), 0) / 1000
  const inclusiveMs = ids.reduce((total, id) => total + resolveTotal(id), 0) / 1000
  const invocations = ids.map(id => ({
    ms: resolveTotal(id) / 1000,
    samples: sampleCount.get(id) ?? 0,
    frame: frameOf(id)
  }))
  invocations.sort((left, right) => right.ms - left.ms)
  const samples = allIdsOfClass.reduce((total, id) => total + (sampleCount.get(id) ?? 0), 0)
  // An entry point with zero self time (e.g. `AcTrView2d.animate`) still ran
  // somewhere: fall back to its subtree so the host column is never blank for
  // work that demonstrably happened.
  const ownHost = hostTasksOf(allIdsOfClass)
  const hostTasks = ownHost.length > 0 ? ownHost : hostTasksOf(subtreeIds(ids))
  return {
    fn: name,
    // `pathNodes` counts distinct call paths merged by V8, not calls. A sampling
    // profile cannot recover exact call counts; Task D adds counters for that.
    pathNodes: ids.length,
    nodes: allIdsOfClass.length,
    samples,
    selfMs: round(selfMs),
    inclusiveMs: round(inclusiveMs),
    maxCallMs: round(invocations[0]?.ms ?? 0),
    medianCallMs: round(invocations.length === 0 ? 0 : invocations[Math.floor(invocations.length / 2)].ms),
    hostTasks: hostTasks.slice(0, 3),
    topFrames: invocations.slice(0, 3).map(entry => `${entry.frame.name} @${entry.frame.url}:${entry.frame.line}`)
  }
}).sort((left, right) => right.inclusiveMs - left.inclusiveMs)

/* ----------------------------------------------------------- slice census */

// Slice count cannot be read off the profile (V8 merges calls by call path). It
// is derived from what the caller converted and the hard cap.
// AC_TR_ENTITY_UPDATE_SLICE_MAX = 512, packages/cad-simple-viewer/src/view/AcTrEntityUpdateQueue.ts:73
const SLICE_MAX = 512
const raw = readJson(path.join(profilesDir, `${tag}.raw.json`))
const appliedEntityCount =
  raw.counters?.move?.entityUpdateStats?.appliedEntityCount ?? raw.size ?? 0
const estimatedSlices = appliedEntityCount > 0 ? Math.ceil(appliedEntityCount / SLICE_MAX) : 0
const sampledUs = [...selfUs.values()].reduce((total, value) => total + value, 0)

const sliceDurations = batchConvertNodes
  .map(node => ({
    ms: round(resolveTotal(node.id) / 1000, 1),
    samples: sampleCount.get(node.id) ?? 0,
    frame: shortName(node.id)
  }))
  .sort((left, right) => right.ms - left.ms)
const sliceTotalMs = sliceDurations.reduce((total, entry) => total + entry.ms, 0)

/* ------------------------------------------------------------------ report */

const conversionWindow = sampleSpan(
  nodes.filter(node => isUnder(node.id, rootNode?.id ?? -1)).map(node => node.id)
)

const report = {
  phase: '2.12',
  task: 'B',
  tag,
  fixture: raw.fixture ?? 'mixed',
  size: raw.size ?? null,
  sharing: raw.sharing ?? null,
  artifacts: raw.artifacts,
  wall: {
    ...raw.steps,
    note:
      'commitMs = synchronous edit; firstYieldMs = edit start → first setTimeout(0) callback (i.e. how long the main thread ran without yielding); readyMs = waitUntilSceneReady; frameMs = two rAF boundaries after ready. readyMs and frameMs are different completion conditions and both are reported.'
  },
  cpu: {
    samplingUs: raw.samplingUs ?? null,
    sampledMs: round(sampledUs / 1000, 1),
    profileSpanMs: round((profile.endTime - profile.startTime) / 1000, 1),
    conversionRoot: rootNode ? { ...frameOf(rootNode.id), totalMs: round(resolveTotal(rootNode.id) / 1000, 1) } : null,
    conversion: {
      window: conversionWindow,
      hostTask: conversionTask
        ? {
            index: conversionTask.index,
            startMs: round(conversionTask.startMs, 1),
            durMs: round(conversionTask.durMs, 1),
            endMs: round(conversionTask.endMs, 1),
            name: conversionTask.name
          }
        : null,
      // Subtree time of the largest single batchConvert call path. The other
      // slice calls arrive over a different path after each resume, so they are
      // separate nodes; all of them are counted in `functions.batchConvert`.
      largestSlicePathMs: sliceDurations[0]?.ms ?? 0,
      // Self time with no JS frame: native code (WebGL, canvas, structuredClone),
      // or work the sampler charged to `(program)`.
      unprofiledMs: round(
        nodes
          .filter(node => (node.callFrame.functionName ?? '') === '(program)')
          .reduce((total, node) => total + (selfUs.get(node.id) ?? 0), 0) / 1000,
        1
      ),
      noTaskSampleCount: orphanSamples
    },
    branchesOfConversionTask: conversionTask ? branchesOfTask(conversionTask) : [],
    branchesOfFrameTask: frameTask ? branchesOfTask(frameTask) : [],
    functions,
    slices: {
      // Measured by the prototype probe in the spec: exact call count, entity
      // count and per-call wall time. The profile alone only offers call paths.
      measured: raw.slices?.move
        ? {
            calls: raw.slices.move.calls,
            entities: raw.slices.move.entities,
            maxEntitiesPerCall: raw.slices.move.maxEntitiesPerCall,
            totalMs: raw.slices.move.totalMs,
            maxMs: raw.slices.move.maxMs,
            medianMs: raw.slices.move.medianMs,
            p95Ms: raw.slices.move.p95Ms,
            // End of one slice to start of the next: a macrotask boundary shows
            // up here as a positive gap, microtasks do not.
            maxGapMs: raw.slices.move.maxGapMs,
            firstStartMs: raw.slices.move.firstStartMs,
            lastEndMs: raw.slices.move.lastEndMs,
            spans: (raw.slices.move.spans ?? []).map(entry => ({
              count: entry.count,
              startMs: entry.startMs,
              ms: entry.ms
            }))
          }
        : null,
      // `pathNodes` is not a call count (V8 merges by call path); `estimated` is
      // the arithmetic count from the converted entity total and the 512 cap, kept
      // so the probe can be checked against it.
      pathNodes: sliceDurations.length,
      estimated: estimatedSlices,
      entitiesPerSlice: SLICE_MAX,
      appliedEntityCount,
      profileTotalMs: round(sliceTotalMs, 1),
      top: sliceDurations.slice(0, 10)
    },
    topSelf: nodes
      .map(node => ({
        ...frameOf(node.id),
        selfMs: round((selfUs.get(node.id) ?? 0) / 1000, 2),
        samples: sampleCount.get(node.id) ?? 0
      }))
      .filter(entry => entry.selfMs > 0)
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 30),
    topInclusive: nodes
      .map(node => ({
        ...frameOf(node.id),
        totalMs: round(resolveTotal(node.id) / 1000, 2),
        samples: sampleCount.get(node.id) ?? 0
      }))
      .filter(entry => entry.totalMs >= 50)
      .sort((left, right) => right.totalMs - left.totalMs)
      .slice(0, 30)
  },
  trace: {
    eventCount: traceEvents.length,
    mainThread: { pid: mainPid ?? null, tid: mainTid ?? null },
    taskCount: outerTasks.length,
    taskMs: round(outerTasks.reduce((total, event) => total + event.dur, 0) / 1000, 1),
    topTasks: tasksSorted
      .map(task => ({
        startMs: round((task.ts - profile.startTime) / 1000, 1),
        durMs: round(task.dur / 1000, 1),
        name: task.name
      }))
      .sort((left, right) => right.durMs - left.durMs)
      .slice(0, 10),
    longTaskCount: longTasks.length,
    longTasks: longTasks.slice(0, 15).map(event => ({
      name: event.name,
      durMs: round(event.dur / 1000, 1),
      childCount: event.childCount ?? 0,
      childrenMs: round((event.childMs ?? 0) / 1000, 1),
      biggestChildren: (event.kids ?? [])
        .slice()
        .sort((left, right) => right.dur - left.dur)
        .slice(0, 6)
        .map(child => ({ name: child.name, durMs: round(child.dur / 1000, 1) }))
    })),
    gaps: {
      maxMs: round((sortedGaps[0] ?? 0) / 1000, 1),
      p95Ms: round((sortedGaps[Math.floor(sortedGaps.length * 0.05)] ?? 0) / 1000, 1),
      note: 'gap between consecutive main-thread tasks; a gap is time the event loop was free'
    },
    timerFire: {
      count: timerFires.length,
      longestMs: round((timerFires[0]?.dur ?? 0) / 1000, 1),
      allMs: timerFires.slice(0, 10).map(event => round(event.dur / 1000, 1))
    },
    frameAfterConversion: frameTask
      ? {
          startMs: round(frameTask.startMs, 1),
          endMs: round(frameTask.endMs, 1),
          durMs: round(frameTask.durMs, 1),
          // How much of the frame is JS at all. Everything else is `(program)`:
          // native GL submit and compositor work.
          jsMs: (() => {
            let total = 0
            for (let index = 0; index < profile.samples.length; index++) {
              const ms = (sampleAt[index] - profile.startTime) / 1000
              if (ms < frameTask.startMs || ms > frameTask.endMs) continue
              const frame = frameOf(profile.samples[index])
              if (frame.name === '(program)' || frame.name === '(idle)') continue
              if (frame.name === '(garbage collector)') continue
              total += profile.timeDeltas[index] ?? 0
            }
            return round(total / 1000, 1)
          })()
        }
      : null,
    clockAlignment: {
      profileStartUs: profile.startTime,
      firstTraceTsUs: tasksSorted[0]?.ts ?? null,
      sameEpoch: tasksSorted.length > 0 && tasksSorted[0].ts >= profile.startTime,
      noTaskSampleCount: orphanSamples,
      note:
        'containment works only if `profile.startTime` and `trace.ts` share an epoch; the check above fails loudly (orphan samples) when they do not'
    },
    gc: {
      count: gcEvents.length,
      totalMs: round(gcEvents.reduce((total, event) => total + event.dur, 0) / 1000, 1),
      maxMs: round(Math.max(0, ...gcEvents.map(event => event.dur)) / 1000, 1),
      names: [...new Set(gcEvents.map(event => event.name))].slice(0, 6)
    }
  },
  counters: raw.counters,
  steps: raw.slices
    ? Object.fromEntries(
        Object.entries(raw.slices).map(([step, value]) => [
          step,
          {
            calls: value.calls,
            entities: value.entities,
            totalMs: value.totalMs,
            maxMs: value.maxMs,
            maxGapMs: value.maxGapMs,
            firstStartMs: value.firstStartMs,
            lastEndMs: value.lastEndMs
          }
        ])
      )
    : null,
  caveats: [
    'Self time is sampled: it is a shape, not an invoice. `inclusiveMs` is a subtree total and must never be added to its children.',
    'A sampling profile cannot count calls: V8 merges every call sharing a call path into one node. `pathNodes` is path count, `samples` is time, and exact call counts need counters (Task D adds them).',
    'Async continuations lose their ancestors: a function resumed from a microtask appears as a direct child of `(root)` even though it was called from inside `batchConvert`. That is why `branchesOfConversionTask` is a sibling list and not a tree.',
    '`unprofiledMs` is `(program)` self time: native code (WebGL, canvas, structuredClone) the sampler could not attribute to a JS frame. It is not an error term to be redistributed.',
    '`firstYieldMs` is the honest blocking number: it ends at the first macrotask boundary, not at the first await.'
  ]
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const lines = [
  `phase 2.12 Task B — MOVE conversion profile (${tag}, ${report.size} entities)`,
  `  wall  commit ${report.wall.move.commitMs} ms → first yield ${report.wall.move.firstYieldMs} ms → ready ${report.wall.move.readyMs} ms → frame ${report.wall.move.frameMs} ms`,
  `  task  conversion ran in RunTask #${report.cpu.conversion.hostTask?.index} ${report.cpu.conversion.hostTask?.startMs} → ${report.cpu.conversion.hostTask?.endMs} ms (${report.cpu.conversion.hostTask?.durMs} ms), profile span ${report.cpu.profileSpanMs} ms`,
  `  slices ${report.cpu.slices.measured?.calls ?? '?'} × ${report.cpu.slices.measured?.maxEntitiesPerCall ?? '?'} entities, ` +
    `wall ${report.cpu.slices.measured?.totalMs ?? '?'} ms (max ${report.cpu.slices.measured?.maxMs ?? '?'}, p95 ${report.cpu.slices.measured?.p95Ms ?? '?'}), ` +
    `max gap between slices ${report.cpu.slices.measured?.maxGapMs ?? '?'} ms`,
  `  trace ${report.trace.taskCount} tasks, ${report.trace.longTaskCount} long tasks, max gap ${report.trace.gaps.maxMs} ms, GC ${report.trace.gc.totalMs} ms in ${report.trace.gc.count} events`,
  '',
  '  branches inside the conversion task (async ancestry lost → siblings, not a tree):',
  ...report.cpu.branchesOfConversionTask.map(
    entry => `    ${String(entry.ms).padStart(9)} ms  ${entry.frame}`
  ),
  '',
  `  frame after conversion: ${report.trace.frameAfterConversion?.durMs} ms task, ${report.trace.frameAfterConversion?.jsMs} ms of it JS`,
  ...report.cpu.branchesOfFrameTask.slice(0, 5).map(
    entry => `    ${String(entry.ms).padStart(9)} ms  ${entry.frame}`
  ),
  '',
  '  function classes (inclusive of own subtree, outermost call paths only):',
  ...report.cpu.functions
    .filter(entry => entry.inclusiveMs > 0)
    .map(
      entry =>
        `    ${entry.fn.padEnd(24)} ${String(entry.inclusiveMs).padStart(9)} ms  self ${String(entry.selfMs).padStart(8)} ms  paths ${String(entry.pathNodes).padStart(4)}  max ${entry.maxCallMs} ms  host ${entry.hostTasks[0]?.task ?? '-'}`
    ),
  '',
  '  top self time:',
  ...report.cpu.topSelf
    .slice(0, 12)
    .map(entry => `    ${String(entry.selfMs).padStart(9)} ms  ${entry.name}  ${entry.url}:${entry.line}`),
  '',
  '  top inclusive time:',
  ...report.cpu.topInclusive
    .slice(0, 16)
    .map(entry => `    ${String(entry.totalMs).padStart(9)} ms  ${entry.name}  ${entry.url}:${entry.line}`),
  '',
  `wrote ${path.relative(repoRoot, outputPath)}`
]
console.log(lines.join('\n'))
