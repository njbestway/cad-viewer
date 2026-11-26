/**
 * Route-B save journal — unit tests with a fake database (real event manager,
 * stub tables/header) and converter-hook-fed captures. No wasm involved:
 * `runRouteBSave` is exercised against a fake converter.
 */
import {
  AcCmEventManager,
  AcDbAttribute,
  AcDbBlockReference,
  type AcDbDatabase,
  type AcDbEntity,
  type AcDbEntityEventArgs,
  acdbHostApplicationServices,
  AcDbLine} from '@mlightcad/data-model'
import type {
  AcadRustChanges,
  AcadRustEntity,
  AcDbAcadRustNativeConverter
} from '@njbestway/acad-rust-converter'

import { serializeEntityFull, serializeHeader, serializeLayer } from '../../src/save/acadRustJson'
import {
  captureEntitySnapshot,
  captureOriginalBytes,
  captureSectionSnapshot,
  consumeDwgCapture,
  type DwgCapture,
  DwgSaveJournal,
  runRouteBSave} from '../../src/save/DwgSaveJournal'
import { RouteBError } from '../../src/save/RouteBError'

type Json = Record<string, unknown>

const MODEL_SPACE_HANDLE = 31

beforeAll(() => {
  acdbHostApplicationServices().workingDatabase = {
    clayer: '0'
  } as unknown as AcDbDatabase
})

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

interface FakeDb {
  db: AcDbDatabase
  entities: AcDbEntity[]
  layers: Json[]
  events: {
    entityAppended: AcCmEventManager<AcDbEntityEventArgs>
    entityModified: AcCmEventManager<AcDbEntityEventArgs>
    entityErased: AcCmEventManager<AcDbEntityEventArgs>
  }
}

function makeFakeDb(entities: AcDbEntity[] = []): FakeDb {
  const events = {
    entityAppended: new AcCmEventManager<AcDbEntityEventArgs>(),
    entityModified: new AcCmEventManager<AcDbEntityEventArgs>(),
    entityErased: new AcCmEventManager<AcDbEntityEventArgs>()
  }
  const state: AcDbEntity[] = [...entities]
  const layers: Json[] = []
  const header = {
    angbase: 0, angdir: 0, aunits: 0, auprec: 0, lunits: 2, luprec: 4,
    insunits: 0, measurement: 0, ltscale: 1, celtscale: 1, celweight: -1,
    lwdisplay: 0, psltscale: 0, tilemode: 1, orthomode: 0, osmode: 0,
    pdmode: 0, pdsize: 0, celtype: 'ByLayer', clayer: '0', textstyle: 'Standard',
    dimstyle: 'Standard', cmlstyle: 'Standard', cmleaderstyle: 'Standard',
    extmin: { x: 0, y: 0, z: 0 }, extmax: { x: 1, y: 1, z: 0 }
  }
  const db = {
    version: { name: 'AC1027' },
    events,
    ...header,
    tables: {
      blockTable: { modelSpace: { newIterator: () => state[Symbol.iterator]() } },
      layerTable: { newIterator: () => layers[Symbol.iterator]() },
      linetypeTable: { newIterator: () => [][Symbol.iterator]() },
      textStyleTable: { newIterator: () => [][Symbol.iterator]() }
    }
  } as unknown as AcDbDatabase
  return { db, entities: state, layers, events }
}

/** Wire-shaped open snapshot of a model entity, with real source handles. */
function snapOf(entity: AcDbEntity, handle: number): AcadRustEntity {
  const full = serializeEntityFull(entity, MODEL_SPACE_HANDLE) as Json
  const kind = Object.keys(full)[0]
  const payload = full[kind] as Json
  ;(payload.common as Json).handle = handle
  if (kind === 'Insert') {
    let ah = handle + 100
    for (const a of (payload.attributes as Json[]) ?? []) {
      ;(a.common as Json).handle = ah++
    }
  }
  return full as unknown as AcadRustEntity
}

/** Feed the converter hooks and consume the capture, like documentActivated. */
function captureFor(
  fake: FakeDb,
  snaps: AcadRustEntity[],
  extraSections: Record<string, unknown> = {}
): DwgCapture {
  captureOriginalBytes(new ArrayBuffer(8))
  for (const s of snaps) captureEntitySnapshot(s)
  captureSectionSnapshot('header', serializeHeader(fake.db))
  captureSectionSnapshot('tables-blockrecord', {
    entries: { '*MODEL_SPACE': { handle: MODEL_SPACE_HANDLE } }
  })
  for (const [kind, json] of Object.entries(extraSections)) {
    captureSectionSnapshot(kind as never, json)
  }
  const cap = consumeDwgCapture()
  if (!cap) throw new Error('capture lost')
  return cap
}

function makeLine(x = 1, y = 2): AcDbLine {
  const line = new AcDbLine()
  line.startPoint = { x: 0, y: 0, z: 0 }
  line.endPoint = { x, y, z: 0 }
  return line
}

