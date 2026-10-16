<template>
  <div class="pb-root" :class="{ collapsed: !open }">
    <button class="pb-toggle" @click="open = !open">
      <span class="pb-title">Perf Benchmark</span>
      <span class="pb-caret">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-show="open" class="pb-body">
      <div class="pb-row">
        <input type="file" accept=".dwg" @change="onFile" />
      </div>
      <div class="pb-file" v-if="fileName">
        {{ fileName }} · {{ (fileSize / 1024 / 1024).toFixed(2) }} MB
      </div>

      <div class="pb-row pb-opts">
        <label title="Number of timed runs (median reported)">
          runs <input type="number" v-model.number="runs" min="1" max="20" />
        </label>
        <span class="pb-checks">
          <label><input type="checkbox" v-model="pick.ts" /> acad-ts (main)</label>
          <label><input type="checkbox" v-model="pick.rustB" /> acad-rust B (worker·JSON)</label>
          <label><input type="checkbox" v-model="pick.rustA" /> acad-rust A (worker·DXF)</label>
        </span>
      </div>

      <div class="pb-row">
        <button :disabled="!fileName || busy" @click="runAll">
          {{ busy ? 'running…' : 'Run benchmark' }}
        </button>
        <span class="pb-iso" :class="{ on: crossOriginIsolated }">
          crossOriginIsolated: {{ crossOriginIsolated ? 'yes (UASM on)' : 'no (JS-heap only)' }}
        </span>
      </div>

      <div v-if="error" class="pb-error">{{ error }}</div>

      <div v-if="results.length" class="pb-tables">
        <div class="pb-summary">
          <div class="pb-hint">
            Totals are end-to-end <code>converter.read()</code> (median of {{ runs }}).
            Lower is better. acad-ts runs on the <b>main thread</b> (blocks UI);
            acad-rust runs in a <b>worker</b>. Memory excludes wasm/worker heap
            unless crossOriginIsolated.
          </div>
          <table class="pb-table">
            <thead>
              <tr>
                <th>route</th>
                <th>total (median)</th>
                <th>µs/entity</th>
                <th>entities (all)</th>
                <th>unknown</th>
                <th>peak JS heap</th>
                <th title="all timed runs, low-high — shows run-to-run/GC variance">runs (raw ms)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in results" :key="r.key" :class="{ fastest: r.key === fastestKey }">
                <td class="pb-name">{{ r.label }}</td>
                <td>{{ fmtMs(r.medianTotalMs) }}<span class="pb-sub"> / warm {{ fmtMs(r.warmMs) }}</span></td>
                <td>{{ r.usPerEntity != null ? r.usPerEntity.toFixed(1) : '—' }}</td>
                <td>{{ r.entityCount }}</td>
                <td>{{ r.unknownEntityCount }}</td>
                <td>{{ r.peakHeapMB != null ? r.peakHeapMB.toFixed(1) + ' MB' : 'n/a' }}</td>
                <td class="pb-sub">{{ fmtRuns(r.totals) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pb-decode">
          <div class="pb-sub-h">Decode (PARSE) vs Map (rest) — the boundary split</div>
          <table class="pb-table">
            <thead>
              <tr>
                <th>route</th>
                <th>PARSE / decode</th>
                <th>tables</th>
                <th>model ENTITY</th>
                <th>BLOCK (defs)</th>
                <th>other</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in results" :key="r.key">
                <td class="pb-name">{{ r.label }}</td>
                <td>{{ fmtMs(r.decodeMs) }}</td>
                <td>{{ fmtMs(r.tablesMs) }}</td>
                <td>{{ fmtMs(r.modelEntityMs) }}</td>
                <td>{{ fmtMs(r.blockMs) }}</td>
                <td>{{ fmtMs(r.otherStageMs) }}</td>
              </tr>
            </tbody>
          </table>
          <div class="pb-note">
            acad-ts PARSE = pure-JS <code>DwgReader</code> decode into objects; the
    remaining stages are its <code>CadDocument→DB</code> map. acad-rust PARSE = wasm
    <code>dwg_open</code> only; its ENTITY/BLOCK stages bundle
    <b>wasm page serde + JSON copy + worker IPC + JSON.parse + map</b> together
    (that bundling IS the boundary cost).
          </div>
        </div>

        <div class="pb-stages">
          <div class="pb-sub-h">Per-stage detail (median run)</div>
          <div v-for="r in results" :key="'s-' + r.key" class="pb-stage-block">
            <div class="pb-stage-h">{{ r.label }}</div>
            <table class="pb-table pb-mini">
              <tbody>
                <tr v-for="s in r.stages" :key="s.stage">
                  <td>{{ s.stage }}</td>
                  <td>{{ fmtMs(s.durMs) }}</td>
                  <td>
                    <div class="pb-bar" :style="{ width: barPct(s.durMs, r) + '%' }"></div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AcDbAcadRustConverter, AcDbAcadRustNativeConverter } from '@mlightcad/acad-rust-converter'
import { AcDbAcadTsConverter } from '@mlightcad/acad-ts-converter'
import { ACADRUST_PARSER_WORKER_FILE } from '@mlightcad/cad-simple-viewer'
import {
  type AcDbConversionProgressCallback,
  AcDbDatabase,
  acdbHostApplicationServices} from '@mlightcad/data-model'
import { computed, ref } from 'vue'

// Same worker asset the app registers in main.ts, so the benchmark exercises
// the exact deployed acad-rust parser worker.
const parserWorkerUrl = `./assets/${ACADRUST_PARSER_WORKER_FILE}`

type RouteKey = 'ts' | 'rustB' | 'rustA'

interface StageRow {
  stage: string
  durMs: number
}

interface RouteResult {
  key: RouteKey
  label: string
  warmMs: number
  totals: number[]
  medianTotalMs: number
  entityCount: number
  unknownEntityCount: number
  usPerEntity?: number
  peakHeapMB?: number
  decodeMs: number
  tablesMs: number
  modelEntityMs: number
  blockMs: number
  otherStageMs: number
  stages: StageRow[]
}

const open = ref(true)
const runs = ref(3)
const busy = ref(false)
const error = ref('')
const fileName = ref('')
const fileSize = ref(0)
const dwgBuffer = ref<ArrayBuffer | null>(null)
const results = ref<RouteResult[]>([])

const pick = ref({ ts: true, rustB: true, rustA: true })
const crossOriginIsolated = computed(
  () => (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
)

const fastestKey = computed(() => {
  if (results.value.length < 2) return ''
  return results.value.reduce((a, b) => (b.medianTotalMs < a.medianTotalMs ? b : a)).key
})

function onFile(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  error.value = ''
  if (!file) return
  fileName.value = file.name
  fileSize.value = file.size
  file.arrayBuffer().then(buf => {
    dwgBuffer.value = buf
  })
}

// --- per-run timing + stage collection via the shared progress callback -----
interface Collected {
  stages: Record<string, number>
  unknown: number
}

function makeCollector(): { cb: AcDbConversionProgressCallback; out: Collected } {
  const starts = new Map<string, number>()
  const out: Collected = { stages: {}, unknown: 0 }
  const cb: AcDbConversionProgressCallback = async (_pct, stage, status, data) => {
    const key = String(stage)
    const now = performance.now()
    if (status === 'START') {
      starts.set(key, now)
    } else if (status === 'END') {
      const s = starts.get(key)
      if (s != null) {
        // last-writer wins if a stage re-opens; acceptable for a probe.
        out.stages[key] = (out.stages[key] ?? 0) + (now - s)
      }
    }
    if (data && typeof data === 'object' && 'unknownEntityCount' in (data as any)) {
      out.unknown = (data as any).unknownEntityCount
    }
  }
  return { cb, out }
}

function iterCount(it: Iterable<unknown>): number {
  let n = 0
  for (const _ of it) n++
  return n
}

/** Total entities across the whole database (model space + every block
 *  definition). The model-space-only count badly understates drawings whose
 *  bulk lives in block definitions, which is what the per-entity rate needs. */
function countDbEntities(db: AcDbDatabase): number {
  const bt = db.tables.blockTable
  let total = 0
  try {
    for (const rec of bt.newIterator()) {
      try {
        total += iterCount((rec as any).newIterator())
      } catch {
        /* record without an entity iterator — skip */
      }
    }
  } catch {
    /* block table not iterable — fall back below */
  }
  if (!total) {
    try {
      total = iterCount(bt.modelSpace.newIterator())
    } catch {
      /* leave 0 */
    }
  }
  return total
}

function usedHeapBytes(): number | undefined {
  const m = (performance as any).memory
  return m && typeof m.usedJSHeapSize === 'number' ? m.usedJSHeapSize : undefined
}

interface OneRead {
  totalMs: number
  stages: Record<string, number>
  entityCount: number
  unknown: number
  heapAfter?: number
}

async function readOnce(
  makeConverter: () => {
    read(d: ArrayBuffer, db: AcDbDatabase, o?: any): Promise<void>
  },
  buffer: ArrayBuffer
): Promise<OneRead> {
  const converter = makeConverter()
  const db = new AcDbDatabase()
  const copy = buffer.slice(0) // untimed defensive copy (converters may transfer)
  const { cb, out } = makeCollector()
  // The acad-rust section mapper reads acdbHostApplicationServices().workingDatabase
  // while folding JSON->DB on the main thread; a bare `new AcDbDatabase()` is not
  // the "current" database, so set it around the read (and restore after) or the
  // worker result mapping throws "current working database must be set".
  const services = acdbHostApplicationServices()
  let prev: AcDbDatabase | null
  try {
    prev = services.workingDatabase
  } catch {
    prev = null
  }
  services.workingDatabase = db
  const t0 = performance.now()
  try {
    await converter.read(copy, db, { progress: cb })
  } finally {
    // Setter is typed non-null but the JS accepts null (no doc open).
    services.workingDatabase = prev as AcDbDatabase
  }
  const t1 = performance.now()
  return {
    totalMs: t1 - t0,
    stages: out.stages,
    entityCount: countDbEntities(db),
    unknown: out.unknown,
    heapAfter: usedHeapBytes()
  }
}

// Group raw stage durations into the boundary buckets we care about.
function bucketize(stages: Record<string, number>) {
  const decodeMs = stages['PARSE'] ?? 0
  const tableNames = ['LTYPE', 'STYLE', 'DIMSTYLE', 'VPORT', 'LAYER', 'HEADER', 'BLOCK_RECORD', 'OBJECT']
  let tablesMs = 0
  let modelEntityMs = stages['ENTITY'] ?? 0
  let blockMs = stages['BLOCK'] ?? 0
  let otherStageMs = 0
  for (const [k, v] of Object.entries(stages)) {
    if (k === 'PARSE' || k === 'ENTITY' || k === 'BLOCK') continue
    if (tableNames.includes(k)) tablesMs += v
    else otherStageMs += v
  }
  return { decodeMs, tablesMs, modelEntityMs, blockMs, otherStageMs }
}

async function runRoute(key: RouteKey, buffer: ArrayBuffer): Promise<RouteResult> {
  const defs: Record<RouteKey, { label: string; make: () => any }> = {
    ts: {
      label: 'acad-ts (main·JSON-free)',
      make: () => new AcDbAcadTsConverter({ useWorker: false })
    },
    rustB: {
      label: 'acad-rust B (worker·JSON)',
      make: () => new AcDbAcadRustNativeConverter({ useWorker: true, parserWorkerUrl })
    },
    rustA: {
      label: 'acad-rust A (worker·DXF)',
      make: () => new AcDbAcadRustConverter({ useWorker: true, parserWorkerUrl })
    }
  }
  const def = defs[key]
  // Warmup (absorbs wasm fetch/compile + worker boot + JIT).
  const warm = await readOnce(def.make, buffer)

  const totalRuns: number[] = []
  const reads: OneRead[] = []
  let heapPeak = warm.heapAfter ?? 0
  for (let i = 0; i < runs.value; i++) {
    const r = await readOnce(def.make, buffer)
    totalRuns.push(r.totalMs)
    reads.push(r)
    if (r.heapAfter != null) heapPeak = Math.max(heapPeak, r.heapAfter)
    // Yield so long main-thread acad-ts decodes don't wedge the UI thread entirely.
    await new Promise(res => setTimeout(res, 0))
  }

  totalRuns.sort((a, b) => a - b)
  const medianTotalMs = totalRuns[Math.floor((totalRuns.length - 1) / 2)]
  const medianRead = reads.reduce((a, b) =>
    Math.abs(a.totalMs - medianTotalMs) <= Math.abs(b.totalMs - medianTotalMs) ? a : b
  )
  const buckets = bucketize(medianRead.stages)
  const stagesList: StageRow[] = Object.entries(medianRead.stages)
    .map(([stage, durMs]) => ({ stage, durMs }))
    .sort((a, b) => b.durMs - a.durMs)

  const heapBase = usedHeapBytes()
  return {
    key,
    label: def.label,
    warmMs: warm.totalMs,
    totals: totalRuns,
    medianTotalMs,
    entityCount: medianRead.entityCount,
    unknownEntityCount: medianRead.unknown,
    usPerEntity: medianRead.entityCount ? (medianTotalMs * 1000) / medianRead.entityCount : undefined,
    peakHeapMB:
      heapBase != null && heapPeak > heapBase ? (heapPeak - heapBase) / 1024 / 1024 : undefined,
    ...buckets,
    stages: stagesList
  }
}

async function runAll(): Promise<void> {
  const buffer = dwgBuffer.value
  error.value = ''
  results.value = []
  if (!buffer) {
    error.value = 'Choose a .dwg first.'
    return
  }
  busy.value = true
  try {
    // Let the "running…" state paint and any pending GC settle before timing.
    await new Promise(res => setTimeout(res, 50))
    const order: RouteKey[] = (['ts', 'rustB', 'rustA'] as RouteKey[]).filter(
      k => (pick.value as any)[k]
    )
    for (const key of order) {
      try {
        results.value.push(await runRoute(key, buffer))
      } catch (e: any) {
        error.value += `${key} failed: ${e?.message ?? e}\n`
      }
    }
  } finally {
    busy.value = false
  }
}

function fmtMs(ms: number): string {
  if (ms == null || !isFinite(ms)) return '—'
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(1)} ms`
}

function fmtRuns(totals: number[]): string {
  if (!totals?.length) return '—'
  const min = totals[0]
  const max = totals[totals.length - 1]
  const spread = min > 0 ? ((max - min) / min) * 100 : 0
  return `${totals.map(t => Math.round(t)).join(' · ')}  (Δ${spread.toFixed(0)}%)`
}

function barPct(durMs: number, r: RouteResult): number {
  const max = r.stages.reduce((m, s) => Math.max(m, s.durMs), 0)
  return max > 0 ? Math.max(2, (durMs / max) * 100) : 0
}
</script>

<style scoped>
.pb-root {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  overflow: auto;
  background: #0f1420;
  color: #d7deea;
  border: 1px solid #2a3346;
  border-radius: 10px;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  z-index: 99999;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
}
.pb-root.collapsed {
  width: auto;
  overflow: visible;
}
.pb-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: #17203a;
  color: #d7deea;
  border: none;
  cursor: pointer;
  font-weight: 600;
}
.pb-body {
  padding: 10px 12px;
}
.pb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0;
  flex-wrap: wrap;
}
.pb-opts input[type='number'] {
  width: 46px;
}
.pb-checks {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.pb-file {
  color: #9fb3d1;
}
button:not(.pb-toggle) {
  background: #2b62ff;
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.pb-iso {
  color: #ffb454;
}
.pb-iso.on {
  color: #57d38a;
}
.pb-error {
  white-space: pre-wrap;
  color: #ff7b7b;
  margin: 6px 0;
}
.pb-hint,
.pb-note {
  color: #8fa3c0;
  margin: 4px 0 8px;
}
.pb-sub-h {
  font-weight: 600;
  color: #b7c6de;
  margin: 12px 0 4px;
}
.pb-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 6px;
}
.pb-table th,
.pb-table td {
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid #23304a;
}
.pb-table th {
  color: #9fb3d1;
  font-weight: 600;
}
.pb-name {
  white-space: nowrap;
}
.pb-sub {
  color: #6f7f99;
}
tr.fastest td {
  background: #16331f;
}
.pb-mini td {
  border-bottom: 1px solid #1b2740;
}
.pb-bar {
  height: 8px;
  background: linear-gradient(90deg, #2b62ff, #6fb0ff);
  border-radius: 3px;
}
.pb-stage-block {
  margin-bottom: 8px;
}
.pb-stage-h {
  color: #cfe0ff;
  margin: 6px 0 2px;
}
code {
  background: #1b2740;
  padding: 0 3px;
  border-radius: 3px;
}
</style>
