import { AcGePoint2dLike, AcGePoint3d } from '@mlightcad/data-model'

/**
 * Joint tolerance (drawing units) for detecting a shared vertex between two
 * consecutive wide-polyline segment quads when reconstructing its centerline.
 * The data model reuses the exact same joint point object across neighboring
 * segment quads, so real bands match to 0; the epsilon only guards float drift
 * introduced by tessellation.
 */
const WIDE_BAND_JOINT_TOLERANCE = 1e-6

/**
 * Geometric summary of a reconstructable wide-polyline solid-fill band.
 */
export interface AcTrWidePolylineBand {
  /** WCS centerline walked along the segment-quad chain. */
  centerline: AcGePoint3d[]
  /** Smallest cap-edge width across all segment quads (drawing units). */
  minWidth: number
  /** Bounding-box diagonal of the band (drawing units), a scale reference. */
  diagonal: number
}

const same = (a: AcGePoint2dLike, b: AcGePoint2dLike): boolean =>
  Math.abs(a.x - b.x) <= WIDE_BAND_JOINT_TOLERANCE &&
  Math.abs(a.y - b.y) <= WIDE_BAND_JOINT_TOLERANCE

const dist2 = (a: AcGePoint2dLike, b: AcGePoint2dLike): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

/** Drops the repeated closing vertex of a closed loop, if present. */
function toUniqueClosed(pts: AcGePoint2dLike[]): AcGePoint2dLike[] {
  const out = pts.slice()
  if (out.length >= 2 && same(out[0], out[out.length - 1])) {
    out.pop()
  }
  return out
}

function bboxDiagonal(pts: AcGePoint2dLike[]): number {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

/**
 * Drops exactly-duplicated boundary loops while preserving order. Some
 * tessellators emit every per-segment quad twice (a wide polyline appears as
 * `2*N` loops of `N` unique quads), which would otherwise break the chain walk
 * at the first repeated quad. Only byte-identical loops collapse, so distinct
 * geometry (hatches, overlapping-but-different quads) is untouched.
 */
function dedupeLoops(loops: AcGePoint2dLike[][]): AcGePoint2dLike[][] {
  const seen = new Set<string>()
  const out: AcGePoint2dLike[][] = []
  for (const loop of loops) {
    let key = ''
    for (const p of loop) key += `${p.x},${p.y};`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(loop)
    }
  }
  return out
}

/**
 * Reconstructs a wide-polyline band that some tessellators emit as its two long
 * boundary edges (`[edgeA, edgeB]`, one sample per polyline vertex on each
 * side) instead of a per-segment quad chain. The centerline is the pairwise
 * midpoint of the two edges; the band width is the gap between paired samples.
 *
 * Traversal direction of the two edges is not guaranteed, so both index orders
 * are tried and the pairing with the smaller average gap (the true offset
 * correspondence) wins.
 *
 * @param loops - Tessellated boundary loops of the fill area.
 * @returns Band metrics + centerline, or `null` when the loops are not a clean
 * equal-length two-edge pair (so the caller keeps its other paths / plain fill).
 */
export function measureOffsetEdgeBand(
  loops: AcGePoint2dLike[][]
): AcTrWidePolylineBand | null {
  const pair = dedupeLoops(loops)
  if (pair.length !== 2) {
    return null
  }
  const a = toUniqueClosed(pair[0])
  const b = toUniqueClosed(pair[1])
  if (a.length < 2 || a.length !== b.length) {
    return null
  }

  const mid = (p: AcGePoint2dLike, q: AcGePoint2dLike): AcGePoint3d =>
    new AcGePoint3d((p.x + q.x) / 2, (p.y + q.y) / 2, 0)

  const score = (
    map: (i: number) => number
  ): { centerline: AcGePoint3d[]; avgGap: number; minWidth: number } => {
    const centerline: AcGePoint3d[] = []
    let sum = 0
    let minWidth = Number.POSITIVE_INFINITY
    for (let i = 0; i < a.length; i++) {
      const q = b[map(i)]
      const gap = dist2(a[i], q)
      sum += gap
      if (gap < minWidth) minWidth = gap
      centerline.push(mid(a[i], q))
    }
    return { centerline, avgGap: sum / a.length, minWidth }
  }

  // Direct pairing (i -> i) vs reversed (i -> n-1-i); the smaller average gap is
  // the real edge correspondence.
  const direct = score(i => i)
  const reversed = score(i => a.length - 1 - i)
  const best = direct.avgGap <= reversed.avgGap ? direct : reversed
  if (!(best.minWidth > 0)) {
    // Degenerate: the two edges coincide -> not a reconstructable band.
    return null
  }

  const all = a.concat(b)
  return {
    centerline: best.centerline,
    // Paired edges sit `minWidth` apart, so that gap is the polyline width.
    minWidth: best.minWidth,
    diagonal: bboxDiagonal(all)
  }
}

