import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.6 — deterministic entity-lifecycle tests for R-8 (ghost geometry).
 *
 * Phase 2.5 proved the defect by racing a bulk ERASE against document open and
 * counting how many erased ids still had a drawable. That was a *statistical*
 * proof: the same case produced 44/50 and 0/50 in different sessions, which is
 * exactly what a race looks like. This spec replaces luck with control:
 *
 * 1. `AcTrView2d.setConvertDebugHook()` parks one conversion at a named stage
 *    (`claimed` / `beforeCommit` / `groupLayer`) and awaits a promise only the
 *    test resolves. The pause point ships in production code but is never
 *    installed there, so each stage costs one falsy field check.
 * 2. The test performs the ERASE / UNDO / REDO / close *while the task is
 *    parked*, then releases it. Every interleaving that used to be a race is
 *    now an ordinary sequential script.
 *
 * The assertions are set based, not sampled: the erased id list is complete and
 * the scene id set is read from the spatial index, so "one ghost added, one
 * legal entity dropped" cannot hide behind an unchanged total.
 *
 * The 50-round case at the end keeps the un-instrumented race: it drives a real
 * ERASE during open and re-asserts the same invariants, which is what catches a
 * regression in the paths the pause points do not touch.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase26')
const reportPath = path.join(reportsDir, 'lifecycle.json')

interface Findings {
  results: Record<string, unknown>
  steps: string[]
}

const findings: Findings = { results: {}, steps: [] }

function flushFindings() {
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Fixture: 7 LINE / 2 LWPOLYLINE / 1 INSERT per 10 entities
 *
 * No TEXT on purpose: glyph work is deferred to a font-dependent job pool and
 * would add a second, unrelated asynchrony to a lifecycle test.
 *
 * The default block puts both members on one layer, so one INSERT commits
 * exactly one drawable and `scene entity count == database entity count` holds.
 * The two-layer variant is used by the fragment test only.
 * ------------------------------------------------------------------ */

function dxfPair(code: number, value: string | number) {
  return `${code}\n${value}\n`
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

function dxfPolyline(originX: number, originY: number, size: number) {
  return (
    dxfPair(0, 'LWPOLYLINE') +
    dxfPair(8, 'LINES') +
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

function dxfInsert(x: number, y: number) {
  return (
    dxfPair(0, 'INSERT') +
    dxfPair(8, 'MARKS') +
    dxfPair(2, 'P26_BLK') +
    dxfPair(10, x) +
    dxfPair(20, y) +
    dxfPair(30, 0)
  )
}

/** Block definition; `twoLayer` splits its members across LINES and MARKS. */
function dxfBlock(twoLayer: boolean) {
  const second = twoLayer
    ? dxfLine(2, 0, 0, 2, 'MARKS')
    : dxfLine(2, 0, 0, 2, 'LINES')
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'BLOCKS') +
    dxfPair(0, 'BLOCK') +
    dxfPair(8, '0') +
    dxfPair(2, 'P26_BLK') +
    dxfPair(70, 0) +
    dxfPair(10, 0) +
    dxfPair(20, 0) +
    dxfPair(30, 0) +
    dxfLine(0, 0, 2, 2, 'LINES') +
    second +
    dxfPair(0, 'ENDBLK') +
    dxfPair(8, '0') +
    dxfPair(0, 'ENDSEC')
  )
}

function dxfHead() {
  return (
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'HEADER') +
    dxfPair(9, '$ACADVER') +
    dxfPair(1, 'AC1015') +
    dxfPair(0, 'ENDSEC') +
    dxfPair(0, 'SECTION') +
    dxfPair(2, 'TABLES') +
    dxfPair(0, 'TABLE') +
    dxfPair(2, 'LAYER') +
    dxfPair(70, 3) +
    dxfPair(0, 'LAYER') +
    dxfPair(2, '0') +
    dxfPair(70, 0) +
    dxfPair(62, 7) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'LINES') +
    dxfPair(70, 0) +
    dxfPair(62, 3) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'LAYER') +
    dxfPair(2, 'MARKS') +
    dxfPair(70, 0) +
    dxfPair(62, 5) +
    dxfPair(6, 'CONTINUOUS') +
    dxfPair(0, 'ENDTAB') +
    dxfPair(0, 'ENDSEC')
  )
}

