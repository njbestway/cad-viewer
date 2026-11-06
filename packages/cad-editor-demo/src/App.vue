<template>
  <div id="app-root">
    <!-- Upload screen when no drawing is open -->
    <div v-if="!showViewer" class="upload-screen">
      <FileUpload
        :landing-manager="landingDataSources"
        @file-select="handleFileSelect"
        @new-drawing="handleNewDrawing"
        @url-select="handleUrlSelect"
      />
    </div>

    <!-- CAD viewer when a file is selected or a new drawing is created -->
    <div v-else-if="viewerPrepared">
      <MlCadViewer
        locale="default"
        :url="store.selectedUrl ?? undefined"
        :local-file="store.selectedFile ?? undefined"
        :mode="selectedMode"
        :use-main-thread-draw="useMainThreadDraw"
        :draw-no-plot-layers="drawNoPlotLayers"
        :progressive-rendering="progressiveRendering"
        :open-view-mode="openViewMode"
        :circle-sides="circleSides"
        :paper-space-background="paperSpaceBackground"
        :disable-export="disableExport"
        @create="onViewerCreate"
        :base-url="BASE_URL"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  AcApDataSourceManager,
  AcApOpenViewMode,
  AcEdOpenMode,
  acuiAttachDataSources} from '@mlightcad/cad-simple-viewer/file-open-panel'
import {
  ACDB_DRAW_CIRCLE_SIDES_DRAFT,
  ACGI_PAPER_SPACE_BACKGROUND,
  log
} from '@mlightcad/data-model'
import { computed, defineAsyncComponent, nextTick, ref } from 'vue'

import FileUpload from './components/FileUpload.vue'
import {
  getGoogleDriveEnvConfig,
  registerGoogleDriveFromEnv
} from './googleDriveEnv'
import { initializeLocale } from './locale'
import {
  getOneDriveEnvConfig,
  registerOneDriveFromEnv
} from './onedriveEnv'
import { registerLibreDwgConverter } from './registerLibreDwg'
import { store } from './store'

const MlCadViewer = defineAsyncComponent(() =>
  import('@mlightcad/cad-editor').then(m => m.MlCadViewer)
)

initializeLocale()

const oneDriveEnv = getOneDriveEnvConfig()
const googleDriveEnv = getGoogleDriveEnvConfig()

/**
 * Landing-page registry used before DocManager exists.
 * Outlives the upload screen so the same cloud source instances can be
 * attached to DocManager after the viewer mounts.
 */
const landingDataSources = new AcApDataSourceManager()

const setupLandingCloudSources = async () => {
  if (oneDriveEnv) {
    try {
      const { AcApOneDriveDataSource } =
        await import('@mlightcad/cad-onedrive-plugin')
      if (!landingDataSources.get('onedrive')) {
        const source = new AcApOneDriveDataSource(
          oneDriveEnv,
          landingDataSources
        )
        landingDataSources.register(source)
        await source.restoreSession()
      }
    } catch (error) {
      log.warn('Landing OneDrive data source unavailable:', error)
    }
  }

  if (googleDriveEnv) {
    try {
      const { AcApGoogleDriveDataSource } =
        await import('@mlightcad/cad-google-drive-plugin')
      if (!landingDataSources.get('googledrive')) {
        const source = new AcApGoogleDriveDataSource(
          googleDriveEnv,
          landingDataSources
        )
        landingDataSources.register(source)
        await source.restoreSession()
      }
    } catch (error) {
      log.warn('Landing Google Drive data source unavailable:', error)
    }
  }
}

void setupLandingCloudSources()

let oneDriveRegistered = false
let googleDriveRegistered = false
let viewerRuntimeReady = false

const viewerPrepared = ref(false)

