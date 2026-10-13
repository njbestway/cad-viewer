import {
  AcCmColor,
  AcCmTransparency,
  accmYieldForPaint,
  accmYieldToUi,
  AcDb2dPolyline,
  AcDb3dPolyline,
  AcDb3PointAngularDimension,
  AcDbAlignedDimension,
  AcDbArc,
  AcDbArcDimension,
  AcDbAttribute,
  AcDbAttributeDefinition,
  AcDbBlockReference,
  AcDbBlockScaling,
  AcDbBlockTableRecord,
  AcDbBlockTableRecordFlag,
  AcDbCircle,
  type AcDbClass,
  type AcDbConversionProgressCallback,
  type AcDbDatabase,
  AcDbDatabaseConverter,
  type AcDbDatabaseConverterReadOptions,
  AcDbDiametricDimension,
  type AcDbDictionary,
  AcDbDimension,
  AcDbDimStyleTableRecord,
  AcDbDimTextHorizontal,
  AcDbDimTextVertical,
  AcDbDimVerticalJustification,
  AcDbDimZeroSuppression,
  AcDbDimZeroSuppressionAngular,
  type AcDbDxfCode,
  AcDbEllipse,
  AcDbEntity,
  AcDbGroup,
  AcDbHatch,
  AcDbHatchPatternType,
  AcDbHatchStyle,
  AcDbLayerTableRecord,
  AcDbLayout,
  AcDbLeader,
  AcDbLeaderAnnotationType,
  AcDbLine,
  AcDbLineSpacingStyle,
  AcDbLinetypeTableRecord,
  AcDbMLeader,
  AcDbMLeaderContentType,
  AcDbMLeaderLineType,
  AcDbMLeaderStyle,
  AcDbMLine,
  AcDbMLineJustification,
  AcDbMlineStyle,
  AcDbMText,
  type AcDbObject,
  AcDbOle2Frame,
  AcDbOleObjectType,
  AcDbOrdinateDimension,
  type AcDbParsingTaskStats,
  type AcDbPlotPaperUnits,
  type AcDbPlotRotation,
  type AcDbPlotShadePlotResLevel,
  type AcDbPlotShadePlotType,
  type AcDbPlotStdScaleType,
  type AcDbPlotType,
  AcDbPoint,
  AcDbPoly2dType,
  AcDbPoly3dType,
  AcDbPolyline,
  AcDbRadialDimension,
  AcDbResultBuffer,
  AcDbRotatedDimension,
  AcDbSolid,
  AcDbSpline,
  AcDbTable,
  AcDbText,
  AcDbTextHorizontalMode,
  AcDbTextStyleTableRecord,
  AcDbTextVerticalMode,
  type AcDbTypedValue,
  AcDbViewportTableRecord,
  AcDbXrecord,
  type AcGeBoundaryEdgeType,
  AcGeBox2d,
  AcGeBox3d,
  AcGeCircArc2d,
  AcGeEllipseArc2d,
  AcGeLine2d,
  AcGeLoop2d,
  AcGePoint2d,
  AcGePoint3d,
  AcGePolyline2d,
  AcGeSpline3d,
  AcGeVector3d,
  AcGiLineWeight,
  AcGiMTextAttachmentPoint,
  AcGiMTextFlowDirection,
  AcGiOrthographicType} from '@mlightcad/data-model'

import {
  type AcadRustDocumentClient,
  AcadRustWorkerDocumentClient
} from './AcadRustSectionClient'
import type { AcDbAcadRustConverterConfig } from './AcDbAcadRustConverter'
import {
  type AcadRustArcPayload,
  type AcadRustAttachmentPoint,
  type AcadRustAttribute,
  type AcadRustAttributeDefinitionPayload,
  type AcadRustBlockRecord,
  type AcadRustBlockRecordFlags,
  type AcadRustBlockRecordTable,
  type AcadRustCirclePayload,
  type AcadRustClass,
  type AcadRustClassTable,
  type AcadRustColor,
  type AcadRustDictionary,
  type AcadRustDimensionAngularPayload,
  type AcadRustDimensionBase,
  type AcadRustDimensionType,
  type AcadRustDimensionVariants,
  type AcadRustDimStyle,
  type AcadRustDimStyleTable,
  type AcadRustDrawingDirection,
  type AcadRustEllipsePayload,
  type AcadRustEntity,
  type AcadRustEntityCommon,
  acadRustEntityKind,
  type AcadRustGroup,
  type AcadRustHatchBoundaryEdge,
  type AcadRustHatchBoundaryPath,
  type AcadRustHatchCircularArcEdge,
  type AcadRustHatchEllipticArcEdge,
  type AcadRustHatchLineEdge,
  type AcadRustHatchPayload,
  type AcadRustHatchPolylineEdge,
  type AcadRustHatchSplineEdge,
  type AcadRustHeader,
  type AcadRustInsertPayload,
  type AcadRustLayer,
  type AcadRustLayerFlags,
  type AcadRustLayerTable,
  type AcadRustLayout,
  type AcadRustLeaderPayload,
  type AcadRustLinePayload,
  type AcadRustLineSpacingStyle,
  type AcadRustLineType,
  type AcadRustLineTypeTable,
  type AcadRustLineWeight,
  type AcadRustLwPolylinePayload,
  type AcadRustMeta,
  type AcadRustMLinePayload,
  type AcadRustMLineStyle,
  type AcadRustMTextPayload,
  type AcadRustMultiLeaderPayload,
  type AcadRustMultiLeaderStyle,
  type AcadRustObjects,
  type AcadRustOle2FramePayload,
  type AcadRustPoint3d,
  type AcadRustPointPayload,
  type AcadRustPolyline2DPayload,
  type AcadRustPolyline3DPayload,
  type AcadRustPolylinePayload,
  type AcadRustResultBufferValue,
  type AcadRustSolidPayload,
  type AcadRustSplinePayload,
  type AcadRustTableCellPayload,
  type AcadRustTablePayload,
  type AcadRustTextHorizontalAlignment,
  type AcadRustTextPayload,
  type AcadRustTextStyle,
  type AcadRustTextStyleTable,
  type AcadRustTextVerticalAlignment,
  type AcadRustTransparency,
  type AcadRustVport,
  type AcadRustVportTable,
  type AcadRustXRecord} from './model/acadrust-model'

/** Canonical deployed worker filename (kept in sync with `AcDbAcadRustConverter`). */
const WORKER_FILE = 'acad-rust-parser-worker.js'

/**
 * Progress weights for the native (Architecture-B) path, mirroring
 * `AcDbNativeDxfConverter` so the open-file status bar advances identically.
 */
const PARSE_START_PCT = 1
const PARSE_END_PCT = 18
const ENTITY_START_PCT = 20
const ENTITY_END_PCT = 98

/**
 * Default model-space entity page size for the sectioned fetch loop. Sized well
 * above the base converter's 10-item UI chunk: each page is a worker round-trip,
 * so we amortize those over many entities while still bounding wasm-side memory.
 * `options.minimumChunkSize` (when provided) overrides it.
 */
const ENTITY_PAGE_SIZE = 500

/** Native converter options — the shared asset config plus client injection. */
export interface AcDbAcadRustNativeConverterConfig extends AcDbAcadRustConverterConfig {
  /**
   * Override the sectioned-protocol transport. Production leaves this unset and
   * the converter drives the real parser Web Worker; tests inject a fake that
   * replays the committed fixtures (node cannot load the `--target web` glue).
   */
  client?: AcadRustDocumentClient
}

/**
 * DWG converter implementing Architecture B: it reads a DWG once into a
 * `CadDocument` resident in wasm memory, then maps document *sections* straight
 * into the {@link AcDbDatabase} — no intermediate ASCII DXF (that round trip is
 * Architecture A, {@link AcDbAcadRustConverter}).
 *
 * The base class `process*()` hooks are synchronous and cannot `await` the
 * worker round-trips the sectioned protocol needs, so — exactly like
 * `AcDbNativeDxfConverter` — the whole lifecycle is driven from an overridden
 * {@link read}: `open` -> per-section fetch+map -> `close`, emitting the same
 * {@link AcDbConversionStage} progression and monotonic progress the UI expects.
 *
 * Current scope: Slice 0 (Phase 4 plan §6.1) — HEADER + LAYER + LTYPE + STYLE —
 * plus the M4.1 pure-geometry entity classes (LINE, CIRCLE, ARC, ELLIPSE,
 * LWPOLYLINE, legacy POLYLINE 2D/3D, SPLINE) and the M4.2 block layer (the
 * BLOCK-RECORD table -> {@link AcDbBlockTableRecord} definitions, their paged
 * inner entities, and INSERT -> {@link AcDbBlockReference} placement carrying the
 * full scale/rotation/extrusion transform), plus the M4.3 text layer (TEXT ->
 * {@link AcDbText} and MTEXT -> {@link AcDbMText}, in model space and block
 * definitions alike). DIMENSION / HATCH and attribute (ATTRIB) rendering remain
 * unknown-counted until later milestones, so
 * `createAcadRustConverter({ architecture: 'native' })` is still for the
 * parity harness and staged rollout, not yet a default.
 */
export class AcDbAcadRustNativeConverter extends AcDbDatabaseConverter<null> {
  private readonly opts: AcDbAcadRustNativeConverterConfig
  /** Injected in tests; otherwise a worker client is built on first read. */
  private injectedClient?: AcadRustDocumentClient

  constructor(config?: AcDbAcadRustNativeConverterConfig) {
    super(config)
    this.opts = config ?? {}
    this.injectedClient = config?.client
  }

