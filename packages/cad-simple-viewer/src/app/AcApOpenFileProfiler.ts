import {
  AcCmPerformanceCollector,
  AcDbDatabase,
  AcDbProgressdEventArgs,
  AcDbRenderingCache,
  AcDbSystemVariables,
  AcDbSysVarManager,
  log
} from '@mlightcad/data-model'
import { AcTrGroup, AcTrMTextRenderer } from '@mlightcad/three-renderer'

import type { AcTrView2d } from '../view/AcTrView2d'
import { getLastFontLoadStats } from './AcApFontLoader'

type StageStats = {
  durationMs: number
}

/**
 * How long OPENPROF waits for scene convert before publishing anyway.
 *
 * Text-heavy drawings can keep deferred glyph jobs running for minutes; a
 * profiler that only reports after idle never explains the hang it was meant
 * to diagnose.
 */
const OPENPROF_SCENE_WAIT_TIMEOUT_MS = 120_000

/**
 * Snapshot of the most recent document-open profile for palette / console use.
 */
export interface AcApOpenFileProfileSnapshot {
  collectedAt: number
  fileName?: string
  totalMs: number
  readMs: number
  convertMs: number
  parseMs: number
  entityMs: number
  stages: { name: string; durationMs: number }[]
  cache: {
    hits: number
    misses: number
    hitMs: number
    cloneMs: number
    missBuildMs: number
    missCompactMs: number
    setCloneMs: number
    applyMs: number
    topLevel: {
      hits: number
      misses: number
      hitMs: number
      cloneMs: number
      missBuildMs: number
      missCompactMs: number
      setCloneMs: number
      applyMs: number
    }
  }
  slowBlocks: {
    blockName: string
    buildMs: number
    compactMs: number
  }[]
  progressive?: {
    enabled: boolean
    paintCount: number
    yieldCount: number
  }
  convertPhase?: {
    finishGeometryMs: number
    /** Portion of `finishGeometryMs` spent in a block's `group.asyncDraw()`. */
    groupGlyphMs: number
    handleGroupMs: number
    addEntityMs: number
    awaitFontsMs: number
    fontPreload?: {
      critical: string[]
      workerWarm?: string[]
      background: string[]
      preset?: string[]
      workerSkipped: number
      parseSite?: 'main' | 'worker'
    }
  }
  /**
   * Convert-queue snapshot when the report was published. `pendingEntities`
   * covers linework convert; `pendingGeometryJobs` covers deferred glyph /
   * INSERT jobs. A large glyph count with `pendingEntities: 0` means the
   * overlay is held by text finalize, not by entity conversion.
   */
  scene?: {
    pendingEntities: number
    convertQueued: number
    deferredQueued: number
    deferredActive: number
    pendingGeometryJobs: number
    deferredGroupJobs: number
    deferredGlyphJobs: number
    claimedObjects: number
  }
  /** True when the scene was still busy at the wait timeout. */
  sceneBusyAtReport?: boolean
}

/**
 * Session open-file profiler.
 *
 * Always records PARSE/ENTITY (and other `openProgress` sub-stages),
 * wall-clock read vs scene convert time, and {@link AcDbRenderingCache}
 * hit/miss counters for the last open. Console output remains gated by the
 * {@link AcDbSystemVariables.OPENPROF} system variable.
 *
 * Stage durations use **active-stage wall time**: from the first event of a
 * sub-stage until the first event of a different sub-stage.
 *
 * Drawing fonts are loaded on demand during text draw, not during `db.read`.
 * Explicit {@link AcApFontLoader} loads still contribute via
 * {@link getLastFontLoadStats} in the console report.
 */
export class AcApOpenFileProfiler {
  private static _lastSnapshot: AcApOpenFileProfileSnapshot | null = null