const ensureViewerRuntime = async () => {
  if (viewerRuntimeReady) {
    viewerPrepared.value = true
    return
  }
  const { AcApSettingManager, LIBREDWG_PARSER_WORKER_FILE } = await import(
    '@mlightcad/cad-simple-viewer'
  )
  // Isolate this example's prefs from cad-simple-viewer-demo on localhost.
  AcApSettingManager.configure({
    storageKey: 'mlightcad.settings.cad-viewer'
  })
  registerLibreDwgConverter(`./assets/${LIBREDWG_PARSER_WORKER_FILE}`)
  viewerRuntimeReady = true
  viewerPrepared.value = true
}

const registerOneDriveIfConfigured = async (
  pluginManager: import('@mlightcad/cad-simple-viewer').AcApPluginManager
) => {
  if (oneDriveRegistered || !oneDriveEnv) return
  try {
    const registered = await registerOneDriveFromEnv(pluginManager)
    oneDriveRegistered = registered
    if (registered) {
      log.info('[example] OneDrive data source registered')
    }
  } catch (error) {
    log.warn('OneDrive plugin not available:', error)
  }
}

const registerGoogleDriveIfConfigured = async (
  pluginManager: import('@mlightcad/cad-simple-viewer').AcApPluginManager
) => {
  if (googleDriveRegistered || !googleDriveEnv) return
  try {
    const registered = await registerGoogleDriveFromEnv(pluginManager)
    googleDriveRegistered = registered
    if (registered) {
      log.info('[example] Google Drive data source registered')
    }
  } catch (error) {
    log.warn('Google Drive plugin not available:', error)
  }
}

const initialize = async () => {
  const {
    AcApDocManager,
    AcEdCommandStack
  } = await import('@mlightcad/cad-simple-viewer')
  const { AcApQuitCmd } = await import('./commands')
  if (import.meta.env.DEV) {
    ;(
      window as Window & { AcApDocManager?: typeof AcApDocManager }
    ).AcApDocManager = AcApDocManager
  }
  const register = AcApDocManager.instance.commandManager
  register.addCommand(
    AcEdCommandStack.SYSTEMT_COMMAND_GROUP_NAME,
    'quit',
    'quit',
    new AcApQuitCmd()
  )
  register.addCommand(
    AcEdCommandStack.SYSTEMT_COMMAND_GROUP_NAME,
    'exit',
    'exit',
    new AcApQuitCmd()
  )
}

// Base URL for cad-data resources (drawings, fonts, drawing templates). The dev
// and preview servers serve the repo-root `caddata/` checkout of
// mlightcad/cad-data live at /cad-data/ (see vite.config.ts), so nothing is
// pulled from the CDN.
const BASE_URL = '/cad-data/'

/* eslint-disable */
// TEMP hatch/pattern probe — `__DUMP_ENTITY('102E89')`, `__SCAN_HATCH()`.
const safe = (fn: any): any => {
  try {
    return typeof fn === 'function' ? fn() : fn
  } catch {
    return '<err>'
  }
}
// `AcApDocManager` is imported dynamically (see `initialize()`) and only exposed
// on `window` in dev; referencing the symbol directly would pull the whole
// viewer back into the landing-page bundle.
const curDb = (): any =>
  (window as any).AcApDocManager?.instance?.curDocument?.database ?? null
const mapDefLines = (arr: any) =>
  (arr ?? []).map((l: any) => ({
    angle: l.angle,
    base: l.base,
    offset: l.offset,
    dashLengths: l.dashLengths
  }))
