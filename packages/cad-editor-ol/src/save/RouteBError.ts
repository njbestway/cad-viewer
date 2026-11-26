/**
 * Route-B save failure with a machine-readable code.
 *
 * The plan's hard rule: a save must never silently degrade (drop entities,
 * fall back to a lossy transcode). Every rejection path throws this error so
 * the UI can surface an explicit code instead of delivering a damaged file.
 */
export type RouteBErrorCode =
  /** The host did not retain the source DWG bytes (DXF source or lost capture). */
  | 'no-original-bytes'
  /** Source version is outside the AC1018–AC1032 same-version save window. */
  | 'unsupported-version'
  /** An edited/added entity type is outside the MVP inverse-mapping set. */
  | 'unsupported-entity'
  /** An edit the MVP cannot express as a patch (e.g. ATTRIB count change). */
  | 'unsupported-edit'
  /** A dirty entity has no open-time baseline snapshot to diff against. */
  | 'missing-baseline'
  /** A new layer/ltype/style entry: Rust patch_table cannot add table entries. */
  | 'new-table-entry'
  /** The change-set version does not match the resident database version. */
  | 'version-mismatch'
  /** The post-save fidelity audit reported hard errors. */
  | 'audit-failed'

export class RouteBError extends Error {
  readonly code: RouteBErrorCode

  constructor(code: RouteBErrorCode, message: string) {
    super(message)
    this.name = 'RouteBError'
    this.code = code
  }
}