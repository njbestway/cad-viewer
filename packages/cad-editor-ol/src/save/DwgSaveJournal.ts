/**
 * Route-B save journal: accumulates the edit change-set for one DWG database
 * and turns it into the `AcadRustChanges` wire payload `dwg_patch_save` applies
 * to the *original* file bytes.
 *
 * Capture side — the converter's open-time hooks (`onOriginalBytes`,
 * `onEntitySnapshot`, `onSectionSnapshot`) feed a module-level pending capture
 * while `read()` runs; {@link consumeDwgCapture} hands it to the journal once
 * the document is activated. The journal therefore needs no per-entity wasm
 * round-trip at save time: every baseline is already resident.
 *
 * Edit side — `entityAppended` / `entityModified` / `entityErased` maintain a
 * dirty candidate set (ATTRIB edits resolve to their owning INSERT). At save
 * time each candidate is inverse-serialized and compared against its
 * *normalized* open snapshot: an edit that undo/redo returned to the open value
 * produces no patch (idempotent, resilient to missed/duplicated events).
 * Tables and header are full-diffed against their section snapshots — no event
 * bookkeeping needed there.
 *
 * Hard rule (plan): every unsupported edit / missing baseline / new table entry
 * throws {@link RouteBError}. A save never silently degrades.
 */
import type {
  AcDbAttribute,
  AcDbBlockReference,
  AcDbDatabase,
  AcDbEntity,
  AcDbEntityEventArgs,
  AcDbLayerTableRecord,
  AcDbLinetypeTableRecord,
  AcDbTextStyleTableRecord
} from '@mlightcad/data-model'
import type {
  AcadRustAttribute,
  AcadRustChanges,
  AcadRustEntity,
  AcadRustEntryPatch,
  AcadRustHeader,
  AcadRustLayer,
  AcadRustLineType,
  AcadRustPatchAudit,
  AcadRustPatchOp,
  AcadRustSectionKind,
  AcadRustTextStyle,
  AcDbAcadRustNativeConverter
} from '@njbestway/acad-rust-converter'

import {
  entityKindOf,
  entitySnapshotsEqual,
  normalizeEntitySnapshot,
  normalizeHeader,
  normalizeLayer,
  normalizeLtype,
  normalizeStyle,
  serializeAttributePartial,
  serializeEntityFull,
  serializeEntityPartial,
  serializeHeader,
  serializeLayer,
  serializeLtype,
  serializeStyle
} from './acadRustJson'
import { coveredEqual, diffCovered, diffJson } from './jsonDiff'
import { RouteBError } from './RouteBError'

/** Same-version save window (Rust gates pre-R2004 independently). */
const SUPPORTED_VERSIONS = new Set([
  'AC1018',
  'AC1021',
  'AC1024',
  'AC1027',
  'AC1032'
])

/** The model-space block name whose handle owns MVP-added entities. */
const MODEL_SPACE_NAME = '*Model_Space'

// ---------------------------------------------------------------------------
// Open-time capture session (fed by the converter hooks).
// ---------------------------------------------------------------------------

/** Everything the journal needs from one DWG open. */
export interface DwgCapture {
  /** Source DWG bytes — the patch base for every save. */
  originalBytes?: ArrayBuffer
  /** Open-time entity serde JSON keyed by DWG handle (incl. block members). */
  entities: Map<number, AcadRustEntity>
  /** ATTRIB handle -> owning INSERT handle (edit resolution). */
  attribOwner: Map<number, number>
  /** Raw section JSON: header / tables-layer / tables-ltype / tables-style / tables-blockrecord. */
  sections: Partial<Record<AcadRustSectionKind, unknown>>
}

let pending: DwgCapture | null = null

function ensurePending(): DwgCapture {
  if (!pending) {
    pending = {
      entities: new Map(),
      attribOwner: new Map(),
      sections: {}
    }
  }
  return pending
}

/** Converter `onOriginalBytes` sink. */
export function captureOriginalBytes(bytes: ArrayBuffer): void {
  ensurePending().originalBytes = bytes
}

/** Converter `onEntitySnapshot` sink (every entity, model space + blocks). */
export function captureEntitySnapshot(entity: AcadRustEntity): void {
  const kind = Object.keys(entity)[0]
  const payload = entity[kind] as
    | { common?: { handle?: number }; attributes?: AcadRustAttribute[] }
    | undefined
  const handle = payload?.common?.handle
  if (kind == null || handle == null) return
  const cap = ensurePending()
  cap.entities.set(handle, entity)
  if (kind === 'Insert') {
    for (const a of payload?.attributes ?? []) {
      const ah = a?.common?.handle
      if (ah != null) cap.attribOwner.set(ah, handle)
    }
  }
}