/**
 * Writes a fixture of `count` entities on a 3-unit grid: the centre of a cell
 * belongs to exactly one entity, which makes picking probes exact.
 */
function writeLifecycleFixture(count: number, twoLayerBlock = false): string {
  const parts: string[] = []
  for (let index = 0; index < count; index++) {
    const x = (index % 100) * 3
    const y = Math.floor(index / 100) * 3
    const kind = index % 10
    if (kind < 7) parts.push(dxfLine(x, y, x + 2, y + 2, 'LINES'))
    else if (kind < 9) parts.push(dxfPolyline(x, y, 2))
    else parts.push(dxfInsert(x, y))
  }
  const suffix = twoLayerBlock ? 'two-layer' : 'one-layer'
  const file = path.join(os.tmpdir(), `phase26-lifecycle-${suffix}-${count}.dxf`)
  fs.writeFileSync(
    file,
    dxfHead() +
      dxfBlock(twoLayerBlock) +
      dxfPair(0, 'SECTION') +
      dxfPair(2, 'ENTITIES') +
      parts.join('') +
      dxfPair(0, 'ENDSEC') +
      dxfPair(0, 'EOF'),
    'utf8'
  )
  return file
}

/* ------------------------------------------------------------------ *
 * Page handles
 * ------------------------------------------------------------------ */

interface SpatialIndexHandle {
  search?: (box: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }) => Array<{ id: string }>
}

interface LayoutHandle {
  _spatialIndex?: SpatialIndexHandle
}

interface ViewHandle {
  hasEntity: (id: string) => boolean
  pick: (point: { x: number; y: number }, hitRadius?: number) => Array<{ id: string }>
  waitUntilIdle?: (timeoutMs?: number) => Promise<boolean>
  isProcessingEntities?: boolean
  getOpenConvertStats?: () => Record<string, number>
  setConvertDebugHook?: (
    hook: ((stage: string, objectId: string) => void | Promise<void>) | null
  ) => void
  _scene?: {
    _layouts?: Map<string, LayoutHandle> | LayoutHandle[]
    stats?: { summary?: { entityCount?: number } }
  }
  _erasedConvertObjectIds?: Set<string>
  _claimedConvertObjectIds?: Set<string>
  _convertQueue?: unknown[]
}

interface DocHandle {
  database: {
    tables: {
      blockTable: {
        modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
      }
    }
    transactionManager: { undo: () => boolean; redo: () => boolean }
    getObjectById?: (id: string) => unknown
  }
  entityService: { eraseEntities: (ids: string[]) => number }
}

interface ManagerHandle {
  curView: ViewHandle
  curDocument: DocHandle
  closeDocument?: () => Promise<boolean>
}

interface PendingPause {
  stage: string
  objectId: string
  release?: () => void
}

interface TrapState {
  installed: boolean
  events: string[]
  pending: PendingPause | null
  trap: { stage: string; count: number; hits: number; objectId: string | null } | null
  released: number
}

type PageWindow = Window & {
  AcApDocManager?: { instance?: ManagerHandle }
  __p26?: TrapState
}

/** A box that covers every fixture cell, used for exhaustive index queries. */
const WORLD_BOX = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }

/**
 * Installs the pause-point plumbing before the app boots.
 *
 * The hook is attached as soon as the view exists, i.e. while the uploaded
 * drawing is still being parsed, so no entity can slip past it.
 */
