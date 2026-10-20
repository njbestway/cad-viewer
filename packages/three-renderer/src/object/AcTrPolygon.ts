import {
  acdbDrawTessellateOptions,
  AcGeArea2d,
  AcGeGeometryUtil,
  AcGeIndexNode,
  AcGePoint2d,
  AcGePoint2dLike,
  AcGiSubEntityTraits,
  log
} from '@mlightcad/data-model'
import { GeometryEpsilon, PolyBool } from '@velipso/polybool'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import { resolveAnchorFromBox } from '../draw/AcTrBatchDrawPolicy'
import type { AcTrDrawMode } from '../draw/AcTrDrawMode'
import { AcTrRenderContext } from '../renderer/AcTrRenderContext'
import { AcTrBufferGeometryUtil } from '../util/AcTrBufferGeometryUtil'
import { AcTrEntity } from './AcTrEntity'
import {
  type AcTrHatchLoopRegion,
  hatchLoopHasRenderableArea,
  resolveSelfIntersectingHatchLoopRegions
} from './AcTrHatchLoopRepair'

function toVector2(points: AcGePoint2dLike[]): THREE.Vector2[] {
  return points
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(point => new THREE.Vector2(point.x, point.y))
}

/**
 * True when a ring lies inside (or on) another ring.
 *
 * Uses a majority vote of the ring's vertices instead of a single vertex:
 * self-intersect repair produces regions that share their crossing vertex with
 * the parent ring, and a point-in-polygon test on that shared vertex is
 * ambiguous (it can report one solid lobe as being inside its sibling).
 */
function isHoleInsideOuter(
  hole: AcGePoint2dLike[],
  outer: AcGePoint2dLike[]
): boolean {
  let vertices = 0
  let inside = 0
  for (const point of hole) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue
    }
    vertices++
    if (AcGeGeometryUtil.isPointInPolygon(point, outer, true)) {
      inside++
    }
  }
  return vertices > 0 && inside * 2 > vertices
}

function hasFillVertices(geometry: THREE.BufferGeometry | undefined): boolean {
  if (!geometry) {
    return false
  }
  const position = geometry.getAttribute('position')
  return !!position && position.count > 0
}

/**
 * Bounding-box center of tessellated hatch loops in float64 WCS.
 * Used as the origin-shift for patterned hatches so GPU float32 pattern math
 * (`fract` / `floor` on `v_pos`) stays precise at large survey coordinates.
 */
function computeLocalOriginFromLoops(
  loops: AcGePoint2dLike[][]
): THREE.Vector3 | undefined {
  const box = new THREE.Box3()
  let hasPoint = false
  for (const loop of loops) {
    for (const point of loop) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        continue
      }
      box.expandByPoint(_tmpPoint.set(point.x, point.y, 0))
      hasPoint = true
    }
  }
  if (!hasPoint || box.isEmpty()) {
    return undefined
  }
  return box.getCenter(new THREE.Vector3())
}

/** Returns hatch loops translated so `origin` becomes the local (0,0). */
function offsetLoops(
  loops: AcGePoint2d[][],
  origin: THREE.Vector3
): AcGePoint2d[][] {
  return loops.map(loop =>
    loop.map(
      point => new AcGePoint2d(point.x - origin.x, point.y - origin.y)
    )
  )
}

const _tmpPoint = /*@__PURE__*/ new THREE.Vector3()

export class AcTrPolygon extends AcTrEntity {
  private _traits: AcGiSubEntityTraits

