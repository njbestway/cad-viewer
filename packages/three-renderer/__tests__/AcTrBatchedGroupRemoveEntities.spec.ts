import * as THREE from 'three'

import { AcTrBatchedGroup } from '../src/batch/AcTrBatchedGroup'
import { AcTrBatchedLine } from '../src/batch/AcTrBatchedLine'
import { RTE_REBASE_THRESHOLD } from '../src/draw/AcTrBatchDrawPolicy'
import { AcTrEntity } from '../src/object/AcTrEntity'
import { AcTrRenderContext } from '../src/renderer/AcTrRenderContext'
import { getSceneDrawableUserData } from '../src/util/AcTrObjectUserData'

function createLineSegments(
  offsetY: number,
  material: THREE.LineBasicMaterial
): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0], 3)
  )
  geometry.setIndex([0, 1])
  const line = new THREE.LineSegments(geometry, material)
  line.position.set(0, offsetY, 0)
  line.updateMatrixWorld(true)
  return line
}

function createEntity(
  objectId: string,
  ...drawables: THREE.Object3D[]
): AcTrEntity {
  const entity = new AcTrEntity(new AcTrRenderContext())
  entity.objectId = objectId
  entity.visible = true
  for (const drawable of drawables) {
    entity.add(drawable)
  }
  return entity
}

/** Every batched line container currently attached to the group. */
function lineBatches(group: AcTrBatchedGroup): AcTrBatchedLine[] {
  const batches: AcTrBatchedLine[] = []
  group.traverse(child => {
    if (child instanceof AcTrBatchedLine) {
      batches.push(child)
    }
  })
  return batches
}

function createUnbatchedLine() {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-10, 0, 0, 10, 0, 0], 3)
  )
  geometry.setIndex([0, 1])
  const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial())
  line.position.set(RTE_REBASE_THRESHOLD + 500, 2_000_000, 0)
  getSceneDrawableUserData(line).noBatch = true
  line.updateMatrixWorld(true)
  return line
}

/**
 * Builds a group whose entities are spread over `batchCount` batched line
 * containers (batches are keyed by material, plus world-origin bucket).
 */
function createGroupWithBatches(
  entityCount: number,
  batchCount: number
): { group: AcTrBatchedGroup; ids: string[] } {
  const group = new AcTrBatchedGroup()
  const ids: string[] = []
  const materials = Array.from(
    { length: batchCount },
    () => new THREE.LineBasicMaterial()
  )
  for (let i = 0; i < entityCount; i++) {
    const id = `E${i}`
    ids.push(id)
    group.addEntity(
      createEntity(
        id,
        createLineSegments(i * 2, materials[i % batchCount])
      )
    )
  }
  return { group, ids }
}

describe('AcTrBatchedGroup.removeEntities', () => {
  it('compacts each affected batched container exactly once', () => {
    const { group, ids } = createGroupWithBatches(40, 2)
    const batches = lineBatches(group)
    expect(batches).toHaveLength(2)
    expect(group.entityCount).toBe(40)

    const optimizeSpies = batches.map(batch => jest.spyOn(batch, 'optimize'))
    const deleteSpies = batches.map(batch => jest.spyOn(batch, 'deleteGeometry'))

    const removed = ids.slice(0, 30)
    const result = group.removeEntities(removed)

    expect(result.removedObjectIds).toEqual(removed)
    expect(result.affectedBatchCount).toBe(2)
    expect(result.optimizeCount).toBe(2)

    // The whole point of the batch API: one compaction per container, not one
    // per removed entity (the per-entity path called optimize 30 times here).
    optimizeSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1))
    const deleteCalls = deleteSpies.reduce(
      (total, spy) => total + spy.mock.calls.length,
      0
    )
    expect(deleteCalls).toBe(30)

    expect(group.entityCount).toBe(10)
    for (const id of removed) {
      expect(group.hasEntity(id)).toBe(false)
    }
    for (const id of ids.slice(30)) {
      expect(group.hasEntity(id)).toBe(true)
    }
  })

  it('ignores duplicate and unknown ids, preserving input order', () => {
    const { group, ids } = createGroupWithBatches(5, 1)
    const batches = lineBatches(group)
    const optimizeSpy = jest.spyOn(batches[0], 'optimize')

    const result = group.removeEntities([
      ids[2],
      ids[0],
      ids[2],
      'MISSING',
      ids[0]
    ])

    expect(result.removedObjectIds).toEqual([ids[2], ids[0]])
    expect(result.optimizeCount).toBe(1)
    expect(optimizeSpy).toHaveBeenCalledTimes(1)
    expect(group.entityCount).toBe(3)
    // A duplicated id must not shift the slots of the survivors twice.
    expect(group.hasEntity(ids[1])).toBe(true)
    expect(group.hasEntity(ids[3])).toBe(true)
    expect(group.hasEntity(ids[4])).toBe(true)
  })

  it('is a no-op for empty and fully unknown id lists', () => {
    const { group } = createGroupWithBatches(3, 1)
    const batches = lineBatches(group)
    const optimizeSpy = jest.spyOn(batches[0], 'optimize')

    expect(group.removeEntities([])).toEqual({
      removedObjectIds: [],
      affectedBatchCount: 0,
      optimizeCount: 0
    })
    expect(group.removeEntities(['NOPE-1', 'NOPE-2'])).toEqual({
      removedObjectIds: [],
      affectedBatchCount: 0,
      optimizeCount: 0
    })
    expect(optimizeSpy).not.toHaveBeenCalled()
    expect(group.entityCount).toBe(3)
  })

  it('clears selection and hover state before releasing slots', () => {
    const { group, ids } = createGroupWithBatches(6, 1)
    group.select(ids[0])
    group.hover(ids[1])

    group.removeEntities([ids[0], ids[1]])

    expect(group.getEntityVisible(ids[0])).toBeUndefined()
    expect(group.getEntityVisible(ids[1])).toBeUndefined()

    // Remaining entities keep rendering normally after the compaction.
    expect(group.entityCount).toBe(4)
    expect(group.getEntityVisible(ids[2])).toBe(true)
    expect(group.getEntityVisible(ids[3])).toBe(true)
  })

  it('disposes unbatched drawables and reports them as removed', () => {
    const group = new AcTrBatchedGroup()
    const line = createUnbatchedLine()
    const geometry = line.geometry
    const disposeSpy = jest.spyOn(geometry, 'dispose')

    group.addEntity(createEntity('line-1', line))
    group.select('line-1')
    expect(group.stats.unbatched.count).toBe(1)

    const result = group.removeEntities(['line-1', 'line-1'])

    expect(result.removedObjectIds).toEqual(['line-1'])
    // Unbatched removals never touch a batch, so nothing is compacted.
    expect(result.optimizeCount).toBe(0)
    expect(disposeSpy).toHaveBeenCalled()
    expect(group.hasEntity('line-1')).toBe(false)
    expect(group.stats.unbatched.count).toBe(0)
  })

  it('keeps removeEntity boolean semantics for one id', () => {
    const { group, ids } = createGroupWithBatches(2, 1)

    expect(group.removeEntity(ids[0])).toBe(true)
    expect(group.removeEntity(ids[0])).toBe(false)
    expect(group.removeEntity('MISSING')).toBe(false)
    expect(group.entityCount).toBe(1)
  })
})
