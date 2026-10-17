import {
  AcCmColor,
  AcCmTransparency,
  AcDbArc,
  AcDbAttribute,
  AcDbBlockReference,
  AcDbBlockTableRecord,
  AcDbCircle,
  type AcDbConversionProgressCallback,
  type AcDbDatabase,
  AcDbDatabaseConverter,
  type AcDbDatabaseConverterReadOptions,
  type AcDbDictionary,
  AcDbEllipse,
  AcDbEntity,
  AcDbHatch,
  AcDbHatchPatternType,
  AcDbHatchStyle,
  AcDbLayerTableRecord,
  AcDbLine,
  AcDbLinetypeTableRecord,
  AcDbMText,
  AcDbOle2Frame,
  AcDbOleObjectType,
  AcDbPoint,
  AcDbPolyline,
  AcDbRasterImage,
  AcDbRasterImageClipBoundaryType,
  AcDbRasterImageDef,
  AcDbSolid,
  AcDbSpline,
  AcDbText,
  AcDbTextStyleTableRecord,
  type AcGeBoundaryEdgeType,
  AcGeCircArc2d,
  AcGeEllipseArc2d,
  AcGeLine2d,
  AcGeLoop2d,
  AcGeMatrix3d,
  AcGePoint2d,
  AcGePoint3d,
  AcGePolyline2d,
  AcGeSpline3d,
  AcGeVector3d,
  type AcGiLineTypePatternElement,
  AcGiLineWeight,
  AcGiMTextAttachmentPoint
} from '@mlightcad/data-model'
import {
  Arc,
  type BlockRecord,
  type CadDocument,
  Circle,
  type Color,
  DwgReader,
  Ellipse,
  Entity,
  Hatch,
  type HatchBoundaryPath,
  HatchBoundaryPathArc,
  HatchBoundaryPathEllipse,
  HatchBoundaryPathLine,
  HatchBoundaryPathPolyline,
  HatchBoundaryPathSpline,
  HatchPatternType,
  ImageDisplayFlags,
  Insert,
  Line,
  type LineTypeSegment,
  LineTypeShapeFlags,
  LineWeightType,
  LwPolyline,
  MText,
  Ole2Frame,
  Point,
  RasterImage,
  Solid,
  Spline,
  TextEntity,
  type Transparency
} from '@node-projects/acad-ts'

/**
 * Experimental DWG converter built on [acad-ts](https://github.com/node-projects/acad-ts)
 * (`@node-projects/acad-ts`, MIT, pure TypeScript — no WASM).
 *
 * Purpose: validate whether acad-ts can serve as a DWG parser for this viewer.
 * Unlike the acad-rust converters (which shuttle DWG through DXF or a Rust/WASM
 * section dump), this one parses the DWG straight into an acad-ts `CadDocument`
 * and then maps that object model *directly* into the data-model
 * {@link AcDbDatabase} — a genuine end-to-end exercise of acad-ts's reader.
 *
 * Coverage (v1, geometry + text + block references):
 *   LINE, CIRCLE, ARC, ELLIPSE, LWPOLYLINE, SPLINE, TEXT, MTEXT, INSERT, POINT,
 *   SOLID, HATCH, IMAGE, OLE2FRAME, plus the LAYER / LTYPE / STYLE symbol tables and
 *   non-layout BLOCK records. Any other entity type is counted as
 *   `unknownEntityCount` (so the console / progress `data` reports how much of a
 *   drawing acad-ts surfaces that this mapper does not yet fold).
 */
export class AcDbAcadTsConverter extends AcDbDatabaseConverter<unknown> {
  async read(
    data: ArrayBuffer,
    db: AcDbDatabase,
    options?: AcDbDatabaseConverterReadOptions
  ): Promise<void> {
    const progress = options?.progress ?? this.progress

    await emit(progress, 2, 'PARSE', 'START')
    let doc: CadDocument
    try {
      doc = DwgReader.readFromStream(data)
    } catch (error) {
      await emit(progress, 2, 'PARSE', 'ERROR')
      throw error
    }
    await emit(progress, 20, 'PARSE', 'END')

    // Symbol tables first so entities can resolve layer / linetype / style by name.
    await emit(progress, 24, 'LAYER', 'START')
    mapLayers(db, doc)
    await emit(progress, 28, 'LAYER', 'END')

    await emit(progress, 28, 'LTYPE', 'START')
    mapLineTypes(db, doc)
    await emit(progress, 32, 'LTYPE', 'END')

    await emit(progress, 32, 'STYLE', 'START')
    mapTextStyles(db, doc)
    await emit(progress, 36, 'STYLE', 'END')

    await emit(progress, 36, 'BLOCK_RECORD', 'START')
    const blockTargets = mapBlockRecords(db, doc)
    await emit(progress, 40, 'BLOCK_RECORD', 'END')

    // Model-space entities.
    await emit(progress, 42, 'ENTITY', 'START')
    const stats = { unknownEntityCount: 0 }
    const model = doc.modelSpace
    if (model) {
      const target = db.tables.blockTable.modelSpace
      for (const entity of model.entities) {
        if (entity instanceof Entity) {
          if (!mapEntity(entity, target, db)) {
            stats.unknownEntityCount++
          }
        }
      }
    }
    await emit(progress, 80, 'ENTITY', 'END', stats)

    // Block-definition contents (rendered on demand by the block renderer).
    await emit(progress, 82, 'BLOCK', 'START')
    for (const { source, record } of blockTargets) {
      for (const entity of source.entities) {
        if (entity instanceof Entity) {
          if (!mapEntity(entity, record, db)) {
            stats.unknownEntityCount++
          }
        }
      }
    }
    await emit(progress, 98, 'BLOCK', 'END', stats)

    await emit(progress, 100, 'END', 'END', stats)
  }
}