/** Dispatch an entity event with the full args shape (database required). */
function fire(
  ev: AcCmEventManager<AcDbEntityEventArgs>,
  db: AcDbDatabase,
  entity: AcDbEntity
): void {
  ev.dispatch({ entity, database: db })
}

// ---------------------------------------------------------------------------
// Gates.
// ---------------------------------------------------------------------------

describe('DwgSaveJournal gates', () => {
  it('rejects a capture without source bytes (DXF source / lost capture)', () => {
    const fake = makeFakeDb()
    const cap: DwgCapture = { entities: new Map(), attribOwner: new Map(), sections: {} }
    expect(() => new DwgSaveJournal(fake.db, cap)).toThrow(RouteBError)
    try {
      new DwgSaveJournal(fake.db, cap)
    } catch (e) {
      expect((e as RouteBError).code).toBe('no-original-bytes')
    }
  })

  it('rejects pre-R2004 / unknown versions', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    ;(fake.db as unknown as Json).version = { name: 'AC1015' }
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    expect(() => journal.buildChanges()).toThrow(RouteBError)
    try {
      journal.buildChanges()
    } catch (e) {
      expect((e as RouteBError).code).toBe('unsupported-version')
    }
    journal.dispose()
  })

  it('rejects edits on entities outside model space', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const outside = makeLine()
    outside.dwgHandle = 99
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    fire(fake.events.entityModified, fake.db, outside)
    try {
      journal.buildChanges()
      throw new Error('expected RouteBError')
    } catch (e) {
      expect((e as RouteBError).code).toBe('unsupported-edit')
    }
    journal.dispose()
  })

  it('rejects dirty entities outside the MVP inverse-mapping set', () => {
    const hatch = { dxfTypeName: 'HATCH', dwgHandle: 9 } as unknown as AcDbEntity
    const fake = makeFakeDb([hatch])
    const cap = captureFor(fake, [])
    cap.entities.set(9, { Hatch: { common: { handle: 9 } } } as unknown as AcadRustEntity)
    const journal = new DwgSaveJournal(fake.db, cap)
    fire(fake.events.entityModified, fake.db, hatch)
    try {
      journal.buildChanges()
      throw new Error('expected RouteBError')
    } catch (e) {
      expect((e as RouteBError).code).toBe('unsupported-entity')
    }
    journal.dispose()
  })

  it('rejects table entries created after open (Rust cannot add them)', () => {
    const fake = makeFakeDb()
    fake.layers.push({ name: 'NEW' })
    const journal = new DwgSaveJournal(
      fake.db,
      captureFor(fake, [], { 'tables-layer': { entries: {} } })
    )
    try {
      journal.buildChanges()
      throw new Error('expected RouteBError')
    } catch (e) {
      expect((e as RouteBError).code).toBe('new-table-entry')
    }
    journal.dispose()
  })
})

// ---------------------------------------------------------------------------
// Change-set generation.
// ---------------------------------------------------------------------------