  private _active = false
  private _printToConsole = false
  private _t0 = 0
  private _readEndMs = 0
  private _stages = new Map<string, StageStats>()
  private _activeStage?: string
  private _activeStageStartedAt = 0
  private _progressListener?: (args: AcDbProgressdEventArgs) => void
  private _database?: AcDbDatabase
  private _finishScheduled = false
  /** Scene convert did not reach idle before the wait timeout. */
  private _sceneBusyTimedOut = false

  /**
   * Returns the most recent completed open-file profile, if any.
   */
  static getLastSnapshot(): AcApOpenFileProfileSnapshot | null {
    return AcApOpenFileProfiler._lastSnapshot
  }

  /**
   * Returns whether OPENPROF console logging is enabled for `database`.
   */
  static isEnabled(database: AcDbDatabase): boolean {
    try {
      if (
        AcDbSysVarManager.instance().getVar(
          AcDbSystemVariables.OPENPROF,
          database
        ) === true
      ) {
        return true
      }
    } catch {
      // Fall through to the URL/localStorage switch.
    }
    // Debug escape hatch for hosts that do not expose the sysvar manager to
    // the console: `?openprof=1` or localStorage['cad-openprof'] = '1'.
    try {
      if (typeof window === 'undefined') {
        return false
      }
      const param = new URL(window.location.href).searchParams.get('openprof')
      if (param === '1' || param === 'true') {
        return true
      }
      return window.localStorage.getItem('cad-openprof') === '1'
    } catch {
      return false
    }
  }

  /**
   * Starts a profiling session for the next document open.
   *
   * Call from document-open start (before `db.read` / URI open). Always
   * collects a snapshot; console printing follows OPENPROF.
   *
   * @param database - Database that will emit `openProgress` for this open.
   */
  begin(database: AcDbDatabase): void {
    this.cancel()

    this._active = true
    this._printToConsole = AcApOpenFileProfiler.isEnabled(database)
    this._finishScheduled = false
    this._sceneBusyTimedOut = false
    AcTrGroup.resetAsyncDrawTimings()
    this._t0 = performance.now()
    this._readEndMs = 0
    this._stages.clear()
    this._activeStage = undefined
    this._activeStageStartedAt = 0
    this._database = database

    AcDbRenderingCache.resetProfile()
    AcDbRenderingCache.profiling = true

    this._progressListener = (args: AcDbProgressdEventArgs) => {
      this.onProgress(args)
    }
    database.events.openProgress.addEventListener(this._progressListener)
  }

  /**
   * Marks the end of `db.read` / document open await and schedules the report
   * once the view has finished converting entities.
   *
   * @param view - Active 2d view whose entity convert queue is drained.
   */
  markReadCompleteAndScheduleReport(view: AcTrView2d): void {
    if (!this._active) {
      return
    }
    this._readEndMs = performance.now()
    this.scheduleReport(view)
  }

  /**
   * Aborts an in-flight session without publishing (e.g. document replaced).
   */
  cancel(): void {
    this.detachProgressListener()
    if (this._active) {
      AcDbRenderingCache.profiling = false
    }
    this._active = false
    this._printToConsole = false
    this._finishScheduled = false
    this._sceneBusyTimedOut = false
    this._database = undefined
    this._activeStage = undefined
    this._stages.clear()
  }

  private onProgress(args: AcDbProgressdEventArgs): void {
    const name = String(args.subStage ?? args.stage ?? 'UNKNOWN')
    const now = performance.now()
    if (this._activeStage == null) {
      this._activeStage = name
      this._activeStageStartedAt = now
      return
    }
    if (name !== this._activeStage) {
      this.closeActiveStage(now)
      this._activeStage = name
      this._activeStageStartedAt = now
    }
  }

  private closeActiveStage(now: number): void {
    if (this._activeStage == null) {
      return
    }
    let stats = this._stages.get(this._activeStage)
    if (!stats) {
      stats = { durationMs: 0 }
      this._stages.set(this._activeStage, stats)
    }
    stats.durationMs += Math.max(0, now - this._activeStageStartedAt)
    this._activeStage = undefined
  }