/** Converter `onSectionSnapshot` sink. */
export function captureSectionSnapshot(
  kind: AcadRustSectionKind,
  json: unknown
): void {
  ensurePending().sections[kind] = json
}

/** Take the pending capture (clears it). Returns null when nothing was captured. */
export function consumeDwgCapture(): DwgCapture | null {
  const cap = pending
  pending = null
  return cap
}

// ---------------------------------------------------------------------------
// Journal.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

/** Section snapshot shape shared by the symbol tables (`Table<T>`). */
interface TableSection<T> {
  entries?: Record<string, T>
}

export class DwgSaveJournal {
  private readonly db: AcDbDatabase
  private readonly capture: DwgCapture
  /** Dirty candidate handles (ATTRIB already resolved to owning INSERT). */
  private readonly dirty = new Set<number>()
  /** Newly created entities (no DWG handle yet), tracked by identity. */
  private readonly addedEntities = new Set<AcDbEntity>()
  /** Erased source handles. */
  private readonly erased = new Set<number>()
  private disposed = false

  private readonly onAppended = (args: AcDbEntityEventArgs): void => {
    for (const entity of asArray(args.entity)) {
      const h = entity.dwgHandle
      if (h != null && this.capture.entities.has(h)) {
        // Re-append of a source entity (undo of erase): treat as an edit
        // candidate and cancel any pending erase.
        this.dirty.add(h)
        this.erased.delete(h)
      } else {
        this.addedEntities.add(entity)
      }
    }
  }

  private readonly onModified = (args: AcDbEntityEventArgs): void => {
    for (const entity of asArray(args.entity)) {
      const h = entity.dwgHandle
      if (h != null) {
        this.dirty.add(this.capture.attribOwner.get(h) ?? h)
      } else if (!this.addedEntities.has(entity)) {
        // A handle-less edit on something we never saw appended: treat it as
        // new so the full serializer covers it (never silently dropped).
        this.addedEntities.add(entity)
      }
    }
  }

  private readonly onErased = (args: AcDbEntityEventArgs): void => {
    for (const entity of asArray(args.entity)) {
      const h = entity.dwgHandle
      if (h != null) {
        this.erased.add(h)
        this.dirty.delete(h)
      }
      this.addedEntities.delete(entity)
    }
  }

  constructor(db: AcDbDatabase, capture: DwgCapture) {
    if (!capture.originalBytes) {
      throw new RouteBError(
        'no-original-bytes',
        'Route-B save requires the source DWG bytes; this document has none (DXF source or lost capture)'
      )
    }
    this.db = db
    this.capture = capture
    db.events.entityAppended.addEventListener(this.onAppended)
    db.events.entityModified.addEventListener(this.onModified)
    db.events.entityErased.addEventListener(this.onErased)
  }

  /** The source DWG bytes every patch applies to. */
  get originalBytes(): ArrayBuffer {
    return this.capture.originalBytes as ArrayBuffer
  }

  /** Unsubscribe from the database (document close / re-open). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.db.events.entityAppended.removeEventListener(this.onAppended)
    this.db.events.entityModified.removeEventListener(this.onModified)
    this.db.events.entityErased.removeEventListener(this.onErased)
  }

  /**
   * Build the change-set for the current database state. Throws
   * {@link RouteBError} on any unsupported edit, missing baseline or new table
   * entry — the caller must surface the code, never fall back to a lossy save.
   */
  buildChanges(): AcadRustChanges {
    const version = this.db.version?.name
    if (!version || !SUPPORTED_VERSIONS.has(version)) {
      throw new RouteBError(
        'unsupported-version',
        `Route-B saves AC1018–AC1032 same-version only; source is '${version ?? 'unknown'}'`
      )
    }

    // Live model-space index (handle -> entity) + identity set for added checks.
    const index = new Map<number, AcDbEntity>()
    const live = new Set<AcDbEntity>()
    for (const entity of this.db.tables.blockTable.modelSpace.newIterator()) {
      live.add(entity)
      const h = entity.dwgHandle
      if (h != null) index.set(h, entity)
    }

    const changes: AcadRustChanges = { version }
    const modified = this.buildModified(index)
    if (modified.length) changes.modified = modified
    const added = this.buildAdded(live)
    if (added.length) changes.added = added
    const erased = this.buildErased(index)
    if (erased.length) changes.erased = erased
    const tables = this.buildTables()
    if (tables) changes.tables = tables
    const header = this.buildHeader()
    if (header.length) changes.header = header
    return changes
  }

  // -- entities -------------------------------------------------------------

