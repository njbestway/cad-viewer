<template>
  <el-config-provider :size="'small'">
    <ml-tool-palette
      class="ml-layer-manager"
      :style="paletteStyle"
      v-model="store.dialogs.layerManager"
      :title="activeTabTitle"
      :left-offset="paletteOffsets.left"
      :right-offset="paletteOffsets.right"
      :top-offset="paletteOffsets.top"
      :bottom-offset="paletteOffsets.bottom"
    >
      <ml-overflow-tabs
        v-model="store.dialogs.activePaletteTab"
        :tabs="tabs"
      >
        <div
          v-if="store.dialogs.activePaletteTab === 'layerManager'"
          class="ml-layer-list-wrapper"
        >
          <ml-layer-list :editor="props.editor" />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'entityProperties'"
          class="ml-entity-properties-wrapper"
        >
          <ml-entity-properties
            :entity-props-list="properties"
            :entity-locked="propertyEntityLocked"
            :database="propertyDatabase"
            :layer-options="layerOptions"
            :editable="propertiesEditable"
            @update-property="handleUpdateProperty"
          />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'countList'"
          class="ml-count-list-wrapper"
        >
          <ml-count-list />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'find'"
          class="ml-find-palette-wrapper"
        >
          <ml-find-palette />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'designReview'"
          class="ml-design-review-wrapper"
        >
          <ml-design-review-palette />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'measurements'"
          class="ml-measurement-palette-wrapper"
        >
          <ml-measurement-palette />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'missingResources'"
          class="ml-missing-resources-wrapper"
        >
          <ml-missing-resources />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'memoryProfile'"
          class="ml-memory-profile-wrapper"
        >
          <ml-memory-profile />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'openFileProfile'"
          class="ml-open-file-profile-wrapper"
        >
          <ml-open-file-profile />
        </div>
        <div
          v-else-if="store.dialogs.activePaletteTab === 'blocks'"
          class="ml-blocks-palette-wrapper"
        >
          <ml-blocks-palette />
        </div>
        <div
          v-else-if="
            store.features.scriptPlugin &&
            store.dialogs.activePaletteTab === 'cadScript'
          "
          class="ml-script-palette-wrapper"
        >
          <ml-cad-script-panel />
        </div>
      </ml-overflow-tabs>
    </ml-tool-palette>
  </el-config-provider>
</template>

<script setup lang="ts">
import {
  AcApDocManager,
  AcApLayerService,
  acapRunDatabaseEdit,
  AcEdOpenMode
} from '@mlightcad/cad-simple-viewer'
import {
  type AcDbEntity,
  type AcDbEntityProperties,
  type AcDbEntityRuntimeProperty
} from '@mlightcad/data-model'
import {
  type MlOverflowTab,
  MlOverflowTabs,
  MlToolPalette
} from '@mlightcad/ui-components'
import { ElConfigProvider } from 'element-plus'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { store } from '../../app'
import {
  useDocument,
  useLayers,
  useSelectionSet,
  useViewerRect
} from '../../composable'
import { toolPaletteTabName, toolPaletteTitle } from '../../locale'
import MlBlocksPalette from './MlBlocksPalette.vue'
import MlCadScriptPanel from './MlCadScriptPanel.vue'
import MlCountList from './MlCountList.vue'
import MlDesignReviewPalette from './MlDesignReviewPalette.vue'
import MlEntityProperties from './MlEntityProperties.vue'
import MlFindPalette from './MlFindPalette.vue'
import MlLayerList from './MlLayerList.vue'
import MlMeasurementPalette from './MlMeasurementPalette.vue'
import MlMemoryProfile from './MlMemoryProfile.vue'
import MlMissingResources from './MlMissingResources.vue'
import MlOpenFileProfile from './MlOpenFileProfile.vue'

/**
 * Properties of palette manager component
 */
interface Props {
  /**
   * Current editor
   */
  editor: AcApDocManager
}

const props = defineProps<Props>()
const { t } = useI18n()
const containerRect = useViewerRect()

const DEFAULT_WIDTH = 520
const DEFAULT_HEIGHT = 500
const FLOATING_LEFT_OFFSET = 2
const FLOATING_TOP_OFFSET = 2

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max)
}