const findEnt = (db: any, id: string): any => {
  const s = String(id).toLowerCase()
  // objectId and handle can diverge from getEntityById's key, so scan model
  // space and match either, falling back to getEntityById.
  try {
    for (const x of db.tables.blockTable.modelSpace.newIterator()) {
      const e: any = x
      if (
        String(e.objectId).toLowerCase() === s ||
        String(e.handle).toLowerCase() === s
      )
        return e
    }
  } catch {
    /* ignore */
  }
  return db.tables.blockTable.getEntityById(String(id))
}
const dumpEntity = (id: string) => {
  const db = curDb()
  const ent: any = db ? findEnt(db, id) : null
  if (!ent) {
    console.log('[DBG] entity not found', id)
    return null
  }
  const ls: any =
    ent.lineStyle ?? (ent.linetype ? { name: ent.linetype } : null)
  const larr = ls?.lines ?? ls?.pattern ?? ls?.elements ?? []
  let eff: any = null
  const mock: any = new Proxy(
    { subEntityTraits: {}, context: { database: db } },
    {
      get: (t: any, p: string) => (p in t ? t[p] : () => undefined),
      set: (t: any, p: string, v: any) => {
        t[p] = v
        return true
      }
    }
  )
  try {
    if (typeof ent.subWorldDraw === 'function') ent.subWorldDraw(mock)
    else if (typeof ent.worldDraw === 'function') ent.worldDraw(mock)
    const ft = mock.subEntityTraits.fillType
    if (ft)
      eff = {
        solidFill: ft.solidFill,
        patternAngle: ft.patternAngle,
        nDef: ft.definitionLines?.length,
        definitionLines: mapDefLines(ft.definitionLines)
      }
  } catch (e) {
    eff = 'worldDraw err: ' + e
  }
  const out = {
    id,
    type: ent.constructor?.name,
    objectId: String(ent.objectId),
    handle: String(ent.handle),
    layer: ent.layer,
    closed: ent.closed,
    numberOfVertices: ent.numberOfVertices,
    linetype: ls
      ? {
          name: ls.name,
          totalPatternLength: ls.totalPatternLength,
          elements: Array.isArray(larr)
            ? larr.map((e: any) => ({
                length: e.length,
                type: e.elementTypeFlag,
                text: e.text,
                shapeNumber: e.shapeNumber
              }))
            : null
        }
      : null,
    patternName: safe(ent.patternName),
    patternType: safe(ent.patternType),
    patternScale: safe(ent.patternScale),
    isSolidFill: safe(ent.isSolidFill),
    nDefLines: safe(() => ent.definitionLines?.length),
    recordDefinitionLines: safe(() => mapDefLines(ent.definitionLines)),
    effective: eff
  }
  console.log('[DBG ENTITY]', JSON.stringify(out, null, 1))
  return out
}
const scanHatch = () => {
  const db = curDb()
  if (!db) {
    console.log('[DBG] no database open')
    return []
  }
  const rows: any[] = []
  for (const e of db.tables.blockTable.modelSpace.newIterator()) {
    const ee: any = e
    const isHatch =
      ee.constructor?.name?.includes('Hatch') ||
      ee.patternName != null ||
      (ee.definitionLines && ee.definitionLines.length)
    if (isHatch) {
      rows.push({
        id: String(ee.objectId),
        type: ee.constructor?.name,
        layer: ee.layer,
        patternName: safe(ee.patternName),
        patternScale: safe(ee.patternScale),
        solid: ee.isSolidFill,
        nDef: safe(() => ee.definitionLines?.length)
      })
    }
  }
  console.log(
    '[DBG HATCHES] count=' + rows.length,
    JSON.stringify(rows, null, 1)
  )
  return rows
}
;(window as any).__DUMP_ENTITY = dumpEntity
;(window as any).__SCAN_HATCH = scanHatch
/* eslint-enable */

const showViewer = computed(
  () =>
    store.selectedFile != null ||
    store.selectedUrl != null ||
    store.isNewDrawing
)

const selectedMode = ref<AcEdOpenMode>(AcEdOpenMode.Write)
const useMainThreadDraw = ref(true)
const drawNoPlotLayers = ref(false)
const progressiveRendering = ref(false)
const openViewMode = ref<AcApOpenViewMode | undefined>(undefined)
const circleSides = ref(ACDB_DRAW_CIRCLE_SIDES_DRAFT)
const paperSpaceBackground = ref(ACGI_PAPER_SPACE_BACKGROUND)
const disableExport = ref(false)

