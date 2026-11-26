/**
 * Route-B inverse mapping: data-model entity -> acadrust serde JSON.
 *
 * Two output shapes share one field vocabulary (the converter's forward
 * mapping in `AcDbAcadRustNativeConverter.ts` is the mirror authority):
 *
 * - `serializeEntityPartial` emits only the *covered* fields the editor can
 *   round-trip. The save journal diffs it against the open snapshot with
 *   covered-key semantics, so provenance fields the editor never touches
 *   (extended_data, reactors, owner handles, vertex ids, attdef handles, ...)
 *   stay byte-intact on the source record.
 * - `serializeEntityFull` emits a complete `EntityType` JSON for *added*
 *   entities: Rust deserializes it with `serde_json::from_value`, so every
 *   field without a serde default must be present (see the fork's
 *   `entities/*.rs`). Defaults mirror `EntityCommon::new()` / `MText::new()`.
 *
 * `normalizeEntitySnapshot` canonicalizes the *snapshot* side of the diff so
 * lossy forward folds do not manufacture patches for untouched entities:
 * ByLayer-ish colors, collapsed transparencies, ''-style names, the
 * width-step vertex duplication the forward mapper performs, OCS<->WCS
 * round-trip noise, arc angle normalization and planar MTEXT direction.
 * Comparison is two-stage: equal-to-normalized => no patch at all; otherwise
 * the patch is diffed against the *original* snapshot so JSON-pointer paths
 * address the real source tree.
 *
 * MVP coverage (plan P6c): LINE / LWPOLYLINE / CIRCLE / ARC / TEXT / MTEXT /
 * INSERT (incl. ATTRIB) / POINT + common properties + LAYER / LTYPE / STYLE
 * tables + selected header variables. HATCH / DIMENSION / compound polylines
 * stay read-only: the journal rejects edits on them with `unsupported-entity`.
 */
import {
  AcCmColor,
  AcCmTransparency,
  AcDbArc,
  AcDbAttribute,
  AcDbBlockReference,
  AcDbCircle,
  AcDbDatabase,
  AcDbEntity,
  AcDbLayerTableRecord,
  AcDbLine,
  AcDbLinetypeTableRecord,
  AcDbMInsertBlock,
  AcDbMText,
  AcDbPoint,
  AcDbPolyline,
  AcDbText,
  AcDbTextHorizontalMode,
  AcDbTextStyleTableRecord,
  AcDbTextVerticalMode,
  acgeTransformOcsPointToWcs,
  acgeTransformWcsPointToOcs,
  type AcGiLineTypePatternElement,
  AcGiLineWeight,
  AcGiMTextAttachmentPoint,
  AcGiMTextFlowDirection} from '@mlightcad/data-model'
import type {
  AcadRustAttribute,
  AcadRustColor,
  AcadRustEntity,
  AcadRustEntityCommon,
  AcadRustHeader,
  AcadRustLayer,
  AcadRustLineType,
  AcadRustLineTypeElement,
  AcadRustLineWeight,
  AcadRustLwPolylinePayload,
  AcadRustMTextPayload,
  AcadRustPoint2d,
  AcadRustPoint3d,
  AcadRustTextStyle,
  AcadRustTransparency
} from '@njbestway/acad-rust-converter'

import { coveredEqual } from './jsonDiff'
import { RouteBError } from './RouteBError'

/** A serde JSON object under construction. */
type Json = Record<string, unknown>

const TAU = Math.PI * 2
/** Width-step detection threshold — mirrors the forward mapper's 1e-6. */
const WIDTH_EPSILON = 1e-6

// ---------------------------------------------------------------------------
// Scalar bridges (color / lineweight / transparency) and their canonical forms.
// ---------------------------------------------------------------------------

/** data-model color -> acadrust `Color` wire form. */
export function serializeColor(c: AcCmColor): AcadRustColor {
  if (c.isByBlock) return 'ByBlock'
  if (c.isByLayer) return 'ByLayer'
  if (c.isByACI) return { Index: c.colorIndex ?? 256 }
  return { Rgb: { r: c.red ?? 0, g: c.green ?? 0, b: c.blue ?? 0 } }
}

/**
 * Canonical color the forward mapper would produce: `colorToAcCm` folds
 * `None`/`ByLayer`/`Index(256)` onto ByLayer and `Index(0)` onto ByBlock.
 */