async function installTrapPlumber(page: Page) {
  await page.addInitScript(() => {
    const state: {
      installed: boolean
      events: string[]
      pending: { stage: string; objectId: string; release?: () => void } | null
      trap: { stage: string; count: number; hits: number; objectId: string | null } | null
      released: number
    } = {
      installed: false,
      events: [],
      pending: null,
      trap: null,
      released: 0
    }
    ;(window as unknown as { __p26: typeof state }).__p26 = state
    const timer = window.setInterval(() => {
      const view = (
        window as unknown as {
          AcApDocManager?: { instance?: { curView?: Record<string, unknown> } }
        }
      ).AcApDocManager?.instance?.curView as
        | { setConvertDebugHook?: (hook: unknown) => void }
        | undefined
      if (!view?.setConvertDebugHook) return
      window.clearInterval(timer)
      view.setConvertDebugHook((stage: string, objectId: string) => {
        state.events.push(`${stage}:${objectId}`)
        const trap = state.trap
        if (!trap || trap.stage !== stage) return
        if (trap.objectId !== null && trap.objectId !== objectId) return
        trap.hits++
        if (trap.hits < trap.count) return
        // Disarm: the same trap must not also park the recovery path's convert.
        trap.stage = '__disarmed'
        return new Promise<void>(resolve => {
          state.pending = {
            stage,
            objectId,
            release: () => {
              state.released++
              state.pending = null
              resolve()
            }
          }
        })
      })
      state.installed = true
    }, 2)
  })
}

async function armTrap(
  page: Page,
  stage: 'claimed' | 'beforeCommit' | 'groupLayer',
  count = 1
) {
  await page.evaluate(
    ({ targetStage, targetCount }) => {
      const state = (window as unknown as PageWindow).__p26
      if (!state) throw new Error('trap plumber not installed')
      state.trap = { stage: targetStage, count: targetCount, hits: 0, objectId: null }
    },
    { targetStage: stage, targetCount: count }
  )
}

async function waitPaused(page: Page, timeoutMs = 180_000): Promise<PendingPause> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const state = (window as unknown as PageWindow).__p26
          return state?.pending ? state.pending.objectId : null
        }),
      { timeout: timeoutMs, intervals: [20] }
    )
    .not.toBeNull()
  return page.evaluate(() => {
    const pending = (window as unknown as PageWindow).__p26!.pending!
    return { stage: pending.stage, objectId: pending.objectId }
  })
}

async function releasePause(page: Page) {
  await page.evaluate(() => {
    const pending = (window as unknown as PageWindow).__p26?.pending
    if (pending?.release) pending.release()
  })
}

async function readDbIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (!iterator) return [] as string[]
    const ids: string[] = []
    for (const entity of iterator) ids.push(String(entity.objectId))
    return ids
  })
}

/**
 * Exhaustive id set of the scene's spatial index roots.
 *
 * `search()` returns one item per root (child boxes of an INSERT are nested
 * under `children`), so this is one id per drawable, which is what makes the
 * set difference below meaningful.
 */
async function readSceneIds(page: Page): Promise<string[]> {
  return page.evaluate(box => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    if (!layouts) return [] as string[]
    const list: LayoutHandle[] =
      typeof (layouts as Map<string, LayoutHandle>).values === 'function'
        ? Array.from((layouts as Map<string, LayoutHandle>).values())
        : (layouts as LayoutHandle[])
    const ids: string[] = []
    for (const layout of list) {
      const items = layout?._spatialIndex?.search?.(box) ?? []
      for (const item of items) if (item?.id) ids.push(String(item.id))
    }
    return ids
  }, WORLD_BOX)
}

async function readSceneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    return view?._scene?.stats?.summary?.entityCount ?? -1
  })
}

async function presentAmong(page: Page, ids: string[]): Promise<number> {
  return page.evaluate(sample => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    let present = 0
    for (const id of sample) if (view?.hasEntity(id)) present++
    return present
  }, ids)
}

async function eraseIds(page: Page, ids: string[]) {
  return page.evaluate(list => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    if (!doc) throw new Error('curDocument unavailable')
    return doc.entityService.eraseEntities(list)
  }, ids)
}

async function undoOnce(page: Page) {
  return page.evaluate(() =>
    Boolean(
      (
        window as unknown as PageWindow
      ).AcApDocManager?.instance?.curDocument?.database.transactionManager.undo()
    )
  )
}