  /**
   * Drive the sectioned open -> map -> close lifecycle.
   */
  async read(
    data: ArrayBuffer,
    db: AcDbDatabase,
    options?: AcDbDatabaseConverterReadOptions
  ): Promise<void> {
    const progress = options?.progress ?? this.progress
    const emit = async (
      percentage: number,
      stage: Parameters<AcDbConversionProgressCallback>[1],
      stageStatus: Parameters<AcDbConversionProgressCallback>[2],
      data2?: unknown
    ): Promise<void> => {
      await progress?.(percentage, stage, stageStatus, data2)
    }

    const client = this.resolveClient(data, options?.timeout ?? this.config.timeout)

    await emit(0, 'START', 'START')
    await emit(PARSE_START_PCT, 'PARSE', 'START')
    // Let the open-file overlay paint before the wasm DWG read (once).
    await accmYieldForPaint()

    // Suppress entity/table event side-effects until the batch flushes.
    db.beginEventBatch()
    let batchOpen = true
    let handle: number | undefined
    try {
      handle = await client.open(data)
      await emit(4, 'PARSE', 'IN-PROGRESS')

      const meta = await client.meta(handle)
      // $ACADVER is only on the meta envelope, not the header section.
      this.applyVersion(db, meta)

      // HEADER ($CLAYER, unit tables, extents, current styles...).
      const header = await client.section<AcadRustHeader>(handle, 'header')
      await emit(8, 'HEADER', 'START')
      mapHeader(db, header)
      await emit(9, 'HEADER', 'END')

      // CLASSES (M4.8): the DWG class table -> db.classes (used for proxy-entity
      // class-id resolution and DXF re-export). AcDbConversionStage has no CLASSES
      // tick, so this maps without a dedicated progress emit (progress stays
      // monotonic 9 -> 11); entries keep DWG order for 0-based proxy class ids.
      const classes = await client.section<AcadRustClassTable>(handle, 'classes')
      mapClasses(db, classes)

      // LTYPE (layers reference linetype names, so land the table first).
      const lineTypes = await client.section<AcadRustLineTypeTable>(
        handle,
        'tables-ltype'
      )
      await emit(11, 'LTYPE', 'START')
      mapLineTypes(db, lineTypes)
      await emit(12, 'LTYPE', 'END')

      // DIMSTYLE (M4.6): dimension styles; DIMENSION entities only resolve
      // their look (text size / arrows / gaps / colors) through this table at
      // draw time, so the records must exist before the entity stage lands.
      const dimStyles = await client.section<AcadRustDimStyleTable>(
        handle,
        'tables-dimstyle'
      )
      await emit(13, 'DIMSTYLE', 'START')
      mapDimStyles(db, dimStyles)
      await emit(13, 'DIMSTYLE', 'END')

      // VPORT table (`tables-vport.json`): the active model-space viewport. Its
      // camera + snap/grid/ucs geometry drive the initial view framing; the DXF
      // baseline carries the same values. Flag/enum/handle fields are left at
      // defaults to match the baseline (see `viewportToRecord`).
      const vports = await client.section<AcadRustVportTable>(
        handle,
        'tables-vport'
      )
      await emit(13, 'VPORT', 'START')
      mapVports(db, vports)
      await emit(13, 'VPORT', 'END')

      // STYLE (text styles; $TEXTSTYLE resolves against this table).
      const textStyles = await client.section<AcadRustTextStyleTable>(
        handle,
        'tables-style'
      )
      await emit(14, 'STYLE', 'START')
      mapTextStyles(db, textStyles)
      await emit(15, 'STYLE', 'END')

      // LAYER ($CLAYER + the layer table entities hang off).
      const layers = await client.section<AcadRustLayerTable>(
        handle,
        'tables-layer'
      )
      await emit(16, 'LAYER', 'START')
      mapLayers(db, layers)
      await emit(17, 'LAYER', 'END')

      // BLOCK-RECORD table (block *definitions*). Landed before entities so the
      // `tables-blockrecord` set is in place when INSERTs resolve by name; their
      // inner entities are paged in the ENTITY stage below.
      const blockRecords = await client.section<AcadRustBlockRecordTable>(
        handle,
        'tables-blockrecord'
      )
      await emit(18, 'BLOCK_RECORD', 'START')
      const mappedBlocks = mapBlockRecords(db, blockRecords)
      await emit(18, 'BLOCK_RECORD', 'END')

      await emit(PARSE_END_PCT, 'PARSE', 'END', { unknownEntityCount: 0 })

      // ENTITY stage: page model-space entities and each block definition's
      // inner entities, mapping the classes that have reached Gate 2 (M4.1 pure
      // geometry + M4.2 INSERT/block records + M4.3 TEXT/MTEXT). Unrecognized
      // variants advance `unknownEntityCount`, which the END stats carry so
      // coverage/parity is tracked per file rather than silently dropped.
      await emit(ENTITY_START_PCT, 'ENTITY', 'START')
      const pageSize = Math.max(1, options?.minimumChunkSize ?? ENTITY_PAGE_SIZE)
      const modelTotal = Math.max(0, meta?.modelSpaceEntityCount ?? 0)
      const blockTotal = mappedBlocks.reduce((sum, b) => sum + b.entityCount, 0)
      const grandTotal = modelTotal + blockTotal
      let unknownEntityCount = 0
      let processed = 0
      const emitEntityProgress = async (): Promise<void> => {
        const frac =
          grandTotal > 0 ? Math.min(1, processed / grandTotal) : 1
        const pct = Math.min(
          ENTITY_END_PCT,
          ENTITY_START_PCT + Math.round(frac * (ENTITY_END_PCT - ENTITY_START_PCT))
        )
        await emit(pct, 'ENTITY', 'IN-PROGRESS')
      }

      // (a) Model space — the drawing body (LINE/CIRCLE/.../INSERT).
      const modelSpace = db.tables.blockTable.modelSpace
      let offset = 0
      for (;;) {
        if (modelTotal > 0 && offset >= modelTotal) {
          break
        }
        const page = await client.entityPage(handle, offset, pageSize)
        if (page.length === 0) {
          break
        }
        for (const entity of page) {
          if (!mapEntity(entity, modelSpace)) {
            unknownEntityCount++
          }
        }
        offset += page.length
        processed += page.length
        await emitEntityProgress()
        // Keep the UI responsive between worker round-trips.
        await accmYieldToUi()
        if (page.length < pageSize) {
          break // short page => server exhausted the range
        }
      }

      // (b) Block definitions — page each non-space block's own entities into its
      // record (bounded by the BLOCK-RECORD `entity_handles` count). Insert refs
      // above already resolve to these records by name.
      for (const { name, record, entityCount } of mappedBlocks) {
        if (entityCount <= 0) {
          continue
        }
        let blockOffset = 0
        for (;;) {
          if (blockOffset >= entityCount) {
            break
          }
          const page = await client.blockEntityPage(
            handle,
            name,
            blockOffset,
            pageSize
          )
          if (page.length === 0) {
            break
          }
          for (const entity of page) {
            if (!mapEntity(entity, record)) {
              unknownEntityCount++
            }
          }
          blockOffset += page.length
          processed += page.length
          await emitEntityProgress()
          await accmYieldToUi()
          if (page.length < pageSize) {
            break
          }
        }
      }

      const stats: AcDbParsingTaskStats = { unknownEntityCount }
      await emit(ENTITY_END_PCT, 'ENTITY', 'END', stats)

      // OBJECTS (M4.9 / M4.9b / M4.9c): the DWG objects section. Self-contained
      // XRECORD result buffers and LAYOUT objects land in their db.objects
      // containers, keyed the way the Architecture-A DXF reader
      // (AcDbDxfObjectsReader) resolves them; the NOD dictionary graph then
      // wires against those containers. Object variants without a native
      // data-model class (scale / visualstyle / material / ...) are filtered
      // out here the same way the DXF reader skips unknown types. Handles are
      // re-derived (not copied), so parity is asserted on the handle-key set +
      // data, never on identity.
      const objects = await client.section<AcadRustObjects>(handle, 'objects')
      await emit(ENTITY_END_PCT, 'OBJECT', 'START')
      mapObjects(db, objects, blockRecords)
      await emit(99, 'OBJECT', 'END')

      db.endEventBatch()
      batchOpen = false

      await emit(100, 'END', 'END')
    } catch (error) {
      // Always drop the event batch (if still open) so the viewer is not left
      // mid-stream, and release the resident wasm document, before rethrowing.
      if (batchOpen) {
        db.endEventBatch()
      }
      throw error
    } finally {
      if (handle != null) {
        await client.close(handle).catch(() => undefined)
      }
      // Worker clients are reused across files only through the factory; a
      // per-read injected client is left for the caller (tests) to dispose.
    }
  }

  /** Build the worker client once, or return the caller-injected one. */
  private resolveClient(data: ArrayBuffer, timeout?: number): AcadRustDocumentClient {
    if (this.injectedClient) {
      return this.injectedClient
    }
    const workerUrl = this.resolveWorkerUrl()
    if (!workerUrl) {
      throw new Error(
        'AcDbAcadRustNativeConverter needs a worker URL: set config.parserWorkerUrl, ' +
          `or config.assetBaseUrl to the directory holding ${WORKER_FILE} ` +
          '(the sectioned WASM parser runs in a Web Worker).'
      )
    }
    return new AcadRustWorkerDocumentClient({
      workerUrl,
      timeout: this.getParserWorkerTimeout(data, timeout)
    })
  }

  /** Explicit `parserWorkerUrl` wins; else derive from `assetBaseUrl`. */
  private resolveWorkerUrl(): string | undefined {
    if (this.opts.parserWorkerUrl != null) {
      return this.opts.parserWorkerUrl.toString()
    }
    const base = this.opts.assetBaseUrl
    if (base == null) {
      return undefined
    }
    const s = base.toString()
    return s.endsWith('/') ? `${s}${WORKER_FILE}` : `${s}/${WORKER_FILE}`
  }

  /** Apply the DWG version carried on the meta envelope. */
  private applyVersion(db: AcDbDatabase, meta: AcadRustMeta): void {
    if (meta?.version) {
      db.version = meta.version
    }
  }
}

// ---------------------------------------------------------------------------
// Section -> database mapping (Slice 0).
//
// Each mapper writes into the freshly-opened database using the same accessors
// the MIT `AcDbDxfHeaderReader` / `AcDbDxfDocumentReader` use, so the native
// path's `db` is structurally comparable to the Architecture-A output in the
// parity test. Records are built through their attribute-object constructors
// (which bypass the open-for-write guard on not-yet-added temp records) and
// appended via `db.tables.*.add()`.
// ---------------------------------------------------------------------------

/** Map the acadrust `Color` enum to an {@link AcCmColor}. */
function colorToAcCm(color: AcadRustColor): AcCmColor {
  const c = new AcCmColor()
  if (typeof color === 'string') {
    // Unit variants: ByLayer/ByBlock; anything else (e.g. None) is ByLayer-ish.
    c.colorIndex = color === 'ByBlock' ? 0 : 256
  } else if ('Index' in color) {
    c.colorIndex = color.Index
  } else if ('Rgb' in color) {
    c.setRGB(color.Rgb.r, color.Rgb.g, color.Rgb.b)
  } else {
    c.colorIndex = 256
  }
  return c
}

/** ACI index for the `$CECOLOR` header scalar (Rgb falls back to ByLayer). */
function colorToAci(color: AcadRustColor): number {
  if (typeof color === 'string') {
    return color === 'ByBlock' ? 0 : 256
  }
  if ('Index' in color) {
    return color.Index
  }
  return 256
}

/** Map the acadrust `LineWeight` enum to an {@link AcGiLineWeight} value. */
function lineWeightToGi(lw: AcadRustLineWeight): AcGiLineWeight {
  if (typeof lw === 'string') {
    switch (lw) {
      case 'ByLayer':
        return AcGiLineWeight.ByLayer
      case 'ByBlock':
        return AcGiLineWeight.ByBlock
      case 'Default':
      case 'NoLineweight':
      default:
        return AcGiLineWeight.ByLineWeightDefault
    }
  }
  if ('Value' in lw) {
    return lw.Value as AcGiLineWeight
  }
  return AcGiLineWeight.ByLineWeightDefault
}

/** Map the acadrust `Transparency` (snake_case) enum to {@link AcCmTransparency}. */
function transparencyToAcCm(t: AcadRustTransparency): AcCmTransparency {
  if (typeof t === 'string') {
    // "by_layer" / "by_block" both inherit; the record default is ByLayer.
    return new AcCmTransparency()
  }
  if ('explicit' in t) {
    const tr = new AcCmTransparency()
    if (t.explicit > 0) {
      // acadrust carries the AutoCAD transparency percentage (0 = opaque).
      tr.percentage = t.explicit
    }
    return tr
  }
  return new AcCmTransparency()
}

/** Fold the discrete acadrust layer flag booleans into DXF `standardFlags`. */
function layerFlagsToStandardFlags(flags: AcadRustLayerFlags): number {
  let value = 0
  if (flags.frozen) value |= 1
  if (flags.frozen_in_new_viewport) value |= 2
  if (flags.locked) value |= 4
  if (flags.xref_dependent) value |= 16
  return value
}

function mapHeader(db: AcDbDatabase, h: AcadRustHeader): void {
  db.angbase = h.angle_base
  db.angdir = h.angle_direction
  db.aunits = h.angular_unit_format
  db.auprec = h.angular_unit_precision
  db.lunits = h.linear_unit_format
  db.luprec = h.linear_unit_precision
  db.insunits = h.insertion_units
  db.measurement = h.measurement
  db.ltscale = h.linetype_scale
  db.celtscale = h.current_entity_linetype_scale
  db.celweight = h.current_line_weight
  db.lwdisplay = h.lineweight_display
  db.psltscale = h.paper_space_linetype_scaling
  db.tilemode = h.show_model_space
  db.orthomode = h.ortho_mode ? 1 : 0
  db.osmode = h.object_snap_mode
  db.pdmode = h.point_display_mode
  db.pdsize = h.point_display_size
  db.celtype = h.current_linetype_name || 'ByLayer'
  db.clayer = h.current_layer_name || '0'
  db.textstyle = h.current_text_style_name || 'Standard'
  db.dimstyle = h.current_dimstyle_name || 'Standard'
  db.cmlstyle = h.multiline_style || 'Standard'
  db.cmleaderstyle = h.current_mleader_style_name || 'Standard'
  db.extmin = new AcGePoint3d(
    h.model_space_extents_min.x,
    h.model_space_extents_min.y,
    h.model_space_extents_min.z
  )
  db.extmax = new AcGePoint3d(
    h.model_space_extents_max.x,
    h.model_space_extents_max.y,
    h.model_space_extents_max.z
  )
  // $CECOLOR is a live AcCmColor on the database; set its index in place.
  db.cecolor.colorIndex = colorToAci(h.current_entity_color)
  if (h.handle_seed != null) {
    db.initializeHandleSeed(String(h.handle_seed))
  }
}

function mapLayers(db: AcDbDatabase, table: AcadRustLayerTable): void {
  for (const layer of Object.values(table?.entries ?? {})) {
    db.tables.layerTable.add(layerToRecord(layer))
  }
}

function layerToRecord(layer: AcadRustLayer): AcDbLayerTableRecord {
  return new AcDbLayerTableRecord({
    name: layer.name,
    color: colorToAcCm(layer.color),
    standardFlags: layerFlagsToStandardFlags(layer.flags),
    isOff: layer.flags.off,
    isPlottable: layer.is_plottable,
    transparency: transparencyToAcCm(layer.transparency),
    linetype: layer.line_type || 'Continuous',
    lineWeight: lineWeightToGi(layer.line_weight),
    description: layer.description
  })
}

function mapLineTypes(db: AcDbDatabase, table: AcadRustLineTypeTable): void {
  for (const lineType of Object.values(table?.entries ?? {})) {
    db.tables.linetypeTable.add(lineTypeToRecord(lineType))
  }
}

function lineTypeToRecord(lineType: AcadRustLineType): AcDbLinetypeTableRecord {
  return new AcDbLinetypeTableRecord({
    name: lineType.name,
    description: lineType.description,
    standardFlag: lineType.xref_dependent ? 16 : 0,
    totalPatternLength: lineType.pattern_length,
    // Slice 0 keeps dash lengths + total pattern length (what the renderer
    // needs to stroke the pattern). Embedded shape/text complex segments are a
    // later milestone and are flattened to plain dashes here.
    pattern: (lineType.elements ?? []).map(el => ({
      elementLength: el.length,
      elementTypeFlag: 0
    }))
  })
}

function mapTextStyles(db: AcDbDatabase, table: AcadRustTextStyleTable): void {
  for (const style of Object.values(table?.entries ?? {})) {
    db.tables.textStyleTable.add(textStyleToRecord(style))
  }
  db.ensureTextStyleDefaults()
}

function textStyleToRecord(style: AcadRustTextStyle): AcDbTextStyleTableRecord {
  let textGenerationFlag = 0
  if (style.flags.upside_down) textGenerationFlag |= 1
  if (style.flags.backward) textGenerationFlag |= 2
  let standardFlag = 0
  if (style.is_shape_file) standardFlag |= 1
  if (style.annotative) standardFlag |= 4
  return new AcDbTextStyleTableRecord({
    name: style.name,
    standardFlag,
    fixedTextHeight: style.height,
    widthFactor: style.width_factor,
    obliqueAngle: style.oblique_angle,
    textGenerationFlag,
    lastHeight: style.last_height,
    font: style.font_file,
    bigFont: style.big_font_file,
    extendedFont: style.true_type_font || undefined
  })
}