/**
 * Measures a wide-polyline solid-fill band and reconstructs its WCS centerline
 * from the tessellated loops.
 *
 * A wide polyline is emitted as a chain of per-segment quads. Each quad is
 * ordered `[leftStart, leftEnd, rightEnd, rightStart]` (closed, so a tessellated
 * loop may repeat the first point at the end), and consecutive quads share their
 * joint vertices: `prev.leftEnd === next.leftStart` and
 * `prev.rightEnd === next.rightStart`. The centerline is the sequence of cap-edge
 * midpoints walked along that chain; the band width is the length of each cap
 * edge (`leftStart`↔`rightStart`, `leftEnd`↔`rightEnd`).
 *
 * @param loops - Tessellated boundary loops of the fill area.
 * @param options - `allowSingleQuad` permits a one-segment band (a single
 * `2`-vertex wide polyline). Because a lone quad is geometrically identical to
 * a rectangular solid hatch, callers must only set this when the linetype is
 * genuinely complex (embeds TEXT/SHAPE) or when they separately guard against
 * mis-stroking hatches, so plain hatches are never mis-stroked.
 * @returns Band metrics + centerline when the loops form a reconstructable
 * segment-quad chain, or `null` when they do not (non-quad boundary such as a
 * hatch, or a broken/self-revisiting chain) so the caller keeps a plain fill.
 */
export function measureWidePolylineBand(
  loops: AcGePoint2dLike[][],
  options?: { allowSingleQuad?: boolean }
): AcTrWidePolylineBand | null {
  // Tessellators may emit each segment quad twice; collapse byte-identical loops
  // first so the chain walk sees the true `N`-quad sequence.
  const uniqueLoops = dedupeLoops(loops)
  const minLoops = options?.allowSingleQuad ? 1 : 2
  if (uniqueLoops.length < minLoops) {
    return null
  }

  const same = (a: AcGePoint2dLike, b: AcGePoint2dLike): boolean =>
    Math.abs(a.x - b.x) <= WIDE_BAND_JOINT_TOLERANCE &&
    Math.abs(a.y - b.y) <= WIDE_BAND_JOINT_TOLERANCE

  const dist = (a: AcGePoint2dLike, b: AcGePoint2dLike): number =>
    Math.hypot(a.x - b.x, a.y - b.y)

  // Every loop must be a single segment quad: [leftStart, leftEnd, rightEnd,
  // rightStart] after dropping the closing duplicate.
  const quads: AcGePoint2dLike[][] = []
  let minWidth = Number.POSITIVE_INFINITY
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const loop of uniqueLoops) {
    const pts = loop.slice()
    if (pts.length >= 2 && same(pts[0], pts[pts.length - 1])) {
      pts.pop()
    }
    if (pts.length !== 4) {
      return null
    }
    // Cap edges (0-3 and 1-2) carry the band width; average both for robustness.
    const width = (dist(pts[0], pts[3]) + dist(pts[1], pts[2])) / 2
    if (width < minWidth) {
      minWidth = width
    }
    for (const p of pts) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    quads.push(pts)
  }

  const mid = (a: AcGePoint2dLike, b: AcGePoint2dLike): AcGePoint3d =>
    new AcGePoint3d((a.x + b.x) / 2, (a.y + b.y) / 2, 0)

  const centerline: AcGePoint3d[] = []
  for (let i = 0; i < quads.length; i++) {
    const [leftStart, , , rightStart] = quads[i]
    if (i > 0) {
      const prev = quads[i - 1]
      // Consecutive quads must share the joint edge, otherwise this is not a
      // single continuous band (independent hatches, self-revisiting paths).
      if (!same(prev[1], leftStart) || !same(prev[2], rightStart)) {
        return null
      }
    }
    centerline.push(mid(leftStart, rightStart))
  }
  const lastQuad = quads[quads.length - 1]
  centerline.push(mid(lastQuad[1], lastQuad[2]))

  if (centerline.length < 2) {
    return null
  }
  return {
    centerline,
    minWidth: Number.isFinite(minWidth) ? minWidth : 0,
    diagonal: Math.hypot(maxX - minX, maxY - minY)
  }
}

/**
 * Reconstructs the WCS centerline of a wide-polyline solid-fill band from its
 * tessellated loops so a non-continuous linetype (or a needle-thin band that
 * would otherwise render sub-pixel) can be stroked instead of filled solid.
 *
 * @returns Centerline points when the loops form a reconstructable segment-quad
 * chain, or `null` to leave it as a plain fill.
 */
export function reconstructWidePolylineCenterline(
  loops: AcGePoint2dLike[][],
  options?: { allowSingleQuad?: boolean }
): AcGePoint3d[] | null {
  return measureWidePolylineBand(loops, options)?.centerline ?? null
}