// ---------------------------------------------------------------------------
// Progress plumbing.
// ---------------------------------------------------------------------------

async function emit(
  progress: AcDbConversionProgressCallback | undefined,
  percentage: number,
  stage: Parameters<AcDbConversionProgressCallback>[1],
  stageStatus: Parameters<AcDbConversionProgressCallback>[2],
  data?: unknown
): Promise<void> {
  if (!progress) {
    return
  }
  await progress(percentage, stage, stageStatus, data)
}

// ---------------------------------------------------------------------------
// Symbol-table mapping.
//
// The data-model database already owns the default records ("0" layer,
// ByLayer/ByBlock/Continuous linetypes, Standard style); re-adding them throws,
// so every `add` is guarded. A verification converter should never abort on a
// duplicate default — it should skip and carry on.
// ---------------------------------------------------------------------------

function mapLayers(db: AcDbDatabase, doc: CadDocument): void {
  for (const layer of iter(doc.layers)) {
    guardAdd(() =>
      db.tables.layerTable.add(
        new AcDbLayerTableRecord({
          name: layer.name,
          color: colorToAcCm(layer.color),
          isOff: !layer.isOn,
          isPlottable: layer.plotFlag,
          linetype: layer.lineType?.name ?? 'Continuous',
          lineWeight: lineWeightToGi(layer.lineWeight)
        })
      )
    )
  }
}

// A linetype pattern element carrying the renderer's style-name alias. The
// data-model record schema (`AcGiLineTypePatternElement`) has no `style` field,
// but the three-renderer's `resolveTextStyleForElement` falls back to
// `element.style` (a STYLE *name*) via `textStyleTable.getAt(name)` whenever
// `styleObjectId` is absent — which lets acad-ts embed the complex-linetype
// font without the handle→objectId remap the acad-rust route needs.
type LinetypePatternElement = AcGiLineTypePatternElement & { style?: string }

function mapLineTypes(db: AcDbDatabase, doc: CadDocument): void {
  for (const lineType of iter(doc.lineTypes)) {
    guardAdd(() =>
      db.tables.linetypeTable.add(
        new AcDbLinetypeTableRecord({
          name: lineType.name,
          description: lineType.description ?? undefined,
          totalPatternLength: lineType.patternLength,
          // Dash lengths plus embedded complex SHAPE/TEXT segments (DXF group 74
          // bit flags 1/2/4). Complex segments drive the renderer's glyph
          // placement so patterns like `jtbj-1` (井田边界) keep their boundary
          // markers instead of collapsing to plain dashes.
          pattern: lineType.segments.map(linetypeSegmentToPattern)
        })
      )
    )
  }
}

/**
 * Map one acad-ts `LineTypeSegment` to a data-model pattern element, preserving
 * the DXF group-74 complex flags. The segment's `shapeFlags` bit layout
 * (RotationIsAbsolute=1 / Text=2 / Shape=4) is identical to the renderer's
 * `COMPLEX_LTYPE_*` mask, so the flags transfer directly.
 */
