/**
 * Route-B inverse mapping — unit tests against the real data-model runtime
 * (local override). The working database is stubbed: entity getters resolve
 * layer/color defaults through `acdbHostApplicationServices().workingDatabase`.
 */
import {
  AcDbArc,
  AcDbAttribute,
  AcDbBlockReference,
  type AcDbDatabase,
  type AcDbEntity,
  acdbHostApplicationServices,
  AcDbLine,
  AcDbMText,
  AcDbPolyline,
  AcGePoint2d,
  AcGiLineWeight} from '@mlightcad/data-model'
import type {
  AcadRustEntity,
  AcadRustLineType
} from '@njbestway/acad-rust-converter'

import {
  entityKindOf,
  entitySnapshotsEqual,
  normalizeColor,
  normalizeEntitySnapshot,
  normalizeHeader,
  normalizeLineWeight,
  normalizeLtype,
  normalizeTransparency,
  serializeColor,
  serializeEntityFull,
  serializeEntityPartial,
  serializeHeader,
  serializeLayer,
  serializeLineWeight,
  serializeLtype
} from '../../src/save/acadRustJson'
import { coveredEqual } from '../../src/save/jsonDiff'
import { RouteBError } from '../../src/save/RouteBError'

type Json = Record<string, unknown>

beforeAll(() => {
  acdbHostApplicationServices().workingDatabase = {
    clayer: '0'
  } as unknown as AcDbDatabase
})

const PLUS_Z = { x: 0, y: 0, z: 1 }

/** Covered common block of a freshly built entity, plus a source handle. */
function commonOf(entity: AcDbEntity, handle: number): Json {
  const partial = serializeEntityPartial(entity) as Json
  const kind = Object.keys(partial)[0]
  return { ...(partial[kind] as Json).common as Json, handle }
}

describe('scalar bridges', () => {
  it('folds ByLayer-ish colors onto the forward canonical form', () => {
    expect(normalizeColor('None')).toBe('ByLayer')
    expect(normalizeColor({ Index: 256 })).toBe('ByLayer')
    expect(normalizeColor({ Index: 0 })).toBe('ByBlock')
    expect(normalizeColor({ Index: 7 })).toEqual({ Index: 7 })
    expect(normalizeColor('ByBlock')).toBe('ByBlock')
    const byLayer = new AcDbLine().color
    expect(serializeColor(byLayer)).toBe('ByLayer')
  })

  it('folds negative / NoLineweight sentinels onto Default', () => {
    expect(serializeLineWeight(AcGiLineWeight.ByLayer)).toBe('ByLayer')
    expect(serializeLineWeight(AcGiLineWeight.ByBlock)).toBe('ByBlock')
    expect(serializeLineWeight(AcGiLineWeight.ByLineWeightDefault)).toBe('Default')
    expect(serializeLineWeight(35)).toEqual({ Value: 35 })
    expect(normalizeLineWeight('NoLineweight')).toBe('Default')
    expect(normalizeLineWeight({ Value: -3 })).toBe('Default')
  })

  it('collapses opaque / string transparencies onto by_layer', () => {
    expect(normalizeTransparency('by_block')).toBe('by_layer')
    expect(normalizeTransparency({ explicit: 0 })).toBe('by_layer')
    expect(normalizeTransparency({ explicit: 50 })).toEqual({ explicit: 50 })
  })
})

describe('entityKindOf', () => {
  it('maps the MVP set and rejects everything else', () => {
    expect(entityKindOf(new AcDbLine())).toBe('Line')
    expect(entityKindOf(new AcDbPolyline())).toBe('LwPolyline')
    expect(entityKindOf(new AcDbBlockReference('B'))).toBe('Insert')
    expect(entityKindOf({ dxfTypeName: 'HATCH' } as AcDbEntity)).toBeUndefined()
  })
})

