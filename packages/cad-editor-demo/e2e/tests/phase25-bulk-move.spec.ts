import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page,test } from '@playwright/test'

import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.5 — bulk MOVE / ERASE in a real WebGL browser.
 *
 * Phase 1.5 proved *correctness* on a 20k fixture. It did not answer whether a
 * 50k / 100k MOVE is usable, so this spec measures the three timings that only
 * a browser can produce, and asserts the invariants that a headless harness
 * cannot see:
 *
 * | timing | start | end |
 * | --- | --- | --- |
 * | `moveMs` | before `entityService.translateEntities()` | the call returns (database committed + synchronous render fan-out) |
 * | `settleMs` | right after | `view.waitUntilIdle()` resolves (deferred conversion drained) |
 * | `frameMs` | right after | two `requestAnimationFrame` ticks (a real present) |
 *
 * The MOVE is driven through the production path
 * (`AcApDocument.entityService.translateEntities` → `runDatabaseEdit` → one undo
 * mark), so Undo / Redo and the `entityModified` fan-out are the real ones.
 *
 * Everything is written to `reports/phase25/browser-move.json`. Frame timing is
 * sampled from `requestAnimationFrame`, which is a *present* observation, not a
 * GPU-time measurement: the page cannot read `EXT_disjoint_timer_query` numbers
 * portably, so per-frame GPU cost stays unavailable and is listed as such.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase25')
const reportPath = path.join(reportsDir, 'browser-move.json')

interface Findings {
  browser: string
  environment: Record<string, unknown>
  fixtures: string[]
  steps: string[]
  results: Record<string, unknown>
  errors: string[]
  unavailableMetrics: Record<string, string>
}

const findings: Findings = {
  browser: '',
  environment: {},
  fixtures: [],
  steps: [],
  results: {},
  errors: [],
  unavailableMetrics: {
    gpuFrameMs:
      'The page cannot read GPU timings portably (EXT_disjoint_timer_query is unavailable in most headless WebGL contexts). frameMs measures the rAF interval, i.e. CPU + present, not GPU time.',
    sampledPeakHeapMB:
      'performance.memory is a point sample of usedJSHeapSize; a true peak needs a sampling profiler attached to the browser process.',
    swapChainMemory:
      'Canvas back-buffer memory is owned by the compositor and is not exposed to the page.'
  }
}

function flushFindings() {
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Deterministic DXF writer (same dialect as the Phase 1.5 spec)
 * ------------------------------------------------------------------ */

function dxfPair(code: number, value: string | number) {
  return `${code}\n${value}\n`
}

function dxfHeader() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'HEADER') +
    dxfPair(9, '$ACADVER') +
    dxfPair(1, 'AC1015') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfTables() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'TABLES') +
    dxfPair(0, 'TABLE') +
    dxfPair(2, 'LTYPE') +
    dxfPair(70, 1) +
    dxfPair(0, 'LTYPE') +
    dxfPair(2, 'CONTINUOUS') +
    dxfPair(70, 0) +
    dxfPair(3, 'Solid line') +
    dxfPair(72, 65) +
    dxfPair(73, 0) +
    dxfPair(40, 0.0) +
    dxfPair(0, 'ENDTAB') +
    dxfPair(0, 'TABLE') +
    dxfPair(2, 'LAYER') +
    dxfPair(70, 3) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, '0') +
    dxfPair(70, 0) +
    dxfPair(62, 7) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(370, -1) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'LINES') +
    dxfPair(70, 0) +
    dxfPair(62, 3) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(370, -1) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'MARKS') +
    dxfPair(70, 0) +
    dxfPair(62, 5) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(370, -1) +
    dxfPair(0, 'ENDTAB') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfBlocks() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'BLOCKS') +
    dxfPair(0, 'BLOCK') +
    dxfPair(8, '0') +
    dxfPair(2, 'P25_BLK') +
    dxfPair(70, 0) +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(30, 0) +
    dxfPair(0, 'LINE') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(11, 2) +
    dxfPair(21, 0) +
    dxfPair(0, 'LINE') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(11, 0) +
    dxfPair(21, 2) +
    dxfPair(0, 'ENDBLK') +
    dxfPair(8, '0') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfLine(x1: number, y1: number, x2: number, y2: number, layer: string) {
  return (
    dxfPair(0, 'LINE') +
    dxfPair(8, layer) +
    dxfPair(10, x1) +
    dxfPair(20, y1) +
    dxfPair(30, 0) +
    dxfPair(11, x2) +
    dxfPair(21, y2) +
    dxfPair(31, 0)
  )
}

function dxfPolyline(originX: number, originY: number, size: number, layer: string) {
  return (
    dxfPair(0, 'LWPOLYLINE') +
    dxfPair(8, layer) +
    dxfPair(90, 4) +
    dxfPair(70, 1) +
    dxfPair(10, originX) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY) +
    dxfPair(10, originX + size) +
    dxfPair(20, originY + size) +
    dxfPair(10, originX) +
    dxfPair(20, originY + size)
  )
}

function dxfText(x: number, y: number, value: string) {
  return (
    dxfPair(0, 'TEXT') +
    dxfPair(8, 'MARKS') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0) +
    dxfPair(40, 2) +
    dxfPair(1, value)
  )
}

function dxfInsert(x: number, y: number) {
  return (
    dxfPair(0, 'INSERT') +
    dxfPair(8, 'MARKS') +
    dxfPair(2, 'P25_BLK') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0)
  )
}

function dxfDocument(entities: string) {
  return (
    dxfHeader() +
    dxfTables() +
    dxfBlocks() +
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'ENTITIES') +
    entities +
    dxfPair(0, 'ENDSEC') +
    dxfPair(0, 'EOF')
  )
}

/**
 * Mixed fixture: 6 LINE / 2 LWPOLYLINE / 1 INSERT / 1 TEXT per 10 entities.
 *
 * Each cell of the grid is 3 x 3 with a 2 x 2 entity inside it, so the centre
 * of a cell belongs to exactly one entity. That makes the pick probes exact:
 * `entity[index]` can be found at `centreOf(index)` and nowhere else.
 */
function writeMoveFixture(count: number): string {
  const parts: string[] = []
  for (let index = 0; index < count; index++) {
    const column = index % 100
    const row = Math.floor(index / 100)
    const x = column * 3
    const y = row * 3
    const kind = index % 10
    if (kind < 6) parts.push(dxfLine(x, y, x + 2, y + 2, 'LINES'))
    else if (kind < 8) parts.push(dxfPolyline(x, y, 2, 'LINES'))
    else if (kind === 8) parts.push(dxfInsert(x, y))
    else parts.push(dxfText(x, y, `T${index}`))
  }
  const file = path.join(os.tmpdir(), `phase25-mixed-${count}.dxf`)
  fs.writeFileSync(file, dxfDocument(parts.join('')), 'utf8')
  return file
}