describe('DwgSaveJournal change-set', () => {
  it('is idempotent: a dirty candidate equal to the open value emits nothing', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    fire(fake.events.entityModified, fake.db, line)
    expect(journal.buildChanges()).toEqual({ version: 'AC1027' })
    journal.dispose()
  })

  it('emits a pointed RFC6902 replace for a LINE endpoint edit', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    line.endPoint = { x: 9, y: 2, z: 0 }
    fire(fake.events.entityModified, fake.db, line)
    const changes = journal.buildChanges()
    expect(changes.modified).toEqual([
      { handle: 5, patch: [{ op: 'replace', path: '/Line/end/x', value: 9 }] }
    ])
    journal.dispose()
  })

  it('undo back to the open value cancels the patch (event-loss resilient)', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    line.endPoint = { x: 9, y: 2, z: 0 }
    fire(fake.events.entityModified, fake.db, line)
    line.endPoint = { x: 1, y: 2, z: 0 }
    fire(fake.events.entityModified, fake.db, line)
    expect(journal.buildChanges().modified).toBeUndefined()
    journal.dispose()
  })

  it('erase removes the handle; re-append (undo) cancels the erase', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    fake.entities.splice(0, 1)
    fire(fake.events.entityErased, fake.db, line)
    expect(journal.buildChanges().erased).toEqual([5])
    fake.entities.push(line)
    fire(fake.events.entityAppended, fake.db, line)
    const changes = journal.buildChanges()
    expect(changes.erased).toBeUndefined()
    expect(changes.modified).toBeUndefined()
    journal.dispose()
  })

  it('routes a handle-less appended entity to model space with handle 0', () => {
    const fake = makeFakeDb()
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, []))
    const added = makeLine(7, 8)
    fake.entities.push(added)
    fire(fake.events.entityAppended, fake.db, added)
    const changes = journal.buildChanges()
    expect(changes.added).toHaveLength(1)
    expect(changes.added?.[0].owner).toBe(MODEL_SPACE_HANDLE)
    const entity = changes.added?.[0].entity as Json
    expect((entity.Line as Json).common).toMatchObject({
      handle: 0,
      owner_handle: MODEL_SPACE_HANDLE
    })
    journal.dispose()
  })

  it('ATTRIB-only edit: resolves the owning INSERT and diffs per index', () => {
    const br = new AcDbBlockReference('B1')
    const at = new AcDbAttribute()
    at.tag = 'T1'
    at.textString = 'old'
    br.appendAttributes(at)
    br.dwgHandle = 5
    at.dwgHandle = 105
    const fake = makeFakeDb([br])
    const snap = snapOf(br, 5) // attribute common.handle becomes 105
    const cap = captureFor(fake, [snap])
    expect(cap.attribOwner.get(105)).toBe(5)
    const journal = new DwgSaveJournal(fake.db, cap)
    at.textString = 'new'
    fire(fake.events.entityModified, fake.db, at)
    const changes = journal.buildChanges()
    expect(changes.modified).toEqual([
      {
        handle: 5,
        patch: [{ op: 'replace', path: '/Insert/attributes/0/value', value: 'new' }]
      }
    ])
    journal.dispose()
  })

  it('diffs a LAYER flag edit against the section snapshot', () => {
    const fake = makeFakeDb()
    const record = {
      name: 'L1',
      standardFlags: 0,
      isOff: false,
      color: makeLine().color,
      linetype: 'Continuous',
      lineWeight: -1,
      isPlottable: true,
      transparency: makeLine().transparency,
      description: ''
    }
    const baseline = serializeLayer(record as never)
    fake.layers.push(record)
    const journal = new DwgSaveJournal(
      fake.db,
      captureFor(fake, [], { 'tables-layer': { entries: { L1: baseline } } })
    )
    record.isOff = true
    const changes = journal.buildChanges()
    expect(changes.tables?.layer).toEqual([
      { name: 'L1', patch: [{ op: 'replace', path: '/flags/off', value: true }] }
    ])
    journal.dispose()
  })

  it('matches table snapshot keys case-insensitively (Rust normalize_name)', () => {
    const fake = makeFakeDb()
    const record = {
      name: 'MyLayer',
      standardFlags: 0,
      isOff: false,
      color: makeLine().color,
      linetype: 'Continuous',
      lineWeight: -1,
      isPlottable: true,
      transparency: makeLine().transparency,
      description: ''
    }
    const baseline = serializeLayer(record as never)
    fake.layers.push(record)
    const journal = new DwgSaveJournal(
      fake.db,
      // Real snapshots key entries upper-cased while record.name keeps casing.
      captureFor(fake, [], {
        'tables-layer': { entries: { MYLAYER: baseline } }
      })
    )
    record.isOff = true
    const changes = journal.buildChanges()
    expect(changes.tables?.layer).toEqual([
      {
        name: 'MyLayer',
        patch: [{ op: 'replace', path: '/flags/off', value: true }]
      }
    ])
    journal.dispose()
  })

  it('diffs header variables (ltscale) against the header snapshot', () => {
    const fake = makeFakeDb()
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, []))
    ;(fake.db as unknown as Json).ltscale = 2
    const changes = journal.buildChanges()
    expect(changes.header).toEqual([
      { op: 'replace', path: '/linetype_scale', value: 2 }
    ])
    journal.dispose()
  })

  it('dispose unsubscribes: later events no longer dirty the journal', () => {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    journal.dispose()
    line.endPoint = { x: 9, y: 2, z: 0 }
    fire(fake.events.entityModified, fake.db, line)
    expect(journal.buildChanges().modified).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Save orchestration.
// ---------------------------------------------------------------------------

describe('runRouteBSave', () => {
  function setup() {
    const line = makeLine()
    line.dwgHandle = 5
    const fake = makeFakeDb([line])
    const journal = new DwgSaveJournal(fake.db, captureFor(fake, [snapOf(line, 5)]))
    return { fake, journal }
  }

  it('returns bytes when the audit passes', async () => {
    const { journal } = setup()
    const out = new ArrayBuffer(4)
    const converter = {
      patchSave: jest.fn(async () => out),
      patchAudit: jest.fn(async () => ({ ok: true, hard_errors: [] }))
    } as unknown as AcDbAcadRustNativeConverter
    const result = await runRouteBSave(converter, journal)
    expect(result.bytes).toBe(out)
    expect(converter.patchSave).toHaveBeenCalledWith(
      journal.originalBytes,
      JSON.stringify({ version: 'AC1027' } as AcadRustChanges)
    )
    journal.dispose()
  })

  it('a failed audit is a hard error — bytes are never delivered', async () => {
    const { journal } = setup()
    const converter = {
      patchSave: jest.fn(async () => new ArrayBuffer(4)),
      patchAudit: jest.fn(async () => ({
        ok: false,
        hard_errors: [
          { kind: 'lost', handle: 7 },
          { kind: 'unexpected_reencode', detail: { handle: 8 } }
        ]
      }))
    } as unknown as AcDbAcadRustNativeConverter
    await expect(runRouteBSave(converter, journal)).rejects.toMatchObject({
      name: 'RouteBError',
      code: 'audit-failed'
    })
    await expect(runRouteBSave(converter, journal)).rejects.toThrow(/lost: handle 7/)
    journal.dispose()
  })
})