const paletteOffsets = computed(() => {
  const { top, left, width, height } = containerRect.value
  const right = left + width
  const bottom = top + height

  return {
    top,
    left,
    right: Math.max(0, window.innerWidth - right),
    bottom: Math.max(0, window.innerHeight - bottom)
  }
})

const paletteStyle = computed(() => {
  const { top, left, width, height } = containerRect.value
  const safeWidth = width > 0 ? width : DEFAULT_WIDTH
  const safeHeight = height > 0 ? height : DEFAULT_HEIGHT
  return {
    '--ml-palette-left': `${left + FLOATING_LEFT_OFFSET}px`,
    '--ml-palette-top': `${top + FLOATING_TOP_OFFSET}px`,
    '--ml-palette-width': `${Math.min(DEFAULT_WIDTH, safeWidth)}px`,
    '--ml-palette-height': `${Math.min(DEFAULT_HEIGHT, safeHeight)}px`,
    '--ml-palette-max-width': `${safeWidth}px`,
    '--ml-palette-max-height': `${safeHeight}px`
  }
})

const syncPaletteToContainer = () => {
  if (!store.dialogs.layerManager) return

  const paletteElement =
    document.querySelector<HTMLElement>('.ml-layer-manager')
  if (!paletteElement) return

  const {
    top,
    left,
    width: containerWidth,
    height: containerHeight
  } = containerRect.value
  if (containerWidth <= 0 || containerHeight <= 0) return

  const right = left + containerWidth
  const bottom = top + containerHeight
  const rect = paletteElement.getBoundingClientRect()
  const width = Math.min(rect.width || DEFAULT_WIDTH, containerWidth)
  const height = Math.min(rect.height || DEFAULT_HEIGHT, containerHeight)
  const isDockedLeft = rect.left <= left + 1
  const isDockedRight = rect.right >= right - 1
  // Geometric proximity alone is not enough: a floating palette sits only a
  // couple of pixels inside the viewer edge. Only stretch when already at
  // docked (full) height so Undock cannot be overwritten back to full-size.
  const isSideDocked =
    (isDockedLeft || isDockedRight) && height >= containerHeight - 1

  const nextLeft = isDockedLeft
    ? left
    : isDockedRight
      ? Math.max(left, right - width)
      : clamp(rect.left, left, Math.max(left, right - width))
  const nextTop = isSideDocked
    ? top
    : clamp(rect.top, top, Math.max(top, bottom - height))
  const nextHeight = isSideDocked ? containerHeight : height

  paletteElement.style.left = `${nextLeft}px`
  paletteElement.style.top = `${nextTop}px`
  paletteElement.style.width = `${width}px`
  paletteElement.style.height = `${nextHeight}px`
  paletteElement.style.maxHeight = `${containerHeight}px`
  paletteElement.style.maxWidth = `${containerWidth}px`
}

const baseTabNames = [
  'layerManager',
  'entityProperties',
  'countList',
  'find',
  'designReview',
  'measurements',
  'blocks',
  'missingResources',
  'memoryProfile'
] as const
const tabNames = computed((): readonly string[] => {
  const names: string[] = [...baseTabNames]
  // Revealed by OPENPERF only — keep out of the default palette chrome.
  if (store.dialogs.openFileProfileTabVisible) {
    names.push('openFileProfile')
  }
  if (store.features.scriptPlugin) {
    names.push('cadScript')
  }
  return names
})

const tabs = computed<MlOverflowTab[]>(() => {
  return tabNames.value.map(name => {
    return {
      name,
      label:
        name === 'cadScript'
          ? t('main.toolPalette.script.scriptTab')
          : toolPaletteTabName(name)
    }
  })
})

const activeTabTitle = computed(() => {
  if (store.dialogs.activePaletteTab === 'cadScript') {
    return t('main.toolPalette.script.scriptTitle')
  }
  return toolPaletteTitle(store.dialogs.activePaletteTab)
})

watch(
  [() => store.dialogs.activePaletteTab, tabNames],
  ([activeTab, names]) => {
    if (!names.includes(activeTab)) {
      store.dialogs.activePaletteTab = names[0]
    }
  },
  { immediate: true }
)