  constructor(
    area: AcGeArea2d,
    traits: AcGiSubEntityTraits,
    context: AcTrRenderContext
  ) {
    super(context)
    this._traits = traits

    const tessellateOptions = acdbDrawTessellateOptions({ context })
    const pointBoundaries = area.tessellate(tessellateOptions)
    // Reuse sampled loops so buildHierarchy does not tessellate a second time.
    const hierarchy = (
      Object.create(area, {
        tessellate: { value: () => pointBoundaries }
      }) as AcGeArea2d
    ).buildHierarchy(tessellateOptions)
    const hasRenderableBoundaries = pointBoundaries.some(loop =>
      hatchLoopHasRenderableArea(loop)
    )

    // Rebasing object-space vertices near a local origin keeps the Float32
    // buffers precise at large survey coordinates (ulp ~4 at x≈3.6e7 collapses
    // small fills into jagged blobs). Patterned hatches additionally shift the
    // shader pattern `base` by the same offset so `fract`/`floor` spacing stays
    // correct. Solid fills are baked into shared batch buffers here (block
    // templates and `group`ed multi-area hatches bypass the per-entity rebase in
    // {@link buildAreaGeometry}), so they need this shift too. Gradient fills
    // are left untranslated: their material relies on un-shifted WCS bounds.
    const isPatterned = this.isPatternedHatch(traits)
    const isGradient = !!traits.fillType.gradient
    let localOrigin: THREE.Vector3 | undefined
    let boundariesForGeometry = pointBoundaries
    if (!isGradient) {
      localOrigin = computeLocalOriginFromLoops(pointBoundaries)
      if (localOrigin) {
        boundariesForGeometry = offsetLoops(pointBoundaries, localOrigin)
      }
    }

    const geometries: THREE.BufferGeometry[] = []
    this.buildHatchGeometry(boundariesForGeometry, hierarchy, geometries)

    let geometry: THREE.BufferGeometry | undefined
    if (geometries.length === 1) {
      geometry = geometries[0]
    } else if (geometries.length > 1) {
      geometry = mergeGeometries(geometries) ?? undefined
    }

    if (geometry && hasFillVertices(geometry)) {
      const boundingBox =
        AcTrBufferGeometryUtil.safeComputeBoundingBox(geometry)
      if (!boundingBox) {
        log.warn('Skipped hatch fill with invalid geometry coordinates')
        geometry.dispose()
        return
      }
      this.wcsBbox = localOrigin
        ? boundingBox.clone().translate(localOrigin)
        : boundingBox

      this.addGradientPositionAttribute(geometry, traits)

      const gradientBounds = {
        minX: this.wcsBbox.min.x,
        minY: this.wcsBbox.min.y,
        maxX: this.wcsBbox.max.x,
        maxY: this.wcsBbox.max.y
      }
      const rebaseOffset =
        isPatterned && localOrigin
          ? new THREE.Vector2(localOrigin.x, localOrigin.y)
          : undefined
      const material = this.styleManager.getFillMaterial(
        traits,
        rebaseOffset,
        gradientBounds
      )
      const mesh = new THREE.Mesh(geometry, material)
      if (localOrigin) {
        mesh.position.set(localOrigin.x, localOrigin.y, localOrigin.z)
      }
      this.add(mesh)
      this.finalizeLeafDrawables()
    } else if (hasRenderableBoundaries) {
      log.warn('Failed to convert hatch boundaries!')
    }
  }

  override resolveDrawMode(): AcTrDrawMode {
    if (this.isPatternedHatch(this._traits)) {
      return 'unbatch'
    }
    return this.batchDrawPolicy.resolveDrawMode({
      anchor: resolveAnchorFromBox(this.wcsBbox)
    })
  }

  private isPatternedHatch(traits: AcGiSubEntityTraits) {
    const style = traits.fillType
    return !style.gradient && !!style.definitionLines?.length
  }

  private addGradientPositionAttribute(
    geometry: THREE.BufferGeometry,
    traits: AcGiSubEntityTraits
  ) {
    if (!traits.fillType.gradient || !geometry.boundingBox) {
      return
    }

    const position = geometry.getAttribute('position')
    if (!position) {
      return
    }

    const box = geometry.boundingBox
    const centerX = (box.min.x + box.max.x) * 0.5
    const centerY = (box.min.y + box.max.y) * 0.5
    const halfWidth = Math.max((box.max.x - box.min.x) * 0.5, 1e-9)
    const halfHeight = Math.max((box.max.y - box.min.y) * 0.5, 1e-9)
    const values = new Float32Array(position.count * 2)

    for (let index = 0; index < position.count; index++) {
      values[index * 2] = (position.getX(index) - centerX) / halfWidth
      values[index * 2 + 1] = (position.getY(index) - centerY) / halfHeight
    }

    geometry.setAttribute(
      'gradientPosition',
      new THREE.BufferAttribute(values, 2)
    )
  }