describe('partial serializers', () => {
  it('LINE: covered geometry only', () => {
    const line = new AcDbLine()
    line.startPoint = { x: 0, y: 0, z: 0 }
    line.endPoint = { x: 1, y: 2, z: 0 }
    const json = serializeEntityPartial(line) as Json
    expect(json.Line).toMatchObject({
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 2, z: 0 },
      thickness: 0,
      normal: PLUS_Z
    })
    expect(Object.keys(json.Line as Json)).toEqual(
      expect.arrayContaining(['common', 'start', 'end', 'thickness', 'normal'])
    )
  })

  it('LWPOLYLINE: width-step duplication aligns snapshot with model storage', () => {
    // Source wire: 3 vertices with a width step at vertex 1 (0.5 -> 2).
    const srcVerts = [
      { location: { x: 0, y: 0 }, bulge: 0, start_width: 0.5, end_width: 0.5, vertex_id: 10 },
      { location: { x: 1, y: 0 }, bulge: 0, start_width: 2, end_width: 2, vertex_id: 11 },
      { location: { x: 2, y: 0 }, bulge: 0, start_width: 2, end_width: 2, vertex_id: 12 }
    ]
    // Model storage form: the forward mapper duplicates the step vertex.
    const model = new AcDbPolyline()
    model.addVertexAt(0, new AcGePoint2d(0, 0), 0, 0.5, 0.5)
    model.addVertexAt(1, new AcGePoint2d(1, 0), 0, 0.5, 2)
    model.addVertexAt(2, new AcGePoint2d(1, 0), 0, 2, 2)
    model.addVertexAt(3, new AcGePoint2d(2, 0), 0, 2, 2)
    const baseline = {
      LwPolyline: {
        common: commonOf(model, 5),
        vertices: srcVerts,
        is_closed: false,
        elevation: 0,
        thickness: 0,
        normal: PLUS_Z,
        constant_width: 0,
        plinegen: false
      }
    } as unknown as AcadRustEntity
    const normalized = normalizeEntitySnapshot(baseline)
    const verts = (normalized.LwPolyline as Json).vertices as Json[]
    expect(verts).toHaveLength(4)
    expect(verts[1]).toEqual({
      location: { x: 1, y: 0 },
      bulge: 0,
      start_width: 0.5,
      end_width: 2
    })
    const current = serializeEntityPartial(model, baseline) as Json
    // vertex_id provenance is copied by index and stripped for comparison.
    expect((current.LwPolyline as Json).vertices).toHaveLength(4)
    expect(entitySnapshotsEqual(normalized, current)).toBe(true)
  })

  it('ARC: a full-turn start angle normalizes to 0 (setter semantics)', () => {
    const model = new AcDbArc() // startAngle 0, endAngle π/2
    const baseline = {
      Arc: {
        common: commonOf(model, 6),
        center: { x: 0, y: 0, z: 0 },
        radius: 1,
        start_angle: Math.PI * 2,
        end_angle: Math.PI / 2,
        thickness: 0,
        normal: PLUS_Z
      }
    } as unknown as AcadRustEntity
    const normalized = normalizeEntitySnapshot(baseline)
    expect((normalized.Arc as Json).start_angle).toBe(0)
    expect(
      entitySnapshotsEqual(normalized, serializeEntityPartial(model, baseline) as Json)
    ).toBe(true)
  })

  it('MTEXT: planar direction is re-derived from rotation on both sides', () => {
    const model = new AcDbMText()
    model.contents = 'x'
    model.height = 1
    model.rotation = Math.PI / 2 // setter does NOT sync `direction`
    const baseline = {
      MText: {
        common: commonOf(model, 7),
        value: 'x',
        insertion_point: { x: 0, y: 0, z: 0 },
        height: 1,
        rectangle_width: 0,
        rotation: Math.PI / 2,
        dwg_x_direction: { x: 1, y: 0, z: 0 }, // stale source vector
        style: 'Standard',
        attachment_point: 'TopLeft',
        drawing_direction: 'LeftToRight',
        line_spacing_factor: 1,
        line_spacing_style: 'AtLeast',
        normal: PLUS_Z,
        background_fill_flags: 0,
        extents_width: 0
      }
    } as unknown as AcadRustEntity
    const normalized = normalizeEntitySnapshot(baseline)
    const dir = (normalized.MText as Json).dwg_x_direction as Json
    expect(dir.y).toBeCloseTo(1, 9)
    expect(
      entitySnapshotsEqual(normalized, serializeEntityPartial(model, baseline) as Json)
    ).toBe(true)
  })
})

