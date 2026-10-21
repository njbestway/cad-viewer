import { AcTrGroup } from '../src/object/AcTrGroup'
import { AcTrCoalescedLineRef } from '../src/renderer/AcTrBlockLineCoalesce'
import { AcTrRenderer } from '../src/renderer/AcTrRenderer'
import * as THREE from 'three'

function createRenderer() {
  const webgl = {
    getSize: (target: THREE.Vector2) => target.set(800, 600)
  } as unknown as THREE.WebGLRenderer
  return new AcTrRenderer(webgl)
}

function applyDashedTraits(renderer: AcTrRenderer) {
  renderer.subEntityTraits.lineType = {
    ...renderer.subEntityTraits.lineType,
    name: 'DASHED',
    pattern: [
      { elementLength: 12.7, elementTypeFlag: 0 },
      { elementLength: -6.35, elementTypeFlag: 0 }
    ],
    totalPatternLength: 19.05
  }
}

function coalescedLineSegments(group: AcTrGroup): THREE.LineSegments {
  const child = group.children.find(
    object => object instanceof THREE.LineSegments
  )
  expect(child).toBeInstanceOf(THREE.LineSegments)
  return child as THREE.LineSegments
}

describe('block line coalesce', () => {
  it('merges simple block lines into one mesh and keeps a box per line', () => {
    const renderer = createRenderer()
    renderer.beginBlockLineCoalesce()
    const first = renderer.lines([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ])
    const second = renderer.lines([
      { x: 0, y: 5, z: 0 },
      { x: 10, y: 5, z: 0 }
    ])
    expect(first).toBeInstanceOf(AcTrCoalescedLineRef)
    expect(second).toBeInstanceOf(AcTrCoalescedLineRef)
    first.objectId = 'line-a'
    second.objectId = 'line-b'
    first.layerName = '0'
    second.layerName = '0'

    const group = renderer.group([first, second])
    renderer.endBlockLineCoalesce()

    expect(group).toBeInstanceOf(AcTrGroup)
    expect(group.isCompacted).toBe(true)
    expect(group.children.length).toBe(1)
    const ids = group.wcsChildBoxes.map(box => box.id)
    expect(ids).toContain('line-a')
    expect(ids).toContain('line-b')
  })

  it('restarts dash phase at each original line', () => {
    const renderer = createRenderer()
    applyDashedTraits(renderer)
    renderer.beginBlockLineCoalesce()
    const first = renderer.lines([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ])
    const second = renderer.lines([
      { x: 0, y: 5, z: 0 },
      { x: 20, y: 5, z: 0 }
    ])
    const polyline = renderer.lines([
      { x: 0, y: 10, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 10, y: 15, z: 0 }
    ])
    const group = renderer.group([first, second, polyline])
    renderer.endBlockLineCoalesce()

    const line = coalescedLineSegments(group)
    expect(line.material).toBeInstanceOf(THREE.ShaderMaterial)
    const distances = line.geometry.getAttribute('lineDistance')
    expect(distances).toBeDefined()
    expect(distances.count).toBe(8)
    expect(distances.getX(0)).toBeCloseTo(0)
    expect(distances.getX(1)).toBeCloseTo(10)
    expect(distances.getX(2)).toBeCloseTo(0)
    expect(distances.getX(3)).toBeCloseTo(20)
    expect(distances.getX(4)).toBeCloseTo(0)
    expect(distances.getX(5)).toBeCloseTo(10)
    expect(distances.getX(6)).toBeCloseTo(10)
    expect(distances.getX(7)).toBeCloseTo(15)
  })

  it('keeps survey-scale block lines accurate when merged', () => {
    // Real geometry: block `A$C3BFC201F` of the mining plan is inserted at
    // x~3.76e7 with scale 0.375, so its 22.4-unit circle becomes an 8.4-unit
    // ring whose 50 chords are ~1 unit long - far below the 4-unit float32
    // step at that magnitude. Staging absolute coordinates in float32 is what
    // made the ring and its two arcs vanish on screen.
    const center = { x: 37595245.3145837, y: 3947073.4101060918 }
    const radius = 22.391823320815295 * 0.375
    const sides = 50
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= sides; i++) {
      const angle = (i / sides) * Math.PI * 2
      points.push(
        new THREE.Vector3(
          center.x + radius * Math.cos(angle),
          center.y + radius * Math.sin(angle),
          0
        )
      )
    }

    const renderer = createRenderer()
    renderer.beginBlockLineCoalesce()
    const ring = renderer.lines(points)
    ring.objectId = 'circle-377185'
    ring.layerName = '0'
    const group = renderer.group([ring])
    renderer.endBlockLineCoalesce()

    const line = coalescedLineSegments(group)
    const position = line.geometry.getAttribute('position')
    let maxError = 0
    let degenerate = 0
    for (let i = 0; i < position.count; i += 2) {
      const ax = position.getX(i) + line.position.x
      const ay = position.getY(i) + line.position.y
      const bx = position.getX(i + 1) + line.position.x
      const by = position.getY(i + 1) + line.position.y
      const expected = points[i / 2]
      maxError = Math.max(
        maxError,
        Math.abs(ax - expected.x),
        Math.abs(ay - expected.y)
      )
      if (ax === bx && ay === by) {
        degenerate++
      }
    }

    // A chord must keep its length and its place, not snap to a 4-unit grid.
    expect(maxError).toBeLessThan(1e-3)
    expect(degenerate).toBe(0)
  })

  it('keeps nested block lines off the outer vertex builder', () => {
    const renderer = createRenderer()
    renderer.beginBlockLineCoalesce()
    const outerA = renderer.lines([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ])
    renderer.beginBlockLineCoalesce()
    const innerA = renderer.lines([
      { x: 100, y: 0, z: 0 },
      { x: 101, y: 0, z: 0 }
    ])
    const innerB = renderer.lines([
      { x: 100, y: 1, z: 0 },
      { x: 101, y: 1, z: 0 }
    ])
    innerA.objectId = 'inner-a'
    innerB.objectId = 'inner-b'
    const innerGroup = renderer.group([innerA, innerB])
    renderer.endBlockLineCoalesce()

    const innerLine = coalescedLineSegments(innerGroup)
    innerLine.updateMatrixWorld(true)
    const innerBox = new THREE.Box3().setFromObject(innerLine)
    expect(innerBox.min.x).toBeCloseTo(100)
    expect(innerBox.max.x).toBeCloseTo(101)

    const outerB = renderer.lines([
      { x: 0, y: 5, z: 0 },
      { x: 10, y: 5, z: 0 }
    ])
    outerA.objectId = 'outer-a'
    outerB.objectId = 'outer-b'
    const outerGroup = renderer.group([outerA, innerGroup, outerB])
    renderer.endBlockLineCoalesce()

    expect(innerGroup).toBeInstanceOf(AcTrGroup)
    expect(outerGroup).toBeInstanceOf(AcTrGroup)
    expect(innerGroup.wcsChildBoxes.map(box => box.id)).toEqual(
      expect.arrayContaining(['inner-a', 'inner-b'])
    )
    expect(outerGroup.wcsChildBoxes.map(box => box.id)).toEqual(
      expect.arrayContaining(['outer-a', 'outer-b', 'inner-a', 'inner-b'])
    )

    const lines: THREE.LineSegments[] = []
    outerGroup.traverse(object => {
      if (object instanceof THREE.LineSegments) {
        lines.push(object)
      }
    })
    const ranges = lines.map(line => {
      const position = line.geometry.getAttribute('position')
      let minX = Infinity
      let maxX = -Infinity
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i) + line.position.x
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
      }
      return { minX, maxX }
    })
    expect(ranges.some(range => range.maxX < 50)).toBe(true)
    expect(ranges.some(range => range.minX > 50)).toBe(true)
  })
})