const createNewDrawing = async () => {
  const { AcApDocManager, layoutBackgroundColorFromRgb } = await import(
    '@mlightcad/cad-simple-viewer'
  )
  const success = await AcApDocManager.instance.newDocument({
    mode: selectedMode.value,
    drawNoPlotLayers: drawNoPlotLayers.value,
    progressiveRendering: progressiveRendering.value,
    circleSides: circleSides.value,
    sysVars: {
      paperbkcolor: layoutBackgroundColorFromRgb(paperSpaceBackground.value)
    },
    ...(openViewMode.value != null ? { openViewMode: openViewMode.value } : {})
  })
  if (!success) {
    log.error('Failed to create new drawing')
  }
}

const onViewerCreate = async () => {
  await initialize()
  const { AcApDocManager } = await import('@mlightcad/cad-simple-viewer')
  // Reuse landing MSAL / GIS clients — a second client for the same app id
  // splits the cache and can block interactive login.
  acuiAttachDataSources(
    landingDataSources,
    AcApDocManager.instance.dataSourceManager
  )
  if (landingDataSources.get('onedrive')) oneDriveRegistered = true
  if (landingDataSources.get('googledrive')) googleDriveRegistered = true
  await registerOneDriveIfConfigured(AcApDocManager.instance.pluginManager)
  await registerGoogleDriveIfConfigured(AcApDocManager.instance.pluginManager)
  if (store.isNewDrawing) {
    await nextTick()
    await createNewDrawing()
  }
}

const applyOpenOptions = (
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined,
  sides: number,
  paperBg: number,
  exportDisabled: boolean
) => {
  selectedMode.value = mode
  useMainThreadDraw.value = mainThreadDraw
  drawNoPlotLayers.value = showNoPlotLayers
  progressiveRendering.value = enableProgressiveRendering
  openViewMode.value = viewMode
  circleSides.value = sides
  paperSpaceBackground.value = paperBg
  disableExport.value = exportDisabled
}

const openViewer = async (apply: () => void) => {
  await ensureViewerRuntime()
  apply()
}

const handleFileSelect = (
  file: File,
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined,
  sides: number,
  paperBg: number,
  exportDisabled: boolean
) => {
  void openViewer(() => {
    store.isNewDrawing = false
    store.selectedUrl = null
    store.selectedFile = file
    applyOpenOptions(
      mode,
      mainThreadDraw,
      showNoPlotLayers,
      enableProgressiveRendering,
      viewMode,
      sides,
      paperBg,
      exportDisabled
    )
  })
}

const handleUrlSelect = (
  url: string,
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined,
  sides: number,
  paperBg: number,
  exportDisabled: boolean
) => {
  void openViewer(() => {
    store.isNewDrawing = false
    store.selectedFile = null
    store.selectedUrl = url
    applyOpenOptions(
      mode,
      mainThreadDraw,
      showNoPlotLayers,
      enableProgressiveRendering,
      viewMode,
      sides,
      paperBg,
      exportDisabled
    )
  })
}

const handleNewDrawing = (
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined,
  sides: number,
  paperBg: number,
  exportDisabled: boolean
) => {
  void openViewer(() => {
    store.selectedFile = null
    store.selectedUrl = null
    store.isNewDrawing = true
    applyOpenOptions(
      mode,
      mainThreadDraw,
      showNoPlotLayers,
      enableProgressiveRendering,
      viewMode,
      sides,
      paperBg,
      exportDisabled
    )
  })
}
</script>

<style scoped>
#app-root {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--ml-ui-bg-page, #141414);
}

.upload-screen {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: safe center;
  overflow-x: hidden;
  overflow-y: auto;
  margin: 0;
  padding: 16px;
  box-sizing: border-box;
  background: var(--ml-ui-bg-page, #141414);
  z-index: 1000;
  pointer-events: auto;
}
</style>