watch(
  () => [containerRect.value, store.dialogs.layerManager],
  async () => {
    await nextTick()
    syncPaletteToContainer()
  },
  { immediate: true, deep: true }
)

const { selectionSet } = useSelectionSet()
const { openMode: docOpenMode } = useDocument()
const { layers } = useLayers(AcApDocManager.instance)
/**
 * Bumped after every panel edit so `propertyRows` recomputes and the
 * controlled dropdowns (layer / linetype / lineweight) re-read the freshly
 * written database values instead of snapping back to the pre-edit state.
 */
const propertyRefreshTick = ref(0)
/**
 * The entity-properties panel only renders editable controls when the active
 * document is opened in Write mode; `MlEntityProperties` hides every editor
 * (falling back to read-only text) when `editable` is false. Property writes
 * go through `openEntityForWrite`, which requires Write mode, so gate the
 * editors on it too.
 */
const propertiesEditable = computed(
  () => docOpenMode.value === AcEdOpenMode.Write
)

/**
 * A lightweight polyline vertex as stored in the data model's `vertices`
 * accessor. Position lives on `x`/`y`; each vertex carries a `startWidth` and
 * `endWidth` (both `undefined` when the segment is hairline). There is no
 * separate constant-width field: a "global width" is just every vertex sharing
 * the same start and end width (DXF group 43).
 */
interface MlPolylineVertex {
  x: number
  y: number
  bulge?: number
  startWidth?: number
  endWidth?: number
}

/**
 * Reads the live vertex array of a polyline entity through its public
 * `geometry.vertices` accessor (no private field access), so the panel and the
 * write path can mutate the exact objects the entity serializes from.
 */
function polylineVerticesOf(entity: AcDbEntity): MlPolylineVertex[] | undefined {
  const verticesProp = entity.properties?.groups
    ?.find(group => group.groupName === 'geometry')
    ?.properties.find(item => item.name === 'vertices')
  const arr = verticesProp?.accessor.get()
  return Array.isArray(arr) ? (arr as MlPolylineVertex[]) : undefined
}

/**
 * The single constant width shared by every vertex, or `undefined` when widths
 * vary per vertex (mirrors the data model's `resolveConstantWidth`).
 */
function constantWidthOf(
  vertices?: MlPolylineVertex[]
): number | undefined {
  if (!vertices?.length) return undefined
  let common: number | undefined
  for (const vertex of vertices) {
    const start = vertex.startWidth ?? 0
    const end = vertex.endWidth ?? 0
    if (start !== end) return undefined
    if (common === undefined) common = start
    else if (common !== start) return undefined
  }
  return common
}

/**
 * Adds the polyline-only vertex-width controls the data model does not expose:
 * per-vertex `startWidth`/`endWidth` on the `vertices` array, and a scalar
 * `globalWidth` (constant width) in the `others` group. `entity.properties`
 * returns a freshly built object each call, so these additions never
 * accumulate across recomputes.
 */
function augmentPolylineProperties(
  entity: AcDbEntity
): AcDbEntityProperties {
  const props = entity.properties
  if (props.type !== 'Polyline') return props

  const verticesProp = props.groups
    .find(group => group.groupName === 'geometry')
    ?.properties.find(item => item.name === 'vertices')
  const schema = verticesProp?.itemSchema
  if (schema) {
    for (const name of ['startWidth', 'endWidth']) {
      if (!schema.properties.some(item => item.name === name)) {
        schema.properties.push({ name, type: 'float', editable: true })
      }
    }
  }

  const others = props.groups.find(group => group.groupName === 'others')
  if (others && !others.properties.some(item => item.name === 'globalWidth')) {
    const globalWidth: AcDbEntityRuntimeProperty = {
      name: 'globalWidth',
      type: 'float',
      editable: true,
      accessor: {
        get: () => constantWidthOf(polylineVerticesOf(entity))
      }
    }
    others.properties.unshift(globalWidth)
  }

  return props
}