// ---------------------------------------------------------------------------
// Dimension styles (M4.6).
//
// The DIMSTYLE section is the dimension *appearance* directory. acadrust's
// serde keys are the DXF mnemonics themselves, so the mapping is largely a
// field-for-field fold — with three wire-vs-record type bridges to mind:
// boolean switches -> the `0 | 1` the attrs declare, arrow-block handles ->
// the sibling `dimblk*_name` strings the record actually stores, and `dimdsep`
// -> a character from its code (46 = '.'). Numeric justification/zero-suppress
// codes arrive as plain numbers and are re-typed onto their data-model enums
// (the wire values are the same DXF group-code numbers, so the casts are the
// documented domain). Unmodeled extras (`dimfxl`, `dimtfill*`, metric
// zero-factor fields, truecolors) have no record counterpart and stay on the
// payload.
// ---------------------------------------------------------------------------

/**
 * Fold the acadrust CLASSES / DWG class table into `db.classes` (the data-model's
 * first-class `AcDbClass[]`). Entries keep DWG class-table order so proxy entities
 * resolve their application class id (0-based index + 500) exactly as the
 * Architecture-A DXF reader does. Only the seven DXF-persisted fields are mapped;
 * DWG-internal fields (`class_number` etc.) have no `AcDbClass` slot (see
 * `AcadRustClass`).
 */
function mapClasses(db: AcDbDatabase, table: AcadRustClassTable): void {
  const classes = (table?.entries ?? []).map(classToEntry)
  // Mirror the DXF reader: only overwrite the default [] when the source carries
  // classes, so an absent section never clobbers the database.
  if (classes.length > 0) {
    db.classes = classes
  }
}

function classToEntry(c: AcadRustClass): AcDbClass {
  return {
    name: c.dxf_name,
    cppClassName: c.cpp_class_name,
    appName: c.application_name,
    proxyFlag: c.proxy_flags,
    instanceCount: c.instance_count,
    wasProxy: c.was_zombie,
    isEntity: c.is_an_entity
  }
}

/**
 * Map the DWG OBJECTS section (M4.9 / M4.9b / M4.9c / M4.9d): XRECORD entries into
 * `db.objects.xrecord`, LAYOUT entries into `db.objects.layout`, GROUP entries
 * into `db.objects.group`, MLINESTYLE entries into `db.objects.mlineStyle` and
 * MLEADERSTYLE entries into `db.objects.mleaderStyle` (each keyed the way the
 * Architecture-A DXF reader resolves them), then wire the NOD dictionary graph
 * against the filled containers. Object variants without a native data-model
 * class (scale / visualstyle / material / ...) stay filtered out exactly like
 * the DXF reader skips them.
 */
function mapObjects(
  db: AcDbDatabase,
  table: AcadRustObjects,
  blockRecords: AcadRustBlockRecordTable
): void {
  for (const entry of Object.values(table ?? {})) {
    const l = entry?.Layout
    if (l?.name) {
      const layout = layoutToRecord(db, blockRecords, l)
      db.objects.layout.setAt(layout.layoutName, layout)
      continue
    }
    const g = entry?.Group
    if (g) {
      const group = groupToRecord(g)
      db.objects.group.setAt(group.name || group.objectId, group)
      continue
    }
    const m = entry?.MLineStyle
    if (m) {
      const style = mlineStyleToRecord(m)
      db.objects.mlineStyle.setAt(style.styleName || style.objectId, style)
      continue
    }
    const md = entry?.MultiLeaderStyle
    if (md) {
      const style = mleaderStyleToRecord(md)
      db.objects.mleaderStyle.setAt(style.objectId, style)
      continue
    }
    const x = entry?.XRecord
    if (!x || !Array.isArray(x.entries)) {
      continue
    }
    const rec = xRecordToXrecord(x)
    db.objects.xrecord.setAt(rec.objectId, rec)
  }
  wireNamedObjectDictionary(db, table)
}

/**
 * Bridge a DWG block-record handle to a resident native record: resolve the
 * name from the BLOCK-RECORD section and look it up in the block table (the
 * converter re-derives object handles, so the DWG hex is not valid inside the
 * native db). The db only pre-creates the model-space record, so a layout's
 * paper-space record is landed here on demand - the Architecture-A baseline
 * carries one record per layout and the viewer needs it to switch spaces.
 * Falls back to the raw DWG hex when the section has no such entry.
 */
function resolveBlockRecordObjectId(
  db: AcDbDatabase,
  blockRecords: AcadRustBlockRecordTable,
  handle: number
): string {
  const entry = Object.values(blockRecords?.entries ?? {}).find(
    (e) => e?.handle === handle
  )
  if (entry?.name) {
    const table = db.tables.blockTable
    let record = table.getAt(entry.name)
    if (!record) {
      record = blockRecordToRecord(entry)
      table.add(record)
    }
    return record.objectId
  }
  return dwgHandleToObjectId(handle)
}

const tupleToPt3 = (t: [number, number, number]): AcGePoint3d =>
  new AcGePoint3d(t[0], t[1], t[2])

/**
 * Build an AcDbLayout from the flattened acadrust LAYOUT variant. Every slot
 * follows the group-code semantics of `AcDbPlotSettings`/`AcDbLayout`
 * `dxfInFields` (verified against the Architecture-A baseline DXF): group 70
 * plot flags map bit-for-bit from `plot_flags`, 44/45 to plotPaperSize, 78 to
 * shadePlotCustomDPI and so on. Deliberately unmapped: `plot_scale_factor`
 * (DXF 147 is derived from stdScaleType and ignored on read),
 * `viewport`/`base_ucs`/`named_ucs`/`plot_view_handle`/`visual_style_handle`
 * (all zero in this corpus, so no baseline evidence for their non-default
 * encoding) and the plot_flags bits without a DXF-side slot
 * (update_paper / initializing / prev_plot_init / unknown_bits).
 */
function layoutToRecord(
  db: AcDbDatabase,
  blockRecords: AcadRustBlockRecordTable,
  l: AcadRustLayout
): AcDbLayout {
  const rec = new AcDbLayout()
  rec.objectId = dwgHandleToObjectId(l.handle)
  rec.ownerId = dwgHandleToObjectId(l.owner)
  rec.layoutName = l.name
  rec.tabSelected = l.flags !== 0
  rec.tabOrder = l.tab_order
  rec.limits = new AcGeBox2d(
    { x: l.min_limits[0], y: l.min_limits[1] },
    { x: l.max_limits[0], y: l.max_limits[1] }
  )
  rec.extents = new AcGeBox3d(
    { x: l.min_extents[0], y: l.min_extents[1], z: l.min_extents[2] },
    { x: l.max_extents[0], y: l.max_extents[1], z: l.max_extents[2] }
  )
  rec.insertionPoint = tupleToPt3(l.insertion_base)
  rec.elevation = l.elevation
  rec.ucsOrigin = tupleToPt3(l.ucs_origin)
  rec.ucsXAxis = { x: l.ucs_x_axis[0], y: l.ucs_x_axis[1], z: l.ucs_x_axis[2] }
  rec.ucsYAxis = { x: l.ucs_y_axis[0], y: l.ucs_y_axis[1], z: l.ucs_y_axis[2] }
  rec.orthographicType = l.ucs_ortho_type
  rec.blockTableRecordId = resolveBlockRecordObjectId(
    db,
    blockRecords,
    l.block_record
  )
  if (l.viewports?.length) {
    rec.viewportArray = l.viewports.map(dwgHandleToObjectId)
  }
  // Embedded AcDbPlotSettings payload.
  rec.plotSettingsName = l.plot_page_name
  rec.plotCfgName = l.plot_printer_name
  rec.canonicalMediaName = l.paper_size
  rec.plotViewName = l.plot_view_name
  rec.currentStyleSheet = l.plot_style_sheet
  rec.plotPaperMargins = {
    left: l.plot_margin_left,
    right: l.plot_margin_right,
    top: l.plot_margin_top,
    bottom: l.plot_margin_bottom
  }
  rec.plotPaperSize = new AcGePoint2d(l.paper_width, l.paper_height)
  rec.plotOrigin = new AcGePoint2d(l.plot_origin_x, l.plot_origin_y)
  rec.plotWindowArea = new AcGeBox2d(
    { x: l.plot_window_min_x, y: l.plot_window_min_y },
    { x: l.plot_window_max_x, y: l.plot_window_max_y }
  )
  rec.customPrintScale = {
    numerator: l.plot_scale_numerator,
    denominator: l.plot_scale_denominator
  }
  const f = l.plot_flags
  if (f) {
    rec.plotViewportBorders = f.plot_viewport_borders
    rec.showPlotStyles = f.show_plot_styles
    rec.plotCentered = f.plot_centered
    rec.plotHidden = f.plot_hidden
    rec.useStandardScale = f.use_standard_scale
    rec.plotPlotStyles = f.plot_plot_styles
    rec.scaleLineweights = f.scale_lineweights
    rec.printLineweights = f.print_lineweights
    rec.drawViewportsFirst = f.draw_viewports_first
    rec.modelType = f.model_type
  }
  rec.plotPaperUnits = l.plot_paper_units as AcDbPlotPaperUnits
  rec.plotRotation = l.plot_rotation as AcDbPlotRotation
  rec.plotType = l.plot_type as AcDbPlotType
  rec.stdScaleType = l.plot_scale_type as AcDbPlotStdScaleType
  rec.shadePlot = l.shade_plot_mode as AcDbPlotShadePlotType
  rec.shadePlotResLevel = l.shade_plot_resolution as AcDbPlotShadePlotResLevel
  rec.shadePlotCustomDPI = l.shade_plot_dpi
  rec.paperImageOrigin = new AcGePoint2d(
    l.paper_image_origin_x,
    l.paper_image_origin_y
  )
  return rec
}

/**
 * Build a standalone {@link AcDbGroup} from an acadrust GROUP entry, mirroring
 * `AcDbDxfObjectsReader` case 'GROUP'. The DXF baseline loses the DWG group
 * name (DXF carries no name slot on the object; the reader lands such groups
 * under their handle), so the native container is keyed by name when present -
 * strictly more faithful than the Architecture-A baseline.
 */
function groupToRecord(g: AcadRustGroup): AcDbGroup {
  const rec = new AcDbGroup()
  rec.objectId = dwgHandleToObjectId(g.handle)
  rec.ownerId = dwgHandleToObjectId(g.owner)
  rec.name = g.name
  rec.unnamed = g.unnamed
  rec.selectable = g.selectable
  // g.description has no AcDbGroup slot (DXF group 300 maps to name); the
  // corpus carries it empty anyway.
  for (const handle of g.entities ?? []) {
    rec.addEntityId(dwgHandleToObjectId(handle))
  }
  return rec
}

/** Build a standalone {@link AcDbMlineStyle} from an acadrust MLINESTYLE entry. */
function mlineStyleToRecord(m: AcadRustMLineStyle): AcDbMlineStyle {
  const rec = new AcDbMlineStyle()
  rec.objectId = dwgHandleToObjectId(m.handle)
  rec.ownerId = dwgHandleToObjectId(m.owner)
  rec.styleName = m.name
  rec.description = m.description
  // DWG stores radians; AcDbMlineStyle keeps the DXF degree representation
  // (baseline group 51/52 = 90 for the fixture's pi/2).
  rec.startAngle = (m.start_angle * 180) / Math.PI
  rec.endAngle = (m.end_angle * 180) / Math.PI
  rec.fillColor = colorToAcCm(m.fill_color)
  // m.flags stays unmapped: the DWG->DXF group 70 bit order has no non-zero
  // evidence in this corpus (baseline 70:0, every fixture flag false), so the
  // record default is kept exactly like the M4.7 viewport flags.
  for (const el of m.elements ?? []) {
    rec.addElement({
      offset: el.offset,
      color: colorToAcCm(el.color),
      lineType: el.linetype
    })
  }
  return rec
}

// MLEADERSTYLE enum tables: only the acadrust-name -> DXF-code pairs that the
// baseline corpus evidences (group codes noted inline). Unknown names fall
// through to the data-model defaults instead of being guessed.
const MLEADER_PATH_TYPE: Record<string, number> = {
  StraightLineSegments: 1 // group 173 (baseline 173:1)
}
const MLEADER_CONTENT_TYPE: Record<string, number> = {
  MText: 2 // group 170 (baseline 170:2)
}
const MLEADER_MULTILEADER_DRAW_ORDER: Record<string, number> = {
  LeaderFirst: 1 // group 171 (baseline 171:1)
}
const MLEADER_LEADER_DRAW_ORDER: Record<string, number> = {
  LeaderHeadFirst: 0 // group 172 (baseline 172:0)
}
const MLEADER_TEXT_ANGLE_TYPE: Record<string, number> = {
  Horizontal: 1 // group 175 (baseline 175:1)
}
const MLEADER_TEXT_ALIGNMENT: Record<string, number> = {
  Left: 0 // group 176 (baseline 176:0)
}
const MLEADER_TEXT_LEFT_ATTACHMENT: Record<string, number> = {
  MiddleOfTopLine: 1 // group 174 (baseline 174:1)
}
const MLEADER_TEXT_RIGHT_ATTACHMENT: Record<string, number> = {
  BottomOfTopLineUnderlineBottomLine: 6 // group 178 (baseline 178:6)
}
const MLEADER_BLOCK_CONNECTION: Record<string, number> = {
  BlockExtents: 0 // group 177 (baseline 177:0)
}