  private buildModified(
    index: Map<number, AcDbEntity>
  ): { handle: number; patch: AcadRustPatchOp[] }[] {
    const out: { handle: number; patch: AcadRustPatchOp[] }[] = []
    for (const handle of this.dirty) {
      if (this.erased.has(handle)) continue
      const entity = index.get(handle)
      if (!entity) {
        throw new RouteBError(
          'unsupported-edit',
          `Entity ${handle} was edited outside model space (block definition / paper space); Route-B MVP cannot patch it`
        )
      }
      const baseline = this.capture.entities.get(handle)
      if (!baseline) {
        throw new RouteBError(
          'missing-baseline',
          `No open-time snapshot for edited entity ${handle}`
        )
      }
      const kind = entityKindOf(entity)
      const baseKind = Object.keys(baseline)[0]
      if (!kind || kind !== baseKind) {
        throw new RouteBError(
          'unsupported-entity',
          `Entity ${handle} (${entity.dxfTypeName}) is outside the MVP inverse-mapping set or was remapped from '${baseKind}'`
        )
      }
      const current = serializeEntityPartial(entity, baseline) as Json
      const normalized = normalizeEntitySnapshot(baseline)
      // Scalar surface first: equal-to-normalized means no scalar ops, but an
      // INSERT may still carry ATTRIB-only edits — never skip the attribute
      // diff on scalar equality.
      const ops = entitySnapshotsEqual(normalized, current)
        ? []
        : diffJson(baseline, current)
      if (kind === 'Insert') {
        this.diffAttributes(
          baseline,
          normalized,
          entity as AcDbBlockReference,
          ops
        )
      }
      if (ops.length) out.push({ handle, patch: ops })
    }
    return out
  }

  /**
   * Per-index ATTRIB diff under `/Insert/attributes/{i}` (aligned by DWG
   * handle). A count change or a handle-less new attribute is an unsupported
   * edit: wholesale array replacement would drop ATTRIB provenance
   * (attdef_handle / line_count / common) the partial serializer cannot rebuild.
   */
  private diffAttributes(
    baseline: AcadRustEntity,
    normalized: AcadRustEntity,
    insert: AcDbBlockReference,
    ops: AcadRustPatchOp[]
  ): void {
    const sAttribs =
      ((baseline.Insert as Json).attributes as AcadRustAttribute[] | undefined) ??
      []
    const nAttribs =
      ((normalized.Insert as Json).attributes as Json[] | undefined) ?? []
    const cAttribs: AcDbAttribute[] = []
    for (const a of insert.attributeIterator()) cAttribs.push(a)
    if (sAttribs.length !== cAttribs.length) {
      throw new RouteBError(
        'unsupported-edit',
        'Adding/removing INSERT attributes is outside the Route-B MVP (attribute count changed)'
      )
    }
    for (let i = 0; i < sAttribs.length; i++) {
      const s = sAttribs[i]
      const c =
        cAttribs.find(a => a.dwgHandle === s.common.handle) ?? cAttribs[i]
      if (c.dwgHandle !== s.common.handle) {
        throw new RouteBError(
          'unsupported-edit',
          `INSERT attribute ${i} has no matching source handle (reordered or new attribute)`
        )
      }
      if (!!s.embedded_mtext !== !!c.mtext) {
        throw new RouteBError(
          'unsupported-edit',
          `INSERT attribute '${s.tag}' changed its multiline (embedded MTEXT) nature`
        )
      }
      const aCurrent = serializeAttributePartial(c)
      if (coveredEqual(nAttribs[i], aCurrent)) continue
      diffCovered(s, aCurrent, `/Insert/attributes/${i}`, ops)
    }
  }

  private buildAdded(
    live: Set<AcDbEntity>
  ): { owner?: number; entity: Record<string, unknown> }[] {
    if (this.addedEntities.size === 0) return []
    const owner = this.modelSpaceHandle()
    const out: { owner?: number; entity: Record<string, unknown> }[] = []
    for (const entity of this.addedEntities) {
      if (!live.has(entity)) continue
      out.push({ owner, entity: serializeEntityFull(entity, owner) })
    }
    return out
  }

  private buildErased(index: Map<number, AcDbEntity>): number[] {
    const out: number[] = []
    for (const handle of this.erased) {
      // A re-appended handle (undo of erase) is no longer an erase.
      if (index.has(handle)) continue
      if (this.capture.entities.has(handle)) out.push(handle)
    }
    return out
  }

  private modelSpaceHandle(): number {
    const section = this.capture.sections['tables-blockrecord'] as
      | TableSection<{ handle?: number }>
      | undefined
    // Rust tables key entries by normalize_name (upper case); the record's
    // own `name` field keeps the source casing (*Model_Space).
    const handle =
      section?.entries?.[MODEL_SPACE_NAME.toUpperCase()]?.handle
    if (handle == null) {
      throw new RouteBError(
        'missing-baseline',
        'No BLOCK-RECORD snapshot for *Model_Space; cannot route added entities'
      )
    }
    return handle
  }

