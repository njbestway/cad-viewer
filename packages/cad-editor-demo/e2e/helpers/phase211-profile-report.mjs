/**
 * Phase 2.11 Task G — turns the Task G artifacts into an attribution table.
 *
 * Inputs (written by `e2e/tests/phase211-move-profile.spec.ts`):
 *   reports/phase211/profiles/<tag>.cpuprofile
 *   reports/phase211/profiles/<tag>.trace.json
 *   reports/phase211/profiles/<tag>.raw.json
 * Output:
 *   reports/phase211/phase211-move-conversion-profile.json
 *
 * The commit / conversion split comes from the profile tree, not from page
 * clocks: every sample below the committed transaction node is commit work, and
 * the remainder is view work. Only the CPU profile can attribute that boundary
 * without depending on two different monotonic epochs.
 *
 * Usage: node e2e/helpers/phase211-profile-report.mjs [--tag=move50000]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const profilesDir = path.join(repoRoot, 'reports', 'phase211', 'profiles')
const outputPath = path.join(repoRoot, 'reports', 'phase211', 'phase211-move-conversion-profile.json')

const args = new Map(
  process.argv.slice(2).map(raw => {
    const [key, value = ''] = raw.replace(/^--/, '').split('=')
    return [key, value]
  })
)
const tag = args.get('tag') ?? 'move50000'

const round = value => Math.round(value * 100) / 100

/* ------------------------------------------------------------------ profile */

const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, `${tag}.cpuprofile`), 'utf8'))
const nodes = new Map(profile.nodes.map(node => [node.id, node]))
const selfUs = new Map()
let sampledUs = 0
for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index]
  const delta = profile.timeDeltas[index] ?? 0
  if (delta > 0) {
    selfUs.set(id, (selfUs.get(id) ?? 0) + delta)
    sampledUs += delta
  }
}
const sampleCount = new Map()
for (const id of profile.samples) sampleCount.set(id, (sampleCount.get(id) ?? 0) + 1)

// Parent links, then a post-order total so a subtree can be measured as a whole.
const parentOf = new Map()
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parentOf.set(child, node.id)
}
const totalUs = new Map()
const childrenOf = id => profile.nodes.find(node => node.id === id)?.children ?? []
const resolveTotal = id => {
  if (totalUs.has(id)) return totalUs.get(id)
  totalUs.set(id, 0)
  let total = selfUs.get(id) ?? 0
  for (const child of childrenOf(id)) total += resolveTotal(child)
  totalUs.set(id, total)
  return total
}
for (const node of profile.nodes) resolveTotal(node.id)

const rootIds = profile.nodes.filter(node => !parentOf.has(node.id)).map(node => node.id)

function frameOf(id) {
  const callFrame = nodes.get(id)?.callFrame ?? {}
  return {
    name: callFrame.functionName || '(anonymous)',
    url: (callFrame.url ?? '').replace(/^.*\/(packages|node_modules)\//, '$1/'),
    line: (callFrame.lineNumber ?? -1) + 1
  }
}

function descendants(id, out = []) {
  out.push(id)
  for (const child of childrenOf(id)) descendants(child, out)
  return out
}

/* --------------------------------------------------------- commit subtree */

const COMMIT_PATTERN = /runDatabaseEdit|executeTransaction|commitTransaction|endTransaction|AcDbTransactionManager\.commit/
const commitCandidates = profile.nodes.filter(node => COMMIT_PATTERN.test(node.callFrame.functionName ?? ''))
const commitRoot = commitCandidates.sort((left, right) => resolveTotal(right.id) - resolveTotal(left.id))[0]
const commitIds = new Set(commitRoot ? descendants(commitRoot.id) : [])
const commitMs = (commitRoot ? resolveTotal(commitRoot.id) : 0) / 1000

function topBySelf(ids, limit) {
  return ids
    .map(id => {
      const frame = frameOf(id)
      return {
        ...frame,
        selfMs: round((selfUs.get(id) ?? 0) / 1000),
        samples: sampleCount.get(id) ?? 0
      }
    })
    .filter(entry => entry.selfMs > 0)
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, limit)
}

function topByTotal(ids, limit) {
  return ids
    .map(id => {
      const frame = frameOf(id)
      return {
        ...frame,
        selfMs: round((selfUs.get(id) ?? 0) / 1000),
        totalMs: round(resolveTotal(id) / 1000),
        samples: sampleCount.get(id) ?? 0
      }
    })
    .filter(entry => entry.totalMs > 0)
    .sort((left, right) => right.totalMs - left.totalMs)
    .slice(0, limit)
}