/** Build a standalone {@link AcDbMLeaderStyle} from an acadrust MLEADERSTYLE entry. */
function mleaderStyleToRecord(m: AcadRustMultiLeaderStyle): AcDbMLeaderStyle {
  const rec = new AcDbMLeaderStyle()
  rec.objectId = dwgHandleToObjectId(m.handle)
  rec.ownerId = dwgHandleToObjectId(m.owner_handle)
  if (MLEADER_CONTENT_TYPE[m.content_type] !== undefined) {
    rec.contentType = MLEADER_CONTENT_TYPE[m.content_type]
  }
  if (MLEADER_MULTILEADER_DRAW_ORDER[m.multileader_draw_order] !== undefined) {
    rec.drawMLeaderOrderType = MLEADER_MULTILEADER_DRAW_ORDER[m.multileader_draw_order]
  }
  if (MLEADER_LEADER_DRAW_ORDER[m.leader_draw_order] !== undefined) {
    rec.drawLeaderOrderType = MLEADER_LEADER_DRAW_ORDER[m.leader_draw_order]
  }
  rec.maxLeaderSegmentsPoints = m.max_leader_points
  rec.firstSegmentAngleConstraint = m.first_segment_angle
  rec.secondSegmentAngleConstraint = m.second_segment_angle
  if (MLEADER_PATH_TYPE[m.path_type] !== undefined) {
    rec.leaderLineType = MLEADER_PATH_TYPE[m.path_type]
  }
  rec.leaderLineColor = colorToAcCm(m.line_color)
  rec.leaderLineTypeId = dwgHandleToObjectId(m.line_type_handle)
  rec.leaderLineWeight = lineWeightToGi(m.line_weight)
  rec.enableLanding = m.enable_landing
  rec.landingGap = m.landing_gap
  rec.enableDogleg = m.enable_dogleg
  // The DWG `landing_distance` field carries the DXF group 43 dogleg length
  // (baseline 43:8 == fixture landing_distance 8), hence the crossed naming.
  rec.doglegLength = m.landing_distance
  rec.description = m.description
  if (m.arrowhead_handle != null) {
    rec.arrowSymbolId = dwgHandleToObjectId(m.arrowhead_handle)
  }
  rec.arrowSize = m.arrowhead_size
  rec.defaultMTextContents = m.default_text
  rec.textStyleId = dwgHandleToObjectId(m.text_style_handle)
  if (MLEADER_TEXT_LEFT_ATTACHMENT[m.text_left_attachment] !== undefined) {
    rec.textLeftAttachmentType = MLEADER_TEXT_LEFT_ATTACHMENT[m.text_left_attachment]
  }
  if (MLEADER_TEXT_ANGLE_TYPE[m.text_angle_type] !== undefined) {
    rec.textAngleType = MLEADER_TEXT_ANGLE_TYPE[m.text_angle_type]
  }
  if (MLEADER_TEXT_ALIGNMENT[m.text_alignment] !== undefined) {
    rec.textAlignmentType = MLEADER_TEXT_ALIGNMENT[m.text_alignment]
  }
  if (MLEADER_TEXT_RIGHT_ATTACHMENT[m.text_right_attachment] !== undefined) {
    rec.textRightAttachmentType = MLEADER_TEXT_RIGHT_ATTACHMENT[m.text_right_attachment]
  }
  rec.textColor = colorToAcCm(m.text_color)
  rec.textHeight = m.text_height
  rec.enableFrameText = m.text_frame
  rec.textAlignAlwaysLeft = m.text_always_left
  rec.alignSpace = m.align_space
  if (m.block_content_handle != null) {
    rec.blockId = dwgHandleToObjectId(m.block_content_handle)
  }
  rec.blockColor = colorToAcCm(m.block_content_color)
  rec.blockScale = new AcGeVector3d(
    m.block_content_scale_x,
    m.block_content_scale_y,
    m.block_content_scale_z
  )
  rec.enableBlockScale = m.enable_block_scale
  rec.blockRotation = m.block_content_rotation
  rec.enableBlockRotation = m.enable_block_rotation
  if (MLEADER_BLOCK_CONNECTION[m.block_content_connection] !== undefined) {
    rec.blockConnectionType = MLEADER_BLOCK_CONNECTION[m.block_content_connection]
  }
  rec.scale = m.scale_factor
  rec.overwritePropChanged = m.property_changed
  rec.annotative = m.is_annotative
  rec.breakSize = m.break_gap_size
  // text_attachment_direction / text_top_attachment / text_bottom_attachment
  // and unknown_flag_298 stay unmapped: the baseline omits groups 271/272/273/
  // 298 entirely (their fixture values equal the data-model defaults), so their
  // name -> code tables would be guesses.
  return rec
}

/**
 * Mirror {@link AcDbDxfObjectsReader} `finishNamedObjectDictionaries`: bind the
 * root DICTIONARY (owner 0) to `db.objects.dictionary`, hang only the
 * whitelist-named child dictionaries on it, and resolve each wired child
 * dictionary's own `[key, handle]` entries against the objects already resident
 * in the db.objects containers (a two-pass graph assembly). Dictionaries whose
 * root key is not whitelisted stay unbuilt on purpose - the Architecture-A
 * baseline does not carry them either, and their payload types have no native
 * data-model class yet. duplicate_cloning / hard_owner have no AcDbDictionary
 * slot and stay at their defaults (baseline parity).
 */
function wireNamedObjectDictionary(db: AcDbDatabase, table: AcadRustObjects): void {
  const dictionaries = new Map<number, AcadRustDictionary>()
  let root: AcadRustDictionary | undefined
  for (const entry of Object.values(table ?? {})) {
    const d = entry?.Dictionary
    if (!d || !Array.isArray(d.entries)) {
      continue
    }
    dictionaries.set(d.handle, d)
    if (!root && d.owner === 0) {
      root = d
    }
  }
  if (!root) {
    return
  }
  const rootId = dwgHandleToObjectId(root.handle)
  const rootDict = db.objects.dictionary
  rootDict.objectId = rootId
  rootDict.ownerId = '0'
  const asObjectDict = (dict: object): AcDbDictionary<AcDbObject> =>
    dict as unknown as AcDbDictionary<AcDbObject>
  // Same key whitelist the DXF reader uses to bind child dictionaries to slots.
  const typedByKey: Record<string, AcDbDictionary<AcDbObject>> = {
    ACAD_LAYOUT: asObjectDict(db.objects.layout),
    ACAD_GROUP: asObjectDict(db.objects.group),
    ACAD_SORTENTS: asObjectDict(db.objects.sortentsTable),
    ACAD_MLEADERSTYLE: asObjectDict(db.objects.mleaderStyle),
    ACAD_MLINESTYLE: asObjectDict(db.objects.mlineStyle),
    ISM_RASTER_IMAGE_DICT: asObjectDict(db.objects.imageDefinition),
    MLIGHT_XRECORD: asObjectDict(db.objects.xrecord)
  }
  const objectsByHandle = collectLoadedObjectsByHandle(db)
  for (const [key, childHandle] of root.entries) {
    const typed = typedByKey[key.toUpperCase()]
    if (!typed) {
      continue
    }
    typed.objectId = dwgHandleToObjectId(childHandle)
    typed.ownerId = rootId
    rootDict.setAt(key, typed as unknown as AcDbDictionary)
    const child = dictionaries.get(childHandle)
    if (!child) {
      continue
    }
    for (const [entryName, entryHandle] of child.entries) {
      const obj = objectsByHandle.get(dwgHandleToObjectId(entryHandle))
      if (obj && !typed.getAt(entryName)) {
        typed.setAt(entryName, obj)
      }
    }
  }
}

/**
 * Index every object already resident in the db.objects containers by its
 * object id (mirrors the reader's `collectLoadedObjectsByHandle`): dictionary
 * entries reference objects by handle, so the graph can only be wired after
 * the flat reads have run.
 */
function collectLoadedObjectsByHandle(db: AcDbDatabase): Map<string, AcDbObject> {
  const map = new Map<string, AcDbObject>()
  const add = (obj: AcDbObject): void => {
    let id: string | undefined
    try {
      id = obj.objectId
    } catch {
      id = undefined
    }
    if (id) {
      map.set(id, obj)
    }
  }
  const objects = db.objects
  for (const dict of [
    objects.layout,
    objects.group,
    objects.sortentsTable,
    objects.imageDefinition,
    objects.mleaderStyle,
    objects.mlineStyle,
    objects.layerFilter,
    objects.layerIndex,
    objects.xrecord
  ]) {
    for (const [, obj] of dict.entries()) {
      add(obj)
    }
  }
  return map
}

/** Build a standalone {@link AcDbXrecord} from an acadrust XRECORD entry. */
function xRecordToXrecord(x: AcadRustXRecord): AcDbXrecord {
  const rec = new AcDbXrecord()
  // DWG stores handles as integers; the object-id map / DXF group 5 use their
  // uppercase-hex form (e.g. 4806 -> "12C6"), matching the baseline's handle.
  rec.objectId = dwgHandleToObjectId(x.handle)
  const values: AcDbTypedValue[] = []
  for (const e of x.entries) {
    pushResultBufferValues(values, e.code, e.value)
  }
  rec.data = new AcDbResultBuffer(values)
  return rec
}

/**
 * Unwrap one acadrust result-buffer entry into the DXF typed value(s) the
 * Architecture-A reader produces. Scalars map one-to-one (unchanged behavior);
 * the four structured variants follow what `DxfWriter` emits in `baseline.dxf`,
 * verified against the sample corpus: a `Point3D` expands to the X/Y/Z double
 * triple (group codes `n` / `n+10` / `n+20`), a `Handle` becomes its
 * uppercase-hex string, a `Chunk` becomes an uppercase-hex binary string and a
 * `Bool` stays a boolean. Unknown variants are skipped rather than aborting the
 * whole drawing (W2 surfaced shapes the fixture never exercised).
 */
function pushResultBufferValues(
  out: AcDbTypedValue[],
  code: number,
  v: AcadRustResultBufferValue
): void {
  const add = (c: number, value: unknown): void => {
    out.push({ code: c as AcDbDxfCode, value } as AcDbTypedValue)
  }
  if ('String' in v) return add(code, v.String)
  if ('Int32' in v) return add(code, v.Int32)
  if ('Int16' in v) return add(code, v.Int16)
  if ('Byte' in v) return add(code, v.Byte)
  if ('Double' in v) return add(code, v.Double)
  if ('Bool' in v) return add(code, v.Bool)
  if ('Handle' in v) return add(code, dwgHandleToObjectId(v.Handle))
  if ('Point3D' in v) {
    const [x, y, z] = v.Point3D
    add(code, x)
    add(code + 10, y)
    add(code + 20, z)
    return
  }
  if ('Chunk' in v) return add(code, bytesToHexUpper(v.Chunk))
}

/** Render a byte array as the uppercase hex string DXF group 310 carries. */
function bytesToHexUpper(bytes: number[]): string {
  let out = ''
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, '0')
  return out.toUpperCase()
}

/** Normalize a numeric DWG handle to its uppercase-hex object-id string. */
function dwgHandleToObjectId(handle: number): string {
  return handle.toString(16).toUpperCase()
}

function mapDimStyles(db: AcDbDatabase, table: AcadRustDimStyleTable): void {
  for (const style of Object.values(table?.entries ?? {})) {
    db.tables.dimStyleTable.add(dimStyleToRecord(style))
  }
}

/**
 * Fold one acadrust VPORT record into a data-model `AcDbViewportTableRecord`.
 * Camera fields go through the abstract-view setters (which proxy into `gsView`
 * and drive `modelViewBox`); snap/grid/ucs geometry go through the viewport
 * attrs. Deliberately NOT mapped — left at the record defaults to match the
 * Architecture-A DXF baseline, which stores group 70 = 0 / a default render mode
 * — are the `standardFlag` bit-pack, `render_mode`, `view_mode`,
 * `ucs_icon_setting`, `grid_flags`, ambient/brightness/contrast, and the
 * background/visual-style/named-ucs handle cross-refs (carried on `AcadRustVport`
 * for a later milestone).
 */