async function redoOnce(page: Page) {
  return page.evaluate(() =>
    Boolean(
      (
        window as unknown as PageWindow
      ).AcApDocManager?.instance?.curDocument?.database.transactionManager.redo()
    )
  )
}

/** Centre of an entity as its own geometric extents, for exact picking. */
async function pickEntityCentre(page: Page, objectId: string) {
  return page.evaluate(target => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const entity = doc?.database.getObjectById?.(target) as
      | {
          geometricExtents?: {
            min: { x: number; y: number }
            max: { x: number; y: number }
          }
        }
      | undefined
    const box = entity?.geometricExtents
    if (!box || !view) return null
    const point = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2
    }
    return { point, picked: view.pick(point, 2).map(item => String(item.id)) }
  }, objectId)
}

async function waitIdle(page: Page, timeoutMs = 180_000) {
  return page.evaluate(async budget => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    if (!view) throw new Error('curView unavailable')
    if (view.waitUntilIdle) await view.waitUntilIdle(budget)
    const deadline = performance.now() + budget
    let idleStreak = 0
    while (idleStreak < 2 && performance.now() < deadline) {
      const stats = view.getOpenConvertStats?.() ?? {}
      const busy =
        Boolean(view.isProcessingEntities) ||
        (stats.pendingEntityUpdates ?? 0) > 0 ||
        (stats.pendingEntities ?? 0) > 0 ||
        (stats.convertQueued ?? 0) > 0 ||
        (stats.deferredActive ?? 0) > 0 ||
        (stats.pendingGeometryJobs ?? 0) > 0
      idleStreak = busy ? 0 : idleStreak + 1
      if (idleStreak >= 2) break
      await new Promise<void>(resolve => setTimeout(resolve, 16))
    }
    return { idle: idleStreak >= 2, stats: view.getOpenConvertStats?.() ?? null }
  }, timeoutMs)
}

/** Set-based scene/database comparison shared by every case. */
async function compareSceneToDatabase(page: Page, erasedIds: string[]) {
  const dbIds = await readDbIds(page)
  const indexIds = await readSceneIds(page)
  const uniqueIndex = new Set(indexIds)
  const dbSet = new Set(dbIds)
  return {
    dbIds,
    dbCount: dbIds.length,
    sceneCount: await readSceneCount(page),
    indexCount: uniqueIndex.size,
    indexDuplicates: indexIds.length - uniqueIndex.size,
    ghostAmongErased: await presentAmong(page, erasedIds),
    erasedSize: erasedIds.length,
    residual: [...uniqueIndex].filter(id => !dbSet.has(id)),
    missing: dbIds.filter(id => !uniqueIndex.has(id))
  }
}

/**
 * Opens `fixture` on a fresh page with the pause plumbing armed for `stage`.
 *
 * The trap is armed before the file is uploaded, so the first conversion that
 * reaches the stage is the one that parks — no opening pass can outrun it.
 */
async function openTrapped(
  page: Page,
  fixture: string,
  stage: 'claimed' | 'beforeCommit' | 'groupLayer',
  count = 1
) {
  await installTrapPlumber(page)
  await page.goto('/')
  await armTrap(page, stage, count)
  await uploadFixture(page, fixture)
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 30_000 })
  return waitPaused(page)
}

