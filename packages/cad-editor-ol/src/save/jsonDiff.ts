/**
 * RFC6902 diff for the Route-B save journal.
 *
 * The change-set is a *covered-key* diff: the current (reverse-serialized)
 * JSON only carries the fields the editor's inverse mapping understands, so
 * the walk visits the keys present in `current` and never removes keys that
 * only exist in `base` (provenance fields such as `extended_data`, reactors,
 * owner handles, vertex ids, ... stay untouched on the source record).
 *
 * Arrays are replaced wholesale when they differ — entity vertex lists and
 * linetype patterns are small enough that a whole-array `replace` is simpler
 * and safer than per-element index ops (RFC6902 array index semantics shift
 * under removals).
 *
 * Numbers compare with a relative epsilon so OCS<->WCS round-trip noise does
 * not manufacture patches for untouched geometry.
 */
import type { AcadRustPatchOp } from '@njbestway/acad-rust-converter'

/** Relative tolerance for float comparison (OCS round-trip noise floor). */
export const JSON_DIFF_EPSILON = 1e-9

/** Epsilon-aware number equality (relative to the larger magnitude, min 1). */
export function numEqual(a: number, b: number): boolean {
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return (
    Math.abs(a - b) <=
    JSON_DIFF_EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
  )
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep equality with float epsilon; key sets must match exactly. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return numEqual(a, b)
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      if (!jsonEqual(a[k], b[k])) return false
    }
    return true
  }
  return false
}

/**
 * Walk `current`'s keys against `base`, appending RFC6902 ops that transform
 * `base` into `current` on the covered surface. Keys absent from `current`
 * are left alone on `base`.
 *
 * @param base - Source value (open snapshot subtree).
 * @param current - Reverse-serialized value (covered fields only).
 * @param path - RFC6902 JSON-pointer of this subtree ('' at the root).
 * @param ops - Accumulator for the generated ops.
 */
export function diffCovered(
  base: unknown,
  current: unknown,
  path: string,
  ops: AcadRustPatchOp[]
): void {
  if (current === undefined) return

  if (isPlainObject(current)) {
    if (!isPlainObject(base)) {
      ops.push({ op: base === undefined ? 'add' : 'replace', path, value: current })
      return
    }
    for (const key of Object.keys(current)) {
      diffCovered(base[key], current[key], `${path}/${escapePointer(key)}`, ops)
    }
    return
  }

  if (Array.isArray(current)) {
    if (!jsonEqual(base, current)) {
      ops.push({ op: base === undefined ? 'add' : 'replace', path, value: current })
    }
    return
  }

  // Primitive / null leaf.
  if (base === undefined) {
    ops.push({ op: 'add', path, value: current })
  } else if (!jsonEqual(base, current)) {
    ops.push({ op: 'replace', path, value: current })
  }
}

/** RFC6902 JSON-pointer token escape (~ and /). */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Convenience: diff two trees from the root. */
export function diffJson(base: unknown, current: unknown): AcadRustPatchOp[] {
  const ops: AcadRustPatchOp[] = []
  diffCovered(base, current, '', ops)
  return ops
}

/**
 * True when `current`'s covered surface already matches `base` — i.e. the
 * covered-key diff would produce no ops. Used by the save journal to drop
 * idempotent edits (undo/redo back to the open value) before emitting patches.
 */
export function coveredEqual(base: unknown, current: unknown): boolean {
  const ops: AcadRustPatchOp[] = []
  diffCovered(base, current, '', ops)
  return ops.length === 0
}