const GRID_CELL = 3
/** Centre of grid cell `index` — the only point that entity can be picked at. */
function centreOf(index: number) {
  return { x: (index % 100) * GRID_CELL + 1, y: Math.floor(index / 100) * GRID_CELL + 1 }
}

/* ------------------------------------------------------------------ *
 * Page helpers
 * ------------------------------------------------------------------ */

type PageWindow = Window & {
  AcApDocManager?: { instance: Record<string, unknown> }
  __phase25?: Record<string, unknown>
}

/** Installs long-task / error probes before the app boots. */
async function installProbes(page: Page) {
  await page.addInitScript(() => {
    const state: {
      longTasks: Array<{ start: number; duration: number }>
      errors: string[]
    } = { longTasks: [], errors: [] }
    ;(window as unknown as { __phase25Probe: typeof state }).__phase25Probe = state
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is not observable in every context; samples stay empty.
    }
    window.addEventListener('error', event => {
      state.errors.push(String(event.message))
    })
    window.addEventListener('unhandledrejection', event => {
      state.errors.push(`unhandledrejection: ${String(event.reason)}`)
    })
  })
}

async function bindHandles(page: Page) {
  const bound = await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const mgr = win.AcApDocManager?.instance as
      | {
          curView?: Record<string, unknown>
          curDocument?: { database?: Record<string, unknown> }
        }
      | undefined
    const view = mgr?.curView
    if (!mgr || !view || !mgr.curDocument?.database) return false
    win.__phase25 = { mgr, view }
    return true
  })
  expect(bound, 'AcApDocManager.instance / curView / database must be reachable').toBe(true)
}

async function openDrawing(
  page: Page,
  fixturePath: string,
  timeoutMs = 120_000,
  expectedEntities = 0
) {
  await installProbes(page)
  await page.goto('/')
  await uploadFixture(page, fixturePath)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 30_000 })
  const readCount = async () =>
    page.evaluate(() => {
      const win = window as unknown as PageWindow
      const mgr = win.AcApDocManager?.instance as
        | {
            curDocument?: {
              database?: {
                tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
              }
            }
          }
        | undefined
      const iterator = mgr?.curDocument?.database?.tables.blockTable.modelSpace.newIterator()
      if (!iterator) return 0
      let count = 0
      for (const entity of iterator) if (entity) count++
      return count
    })
  // The parser appends incrementally, so `> 0` only means "the first batch
  // landed". Waiting for the exact fixture size is what makes the 100k case
  // meaningful: without it the MOVE started at 57k entities.
  if (expectedEntities > 0) {
    await expect.poll(readCount, { timeout: timeoutMs }).toBe(expectedEntities)
  } else {
    await expect.poll(readCount, { timeout: timeoutMs }).toBeGreaterThan(0)
  }
  await bindHandles(page)
}

/**
 * Waits for `renderUpdateSettled`, then for two real frames.
 *
 * `waitUntilIdle()` alone cannot name the boundary: it samples
 * `isProcessingEntities`, and it returns after two idle samples, which is
 * exactly the window between the commit returning and the entity-update queue's
 * `setTimeout(0)` flush firing. The explicit poll below therefore also checks
 * `pendingEntityUpdates` (the coalesced wave) and the convert/deferred counters,
 * and `isProcessingEntities` covers the window where a wave has been taken but
 * is still draining (`AcTrEntityUpdateQueue.isBusy` includes `_draining`).
 *
 * `waitUntilIdleMs` is reported separately so the two halves stay separable:
 * a `settleMs` that equals `waitUntilIdleMs` means the wave had not started yet.
 */
async function waitIdle(page: Page, timeoutMs = 120_000) {
  const settle = await page.evaluate(async budget => {
    const win = window as unknown as PageWindow
    const view = win.__phase25?.view as {
      waitUntilIdle?: (timeout?: number) => Promise<boolean>
      getOpenConvertStats?: () => Record<string, number>
      isProcessingEntities?: boolean
    }
    const startedAt = performance.now()
    if (view.waitUntilIdle) await view.waitUntilIdle(budget)
    const waitUntilIdleMs = Math.round(performance.now() - startedAt)
    const readBusy = () => {
      const stats = view.getOpenConvertStats?.() ?? {}
      return {
        processing: Boolean(view.isProcessingEntities),
        pendingEntityUpdates: stats.pendingEntityUpdates ?? 0,
        open: (stats.pendingEntities ?? 0) +
          (stats.convertQueued ?? 0) +
          (stats.deferredActive ?? 0) +
          (stats.pendingGeometryJobs ?? 0)
      }
    }
    const isIdle = (busy: ReturnType<typeof readBusy>) =>
      !busy.processing && busy.pendingEntityUpdates === 0 && busy.open === 0
    const deadline = performance.now() + budget
    let idleStreak = 0
    let busyAtReturn = readBusy()
    while (idleStreak < 2 && performance.now() < deadline) {
      busyAtReturn = readBusy()
      idleStreak = isIdle(busyAtReturn) ? idleStreak + 1 : 0
      if (idleStreak >= 2) break
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
    return {
      waitUntilIdleMs,
      settleMs: Math.round(performance.now() - startedAt),
      busyAtReturn
    }
  }, timeoutMs)
  const frameMs = await page.evaluate(async () => {
    const startedAt = performance.now()
    await new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    return Math.round(performance.now() - startedAt)
  })
  return { ...settle, frameMs }
}

interface SceneSnapshot {
  entityCount: number
  sceneEntityCount: number
  types: Record<string, number>
  ids: string[]
  erasedGuardSize: number
  generationSize: number
  claimedSize: number
  processing: boolean
  heapUsedBytes: number | null
  convertStats: Record<string, number> | null
  queueStats: Record<string, number> | null
}

async function readScene(page: Page): Promise<SceneSnapshot> {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const mgr = win.__phase25?.mgr as
      | {
          curDocument?: {
            database?: {
              tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
            }
          }
        }
      | undefined
    const view = win.__phase25?.view as {
      isProcessingEntities?: boolean
      entityUpdateStats?: Record<string, number>
      getOpenConvertStats?: () => Record<string, number>
      _erasedConvertObjectIds?: Set<string>
      _entityConvertGeneration?: Map<string, number>
      _claimedConvertObjectIds?: Set<string>
      _scene?: { stats?: { summary?: { entityCount?: number } } }
    }
    const ids: string[] = []
    const types: Record<string, number> = {}
    const modelSpace = mgr?.curDocument?.database?.tables.blockTable.modelSpace
    if (modelSpace) {
      for (const raw of modelSpace.newIterator()) {
        const entity = raw as { objectId: string; type?: string; dxfTypeName?: string }
        ids.push(String(entity.objectId))
        const type = String(entity.dxfTypeName ?? entity.type ?? 'UNKNOWN')
        types[type] = (types[type] ?? 0) + 1
      }
    }
    const perf = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return {
      entityCount: ids.length,
      sceneEntityCount: view._scene?.stats?.summary?.entityCount ?? -1,
      types,
      ids,
      erasedGuardSize: view._erasedConvertObjectIds?.size ?? -1,
      generationSize: view._entityConvertGeneration?.size ?? -1,
      claimedSize: view._claimedConvertObjectIds?.size ?? -1,
      processing: Boolean(view.isProcessingEntities),
      heapUsedBytes: perf ? perf.usedJSHeapSize : null,
      convertStats: view.getOpenConvertStats ? view.getOpenConvertStats() : null,
      queueStats: view.entityUpdateStats ?? null
    }
  })
}