  private buildHatchGeometry(
    pointBoundaries: AcGePoint2d[][],
    node: AcGeIndexNode,
    geometries: THREE.BufferGeometry[]
  ) {
    if (node.children.length === 0) {
      return
    }
    const noHoles: number[] = []
    const holes = new Map<number, number[]>()
    node.children.forEach(child => {
      if (child.children.length === 0) {
        noHoles.push(child.index)
      } else {
        holes.set(
          child.index,
          child.children.map(child => child.index)
        )
      }
    })

    const createGeometry = (shape: THREE.Shape) => {
      try {
        const geom = new THREE.ShapeGeometry(shape)
        if (!AcTrBufferGeometryUtil.hasFinitePositions(geom)) {
          geom.dispose()
          return
        }
        if (geom.hasAttribute('uv')) {
          geom.deleteAttribute('uv')
        }
        if (geom.hasAttribute('normal')) {
          geom.deleteAttribute('normal')
        }
        geometries.push(geom)
      } catch (_error) {
        log.warn(
          `Triangulate shape error: ${shape
            .getPoints()
            .map(v => v.toArray())
            .toString()}`
        )
      }
    }

    noHoles.forEach(index => {
      const points = pointBoundaries[index]
      if (points.length < 3) {
        return
      }
      // DWG hatch edge paths may self-intersect (T-junctions without a shared
      // vertex). Earcut then fills the concave exterior — repair first.
      // The repair emits both solids and holes of the even-odd result; nest
      // them so holes are not filled as standalone shapes.
      const regions = resolveSelfIntersectingHatchLoopRegions(points)
      this.buildRegionShapes(regions).forEach(createGeometry)
    })

    for (const pair of holes) {
      const outerPoints = pointBoundaries[pair[0]]
      if (outerPoints.length < 3) {
        continue
      }
      // Merge overlapping holes once (shared by every repaired outer region).
      // ShapeGeometry/earcut must not receive overlapping hole paths (#744).
      const holePaths = this.buildMergedHolePaths(pointBoundaries, pair[1])
      // Same self-intersection repair as the no-hole path. If the outer splits
      // into several simple regions, only attach holes that lie inside each
      // region — foreign holes corrupt earcut triangulation. Rings nested in a
      // repaired outer are its holes and are nested by buildRegionShapes.
      const outerRegions = resolveSelfIntersectingHatchLoopRegions(outerPoints)
      this.buildRegionShapes(outerRegions, holePaths).forEach(createGeometry)
    }

    node.children.forEach(child => {
      child.children.forEach(grandchild => {
        this.buildHatchGeometry(pointBoundaries, grandchild, geometries)
      })
    })
  }

  /**
   * Builds fills from repaired hatch regions.
   *
   * PolyBool emits every ring of the rebuilt even-odd polygon, so a ring
   * nested inside another one is a hole. Its winding is _not_ a hole flag: a
   * bow-tie comes back as one clockwise and one counter-clockwise lobe, both
   * solid. Nesting depth is therefore what separates solids from holes, and
   * each hole is attached to its immediate parent so earcut does not fill it.
   * `extraHoles` are hierarchy holes of the original outer.
   */
  private buildRegionShapes(
    regions: AcTrHatchLoopRegion[],
    extraHoles: AcGePoint2dLike[][] = []
  ): THREE.Shape[] {
    const rings = regions.filter(region => region.points.length >= 3)
    if (rings.length === 0) {
      return []
    }

    const depths = rings.map((ring, index) =>
      rings.reduce((depth, other, otherIndex) => {
        if (otherIndex === index) {
          return depth
        }
        return isHoleInsideOuter(ring.points, other.points) ? depth + 1 : depth
      }, 0)
    )

    const shapes: THREE.Shape[] = []
    rings.forEach((ring, index) => {
      if (depths[index] % 2 === 1) {
        return
      }
      const shape = new THREE.Shape(toVector2(ring.points))
      rings.forEach((hole, holeIndex) => {
        if (
          depths[holeIndex] === depths[index] + 1 &&
          isHoleInsideOuter(hole.points, ring.points)
        ) {
          shape.holes.push(new THREE.Path(toVector2(hole.points)))
        }
      })
      extraHoles.forEach(hole => {
        if (hole.length >= 3 && isHoleInsideOuter(hole, ring.points)) {
          shape.holes.push(new THREE.Path(toVector2(hole)))
        }
      })
      shapes.push(shape)
    })
    return shapes
  }

