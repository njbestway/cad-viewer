import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type Page, test } from '@playwright/test'

import { writeMixedFixture } from '../helpers/cadFixtures'
import { uploadFixture } from '../helpers/fileUpload'

/**
 * Phase 2.9 diagnostic probe — why does the spatial index answer for fewer ids
 * than the scene can draw?
 *
 * `waitUntilSceneReady` cross-checks three sets: database ids, the ids the scene
 * graph can still draw (`layout.collectObjectIds()`), and the ids the layout
 * spatial index answers for. On the mixed fixture the third set comes up short
 * by exactly one fixture group, and the shortfall has to be *named*: a TEXT
 * whose bbox only exists after the deferred glyph bake is a different defect
 * from an INSERT that was never registered, and the fix differs.
 *
 * This spec never asserts. It writes `reports/phase29/phase29-index-probe.json`
 * with the missing ids resolved to their database type, plus whether a second
 * sample after an idle pause still reports them.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..')
const reportsDir = path.join(repoRoot, 'reports', 'phase29')

const size = Number(process.env.P29_PROBE_SIZE ?? 1_500)
const tag = (process.env.P29_PROBE_TAG ?? 'probe').replace(/[^\w.-]/g, '_')

test.use({ trace: 'off' })
test.setTimeout(900_000)

type PageWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (options?: {
          timeoutMs?: number
        }) => Promise<{ ready: boolean; reasons: string[] }>
        getSceneReadiness?: (options?: {
          sampleLimit?: number
        }) => {
          ready: boolean
          reasons: string[]
          sceneObjectIds: number
          spatialIndexIds: number
          missingFromSceneCount: number
          missingFromIndexSamples: string[]
          unindexedInScene: number
          checkedLayoutId: string
        }
        _scene?: { _layouts?: Map<string, LayoutLike> | LayoutLike[] }
      }
      curDocument?: {
        database: {
          tables: {
            blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } }
          }
          transactionManager: { undo: () => boolean; redo: () => boolean }
        }
        entityService: {
          eraseEntities: (ids: string[]) => number
          getEntitiesByIds: (ids: string[]) => unknown[]
        }
      }
    }
  }
}

interface LayoutLike {
  id?: string
  spatialIndexStats?: unknown
  spatialIndexIds?: string[]
  /** First-level ids only: one per entity, children not expanded. */
  spatialIndexRootIds?: string[]
  collectObjectIds?: (target?: Set<string>) => Set<string>
  _layers?: Map<string, { _group?: { _entitiesMap?: Map<string, unknown> } }>
}

/** Ids the layout draws but its spatial index cannot answer, plus layer split. */
async function readIndexGap(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as PageWindow
    const view = win.AcApDocManager?.instance?.curView
    const layouts = view?._scene?._layouts
    const values =
      layouts instanceof Map ? Array.from(layouts.values()) : layouts ? Array.from(layouts) : []
    return values.map(layout => {
      const sceneIds = layout?.collectObjectIds
        ? Array.from(layout.collectObjectIds())
        : ([] as string[])
      // Root-level ids: `spatialIndexIds` flattens child indexes, so a block
      // reference would be replaced by its children in that view.
      const indexIds = layout?.spatialIndexRootIds ?? layout?.spatialIndexIds ?? []
      const indexed = new Set(indexIds)
      const unindexed = sceneIds.filter(id => !indexed.has(id))
      const sceneSet = new Set(sceneIds)
      return {
        layoutId: layout?.id ?? null,
        stats: layout?.spatialIndexStats ?? null,
        sceneIds: sceneIds.length,
        indexIds: indexIds.length,
        flattenedIndexIds: layout?.spatialIndexIds?.length ?? -1,
        unindexedCount: unindexed.length,
        unindexedSample: unindexed.slice(0, 40),
        indexedButNotDrawn: indexIds.filter(id => !sceneSet.has(id)).length,
        layerEntityCounts: Array.from(layout?._layers?.entries?.() ?? []).map(([name, layer]) => [
          name,
          layer?._group?._entitiesMap?.size ?? -1
        ])
      }
    })
  })
}