export function normalizeColor(c: AcadRustColor): AcadRustColor {
  if (typeof c === 'string') return c === 'ByBlock' ? 'ByBlock' : 'ByLayer'
  if ('Index' in c) {
    if (c.Index === 0) return 'ByBlock'
    if (c.Index === 256) return 'ByLayer'
    return { Index: c.Index }
  }
  return c
}

/** data-model lineweight -> acadrust `LineWeight` wire form. */
export function serializeLineWeight(
  lw: AcGiLineWeight | number
): AcadRustLineWeight {
  if (lw === AcGiLineWeight.ByLayer) return 'ByLayer'
  if (lw === AcGiLineWeight.ByBlock) return 'ByBlock'
  // ByLineWeightDefault / ByDIPs / any negative sentinel fold onto Default.
  if (lw < 0) return 'Default'
  return { Value: lw }
}

/** Canonical lineweight: `NoLineweight` and negative values fold to Default. */
export function normalizeLineWeight(lw: AcadRustLineWeight): AcadRustLineWeight {
  if (typeof lw === 'string') return lw === 'ByLayer' || lw === 'ByBlock' ? lw : 'Default'
  if ('Value' in lw) return lw.Value < 0 ? 'Default' : { Value: lw.Value }
  return 'Default'
}

/** data-model transparency -> acadrust `Transparency` wire form. */
export function serializeTransparency(t: AcCmTransparency): AcadRustTransparency {
  if (t.isByBlock) return 'by_block'
  if (t.isByAlpha) return { explicit: t.percentage ?? 0 }
  return 'by_layer'
}

/**
 * Canonical transparency: the forward mapper collapses *every* string variant
 * (by_layer / by_block) onto the ByLayer default, and `explicit: 0` stays
 * opaque-default — so both normalize to `by_layer`.
 */
export function normalizeTransparency(
  t: AcadRustTransparency
): AcadRustTransparency {
  if (typeof t === 'string') return 'by_layer'
  if ('explicit' in t) return t.explicit > 0 ? { explicit: t.explicit } : 'by_layer'
  return 'by_layer'
}

// ---------------------------------------------------------------------------
// Small geometry / enum helpers.
// ---------------------------------------------------------------------------

function p3(v: { x: number; y: number; z?: number }): AcadRustPoint3d {
  return { x: v.x, y: v.y, z: v.z ?? 0 }
}

function p2(v: { x: number; y: number }): AcadRustPoint2d {
  return { x: v.x, y: v.y }
}

function isPlusZ(n: { x: number; y: number; z: number }): boolean {
  return (
    Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && Math.abs(n.z - 1) < 1e-12
  )
}

/** Normalize an angle to [0, 2π), mapping a full turn onto 0. */
function normAngle(a: number): number {
  const r = ((a % TAU) + TAU) % TAU
  return Math.abs(r - TAU) < 1e-12 ? 0 : r
}

function dirFromRotation(rotation: number): AcadRustPoint3d {
  return { x: Math.cos(rotation), y: Math.sin(rotation), z: 0 }
}

function hName(mode: AcDbTextHorizontalMode): string {
  switch (mode) {
    case AcDbTextHorizontalMode.CENTER:
      return 'Center'
    case AcDbTextHorizontalMode.RIGHT:
      return 'Right'
    case AcDbTextHorizontalMode.ALIGNED:
      return 'Aligned'
    case AcDbTextHorizontalMode.MIDDLE:
      return 'Middle'
    case AcDbTextHorizontalMode.FIT:
      return 'Fit'
    default:
      return 'Left'
  }
}

function vName(mode: AcDbTextVerticalMode): string {
  switch (mode) {
    case AcDbTextVerticalMode.BOTTOM:
      return 'Bottom'
    case AcDbTextVerticalMode.MIDDLE:
      return 'Middle'
    case AcDbTextVerticalMode.TOP:
      return 'Top'
    default:
      return 'Baseline'
  }
}