function linetypeSegmentToPattern(
  segment: LineTypeSegment
): LinetypePatternElement {
  const simple: LinetypePatternElement = {
    elementLength: segment.length,
    elementTypeFlag: 0
  }
  const flags = segment.shapeFlags ?? LineTypeShapeFlags.None
  const isShape =
    (flags & LineTypeShapeFlags.Shape) !== 0 &&
    segment.shapeNumber != null &&
    segment.shapeNumber !== 0
  const isText =
    (flags & LineTypeShapeFlags.Text) !== 0 &&
    typeof segment.text === 'string' &&
    segment.text.length > 0
  // A shape/text bit with no payload is a pseudo-complex dash: the baseline
  // DXF writes those as plain segments (group 74 = 0), and keeping them
  // complex would stamp an empty glyph on every pattern cycle.
  if (!isShape && !isText) {
    return simple
  }
  let flag = 0
  if ((flags & LineTypeShapeFlags.RotationIsAbsolute) !== 0) {
    flag |= 1
  }
  flag |= isShape ? 4 : 2
  const element: LinetypePatternElement = {
    elementLength: segment.length,
    elementTypeFlag: flag,
    scale: segment.scale,
    rotation: segment.rotation,
    offsetX: segment.offset?.x ?? 0,
    offsetY: segment.offset?.y ?? 0
  }
  if (isShape) {
    element.shapeNumber = segment.shapeNumber
  } else {
    element.text = segment.text
  }
  // acad-ts resolves each segment's STYLE handle to a live TextStyle during
  // document build, so the style name is authoritative here; mapTextStyles has
  // added the same-named record to the table before render, letting the
  // renderer's name fallback embed the correct SHAPE/TEXT font.
  const styleName = segment.style?.name?.trim()
  if (styleName) {
    element.style = styleName
  }
  return element
}

function mapTextStyles(db: AcDbDatabase, doc: CadDocument): void {
  for (const style of iter(doc.textStyles)) {
    guardAdd(() =>
      db.tables.textStyleTable.add(
        new AcDbTextStyleTableRecord({
          name: style.name,
          fixedTextHeight: style.height,
          widthFactor: style.width,
          obliqueAngle: style.obliqueAngle,
          lastHeight: style.lastHeight,
          font: style.filename,
          bigFont: style.bigFontFilename ?? undefined,
          standardFlag: style.isShapeFile ? 1 : 0
        })
      )
    )
  }
  db.ensureTextStyleDefaults?.()
}

/**
 * Create block-table records for every named block except the model / paper
 * layouts (which the database owns) and any name already resident. Returns the
 * source->record pairs so the BLOCK stage can populate their entities.
 */
function mapBlockRecords(
  db: AcDbDatabase,
  doc: CadDocument
): Array<{ source: BlockRecord; record: AcDbBlockTableRecord }> {
  const blockTable = db.tables.blockTable
  const mapped: Array<{ source: BlockRecord; record: AcDbBlockTableRecord }> = []
  for (const record of iter(doc.blockRecords)) {
    if (isLayoutName(record.name) || blockTable.has(record.name)) {
      continue
    }
    const created = new AcDbBlockTableRecord({
      name: record.name,
      origin: toPoint3(record.blockEntity?.basePoint)
    })
    guardAdd(() => blockTable.add(created))
    mapped.push({ source: record, record: created })
  }
  return mapped
}

// ---------------------------------------------------------------------------
// Entity mapping (direct: acad-ts object model -> AcDbDatabase).
// ---------------------------------------------------------------------------

