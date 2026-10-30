/**
 * Shared page-side counter reader for the Phase 2.13 harnesses.
 *
 * Kept in one place so the A/B arms, the erase/stress cell and the readiness
 * checks all compare *the same* four id sets: database, scene, spatial index,
 * plus the renderer's drawable count. A ghost or a stale index entry has to be
 * visible to every cell that claims to check correctness.
 */

import type { Page } from '@playwright/test'

export type WindowCounters = {
  longTasks: { count: number; totalMs: number; longestMs: number; over50: number; over200: number; over1000: number }
  frames: { samples: number; p50: number; p95: number; max: number }
  heapMB: number
  heapPeakMB: number
  scheduler: Record<string, number> | null
  slotLifecycle: Record<string, number> | null
  sharedBatch: Record<string, unknown> | null
  entityUpdateStats: Record<string, number> | null
  readiness: Record<string, unknown> | null
  renderer: { geometries: number | null; object3dNodes: number; renderables: number; uniqueGeometry: number }
  ids: {
    db: number
    scene: number
    index: number
    missingInScene: number
    residualInScene: number
    missingInIndex: number
    residualInIndex: number
  }
}

export async function readWindowCounters(page: Page): Promise<WindowCounters> {
  return page.evaluate(() => {
    type Win = Window & {
      AcApDocManager?: {
        instance?: {
          curView?: Record<string, unknown> & {
            getConversionSchedulerMetrics?: () => Record<string, number>
            getSlotLifecycleMetrics?: () => Record<string, number>
            getSharedBatchMetrics?: () => Record<string, unknown>
            getSceneReadiness?: () => Record<string, unknown>
            entityUpdateStats?: Record<string, number>
          }
          curDocument?: {
            database: {
              tables: { blockTable: { modelSpace: { newIterator: () => Iterable<{ objectId: string }> } } }
            }
          }
        }
      }
      __p213LongTasks?: number[]
      __p213Frames?: number[]
      __p213HeapPeak?: number
    }
    const win = window as unknown as Win
    const view = win.AcApDocManager?.instance?.curView
    const doc = win.AcApDocManager?.instance?.curDocument
    const longTasks = win.__p213LongTasks ?? []
    const frames = [...(win.__p213Frames ?? [])].sort((left, right) => left - right)
    const pct = (share: number) =>
      frames.length === 0 ? 0 : frames[Math.min(frames.length - 1, Math.floor(frames.length * share))]
    const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }

    const dbIds: string[] = []
    const iterator = doc?.database.tables.blockTable.modelSpace.newIterator()
    if (iterator) for (const entity of iterator) dbIds.push(String(entity.objectId))

    const layouts = (view as { _scene?: { _layouts?: Map<string, unknown> } })?._scene?._layouts
    const layoutValues = layouts instanceof Map ? Array.from(layouts.values()) : []

    const sceneIds: string[] = []
    const indexIds: string[] = []
    let renderables = 0
    let object3dNodes = 0
    const geometrySet = new Set<unknown>()
    for (const layout of layoutValues) {
      const collect = (layout as { collectObjectIds?: () => Set<string> }).collectObjectIds
      if (typeof collect === 'function') {
        for (const id of collect.call(layout)) sceneIds.push(String(id))
      }
      const index = (layout as {
        _spatialIndex?: { search: (box: Record<string, number>) => Array<{ id: string }> }
      })._spatialIndex
      for (const item of index?.search?.({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }) ?? []) {
        indexIds.push(String(item.id))
      }
      ;(layout as { _group?: { traverse: (fn: (node: unknown) => void) => void } })?._group?.traverse(node => {
        object3dNodes++
        const drawable = node as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; geometry?: unknown }
        if (!drawable.isMesh && !drawable.isLine && !drawable.isPoints) return
        renderables++
        if (drawable.geometry) geometrySet.add(drawable.geometry)
      })
    }

    const dbSet = new Set(dbIds)
    const sceneSet = new Set(sceneIds)
    const indexSet = new Set(indexIds)
    const renderer = (view as { renderer?: { _renderer?: { info?: Record<string, unknown> } } })?.renderer?._renderer
      ?.info as { memory?: { geometries?: number } } | undefined

    return {
      longTasks: {
        count: longTasks.length,
        totalMs: Math.round(longTasks.reduce((total, value) => total + value, 0) * 10) / 10,
        longestMs: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        over50: longTasks.filter(value => value >= 50).length,
        over200: longTasks.filter(value => value >= 200).length,
        over1000: longTasks.filter(value => value >= 1000).length
      },
      frames: {
        samples: frames.length,
        p50: Math.round(pct(0.5) * 10) / 10,
        p95: Math.round(pct(0.95) * 10) / 10,
        max: Math.round((frames[frames.length - 1] ?? 0) * 10) / 10
      },
      heapMB: Math.round(((perf.memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
      heapPeakMB: Math.round(((win.__p213HeapPeak ?? 0) / 1024 / 1024) * 10) / 10,
      scheduler: view?.getConversionSchedulerMetrics?.() ?? null,
      slotLifecycle: view?.getSlotLifecycleMetrics?.() ?? null,
      sharedBatch: view?.getSharedBatchMetrics?.() ?? null,
      entityUpdateStats: view?.entityUpdateStats ?? null,
      readiness: (() => {
        try {
          return view?.getSceneReadiness?.() ?? null
        } catch (error) {
          return { error: String((error as Error)?.message ?? error) }
        }
      })(),
      renderer: {
        geometries: renderer?.memory?.geometries ?? null,
        object3dNodes,
        renderables,
        uniqueGeometry: geometrySet.size
      },
      ids: {
        db: dbIds.length,
        scene: sceneIds.length,
        index: indexIds.length,
        missingInScene: dbIds.filter(id => !sceneSet.has(id)).length,
        residualInScene: sceneIds.filter(id => !dbSet.has(id)).length,
        missingInIndex: sceneIds.filter(id => !indexSet.has(id)).length,
        residualInIndex: indexIds.filter(id => !sceneSet.has(id)).length
      }
    }
  })
}

/** Long-task and frame observers; install with `page.addInitScript`. */
export async function installWindowObservers(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __p213LongTasks: number[]
      __p213Frames: number[]
      __p213HeapPeak: number
    }
    win.__p213LongTasks = []
    win.__p213Frames = []
    win.__p213HeapPeak = 0
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) win.__p213LongTasks.push(Math.round(entry.duration * 10) / 10)
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // `longtask` is Chromium-only.
    }
    let previous = 0
    const sample = (now: number) => {
      if (previous > 0) win.__p213Frames.push(Math.round((now - previous) * 10) / 10)
      previous = now
      const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } }
      const used = perf.memory?.usedJSHeapSize ?? 0
      if (used > win.__p213HeapPeak) win.__p213HeapPeak = used
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

export async function resetWindowObservers(page: Page) {
  await page.evaluate(() => {
    const win = window as unknown as { __p213LongTasks: number[]; __p213Frames: number[]; __p213HeapPeak: number }
    win.__p213LongTasks = []
    win.__p213Frames = []
    win.__p213HeapPeak = 0
  })
}