/** Resolves ids to their database type so the gap can be named. */
async function readIdTypes(page: Page, ids: string[]) {
  if (ids.length === 0) return { tally: {}, entities: [] }
  return page.evaluate(list => {
    const win = window as unknown as PageWindow
    const doc = win.AcApDocManager?.instance?.curDocument
    const entities = doc?.entityService.getEntitiesByIds(list) ?? []
    const resolved = entities.map(entity => {
      const record = entity as unknown as {
        objectId?: string
        type?: string
        dxfTypeName?: string
        wcsBbox?: { min?: { x: number; y: number }; max?: { x: number; y: number } }
        userData?: Record<string, unknown>
      }
      const bbox = record.wcsBbox
      const finite =
        !!bbox?.min &&
        !!bbox?.max &&
        Number.isFinite(bbox.min.x) &&
        Number.isFinite(bbox.min.y) &&
        Number.isFinite(bbox.max.x) &&
        Number.isFinite(bbox.max.y)
      return {
        id: String(record.objectId ?? ''),
        type: record.type ?? record.dxfTypeName ?? (entity as { constructor?: { name?: string } }).constructor?.name ?? '?',
        bboxFinite: finite,
        bbox: bbox
          ? {
              min: [bbox.min?.x, bbox.min?.y],
              max: [bbox.max?.x, bbox.max?.y]
            }
          : null,
        userDataKeys: Object.keys(record.userData ?? {})
      }
    })
    const tally: Record<string, number> = {}
    for (const item of resolved) tally[item.type] = (tally[item.type] ?? 0) + 1
    return { tally, entities: resolved.slice(0, 12) }
  }, ids)
}

test(`phase29 index probe (${size} entities)`, async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(size, `p29probe${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const win = window as unknown as PageWindow
          const iterator =
            win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable.modelSpace.newIterator()
          if (!iterator) return 0
          let count = 0
          for (const _entity of iterator) {
            void _entity
            count += 1
          }
          return count
        }),
      { timeout: 900_000, intervals: [250] }
    )
    .toBe(size)

  const readiness = await page.evaluate(async () => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const started = performance.now()
    const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 240_000 })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: snapshot?.reasons ?? [],
      waitedMs: Math.round(performance.now() - started)
    }
  })
  const first = await readIndexGap(page)

  // A second look after an idle pause: if the index catches up on its own the
  // shortfall is a registration *window*, not a missing registration.
  await page.waitForTimeout(3_000)
  const second = await readIndexGap(page)
  const readinessAfterIdle = await page.evaluate(() => {
    const view = (window as unknown as PageWindow).AcApDocManager?.instance?.curView
    const snapshot = view?.getSceneReadiness?.({ sampleLimit: 64 })
    return {
      ready: Boolean(snapshot?.ready),
      reasons: snapshot?.reasons ?? [],
      sceneObjectIds: snapshot?.sceneObjectIds ?? -1,
      spatialIndexIds: snapshot?.spatialIndexIds ?? -1,
      missingFromSceneCount: snapshot?.missingFromSceneCount ?? -1,
      unindexedInScene: snapshot?.unindexedInScene ?? -1,
      missingFromIndexSamples: snapshot?.missingFromIndexSamples ?? [],
      checkedLayoutId: snapshot?.checkedLayoutId ?? ''
    }
  })

  const gapIds = second.flatMap(layout => layout.unindexedSample)
  const types = await readIdTypes(page, gapIds.slice(0, 40))

  const report = {
    tag,
    size,
    fixture: path.basename(fixture),
    userAgent: await page.evaluate(() => navigator.userAgent),
    readiness,
    readinessAfterIdle,
    first,
    second,
    gapTypes: types
  }
  fs.writeFileSync(
    path.join(reportsDir, `phase29-index-probe-${tag}-${size}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  )
  console.log(
    `[phase29-probe] ready=${readiness.ready} reasons=${readiness.reasons.join(',')} ` +
      `afterIdle=${readinessAfterIdle.ready}/${readinessAfterIdle.reasons.join(',')} ` +
      `gapTypes=${JSON.stringify(types.tally)}`
  )
})

/**
 * The gap only appears after `ERASE → Undo`, so the open path is not the one to
 * chase: undo re-adds entities through the batched group instead of through the
 * open stream, and that is where the index stops short.
 */