/* ------------------------------------------------------------------ *
 * Deterministic cases
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 })

test.beforeAll(() => {
  findings.steps.push(
    'fixture: 7 LINE / 2 LWPOLYLINE / 1 INSERT per 10 entities on a 3-unit grid, no TEXT'
  )
  flushFindings()
})

test('ERASE while the entity is claimed but has no geometry yet', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 3_000
  const paused = await openTrapped(page, writeLifecycleFixture(total), 'claimed')

  expect(await eraseIds(page, [paused.objectId])).toBe(1)
  // Nothing is in the scene yet for this id: the tombstone has to come from the
  // database event alone, before any drawable exists.
  expect(await presentAmong(page, [paused.objectId])).toBe(0)

  await releasePause(page)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [paused.objectId])
  findings.results.eraseWhileClaimed = { paused, result }

  expect(result.ghostAmongErased).toBe(0)
  expect(result.dbCount).toBe(total - 1)
  expect(result.sceneCount).toBe(total - 1)
  expect(result.indexCount).toBe(total - 1)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  flushFindings()
})

test('ERASE while the geometry exists but has not been committed', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 3_000
  const paused = await openTrapped(page, writeLifecycleFixture(total), 'beforeCommit')

  // Geometry is built and parked right before `_scene.addEntity`.
  expect(await presentAmong(page, [paused.objectId])).toBe(0)
  expect(await eraseIds(page, [paused.objectId])).toBe(1)
  await releasePause(page)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [paused.objectId])
  findings.results.eraseBeforeCommit = { paused, result }

  expect(result.ghostAmongErased).toBe(0)
  expect(result.dbCount).toBe(total - 1)
  expect(result.sceneCount).toBe(total - 1)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  flushFindings()
})

test('ERASE → UNDO while the pre-erase task is still parked', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 3_000
  const paused = await openTrapped(page, writeLifecycleFixture(total), 'claimed')

  expect(await eraseIds(page, [paused.objectId])).toBe(1)
  expect((await readDbIds(page)).length).toBe(total - 1)

  // Undo restores the *same* object id. The parked task predates the erase, so
  // it has to be rejected by revision instead of committing into the restored
  // id's new life — which is what an ObjectId-only check would allow.
  expect(await undoOnce(page)).toBe(true)
  expect((await readDbIds(page)).length).toBe(total)

  await releasePause(page)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [])
  const centre = await pickEntityCentre(page, paused.objectId)
  findings.results.eraseUndoDuringConvert = { paused, result, centre }

  expect(result.dbCount).toBe(total)
  expect(result.sceneCount).toBe(total)
  expect(result.indexCount).toBe(total)
  expect(result.indexDuplicates).toBe(0)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  // Exactly one drawable for the restored id: not zero (kept stale) and not two
  // (the parked task committed on top of the reconverted one).
  expect(await presentAmong(page, [paused.objectId])).toBe(1)
  expect(centre?.picked).toContain(paused.objectId)
  flushFindings()
})

test('ERASE → UNDO → REDO while the pre-erase task is still parked', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 3_000
  const paused = await openTrapped(page, writeLifecycleFixture(total), 'beforeCommit')

  expect(await eraseIds(page, [paused.objectId])).toBe(1)
  expect(await undoOnce(page)).toBe(true)
  expect(await redoOnce(page)).toBe(true)
  expect((await readDbIds(page)).length).toBe(total - 1)

  await releasePause(page)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [paused.objectId])
  const centre = await pickEntityCentre(page, paused.objectId)
  findings.results.eraseUndoRedoDuringConvert = { paused, result, centre }

  expect(result.ghostAmongErased).toBe(0)
  expect(result.dbCount).toBe(total - 1)
  expect(result.sceneCount).toBe(total - 1)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  expect(centre?.picked ?? []).not.toContain(paused.objectId)
  flushFindings()
})

test('ERASE of a committed drawable leaves the index and picking clean', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 1_500
  await installTrapPlumber(page)
  await page.goto('/')
  await uploadFixture(page, writeLifecycleFixture(total))
  await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 30_000 })
  await waitIdle(page, 300_000)

  const dbIds = await readDbIds(page)
  expect(dbIds.length).toBe(total)
  const target = dbIds[0]
  const before = await pickEntityCentre(page, target)
  expect(before?.picked).toContain(target)

  expect(await eraseIds(page, [target])).toBe(1)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [target])
  const after = await pickEntityCentre(page, target)
  findings.results.eraseCommitted = { target, before, after, result }

  expect(result.ghostAmongErased).toBe(0)
  expect(result.dbCount).toBe(total - 1)
  expect(result.sceneCount).toBe(total - 1)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  expect(after).toBeNull()
  flushFindings()
})

test('closing the document while a convert is parked leaves nothing behind', async ({
  page
}) => {
  test.setTimeout(600_000)
  const paused = await openTrapped(page, writeLifecycleFixture(1_000), 'claimed')

  const closed = await page.evaluate(async () => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance
    if (!manager?.closeDocument) return false
    return manager.closeDocument()
  })
  expect(closed).toBe(true)

  // The parked task belongs to a document that no longer exists; releasing it
  // must not write into the replacement session.
  await releasePause(page)
  await page.waitForTimeout(1_000)
  await waitIdle(page, 120_000)

  const after = await page.evaluate(() => {
    const manager = (window as unknown as PageWindow).AcApDocManager?.instance
    const view = manager?.curView
    const iterator = manager?.curDocument?.database.tables.blockTable.modelSpace.newIterator()
    let entityCount = -1
    if (iterator) {
      entityCount = 0
      for (const entity of iterator) if (entity) entityCount++
    }
    return {
      entityCount,
      sceneCount: view?._scene?.stats?.summary?.entityCount ?? -1,
      convertQueued: view?._convertQueue?.length ?? -1,
      claimed: view?._claimedConvertObjectIds?.size ?? -1,
      tombstoned: view?._erasedConvertObjectIds?.size ?? -1
    }
  })
  findings.results.closeWhilePaused = { paused, after }

  expect(after.entityCount).toBe(0)
  expect(after.sceneCount).toBe(0)
  expect(after.convertQueued).toBe(0)
  flushFindings()
})

test('ERASE between the two layer fragments of one INSERT', async ({ page }) => {
  test.setTimeout(600_000)
  const total = 2_000
  const paused = await openTrapped(
    page,
    writeLifecycleFixture(total, true),
    'groupLayer',
    2
  )

  const inserted = paused.objectId
  // The first fragment is already in the scene when the second is parked; the
  // remaining fragment must not commit after the ERASE.
  expect(await presentAmong(page, [inserted])).toBeGreaterThan(0)
  expect(await eraseIds(page, [inserted])).toBe(1)
  await releasePause(page)
  await waitIdle(page, 300_000)

  const result = await compareSceneToDatabase(page, [inserted])
  findings.results.eraseBetweenGroupLayers = { paused, result }

  const insertCount = Math.ceil(total / 10) - 1
  expect(result.ghostAmongErased).toBe(0)
  expect(result.dbCount).toBe(total - 1)
  expect(result.indexCount).toBe(total - 1)
  // One drawable per surviving INSERT fragment (two layers), one for the rest.
  expect(result.sceneCount).toBe(total - 1 + insertCount)
  expect(result.residual).toEqual([])
  expect(result.missing).toEqual([])
  flushFindings()
})

/* ------------------------------------------------------------------ *
 * Un-instrumented race, repeated
 * ------------------------------------------------------------------ */