  private scheduleReport(view: AcTrView2d): void {
    if (!this._active || this._finishScheduled) {
      return
    }
    this._finishScheduled = true
    void this.waitForIdle(view)
      .then(() => {
        if (!this._active) {
          return
        }
        this.publishReport(performance.now(), view)
        this.cancel()
      })
      .catch(error => {
        log.warn('OPENPROF: failed to finish open profile', error)
        this.cancel()
      })
  }

  private async waitForIdle(view: AcTrView2d): Promise<void> {
    // Allow any synchronously queued addEntity calls to bump the counter.
    await Promise.resolve()
    if (!view.isProcessingEntities) {
      return
    }
    const startedAt = performance.now()
    let lastLogAt = startedAt
    await new Promise<void>(resolve => {
      const poll = () => {
        if (!view.isProcessingEntities) {
          resolve()
          return
        }
        const now = performance.now()
        // Print what is left every 2 s instead of waiting silently for a
        // report that a text-heavy drawing may delay for minutes.
        if (this._printToConsole && now - lastLogAt >= 2000) {
          lastLogAt = now
          const stats =
            typeof view.getOpenConvertStats === 'function'
              ? view.getOpenConvertStats()
              : null
          console.log(
            `[OPENPROF] scene busy +${((now - startedAt) / 1000).toFixed(1)} s`,
            stats
          )
        }
        if (now - startedAt >= OPENPROF_SCENE_WAIT_TIMEOUT_MS) {
          this._sceneBusyTimedOut = true
          resolve()
          return
        }
        setTimeout(poll, 16)
      }
      poll()
    })
  }