  /**
   * Build hole rings for an outer, unioning overlapping hole components (#744).
   */
  private buildMergedHolePaths(
    pointBoundaries: AcGePoint2d[][],
    holeIndices: number[]
  ): AcGePoint2dLike[][] {
    const paths: AcGePoint2dLike[][] = []
    const vec2Array = (vecs: AcGePoint2d[]) =>
      vecs.map(p => p.toArray() as [number, number])
    const needMergeHolesArr = this.findIntersectHole(
      pointBoundaries,
      holeIndices
    )
    needMergeHolesArr.forEach(mergeArr => {
      const validHoles = mergeArr.filter(
        index => pointBoundaries[index].length >= 3
      )
      let epsilon = 1e-6
      let mergedOk = false
      try {
        if (validHoles.length === 0) {
          // nothing to merge
        } else if (validHoles.length === 1) {
          paths.push(pointBoundaries[validHoles[0]])
          mergedOk = true
        } else {
          // One epsilon / PolyBool for the whole component — mixing
          // GeometryEpsilon across segment build and combine is unreliable.
          epsilon = Math.min(
            ...validHoles.map(index =>
              pointBoundaries[index][0].relativeEps()
            ),
            1e-6
          )
          const polybool = new PolyBool(new GeometryEpsilon(epsilon))
          let acc = polybool.segments({
            regions: [vec2Array(pointBoundaries[validHoles[0]])],
            inverted: false
          })
          for (let i = 1; i < validHoles.length; i++) {
            const next = polybool.segments({
              regions: [vec2Array(pointBoundaries[validHoles[i]])],
              inverted: false
            })
            // Fold into the running union, not only against the first loop.
            acc = polybool.selectUnion(polybool.combine(acc, next))
          }
          const mergedHoles = polybool.polygon(acc)
          if (mergedHoles.regions.length > 0) {
            mergedHoles.regions.forEach((ps: number[][]) => {
              if (ps.length === 0) {
                return
              }
              paths.push(ps.map(p => new AcGePoint2d(p[0], p[1])))
            })
            mergedOk = true
          } else {
            log.warn('mergedHoles.regions is empty!')
          }
        }
      } catch (error) {
        log.warn(`Polybool error: ${error}, epsilon is ${epsilon}`)
      }
      // Failed or empty union: keep openings open with the original loops
      // instead of dropping the whole component.
      if (!mergedOk) {
        for (const index of validHoles) {
          paths.push(pointBoundaries[index])
        }
      }
    })
    const ignoreHoleIndexArr = needMergeHolesArr.flat()
    // Non-overlapping holes stay as-is.
    for (let i = 0; i < holeIndices.length; i++) {
      const idx = holeIndices[i]
      if (!ignoreHoleIndexArr.includes(idx)) {
        const holePoints = pointBoundaries[idx]
        if (holePoints.length < 3) {
          continue
        }
        paths.push(holePoints)
      }
    }
    return paths
  }

  /**
   * Group hole indices into connected components under pairwise intersection.
   * Only components with two or more holes are returned (those need a boolean
   * union before triangulation).
   */
  private findIntersectHole(
    pointBoundaries: AcGePoint2dLike[][],
    indexArr: number[]
  ): number[][] {
    const len = indexArr.length
    if (len < 2) {
      return []
    }

    const parent = Array.from({ length: len }, (_, i) => i)
    const find = (i: number): number => {
      let root = i
      while (parent[root] !== root) {
        root = parent[root]
      }
      let cur = i
      while (parent[cur] !== root) {
        const next = parent[cur]
        parent[cur] = root
        cur = next
      }
      return root
    }
    const unite = (a: number, b: number) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) {
        parent[rb] = ra
      }
    }

    for (let i = 0; i < len; i++) {
      const points1 = pointBoundaries[indexArr[i]]
      for (let j = i + 1; j < len; j++) {
        const points2 = pointBoundaries[indexArr[j]]
        if (AcGeGeometryUtil.isPolygonIntersect(points1, points2)) {
          unite(i, j)
        }
      }
    }

    const components = new Map<number, number[]>()
    for (let i = 0; i < len; i++) {
      const root = find(i)
      let group = components.get(root)
      if (!group) {
        group = []
        components.set(root, group)
      }
      group.push(indexArr[i])
    }

    return Array.from(components.values()).filter(group => group.length > 1)
  }
}