test(`phase29 index probe after erase/undo (${size} entities)`, async ({ page }) => {
  fs.mkdirSync(reportsDir, { recursive: true })
  const fixture = writeMixedFixture(size, `p29gap${size}`)
  await page.goto('/')
  await uploadFixture(page, fixture)
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const win = window as unknown as PageWindow
          const iterator =
            win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable.modelSpace.newIterator()
          if (!iterator) return 0
          let count = 0
          for (const _entity of iterator) {
            void _entity
            count += 1
          }
          return count
        }),
      { timeout: 900_000, intervals: [250] }
    )
    .toBe(size)

  const readinessOf = () =>
    page.evaluate(async () => {
      const view = (window as unknown as PageApWindow).AcApDocManager?.instance?.curView
      const snapshot = await view?.waitUntilSceneReady?.({ timeoutMs: 240_000 })
      const fresh = view?.getSceneReadiness?.({ sampleLimit: 64 })
      return {
        ready: Boolean(snapshot?.ready),
        reasons: snapshot?.reasons ?? [],
        after: fresh
          ? {
              ready: fresh.ready,
              reasons: fresh.reasons,
              sceneObjectIds: fresh.sceneObjectIds,
              spatialIndexIds: fresh.spatialIndexIds,
              missingFromSceneCount: fresh.missingFromSceneCount,
              unindexedInScene: fresh.unindexedInScene,
              missingFromIndexSamples: fresh.missingFromIndexSamples
            }
          : null
      }
    })

  const opened = await readinessOf()
  const gapAtOpen = await readIndexGap(page)

  const ids = await page.evaluate(() => {
    const win = window as unknown as PageWindow
    const iterator =
      win.AcApDocManager?.instance?.curDocument?.database.tables.blockTable.modelSpace.newIterator()
    const list: string[] = []
    if (iterator) for (const entity of iterator) list.push(String(entity.objectId))
    return list
  })

  await page.evaluate(list => {
    const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
    doc?.entityService.eraseEntities(list)
  }, ids)
  const afterErase = await readinessOf()

  /** One undo/redo plus a readiness sample and a gap snapshot. */
  const tap = async (kind: 'undo' | 'redo') => {
    await page.evaluate(name => {
      const doc =
        (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      if (name === 'undo') doc?.database.transactionManager.undo()
      else doc?.database.transactionManager.redo()
    }, kind)
    const readiness = await readinessOf()
    const gap = await readIndexGap(page)
    return { kind, readiness, gap }
  }

  // `ERASE → Undo → Redo → Undo` repeated, which is one round of the phase 2.9
  // lifecycle run. The first round where the gap appears names the culprit.
  const rounds = Number(process.env.P29_PROBE_ROUNDS ?? 3)
  const steps: Array<{
    round: number
    kind: 'erase' | 'undo' | 'redo'
    ready: boolean
    reasons: string[]
    gap: Array<{ sceneIds: number; indexIds: number; unindexedCount: number }>
  }> = []

  for (let round = 1; round <= rounds; round++) {
    await page.evaluate(list => {
      const doc = (window as unknown as PageWindow).AcApDocManager?.instance?.curDocument
      doc?.entityService.eraseEntities(list)
    }, ids)
    const eraseReadiness = await readinessOf()
    const eraseGap = await readIndexGap(page)
    steps.push({
      round,
      kind: 'erase',
      ready: eraseReadiness.ready,
      reasons: eraseReadiness.reasons,
      gap: eraseGap.map(layout => ({
        sceneIds: layout.sceneIds,
        indexIds: layout.indexIds,
        unindexedCount: layout.unindexedCount
      }))
    })

    for (const kind of ['undo', 'redo', 'undo'] as const) {
      const step = await tap(kind)
      steps.push({
        round,
        kind,
        ready: step.readiness.ready,
        reasons: step.readiness.reasons,
        gap: step.gap.map(layout => ({
          sceneIds: layout.sceneIds,
          indexIds: layout.indexIds,
          unindexedCount: layout.unindexedCount
        }))
      })
    }
  }

  const last = steps[steps.length - 1]
  const afterUndo = { ready: last.ready, reasons: last.reasons }
  const gapAfterUndo = steps
    .filter(step => step.reasons.length > 0)
    .map(step => ({ round: step.round, kind: step.kind, reasons: step.reasons }))
  const samples = await page.evaluate(() => {
    const view = (window as unknown as PageApWindow).AcApDocManager?.instance?.curView
    const fresh = view?.getSceneReadiness?.({ sampleLimit: 64 })
    return fresh?.missingFromIndexSamples ?? []
  })
  const types = await readIdTypes(page, samples.slice(0, 40))

  // Last look, one idle second later: a registration that merely ran late
  // would have caught up by now.
  await page.waitForTimeout(1_000)
  const afterIdle = await readinessOf()

  const report = {
    tag,
    size,
    fixture: path.basename(fixture),
    userAgent: await page.evaluate(() => navigator.userAgent),
    opened,
    gapAtOpen,
    afterErase,
    afterUndo,
    afterIdle,
    steps,
    gapAfterUndo,
    gapTypes: types
  }
  fs.writeFileSync(
    path.join(reportsDir, `phase29-index-gap-${tag}-${size}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  )
  console.log(
    `[phase29-gap] open=${opened.ready} erase=${afterErase.ready} ` +
      `failing=${
        gapAfterUndo.length === 0
          ? 'none'
          : gapAfterUndo.map(item => `r${item.round}/${item.kind}:${item.reasons.join('+')}`).join(' ')
      } idle=${afterIdle.ready} types=${JSON.stringify(types.tally)}`
  )
})

type PageApWindow = Window & {
  AcApDocManager?: {
    instance?: {
      curView?: {
        waitUntilSceneReady?: (options?: {
          timeoutMs?: number
        }) => Promise<{ ready: boolean; reasons: string[] }>
        getSceneReadiness?: (options?: { sampleLimit?: number }) => {
          ready: boolean
          reasons: string[]
          sceneObjectIds: number
          spatialIndexIds: number
          missingFromSceneCount: number
          missingFromIndexSamples: string[]
          unindexedInScene: number
        }
      }
    }
  }
}