  private publishReport(convertEndMs: number, view: AcTrView2d): void {
    // Close the last openProgress stage when read finished (usually END/ENTITY).
    this.closeActiveStage(this._readEndMs > 0 ? this._readEndMs : convertEndMs)

    const readMs = Math.max(0, this._readEndMs - this._t0)
    const convertMs = Math.max(0, convertEndMs - this._readEndMs)
    const totalMs = Math.max(0, convertEndMs - this._t0)
    const parseMs = this._stages.get('PARSE')?.durationMs ?? 0
    const entityMs = this._stages.get('ENTITY')?.durationMs ?? 0
    const cache = { ...AcDbRenderingCache.profileStats }
    const tl = cache.topLevel
    const progressiveStats = view.progressiveOpenStats
    const progressiveEnabled = view.progressiveRendering
    const convertPhaseRaw =
      typeof view.takeConvertPhaseTimings === 'function'
        ? view.takeConvertPhaseTimings()
        : null
    const convertPhase = convertPhaseRaw
      ? {
          finishGeometryMs: convertPhaseRaw.finishGeometry,
          groupGlyphMs: convertPhaseRaw.groupGlyph,
          handleGroupMs: convertPhaseRaw.handleGroup,
          addEntityMs: convertPhaseRaw.addEntity,
          awaitFontsMs: convertPhaseRaw.awaitFonts,
          fontPreload: convertPhaseRaw.fontPreload
        }
      : undefined
    const asyncDraw = AcTrGroup.getAsyncDrawTimings()
    const scene =
      typeof view.getOpenConvertStats === 'function'
        ? view.getOpenConvertStats()
        : undefined

    const slowBlocks = [...cache.blockMisses]
      .sort((a, b) => b.buildMs + b.compactMs - (a.buildMs + a.compactMs))
      .slice(0, 10)
      .map(block => ({
        blockName: block.blockName,
        buildMs: block.buildMs,
        compactMs: block.compactMs
      }))

    const stages = [...this._stages.entries()]
      .filter(([, stats]) => stats.durationMs > 0)
      .sort((a, b) => b[1].durationMs - a[1].durationMs)
      .map(([name, stats]) => ({ name, durationMs: stats.durationMs }))

    const snapshot: AcApOpenFileProfileSnapshot = {
      collectedAt: Date.now(),
      fileName: this._database?.dwgname,
      totalMs,
      readMs,
      convertMs,
      parseMs,
      entityMs,
      stages,
      cache: {
        hits: cache.hits,
        misses: cache.misses,
        hitMs: cache.hitMs,
        cloneMs: cache.cloneMs,
        missBuildMs: cache.missBuildMs,
        missCompactMs: cache.missCompactMs,
        setCloneMs: cache.setCloneMs,
        applyMs: cache.applyMs,
        topLevel: { ...tl }
      },
      slowBlocks,
      progressive: {
        enabled: progressiveEnabled,
        paintCount: progressiveStats.paintCount,
        yieldCount: progressiveStats.yieldCount
      },
      convertPhase,
      scene,
      sceneBusyAtReport: this._sceneBusyTimedOut || undefined
    }
    AcApOpenFileProfiler._lastSnapshot = snapshot

    if (!this._printToConsole) {
      return
    }

    const pct = (part: number, total: number) =>
      total <= 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`

    const lines: string[] = [
      '',
      '========== OPENPROF (open-file profile) ==========',
      'Note: progress-bar % weights (PARSE~12%, ENTITY~98%) are not wall-time shares.',
      'Stage ms = active-stage wall time (first event of stage → first event of next stage).',
      `progressive:          ${progressiveEnabled ? 'on' : 'off'} (mid-open paints=${progressiveStats.paintCount}, yields=${progressiveStats.yieldCount})`,
      `wall clock total:     ${totalMs.toFixed(0)} ms`,
      `  db.read:            ${readMs.toFixed(0)} ms  (${pct(readMs, totalMs)})`,
      `    PARSE:            ${parseMs.toFixed(0)} ms  (${pct(parseMs, readMs)} of read)`,
      `    ENTITY flush:     ${entityMs.toFixed(0)} ms  (${pct(entityMs, readMs)} of read)`,
      `  scene convert:      ${convertMs.toFixed(0)} ms  (${pct(convertMs, totalMs)})`
    ]

    if (convertPhase) {
      // `groupGlyph` is only meaningful next to the mode that produced it:
      // main-thread glyph draw is serial, worker draw runs `min(4, cores)` wide.
      let mtextMode: string | undefined
      try {
        mtextMode = AcTrMTextRenderer.getInstance().getRenderMode()
      } catch {
        mtextMode = undefined
      }
      lines.push(
        `    finishGeometry:   ${convertPhase.finishGeometryMs.toFixed(0)} ms (cumulative)`,
        `      groupGlyph:     ${convertPhase.groupGlyphMs.toFixed(0)} ms (block asyncDraw inside finishGeometry)`,
        `        glyphDraw:    ${asyncDraw.glyph.toFixed(0)} ms (pending glyph draw)`,
        `        bboxRefresh:  ${asyncDraw.bbox.toFixed(0)} ms (wcs child boxes after glyphs)`,
        `    handleGroup:      ${convertPhase.handleGroupMs.toFixed(0)} ms (cumulative)`,
        `    addEntity:        ${convertPhase.addEntityMs.toFixed(0)} ms`,
        // Wall time of preset + STYLE font preload awaited before glyph draw.
        `    awaitFonts:       ${convertPhase.awaitFontsMs.toFixed(0)} ms (preset+style preload wall)`,
        `    mtext render mode: ${mtextMode ?? 'unknown'}` +
          (mtextMode === 'main'
            ? ' (glyph draw is serial on the main thread)'
            : ' (glyph draw runs in a worker pool)')
      )
      const fp = convertPhase.fontPreload
      if (fp) {
        lines.push(
          `    fontPreload parseSite:  ${fp.parseSite ?? 'main'}`,
          `    fontPreload critical:   [${fp.critical.join(', ')}]`,
          `    fontPreload preset:     [${(fp.preset ?? fp.workerWarm ?? []).join(', ')}]`,
          `    fontPreload background: [${fp.background.join(', ')}]`,
          `    fontPreload workerSkipped: ${fp.workerSkipped} (already in pool)`
        )
      }
    }

    if (scene) {
      lines.push(
        '',
        '--- scene queue at report time ---',
        `pending entities: ${scene.pendingEntities}, convert queued: ${scene.convertQueued}`,
        `deferred: ${scene.deferredQueued} queued + ${scene.deferredActive} active ` +
          `(group ${scene.deferredGroupJobs}, glyph ${scene.deferredGlyphJobs}), ` +
          `pending jobs ${scene.pendingGeometryJobs}`,
        `claimed object ids: ${scene.claimedObjects}`
      )
      if (this._sceneBusyTimedOut) {
        lines.push(
          `scene still busy after ${(OPENPROF_SCENE_WAIT_TIMEOUT_MS / 1000).toFixed(0)} s ` +
            '- report published at timeout'
        )
      }
    }

    const fontLoad = getLastFontLoadStats()
    if (fontLoad) {
      lines.push(
        `  explicit font load: critical=${fontLoad.criticalLoadMs.toFixed(0)}ms meta=${fontLoad.metaMs.toFixed(0)}ms` +
          ` deferredMesh=${fontLoad.deferred ? 'yes' : 'no'}` +
          ` (critical=[${fontLoad.criticalFonts.join(',')}]` +
          ` deferred=[${fontLoad.deferredFonts.join(',')}])`
      )
    }

    lines.push(
      '',
      '--- AcDbRenderingCache (top-level INSERT draws) ---',
      `hits:   ${tl.hits}, hit path ${tl.hitMs.toFixed(0)} ms (clone ${tl.cloneMs.toFixed(0)} ms)`,
      `misses: ${tl.misses}, build ${tl.missBuildMs.toFixed(0)} ms (incl. nested), compact ${tl.missCompactMs.toFixed(0)} ms, set/clone ${tl.setCloneMs.toFixed(0)} ms`,
      `applyMatrix+attribs: ${tl.applyMs.toFixed(0)} ms`,
      '',
      `--- AcDbRenderingCache (all depths: hits=${cache.hits}, misses=${cache.misses}) ---`,
      `hit ${cache.hitMs.toFixed(0)} ms (clone ${cache.cloneMs.toFixed(0)}), build ${cache.missBuildMs.toFixed(0)}, compact ${cache.missCompactMs.toFixed(0)}, set ${cache.setCloneMs.toFixed(0)}, apply ${cache.applyMs.toFixed(0)}`
    )

    if (slowBlocks.length > 0) {
      lines.push('', '--- Slowest block template misses (build+compact) ---')
      for (const block of slowBlocks) {
        const name =
          block.blockName.length > 40
            ? `${block.blockName.slice(0, 37)}...`
            : block.blockName
        lines.push(
          `${name.padEnd(40)} build=${block.buildMs.toFixed(0).padStart(7)}ms  compact=${block.compactMs.toFixed(0).padStart(7)}ms  total=${(block.buildMs + block.compactMs).toFixed(0).padStart(7)}ms`
        )
      }
    }

    const otherStages = stages.filter(
      stage => !['PARSE', 'FONT', 'ENTITY', 'START', 'END'].includes(stage.name)
    )
    if (otherStages.length > 0) {
      lines.push('', '--- Other openProgress sub-stages ---')
      for (const stage of otherStages) {
        lines.push(`  ${stage.name}: ${stage.durationMs.toFixed(0)} ms`)
      }
    }

    lines.push('==================================================', '')
    console.log(lines.join('\n'))

    // Classic converter also fills AcCmPerformanceCollector ("Load Database").
    try {
      const collector = AcCmPerformanceCollector.getInstance()
      if (collector.getAll().length > 0) {
        console.log('--- AcCmPerformanceCollector ---')
        collector.printAll()
      }
    } catch {
      // optional
    }
  }

  private detachProgressListener(): void {
    if (this._progressListener && this._database) {
      this._database.events.openProgress.removeEventListener(
        this._progressListener
      )
    }
    this._progressListener = undefined
  }
}