describe('full serializers (added entities)', () => {
  it('LINE: complete EntityCommon with handle 0 and the target owner', () => {
    const line = new AcDbLine()
    const json = serializeEntityFull(line, 31) as Json
    const common = (json.Line as Json).common as Json
    expect(common.handle).toBe(0)
    expect(common.owner_handle).toBe(31)
    expect(common.extended_data).toEqual({ records: [] })
    expect(common.reactors).toEqual([])
    expect(common.xdictionary_handle).toBeNull()
  })

  it('MTEXT: serde-required extras are present', () => {
    const json = serializeEntityFull(new AcDbMText(), 31) as Json
    const p = json.MText as Json
    expect(p.background_color).toBe('ByLayer')
    expect(p.background_transparency).toBe(0)
    expect(p.column_data).toMatchObject({ column_type: 0, heights: [] })
  })

  it('INSERT: attributes carry attdef/line_count provenance defaults', () => {
    const br = new AcDbBlockReference('B1')
    const at = new AcDbAttribute()
    at.tag = 'T'
    at.textString = 'v'
    br.appendAttributes(at)
    const json = serializeEntityFull(br, 31) as Json
    const attribs = (json.Insert as Json).attributes as Json[]
    expect(attribs).toHaveLength(1)
    expect(attribs[0]).toMatchObject({ attdef_handle: 0, line_count: 1, tag: 'T', value: 'v' })
    expect((attribs[0].flags as Json).annotative).toBe(false)
  })

  it('rejects entity types outside the MVP creatable set', () => {
    expect(() =>
      serializeEntityFull({ dxfTypeName: 'HATCH' } as AcDbEntity, 31)
    ).toThrow(RouteBError)
  })
})

describe('table / header normalization', () => {
  it('LTYPE: pseudo-complex dashes fold to plain segments on both sides', () => {
    const baseline = {
      name: 'LT',
      description: '',
      pattern_length: 1,
      elements: [
        {
          length: 1,
          complex: {
            content: { Shape: { shape_number: 0 } },
            style_handle: 9,
            scale: 1,
            rotation: 0,
            absolute_rotation: false,
            offset: [0, 0]
          }
        }
      ],
      xref_dependent: false
    } as unknown as AcadRustLineType
    const record = {
      name: 'LT',
      linetype: {
        description: '',
        totalPatternLength: 1,
        standardFlag: 0,
        pattern: [{ elementLength: 1, elementTypeFlag: 0 }]
      }
    }
    const current = serializeLtype(record as never, baseline)
    expect(coveredEqual(normalizeLtype(baseline), current)).toBe(true)
  })

  it('LAYER: covered flags decode from standardFlags + isOff', () => {
    const record = {
      name: 'L1',
      standardFlags: 4, // locked
      isOff: true,
      color: new AcDbLine().color,
      linetype: 'Continuous',
      lineWeight: AcGiLineWeight.ByLayer,
      isPlottable: true,
      transparency: new AcDbLine().transparency,
      description: ''
    }
    const json = serializeLayer(record as never)
    expect(json.flags).toEqual({
      frozen: false,
      frozen_in_new_viewport: false,
      locked: true,
      off: true,
      xref_dependent: false
    })
  })

  it('header: excludes cecolor/handle_seed and folds empty style names', () => {
    const db = {
      angbase: 0, angdir: 0, aunits: 0, auprec: 0, lunits: 2, luprec: 4,
      insunits: 0, measurement: 0, ltscale: 1, celtscale: 1, celweight: -1,
      lwdisplay: 0, psltscale: 0, tilemode: 1, orthomode: 0, osmode: 0,
      pdmode: 0, pdsize: 0, celtype: '', clayer: '', textstyle: '',
      dimstyle: '', cmlstyle: '', cmleaderstyle: '',
      extmin: { x: 0, y: 0, z: 0 }, extmax: { x: 1, y: 1, z: 0 }
    } as unknown as AcDbDatabase
    const json = serializeHeader(db)
    expect(json).not.toHaveProperty('current_entity_color')
    expect(json).not.toHaveProperty('handle_seed')
    expect(json.current_layer_name).toBe('0')
    const normalized = normalizeHeader({ ...json, current_text_style_name: '' } as never)
    expect(normalized.current_text_style_name).toBe('Standard')
    expect(coveredEqual(normalized, json)).toBe(true)
  })
})