function viewportToRecord(v: AcadRustVport): AcDbViewportTableRecord {
  const rec = new AcDbViewportTableRecord({ name: v.name })
  // Viewport rectangle (graphics-area fractions, DXF 10/11).
  if (v.lower_left) {
    rec.lowerLeftCorner = new AcGePoint2d(v.lower_left.x, v.lower_left.y)
  }
  if (v.upper_right) {
    rec.upperRightCorner = new AcGePoint2d(v.upper_right.x, v.upper_right.y)
  }
  // Snap / grid geometry (DXF 13/14/15/50/61/72).
  if (v.snap_base) {
    rec.snapBase = new AcGePoint2d(v.snap_base.x, v.snap_base.y)
  }
  if (v.snap_spacing) {
    rec.snapIncrements = new AcGePoint2d(v.snap_spacing.x, v.snap_spacing.y)
  }
  if (v.grid_spacing) {
    rec.gridIncrements = new AcGePoint2d(v.grid_spacing.x, v.grid_spacing.y)
  }
  if (typeof v.grid_major === 'number') {
    rec.gridMajor = v.grid_major
  }
  if (typeof v.circle_zoom === 'number') {
    rec.circleSides = v.circle_zoom
  }
  if (typeof v.snap_rotation === 'number') {
    rec.snapAngle = v.snap_rotation
  }
  if (typeof v.ucs_elevation === 'number') {
    rec.ucsElevation = v.ucs_elevation
  }
  // Camera -> gsView (drives the initial model-space view box, DXF 12/16/17/40/51).
  if (v.view_center) {
    rec.centerPoint = new AcGePoint2d(v.view_center.x, v.view_center.y)
  }
  if (v.view_direction) {
    rec.viewDirectionFromTarget = new AcGePoint3d(
      v.view_direction.x,
      v.view_direction.y,
      v.view_direction.z
    )
  }
  if (v.view_target) {
    rec.viewTarget = new AcGePoint3d(
      v.view_target.x,
      v.view_target.y,
      v.view_target.z
    )
  }
  if (typeof v.view_height === 'number') {
    rec.viewHeight = v.view_height
  }
  if (typeof v.view_twist === 'number') {
    rec.viewTwistAngle = v.view_twist
  }
  if (typeof v.lens_length === 'number') {
    rec.lensLength = v.lens_length
  }
  if (typeof v.front_clip === 'number') {
    rec.frontClippingPlane = v.front_clip
  }
  if (typeof v.back_clip === 'number') {
    rec.backClippingPlane = v.back_clip
  }
  if (typeof v.ucs_ortho_type === 'number') {
    rec.orthographicType = v.ucs_ortho_type as AcGiOrthographicType
  }
  if (v.ucs_origin) {
    rec.ucsOrigin = new AcGePoint3d(
      v.ucs_origin.x,
      v.ucs_origin.y,
      v.ucs_origin.z
    )
  }
  if (v.ucs_x_axis) {
    rec.ucsXAxis = new AcGePoint3d(v.ucs_x_axis.x, v.ucs_x_axis.y, v.ucs_x_axis.z)
  }
  if (v.ucs_y_axis) {
    rec.ucsYAxis = new AcGePoint3d(v.ucs_y_axis.x, v.ucs_y_axis.y, v.ucs_y_axis.z)
  }
  // `gsView.aspectRatio` has no public setter (the DXF reader writes it directly).
  if (Number.isFinite(v.aspect_ratio) && v.aspect_ratio > 0) {
    rec.gsView.aspectRatio = v.aspect_ratio
  }
  return rec
}

function mapVports(db: AcDbDatabase, table: AcadRustVportTable): void {
  for (const v of Object.values(table?.entries ?? {})) {
    db.tables.viewportTable.add(viewportToRecord(v))
  }
}

/** Wire boolean -> the `0 | 1` switch typing of the record attrs. */
function dimFlag(value: boolean | undefined): 0 | 1 {
  return value ? 1 : 0
}

function dimStyleToRecord(style: AcadRustDimStyle): AcDbDimStyleTableRecord {
  return new AcDbDimStyleTableRecord({
    name: style.name,
    // dimension line / extension line / text appearance.
    dimclrd: style.dimclrd,
    dimclre: style.dimclre,
    dimclrt: style.dimclrt,
    dimlwd: style.dimlwd,
    dimlwe: style.dimlwe,
    dimdle: style.dimdle,
    dimdli: style.dimdli,
    dimexe: style.dimexe,
    dimexo: style.dimexo,
    dimgap: style.dimgap,
    dimasz: style.dimasz,
    dimtsz: style.dimtsz,
    dimcen: style.dimcen,
    // arrow blocks: the record stores resolved *names* (payload 340-code
    // handles stay untouched); no ldrblk name crosses the wire today.
    dimblk: style.dimblk_name ?? '',
    dimblk1: style.dimblk1_name ?? '',
    dimblk2: style.dimblk2_name ?? '',
    dimsah: dimFlag(style.dimsah),
    // text.
    dimtxt: style.dimtxt,
    dimtxsty: style.dimtxsty ?? '',
    dimjust: style.dimjust as AcDbDimTextHorizontal,
    dimtad: style.dimtad as AcDbDimTextVertical,
    dimtvp: style.dimtvp,
    dimtih: dimFlag(style.dimtih),
    dimtoh: dimFlag(style.dimtoh),
    dimtix: dimFlag(style.dimtix),
    dimsoxd: dimFlag(style.dimsoxd),
    dimtmove: style.dimtmove,
    dimpost: style.dimpost ?? '',
    dimapost: style.dimapost ?? '',
    dimupt: dimFlag(style.dimupt),
    // extension-line suppression.
    dimse1: dimFlag(style.dimse1),
    dimse2: dimFlag(style.dimse2),
    dimsd1: dimFlag(style.dimsd1),
    dimsd2: dimFlag(style.dimsd2),
    dimtofl: dimFlag(style.dimtofl),
    // fit + scale.
    dimscale: style.dimscale,
    dimlfac: style.dimlfac,
    dimatfit: style.dimatfit,
    dimfit: style.dimfit,
    // primary unit formatting.
    dimunit: style.dimunit,
    dimlunit: style.dimlunit,
    dimdec: style.dimdec,
    dimrnd: style.dimrnd,
    dimdsep: String.fromCharCode(style.dimdsep ?? 46),
    dimzin: style.dimzin as AcDbDimZeroSuppression,
    dimfrac: style.dimfrac,
    // angular formatting.
    dimaunit: style.dimaunit,
    dimadec: style.dimadec,
    dimazin: style.dimazin as AcDbDimZeroSuppressionAngular,
    // alternate units.
    dimalt: dimFlag(style.dimalt),
    dimaltf: style.dimaltf,
    dimaltd: style.dimaltd,
    dimaltu: style.dimaltu,
    dimalttd: style.dimalttd,
    dimaltrnd: style.dimaltrnd,
    dimaltz: style.dimaltz as AcDbDimZeroSuppression,
    dimalttz: style.dimalttz as AcDbDimZeroSuppression,
    // tolerances.
    dimtol: dimFlag(style.dimtol),
    dimlim: dimFlag(style.dimlim),
    dimtp: style.dimtp,
    dimtm: style.dimtm,
    dimtdec: style.dimtdec,
    dimtfac: style.dimtfac,
    dimtolj: style.dimtolj as AcDbDimVerticalJustification,
    dimtzin: style.dimtzin as AcDbDimZeroSuppression
  })
}

// ---------------------------------------------------------------------------
// Block definitions (M4.2).
//
// The BLOCK-RECORD table is the block *definition* directory: one record per
// named block carrying its base point and the handles of its inner entities.
// We create a {@link AcDbBlockTableRecord} for every non-space record (a fresh
// database already owns *Model_Space / *Paper_Space, and `blockTable.add` keys by
// name, so re-adding a space would clobber the live model-space reference the
// entity mapper appends to). The returned list drives the ENTITY stage's second
// loop, which pages each block's own entities into its record so INSERT refs
// resolve against populated geometry.
// ---------------------------------------------------------------------------

/** A created block definition plus the entity count to page into it. */
interface MappedBlock {
  name: string
  record: AcDbBlockTableRecord
  entityCount: number
}

/** Fold the discrete acadrust block-flag booleans into DXF group 70 bits. */
function blockFlagsToBits(flags: AcadRustBlockRecordFlags): number {
  let value = AcDbBlockTableRecordFlag.None
  if (flags.anonymous) value |= AcDbBlockTableRecordFlag.Anonymous
  if (flags.has_attributes) value |= AcDbBlockTableRecordFlag.HasNonConstantAttributes
  if (flags.is_xref || flags.is_external) value |= AcDbBlockTableRecordFlag.Xref
  if (flags.is_xref_overlay) value |= AcDbBlockTableRecordFlag.XrefOverlay
  if (flags.is_xref_unloaded) value |= AcDbBlockTableRecordFlag.ExternallyDependent
  return value
}

function blockRecordToRecord(entry: AcadRustBlockRecord): AcDbBlockTableRecord {
  const bp = entry.base_point
  return new AcDbBlockTableRecord({
    name: entry.name,
    origin: new AcGePoint3d(bp?.x ?? 0, bp?.y ?? 0, bp?.z ?? 0),
    flags: blockFlagsToBits(entry.flags ?? ({} as AcadRustBlockRecordFlags)),
    blockInsertUnits: entry.units,
    explodability: entry.explodable ? 1 : 0,
    blockScaling: entry.scale_uniformly
      ? AcDbBlockScaling.Uniform
      : AcDbBlockScaling.Any,
    pathName: entry.xref_path ?? ''
  })
}

/**
 * Create block-table records from the BLOCK-RECORD section, skipping the model /
 * paper spaces (which the database already owns) and any name already present.
 * Returns the records the ENTITY stage should populate.
 */
function mapBlockRecords(
  db: AcDbDatabase,
  table: AcadRustBlockRecordTable
): MappedBlock[] {
  const mapped: MappedBlock[] = []
  const blockTable = db.tables.blockTable
  for (const entry of Object.values(table?.entries ?? {})) {
    if (!entry?.name) {
      continue
    }
    if (
      AcDbBlockTableRecord.isModelSapceName(entry.name) ||
      AcDbBlockTableRecord.isPaperSapceName(entry.name) ||
      blockTable.has(entry.name)
    ) {
      continue
    }
    const record = blockRecordToRecord(entry)
    blockTable.add(record)
    mapped.push({
      name: entry.name,
      record,
      entityCount: entry.entity_handles?.length ?? 0
    })
  }
  return mapped
}

// ---------------------------------------------------------------------------
// Entity mapping (M4.1).
//
// `read()` fetches model-space pages and routes each element here. A recognized
// variant is built into its data-model entity, appended to the model-space block
// record, then styled from the shared `common` block — mirroring the built-in DXF
// reader's insert-then-attribute order so the native db stays structurally
// comparable to the Architecture-A baseline. Unrecognized variants return false
// and advance `unknownEntityCount`.
// ---------------------------------------------------------------------------