function attachmentName(point: AcGiMTextAttachmentPoint): string {
  switch (point) {
    case AcGiMTextAttachmentPoint.TopCenter:
      return 'TopCenter'
    case AcGiMTextAttachmentPoint.TopRight:
      return 'TopRight'
    case AcGiMTextAttachmentPoint.MiddleLeft:
      return 'MiddleLeft'
    case AcGiMTextAttachmentPoint.MiddleCenter:
      return 'MiddleCenter'
    case AcGiMTextAttachmentPoint.MiddleRight:
      return 'MiddleRight'
    case AcGiMTextAttachmentPoint.BottomLeft:
      return 'BottomLeft'
    case AcGiMTextAttachmentPoint.BottomCenter:
      return 'BottomCenter'
    case AcGiMTextAttachmentPoint.BottomRight:
      return 'BottomRight'
    // BaselineLeft/Center/Right (10-12) are TEXT/ATTRIB render extensions with
    // no MTEXT wire variant; fold onto the top row (MVP limitation).
    default:
      return 'TopLeft'
  }
}

function flowName(dir: AcGiMTextFlowDirection): string {
  switch (dir) {
    case AcGiMTextFlowDirection.TOP_TO_BOTTOM:
      return 'TopToBottom'
    case AcGiMTextFlowDirection.BY_STYLE:
      return 'ByStyle'
    // RIGHT_TO_LEFT / BOTTOM_TO_TOP have no wire variant; fold (MVP).
    default:
      return 'LeftToRight'
  }
}