  // -- tables / header --------------------------------------------------------

  private buildTables(): AcadRustChanges['tables'] | undefined {
    const layer = this.diffTable<AcadRustLayer, AcDbLayerTableRecord>(
      'tables-layer',
      this.db.tables.layerTable.newIterator(),
      r => serializeLayer(r),
      normalizeLayer
    )
    const ltype = this.diffTable<AcadRustLineType, AcDbLinetypeTableRecord>(
      'tables-ltype',
      this.db.tables.linetypeTable.newIterator(),
      (r, s) => serializeLtype(r, s),
      normalizeLtype
    )
    const style = this.diffTable<AcadRustTextStyle, AcDbTextStyleTableRecord>(
      'tables-style',
      this.db.tables.textStyleTable.newIterator(),
      r => serializeStyle(r),
      normalizeStyle
    )
    if (!layer.length && !ltype.length && !style.length) return undefined
    const tables: NonNullable<AcadRustChanges['tables']> = {}
    if (layer.length) tables.layer = layer
    if (ltype.length) tables.ltype = ltype
    if (style.length) tables.style = style
    return tables
  }

  /**
   * Full-diff one symbol table against its section snapshot. Rust
   * `patch_table` addresses entries *by name* and cannot add new ones, so a
   * resident entry missing from the baseline is a hard `new-table-entry`
   * rejection (the MVP cannot incrementally create layers/linetypes/styles).
   */
  private diffTable<T, R extends { name: string }>(
    kind: AcadRustSectionKind,
    records: Iterable<R>,
    serialize: (record: R, baseline: T | undefined) => Json,
    normalize: (baseline: T) => Json
  ): AcadRustEntryPatch[] {
    const section = this.capture.sections[kind] as TableSection<T> | undefined
    // Snapshot keys are upper-cased by Rust `normalize_name`; resident record
    // names keep the source casing. Match case-insensitively (Rust patch_table
    // resolves the emitted name through the same normalization).
    const entries = new Map<string, T>()
    for (const [key, value] of Object.entries(section?.entries ?? {})) {
      entries.set(key.toUpperCase(), value)
    }
    const out: AcadRustEntryPatch[] = []
    for (const record of records) {
      const name = record.name
      const baseline = entries.get(name.toUpperCase())
      if (!baseline) {
        throw new RouteBError(
          'new-table-entry',
          `Table entry '${name}' (${kind}) was created after open; Route-B MVP cannot add table entries incrementally`
        )
      }
      const current = serialize(record, baseline)
      if (coveredEqual(normalize(baseline), current)) continue
      const ops = diffJson(baseline, current)
      if (ops.length) out.push({ name, patch: ops })
    }
    return out
  }

  private buildHeader(): AcadRustPatchOp[] {
    const baseline = this.capture.sections['header'] as AcadRustHeader | undefined
    if (!baseline) return []
    const current = serializeHeader(this.db)
    if (coveredEqual(normalizeHeader(baseline), current)) return []
    return diffJson(baseline, current)
  }
}

function asArray(entity: AcDbEntity | AcDbEntity[]): AcDbEntity[] {
  return Array.isArray(entity) ? entity : [entity]
}

// ---------------------------------------------------------------------------
// Save orchestration (patch + mandatory fidelity audit).
// ---------------------------------------------------------------------------

/**
 * Run a Route-B save: build the change-set, patch the original bytes, then
 * audit the result. A failed audit is a hard {@link RouteBError} — the bytes
 * are never delivered past a fidelity failure (plan: no silent degradation).
 */
export async function runRouteBSave(
  converter: AcDbAcadRustNativeConverter,
  journal: DwgSaveJournal
): Promise<{ bytes: ArrayBuffer; audit: AcadRustPatchAudit }> {
  const changes = journal.buildChanges()
  const json = JSON.stringify(changes)
  const bytes = await converter.patchSave(journal.originalBytes, json)
  const audit = await converter.patchAudit(journal.originalBytes, json)
  if (!audit.ok) {
    const detail = audit.hard_errors
      .map(e =>
        e.kind === 'lost'
          ? `lost: handle ${e.handle}`
          : `${e.kind}: ${JSON.stringify(e.detail)}`
      )
      .join('; ')
    throw new RouteBError(
      'audit-failed',
      `Route-B fidelity audit failed (${audit.hard_errors.length} hard errors): ${detail}`
    )
  }
  return { bytes, audit }
}