/** Map one externally-tagged entity into `target`; false => unknown. */
function mapEntity(entity: AcadRustEntity, target: AcDbBlockTableRecord): boolean {
  switch (acadRustEntityKind(entity)) {
    case 'Line': {
      const line = entity.Line as AcadRustLinePayload | undefined
      if (!line?.common) {
        return false
      }
      const record = new AcDbLine(
        new AcGePoint3d(line.start.x, line.start.y, line.start.z),
        new AcGePoint3d(line.end.x, line.end.y, line.end.z)
      )
      if (line.thickness) {
        record.thickness = line.thickness
      }
      const n = line.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      place(target, record, line.common)
      return true
    }
    case 'Circle': {
      const c = entity.Circle as AcadRustCirclePayload | undefined
      if (!c?.common) {
        return false
      }
      const record = new AcDbCircle(
        new AcGePoint3d(c.center.x, c.center.y, c.center.z),
        c.radius,
        toVector(c.normal)
      )
      if (c.thickness) {
        record.thickness = c.thickness
      }
      place(target, record, c.common)
      return true
    }
    case 'Arc': {
      const a = entity.Arc as AcadRustArcPayload | undefined
      if (!a?.common) {
        return false
      }
      const record = new AcDbArc(
        new AcGePoint3d(a.center.x, a.center.y, a.center.z),
        a.radius,
        a.start_angle,
        a.end_angle,
        toVector(a.normal)
      )
      if (a.thickness) {
        record.thickness = a.thickness
      }
      place(target, record, a.common)
      return true
    }
    case 'Ellipse': {
      const e = entity.Ellipse as AcadRustEllipsePayload | undefined
      if (!e?.common) {
        return false
      }
      // acadrust stores the major-axis *endpoint* relative to the center (its
      // length is the major radius) plus a minor/major ratio; AcDbEllipse wants
      // the two radii directly.
      const major = toVector(e.major_axis)
      const majorRadius = Math.hypot(major.x, major.y, major.z)
      const record = new AcDbEllipse(
        new AcGePoint3d(e.center.x, e.center.y, e.center.z),
        toVector(e.normal),
        major,
        majorRadius,
        majorRadius * (e.minor_axis_ratio ?? 0),
        e.start_parameter,
        e.end_parameter
      )
      place(target, record, e.common)
      return true
    }
    case 'LwPolyline': {
      const p = entity.LwPolyline as AcadRustLwPolylinePayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbPolyline()
      const cw = p.constant_width ?? 0
      p.vertices.forEach((v, i) => {
        record.addVertexAt(
          i,
          new AcGePoint2d(v.location.x, v.location.y),
          v.bulge ?? 0,
          v.start_width || cw,
          v.end_width || cw
        )
      })
      record.closed = !!p.is_closed
      record.elevation = p.elevation ?? 0
      if (p.thickness) {
        record.thickness = p.thickness
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      place(target, record, p.common)
      return true
    }
    case 'Polyline': {
      // acadrust `Polyline` is the legacy POLYLINE carrying 3D vertices.
      const p = entity.Polyline as AcadRustPolylinePayload | undefined
      if (!p?.common) {
        return false
      }
      const bits = p.flags?.bits ?? 0
      const closed = (bits & 1) !== 0
      const polyType = bits & 4 ? AcDbPoly3dType.CubicSplinePoly : AcDbPoly3dType.SimplePoly
      const record = new AcDb3dPolyline(
        polyType,
        p.vertices.map(v => new AcGePoint3d(v.location.x, v.location.y, v.location.z)),
        closed
      )
      place(target, record, p.common)
      return true
    }
    case 'Polyline2D': {
      // Legacy heavy 2D POLYLINE: OCS vertices + elevation + per-vertex bulge.
      const p = entity.Polyline2D as AcadRustPolyline2DPayload | undefined
      if (!p?.common) {
        return false
      }
      const bits = p.flags?.bits ?? 0
      const closed = (bits & 1) !== 0
      let polyType = AcDbPoly2dType.SimplePoly
      if (bits & 4) polyType = AcDbPoly2dType.CubicSplinePoly
      else if (bits & 2) polyType = AcDbPoly2dType.FitCurvePoly
      const record = new AcDb2dPolyline(
        polyType,
        p.vertices.map(v => new AcGePoint3d(v.location.x, v.location.y, v.location.z)),
        p.elevation ?? 0,
        closed,
        p.start_width ?? 0,
        p.end_width ?? 0,
        p.vertices.map(v => v.bulge ?? 0)
      )
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      place(target, record, p.common)
      return true
    }
    case 'Polyline3D': {
      // acadrust `Polyline3D` is a 3D POLYLINE with named boolean flags and WCS
      // `position` vertices — a distinct serde shape from the legacy `Polyline`
      // variant above (which carries `flags.bits` + `location`). Corpus 3D
      // polylines are always simple (smooth_type "None", spline_fit false).
      const p = entity.Polyline3D as AcadRustPolyline3DPayload | undefined
      if (!p?.common) {
        return false
      }
      const flags = p.flags
      const polyType = flags?.spline_fit
        ? AcDbPoly3dType.CubicSplinePoly
        : AcDbPoly3dType.SimplePoly
      const record = new AcDb3dPolyline(
        polyType,
        p.vertices.map(v => new AcGePoint3d(v.position.x, v.position.y, v.position.z)),
        !!flags?.closed
      )
      place(target, record, p.common)
      return true
    }
    case 'Point': {
      // DXF POINT: WCS position + optional thickness/extrusion/PDMODE rotation.
      const p = entity.Point as AcadRustPointPayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbPoint()
      record.position = new AcGePoint3d(p.location.x, p.location.y, p.location.z)
      if (p.thickness) {
        record.thickness = p.thickness
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = toVector(n)
      }
      if (p.x_axis_angle) {
        record.ecsRotation = p.x_axis_angle
      }
      place(target, record, p.common)
      return true
    }
    case 'Solid': {
      // DXF SOLID (4-corner filled polygon). `is_trace` is false across the
      // corpus, so the entity always lands on AcDbSolid (dxfTypeName SOLID).
      const p = entity.Solid as AcadRustSolidPayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbSolid()
      record.setPointAt(0, new AcGePoint3d(p.first_corner.x, p.first_corner.y, p.first_corner.z))
      record.setPointAt(1, new AcGePoint3d(p.second_corner.x, p.second_corner.y, p.second_corner.z))
      record.setPointAt(2, new AcGePoint3d(p.third_corner.x, p.third_corner.y, p.third_corner.z))
      record.setPointAt(3, new AcGePoint3d(p.fourth_corner.x, p.fourth_corner.y, p.fourth_corner.z))
      if (p.thickness) {
        record.thickness = p.thickness
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = toVector(n)
      }
      place(target, record, p.common)
      return true
    }
    case 'Leader': {
      // DXF LEADER: a polyline leader through `vertices` with arrow/hookline
      // flags + owning dimension style. Corpus leaders are always straight and
      // carry no annotation (creation_type "NoAnnotation").
      const p = entity.Leader as AcadRustLeaderPayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbLeader()
      for (const v of p.vertices ?? []) {
        record.appendVertex(new AcGePoint3d(v.x, v.y, v.z))
      }
      record.isSplined = p.path_type === 'Spline'
      record.hasArrowHead = !!p.arrow_enabled
      record.hasHookLine = !!p.hookline_enabled
      record.isHookLineSameDirection = p.hookline_direction === 'Same'
      if (p.text_height) {
        record.textHeight = p.text_height
      }
      if (p.text_width) {
        record.textWidth = p.text_width
      }
      if (p.dimension_style) {
        record.dimensionStyle = p.dimension_style
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = toVector(n)
      }
      record.annoType = leaderAnnotationType(p.creation_type)
      place(target, record, p.common)
      return true
    }
    case 'MultiLeader': {
      // DXF MULTILEADER. Leader geometry comes from `context.leader_roots[]
      // .lines[].points`; content type / dogleg / landing / colors are top-level
      // scalars, style + annotation references are DWG handles bridged to object
      // ids. Deep per-field override enums (text attachment codes, block-attribute
      // rows, embedded MText) are deferred pending baseline evidence.
      const m = entity.MultiLeader as AcadRustMultiLeaderPayload | undefined
      if (!m?.common) {
        return false
      }
      const record = new AcDbMLeader()
      record.contentType = mLeaderContentType(m.content_type)
      record.leaderLineType = mLeaderLineType(m.path_type)
      for (const root of m.context?.leader_roots ?? []) {
        const li = record.addLeader()
        for (const line of root.lines ?? []) {
          record.addLeaderLine(
            li,
            (line.points ?? []).map(pt => new AcGePoint3d(pt.x, pt.y, pt.z))
          )
        }
      }
      record.doglegEnabled = !!m.enable_dogleg
      if (m.enable_dogleg && m.dogleg_length) {
        record.doglegLength = m.dogleg_length
      }
      if (m.enable_landing) {
        record.landingEnabled = true
      }
      const ctx = m.context
      if (ctx?.landing_gap) {
        record.landingGap = ctx.landing_gap
      }
      const arrow = ctx?.arrowhead_size ?? m.arrowhead_size
      if (arrow) {
        record.arrowheadSize = arrow
      }
      const tn = ctx?.text_normal
      if (tn && !(tn.x === 0 && tn.y === 0 && tn.z === 1)) {
        record.normal = toVector(tn)
      }
      if (m.line_color !== undefined) {
        record.leaderLineColor = colorToAcCm(m.line_color)
      }
      if (ctx?.text_color !== undefined) {
        record.textColor = colorToAcCm(ctx.text_color)
      }
      if (m.style_handle) {
        record.mleaderStyleId = dwgHandleToObjectId(m.style_handle)
      }
      if (m.arrowhead_handle) {
        record.arrowheadId = dwgHandleToObjectId(m.arrowhead_handle)
      }
      if (m.text_style_handle) {
        record.textStyleId = dwgHandleToObjectId(m.text_style_handle)
      }
      if (m.line_type_handle) {
        record.leaderLineTypeId = dwgHandleToObjectId(m.line_type_handle)
      }
      if (m.dwg_version !== undefined) {
        record.version = m.dwg_version
      }
      place(target, record, m.common)
      return true
    }
    case 'Ole2Frame': {
      // DXF OLE2FRAME: a display frame hosting an OLE 2 object. Only the frame
      // rectangle and object type are recoverable from the corpus; the embedded
      // `storage` compound-file binary is opaque and non-renderable, so it is
      // intentionally skipped (AcDbOle2Frame.setOleObject expects raw bytes).
      const p = entity.Ole2Frame as AcadRustOle2FramePayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbOle2Frame()
      if (p.upper_left_corner) {
        record.upperLeftCorner = new AcGePoint3d(
          p.upper_left_corner.x,
          p.upper_left_corner.y,
          p.upper_left_corner.z
        )
      }
      if (p.lower_right_corner) {
        record.lowerRightCorner = new AcGePoint3d(
          p.lower_right_corner.x,
          p.lower_right_corner.y,
          p.lower_right_corner.z
        )
      }
      record.oleObjectType = oleObjectType(p.ole_object_type)
      if (p.version !== undefined) {
        record.oleVersion = p.version
      }
      if (p.source_application) {
        record.userType = p.source_application
      }
      place(target, record, p.common)
      return true
    }
    case 'Spline': {
      const s = entity.Spline as AcadRustSplinePayload | undefined
      if (!s?.common) {
        return false
      }
      const closed = !!s.flags?.closed
      const controlPoints = (s.control_points ?? []).map(
        pt => new AcGePoint3d(pt.x, pt.y, pt.z)
      )
      const record = controlPoints.length
        ? AcDbSpline.fromControlPoints(
            controlPoints,
            s.knots ?? [],
            s.weights?.length ? s.weights : undefined,
            s.degree,
            closed
          )
        : AcDbSpline.fromFitPoints(
            (s.fit_points ?? []).map(pt => new AcGePoint3d(pt.x, pt.y, pt.z)),
            'Uniform',
            s.degree,
            closed
          )
      if (!record) {
        return false
      }
      place(target, record, s.common)
      return true
    }
    case 'Table': {
      // DXF ACAD_TABLE: an n x m grid of text cells. Rebuild the row/column grid
      // with per-row heights, per-column widths and text content so the table is
      // renderable; deep style / break / field / merged-cell / numeric-alignment
      // overrides are deferred (no baseline backing). Cells are addressed as
      // `row * numColumns + column` via setCell.
      const p = entity.Table as AcadRustTablePayload | undefined
      if (!p?.common) {
        return false
      }
      const rows = p.rows ?? []
      const cols = p.columns ?? []
      const record = new AcDbTable(p.block_name ?? p.name ?? '', rows.length, cols.length)
      cols.forEach((col, ci) => {
        if (col.width) {
          record.setColumnWidth(ci, col.width)
        }
      })
      rows.forEach((row, ri) => {
        if (row.height) {
          record.setRowHeight(ri, row.height)
        }
        ;(row.cells ?? []).forEach((cellPayload, ci) => {
          const text = tableCellText(cellPayload)
          if (!text) {
            return
          }
          record.setCell(ri * cols.length + ci, {
            text,
            attachmentPoint: record.attachmentPoint,
            cellType: 1,
            textHeight: tableCellTextHeight(cellPayload)
          })
        })
      })
      if (p.insertion_point) {
        record.position = new AcGePoint3d(
          p.insertion_point.x,
          p.insertion_point.y,
          p.insertion_point.z
        )
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = toVector(n)
      }
      const hd = p.horizontal_direction
      if (hd && !(hd.x === 1 && hd.y === 0 && hd.z === 0)) {
        record.horizontalDirection = new AcGeVector3d(hd.x, hd.y, hd.z)
      }
      if (p.table_style_handle) {
        record.tableStyleId = dwgHandleToObjectId(p.table_style_handle)
      }
      place(target, record, p.common)
      return true
    }
    case 'AttributeDefinition': {
      // DXF ATTDEF: a block-definition attribute template. `AcDbAttributeDefinition`
      // extends AcDbText exactly like AcDbAttribute (M4.5), so the display fields
      // fold the same way; the template carries `prompt` + `default_value` instead
      // of a concrete `value`.
      const p = entity.AttributeDefinition as AcadRustAttributeDefinitionPayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbAttributeDefinition()
      record.textString = p.default_value ?? ''
      record.prompt = p.prompt ?? ''
      record.position = p3(p.insertion_point)
      if (p.alignment_point) {
        record.alignmentPoint = p3(p.alignment_point)
        record.hasAlignmentPoint = true
      }
      record.height = p.height ?? 0
      record.rotation = p.rotation ?? 0
      record.widthFactor = p.width_factor ?? 1
      record.oblique = p.oblique_angle ?? 0
      if (p.text_style) {
        record.styleName = p.text_style
      }
      if (p.text_generation_flags) {
        record.generationFlag = p.text_generation_flags
      }
      record.horizontalMode = textHorizontalMode(p.horizontal_alignment)
      record.verticalMode = textVerticalMode(p.vertical_alignment)
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      record.tag = p.tag ?? ''
      record.fieldLength = p.field_length ?? 0
      const flags = p.flags
      record.isInvisible = !!flags?.invisible
      record.isConst = !!flags?.constant
      record.isVerifiable = !!flags?.verify
      record.isPreset = !!flags?.preset
      const multiline =
        !!p.is_multiline || p.mtext_flag === 'MultiLine' || p.mtext_flag === 'ConstantMultiLine'
      record.isMTextAttribute = multiline
      if (p.mtext_flag === 'ConstantMultiLine') {
        record.isConstMTextAttribute = true
      }
      record.lockPositionInBlock = !!p.lock_position || !!flags?.locked_position
      record.isReallyLocked = !!p.lock_position
      if (p.embedded_mtext) {
        record.mtext = buildMTextEntity(p.embedded_mtext)
      }
      place(target, record, p.common)
      return true
    }
    case 'MLine': {
      // DXF MLINE: a multiline along a reference path, one offset element per
      // MLINESTYLE line. Rebuild the vertex frames (position/direction/miter) and
      // per-element parameters; the `flags` string enum has no baseline group-70
      // backing and is deferred.
      const p = entity.MLine as AcadRustMLinePayload | undefined
      if (!p?.common) {
        return false
      }
      const record = new AcDbMLine()
      record.styleName = p.style_name ?? ''
      if (p.style_handle) {
        record.styleObjectHandle = dwgHandleToObjectId(p.style_handle)
      }
      record.scale = p.scale_factor ?? 1
      record.justification = mlineJustification(p.justification)
      if (p.start_point) {
        record.startPosition = new AcGePoint3d(p.start_point.x, p.start_point.y, p.start_point.z)
      }
      const n = p.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      if (p.style_element_count !== undefined) {
        record.styleCount = p.style_element_count
      }
      record.segments = (p.vertices ?? []).map(v => ({
        position: new AcGePoint3d(v.position.x, v.position.y, v.position.z),
        direction: new AcGeVector3d(v.direction.x, v.direction.y, v.direction.z),
        miterDirection: new AcGeVector3d(v.miter.x, v.miter.y, v.miter.z),
        elements: (v.segments ?? []).map(s => ({
          parameters: s.parameters,
          fillParameters: s.area_fill_parameters
        }))
      }))
      place(target, record, p.common)
      return true
    }
    case 'Insert': {
      // Block reference: placement transform is carried verbatim (the renderer
      // resolves `block_name` against the block table and applies scale/rotation
      // at draw time — this is the extreme-scale path, e.g. inserts at 1000x).
      // Attached ATTRIB values are appended *after* `place` so the INSERT is
      // already database-bound: `appendAttributes` commits each attribute's
      // handle via `syncAttributeDatabases`, which silently no-ops while the
      // owner has no database yet.
      const ins = entity.Insert as AcadRustInsertPayload | undefined
      if (!ins?.common || !ins.block_name) {
        return false
      }
      const record = new AcDbBlockReference(ins.block_name)
      record.position = new AcGePoint3d(
        ins.insert_point.x,
        ins.insert_point.y,
        ins.insert_point.z
      )
      record.scaleFactors = new AcGePoint3d(ins.x_scale, ins.y_scale, ins.z_scale)
      if (ins.rotation) {
        record.rotation = ins.rotation
      }
      const n = ins.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      if (ins.column_count > 1) {
        record.columnCount = ins.column_count
      }
      if (ins.row_count > 1) {
        record.rowCount = ins.row_count
      }
      if (ins.column_spacing) {
        record.columnSpacing = ins.column_spacing
      }
      if (ins.row_spacing) {
        record.rowSpacing = ins.row_spacing
      }
      place(target, record, ins.common)
      for (const a of ins.attributes ?? []) {
        if (!a?.common) {
          continue
        }
        const attrib = buildAttribute(a)
        record.appendAttributes(attrib)
        applyCommon(attrib, a.common)
      }
      return true
    }
    case 'Text': {
      // Single-line TEXT: OCS insertion point + normal are carried verbatim (the
      // entity maps them to WCS at draw time), the two alignment axes onto the
      // data-model horizontal/vertical modes, and the DXF group-71 generation
      // flag straight across (bit 2 backward / bit 4 upside-down match).
      const t = entity.Text as AcadRustTextPayload | undefined
      if (!t?.common || !t.insertion_point) {
        return false
      }
      const record = new AcDbText()
      record.textString = t.value ?? ''
      record.position = new AcGePoint3d(
        t.insertion_point.x,
        t.insertion_point.y,
        t.insertion_point.z
      )
      if (t.alignment_point) {
        record.alignmentPoint = new AcGePoint3d(
          t.alignment_point.x,
          t.alignment_point.y,
          t.alignment_point.z
        )
        record.hasAlignmentPoint = true
      }
      record.height = t.height
      record.rotation = t.rotation ?? 0
      record.widthFactor = t.width_factor ?? 1
      record.oblique = t.oblique_angle ?? 0
      if (t.style) {
        record.styleName = t.style
      }
      record.horizontalMode = textHorizontalMode(t.horizontal_alignment)
      record.verticalMode = textVerticalMode(t.vertical_alignment)
      if (t.thickness) {
        record.thickness = t.thickness
      }
      if (t.generation_flags) {
        record.generationFlag = t.generation_flags
      }
      const n = t.normal
      if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
        record.normal = new AcGeVector3d(n.x, n.y, n.z)
      }
      place(target, record, t.common)
      return true
    }
    case 'MText': {
      // Multiline MTEXT: see {@link buildMTextEntity} for the field mapping.
      const m = entity.MText as AcadRustMTextPayload | undefined
      if (!m?.common || !m.insertion_point) {
        return false
      }
      place(target, buildMTextEntity(m), m.common)
      return true
    }
    case 'Dimension': {
      // DIMENSION is a nested externally-tagged enum (`{"Linear":{"base",…}}`).
      // The anonymous `*D…` block that carries the rendered geometry is already
      // created + paged by the M4.2 block layer, so the dimension resolves by
      // `dimBlockId = block_name`; we rebuild the correct subtype from the
      // definition points and fold the shared `base` onto the data-model fields.
      const built = buildDimension(
        entity.Dimension as AcadRustDimensionVariants | undefined
      )
      if (!built) {
        return false
      }
      place(target, built.entity, built.common)
      return true
    }
    case 'Hatch': {
      // HATCH boundary loops are authored in OCS and carried verbatim (the
      // entity maps `elevation` + `normal` to WCS at draw time), each boundary
      // path becoming one or more {@link AcGeLoop2d} / polyline loops added to
      // the hatch — mirroring the DXF reader's edge -> geometry conversion.
      const built = buildHatch(entity.Hatch as AcadRustHatchPayload | undefined)
      if (!built) {
        return false
      }
      place(target, built.entity, built.common)
      return true
    }
    default:
      return false
  }
}