interface MoveResult {
  moved: number
  moveMs: number
  batchCount: number
}

/**
 * Translates the first `count` model-space entities by (dx, dy).
 *
 * `AcApEntityService.transformEntities()` opens each entity for write but does
 * **not** commit: it is designed to be called inside a database edit. Wrapping
 * the call in `AcDbDatabase.runDatabaseEdit()` is what gives the MOVE its undo
 * mark and its `entityModified` fan-out, i.e. the same path the editor command
 * uses. Without the wrapper the entities are written inside an open transaction
 * that is never committed, and neither the spatial index nor the scene moves.
 *
 * Batching is only used above `maxBatch` ids so the 100k case does not hold one
 * 100k-element array of cloned entities at once; every batch is its own undo
 * mark, which the Undo/Redo cases below account for.
 */
async function translatePrefix(
  page: Page,
  count: number,
  dx: number,
  dy: number,
  maxBatch = 0
): Promise<MoveResult> {
  return page.evaluate(
    ({ wanted, offsetX, offsetY, batchSize }) => {
      const win = window as unknown as PageWindow
      const mgr = win.__phase25?.mgr as {
        curDocument: {
          database: {
            tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
            runDatabaseEdit: (label: string, fn: () => void) => void
          }
          entityService: {
            getEntitiesByIds: (ids: string[]) => unknown[]
            translateEntities: (
              entities: unknown[],
              displacement: { x: number; y: number; z: number }
            ) => number
          }
        }
      }
      const doc = mgr.curDocument
      const ids = Array.from(doc.database.tables.blockTable.modelSpace.newIterator())
        .slice(0, wanted)
        .map(entity => String((entity as { objectId: string }).objectId))

      let moved = 0
      let batchCount = 0
      const translate = (slice: string[]) => {
        doc.database.runDatabaseEdit('phase25-move', () => {
          const entities = doc.entityService.getEntitiesByIds(slice)
          moved += doc.entityService.translateEntities(entities, {
            x: offsetX,
            y: offsetY,
            z: 0
          })
        })
        batchCount++
      }

      const startedAt = performance.now()
      if (batchSize > 0 && ids.length > batchSize) {
        for (let index = 0; index < ids.length; index += batchSize) {
          translate(ids.slice(index, index + batchSize))
        }
      } else {
        translate(ids)
      }
      return {
        moved,
        moveMs: Math.round((performance.now() - startedAt) * 10) / 10,
        batchCount
      }
    },
    { wanted: count, offsetX: dx, offsetY: dy, batchSize: maxBatch }
  )
}

/** Erases the first `count` ids through the production service. */
async function erasePrefix(page: Page, count: number, batchSize = 2000) {
  return page.evaluate(
    ({ wanted, batch }) => {
      const win = window as unknown as PageWindow
      const mgr = win.__phase25?.mgr as {
        curDocument: {
          database: {
            tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
          }
          entityService: { eraseEntities: (ids: string[]) => number }
        }
      }
      const ids = Array.from(
        mgr.curDocument.database.tables.blockTable.modelSpace.newIterator()
      )
        .slice(0, wanted)
        .map(entity => String((entity as { objectId: string }).objectId))
      const startedAt = performance.now()
      let erased = 0
      let batchCount = 0
      for (let index = 0; index < ids.length; index += batch) {
        erased += mgr.curDocument.entityService.eraseEntities(ids.slice(index, index + batch))
        batchCount++
      }
      return {
        erased,
        eraseMs: Math.round((performance.now() - startedAt) * 10) / 10,
        batchCount
      }
    },
    { wanted: count, batch: batchSize }
  )
}

async function undo(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const tm = (win.__phase25?.mgr as {
      curDocument?: { database?: { transactionManager: { undo: () => boolean } } }
    })?.curDocument?.database?.transactionManager
    if (!tm) throw new Error('transactionManager unavailable')
    return tm.undo()
  })
}

async function redo(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const tm = (win.__phase25?.mgr as {
      curDocument?: { database?: { transactionManager: { redo: () => boolean } } }
    })?.curDocument?.database?.transactionManager
    if (!tm) throw new Error('transactionManager unavailable')
    return tm.redo()
  })
}

async function pickAt(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ px, py }) => {
      const win = window as unknown as PageWindow
      const view = win.__phase25?.view as {
        pick: (point: { x: number; y: number }, hitRadius?: number) => Array<{ id: string }>
      }
      return view.pick({ x: px, y: py }, 2).map(item => String(item.id))
    },
    { px: x, py: y }
  )
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Window selection through the spatial index; returns raw (possibly repeated) ids. */
async function searchBox(page: Page, box: Box) {
  return page.evaluate(
    ({ x0, y0, x1, y1 }) => {
      const win = window as unknown as PageWindow
      const view = win.__phase25?.view as {
        getDrawingExtents: () =>
          | { constructor: new (min: unknown, max: unknown) => unknown }
          | undefined
        search: (box: unknown) => Array<{ id: string }>
      }
      const extents = view.getDrawingExtents()
      if (!extents) return [] as string[]
      const BoxCtor = extents.constructor as new (
        min: { x: number; y: number },
        max: { x: number; y: number }
      ) => unknown
      return view.search(new BoxCtor({ x: x0, y: y0 }, { x: x1, y: y1 })).map(item =>
        String(item.id)
      )
    },
    { x0: box.minX, y0: box.minY, x1: box.maxX, y1: box.maxY }
  )
}

async function readExtents(page: Page): Promise<Box | null> {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.__phase25?.view as {
      getDrawingExtents: () =>
        | { min: { x: number; y: number }; max: { x: number; y: number } }
        | undefined
    }
    const box = view.getDrawingExtents()
    if (!box) return null
    return { minX: box.min.x, minY: box.min.y, maxX: box.max.x, maxY: box.max.y }
  })
}

/** How many of `ids` the renderer still holds as a drawable. */
async function countPresent(page: Page, ids: string[]) {
  return page.evaluate(targets => {
    const win = window as unknown as PageWindow
    const view = win.__phase25?.view as { hasEntity: (id: string) => boolean }
    let present = 0
    for (const id of targets) if (view.hasEntity(id)) present++
    return present
  }, ids)
}

const PROBE_BOTTOM_SKIP = 40
const PROBE_CHANNEL_MIN = 100