/** Map one acad-ts entity into `target`; false => an unmapped entity type. */
function mapEntity(
  entity: Entity,
  target: AcDbBlockTableRecord,
  db: AcDbDatabase
): boolean {
  // Order matters: Arc extends Circle, so Arc must be tested first.
  if (entity instanceof Line) {
    const record = new AcDbLine(toPoint3(entity.startPoint), toPoint3(entity.endPoint))
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    applyNormal(record, entity.normal)
    place(target, record, entity)
    return true
  }
  if (entity instanceof Arc) {
    const record = new AcDbArc(
      ocsCenterToWcs(entity.center, entity.normal),
      entity.radius,
      entity.startAngle,
      entity.endAngle,
      toVector(entity.normal)
    )
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    place(target, record, entity)
    return true
  }
  if (entity instanceof Circle) {
    const record = new AcDbCircle(
      ocsCenterToWcs(entity.center, entity.normal),
      entity.radius,
      toVector(entity.normal)
    )
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    place(target, record, entity)
    return true
  }
  if (entity instanceof Ellipse) {
    const major = toVector(entity.majorAxisEndPoint)
    const majorRadius = Math.hypot(major.x, major.y, major.z)
    const record = new AcDbEllipse(
      toPoint3(entity.center),
      toVector(entity.normal),
      major,
      majorRadius,
      majorRadius * entity.radiusRatio,
      entity.startParameter,
      entity.endParameter
    )
    place(target, record, entity)
    return true
  }
  if (entity instanceof LwPolyline) {
    const record = new AcDbPolyline()
    const cw = entity.constantWidth ?? 0
    entity.vertices.forEach((vertex, index) => {
      record.addVertexAt(
        index,
        new AcGePoint2d(vertex.location.x, vertex.location.y),
        vertex.bulge ?? 0,
        vertex.startWidth || cw,
        vertex.endWidth || cw
      )
    })
    record.closed = entity.isClosed
    record.elevation = entity.elevation ?? 0
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    applyNormal(record, entity.normal)
    place(target, record, entity)
    return true
  }
  if (entity instanceof Spline) {
    const controlPoints = entity.controlPoints.map(toPoint3)
    const record = controlPoints.length
      ? AcDbSpline.fromControlPoints(
          controlPoints,
          entity.knots ?? [],
          entity.weights?.length ? entity.weights : undefined,
          entity.degree,
          entity.isClosed
        )
      : AcDbSpline.fromFitPoints(
          entity.fitPoints.map(toPoint3),
          'Uniform',
          entity.degree,
          entity.isClosed
        )
    if (!record) {
      return false
    }
    place(target, record, entity)
    return true
  }
  if (entity instanceof Point) {
    const record = new AcDbPoint()
    record.position = toPoint3(entity.location)
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    applyNormal(record, entity.normal)
    if (entity.rotation) {
      record.ecsRotation = entity.rotation
    }
    place(target, record, entity)
    return true
  }
  if (entity instanceof Solid) {
    // DXF SOLID: a 4-corner filled polygon (first/second/third form the
    // triangle, fourth closes it) — same corner order the acad-rust route uses.
    const record = new AcDbSolid()
    record.setPointAt(0, toPoint3(entity.firstCorner))
    record.setPointAt(1, toPoint3(entity.secondCorner))
    record.setPointAt(2, toPoint3(entity.thirdCorner))
    record.setPointAt(3, toPoint3(entity.fourthCorner))
    if (entity.thickness) {
      record.thickness = entity.thickness
    }
    applyNormal(record, entity.normal)
    place(target, record, entity)
    return true
  }
  if (entity instanceof Hatch) {
    const record = buildHatch(entity)
    place(target, record, entity)
    return true
  }
  if (entity instanceof RasterImage) {
    const record = buildRasterImage(entity, db)
    place(target, record, entity)
    return true
  }
  if (entity instanceof Ole2Frame) {
    const record = buildOle2Frame(entity)
    place(target, record, entity)
    return true
  }
  if (entity instanceof MText) {
    place(target, buildMText(entity), entity)
    return true
  }
  if (entity instanceof TextEntity) {
    place(target, buildText(entity), entity)
    return true
  }
  if (entity instanceof Insert) {
    const blockName = entity.block?.name
    if (!blockName) {
      return false
    }
    const record = new AcDbBlockReference(blockName)
    record.position = toPoint3(entity.insertPoint)
    record.scaleFactors = new AcGePoint3d(entity.xScale, entity.yScale, entity.zScale)
    if (entity.rotation) {
      record.rotation = entity.rotation
    }
    applyNormal(record, entity.normal)
    if (entity.columnCount > 1) {
      record.columnCount = entity.columnCount
    }
    if (entity.rowCount > 1) {
      record.rowCount = entity.rowCount
    }
    if (entity.columnSpacing) {
      record.columnSpacing = entity.columnSpacing
    }
    if (entity.rowSpacing) {
      record.rowSpacing = entity.rowSpacing
    }
    place(target, record, entity)
    for (const attribute of entity.attributes) {
      record.appendAttributes(buildAttribute(attribute))
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Raster image mapping — mirrors the acad-rust / built-in DXF route. A DWG
// IMAGE does not embed pixels: it references an IMAGEDEFINITION (a file path +
// source pixel size) via `imageDefId`, and the viewer resolves the actual bytes
// later (AcTrView2d tracks entities whose `imageFileName` is set but `image`
// Blob is missing; the external-references panel attaches the file). So we only
// reproduce the placement + the linked AcDbRasterImageDef; geometry uses the
// same reconstruction the data-model DXF reader applies:
//   width  = |uVector| * imageSize.x,  height = |vVector| * imageSize.y
//   rotation = atan2(uVector.y, uVector.x),  position = insertPoint
// ---------------------------------------------------------------------------

function buildRasterImage(
  entity: RasterImage,
  db: AcDbDatabase
): AcDbRasterImage {
  const record = new AcDbRasterImage()
  const ip = entity.insertPoint
  record.position = new AcGePoint3d(ip.x, ip.y, ip.z)
  const ux = entity.uVector?.x ?? 0
  const uy = entity.uVector?.y ?? 0
  const uz = entity.uVector?.z ?? 0
  const vx = entity.vVector?.x ?? 0
  const vy = entity.vVector?.y ?? 0
  const vz = entity.vVector?.z ?? 0
  const sx = entity.size?.x ?? 0
  const sy = entity.size?.y ?? 0
  record.imageSize = new AcGePoint2d(sx, sy)
  record.width = Math.hypot(ux, uy, uz) * (sx || 1)
  record.height = Math.hypot(vx, vy, vz) * (sy || 1)
  record.rotation = Math.atan2(uy, ux)
  record.classVersion = entity.classVersion ?? 0
  record.brightness = entity.brightness ?? 50
  record.contrast = entity.contrast ?? 50
  record.fade = entity.fade ?? 0
  const flags = entity.flags ?? ImageDisplayFlags.None
  record.isImageShown = (flags & ImageDisplayFlags.ShowImage) !== 0
  record.isImageTransparent =
    (flags & ImageDisplayFlags.TransparencyIsOn) !== 0
  record.isShownClipped =
    (flags & ImageDisplayFlags.UseClippingBoundary) !== 0
  record.isClipped = !!entity.clippingState
  record.clipMode = entity.clipMode ?? 0
  const boundary = entity.clipBoundaryVertices
  if (boundary?.length) {
    // acad-ts ClipType (Rectangular=1 / Polygonal=2) matches
    // AcDbRasterImageClipBoundaryType (Rect=1 / Poly=2) numerically.
    record.clipBoundaryType =
      (entity.clipType ?? 1) as number as AcDbRasterImageClipBoundaryType
    record.clipBoundary = boundary.map(v => new AcGePoint2d(v.x, v.y))
  }
  const definition = entity.definition
  record.imageDefId = ensureRasterImageDef(
    db,
    definition?.fileName ?? '',
    definition?.size
  )
  return record
}

/**
 * Ensure an {@link AcDbRasterImageDef} for `fileName` lives in the database's
 * raster-image dictionary and return its object id (what `imageDefId` refers
 * to). Multiple entities sharing a file reuse one definition. Mirrors the
 * IMAGEATTACH command's `setAt(name, def)` + `image.imageDefId = def.objectId`
 * pattern, so `AcDbRasterImage.imageFileName` resolves through `getIdAt`.
 */
function ensureRasterImageDef(
  db: AcDbDatabase,
  fileName: string,
  pixelSize?: { x: number; y: number }
): string {
  const dict = db.objects.imageDefinition
  const trimmed = fileName.trim()
  if (trimmed && dict.has(trimmed)) {
    return dict.getAt(trimmed)?.objectId ?? ''
  }
  const def = new AcDbRasterImageDef()
  def.sourceFileName = fileName
  if (pixelSize && pixelSize.x > 0 && pixelSize.y > 0) {
    def.imageSize = new AcGePoint2d(pixelSize.x, pixelSize.y)
  }
  dict.setAt(uniqueImageDefName(dict, fileName), def)
  return def.objectId
}

/**
 * Maps an acad-ts `Ole2Frame` onto {@link AcDbOle2Frame}: the embedded OLE
 * compound-file bytes (`binaryData`) are handed to `setOleObject` so the
 * data-model picture extractor (signature scan for PNG/BMP/JPEG/EMF/WMF) recovers
 * the raster and `subWorldDraw` renders it; the frame corners, object type,
 * version and source application then fill in the placement. Mirrors the native
 * converter's `Ole2Frame` branch — payload is fed *before* the corners so the
 * explicit upper-left / lower-right corners take precedence over anything
 * `setOleObject` re-derives from the OLE binary header. The two `OleObjectType`
 * enums share the same numeric values (Link=1 / Embedded=2 / Static=3).
 */
function buildOle2Frame(entity: Ole2Frame): AcDbOle2Frame {
  const record = new AcDbOle2Frame()
  if (entity.binaryData && entity.binaryData.length > 0) {
    record.setOleObject(entity.binaryData)
  }
  const ul = entity.upperLeftCorner
  const lr = entity.lowerRightCorner
  record.upperLeftCorner = new AcGePoint3d(ul.x, ul.y, ul.z)
  record.lowerRightCorner = new AcGePoint3d(lr.x, lr.y, lr.z)
  record.oleObjectType = entity.oleObjectType as number as AcDbOleObjectType
  record.oleVersion = entity.version
  const app = entity.sourceApplication.trim()
  if (app) {
    record.userType = app
  }
  return record
}

/** Collision-free dictionary key for a raster image definition. */
function uniqueImageDefName(
  dict: AcDbDictionary<AcDbRasterImageDef>,
  fileName: string
): string {
  const base = fileName.trim() || 'image'
  if (!dict.has(base)) {
    return base
  }
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let index = 1
  while (dict.has(`${stem}_${index}${ext}`)) {
    index++
  }
  return `${stem}_${index}${ext}`
}

// ---------------------------------------------------------------------------
// Hatch mapping — mirrors the acad-rust native route. Boundary paths become
// AcGe 2D curves grouped into loops via AcGeLoop2d.buildFromEdges (the same
// constructors the built-in DXF reader uses), and for a non-solid pattern that
// carries authoritative definition lines we populate AcDbHatch.definitionLines
// BEFORE the patternName setter triggers the data-model's PAT expansion. The
// expansion would set _definitionLinesAutoGenerated=true, causing
// getRenderablePatternAngle() to return the raw patternAngle at draw time —
// the shader then double-rotates lines whose angles already embed it (DWG
// convention per OpenCADStudio's `angle_offset=0` for prebaked). Pre-filling
// the array makes `canReplace` false so the expansion is skipped entirely.
// Boundary geometry stays in OCS; `elevation` + `normal` map to WCS at draw
// time, matching the native route.
// ---------------------------------------------------------------------------

/** acad-ts {@link HatchPatternType} -> {@link AcDbHatchPatternType}. */
function hatchPatternType(t: HatchPatternType): AcDbHatchPatternType {
  switch (t) {
    case HatchPatternType.Custom:
      return AcDbHatchPatternType.Custom
    case HatchPatternType.PatternFill:
    case HatchPatternType.SolidFill:
    default:
      return AcDbHatchPatternType.Predefined
  }
}

/** Convert one boundary edge (Line / Arc / Ellipse / Spline) to a curve. */
function hatchEdgeToCurve(
  edge: HatchBoundaryPath['edges'][number]
): AcGeBoundaryEdgeType | undefined {
  if (edge instanceof HatchBoundaryPathLine) {
    return new AcGeLine2d(
      new AcGePoint2d(edge.start.x, edge.start.y),
      new AcGePoint2d(edge.end.x, edge.end.y)
    )
  }
  if (edge instanceof HatchBoundaryPathArc) {
    // acad-ts angles are radians; the 5th constructor arg is `clockwise`.
    return new AcGeCircArc2d(
      new AcGePoint2d(edge.center.x, edge.center.y),
      edge.radius,
      edge.startAngle,
      edge.endAngle,
      !edge.counterClockWise
    )
  }
  if (edge instanceof HatchBoundaryPathEllipse) {
    const major = Math.hypot(edge.majorAxisEndPoint.x, edge.majorAxisEndPoint.y)
    const minor = major * (edge.minorToMajorRatio ?? 0)
    const rotation = Math.atan2(edge.majorAxisEndPoint.y, edge.majorAxisEndPoint.x)
    let start = edge.startAngle
    let end = edge.endAngle
    if (!edge.counterClockWise) {
      start = Math.PI * 2 - start
      end = Math.PI * 2 - end
    }
    return new AcGeEllipseArc2d(
      new AcGePoint3d(edge.center.x, edge.center.y, 0),
      major,
      minor,
      start,
      end,
      !edge.counterClockWise,
      rotation
    )
  }
  if (edge instanceof HatchBoundaryPathSpline) {
    return (
      AcGeSpline3d.fromDwgSplineEdge({
        degree: edge.degree,
        numberOfControlPoints: edge.controlPoints.length,
        numberOfKnots: edge.knots.length,
        numberOfFitData: edge.fitPoints.length,
        knots: edge.knots,
        controlPoints: edge.controlPoints.map(pt => ({
          x: pt.x,
          y: pt.y,
          z: 0,
          weight: edge.isRational ? pt.z : undefined
        })),
        fitDatum: edge.fitPoints.map(pt => ({ x: pt.x, y: pt.y, z: 0 })),
        startTangent: null,
        endTangent: null
      }) ?? undefined
    )
  }
  return undefined
}

/** A polyline boundary edge -> a closed {@link AcGePolyline2d} loop (z = bulge). */
function hatchPolylineLoop(edge: HatchBoundaryPathPolyline): AcGePolyline2d {
  const polyline = new AcGePolyline2d()
  polyline.closed = !!edge.isClosed
  edge.vertices.forEach((v, i) => {
    polyline.addVertexAt(i, { x: v.x, y: v.y, bulge: v.z ?? 0 })
  })
  return polyline
}

/** Convert one boundary path into one or more loops appended to `rec`. */
function addHatchPathLoop(rec: AcDbHatch, path: HatchBoundaryPath): void {
  const edges = path.edges
  if (edges.length === 0) {
    return
  }
  if (edges.length === 1 && edges[0] instanceof HatchBoundaryPathPolyline) {
    rec.add(hatchPolylineLoop(edges[0]))
    return
  }
  const geoEdges: AcGeBoundaryEdgeType[] = []
  for (const edge of edges) {
    if (edge instanceof HatchBoundaryPathPolyline) {
      rec.add(hatchPolylineLoop(edge))
      continue
    }
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

/** Build an {@link AcDbHatch} from one acad-ts `Hatch` entity. */
function buildHatch(entity: Hatch): AcDbHatch {
  const rec = new AcDbHatch()
  rec.isSolidFill = !!entity.isSolid
  rec.patternType = hatchPatternType(entity.patternType)
  if (entity.pattern?.name) {
    rec.patternName = entity.pattern.name
  }
  rec.patternAngle = entity.patternAngle ?? 0
  rec.patternScale = entity.patternScale ?? 1
  // Replace the data-model's auto-expanded PAT definition lines with acad-ts's
  // authoritative line set, AFTER every pattern setter. The PAT expander stores
  // LINE-LOCAL offsets (deltaX = along-line stagger, deltaY = perpendicular
  // spacing); the material manager inverse-rotates each offset by the line angle
  // assuming a WORLD-space vector, so line-local input gets rotated into a bogus
  // large perpendicular spacing and aggregate patterns (GRAVEL) dissolve into
  // sparse dashes. acad-ts carries the world-space offset (matching DWG group
  // 45/46), which inverse-rotates back to the true tight spacing. Clearing +
  // re-pushing after the setters is required because `patternType`/`patternScale`
  // already flipped `_definitionLinesAutoGenerated` to true during their own
  // expansion, so a pre-populated array would still be overwritten. Forcing the
  // flag back to false both prevents any later setter from re-expanding over our
  // data (canReplace = autoGen || length===0, and length>0 now) and makes
  // `getRenderablePatternAngle()` return 0 so the shader doesn't double-rotate
  // these already-baked line angles.
  if (
    !entity.isSolid &&
    entity.pattern &&
    entity.pattern.lines.length > 0
  ) {
    const defLines = rec.definitionLines
    defLines.length = 0
    for (const line of entity.pattern.lines) {
      defLines.push({
        angle: line.angle ?? 0,
        base: { x: line.basePoint?.x ?? 0, y: line.basePoint?.y ?? 0 },
        offset: { x: line.offset?.x ?? 0, y: line.offset?.y ?? 0 },
        dashLengths: Array.isArray(line.dashLengths)
          ? [...line.dashLengths]
          : []
      })
    }
    ;(
      rec as unknown as { _definitionLinesAutoGenerated: boolean }
    )._definitionLinesAutoGenerated = false
  }
  rec.patternDouble = !!entity.isDouble
  rec.hatchStyle = entity.style as number as AcDbHatchStyle
  rec.associative = !!entity.isAssociative
  rec.elevation = entity.elevation ?? 0
  const n = entity.normal
  if (n && !(n.x === 0 && n.y === 0 && n.z === 1)) {
    rec.normal = new AcGeVector3d(n.x, n.y, n.z)
  }
  for (const path of entity.paths) {
    addHatchPathLoop(rec, path)
  }
  return rec
}

function buildText(entity: TextEntity): AcDbText {
  const record = new AcDbText()
  record.textString = entity.value ?? ''
  record.position = toPoint3(entity.insertPoint)
  if (entity.alignmentPoint) {
    record.alignmentPoint = toPoint3(entity.alignmentPoint)
    record.hasAlignmentPoint = true
  }
  record.height = entity.height ?? 0
  record.rotation = entity.rotation ?? 0
  record.widthFactor = entity.widthFactor ?? 1
  record.oblique = entity.obliqueAngle ?? 0
  record.styleName = entity.style?.name ?? record.styleName
  if (entity.thickness) {
    record.thickness = entity.thickness
  }
  applyNormal(record, entity.normal)
  return record
}

function buildMText(entity: MText): AcDbMText {
  const record = new AcDbMText()
  record.contents = entity.value ?? ''
  record.location = toPoint3(entity.insertPoint)
  record.height = entity.height ?? 0
  record.width = entity.rectangleWidth ?? 0
  record.rotation = entity.rotation ?? 0
  record.direction = new AcGeVector3d(
    Math.cos(record.rotation),
    Math.sin(record.rotation),
    0
  )
  record.styleName = entity.style?.name ?? record.styleName
  record.lineSpacingFactor = entity.lineSpacing ?? 1
  record.attachmentPoint = mTextAttachmentPoint(entity.attachmentPoint)
  applyNormal(record, entity.normal)
  return record
}

function buildAttribute(entity: Entity): AcDbAttribute {
  // Attribute values fold onto the AcDbAttribute display surface (extends
  // AcDbText): tag + text + placement is all the viewer needs to render an
  // insert's attributes.
  const record = new AcDbAttribute()
  const text = entity as unknown as TextEntity
  record.textString = text.value ?? ''
  record.position = toPoint3(text.insertPoint)
  record.height = text.height ?? 0
  record.rotation = text.rotation ?? 0
  record.widthFactor = text.widthFactor ?? 1
  record.styleName = text.style?.name ?? record.styleName
  applyCommon(record, entity)
  return record
}

// ---------------------------------------------------------------------------
// Common attribute + primitive bridges.
// ---------------------------------------------------------------------------

/** Append the entity then style it — insert-then-attribute order. */
function place(
  target: AcDbBlockTableRecord,
  entity: AcDbEntity,
  source: Entity
): void {
  target.appendEntity(entity)
  applyCommon(entity, source)
}

function applyCommon(entity: AcDbEntity, source: Entity): void {
  entity.layer = source.layer?.name || '0'
  entity.color = colorToAcCm(source.color)
  entity.lineType = source.lineType?.name || 'ByLayer'
  entity.linetypeScale = source.lineTypeScale ?? 1
  entity.lineWeight = lineWeightToGi(source.lineWeight)
  entity.transparency = transparencyToAcCm(source.transparency)
  entity.visibility = !source.isInvisible
}

function colorToAcCm(color: Color | undefined): AcCmColor {
  const c = new AcCmColor()
  if (!color) {
    c.colorIndex = 256
    return c
  }
  if (color.isByLayer) {
    c.colorIndex = 256
  } else if (color.isByBlock) {
    c.colorIndex = 0
  } else if (color.isTrueColor) {
    c.setRGB(color.r, color.g, color.b)
  } else {
    c.colorIndex = color.index
  }
  return c
}

function lineWeightToGi(lw: LineWeightType | undefined): AcGiLineWeight {
  switch (lw) {
    case LineWeightType.ByLayer:
      return AcGiLineWeight.ByLayer
    case LineWeightType.ByBlock:
      return AcGiLineWeight.ByBlock
    case LineWeightType.Default:
    case LineWeightType.ByDIPs:
    case undefined:
      return AcGiLineWeight.ByLineWeightDefault
    default:
      return lw as number as AcGiLineWeight
  }
}

function transparencyToAcCm(t: Transparency | undefined): AcCmTransparency {
  const tr = new AcCmTransparency()
  if (t && !t.isByLayer && !t.isByBlock && t.value > 0) {
    tr.percentage = t.value
  }
  return tr
}

function mTextAttachmentPoint(v: number): AcGiMTextAttachmentPoint {
  return v as number as AcGiMTextAttachmentPoint
}

function toPoint3(p: { x: number; y: number; z?: number } | undefined): AcGePoint3d {
  return new AcGePoint3d(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0)
}

function toVector(p: { x: number; y: number; z?: number } | undefined): AcGeVector3d {
  return new AcGeVector3d(p?.x ?? 0, p?.y ?? 0, p?.z ?? 1)
}

/** Set `normal` only when it deviates from the default `+Z` extrusion. */
function applyNormal(
  entity: { normal?: AcGeVector3d },
  normal: { x: number; y: number; z: number } | undefined
): void {
  if (normal && !(normal.x === 0 && normal.y === 0 && normal.z === 1)) {
    entity.normal = new AcGeVector3d(normal.x, normal.y, normal.z)
  }
}

/**
 * Convert an acad-ts OCS center to WCS using its extrusion `normal`. acad-ts
 * keeps CIRCLE/ARC centers in OCS; the data-model constructors treat `center`
 * as WCS, so mirrored/tilted normals must be transformed (byte-for-byte port of
 * the built-in DXF reader's OCS->WCS, with a `+Z` identity fast path).
 */
function ocsCenterToWcs(
  center: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number }
): AcGePoint3d {
  const out = new AcGePoint3d(center.x, center.y, center.z)
  if (normal.x === 0 && normal.y === 0 && normal.z === 1) {
    return out
  }
  return out.applyMatrix4(
    new AcGeMatrix3d().setFromExtrusionDirection(
      new AcGeVector3d(normal.x, normal.y, normal.z)
    )
  )
}

// ---------------------------------------------------------------------------
// Iteration + add helpers.
// ---------------------------------------------------------------------------

function isLayoutName(name: string | undefined): boolean {
  return (
    name === '*Model_Space' ||
    name === '*Paper_Space' ||
    (name?.startsWith('*Paper_Space') ?? false)
  )
}

function iter<T>(collection: Iterable<T> | null | undefined): T[] {
  return collection ? Array.from(collection) : []
}

function guardAdd(add: () => void): void {
  try {
    add()
  } catch {
    // Duplicate default record or unsupported value — skip, keep the file open.
  }
}