/**
 * Apply the shared `common` block (layer / color / linetype / scale / lineweight
 * / transparency / visibility) onto an entity already owned by the database.
 * Runs after `appendEntity` so style resolution sees a bound record.
 */
function applyCommon(entity: AcDbEntity, c: AcadRustEntityCommon): void {
  entity.layer = c.layer || '0'
  entity.color = colorToAcCm(c.color)
  entity.lineType = c.linetype || 'ByLayer'
  entity.linetypeScale = c.linetype_scale ?? 1
  entity.lineWeight = lineWeightToGi(c.line_weight)
  entity.transparency = transparencyToAcCm(c.transparency)
  entity.visibility = !c.invisible
}

/** Convert an acadrust point/vector triple into a data-model vector. */
function toVector(p: AcadRustPoint3d): AcGeVector3d {
  return new AcGeVector3d(p.x, p.y, p.z)
}

/**
 * Append an entity to the model-space block record and style it from its shared
 * `common` block. Kept as one step so every geometry branch uses the same
 * insert-then-attribute order as the built-in DXF reader.
 */
function place(target: AcDbBlockTableRecord, entity: AcDbEntity, common: AcadRustEntityCommon): void {
  target.appendEntity(entity)
  applyCommon(entity, common)
}

// ---------------------------------------------------------------------------
// Text alignment translation (M4.3).
//
// acadrust serializes the TEXT/MTEXT alignment enums as PascalCase variant
// names; the data-model uses numeric enums whose values coincide with the DXF
// group codes. These helpers are the explicit name -> value bridge (a `switch`
// so a future upstream variant fails to the default rather than mis-indexing).
// ---------------------------------------------------------------------------

/** acadrust LEADER `creation_type` -> {@link AcDbLeaderAnnotationType}. */
function leaderAnnotationType(v: string | undefined): AcDbLeaderAnnotationType {
  switch (v) {
    case 'MText':
      return AcDbLeaderAnnotationType.MText
    case 'Fcf':
      return AcDbLeaderAnnotationType.Fcf
    case 'BlockReference':
      return AcDbLeaderAnnotationType.BlockReference
    default:
      return AcDbLeaderAnnotationType.NoAnnotation
  }
}

/** acadrust MULTILEADER `content_type` -> {@link AcDbMLeaderContentType}. */
function mLeaderContentType(v: string | undefined): AcDbMLeaderContentType {
  switch (v) {
    case 'Block':
      return AcDbMLeaderContentType.BlockContent
    case 'MText':
      return AcDbMLeaderContentType.MTextContent
    case 'Tolerance':
      return AcDbMLeaderContentType.ToleranceContent
    default:
      return AcDbMLeaderContentType.NoneContent
  }
}

/** acadrust MULTILEADER `path_type` -> {@link AcDbMLeaderLineType}. */
function mLeaderLineType(v: string | undefined): AcDbMLeaderLineType {
  switch (v) {
    case 'Spline':
    case 'SplineFit':
      return AcDbMLeaderLineType.SplineLeader
    default:
      return AcDbMLeaderLineType.StraightLeader
  }
}

/** acadrust OLE2FRAME `ole_object_type` -> {@link AcDbOleObjectType}. */
function oleObjectType(v: string | undefined): AcDbOleObjectType {
  switch (v) {
    case 'Linked':
    case 'Link':
      return AcDbOleObjectType.Link
    case 'Static':
      return AcDbOleObjectType.Static
    default:
      return AcDbOleObjectType.Embedded
  }
}

/** Text content of an ACAD_TABLE cell (first non-empty Value content). */
function tableCellText(cell: AcadRustTableCellPayload | undefined): string {
  if (!cell || cell.cell_type === 'Block') {
    return ''
  }
  for (const c of cell.contents ?? []) {
    const v = c.value
    if (!v) {
      continue
    }
    const text = v.formatted_value ?? v.text
    if (text) {
      return text
    }
  }
  return ''
}

/** Text height of an ACAD_TABLE cell (first content that carries one). */
function tableCellTextHeight(cell: AcadRustTableCellPayload | undefined): number {
  for (const c of cell?.contents ?? []) {
    if (c.text_height) {
      return c.text_height
    }
  }
  return 0
}

/** acadrust MLINE `justification` name -> {@link AcDbMLineJustification}. */
function mlineJustification(v: string | undefined): AcDbMLineJustification {
  switch (v) {
    case 'Top':
      return AcDbMLineJustification.Top
    case 'Bottom':
      return AcDbMLineJustification.Bottom
    default:
      return AcDbMLineJustification.Zero
  }
}

function textHorizontalMode(
  v: AcadRustTextHorizontalAlignment | undefined
): AcDbTextHorizontalMode {
  switch (v) {
    case 'Center':
      return AcDbTextHorizontalMode.CENTER
    case 'Right':
      return AcDbTextHorizontalMode.RIGHT
    case 'Aligned':
      return AcDbTextHorizontalMode.ALIGNED
    case 'Middle':
      return AcDbTextHorizontalMode.MIDDLE
    case 'Fit':
      return AcDbTextHorizontalMode.FIT
    case 'Left':
    default:
      return AcDbTextHorizontalMode.LEFT
  }
}

function textVerticalMode(
  v: AcadRustTextVerticalAlignment | undefined
): AcDbTextVerticalMode {
  switch (v) {
    case 'Bottom':
      return AcDbTextVerticalMode.BOTTOM
    case 'Middle':
      return AcDbTextVerticalMode.MIDDLE
    case 'Top':
      return AcDbTextVerticalMode.TOP
    case 'Baseline':
    default:
      return AcDbTextVerticalMode.BASELINE
  }
}

function mTextAttachmentPoint(
  v: AcadRustAttachmentPoint | undefined
): AcGiMTextAttachmentPoint {
  switch (v) {
    case 'TopCenter':
      return AcGiMTextAttachmentPoint.TopCenter
    case 'TopRight':
      return AcGiMTextAttachmentPoint.TopRight
    case 'MiddleLeft':
      return AcGiMTextAttachmentPoint.MiddleLeft
    case 'MiddleCenter':
      return AcGiMTextAttachmentPoint.MiddleCenter
    case 'MiddleRight':
      return AcGiMTextAttachmentPoint.MiddleRight
    case 'BottomLeft':
      return AcGiMTextAttachmentPoint.BottomLeft
    case 'BottomCenter':
      return AcGiMTextAttachmentPoint.BottomCenter
    case 'BottomRight':
      return AcGiMTextAttachmentPoint.BottomRight
    case 'TopLeft':
    default:
      return AcGiMTextAttachmentPoint.TopLeft
  }
}

function mTextFlowDirection(
  v: AcadRustDrawingDirection | undefined
): AcGiMTextFlowDirection {
  switch (v) {
    case 'TopToBottom':
      return AcGiMTextFlowDirection.TOP_TO_BOTTOM
    case 'ByStyle':
      return AcGiMTextFlowDirection.BY_STYLE
    case 'LeftToRight':
    default:
      return AcGiMTextFlowDirection.LEFT_TO_RIGHT
  }
}

/** MTEXT line-spacing style (DXF 73): `AtLeast` = 1, `Exactly` = 2. */
function mTextLineSpacingStyle(v: AcadRustLineSpacingStyle | undefined): number {
  return v === 'Exactly' ? 2 : 1
}

/**
 * Build an unplaced {@link AcDbMText} from an MTEXT payload: insertion point is
 * the attachment anchor; the word-wrap `rectangle_width` maps to `width`, and
 * the attachment/flow/line-spacing enums translate onto their data-model
 * values. Background color and the R2018 column block stay unmapped. Shared
 * with the multiline-ATTRIB embedded payload (see {@link buildAttribute}).
 */
function buildMTextEntity(m: AcadRustMTextPayload): AcDbMText {
  const record = new AcDbMText()
  record.contents = m.value ?? ''
  record.location = new AcGePoint3d(
    m.insertion_point.x,
    m.insertion_point.y,
    m.insertion_point.z
  )
  record.height = m.height
  record.width = m.rectangle_width ?? 0
  record.rotation = m.rotation ?? 0
  if (m.style) {
    record.styleName = m.style
  }
  record.attachmentPoint = mTextAttachmentPoint(m.attachment_point)
  record.drawingDirection = mTextFlowDirection(m.drawing_direction)
  record.lineSpacingFactor = m.line_spacing_factor ?? 1
  record.lineSpacingStyle = mTextLineSpacingStyle(m.line_spacing_style)
  record.backgroundFill = (m.background_fill_flags & 1) !== 0
  if (m.extents_width) {
    record.extentsWidth = m.extents_width
  }
  const n = m.normal
  if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
    record.normal = new AcGeVector3d(n.x, n.y, n.z)
  }
  return record
}

/**
 * Build an unplaced {@link AcDbAttribute} (ATTRIB) from an insert-carried
 * attribute. Text-display fields mirror the TEXT branch (the two alignment
 * axes reuse {@link textHorizontalMode}/{@link textVerticalMode} — the acadrust
 * enums are the same variant set), then the attribute-only surface is folded
 * on: `tag`/`fieldLength`, the behavior flags (serialized as a boolean struct,
 * not a bit mask — the setters handle the bits), position locking, and the
 * multiline marker. The R2018+ `embedded_mtext` becomes the internal
 * {@link AcDbMText} (its setter re-marks the multiline bit). The record is
 * returned *unplaced* and *unstyled*: the INSERT branch appends it via
 * `appendAttributes` (owner/handle binding) then applies its own `common`.
 */