const allIds = profile.nodes.map(node => node.id)
const viewIds = allIds.filter(id => !commitIds.has(id))

/* ----------------------------------------------------------- stage buckets */

const STAGES = [
  ['entityUpdateQueue', /AcTrEntityUpdateQueue|applyEntityUpdates|resolveSceneUpdateEntities/],
  ['convertLoop', /batchConvert|convertEntities|drainConvertQueue/],
  ['existingGeometryRemoval', /removeEntit|deleteGeometry|compactBatches|clearGeometryRange|disposeBatch|removeGeometry/],
  ['drawableConstruction', /drawEntit|createDrawable|toDrawable|buildDrawable|renderEntit|createGeometr/],
  ['finishEntityGeometry', /finishEntityGeometry/],
  ['glyphInsertFinalizer', /MText|Glyph|glyph|BlockReference|Finaliz|finaliz|fragment|Fragment/],
  ['batchedGroupAddEntity', /AcTrBatchedGroup|addDirectEntity|addEntity|addGeometry|insertGeometry/],
  ['optimize', /optimize/],
  ['bufferAttributeCopy', /copyAttribute|copyArray|copyWithin|setXYZ|fromArray|Float32Array|copy\b/],
  ['gpuUploadAndPresent', /WebGL|upload|BufferSubData|updateBuffers|drawElements|present|Renderer\.render|animation/]
]

const stages = STAGES.map(([stage, pattern]) => ({ stage, selfMs: 0, samples: 0, examples: [] }))
const bucketSelf = new Map()
for (const id of allIds) {
  const self = selfUs.get(id) ?? 0
  if (self === 0) continue
  const frame = frameOf(id)
  const haystack = `${frame.name} ${frame.url}`
  const hit = STAGES.findIndex(([, pattern]) => pattern.test(haystack))
  if (hit < 0) continue
  const entry = stages[hit]
  entry.selfMs += self / 1000
  entry.samples += sampleCount.get(id) ?? 0
  bucketSelf.set(frame.name, (bucketSelf.get(frame.name) ?? 0) + self / 1000)
  if (entry.examples.length < 5 && !entry.examples.includes(frame.name)) entry.examples.push(frame.name)
}
const attributedMs = stages.reduce((total, entry) => total + entry.selfMs, 0)

/* ------------------------------------------------------------------- trace */

const traceFile = path.join(profilesDir, `${tag}.trace.json`)
const traceEvents = fs.existsSync(traceFile)
  ? JSON.parse(fs.readFileSync(traceFile, 'utf8')).traceEvents ?? []
  : []

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

// Containment stack: a slice is a child of the deepest slice that still covers it.
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
    ;(parent.biggestChild ??= [])
    if (slice.dur > (parent.biggestChild[0]?.dur ?? 0)) parent.biggestChild.unshift(slice)
    else if (slice.dur > (parent.biggestChild[1]?.dur ?? 0)) parent.biggestChild.splice(1, 0, slice)
    parent.biggestChild.length = Math.min(parent.biggestChild.length, 3)
  }
  stack.push(slice)
}

const tasks = slices
  .filter(event => /RunTask$/.test(event.name) || event.name === 'ThreadControllerImpl::RunTask')
  .filter(event => !event.parentTask)
const longTasks = tasks.filter(event => event.dur >= 50_000).sort((left, right) => right.dur - left.dur)
const coveredUs = tasks.reduce((total, event) => total + event.dur, 0)

/* ------------------------------------------------------------------ report */

const rawPath = path.join(profilesDir, `${tag}.raw.json`)
const raw = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : {}

