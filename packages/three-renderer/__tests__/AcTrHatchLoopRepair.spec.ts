import { AcGePoint2d, log } from '@mlightcad/data-model'

import {
  hatchLoopHasRenderableArea,
  hatchLoopHasSelfIntersection,
  resolveSelfIntersectingHatchLoop
} from '../src/object/AcTrHatchLoopRepair'

/**
 * Self-intersecting hatch foot from DWG handle 14AE (simplified, no arc):
 * a vertical strip with a left-hand ledge whose long left edge crosses the
 * bottom ledge — AutoCAD stores this without a T-junction vertex.
 */
function hatch14AeFootLoop() {
  return [
    new AcGePoint2d(1439.03, 691.02),
    new AcGePoint2d(1439.03, 628.96),
    new AcGePoint2d(1418.03, 628.96),
    new AcGePoint2d(1418.03, 627.46),
    new AcGePoint2d(1435.03, 627.46),
    new AcGePoint2d(1435.03, 688.53),
    new AcGePoint2d(1439.03, 691.02)
  ]
}

describe('AcTrHatchLoopRepair', () => {
  it('detects the T-junction self-intersection in hatch 14AE-style foot', () => {
    expect(hatchLoopHasSelfIntersection(hatch14AeFootLoop())).toBe(true)
  })

  it('leaves a simple rectangle unchanged', () => {
    const rect = [
      new AcGePoint2d(0, 0),
      new AcGePoint2d(10, 0),
      new AcGePoint2d(10, 5),
      new AcGePoint2d(0, 5)
    ]
    expect(hatchLoopHasSelfIntersection(rect)).toBe(false)
    const regions = resolveSelfIntersectingHatchLoop(rect)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveLength(4)
  })

  it('decomposes the self-intersecting foot into simple even-odd regions', () => {
    const regions = resolveSelfIntersectingHatchLoop(hatch14AeFootLoop())
    expect(regions.length).toBeGreaterThan(1)
    for (const region of regions) {
      expect(hatchLoopHasSelfIntersection(region)).toBe(false)
      expect(region.length).toBeGreaterThanOrEqual(3)
    }

    // Notch interior stays filled; concave exterior left of the upright does not.
    expect(regions.some(region => pointInPoly(1425, 628.2, region))).toBe(true)
    expect(regions.some(region => pointInPoly(1437, 650, region))).toBe(true)
    expect(regions.some(region => pointInPoly(1425, 640, region))).toBe(false)
  })

  describe('loops that only touch themselves at a vertex', () => {
    let warn: jest.SpyInstance

    beforeEach(() => {
      warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      warn.mockRestore()
    })

    it('ignores a closing edge that ends within noise of an earlier edge (hatch 4054212)', () => {
      expect(hatchLoopHasSelfIntersection(hatch4054212Loop())).toBe(false)
      const regions = resolveSelfIntersectingHatchLoop(hatch4054212Loop())
      expect(regions).toHaveLength(1)
      expect(regions[0]).toHaveLength(5)
      // PolyBool throws "Zero-length segment detected" on this loop, so it
      // must never be fed to the repair path.
      expect(warn).not.toHaveBeenCalled()
    })

    it('ignores repeated vertices and zero-width spikes (hatch 3692049)', () => {
      expect(hatchLoopHasSelfIntersection(hatch3692049Loop())).toBe(false)
      const regions = resolveSelfIntersectingHatchLoop(hatch3692049Loop())
      expect(regions).toHaveLength(1)
      expect(regions[0]).toHaveLength(19)
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('hatchLoopHasRenderableArea', () => {
    it('rejects the degenerate out-and-back path from DWG hatch 46824', () => {
      // Closed two-vertex polyline (opposing line edges) tessellates to
      // [a, b, a]; earcut has nothing to fill.
      const loop = [
        new AcGePoint2d(-9950.337937803008, 24604.21912893001),
        new AcGePoint2d(-7450.337942285463, 24604.21912893164),
        new AcGePoint2d(-9950.337937803008, 24604.21912893001)
      ]
      expect(hatchLoopHasRenderableArea(loop)).toBe(false)
    })

    it('rejects collinear and duplicate-only loops', () => {
      expect(
        hatchLoopHasRenderableArea([
          new AcGePoint2d(0, 0),
          new AcGePoint2d(5, 0),
          new AcGePoint2d(9, 0)
        ])
      ).toBe(false)
      expect(
        hatchLoopHasRenderableArea([
          new AcGePoint2d(1, 1),
          new AcGePoint2d(1, 1),
          new AcGePoint2d(1, 1)
        ])
      ).toBe(false)
    })

    it('accepts a real ring and a self-intersecting bow-tie', () => {
      expect(
        hatchLoopHasRenderableArea([
          new AcGePoint2d(0, 0),
          new AcGePoint2d(10, 0),
          new AcGePoint2d(10, 5),
          new AcGePoint2d(0, 5)
        ])
      ).toBe(true)
      // Zero signed area but a real even-odd region: still renderable.
      expect(
        hatchLoopHasRenderableArea([
          new AcGePoint2d(0, 0),
          new AcGePoint2d(10, 10),
          new AcGePoint2d(10, 0),
          new AcGePoint2d(0, 10)
        ])
      ).toBe(true)
    })
  })
})

/**
 * DWG hatch handle 4054212 (rebased): a quadrilateral whose top edge ends a
 * float-noise sliver past the left edge. PolyBool calls this a zero-length
 * segment and throws; earcut renders the loop correctly as-is.
 */
function hatch4054212Loop() {
  return [
    new AcGePoint2d(-114.15049745887518, 187.15896254684776),
    new AcGePoint2d(-114.14950263500214, -187.15896254591644),
    new AcGePoint2d(114.1504974514246, -187.01592611242086),
    new AcGePoint2d(114.14565581083298, 186.44702962972224),
    new AcGePoint2d(-114.15049739927053, 186.4470296818763)
  ]
}

/**
 * DWG hatch handle 3692049 (rebased): a degenerate out-and-back path with
 * repeated vertices and zero-width spikes. Its self-touches all sit exactly on
 * a vertex, so they are endpoint touches, not crossings.
 */
function hatch3692049Loop() {
  return [
    new AcGePoint2d(-14.465469680726528, -99.079499783925712),
    new AcGePoint2d(-14.33558251708746, -195.07941188290715),
    new AcGePoint2d(0.044921249151229858, -180.65994198899716),
    new AcGePoint2d(14.44129453599453, -195.0635677985847),
    new AcGePoint2d(14.465469673275948, -99.063570877537131),
    new AcGePoint2d(0.06909644603729248, -84.659945053979754),
    new AcGePoint2d(-0.084966011345386505, 55.248284876346588),
    new AcGePoint2d(-0.16194731742143631, 195.06586372107267),
    new AcGePoint2d(-0.16195477545261383, 195.07941187452525),
    new AcGePoint2d(-0.16194731742143631, 195.06586372107267),
    new AcGePoint2d(-0.084966018795967102, 55.248288797214627),
    new AcGePoint2d(-0.2388586550951004, 195.00229961052537),
    new AcGePoint2d(-0.16195477545261383, 195.07941187359393),
    new AcGePoint2d(-0.16194731742143631, 195.06586372107267),
    new AcGePoint2d(-0.16195476800203323, 195.07941188197583),
    new AcGePoint2d(-0.084966011345386505, 195.00238434039056),
    new AcGePoint2d(-0.084966011345386505, 55.248284876346588),
    new AcGePoint2d(-0.084966011345386505, 55.248280955478549),
    new AcGePoint2d(-0.084966011345386505, -84.660029876977205)
  ]
}

function pointInPoly(
  x: number,
  y: number,
  poly: Array<{ x: number; y: number }>
): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