function buildAttribute(a: AcadRustAttribute): AcDbAttribute {
  const record = new AcDbAttribute()
  record.textString = a.value ?? ''
  record.position = p3(a.insertion_point)
  if (a.alignment_point) {
    record.alignmentPoint = p3(a.alignment_point)
    record.hasAlignmentPoint = true
  }
  record.height = a.height ?? 0
  record.rotation = a.rotation ?? 0
  record.widthFactor = a.width_factor ?? 1
  record.oblique = a.oblique_angle ?? 0
  if (a.text_style) {
    record.styleName = a.text_style
  }
  if (a.text_generation_flags) {
    record.generationFlag = a.text_generation_flags
  }
  record.horizontalMode = textHorizontalMode(a.horizontal_alignment)
  record.verticalMode = textVerticalMode(a.vertical_alignment)
  const n = a.normal
  if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
    record.normal = new AcGeVector3d(n.x, n.y, n.z)
  }
  record.tag = a.tag ?? ''
  record.fieldLength = a.field_length ?? 0
  const flags = a.flags
  record.isInvisible = !!flags?.invisible
  record.isConst = !!flags?.constant
  record.isVerifiable = !!flags?.verify
  record.isPreset = !!flags?.preset
  const multiline =
    !!a.is_multiline || a.mtext_flag === 'MultiLine' || a.mtext_flag === 'ConstantMultiLine'
  record.isMTextAttribute = multiline
  if (a.mtext_flag === 'ConstantMultiLine') {
    record.isConstMTextAttribute = true
  }
  record.lockPositionInBlock = !!a.lock_position || !!flags?.locked_position
  record.isReallyLocked = !!a.lock_position
  if (a.embedded_mtext) {
    record.mtext = buildMTextEntity(a.embedded_mtext)
  }
  return record
}

// ---------------------------------------------------------------------------
// Dimension mapping (M4.4).
//
// acadrust emits `Dimension` as a nested externally-tagged enum: one sub-variant
// key (`Linear`/`Aligned`/…) whose value nests a shared `base` plus the
// subtype-specific definition points. We rebuild the matching data-model
// dimension class from those points (the constructor order mirrors the DXF
// reader: extension-line origins then the dimension-line / arc / chord point),
// then fold the `base` onto the shared {@link AcDbDimension} fields. The kind
// code (DXF group 70 low bits) plus the user-positioned text bit are set so the
// record is structurally comparable to the Architecture-A output.
// ---------------------------------------------------------------------------

/** A built entity plus the `common` block to style it from. */
interface MappedEntity {
  entity: AcDbEntity
  common: AcadRustEntityCommon
}

/** Build an {@link AcGePoint3d} from an acadrust point payload. */
function p3(p: AcadRustPoint3d | undefined): AcGePoint3d {
  return new AcGePoint3d(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0)
}

/** acadrust `DimensionType` name -> DXF group-70 kind code (0/1/2/3/4/5/6/8/9). */
function dimensionTypeCode(t: AcadRustDimensionType | undefined): number {
  switch (t) {
    case 'Aligned':
      return 1
    case 'Angular':
      return 2
    case 'Diameter':
      return 3
    case 'Radius':
      return 4
    case 'Angular3Point':
      return 5
    case 'Ordinate':
      return 6
    case 'ArcLength':
      return 8
    case 'LargeRadial':
      return 9
    case 'Linear':
    default:
      return 0
  }
}

/** Fold the shared `DimensionBase` onto a built {@link AcDbDimension}. */
function applyDimensionBase(rec: AcDbDimension, b: AcadRustDimensionBase): void {
  if (b.block_name) {
    rec.dimBlockId = b.block_name
  }
  if (b.style_name) {
    rec.dimensionStyleName = b.style_name
  }
  rec.dimensionText = b.user_text ?? b.text ?? null
  rec.measurement = b.actual_measurement
  rec.textPosition = p3(b.text_middle_point)
  rec.dimBlockPosition = p3(b.insertion_point)
  rec.textRotation = b.text_rotation ?? 0
  rec.horizontalRotation = b.horizontal_direction ?? 0
  rec.attachmentPoint = mTextAttachmentPoint(b.attachment_point)
  rec.textLineSpacingFactor = b.line_spacing_factor ?? 1
  rec.textLineSpacingStyle = (b.line_spacing_style ?? 1) as AcDbLineSpacingStyle
  rec.dxfVersion = b.version ?? 0
  rec.dimensionType =
    dimensionTypeCode(b.dimension_type) | (b.text_user_positioned ? 32 : 0)
  const n = b.normal
  if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
    rec.normal = new AcGeVector3d(n.x, n.y, n.z)
  }
}

/** Build the concrete dimension subtype, or `undefined` for an unmapped variant. */
function buildDimension(
  dim: AcadRustDimensionVariants | undefined
): MappedEntity | undefined {
  if (!dim) {
    return undefined
  }
  if (dim.Linear) {
    const d = dim.Linear
    const rec = new AcDbRotatedDimension(
      p3(d.first_point),
      p3(d.second_point),
      p3(d.definition_point)
    )
    rec.rotation = d.rotation ?? 0
    rec.oblique = d.ext_line_rotation ?? 0
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Aligned) {
    const d = dim.Aligned
    const rec = new AcDbAlignedDimension(
      p3(d.first_point),
      p3(d.second_point),
      p3(d.definition_point)
    )
    rec.oblique = d.ext_line_rotation ?? 0
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Radius) {
    const d = dim.Radius
    // center = angle_vertex (DXF 15), chord point on the curve = definition_point.
    const rec = new AcDbRadialDimension(
      p3(d.angle_vertex),
      p3(d.definition_point),
      d.leader_length ?? 0
    )
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Diameter) {
    const d = dim.Diameter
    // near chord = angle_vertex, far chord = definition_point (leader length).
    const rec = new AcDbDiametricDimension(
      p3(d.angle_vertex),
      p3(d.definition_point),
      d.leader_length ?? 0
    )
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Angular3Pt || dim.Angular2Ln) {
    // Both angular flavors collapse onto the 3-point class exactly as the DXF
    // reader does (2-line: center = angle vertex, arc sample = definition point).
    const d = (dim.Angular3Pt ?? dim.Angular2Ln) as AcadRustDimensionAngularPayload
    const rec = new AcDb3PointAngularDimension(
      p3(d.angle_vertex),
      p3(d.first_point),
      p3(d.second_point),
      p3(d.definition_point)
    )
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Ordinate) {
    const d = dim.Ordinate
    const rec = new AcDbOrdinateDimension(
      p3(d.feature_location),
      p3(d.leader_endpoint)
    )
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  if (dim.Arc) {
    const d = dim.Arc
    const rec = new AcDbArcDimension(
      p3(d.center_point),
      p3(d.first_extension_point),
      p3(d.second_extension_point),
      p3(d.definition_point)
    )
    applyDimensionBase(rec, d.base)
    return { entity: rec, common: d.base.common }
  }
  // LargeRadial has no dedicated data-model counterpart yet -> stays unknown.
  return undefined
}

// ---------------------------------------------------------------------------
// Hatch mapping (M4.4).
//
// The acadrust boundary `paths` are converted to geometry-engine 2D curves using
// the same constructors the DXF reader's `dxfInFields` uses (AcGeLine2d /
// AcGeCircArc2d / AcGeEllipseArc2d / AcGeSpline3d, or an AcGePolyline2d for a
// polyline boundary), then grouped into closed loops via
// {@link AcGeLoop2d.buildFromEdges}. All geometry is OCS and carried verbatim —
// `elevation` + `normal` map to WCS at draw time — so the native hatch is
// structurally comparable to the DXF baseline.
// ---------------------------------------------------------------------------

/** acadrust `HatchPatternType` name -> {@link AcDbHatchPatternType}. */
function hatchPatternType(t: AcadRustHatchPayload['pattern_type']): AcDbHatchPatternType {
  switch (t) {
    case 'UserDefined':
      return AcDbHatchPatternType.UserDefined
    case 'Custom':
      return AcDbHatchPatternType.Custom
    case 'Predefined':
    default:
      return AcDbHatchPatternType.Predefined
  }
}

/** acadrust `HatchStyleType` name -> {@link AcDbHatchStyle}. */
function hatchStyle(s: AcadRustHatchPayload['style']): AcDbHatchStyle {
  switch (s) {
    case 'Outer':
      return AcDbHatchStyle.Outer
    case 'Ignore':
      return AcDbHatchStyle.Ignore
    case 'Normal':
    default:
      return AcDbHatchStyle.Normal
  }
}

/** Convert one boundary {@link AcadRustHatchBoundaryEdge} to a geometry curve. */
function hatchEdgeToCurve(
  edge: AcadRustHatchBoundaryEdge
): AcGeBoundaryEdgeType | undefined {
  if ('Line' in edge) {
    const l = edge.Line as AcadRustHatchLineEdge
    return new AcGeLine2d(
      new AcGePoint2d(l.start.x, l.start.y),
      new AcGePoint2d(l.end.x, l.end.y)
    )
  }
  if ('CircularArc' in edge) {
    const a = edge.CircularArc as AcadRustHatchCircularArcEdge
    // acadrust angles are radians; the 5th constructor arg is `clockwise`.
    return new AcGeCircArc2d(
      new AcGePoint2d(a.center.x, a.center.y),
      a.radius,
      a.start_angle,
      a.end_angle,
      !a.counter_clockwise
    )
  }
  if ('EllipticArc' in edge) {
    const e = edge.EllipticArc as AcadRustHatchEllipticArcEdge
    const major = Math.hypot(e.major_axis_endpoint.x, e.major_axis_endpoint.y)
    const minor = major * (e.minor_axis_ratio ?? 0)
    const rotation = Math.atan2(e.major_axis_endpoint.y, e.major_axis_endpoint.x)
    let start = e.start_angle
    let end = e.end_angle
    if (!e.counter_clockwise) {
      start = Math.PI * 2 - start
      end = Math.PI * 2 - end
    }
    return new AcGeEllipseArc2d(
      new AcGePoint3d(e.center.x, e.center.y, 0),
      major,
      minor,
      start,
      end,
      !e.counter_clockwise,
      rotation
    )
  }
  if ('Spline' in edge) {
    const s = edge.Spline as AcadRustHatchSplineEdge
    const controlPoints = s.control_points ?? []
    return (
      AcGeSpline3d.fromDwgSplineEdge({
        degree: s.degree,
        numberOfControlPoints: controlPoints.length,
        numberOfKnots: (s.knots ?? []).length,
        numberOfFitData: (s.fit_points ?? []).length,
        knots: s.knots ?? [],
        controlPoints: controlPoints.map(pt => ({
          x: pt.x,
          y: pt.y,
          z: 0,
          weight: s.rational ? pt.z : undefined
        })),
        fitDatum: (s.fit_points ?? []).map(pt => ({ x: pt.x, y: pt.y, z: 0 })),
        startTangent: null,
        endTangent: null
      }) ?? undefined
    )
  }
  return undefined
}

/** A polyline boundary edge -> a closed {@link AcGePolyline2d} loop (z = bulge). */
function hatchPolylineLoop(edge: AcadRustHatchPolylineEdge): AcGePolyline2d {
  const polyline = new AcGePolyline2d()
  polyline.closed = !!edge.is_closed
  ;(edge.vertices ?? []).forEach((v, i) => {
    polyline.addVertexAt(i, { x: v.x, y: v.y, bulge: v.z ?? 0 })
  })
  return polyline
}

/** Convert one boundary path into one or more loops appended to `rec`. */
function addHatchPathLoop(rec: AcDbHatch, path: AcadRustHatchBoundaryPath): void {
  const edges = path.edges ?? []
  if (edges.length === 0) {
    return
  }
  const poly =
    edges.length === 1 && 'Polyline' in edges[0] ? edges[0].Polyline : undefined
  if (poly) {
    rec.add(hatchPolylineLoop(poly))
    return
  }
  const geoEdges: AcGeBoundaryEdgeType[] = []
  for (const edge of edges) {
    const curve = hatchEdgeToCurve(edge)
    if (curve) {
      geoEdges.push(curve)
    }
  }
  if (geoEdges.length === 0) {
    return
  }
  const loops = AcGeLoop2d.buildFromEdges(geoEdges)
  if (loops.length > 0) {
    loops.forEach(loop => rec.add(loop))
  } else {
    rec.add(new AcGeLoop2d(geoEdges))
  }
}

/** Build an {@link AcDbHatch} from the acadrust payload, or `undefined`. */
function buildHatch(
  h: AcadRustHatchPayload | undefined
): MappedEntity | undefined {
  if (!h?.common || !Array.isArray(h.paths)) {
    return undefined
  }
  const rec = new AcDbHatch()
  rec.isSolidFill = !!h.is_solid
  rec.patternType = hatchPatternType(h.pattern_type)
  if (h.pattern?.name) {
    rec.patternName = h.pattern.name
  }
  rec.patternAngle = h.pattern_angle ?? 0
  rec.patternScale = h.pattern_scale ?? 1
  rec.patternDouble = !!h.is_double
  rec.hatchStyle = hatchStyle(h.style)
  rec.associative = !!h.is_associative
  rec.elevation = h.elevation ?? 0
  const n = h.normal
  if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
    rec.normal = new AcGeVector3d(n.x, n.y, n.z)
  }
  for (const path of h.paths) {
    addHatchPathLoop(rec, path)
  }
  return { entity: rec, common: h.common }
}