interface RoundState {
  fired: boolean
  totalAtFire: number
  erased: number
  erasedIds: string[]
  error: string | null
}

/**
 * Erases every second id the parser has appended so far, the first time model
 * space is non-empty. The parser keeps streaming afterwards, so this is a real
 * load-time race, not a staged one.
 */
async function installOpenWatcher(page: Page) {
  await page.addInitScript(() => {
    const state = {
      fired: false,
      totalAtFire: 0,
      erased: 0,
      erasedIds: [] as string[],
      error: null as string | null
    }
    ;(window as unknown as { __p26Round: typeof state }).__p26Round = state
    const timer = window.setInterval(() => {
      if (state.fired) {
        window.clearInterval(timer)
        return
      }
      try {
        const manager = (
          window as unknown as {
            AcApDocManager?: {
              instance?: {
                curView?: { isProcessingEntities?: boolean }
                curDocument?: {
                  database?: {
                    tables: {
                      blockTable: {
                        modelSpace: { newIterator: () => Iterable<{ objectId: string }> }
                      }
                    }
                  }
                  entityService?: { eraseEntities: (ids: string[]) => number }
                }
              }
            }
          }
        ).AcApDocManager?.instance
        const doc = manager?.curDocument
        if (!manager?.curView || !doc?.database || !doc?.entityService) return
        const ids: string[] = []
        for (const entity of doc.database.tables.blockTable.modelSpace.newIterator()) {
          ids.push(String(entity.objectId))
        }
        if (ids.length === 0) return
        state.totalAtFire = ids.length
        const targets = ids.filter((_, index) => index % 2 === 0)
        state.erased = doc.entityService.eraseEntities(targets)
        state.erasedIds = targets
        state.fired = true
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        state.fired = true
      }
    }, 4)
  })
}

