import { AcGeBox2d } from '@mlightcad/data-model'
import type { AcTrDirectEntityMeta } from '@mlightcad/three-renderer'
import * as THREE from 'three'

import type { AcEdLayerInfo } from '../src/editor/view/AcEdLayerInfo'
import { AcTrLayout } from '../src/view/AcTrLayout'

/**
 * Drives the layout level of the ERASE path directly:
 * `AcTrLayout.removeEntities` → every layer → `AcTrBatchedGroup.removeEntities`.
 *
 * The scene and view levels only iterate over registered layouts on top of
 * this, so these tests cover the layer fan-out, the spatial index and the
 * bounding-box invalidation without needing a live renderer.
 */
function createLayerInfo(name: string): AcEdLayerInfo {
  // Only name / isFrozen / isOff are read by AcTrLayer.
  return { name, isFrozen: false, isOff: false } as AcEdLayerInfo
}

interface Fixture {
  layout: AcTrLayout
  ids: string[]
  boxes: Map<string, THREE.Box3>
}

function createLayout(entityCount: number, layerCount: number): Fixture {
  const layout = new AcTrLayout()
  for (let index = 0; index < layerCount; index++) {
    layout.addLayer(createLayerInfo(`L${index}`))
  }

  const material = new THREE.LineBasicMaterial()
  const ids: string[] = []
  const boxes = new Map<string, THREE.Box3>()
  const origin = 512000

  for (let index = 0; index < entityCount; index++) {
    const objectId = `E${index}`
    const x = origin + index * 10
    const y = origin + (index % 97) * 10
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([x, y, 0, x + 5, y + 5, 0], 3)
    )
    const wcsBbox = new THREE.Box3(
      new THREE.Vector3(x, y, 0),
      new THREE.Vector3(x + 5, y + 5, 0)
    )
    const meta: AcTrDirectEntityMeta = {
      kind: 'lineBasic',
      geometry,
      worldOffset: new THREE.Vector3(0, 0, 0),
      wcsBbox,
      material,
      objectId,
      ownerId: objectId,
      layerName: `L${index % layerCount}`,
      visible: true
    }
    layout.addDirectEntity(meta)
    // The layout copies what it needs; the caller owns the source geometry.
    geometry.dispose()

    ids.push(objectId)
    boxes.set(objectId, wcsBbox)
  }

  return { layout, ids, boxes }
}

describe('AcTrLayout.removeEntities', () => {
  test('removes a bulk selection across layers with no spatial-index residue', () => {
    const { layout, ids } = createLayout(400, 4)
    expect(layout.entityCount).toBe(400)
    expect(layout.spatialIndexStats.itemCount).toBe(400)

    // Every layer holds every 4th id, so this spans the whole layer fan-out.
    const targets = ids.filter((_, index) => index % 4 === 1).slice(0, 100)
    const removed = layout.removeEntities(targets)

    expect(removed).toHaveLength(targets.length)
    expect(layout.entityCount).toBe(400 - targets.length)
    // The spatial index must drop exactly the removed entities; leftover items
    // keep them pickable after ERASE.
    expect(layout.spatialIndexStats.itemCount).toBe(400 - targets.length)
    for (const objectId of targets) {
      expect(layout.hasEntity(objectId)).toBe(false)
    }
    expect(layout.hasEntity(ids[0])).toBe(true)
  })

  test('removed entities are no longer returned by spatial search', () => {
    const { layout, boxes } = createLayout(120, 3)
    const removedId = 'E60'
    const removedBox = boxes.get(removedId)!
    const query = new AcGeBox2d(
      { x: removedBox.min.x, y: removedBox.min.y },
      { x: removedBox.max.x, y: removedBox.max.y }
    )

    const before = layout.search(query).map(hit => hit.id)
    expect(before).toContain(removedId)

    layout.removeEntities([removedId])

    const after = layout.search(query).map(hit => hit.id)
    expect(after).not.toContain(removedId)
  })

  test('deduplicates ids and ignores unknown ones', () => {
    const { layout, ids } = createLayout(10, 2)

    const removed = layout.removeEntities([
      ids[0],
      ids[0],
      'MISSING',
      ids[3],
      ids[3]
    ])

    expect(removed).toEqual([ids[0], ids[3]])
    expect(layout.entityCount).toBe(8)
    expect(layout.removeEntities([])).toEqual([])
    expect(layout.removeEntities(['MISSING'])).toEqual([])
  })
})