/** The MVP-supported entity kind for a data-model record, or undefined. */
export function entityKindOf(entity: AcDbEntity): string | undefined {
  switch (entity.dxfTypeName) {
    case 'LINE':
      return 'Line'
    case 'CIRCLE':
      return 'Circle'
    case 'ARC':
      return 'Arc'
    case 'POINT':
      return 'Point'
    case 'LWPOLYLINE':
      return 'LwPolyline'
    case 'TEXT':
      return 'Text'
    case 'MTEXT':
      return 'MText'
    case 'INSERT':
      return 'Insert'
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Common block.
// ---------------------------------------------------------------------------

function commonPartial(e: AcDbEntity): Json {
  return {
    layer: e.layer || '0',
    color: serializeColor(e.color),
    line_weight: serializeLineWeight(e.lineWeight),
    linetype: e.lineType || 'ByLayer',
    linetype_scale: e.linetypeScale ?? 1,
    transparency: serializeTransparency(e.transparency),
    invisible: !e.visibility
  }
}

/** Full `EntityCommon` for added entities (handle 0: Rust add_entity assigns). */
function commonFull(e: AcDbEntity, ownerHandle: number): Json {
  return {
    ...commonPartial(e),
    handle: 0,
    color_name: null,
    extended_data: { records: [] },
    reactors: [],
    xdictionary_handle: null,
    owner_handle: ownerHandle,
    full_visual_style_handle: null
  }
}

function normalizeCommon(c: AcadRustEntityCommon): Json {
  return {
    ...c,
    layer: c.layer || '0',
    color: normalizeColor(c.color),
    line_weight: normalizeLineWeight(c.line_weight),
    linetype: c.linetype || 'ByLayer',
    linetype_scale: c.linetype_scale ?? 1,
    transparency: normalizeTransparency(c.transparency)
  }
}

// ---------------------------------------------------------------------------
// Per-entity partial serializers (covered surface only).
// ---------------------------------------------------------------------------

/** MTEXT covered payload — shared by MTEXT entities and embedded ATTRIB mtext. */
function serializeMTextPayload(m: AcDbMText): Json {
  const rotation = m.rotation ?? 0
  // Planar MTEXT: derive the reading vector from rotation (the rotation setter
  // does not sync `direction`, so a stale direction must not mask an edit).
  // Tilted MTEXT: the forward mapper carried `dwg_x_direction` verbatim into
  // `direction`, so reading it back is exact.
  const dir = isPlusZ(m.normal)
    ? dirFromRotation(rotation)
    : p3(m.direction)
  return {
    common: commonPartial(m),
    value: m.contents ?? '',
    insertion_point: p3(m.location),
    height: m.height ?? 0,
    rectangle_width: m.width ?? 0,
    rotation,
    dwg_x_direction: dir,
    style: m.styleName || 'Standard',
    attachment_point: attachmentName(m.attachmentPoint),
    drawing_direction: flowName(m.drawingDirection),
    line_spacing_factor: m.lineSpacingFactor ?? 1,
    line_spacing_style: m.lineSpacingStyle === 2 ? 'Exactly' : 'AtLeast',
    normal: p3(m.normal),
    background_fill_flags: m.backgroundFill ? 1 : 0,
    extents_width: m.extentsWidth ?? 0
  }
}

/** ATTRIB covered payload (the journal diffs these per-index under INSERT). */
export function serializeAttributePartial(a: AcDbAttribute): Json {
  return {
    common: commonPartial(a),
    tag: a.tag ?? '',
    value: a.textString ?? '',
    insertion_point: p3(a.position),
    alignment_point: a.hasAlignmentPoint ? p3(a.alignmentPoint) : p3(a.position),
    height: a.height ?? 0,
    rotation: a.rotation ?? 0,
    width_factor: a.widthFactor ?? 1,
    oblique_angle: a.oblique ?? 0,
    text_style: a.styleName || 'Standard',
    text_generation_flags: a.generationFlag ?? 0,
    horizontal_alignment: hName(a.horizontalMode),
    vertical_alignment: vName(a.verticalMode),
    // `annotative` is not forward-mapped: leave it off the covered surface so
    // the source flag survives. locked_position folds the forward OR.
    flags: {
      invisible: a.isInvisible,
      constant: a.isConst,
      verify: a.isVerifiable,
      preset: a.isPreset,
      locked_position: a.lockPositionInBlock
    },
    field_length: a.fieldLength ?? 0,
    normal: p3(a.normal),
    mtext_flag: a.isConstMTextAttribute
      ? 'ConstantMultiLine'
      : a.isMTextAttribute
        ? 'MultiLine'
        : 'SingleLine',
    is_multiline: a.isMTextAttribute,
    lock_position: a.isReallyLocked,
    embedded_mtext: a.mtext ? serializeMTextPayload(a.mtext) : null
  }
}

/**
 * Covered-surface JSON for a resident entity, externally tagged like the wire
 * (`{"Line": {...}}`). `baseline` supplies provenance the model cannot carry
 * (LWPOLYLINE vertex ids, copied by index). Returns undefined for entity types
 * outside the MVP set — the journal turns that into a hard `unsupported-entity`
 * rejection when such an entity is dirty.
 *
 * INSERT deliberately omits `attributes`: the journal diffs the attribute
 * list per-index (aligned by DWG handle) so a value edit never wholesale-
 * replaces the array and drops ATTRIB provenance.
 */
export function serializeEntityPartial(
  entity: AcDbEntity,
  baseline?: AcadRustEntity
): Json | undefined {
  const kind = entityKindOf(entity)
  if (!kind) return undefined
  const common = commonPartial(entity)
  switch (kind) {
    case 'Line': {
      const e = entity as AcDbLine
      return {
        Line: {
          common,
          start: p3(e.startPoint),
          end: p3(e.endPoint),
          thickness: e.thickness ?? 0,
          normal: p3(e.normal)
        }
      }
    }
    case 'Circle': {
      const e = entity as AcDbCircle
      return {
        Circle: {
          common,
          center: p3(acgeTransformWcsPointToOcs(e.center, e.normal)),
          radius: e.radius,
          thickness: e.thickness ?? 0,
          normal: p3(e.normal)
        }
      }
    }
    case 'Arc': {
      const e = entity as AcDbArc
      return {
        Arc: {
          common,
          center: p3(acgeTransformWcsPointToOcs(e.center, e.normal)),
          radius: e.radius,
          start_angle: e.startAngle,
          end_angle: e.endAngle,
          thickness: e.thickness ?? 0,
          normal: p3(e.normal)
        }
      }
    }
    case 'Point': {
      const e = entity as AcDbPoint
      return {
        Point: {
          common,
          location: p3(e.position),
          thickness: e.thickness ?? 0,
          normal: p3(e.normal),
          x_axis_angle: e.ecsRotation ?? 0
        }
      }
    }
    case 'LwPolyline': {
      const e = entity as AcDbPolyline
      const baseVerts = (
        baseline?.LwPolyline as AcadRustLwPolylinePayload | undefined
      )?.vertices
      const vertices: Json[] = []
      for (let i = 0; i < e.numberOfVertices; i++) {
        vertices.push({
          location: p2(e.getPoint2dAt(i)),
          bulge: e.getBulgeAt(i),
          start_width: e.getStartWidthAt(i),
          end_width: e.getEndWidthAt(i),
          // Provenance: keep the source vertex id when the count still matches;
          // a count change means the edit already invalidated constraint ids.
          vertex_id: baseVerts?.[i]?.vertex_id ?? i
        })
      }
      return {
        LwPolyline: {
          common,
          vertices,
          is_closed: e.closed,
          elevation: e.elevation ?? 0,
          thickness: e.thickness ?? 0,
          normal: p3(e.normal)
        }
      }
    }
    case 'Text': {
      const e = entity as AcDbText
      return {
        Text: {
          common,
          value: e.textString ?? '',
          insertion_point: p3(e.position),
          alignment_point: e.hasAlignmentPoint ? p3(e.alignmentPoint) : null,
          height: e.height ?? 0,
          rotation: e.rotation ?? 0,
          width_factor: e.widthFactor ?? 1,
          oblique_angle: e.oblique ?? 0,
          style: e.styleName || 'Standard',
          horizontal_alignment: hName(e.horizontalMode),
          vertical_alignment: vName(e.verticalMode),
          normal: p3(e.normal),
          thickness: e.thickness ?? 0,
          generation_flags: e.generationFlag ?? 0
        }
      }
    }
    case 'MText':
      return { MText: serializeMTextPayload(entity as AcDbMText) }
    case 'Insert': {
      const e = entity as AcDbBlockReference
      const mi = entity instanceof AcDbMInsertBlock ? entity : undefined
      return {
        Insert: {
          common,
          block_name: e.blockName ?? '',
          insert_point: p3(e.position),
          x_scale: e.scaleFactors.x,
          y_scale: e.scaleFactors.y,
          z_scale: e.scaleFactors.z,
          rotation: e.rotation ?? 0,
          normal: p3(e.normal),
          column_count: mi?.columns ?? 1,
          row_count: mi?.rows ?? 1,
          column_spacing: mi?.columnSpacing ?? 0,
          row_spacing: mi?.rowSpacing ?? 0
        }
      }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Full serializers for added entities (Rust from_value::<EntityType>).
// ---------------------------------------------------------------------------

/** MTEXT fields the forward mapper does not carry but Rust requires. */
function mTextFullExtras(): Json {
  return {
    rectangle_height: null,
    background_scale: 1.5,
    background_color: 'ByLayer',
    background_transparency: 0,
    is_annotative: false,
    column_data: {
      column_type: 0,
      column_count: 0,
      flow_reversed: false,
      auto_height: false,
      width: 0,
      gutter: 0,
      heights: []
    },
    extents_height: 0
  }
}

/** Full ATTRIB JSON (embedded under an added INSERT). */
export function serializeAttributeFull(
  a: AcDbAttribute,
  ownerHandle: number
): Json {
  const p = serializeAttributePartial(a)
  p.common = commonFull(a, ownerHandle)
  p.attdef_handle = 0
  p.line_count = 1
  p.flags = { ...(p.flags as Json), annotative: false }
  if (p.embedded_mtext && a.mtext) {
    ;(p.embedded_mtext as Json).common = commonFull(a.mtext, 0)
  }
  return p
}

/**
 * Complete externally-tagged `EntityType` JSON for a newly created entity.
 * Throws `unsupported-entity` outside the MVP creatable set. `ownerHandle` is
 * the target block's DWG handle (model space for the MVP creation commands).
 */
export function serializeEntityFull(
  entity: AcDbEntity,
  ownerHandle: number
): Json {
  const kind = entityKindOf(entity)
  if (!kind) {
    throw new RouteBError(
      'unsupported-entity',
      `Route-B cannot add entity type '${entity.dxfTypeName}' (outside the MVP inverse-mapping set)`
    )
  }
  const partial = serializeEntityPartial(entity) as Json
  const payload = partial[kind] as Json
  payload.common = commonFull(entity, ownerHandle)
  switch (kind) {
    case 'LwPolyline':
      payload.plinegen = false
      payload.constant_width = 0
      break
    case 'MText':
      Object.assign(payload, mTextFullExtras())
      break
    case 'Insert': {
      const attribs: Json[] = []
      for (const a of (entity as AcDbBlockReference).attributeIterator()) {
        attribs.push(serializeAttributeFull(a, 0))
      }
      payload.attributes = attribs
      break
    }
  }
  return partial
}

// ---------------------------------------------------------------------------
// Snapshot normalization (canonical covered form of the open-time baseline).
// ---------------------------------------------------------------------------

/**
 * Re-run the forward mapper's width-step vertex duplication on the snapshot so
 * it aligns with what the model stores. Output vertices are in *model storage
 * form* (resolved start/end widths, no vertex ids) — exactly what
 * `serializeEntityPartial` reads back, minus the provenance id.
 */
function normalizeLwVertices(p: AcadRustLwPolylinePayload): Json[] {
  const cw = p.constant_width ?? 0
  const src = (p.vertices ?? []).map(v => ({
    x: v.location.x,
    y: v.location.y,
    bulge: v.bulge ?? 0,
    sw: Math.max(0, v.start_width || cw),
    ew: Math.max(0, v.end_width || cw)
  }))
  let hasStep = false
  if (!p.is_closed) {
    for (let i = 1; i < src.length - 1; i++) {
      if (Math.abs(src[i].sw - src[i - 1].ew) > WIDTH_EPSILON) {
        hasStep = true
        break
      }
    }
  }
  if (!hasStep) {
    return src.map(v => ({
      location: { x: v.x, y: v.y },
      bulge: v.bulge,
      start_width: v.sw,
      end_width: v.ew
    }))
  }
  const samples: { x: number; y: number; bulge: number; w: number }[] = []
  for (let i = 0; i < src.length; i++) {
    const cur = src[i]
    if (i === 0) {
      samples.push({ x: cur.x, y: cur.y, bulge: cur.bulge, w: cur.sw })
      continue
    }
    const incoming = src[i - 1].ew
    if (Math.abs(cur.sw - incoming) > WIDTH_EPSILON) {
      samples.push({ x: cur.x, y: cur.y, bulge: 0, w: incoming })
      samples.push({ x: cur.x, y: cur.y, bulge: cur.bulge, w: cur.sw })
    } else {
      samples.push({ x: cur.x, y: cur.y, bulge: cur.bulge, w: cur.sw })
    }
  }
  const W = samples.map(s => s.w)
  return samples.map((s, k) => ({
    location: { x: s.x, y: s.y },
    bulge: s.bulge,
    start_width: W[k],
    end_width: k + 1 < W.length ? W[k + 1] : s.w
  }))
}

function normalizeMTextPayload(m: AcadRustMTextPayload): Json {
  const rotation = m.rotation ?? 0
  const dir = isPlusZ(m.normal)
    ? dirFromRotation(rotation)
    : (m.dwg_x_direction ?? dirFromRotation(rotation))
  return {
    ...m,
    common: normalizeCommon(m.common),
    style: m.style || 'Standard',
    background_fill_flags: (m.background_fill_flags ?? 0) & 1,
    dwg_x_direction: dir
  }
}

function normalizeAttribute(s: AcadRustAttribute): Json {
  const multiline =
    !!s.is_multiline ||
    s.mtext_flag === 'MultiLine' ||
    s.mtext_flag === 'ConstantMultiLine'
  return {
    ...s,
    common: normalizeCommon(s.common),
    text_style: s.text_style || 'Standard',
    flags: {
      ...s.flags,
      locked_position: !!s.lock_position || !!s.flags?.locked_position
    },
    mtext_flag:
      s.mtext_flag === 'ConstantMultiLine'
        ? 'ConstantMultiLine'
        : multiline
          ? 'MultiLine'
          : 'SingleLine',
    is_multiline: multiline,
    embedded_mtext: s.embedded_mtext
      ? normalizeMTextPayload(s.embedded_mtext)
      : null
  }
}

/**
 * Canonical covered form of an open-time entity snapshot. Only the fields the
 * inverse mapping covers are canonicalized; provenance keys ride along
 * untouched (the covered-key comparison never visits keys absent from current).
 */
export function normalizeEntitySnapshot(s: AcadRustEntity): AcadRustEntity {
  const kind = Object.keys(s)[0]
  const p = s[kind] as Json
  if (!kind || !p) return s
  const out: Json = { ...p, common: normalizeCommon(p.common as AcadRustEntityCommon) }
  switch (kind) {
    case 'Circle': {
      const c = p as { center: AcadRustPoint3d; normal: AcadRustPoint3d }
      out.center = p3(
        acgeTransformWcsPointToOcs(
          acgeTransformOcsPointToWcs(c.center, c.normal),
          c.normal
        )
      )
      break
    }
    case 'Arc': {
      const a = p as {
        center: AcadRustPoint3d
        normal: AcadRustPoint3d
        start_angle: number
        end_angle: number
      }
      out.center = p3(
        acgeTransformWcsPointToOcs(
          acgeTransformOcsPointToWcs(a.center, a.normal),
          a.normal
        )
      )
      out.start_angle = normAngle(a.start_angle)
      out.end_angle = normAngle(a.end_angle)
      break
    }
    case 'LwPolyline':
      out.vertices = normalizeLwVertices(p as unknown as AcadRustLwPolylinePayload)
      break
    case 'Text':
      out.style = (p.style as string) || 'Standard'
      break
    case 'MText':
      Object.assign(out, normalizeMTextPayload(p as unknown as AcadRustMTextPayload))
      break
    case 'Insert': {
      const attribs = (p.attributes as AcadRustAttribute[] | undefined) ?? []
      out.attributes = attribs.map(normalizeAttribute)
      break
    }
  }
  return { [kind]: out }
}

/**
 * Covered-surface equality between a normalized snapshot and the current
 * inverse JSON. LWPOLYLINE vertex ids are stripped from `current` first: they
 * are provenance, not geometry, and the normalized snapshot carries none.
 */
export function entitySnapshotsEqual(
  normalized: AcadRustEntity,
  current: Json
): boolean {
  const kind = Object.keys(current)[0]
  let cmp: unknown = current
  if (kind === 'LwPolyline') {
    const payload = (current as Json).LwPolyline as Json
    const verts = (payload.vertices as Json[] | undefined) ?? []
    cmp = {
      LwPolyline: {
        ...payload,
        vertices: verts.map(v => {
          const c = { ...v }
          delete c.vertex_id
          return c
        })
      }
    }
  }
  return coveredEqual(normalized, cmp)
}

// ---------------------------------------------------------------------------
// Table records (LAYER / LTYPE / STYLE) — save-time full diff against sections.
// ---------------------------------------------------------------------------

/** Covered LAYER entry JSON (provenance handles / plot style stay on source). */
export function serializeLayer(record: AcDbLayerTableRecord): Json {
  const std = record.standardFlags ?? 0
  return {
    name: record.name,
    flags: {
      frozen: (std & 1) !== 0,
      frozen_in_new_viewport: (std & 2) !== 0,
      locked: (std & 4) !== 0,
      off: record.isOff,
      xref_dependent: (std & 16) !== 0
    },
    color: serializeColor(record.color),
    line_type: record.linetype || 'Continuous',
    line_weight: serializeLineWeight(record.lineWeight),
    is_plottable: record.isPlottable,
    transparency: serializeTransparency(record.transparency),
    description: record.description ?? ''
  }
}

export function normalizeLayer(s: AcadRustLayer): Json {
  return {
    ...s,
    color: normalizeColor(s.color),
    line_type: s.line_type || 'Continuous',
    line_weight: normalizeLineWeight(s.line_weight),
    transparency: normalizeTransparency(s.transparency)
  }
}

function serializeLtypeElement(
  el: AcGiLineTypePatternElement,
  sEl?: AcadRustLineTypeElement
): Json {
  const flag = el.elementTypeFlag ?? 0
  const isShape = (flag & 4) !== 0 && el.shapeNumber != null && el.shapeNumber !== 0
  const isText = (flag & 2) !== 0 && typeof el.text === 'string' && el.text.length > 0
  if (!isShape && !isText) {
    return { length: el.elementLength, complex: null }
  }
  return {
    length: el.elementLength,
    complex: {
      content: isShape
        ? { Shape: { shape_number: el.shapeNumber } }
        : { Text: { text: el.text } },
      // Provenance: the embedded font's STYLE handle, copied by index.
      style_handle: sEl?.complex?.style_handle ?? 0,
      scale: el.scale ?? 1,
      rotation: el.rotation ?? 0,
      absolute_rotation: (flag & 1) !== 0,
      offset: [el.offsetX ?? 0, el.offsetY ?? 0]
    }
  }
}

/** Covered LTYPE entry JSON; `baseline` supplies complex-element style handles. */
export function serializeLtype(
  record: AcDbLinetypeTableRecord,
  baseline?: AcadRustLineType
): Json {
  const lt = record.linetype
  const pattern = lt.pattern ?? []
  return {
    name: record.name,
    description: lt.description ?? '',
    pattern_length: lt.totalPatternLength ?? 0,
    elements: pattern.map((el, i) =>
      serializeLtypeElement(el, baseline?.elements?.[i])
    ),
    xref_dependent: ((lt.standardFlag ?? 0) & 16) !== 0
  }
}

export function normalizeLtype(s: AcadRustLineType): Json {
  return {
    ...s,
    elements: (s.elements ?? []).map(el => {
      const c = el.complex
      if (!c) return { length: el.length, complex: null }
      const shape = c.content?.Shape?.shape_number
      const text = c.content?.Text?.text
      const isShape = shape != null && shape !== 0
      const isText = typeof text === 'string' && text.length > 0
      // LibreDWG pseudo-complex dashes (shape 0 / empty text) forward-map to
      // plain segments; canonicalize them so untouched patterns compare equal.
      if (!isShape && !isText) return { length: el.length, complex: null }
      return {
        length: el.length,
        complex: {
          ...c,
          content: isShape
            ? { Shape: { shape_number: shape } }
            : { Text: { text } }
        }
      }
    })
  }
}

/** Covered STYLE entry JSON. */
export function serializeStyle(record: AcDbTextStyleTableRecord): Json {
  const ts = record.textStyle
  const gen = ts.textGenerationFlag ?? 0
  const std = ts.standardFlag ?? 0
  return {
    name: record.name,
    flags: { backward: (gen & 2) !== 0, upside_down: (gen & 1) !== 0 },
    height: ts.fixedTextHeight ?? 0,
    width_factor: ts.widthFactor ?? 1,
    oblique_angle: ts.obliqueAngle ?? 0,
    last_height: ts.lastHeight ?? 0,
    font_file: ts.font ?? '',
    big_font_file: ts.bigFont ?? '',
    true_type_font: ts.extendedFont ?? '',
    is_shape_file: (std & 1) !== 0,
    annotative: (std & 4) !== 0
  }
}

export function normalizeStyle(s: AcadRustTextStyle): Json {
  return { ...s, true_type_font: s.true_type_font ?? '' }
}

// ---------------------------------------------------------------------------
// Header variables (the subset mapHeader folds onto the database).
// ---------------------------------------------------------------------------

/**
 * Covered header JSON. `current_entity_color` and `handle_seed` are excluded:
 * the database stores cecolor as an ACI index (true-color identity is lost) and
 * the handle seed is allocator provenance — neither is safely round-trippable.
 */
export function serializeHeader(db: AcDbDatabase): Json {
  return {
    angle_base: db.angbase,
    angle_direction: db.angdir,
    angular_unit_format: db.aunits,
    angular_unit_precision: db.auprec,
    linear_unit_format: db.lunits,
    linear_unit_precision: db.luprec,
    insertion_units: db.insunits,
    measurement: db.measurement,
    linetype_scale: db.ltscale,
    current_entity_linetype_scale: db.celtscale,
    current_line_weight: db.celweight,
    lineweight_display: db.lwdisplay,
    paper_space_linetype_scaling: db.psltscale,
    show_model_space: db.tilemode === 1,
    ortho_mode: db.orthomode === 1,
    object_snap_mode: db.osmode,
    point_display_mode: db.pdmode,
    point_display_size: db.pdsize,
    current_linetype_name: db.celtype || 'ByLayer',
    current_layer_name: db.clayer || '0',
    current_text_style_name: db.textstyle || 'Standard',
    current_dimstyle_name: db.dimstyle || 'Standard',
    multiline_style: db.cmlstyle || 'Standard',
    current_mleader_style_name: db.cmleaderstyle || 'Standard',
    model_space_extents_min: p3(db.extmin),
    model_space_extents_max: p3(db.extmax)
  }
}

export function normalizeHeader(s: AcadRustHeader): Json {
  return {
    ...s,
    current_linetype_name: s.current_linetype_name || 'ByLayer',
    current_layer_name: s.current_layer_name || '0',
    current_text_style_name: s.current_text_style_name || 'Standard',
    current_dimstyle_name: s.current_dimstyle_name || 'Standard',
    multiline_style: s.multiline_style || 'Standard',
    current_mleader_style_name: s.current_mleader_style_name || 'Standard'
  }
}