const report = {
  phase: '2.11',
  task: 'G',
  op: raw.op ?? 'move',
  size: raw.size ?? null,
  tag,
  artifacts: {
    profile: raw.profile ?? path.relative(repoRoot, path.join(profilesDir, `${tag}.cpuprofile`)),
    trace: raw.trace ?? path.relative(repoRoot, traceFile),
    raw: path.relative(repoRoot, rawPath)
  },
  wall: {
    commitMs: raw.commitMs ?? null,
    settleMs: raw.settleMs ?? null,
    totalMs: raw.totalMs ?? null,
    traceWindowMs: raw.traceWindowMs ?? null,
    note: 'commitMs is the synchronous transaction only; settleMs is waitUntilSceneReady afterwards'
  },
  cpu: {
    samplingIntervalUs: profile.timeDeltas?.length ? 200 : null,
    sampledMs: round(sampledUs / 1000),
    commit: {
      root: commitRoot ? frameOf(commitRoot.id) : null,
      totalMs: round(commitMs),
      share: sampledUs > 0 ? round((commitMs / (sampledUs / 1000)) * 100) : 0,
      topFrames: topBySelf([...commitIds], 12),
      topSubtree: topByTotal([...commitIds].filter(id => id !== commitRoot?.id), 8)
    },
    conversion: {
      totalMs: round((sampledUs - (commitRoot ? resolveTotal(commitRoot.id) : 0)) / 1000),
      topFrames: topBySelf(viewIds, 25),
      stages: stages
        .map(entry => ({
          stage: entry.stage,
          selfMs: round(entry.selfMs),
          shareOfSampled: sampledUs > 0 ? round((entry.selfMs / (sampledUs / 1000)) * 100) : 0,
          samples: entry.samples,
          examples: entry.examples
        }))
        .sort((left, right) => right.selfMs - left.selfMs),
      attributedMs: round(attributedMs),
      unattributedMs: round(sampledUs / 1000 - attributedMs),
      unattributedTop: topBySelf(
        allIds.filter(id => {
          const frame = frameOf(id)
          const haystack = `${frame.name} ${frame.url}`
          return (selfUs.get(id) ?? 0) > 0 && !STAGES.some(([, pattern]) => pattern.test(haystack))
        }),
        15
      )
    }
  },
  trace: {
    eventCount: traceEvents.length,
    mainThread: { pid: mainPid ?? null, tid: mainTid ?? null },
    taskCount: tasks.length,
    coveredMs: round(coveredUs / 1000),
    longTaskCount: longTasks.length,
    longest: longTasks.slice(0, 12).map(event => ({
      name: event.name,
      durMs: round(event.dur / 1000),
      childCount: event.childCount ?? 0,
      biggestChildren: (event.biggestChild ?? []).map(child => ({
        name: child.name,
        durMs: round(child.dur / 1000)
      }))
    }))
  },
  counters: {
    before: raw.before ?? null,
    after: raw.after ?? null
  },
  caveats: [
    'CPU profile self time is sampled at 200 µs; it is a shape, not an invoice.',
    'Stage buckets are name matches over self time and are disjoint: a frame belongs to the first bucket its name or url matches.',
    'The trace covers only the head of the conversion (traceWindowMs); the profile covers all of it.',
    'No production code was changed to produce this file; every number comes from the shipped build.'
  ]
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const lines = [
  `phase 2.11 Task G — MOVE conversion profile (${tag})`,
  `  wall   commit ${report.wall.commitMs} ms, settle ${report.wall.settleMs} ms`,
  `  cpu    sampled ${report.cpu.sampledMs} ms; commit ${report.cpu.commit.totalMs} ms (${report.cpu.commit.share}%), conversion ${report.cpu.conversion.totalMs} ms`,
  `  trace  ${report.trace.taskCount} tasks, ${report.trace.longTaskCount} long tasks, covered ${report.trace.coveredMs} ms`,
  '',
  '  stages (self time):',
  ...report.cpu.conversion.stages
    .filter(entry => entry.selfMs > 0)
    .map(entry => `    ${entry.stage.padEnd(26)} ${String(entry.selfMs).padStart(9)} ms  ${String(entry.shareOfSampled).padStart(6)}%  ${entry.examples.slice(0, 3).join(', ')}`),
  '',
  '  top conversion frames:',
  ...report.cpu.conversion.topFrames
    .slice(0, 12)
    .map(entry => `    ${String(entry.selfMs).padStart(9)} ms  ${entry.name}  ${entry.url}:${entry.line}`),
  '',
  '  longest tasks:',
  ...report.trace.longest
    .slice(0, 6)
    .map(
      entry =>
        `    ${String(entry.durMs).padStart(9)} ms  ${entry.name} (${entry.childCount} children; ` +
        `${entry.biggestChildren.map(child => `${child.name} ${child.durMs}ms`).join(', ')})`
    ),
  '',
  `wrote ${path.relative(repoRoot, outputPath)}`
]
console.log(lines.join('\n'))