async function readRound(page: Page): Promise<RoundState> {
  return page.evaluate(() => {
    const state = (window as unknown as { __p26Round?: RoundState }).__p26Round
    return state
      ? {
          fired: state.fired,
          totalAtFire: state.totalAtFire,
          erased: state.erased,
          erasedIds: state.erasedIds,
          error: state.error
        }
      : { fired: false, totalAtFire: 0, erased: 0, erasedIds: [], error: 'watcher missing' }
  })
}

test('50 rounds: ERASE during load leaves no ghost and no residual index entry', async ({
  page
}) => {
  test.setTimeout(1_800_000)
  const total = 1_500
  const fixture = writeLifecycleFixture(total)
  const rounds: Array<Record<string, unknown>> = []
  const failures: string[] = []

  await installOpenWatcher(page)

  for (let round = 1; round <= 50; round++) {
    await page.goto('/')
    await uploadFixture(page, fixture)
    await expect(page.locator('.ml-cad-container')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(async () => (await readRound(page)).fired, { timeout: 180_000, intervals: [20] })
      .toBe(true)

    const state = await readRound(page)
    if (state.error) {
      failures.push(`round ${round}: ${state.error}`)
      rounds.push({ round, error: state.error })
      continue
    }

    await waitIdle(page, 180_000)
    const result = await compareSceneToDatabase(page, state.erasedIds)
    // The watcher fires while the parser is still streaming, so `totalAtFire` is
    // a lower bound. The final count is the full fixture minus the ids that were
    // erased: the parser keeps appending the rest afterwards.
    const expected = total - state.erased

    rounds.push({
      round,
      firedAt: state.totalAtFire,
      parsedAtFire: state.totalAtFire < total,
      erased: state.erased,
      dbCount: result.dbCount,
      sceneCount: result.sceneCount,
      indexCount: result.indexCount,
      indexDuplicates: result.indexDuplicates,
      ghostAmongErased: result.ghostAmongErased,
      residualCount: result.residual.length,
      missingCount: result.missing.length
    })

    if (result.ghostAmongErased !== 0)
      failures.push(`round ${round}: ${result.ghostAmongErased} ghost drawable(s)`)
    if (result.residual.length > 0)
      failures.push(`round ${round}: ${result.residual.length} residual id(s) in index`)
    if (result.missing.length > 0)
      failures.push(`round ${round}: ${result.missing.length} id(s) missing from index`)
    if (result.indexDuplicates !== 0)
      failures.push(`round ${round}: ${result.indexDuplicates} duplicate index id(s)`)
    if (result.sceneCount !== result.dbCount)
      failures.push(`round ${round}: scene ${result.sceneCount} != database ${result.dbCount}`)
    if (result.dbCount !== expected)
      failures.push(`round ${round}: database ${result.dbCount} != expected ${expected}`)
  }

  const summary = {
    rounds: rounds.length,
    failures,
    totals: rounds.reduce(
      (acc, entry) => {
        const record = entry as {
          erased?: number
          ghostAmongErased?: number
          residualCount?: number
        }
        acc.erased += record.erased ?? 0
        acc.ghost += record.ghostAmongErased ?? 0
        acc.residual += record.residualCount ?? 0
        return acc
      },
      { erased: 0, ghost: 0, residual: 0 }
    ),
    detail: rounds
  }
  findings.results.fiftyRounds = summary
  findings.steps.push(
    '50 × (goto + upload 1.5k fixture + in-page 4 ms watcher erases every second visible id + idle + set-difference probes)'
  )
  flushFindings()

  expect(failures).toEqual([])
})

test.afterAll(() => {
  flushFindings()
})
