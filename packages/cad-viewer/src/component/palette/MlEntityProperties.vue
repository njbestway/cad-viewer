<template>
  <div class="ml-entity-properties">
    <!-- Dropdown for multiple entities -->
    <div
      v-if="entityPropsList && entityPropsList.length > 0"
      class="ml-entity-selector"
    >
      <el-select
        v-model="selectedIndex"
        placeholder="Select Entity"
        style="width: 100%; margin-bottom: 0.5rem"
      >
        <el-option
          :label="
            t(
              'main.toolPalette.entityProperties.propertyPanel.multipleEntitySelected',
              { count: entityPropsList.length }
            )
          "
          :value="-1"
        />
        <el-option
          v-for="(item, idx) in entityPropsList"
          :key="idx"
          :label="formatEntityOptionLabel(item as AcDbEntityProperties)"
          :value="idx"
        />
      </el-select>
    </div>

    <!-- Properties Table -->
    <el-table
      v-if="tableRows.length"
      :data="tableRows"
      row-key="id"
      border
      default-expand-all
      :tree-props="{ children: 'children', hasChildren: 'children' }"
      :show-header="false"
      :span-method="spanMethod"
      class="ml-entity-properties-table"
    >
      <!-- Label -->
      <el-table-column
        prop="name"
        :show-overflow-tooltip="{ placement: 'top-start', showAfter: 2000 }"
      >
        <template #default="{ row }">
          <div class="ml-cell-container">
            <div :class="['ml-cell-label', { 'ml-group-row': row.isGroup }]">
              <strong v-if="row.isGroup">{{ entityPropName(row.name) }}</strong>
              <span v-else>{{ getPropertyName(row as MlDisplayPropertyRow) }}</span>
            </div>
          </div>
        </template>
      </el-table-column>

      <!-- Value -->
      <el-table-column>
        <template #default="{ row }">
          <div class="ml-cell-value" v-if="!row.isGroup">
            <!-- ===== Readonly ===== -->
            <template
              v-if="
                editsLocked ||
                (!row.__isArrayIndex && (!editable || !row.editable))
              "
            >
              <ml-color-dropdown
                v-if="row.type === 'color'"
                :model-value="row.accessor.get()"
                :display-color="resolveColorDisplay(row.accessor.get())"
                disabled
              />
              <span
                v-else
                :title="formatDisplayValue(row as MlDisplayPropertyRow)"
                class="ml-readonly-value"
                @dblclick="copyReadonlyValue(row as MlDisplayPropertyRow)"
              >
                {{ formatDisplayValue(row as MlDisplayPropertyRow) }}
              </span>
            </template>

            <!-- ===== Editable ===== -->
            <template v-else>
              <ml-hatch-pattern-dropdown
                v-if="isHatchPatternField(row as MlDisplayPropertyRow)"
                :model-value="String(row.accessor.get() ?? '')"
                @update:modelValue="
                  (v: string) => {
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                  }
                "
              />

              <el-select
                v-else-if="row.type === 'enum'"
                :model-value="row.accessor.get()"
                @change="
                  (v: string | number) =>
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              >
                <el-option
                  v-for="opt in row.options || []"
                  :key="opt.value"
                  :label="entityPropEnum(opt.label)"
                  :value="opt.value"
                />
              </el-select>

              <ml-color-dropdown
                v-else-if="row.type === 'color'"
                :model-value="row.accessor.get()"
                :display-color="resolveColorDisplay(row.accessor.get())"
                @update:model-value="
                  (v: AcCmColor | undefined) =>
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />

              <ml-layer-select
                v-else-if="isLayerField(row as MlDisplayPropertyRow)"
                :model-value="String(row.accessor.get() ?? '')"
                :options="layerOptions ?? []"
                @update:model-value="
                  (v: string) => onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />

              <ml-line-type-select
                v-else-if="row.type === 'linetype'"
                :model-value="String(row.accessor.get() ?? '')"
                @update:model-value="
                  (v: string) => onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />

              <ml-line-weight-select
                v-else-if="row.type === 'lineweight'"
                :model-value="row.accessor.get() as AcGiLineWeight"
                @update:model-value="
                  (v: AcGiLineWeight) =>
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />

              <el-select
                v-else-if="isTransparencyField(row as MlDisplayPropertyRow)"
                :model-value="
                  transparencyOptionValue(row.accessor.get() as AcCmTransparency)
                "
                @change="
                  (v: string) =>
                    onTransparencyChange(row as MlDisplayPropertyRow, v)
                "
              >
                <el-option label="ByLayer" value="ByLayer" />
                <el-option label="ByBlock" value="ByBlock" />
              </el-select>

              <el-input-number
                v-else-if="isElevationField(row as MlDisplayPropertyRow)"
                :controls="false"
                :model-value="row.accessor.get()"
                :step="0.1"
                @change="
                  (v: number | undefined) => {
                    if (v != null) {
                      onPropertyChange(row as MlDisplayPropertyRow, v)
                    }
                  }
                "
              />

              <el-input-number
                v-else-if="isLinetypeScaleField(row as MlDisplayPropertyRow)"
                :controls="false"
                :model-value="row.accessor.get()"
                :step="0.1"
                @change="
                  (v: number | undefined) => {
                    if (v != null) {
                      onPropertyChange(row as MlDisplayPropertyRow, v)
                    }
                  }
                "
              />

              <el-select
                v-else-if="isBooleanChoiceField(row as MlDisplayPropertyRow)"
                :model-value="row.accessor.get()"
                @change="
                  (v: boolean) =>
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              >
                <el-option :label="entityPropEnum('Yes')" :value="true" />
                <el-option :label="entityPropEnum('No')" :value="false" />
              </el-select>

              <el-input-number
                v-else-if="row.type === 'int'"
                controls-position="right"
                :model-value="row.accessor.get()"
                :min="row.__min"
                :max="row.__max"
                :step="1"
                :precision="0"
                @change="
                  (v: number | undefined) => {
                    if (row.__isArrayIndex) {
                      if (!editsLocked) row.accessor.set?.(v)
                    } else {
                      onPropertyChange(row as MlDisplayPropertyRow, v)
                    }
                  }
                "
              />

              <el-input-number
                v-else-if="row.type === 'float'"
                controls-position="right"
                :model-value="row.accessor.get()"
                :step="0.1"
                :precision="3"
                @change="
                  (v: number | undefined) =>
                    onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />

              <el-input
                v-else
                :model-value="row.accessor.get()"
                @input="
                  (v: string) => onPropertyChange(row as MlDisplayPropertyRow, v)
                "
              />
            </template>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <div v-else class="ml-no-entity-selected">
      {{
        t('main.toolPalette.entityProperties.propertyPanel.noEntitySelected')
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  AcCmColor,
  AcCmTransparency,
  AcDbDatabase,
  AcDbEntityProperties,
  AcDbEntityPropertyGroup,
  AcDbEntityRuntimeProperty,
  AcGiLineWeight,
  log
} from '@mlightcad/data-model'
import {
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn
} from 'element-plus'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { entityPropEnum, entityPropName } from '../../locale'
import { MlColorDropdown, MlHatchPatternDropdown, MlLayerSelect, MlLineTypeSelect, MlLineWeightSelect } from '../common'

const { t } = useI18n()

/* ================= props / emits ================= */

/**
 * Layer entry consumed by {@link MlLayerSelect} for the layer property row.
 * Structurally matches the option shape the select component expects.
 */
interface MlLayerOption {
  value: string
  name: string
  cssColor: string
  isOn: boolean
  isLocked: boolean
  isFrozen: boolean
  lineType?: string
}

const props = defineProps<{
  entityPropsList?: AcDbEntityProperties[] | null
  editable?: boolean
  /**
   * Lock state aligned with `entityPropsList`.
   * The common row is read-only when any entry is locked. A single entity row
   * follows that entity.
   */
  entityLocked?: boolean[]
  /**
   * Active document database, used to resolve ByLayer colors into the
   * concrete layer swatch shown in the color dropdown. Optional so the panel
   * still renders (falling back to the neutral placeholder) when unavailable.
   */
  database?: AcDbDatabase | null
  /**
   * Render-ready layer entries for the layer dropdown, supplied by the host
   * (which owns the reactive layer list). Optional so the row falls back to a
   * plain text editor when unavailable.
   */
  layerOptions?: MlLayerOption[]
}>()

const emit = defineEmits<{
  (
    e: 'update-property',
    payload: {
      groupName: string
      propertyName: string
      newValue: unknown
    }
  ): void
}>()

/* ================= state ================= */

const selectedIndex = ref(-1)
const arrayIndexMap = ref<Record<string, number>>({})

/**
 * 🔑 Forces rebuild of array property rows
 */
const arrayRebuildVersion = ref(0)

const editsLocked = computed(() => {
  const flags = props.entityLocked
  if (!flags?.length) return false
  const count = props.entityPropsList?.length ?? 0
  if (count <= 1) return !!flags[0]
  if (selectedIndex.value >= 0) return !!flags[selectedIndex.value]
  return flags.some(Boolean)
})

const activeEntityProperties = computed<AcDbEntityProperties | null>(() => {
  const list = props.entityPropsList
  if (!list?.length) return null

  return list.length === 1
    ? list[0]
    : selectedIndex.value >= 0
      ? list[selectedIndex.value]
      : findCommonProperties(list)
})

/* ================= row types ================= */

interface MlDisplayRowBase {
  id: string
  name: string
  isGroup: boolean
}

type MlDisplayPropertyRow = MlDisplayRowBase &
  AcDbEntityRuntimeProperty & {
    __groupName?: string
    __min?: number
    __max?: number
    __isArrayIndex?: boolean
  }

type MlDisplayGroupRow = MlDisplayRowBase & {
  isGroup: true
  children: MlDisplayPropertyRow[]
}

type MlDisplayRow = MlDisplayGroupRow | MlDisplayPropertyRow

/* ================= helpers ================= */

/**
 * Label for an entity in the top selector: the entity type with its handle
 * merged in, e.g. `Polyline(1058E9)`. The handle is read from the `general`
 * group (the table no longer shows it as its own row). Falls back to the bare
 * type when the handle is unavailable.
 */
function formatEntityOptionLabel(entity: AcDbEntityProperties): string {
  if (entity == null) return ''
  const handle = entity.groups
    .find(group => group.groupName === 'general')
    ?.properties.find(item => item.name === 'handle')?.accessor.get()
  const text = handle != null ? String(handle) : ''
  return text ? `${entity.type}(${text})` : entity.type
}

function isArrayProperty(p: AcDbEntityRuntimeProperty): boolean {
  return p.type === 'array' && !!p.itemSchema
}

function arrayKey(group: string, prop: string) {
  return `${group}.${prop}`
}

/* ================= formatting ================= */

function getPropertyName(row: MlDisplayPropertyRow): string {
  // Element Plus evaluates every `el-table-column` default slot once with a
  // dummy scope (`{ row: {}, column: {}, $index: -1 }`) while collecting
  // nested columns; ignore that placeholder row.
  if (row == null || row.name == null) return ''
  return row.skipTranslation ? row.name : entityPropName(row.name)
}

function formatDisplayValue(row: MlDisplayPropertyRow): string {
  // Placeholder row from el-table-column collection (see getPropertyName).
  if (row == null || row.accessor == null) return ''
  const v = row.accessor.get()
  if (typeof v === 'boolean') {
    return entityPropEnum(v ? 'Yes' : 'No')
  }
  switch (row.type) {
    case 'enum':
      return entityPropEnum(row.options?.find(o => o.value === v)?.label ?? '')
    case 'color':
      return (v as AcCmColor).toString()
    case 'lineweight':
      return AcGiLineWeight[v as number]
    case 'transparency':
      return (v as AcCmTransparency).toString()
    case 'float':
      // Read-only computed statistics (diameter / perimeter / area, lengths,
      // ...) carry raw double precision; show two decimals like CAD palettes.
      return typeof v === 'number' && Number.isFinite(v)
        ? v.toFixed(2)
        : v != null
          ? String(v)
          : ''
    default:
      return v != null ? String(v) : ''
  }
}

async function copyReadonlyValue(row: MlDisplayPropertyRow) {
  const value = formatDisplayValue(row)

  try {
    await navigator.clipboard.writeText(value)
    ElMessage({
      message: t(
        'main.toolPalette.entityProperties.propertyPanel.propValCopied'
      ),
      grouping: true,
      type: 'success'
    })
  } catch (e) {
    log.error(e)
    ElMessage({
      message: t(
        'main.toolPalette.entityProperties.propertyPanel.failedToCopyPropVal'
      ),
      grouping: true,
      type: 'error'
    })
  }
}

/* ================= color display ================= */

/**
 * Layer name of the entity currently shown in the table, used to resolve
 * ByLayer colors. Returns undefined for merged multi-entity views where the
 * layer differs across the selection.
 */
function activeLayerName(): string | undefined {
  const layerProp = activeEntityProperties.value?.groups
    .find(group => group.groupName === 'general')
    ?.properties.find(item => item.name === 'layer')
  const value = layerProp?.accessor.get()
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolves the concrete swatch color shown next to a color property. A
 * ByLayer color has no intrinsic RGB, so it is resolved through the entity's
 * layer (mirrors the ribbon property dropdown); ByBlock and unresolved layers
 * fall back to the neutral placeholders used across the UI.
 */
function resolveColorDisplay(color?: AcCmColor): string {
  if (!color) return ''
  if (color.isByLayer) {
    const layerName = activeLayerName()
    const layerColor = layerName
      ? props.database?.tables.layerTable.getAt(layerName)?.color
      : undefined
    return layerColor?.cssColor || '#7b8794'
  }
  if (color.isByBlock) return '#a0a8b8'
  return color.cssColor || '#7b8794'
}

/* ================= rows ================= */

const tableRows = computed<MlDisplayRow[]>(() => {
  // 🔑 dependency to force rebuild when array index changes
  arrayRebuildVersion.value

  const entity = activeEntityProperties.value
  if (!entity) return []
  return expandEntity(entity)
})

function isHatchPatternField(row: MlDisplayPropertyRow) {
  if (row.__isArrayIndex) return false
  if (activeEntityProperties.value?.type.toLowerCase() !== 'hatch') return false
  const propertyName = row.name.toLowerCase()
  return propertyName === 'patternname' || propertyName === 'pattern'
}

/**
 * The `layer` general property is edited through the layer dropdown instead
 * of a free-text box.
 */
function isLayerField(row: MlDisplayPropertyRow) {
  return row.type === 'string' && row.name === 'layer'
}

/**
 * `linetypeScale` is shown as a plain numeric text box (no spinner) that only
 * accepts valid decimal values, unlike the other float geometry fields.
 */
function isLinetypeScaleField(row: MlDisplayPropertyRow) {
  return row.type === 'float' && row.name === 'linetypeScale'
}

/**
 * `elevation` is a geometry distance that should accept decimals, so it uses a
 * plain numeric box (no spinner) like `linetypeScale` rather than the generic
 * float editor.
 */
function isElevationField(row: MlDisplayPropertyRow) {
  return row.type === 'float' && row.name === 'elevation'
}

/**
 * Transparency only exposes the ByLayer / ByBlock inheritance modes here, so
 * it is edited through a dropdown instead of the free-text box it would
 * otherwise fall into. By-alpha values map to no option (empty selection).
 */
function isTransparencyField(row: MlDisplayPropertyRow) {
  return !row.__isArrayIndex && row.type === 'transparency'
}

function transparencyOptionValue(t?: AcCmTransparency): string {
  if (!t) return 'ByLayer'
  if (t.isByLayer) return 'ByLayer'
  if (t.isByBlock) return 'ByBlock'
  return ''
}

function onTransparencyChange(row: MlDisplayPropertyRow, method: string) {
  onPropertyChange(row, AcCmTransparency.fromString(method))
}

/**
 * Whether the row is a boolean choice rendered as a Yes/No dropdown. Besides
 * real `boolean` properties, the data model mislabels some boolean flags (for
 * example the polyline `closed` flag) as `float` while their accessor still
 * get/sets a boolean, so detect those by the returned value type.
 */
function isBooleanChoiceField(row: MlDisplayPropertyRow): boolean {
  if (row.__isArrayIndex) return false
  return row.type === 'boolean' || typeof row.accessor.get() === 'boolean'
}

function expandEntity(entity: AcDbEntityProperties): MlDisplayRow[] {
  return entity.groups.map((group, gi) => {
    const children: MlDisplayPropertyRow[] = []

    group.properties.forEach((prop, pi) => {
      // The handle is an internal identifier with little editing value; it is
      // surfaced in the entity selector at the top (type + handle) instead of
      // occupying a table row.
      if (group.groupName === 'general' && prop.name === 'handle') return

      if (!isArrayProperty(prop)) {
        children.push({
          ...prop,
          id: `g-${gi}-p-${pi}`,
          isGroup: false,
          __groupName: group.groupName
        })
        return
      }

      const arr = prop.accessor.get() as unknown[]
      const key = arrayKey(group.groupName, prop.name)

      if (!arrayIndexMap.value[key]) arrayIndexMap.value[key] = 1

      arrayIndexMap.value[key] = Math.min(
        Math.max(1, arrayIndexMap.value[key]),
        arr.length
      )

      /* ===== index row (always editable) ===== */
      children.push({
        id: `g-${gi}-p-${pi}-index`,
        name: prop.name,
        type: 'int',
        editable: true,
        isGroup: false,
        __groupName: group.groupName,
        __isArrayIndex: true,
        __min: 1,
        __max: arr.length,
        accessor: {
          get: () => arrayIndexMap.value[key],
          set: (v: number) => {
            const newIndex = Math.min(Math.max(1, v), arr.length)
            if (arrayIndexMap.value[key] !== newIndex) {
              arrayIndexMap.value[key] = newIndex
              arrayRebuildVersion.value++ // 🔥 force rebuild
            }
          }
        }
      } as MlDisplayPropertyRow)

      const element = arr[arrayIndexMap.value[key] - 1] as Record<
        string,
        unknown
      >
      if (!element) return

      /* ===== element property rows ===== */
      if (prop.itemSchema) {
        for (const itemProp of prop.itemSchema.properties) {
          children.push({
            id: `g-${gi}-p-${pi}-${itemProp.name}`,
            name: itemProp.name,
            type: itemProp.type,
            editable: itemProp.editable,
            isGroup: false,
            __groupName: group.groupName,
            accessor: {
              get: () => element[itemProp.name],
              set: (v: unknown) => {
                element[itemProp.name] = v
              }
            }
          })
        }
      }
    })

    return {
      id: `group-${gi}`,
      name: group.groupName,
      isGroup: true,
      children
    }
  })
}

/* ================= common props ================= */

function findCommonProperties(
  list: AcDbEntityProperties[]
): AcDbEntityProperties {
  const first = list[0]
  const groups: AcDbEntityPropertyGroup[] = []

  for (const g of first.groups) {
    const props: AcDbEntityRuntimeProperty[] = []

    for (const p of g.properties) {
      if (
        list.every(ent => {
          const gp = ent.groups
            .find(x => x.groupName === g.groupName)
            ?.properties.find(x => x.name === p.name)
          return gp && gp.accessor.get() === p.accessor.get()
        })
      ) {
        props.push(p)
      }
    }

    if (props.length) groups.push({ groupName: g.groupName, properties: props })
  }

  return { type: first.type, groups }
}

/**
 * span-method for group rows
 */
const spanMethod = ({
  row,
  columnIndex
}: {
  row: MlDisplayRow
  columnIndex: number
}) => {
  if (row.isGroup) {
    return columnIndex === 0 ? [1, 2] : [0, 0]
  }
  return [1, 1]
}

/**
 * Handle property change (direct call to accessor.set)
 */
function onPropertyChange(row: MlDisplayPropertyRow, newValue: unknown) {
  if (editsLocked.value || row.__isArrayIndex) return

  emit('update-property', {
    groupName: row.__groupName ?? '',
    propertyName: row.name,
    newValue
  })
}
</script>

<style scoped>
::v-deep(.el-table__placeholder) {
  width: 0px;
}

::v-deep(.el-table .cell) {
  display: flex;
}

::v-deep(.ml-cell-value > *) {
  width: 100%;
}

.ml-entity-properties {
  padding: 5px;
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
}

.ml-entity-properties-table {
  width: 100%;
  max-width: 100%;
}

.ml-entity-properties-table ::v-deep(.el-scrollbar__wrap) {
  overflow-x: hidden;
}

.ml-entity-properties-table ::v-deep(.el-scrollbar__bar.is-horizontal) {
  display: none;
}

.ml-cell-container {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  line-height: 1;
}

.ml-cell-label {
  font-weight: normal;
  width: 100%;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-group-row {
  font-weight: 600;
}

.ml-cell-value {
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-readonly-value {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-no-entity-selected {
  display: flex;
  justify-content: center;
  align-items: center;
  text-align: center;
  font-style: italic;
  font-size: 0.875rem;
  padding: 0.5rem;
}
</style>