const propertyRows = computed(() => {
  propertyRefreshTick.value
  const list: AcDbEntityProperties[] = []
  const locked: boolean[] = []
  const db = AcApDocManager.instance.curDocument?.database
  if (!db) return { list, locked }
  const blockTable = db.tables.blockTable
  for (const id of selectionSet.value) {
    // Use getEntityById which works for entities in any layout (model space or paper space)
    const entity = blockTable.getEntityById(id)
    if (!entity) continue
    list.push(augmentPolylineProperties(entity))
    locked.push(AcApLayerService.isEntityOnLockedLayer(db, entity))
  }
  return { list, locked }
})
const properties = computed(() => propertyRows.value.list)
const propertyEntityLocked = computed(() => propertyRows.value.locked)
const propertyDatabase = computed(
  () => AcApDocManager.instance.curDocument?.database ?? null
)
const layerOptions = computed(() =>
  layers.map(layer => ({
    value: layer.name,
    name: layer.name,
    cssColor: layer.cssColor || '#7b8794',
    isOn: layer.isOn,
    isLocked: layer.isLocked,
    isFrozen: layer.isFrozen,
    lineType: layer.linetype
  }))
)

/**
 * Writes a property edited in the entity-properties panel back to every
 * selected entity, inside a single undo group, and repaints through the
 * database's entityModified event (bound to `view.updateEntity`).
 *
 * Mirrors the ribbon property dropdown edit path (`acapRunDatabaseEdit` +
 * `openEntityForWrite`) so locked layers are skipped and undo captures the
 * before-state. The child panel emits only the descriptor coordinates
 * (groupName + propertyName); the actual mutation goes through the
 * write-opened entity's own property accessor so it participates in undo.
 */
function handleUpdateProperty(payload: {
  groupName: string
  propertyName: string
  newValue: unknown
  arrayItemName?: string
  arrayItemIndex?: number
}) {
  const db = AcApDocManager.instance.curDocument?.database
  if (!db) return

  const ids = [...selectionSet.value]
  if (ids.length === 0) return

  acapRunDatabaseEdit(db, 'Property', () => {
    for (const id of ids) {
      const existing = db.tables.blockTable.getEntityById(id)
      if (existing && AcApLayerService.isEntityOnLockedLayer(db, existing)) {
        continue
      }
      const entity = db.openEntityForWrite(id)
      if (!entity || AcApLayerService.isEntityOnLockedLayer(db, entity)) {
        continue
      }

      // Polyline vertex widths are not exposed as runtime properties by the
      // data model, so route them onto the live vertex array read through the
      // write-opened entity's own `vertices` accessor (same objects the entity
      // serializes from, so the edit persists with the transaction and undo).
      if (entity.properties?.type === 'Polyline') {
        if (
          payload.arrayItemName === 'vertices' &&
          payload.arrayItemIndex != null
        ) {
          const vertex = polylineVerticesOf(entity)?.[payload.arrayItemIndex]
          if (vertex) {
            ;(vertex as unknown as Record<string, unknown>)[
              payload.propertyName
            ] = payload.newValue
          }
          continue
        }
        if (
          payload.groupName === 'others' &&
          payload.propertyName === 'globalWidth'
        ) {
          const parsed = Number(payload.newValue)
          const width = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
          for (const vertex of polylineVerticesOf(entity) ?? []) {
            vertex.startWidth = width
            vertex.endWidth = width
          }
          continue
        }
      }

      const property = entity.properties?.groups
        ?.find(group => group.groupName === payload.groupName)
        ?.properties.find(item => item.name === payload.propertyName)
      property?.accessor?.set?.(payload.newValue)
    }
  })

  propertyRefreshTick.value++
}
</script>

<style scoped>
.ml-layer-manager {
  left: var(--ml-palette-left);
  top: var(--ml-palette-top);
  width: var(--ml-palette-width);
  height: var(--ml-palette-height);
  max-width: var(--ml-palette-max-width);
  max-height: var(--ml-palette-max-height);
  z-index: 7;
}

.ml-layer-list-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-entity-properties-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ml-count-list-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-find-palette-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-design-review-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-measurement-palette-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-missing-resources-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-memory-profile-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-open-file-profile-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-blocks-palette-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ml-script-palette-wrapper {
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