async function countNonBackgroundPixels(page: Page) {
  const canvas = page.locator('.ml-cad-container canvas').first()
  await expect(canvas).toBeVisible()
  const pngBase64 = (await canvas.screenshot()).toString('base64')
  return page.evaluate(
    async ({ imageBase64, bottomSkip, channelMin }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${imageBase64}`
      await image.decode()
      const probe = document.createElement('canvas')
      probe.width = image.naturalWidth
      probe.height = image.naturalHeight
      const ctx = probe.getContext('2d')
      if (!ctx) throw new Error('Failed to create 2d context for screenshot probe')
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(0, 0, probe.width, probe.height)
      const scanHeight = Math.max(1, probe.height - bottomSkip)
      let count = 0
      for (let y = 0; y < scanHeight; y++) {
        const rowStart = y * probe.width * 4
        for (let x = 0; x < probe.width; x += 2) {
          const i = rowStart + x * 4
          if (data[i + 3] < 200) continue
          if (data[i] > channelMin || data[i + 1] > channelMin || data[i + 2] > channelMin) count++
        }
      }
      return count
    },
    { imageBase64: pngBase64, bottomSkip: PROBE_BOTTOM_SKIP, channelMin: PROBE_CHANNEL_MIN }
  )
}

async function collectEnvironment(page: Page) {
  const env = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    let renderer = 'unavailable'
    let vendor = 'unavailable'
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      if (info) {
        renderer = String(gl.getParameter((info as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL))
        vendor = String(gl.getParameter((info as { UNMASKED_VENDOR_WEBGL: number }).UNMASKED_VENDOR_WEBGL))
      }
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    }
    const memory = (performance as Performance & {
      memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number }
    }).memory
    const probe = (window as unknown as {
      __phase25Probe?: { longTasks: Array<{ duration: number }> }
    }).__phase25Probe
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
      jsHeapSizeLimitMB: memory ? Math.round(memory.jsHeapSizeLimit / 1024 / 1024) : null,
      webglVendor: vendor,
      webglRenderer: renderer,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      longTaskCount: probe?.longTasks.length ?? null,
      longTaskMaxMs: probe?.longTasks.length
        ? Math.max(...probe.longTasks.map(task => task.duration))
        : null
    }
  })
  return {
    ...env,
    hostCpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
    hostMemGB: Math.round(os.totalmem() / 1024 ** 3)
  }
}

async function readProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as {
      __phase25Probe?: { longTasks: Array<{ duration: number }>; errors: string[] }
    }).__phase25Probe
    const tasks = probe?.longTasks ?? []
    return {
      longTaskCount: tasks.length,
      longTaskMaxMs: tasks.length ? Math.max(...tasks.map(task => task.duration)) : 0,
      longTaskTotalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
      errors: probe?.errors ?? []
    }
  })
}

function heapMB(bytes: number | null) {
  return bytes == null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10
}

/**
 * Structural consistency checks shared by every MOVE / ERASE case.
 *
 * `searchBox` covers a generous box around the fixture so the spatial index has
 * to answer for every entity. A repeated id means the same entity was indexed
 * twice (duplicate geometry); a missing id means it was dropped.
 */
async function assertSceneConsistent(page: Page, expectedCount: number, sampleIds: string[]) {
  const scene = await readScene(page)
  const present = await countPresent(page, sampleIds)
  const searchIds = await searchBox(page, {
    minX: -10,
    minY: -10,
    maxX: 20_000,
    maxY: 20_000
  })
  const unique = new Set(searchIds)
  return {
    sceneEntityCount: scene.sceneEntityCount,
    duplicates: searchIds.length - unique.size,
    present,
    sampled: sampleIds.length,
    searchCount: searchIds.length,
    searchUnique: unique.size,
    duplicateIds: searchIds.length - unique.size,
    sceneVsDatabase: scene.sceneEntityCount - expectedCount
  }
}

// Serial: every case appends to one report and a real WebGL context is
// expensive enough that parallel workers would only add noise.
test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 })

test.beforeAll(() => {
  findings.fixtures.push(
    'phase25-mixed-<n>.dxf (generated: 6 LINE / 2 LWPOLYLINE / 1 INSERT / 1 TEXT per 10 entities, 3-unit grid)'
  )
  flushFindings()
})

test('10k MOVE settles, moves every drawable once, and keeps picking exact', async ({
  page
}) => {
  const fixture = writeMoveFixture(10_000)
  await openDrawing(page, fixture, 120_000, 10_000)
  const env = await collectEnvironment(page)
  findings.environment = env
  findings.browser = String(env.userAgent)
  await waitIdle(page)

  const before = await readScene(page)
  expect(before.entityCount).toBe(10_000)
  expect(Object.keys(before.types).sort()).toEqual(
    expect.arrayContaining(['LINE', 'LWPOLYLINE', 'INSERT', 'TEXT'])
  )

  // Exact pick probe on grid cell 0, then a full-drawing MOVE.
  const centre = centreOf(0)
  const hitsBefore = await pickAt(page, centre.x, centre.y)
  expect(hitsBefore.length).toBeGreaterThan(0)
  const probeId = hitsBefore[0]

  const dx = 200
  const dy = 200
  const extentsBeforeMove = await readExtents(page)
  const move = await translatePrefix(page, 10_000, dx, dy)
  const settle = await waitIdle(page)
  const pixelsAfter = await countNonBackgroundPixels(page)

  const after = await readScene(page)
  const hitsAfter = await pickAt(page, centre.x + dx, centre.y + dy)
  const hitsAtOldSpot = await pickAt(page, centre.x, centre.y)

  // Diagnostic record kept in the report. It is what proved the first attempt
  // wrong: calling `translateEntities()` outside a database edit left the
  // drawing extents and the spatial index untouched, so every pick still hit
  // the original position.
  const diagnostics = {
    firstIds: before.ids.slice(0, 3),
    hitsBefore,
    probeId,
    extentsBeforeMove,
    moved: move.moved,
    presentFirst: await countPresent(page, before.ids.slice(0, 3)),
    hitsAfter,
    hitsAtOldSpot,
    searchOriginalCell: (
      await searchBox(page, { minX: -1, minY: -1, maxX: 3, maxY: 3 })
    ).slice(0, 6),
    searchMovedCell: (
      await searchBox(page, { minX: 199, minY: 199, maxX: 203, maxY: 203 })
    ).slice(0, 6),
    extentsAfterMove: await readExtents(page),
    sceneEntityCount: after.sceneEntityCount
  }

  expect(move.moved).toBe(10_000)
  expect(after.entityCount).toBe(10_000)
  expect(hitsAfter).toContain(probeId)
  expect(hitsAtOldSpot).not.toContain(probeId)
  expect(pixelsAfter).toBeGreaterThan(0)

  const consistency = await assertSceneConsistent(
    page,
    10_000,
    before.ids.filter((_, index) => index % 97 === 0)
  )
  expect(consistency.present).toBe(consistency.sampled)
  expect(consistency.duplicateIds).toBe(0)

  const probe = await readProbe(page)
  findings.results.move10k = {
    entities: 10_000,
    moveMs: move.moveMs,
    settleMs: settle.settleMs,
    waitUntilIdleMs: settle.waitUntilIdleMs,
    busyAtReturn: settle.busyAtReturn,
    frameMs: settle.frameMs,
    batchCount: move.batchCount,
    queueStats: after.queueStats,
    heapBeforeMB: heapMB(before.heapUsedBytes),
    heapAfterMB: heapMB(after.heapUsedBytes),
    sceneEntityCount: consistency.sceneEntityCount,
    sceneVsDatabase: consistency.sceneVsDatabase,
    searchCount: consistency.searchCount,
    searchUnique: consistency.searchUnique,
    duplicateIds: consistency.duplicateIds,
    sampledPresent: consistency.present,
    sampled: consistency.sampled,
    pickProbe: { id: probeId, hitsBefore, hitsAfter, hitsAtOldSpot },
    diagnostics,
    pixelsAfter,
    longTasks: probe
  }
  expect(probe.errors).toEqual([])
  findings.steps.push(
    'open 10k mixed fixture → idle → pick(1,1) → translateEntities(10k, +200/+200) → waitUntilIdle + 2 rAF → pick(201,201) → search spatial index → hasEntity sample'
  )
  flushFindings()
})

test('50k MOVE: linear-ish cost, no duplicate or lost drawables', async ({ page }) => {
  test.setTimeout(900_000)
  const fixture = writeMoveFixture(50_000)
  await openDrawing(page, fixture, 300_000, 50_000)
  await waitIdle(page, 300_000)

  const before = await readScene(page)
  expect(before.entityCount).toBe(50_000)

  const move = await translatePrefix(page, 50_000, 120, 60)
  const settle = await waitIdle(page, 300_000)
  const after = await readScene(page)

  expect(move.moved).toBe(50_000)
  expect(after.entityCount).toBe(50_000)

  const consistency = await assertSceneConsistent(
    page,
    50_000,
    before.ids.filter((_, index) => index % 211 === 0)
  )
  expect(consistency.present).toBe(consistency.sampled)
  expect(consistency.duplicateIds).toBe(0)

  const probe = await readProbe(page)
  findings.results.move50k = {
    entities: 50_000,
    moveMs: move.moveMs,
    settleMs: settle.settleMs,
    waitUntilIdleMs: settle.waitUntilIdleMs,
    busyAtReturn: settle.busyAtReturn,
    frameMs: settle.frameMs,
    batchCount: move.batchCount,
    queueStats: after.queueStats,
    heapBeforeMB: heapMB(before.heapUsedBytes),
    heapAfterMB: heapMB(after.heapUsedBytes),
    sceneEntityCount: consistency.sceneEntityCount,
    sceneVsDatabase: consistency.sceneVsDatabase,
    searchCount: consistency.searchCount,
    searchUnique: consistency.searchUnique,
    duplicateIds: consistency.duplicateIds,
    sampledPresent: consistency.present,
    sampled: consistency.sampled,
    longTasks: probe
  }
  expect(probe.errors).toEqual([])
  findings.steps.push('open 50k mixed fixture → idle → translateEntities(50k, +120/+60) → idle → spatial search + hasEntity sample')
  flushFindings()
})

test('100k MOVE: measured when the context can complete it', async ({ page }) => {
  test.setTimeout(1_200_000)
  const fixture = writeMoveFixture(100_000)
  await openDrawing(page, fixture, 600_000, 100_000)
  await waitIdle(page, 600_000)

  const before = await readScene(page)
  expect(before.entityCount).toBe(100_000)

  // 5k batches: one 100k transaction in a browser tab needs ~1 GB of transient
  // clones and is the case most likely to hit the renderer's OOM limit. The
  // batch count is recorded so the number is never confused with a single
  // transaction.
  const move = await translatePrefix(page, 100_000, 90, 90, 5_000)
  const settle = await waitIdle(page, 600_000)
  const after = await readScene(page)

  expect(move.moved).toBe(100_000)
  expect(after.entityCount).toBe(100_000)

  const consistency = await assertSceneConsistent(
    page,
    100_000,
    before.ids.filter((_, index) => index % 499 === 0)
  )
  expect(consistency.present).toBe(consistency.sampled)
  expect(consistency.duplicateIds).toBe(0)

  const probe = await readProbe(page)
  findings.results.move100k = {
    entities: 100_000,
    moveMs: move.moveMs,
    settleMs: settle.settleMs,
    waitUntilIdleMs: settle.waitUntilIdleMs,
    busyAtReturn: settle.busyAtReturn,
    frameMs: settle.frameMs,
    batchCount: move.batchCount,
    queueStats: after.queueStats,
    heapBeforeMB: heapMB(before.heapUsedBytes),
    heapAfterMB: heapMB(after.heapUsedBytes),
    sceneEntityCount: consistency.sceneEntityCount,
    sceneVsDatabase: consistency.sceneVsDatabase,
    searchCount: consistency.searchCount,
    searchUnique: consistency.searchUnique,
    duplicateIds: consistency.duplicateIds,
    sampledPresent: consistency.present,
    sampled: consistency.sampled,
    longTasks: probe
  }
  expect(probe.errors).toEqual([])
  findings.steps.push(
    `open 100k mixed fixture → idle → translateEntities(100k in ${move.batchCount} × 5k transactions, +90/+90) → idle → spatial search + hasEntity sample`
  )
  flushFindings()
})

test('50k ERASE then UNDO then REDO keeps the database and the scene in step', async ({
  page
}) => {
  test.setTimeout(900_000)
  const fixture = writeMoveFixture(50_000)
  await openDrawing(page, fixture, 300_000, 50_000)
  await waitIdle(page, 300_000)

  const before = await readScene(page)
  const pixelsFull = await countNonBackgroundPixels(page)
  const probeId = before.ids[0]
  const centre = centreOf(0)
  expect(await pickAt(page, centre.x, centre.y)).toContain(probeId)

  const erase = await erasePrefix(page, 20_000)
  const settle = await waitIdle(page, 300_000)
  const afterErase = await readScene(page)
  const pixelsErased = await countNonBackgroundPixels(page)

  expect(erase.erased).toBe(20_000)
  expect(afterErase.entityCount).toBe(30_000)
  expect(await pickAt(page, centre.x, centre.y)).not.toContain(probeId)
  expect(pixelsErased).toBeLessThan(pixelsFull)

  // One undo per erase batch (2 000 ids each → 10 marks).
  let undone = 0
  for (let index = 0; index < erase.batchCount; index++) {
    if (await undo(page)) undone++
  }
  expect(undone).toBe(erase.batchCount)
  await waitIdle(page, 300_000)
  const afterUndo = await readScene(page)
  const pixelsUndo = await countNonBackgroundPixels(page)

  let redone = 0
  for (let index = 0; index < erase.batchCount; index++) {
    if (await redo(page)) redone++
  }
  expect(redone).toBe(erase.batchCount)
  await waitIdle(page, 300_000)
  const afterRedo = await readScene(page)
  const pixelsRedo = await countNonBackgroundPixels(page)

  expect(afterUndo.entityCount).toBe(before.entityCount)
  expect(afterRedo.entityCount).toBe(before.entityCount - 20_000)
  expect(pixelsUndo).toBeGreaterThan(pixelsErased)
  expect(pixelsRedo).toBeLessThan(pixelsUndo)

  const consistency = await assertSceneConsistent(
    page,
    30_000,
    before.ids.filter((_, index) => index % 997 === 0)
  )
  expect(consistency.duplicateIds).toBe(0)

  const probe = await readProbe(page)
  findings.results.erase50k = {
    entities: 50_000,
    erased: erase.erased,
    eraseMs: erase.eraseMs,
    eraseBatches: erase.batchCount,
    settleMs: settle.settleMs,
    frameMs: settle.frameMs,
    entityCountAfterErase: afterErase.entityCount,
    entityCountAfterUndo: afterUndo.entityCount,
    entityCountAfterRedo: afterRedo.entityCount,
    pixelsFull,
    pixelsErased,
    pixelsUndo,
    pixelsRedo,
    erasedGuardAfterRedo: afterRedo.erasedGuardSize,
    sceneVsDatabase: consistency.sceneVsDatabase,
    duplicateIds: consistency.duplicateIds,
    queueStats: afterRedo.queueStats,
    longTasks: probe
  }
  expect(probe.errors).toEqual([])
  findings.steps.push(
    'open 50k mixed fixture → idle → eraseEntities(20k in 2k batches) → idle → undo × bursts → idle → redo × bursts → idle, pixel probe after each step'
  )
  flushFindings()
})

test('MOVE → UNDO → REDO restores position, count and pixels', async ({ page }) => {
  test.setTimeout(600_000)
  const fixture = writeMoveFixture(10_000)
  await openDrawing(page, fixture, 120_000, 10_000)
  await waitIdle(page)

  const before = await readScene(page)
  const extentsBefore = await readExtents(page)
  const pixelsFull = await countNonBackgroundPixels(page)
  const centre = centreOf(0)
  const probeId = (await pickAt(page, centre.x, centre.y))[0]
  expect(probeId).toBeTruthy()

  const dx = 300
  const dy = 300
  const move = await translatePrefix(page, 10_000, dx, dy)
  await waitIdle(page)
  const afterMove = await readScene(page)
  const pixelsMoved = await countNonBackgroundPixels(page)

  expect(await undo(page)).toBe(true)
  await waitIdle(page)
  const afterUndo = await readScene(page)
  const pixelsUndo = await countNonBackgroundPixels(page)
  const extentsUndo = await readExtents(page)
  const pickUndo = await pickAt(page, centre.x, centre.y)
  const pickUndoShifted = await pickAt(page, centre.x + dx, centre.y + dy)

  expect(await redo(page)).toBe(true)
  await waitIdle(page)
  const afterRedo = await readScene(page)
  const pixelsRedo = await countNonBackgroundPixels(page)
  const pickRedo = await pickAt(page, centre.x + dx, centre.y + dy)

  expect(move.moved).toBe(10_000)
  expect(afterMove.entityCount).toBe(before.entityCount)
  expect(afterUndo.entityCount).toBe(before.entityCount)
  expect(afterRedo.entityCount).toBe(before.entityCount)
  expect(pickUndo).toContain(probeId)
  expect(pickUndoShifted).not.toContain(probeId)
  expect(pickRedo).toContain(probeId)
  expect(pixelsMoved).toBeGreaterThan(0)
  expect(pixelsUndo).toBeGreaterThan(0)
  expect(pixelsRedo).toBeGreaterThan(0)
  if (extentsBefore && extentsUndo) {
    expect(Math.abs(extentsUndo.minX - extentsBefore.minX)).toBeLessThan(1)
    expect(Math.abs(extentsUndo.minY - extentsBefore.minY)).toBeLessThan(1)
  }

  findings.results.moveUndoRedo = {
    entities: before.entityCount,
    moveMs: move.moveMs,
    extentsBefore,
    entityCountAfterMove: afterMove.entityCount,
    entityCountAfterUndo: afterUndo.entityCount,
    entityCountAfterRedo: afterRedo.entityCount,
    pixelsFull,
    pixelsMoved,
    pixelsUndo,
    pixelsRedo,
    extentsAfterUndo: extentsUndo,
    pickUndo,
    pickUndoShifted,
    pickRedo,
    generationAfterRedo: afterRedo.generationSize,
    erasedGuardAfterRedo: afterRedo.erasedGuardSize
  }
  const probe = await readProbe(page)
  expect(probe.errors).toEqual([])
  findings.steps.push(
    'open 10k mixed fixture → pick(1,1) → translate(10k, +300/+300) → undo → pick(1,1) → redo → pick(301,301); pixels + extents sampled at every step'
  )
  flushFindings()
})

test('20 MOVE / UNDO rounds stay bounded in heap, guard and generation size', async ({
  page
}) => {
  test.setTimeout(900_000)
  const fixture = writeMoveFixture(10_000)
  await openDrawing(page, fixture, 120_000, 10_000)
  await waitIdle(page)

  const scene = await readScene(page)
  const rounds = 20
  const perRound = 500
  const samples: Array<{
    round: number
    heapMB: number | null
    erasedGuardSize: number
    generationSize: number
    claimedSize: number
    entityCount: number
    moveMs: number
    undoMs: number
  }> = []

  for (let round = 0; round < rounds; round++) {
    const move = await translatePrefix(page, perRound, 5, 5)
    const undoStartedAt = Date.now()
    expect(await undo(page)).toBe(true)
    const undoMs = Date.now() - undoStartedAt
    const snapshot = await readScene(page)
    expect(snapshot.entityCount).toBe(scene.entityCount)
    samples.push({
      round,
      heapMB: heapMB(snapshot.heapUsedBytes),
      erasedGuardSize: snapshot.erasedGuardSize,
      generationSize: snapshot.generationSize,
      claimedSize: snapshot.claimedSize,
      entityCount: snapshot.entityCount,
      moveMs: move.moveMs,
      undoMs
    })
  }

  const settle = await waitIdle(page)
  const settled = await readScene(page)
  expect(settled.entityCount).toBe(scene.entityCount)
  expect(settled.processing).toBe(false)
  // Nothing was erased, so the ghost guard must stay empty for the whole run.
  expect(Math.max(...samples.map(sample => sample.erasedGuardSize))).toBe(0)
  expect(settled.erasedGuardSize).toBe(0)
  // The generation map is keyed per entity, so it cannot grow with the number
  // of rounds: it is bounded by the entity count, not by 20 × 500.
  expect(settled.generationSize).toBeLessThanOrEqual(scene.entityCount)
  // `_claimedConvertObjectIds` is the "already converted once" guard. It is a
  // sticky set, not a queue, so it must stay at what the open produced and must
  // not grow by 20 rounds of 500 ids.
  expect(settled.claimedSize).toBe(scene.claimedSize)
  expect(settled.claimedSize).toBeLessThanOrEqual(scene.entityCount)

  const heaps = samples
    .map(sample => sample.heapMB)
    .filter((value): value is number => value != null)
  findings.results.moveRounds = {
    rounds,
    perRound,
    settleMs: settle.settleMs,
    frameMs: settle.frameMs,
    firstHeapMB: heaps.length ? heaps[0] : null,
    lastHeapMB: heaps.length ? heaps[heaps.length - 1] : null,
    maxHeapMB: heaps.length ? Math.max(...heaps) : null,
    heapGrowthMB:
      heaps.length > 1 ? Math.round((heaps[heaps.length - 1] - heaps[0]) * 10) / 10 : null,
    maxErasedGuardSize: Math.max(...samples.map(sample => sample.erasedGuardSize)),
    claimedSizeAtOpen: scene.claimedSize,
    claimedSizeSettled: settled.claimedSize,
    finalGenerationSize: settled.generationSize,
    finalClaimedSize: settled.claimedSize,
    moveMsMedian: [...samples.map(sample => sample.moveMs)].sort((a, b) => a - b)[
      Math.floor(rounds / 2)
    ],
    undoMsMedian: [...samples.map(sample => sample.undoMs)].sort((a, b) => a - b)[
      Math.floor(rounds / 2)
    ],
    samples
  }
  const probe = await readProbe(page)
  expect(probe.errors).toEqual([])
  findings.steps.push(
    `${rounds} rounds × (translate 500 ids → undo), sampling usedJSHeapSize / _erasedConvertObjectIds / _entityConvertGeneration / _claimedConvertObjectIds every round, then one idle + settled sample`
  )
  flushFindings()
})

test('MOVE and ERASE issued while the drawing is still converting', async ({ page }) => {
  test.setTimeout(900_000)
  const fixture = writeMoveFixture(10_000)
  const total = 10_000

  await installProbes(page)
  // The erase / move must land before the open finishes. Driving it from the
  // test side is a race; the page installs a 4 ms watcher before the app boots
  // and fires the first time the model space is populated.
  await page.addInitScript(() => {
    type State = {
      fired: boolean
      totalAtFire: number
      moved: number
      erased: number
      erasedIds: string[]
      erasedSample: string[]
      processingAtFire: boolean
      error: string | null
    }
    const state: State = {
      fired: false,
      totalAtFire: 0,
      moved: 0,
      erased: 0,
      erasedIds: [],
      erasedSample: [],
      processingAtFire: false,
      error: null
    }
    ;(window as unknown as { __phase25MidFlight?: State }).__phase25MidFlight = state
    const timer = window.setInterval(() => {
      if (state.fired) {
        window.clearInterval(timer)
        return
      }
      try {
        const mgr = (
          window as unknown as {
            AcApDocManager?: {
              instance?: {
                curView?: { isProcessingEntities?: boolean }
                curDocument?: {
                  database?: {
                    runDatabaseEdit: (label: string, fn: () => void) => void
                    tables: {
                      blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } }
                    }
                  }
                  entityService?: {
                    getEntitiesByIds: (ids: string[]) => unknown[]
                    translateEntities: (entities: unknown[], displacement: unknown) => number
                    eraseEntities: (ids: string[]) => number
                  }
                }
              }
            }
          }
        ).AcApDocManager?.instance
        const doc = mgr?.curDocument
        if (!mgr?.curView || !doc?.database || !doc?.entityService) return
        const ids: string[] = []
        for (const entity of doc.database.tables.blockTable.modelSpace.newIterator()) {
          ids.push(String(entity.objectId))
        }
        if (ids.length === 0) return
        state.totalAtFire = ids.length
        state.processingAtFire = Boolean(mgr.curView.isProcessingEntities)
        // Move a small slice, then erase half of the ids seen so far.
        const moveIds = ids.slice(0, Math.min(200, ids.length))
        doc.database?.runDatabaseEdit('phase25-midflight-move', () => {
          state.moved = doc.entityService!.translateEntities(
            doc.entityService!.getEntitiesByIds(moveIds),
            { x: 40, y: 40, z: 0 }
          )
        })
        state.erased = doc.entityService.eraseEntities(
          ids.filter((_, index) => index % 2 === 0)
        )
        // Full erased id list: the ghost probe below is set based, so a ghost
        // cannot hide behind an unchanged total. Only ids that were really
        // erased (every second id) are recorded.
        state.erasedIds = ids.filter((_, index) => index % 2 === 0)
        state.erasedSample = state.erasedIds.filter((_, index) => index % 10 === 0)
        state.fired = true
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        state.fired = true
      }
    }, 4)
  })

  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { __phase25MidFlight?: { fired: boolean } })
              .__phase25MidFlight?.fired ?? false
        ),
      { timeout: 180_000, intervals: [50] }
    )
    .toBe(true)

  const midFlight = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __phase25MidFlight: {
          fired: boolean
          totalAtFire: number
          moved: number
          erased: number
          erasedIds: string[]
          erasedSample: string[]
          processingAtFire: boolean
          error: string | null
        }
      }
    ).__phase25MidFlight
    return { ...state }
  })
  expect(midFlight.error).toBeNull()
  expect(midFlight.moved).toBeGreaterThan(0)
  expect(midFlight.erased).toBeGreaterThan(0)

  // The watcher erased half of whatever had been appended when it fired; the
  // parser keeps streaming afterwards, so the settled count is the whole
  // fixture minus exactly those ids.
  const expectedAfterOpen = total - midFlight.erased
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const win = window as unknown as PageWindow
          const mgr = win.AcApDocManager?.instance as
            | {
                curDocument?: {
                  database?: {
                    tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
                  }
                }
              }
            | undefined
          const iterator = mgr?.curDocument?.database?.tables.blockTable.modelSpace.newIterator()
          if (!iterator) return 0
          let count = 0
          for (const entity of iterator) if (entity) count++
          return count
        }),
      { timeout: 300_000 }
    )
    .toBe(expectedAfterOpen)

  await bindHandles(page)
  const settle = await waitIdle(page, 300_000)
  const scene = await readScene(page)
  const pixels = await countNonBackgroundPixels(page)

  // Whatever was appended before the watcher fired had half its ids erased, and
  // nothing else may disappear afterwards.
  expect(scene.entityCount).toBe(total - midFlight.erased)
  expect(scene.processing).toBe(false)
  expect(pixels).toBeGreaterThan(0)

  // `AcTrScene.stats.entityCount` counts what was converted (it is not reduced
  // by a later remove), so it is recorded but not used as a ghost-geometry
  // oracle. The spatial index is: it is updated on both add and remove.
  const consistency = await assertSceneConsistent(
    page,
    scene.entityCount,
    scene.ids.filter((_, index) => index % 233 === 0)
  )
  expect(consistency.duplicateIds).toBe(0)

  // Ghost-geometry oracle, now a hard assertion (Phase 2.6 closed R-8).
  //
  // Phase 2.5 recorded ~88% of a 500-id sample as still drawable and left this
  // un-asserted: `AcApContext` filtered `entityErased` with
  // `hasEntity || claimed`, which misses the third state — an id sitting in
  // `_convertQueue` that is neither in the scene nor claimed yet. Those ids
  // never entered the view's erase tombstone and converted normally afterwards
  // (scene stats 9945 for a 9500-entity database). `AcApContext` now hands every
  // erased layout-space entity to `removeEntity()`; this case keeps the
  // un-instrumented race so the fix stays covered outside the pause-point tests
  // in `phase26-lifecycle.spec.ts`.
  const ghosts = await page.evaluate(all => {
    const win = window as unknown as PageWindow
    const view = win.__phase25?.view as { hasEntity: (id: string) => boolean }
    let present = 0
    for (const id of all) if (view.hasEntity(id)) present++
    return present
  }, midFlight.erasedIds)

  const ghostSample = await page.evaluate(sample => {
    const win = window as unknown as PageWindow
    const view = win.__phase25?.view as { hasEntity: (id: string) => boolean }
    return sample.filter(id => view.hasEntity(id)).length
  }, midFlight.erasedSample)

  // Set difference in both directions: a ghost added while one legal entity
  // disappeared would keep the count identical, so the totals alone are not
  // enough.
  const searchIds = await searchBox(page, {
    minX: -1e6,
    minY: -1e6,
    maxX: 1e6,
    maxY: 1e6
  })
  const indexed = new Set(searchIds)
  const dbSet = new Set(scene.ids)
  const residual = [...indexed].filter(id => !dbSet.has(id))
  const missing = scene.ids.filter(id => !indexed.has(id))

  expect(ghosts).toBe(0)
  expect(ghostSample).toBe(0)
  expect(scene.sceneEntityCount).toBe(expectedAfterOpen)
  expect(residual).toEqual([])
  expect(missing).toEqual([])
  expect(searchIds.length - indexed.size).toBe(0)

  const probe = await readProbe(page)
  findings.results.midFlight = {
    totalAtFire: midFlight.totalAtFire,
    processingAtFire: midFlight.processingAtFire,
    moved: midFlight.moved,
    erased: midFlight.erased,
    fixtureEntityCount: total,
    entityCountAfterOpen: scene.entityCount,
    settleMs: settle.settleMs,
    frameMs: settle.frameMs,
    sceneStatsEntityCount: consistency.sceneEntityCount,
    spatialIndexCount: consistency.searchUnique,
    erasedSampleSize: midFlight.erasedSample.length,
    ghostDrawablesAmongErased: ghosts,
    ghostDrawablesAmongSample: ghostSample,
    residualCount: residual.length,
    missingCount: missing.length,
    duplicateIds: consistency.duplicateIds,
    pixels,
    longTasks: probe
  }
  expect(probe.errors).toEqual([])
  findings.steps.push(
    `open 10k fixture with an in-page 4 ms watcher: first populated read moves ${midFlight.moved} ids +40/+40 and erases ${midFlight.erased} ids → wait for parse → idle → survivor + pixel probe`
  )
  flushFindings()
})

test('closing the document mid-conversion leaves no queued work behind', async ({
  page
}) => {
  test.setTimeout(600_000)
  const fixture = writeMoveFixture(20_000)
  await openDrawing(page, fixture, 300_000, 20_000)
  await waitIdle(page, 300_000)

  const before = await readScene(page)
  expect(before.entityCount).toBe(20_000)

  const move = await translatePrefix(page, 20_000, 25, 25)
  expect(move.moved).toBe(20_000)

  // Close without waiting: the point is that the conversion / update queues are
  // cancelled rather than allowed to write back into a disposed document.
  const closed = await page.evaluate(async () => {
    const win = window as unknown as PageWindow
    const mgr = win.AcApDocManager?.instance as
      | { closeDocument?: () => Promise<boolean>; curDocument?: unknown }
      | undefined
    if (!mgr?.closeDocument) return false
    return mgr.closeDocument()
  })
  expect(closed).toBe(true)

  await page.waitForTimeout(2_000)
  const afterClose = await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const mgr = win.AcApDocManager?.instance as
      | {
          curDocument?: {
            database?: {
              tables: { blockTable: { modelSpace: { newIterator: () => Iterable<unknown> } } }
            }
          }
          curView?: {
            getOpenConvertStats?: () => Record<string, number>
            isProcessingEntities?: boolean
          }
        }
      | undefined
    const stats = mgr?.curView?.getOpenConvertStats?.() ?? null
    const probe = (window as unknown as { __phase25Probe?: { errors: string[] } }).__phase25Probe
    let entityCount = -1
    const iterator = mgr?.curDocument?.database?.tables.blockTable.modelSpace.newIterator()
    if (iterator) {
      entityCount = 0
      for (const entity of iterator) if (entity) entityCount++
    }
    return {
      // `closeDocument()` on the last document resets the session to an empty
      // untitled one instead of leaving no document at all, so a document being
      // present is the expected state; what matters is that it is empty.
      hasDocument: Boolean(mgr?.curDocument?.database),
      entityCount,
      processing: Boolean(mgr?.curView?.isProcessingEntities),
      stats,
      errors: probe?.errors ?? []
    }
  })

  expect(afterClose.errors).toEqual([])
  expect(afterClose.entityCount).toBe(0)
  if (afterClose.stats) {
    expect(afterClose.stats.pendingEntityUpdates ?? 0).toBe(0)
    expect(afterClose.stats.deferredActive ?? 0).toBe(0)
    expect(afterClose.stats.pendingGeometryJobs ?? 0).toBe(0)
    expect(afterClose.stats.convertQueued ?? 0).toBe(0)
  }

  findings.results.closeMidConversion = {
    entities: before.entityCount,
    moveMs: move.moveMs,
    closed,
    hasDocumentAfterClose: afterClose.hasDocument,
    entityCountAfterClose: afterClose.entityCount,
    processingAfterClose: afterClose.processing,
    convertStatsAfterClose: afterClose.stats,
    errorsAfterClose: afterClose.errors
  }
  findings.steps.push(
    'open 20k fixture → translate(20k) → closeDocument() immediately → wait 2 s → assert the reset document is empty and no queue item or page error is left'
  )
  flushFindings()
})

test.afterAll(() => {
  flushFindings()
})
