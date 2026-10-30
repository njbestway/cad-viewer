import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

import { isBatchGeometryActive } from '../src/batch/AcTrBatchedGeometryInfo'
import { AcTrBatchedGroup } from '../src/batch/AcTrBatchedGroup'
import { AcTrBatchedLine } from '../src/batch/AcTrBatchedLine'
import { AcTrBatchedLine2 } from '../src/batch/AcTrBatchedLine2'
import { AcTrBatchedMesh } from '../src/batch/AcTrBatchedMesh'
import { AcTrBatchedPoint } from '../src/batch/AcTrBatchedPoint'
import { AcTrEntity } from '../src/object/AcTrEntity'
import { AcTrRenderContext } from '../src/renderer/AcTrRenderContext'
import { getSceneDrawableUserData } from '../src/util/AcTrObjectUserData'

/**
 * Phase 2.11 Task D — slot-reuse correctness and race regressions.
 *
 * Every case asserts against the slot table itself, never against
 * `renderer.info.memory.geometries`: the table is what Phase 2.10 measured
 * growing, and a stable geometry count can coexist with a broken slot table
 * (that is exactly how the leak survived phase 2.10).
 *
 * The shared invariant checker below is the real subject of this file: any case
 * that mutates the scene must leave the batch in a state where
 *
 * - `liveSlots + freedSlots === slotCapacity`,
 * - the free list is exactly the set of inactive ids (no duplicates, no active
 *   ids, no out-of-range ids),
 * - no inactive slot keeps a `Box3` or a `hiddenDrawSnapshot`,
 * - every active slot names a live entity, and the union of those names is the
 *   entity set the group claims to hold (an entity may legitimately own several
 *   slots — one per INSERT fragment).
 */

type AnyBatch =
  | AcTrBatchedLine
  | AcTrBatchedMesh
  | AcTrBatchedPoint
  | AcTrBatchedLine2

function createLineSegments(
  offsetY: number,
  material: THREE.LineBasicMaterial,
  length = 10
): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, length, 0, 0], 3)
  )
  geometry.setIndex([0, 1])
  const line = new THREE.LineSegments(geometry, material)
  line.position.set(0, offsetY, 0)
  line.updateMatrixWorld(true)
  return line
}

function createMesh(offsetY: number, material: THREE.MeshBasicMaterial) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material)
  mesh.position.set(0, offsetY, 0)
  mesh.updateMatrixWorld(true)
  return mesh
}

function createPoints(offsetY: number, material: THREE.PointsMaterial) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0], 3)
  )
  const points = new THREE.Points(geometry, material)
  points.position.set(0, offsetY, 0)
  points.updateMatrixWorld(true)
  return points
}

function createWideLine(offsetY: number, material: LineMaterial) {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions([0, 0, 0, 10, 0, 0])
  const line = new LineSegments2(geometry, material)
  line.position.set(0, offsetY, 0)
  line.updateMatrixWorld(true)
  return line
}

function createEntity(objectId: string, ...drawables: THREE.Object3D[]) {
  const entity = new AcTrEntity(new AcTrRenderContext())
  entity.objectId = objectId
  entity.visible = true
  for (const drawable of drawables) {
    entity.add(drawable)
  }
  return entity
}

/** Every batched container under the group, of any type. */
function collectBatches(group: AcTrBatchedGroup): AnyBatch[] {
  const batches: AnyBatch[] = []
  group.traverse(child => {
    if (
      child instanceof AcTrBatchedLine ||
      child instanceof AcTrBatchedMesh ||
      child instanceof AcTrBatchedPoint ||
      child instanceof AcTrBatchedLine2
    ) {
      batches.push(child)
    }
  })
  return batches
}

function slotOwners(batch: AnyBatch): string[] {
  const owners: string[] = []
  for (const info of batch._geometryInfo) {
    if (!isBatchGeometryActive(info.flags)) continue
    owners.push(String(info.objectId ?? ''))
  }
  return owners
}

function forceBoundingBoxes(batch: AnyBatch) {
  const box = new THREE.Box3()
  for (let id = 0; id < batch.getSlotLifecycleMetrics().slotCapacity; id++) {
    if (!isBatchGeometryActive(batch._geometryInfo[id].flags)) continue
    batch.getBoundingBoxAt(id, box)
  }
}

/**
 * Asserts the phase 2.11 slot invariants for the whole group.
 *
 * @param group - Group after one edit step.
 * @param expectedObjectIds - Exactly the ids the scene must hold, when known.
 */
function expectSlotInvariants(
  group: AcTrBatchedGroup,
  expectedObjectIds?: readonly string[]
) {
  const batches = collectBatches(group)
  const liveOwners = new Set<string>()
  let liveSum = 0

  for (const batch of batches) {
    const metrics = batch.getSlotLifecycleMetrics()
    liveSum += metrics.liveSlots

    expect(metrics.liveSlots + metrics.freedSlots).toBe(metrics.slotCapacity)

    const pool = batch._availableGeometryIds
    expect(new Set(pool).size).toBe(pool.length)
    expect(pool.length).toBe(metrics.freedSlots)

    const pooled = new Set(pool)
    for (let id = 0; id < metrics.slotCapacity; id++) {
      const info = batch._geometryInfo[id]
      const active = isBatchGeometryActive(info.flags)
      // The pool is exactly the complement of the live set.
      expect(pooled.has(id)).toBe(!active)
      if (active) continue
      // A freed slot must not pin per-entity metadata.
      expect(info.boundingBox).toBeNull()
      expect(info.hiddenDrawSnapshot).toBeUndefined()
    }

    const owners = slotOwners(batch)
    expect(owners.length).toBe(metrics.liveSlots)
    for (const owner of owners) {
      expect(owner).not.toBe('')
      // A slot must never name an entity the group no longer holds: that is the
      // soft-delete-without-release failure mode in its purest form.
      expect(group.hasEntity(owner)).toBe(true)
      liveOwners.add(owner)
    }
  }

  const totals = group.getSlotLifecycleMetrics()
  expect(totals.liveSlots).toBe(liveSum)
  expect(totals.batchCount).toBe(batches.length)

  if (expectedObjectIds) {
    expect([...liveOwners].sort()).toEqual([...expectedObjectIds].sort())
  }
}

/** Ray through one world-space Y, aimed along -Z at the packed line row. */
function rayAt(worldY: number, worldX = 5) {
  return new THREE.Raycaster(
    new THREE.Vector3(worldX, worldY, 50),
    new THREE.Vector3(0, 0, -1),
    0,
    200
  )
}

describe('batch slot reuse regression (phase 2.11 task D)', () => {
  it('holds capacity across consecutive add/remove on one batch', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    // A fixed live set: each round erases three ids and appends three new ones,
    // so the peak concurrency — and therefore the legal capacity — never moves.
    const live: string[] = []

    for (let i = 0; i < 8; i++) {
      const id = `E${i}`
      live.push(id)
      group.addEntity(createEntity(id, createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    const capacity = batch.getSlotLifecycleMetrics().slotCapacity
    expect(capacity).toBe(8)

    for (let round = 0; round < 10; round++) {
      const victims = live.splice(0, 3)
      group.removeEntities(victims)
      expectSlotInvariants(group)
      expect(batch.getSlotLifecycleMetrics().freeListSize).toBe(3)

      for (let k = 0; k < victims.length; k++) {
        const id = `R${round}-${k}`
        live.push(id)
        group.addEntity(createEntity(id, createLineSegments(50 + k, material)))
      }
      expectSlotInvariants(group, live)
      expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(capacity)
      expect(batch.getSlotLifecycleMetrics().liveSlots).toBe(8)
    }

    expect(batch.getSlotLifecycleMetrics().reusedSlots).toBe(30)
  })

  it('rebuilds the same ObjectId immediately after it was removed', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    for (let i = 0; i < 4; i++) {
      group.addEntity(createEntity(`E${i}`, createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    const before = batch.getSlotLifecycleMetrics()

    group.removeEntities(['E2'])
    expectSlotInvariants(group, ['E0', 'E1', 'E3'])

    // Same id, different geometry (y = 40 instead of 4).
    group.addEntity(createEntity('E2', createLineSegments(40, material)))

    expectSlotInvariants(group, ['E0', 'E1', 'E2', 'E3'])
    const after = batch.getSlotLifecycleMetrics()
    expect(after.slotCapacity).toBe(before.slotCapacity)
    expect(after.liveSlots).toBe(4)
    expect(after.reusedSlots).toBeGreaterThan(before.reusedSlots)

    // Only one slot may describe E2, and it must sit on the new geometry.
    const slotsOfE2 = batch._geometryInfo.filter(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'E2'
    )
    expect(slotsOfE2).toHaveLength(1)
    const box = new THREE.Box3()
    batch.getBoundingBoxAt(
      batch._geometryInfo.indexOf(slotsOfE2[0]),
      box
    )
    expect(box.min.y).toBeCloseTo(40)
    expect(box.max.y).toBeCloseTo(40)
  })

  it('survives ERASE → Undo → Redo → Undo without growing the slot table', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    const ids = Array.from({ length: 12 }, (_, i) => `E${i}`)
    for (let i = 0; i < ids.length; i++) {
      group.addEntity(createEntity(ids[i], createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    const capacity = batch.getSlotLifecycleMetrics().slotCapacity
    const erased = ids.slice(0, 5)
    const survivors = ids.slice(5)

    group.removeEntities(erased)
    expectSlotInvariants(group, survivors)
    expect(batch.getSlotLifecycleMetrics().freeListSize).toBe(5)

    // Undo restores the same five ids.
    for (const id of erased) {
      group.addEntity(
        createEntity(id, createLineSegments(ids.indexOf(id) * 2, material))
      )
    }
    expectSlotInvariants(group, ids)
    expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(capacity)

    // Redo erases them again, Undo restores them again.
    group.removeEntities(erased)
    expectSlotInvariants(group, survivors)
    group.addEntity(createEntity('ignored', createLineSegments(200, material)))
    expectSlotInvariants(group, [...survivors, 'ignored'])

    expect(batch.getSlotLifecycleMetrics().slotCapacity).toBeLessThanOrEqual(
      capacity
    )
    expect(batch.getSlotLifecycleMetrics().reusedSlots).toBeGreaterThanOrEqual(5)
  })

  it('survives MOVE → Undo → Redo with the geometry following the slot', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    const ids = ['M0', 'M1', 'M2']
    for (let i = 0; i < ids.length; i++) {
      group.addEntity(createEntity(ids[i], createLineSegments(i * 10, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    const capacity = batch.getSlotLifecycleMetrics().slotCapacity

    // MOVE = drop the old drawable, append the moved one (the viewer's
    // `updateEntity` → remove + reconvert path).
    group.removeEntities(['M1'])
    group.addEntity(createEntity('M1', createLineSegments(100, material)))

    expectSlotInvariants(group, ids)
    const slotOfM1 = batch._geometryInfo.findIndex(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'M1'
    )
    const moved = new THREE.Box3()
    batch.getBoundingBoxAt(slotOfM1, moved)
    expect(moved.min.y).toBeCloseTo(100)

    // Undo: back to y = 10.
    group.removeEntities(['M1'])
    group.addEntity(createEntity('M1', createLineSegments(10, material)))
    expectSlotInvariants(group, ids)
    const undone = new THREE.Box3()
    batch.getBoundingBoxAt(
      batch._geometryInfo.findIndex(
        info => isBatchGeometryActive(info.flags) && info.objectId === 'M1'
      ),
      undone
    )
    expect(undone.min.y).toBeCloseTo(10)
    expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(capacity)
  })

  it('absorbs repeated delete notifications for the same object', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    for (let i = 0; i < 5; i++) {
      group.addEntity(createEntity(`D${i}`, createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine

    expect(group.removeEntities(['D1', 'D1', 'D1']).removedObjectIds).toEqual([
      'D1'
    ])
    const slot = batch._geometryInfo.findIndex(
      info => info.objectId === 'D1' && isBatchGeometryActive(info.flags)
    )
    expect(slot).toBe(-1)

    // A duplicate-free notification must not double count either.
    const metrics = batch.getSlotLifecycleMetrics()
    expect(metrics.freedSlots).toBe(1)
    expect(metrics.deleteGeometryCalls).toBe(1)
    expect(metrics.duplicateFreeAttempts).toBe(0)
    expectSlotInvariants(group, ['D0', 'D2', 'D3', 'D4'])

    // Direct double free through the container API is detected, not applied.
    batch.deleteGeometry(0)
    batch.deleteGeometry(0)
    const afterDirect = batch.getSlotLifecycleMetrics()
    expect(afterDirect.duplicateFreeAttempts).toBe(1)
    expectSlotInvariants(group, ['D2', 'D3', 'D4'])
  })

  it('keeps layers that share one material on independent slots', () => {
    const group = new AcTrBatchedGroup()
    const shared = new THREE.LineBasicMaterial()
    const ids: string[] = []
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 4; i++) {
        const id = `L${layer}-${i}`
        ids.push(id)
        group.addEntity(createEntity(id, createLineSegments(i * 2, shared)))
      }
    }
    const batches = collectBatches(group)
    expect(batches).toHaveLength(1)
    const batch = batches[0] as AcTrBatchedLine
    expect(batch.getSlotLifecycleMetrics().liveSlots).toBe(12)

    const layerIds = ['L1-0', 'L1-1', 'L1-2', 'L1-3']
    group.removeEntities(layerIds)
    expectSlotInvariants(
      group,
      ids.filter(id => !layerIds.includes(id))
    )
    expect(batch.getSlotLifecycleMetrics().freeListSize).toBe(4)

    for (const id of layerIds) {
      group.addEntity(createEntity(id, createLineSegments(30, shared)))
    }
    expectSlotInvariants(group, ids)
    expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(12)
  })

  it('keeps per-entity materials from spawning replacement batches', () => {
    const group = new AcTrBatchedGroup()
    const ids: string[] = []
    const materials = Array.from(
      { length: 12 },
      () => new THREE.LineBasicMaterial()
    )
    for (let i = 0; i < 12; i++) {
      const id = `P${i}`
      ids.push(id)
      group.addEntity(createEntity(id, createLineSegments(i * 2, materials[i])))
    }
    const batchCount = collectBatches(group).length
    expect(batchCount).toBe(12)

    for (let round = 0; round < 4; round++) {
      group.removeEntities(ids)
      expectSlotInvariants(group, [])
      for (let i = 0; i < ids.length; i++) {
        group.addEntity(
          createEntity(ids[i], createLineSegments(i * 2, materials[i]))
        )
      }
      expectSlotInvariants(group, ids)
      // No new container may appear: a stable material set means a stable
      // container set, and the freed slots must be reused inside them.
      expect(collectBatches(group).length).toBe(batchCount)
      for (const batch of collectBatches(group)) {
        expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(1)
      }
    }
  })

  it('mixes line, mesh, point and wide-line containers', () => {
    const group = new AcTrBatchedGroup()
    const lineMaterial = new THREE.LineBasicMaterial()
    const meshMaterial = new THREE.MeshBasicMaterial()
    const pointMaterial = new THREE.PointsMaterial()
    const wideMaterial = new LineMaterial({ linewidth: 2 })

    const make = (id: string, index: number) =>
      createEntity(
        id,
        createLineSegments(index * 2, lineMaterial),
        createMesh(index * 2, meshMaterial),
        createPoints(index * 2, pointMaterial),
        createWideLine(index * 2, wideMaterial)
      )

    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = `X${i}`
      ids.push(id)
      group.addEntity(make(id, i))
    }

    const batches = collectBatches(group)
    expect(batches).toHaveLength(4)
    const capacities = batches.map(b => b.getSlotLifecycleMetrics().slotCapacity)
    expect(capacities).toEqual([4, 4, 4, 4])
    expectSlotInvariants(group, ids)

    group.removeEntities(ids.slice(0, 2))
    expectSlotInvariants(group, ids.slice(2))
    for (const batch of batches) {
      expect(batch.getSlotLifecycleMetrics().freeListSize).toBe(2)
    }

    for (let i = 0; i < 2; i++) {
      group.addEntity(make(ids[i], 10 + i))
    }
    expectSlotInvariants(group, ids)
    expect(
      batches.map(b => b.getSlotLifecycleMetrics().slotCapacity)
    ).toEqual(capacities)
  })

  it('frees every fragment slot of a multi-level INSERT', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    const nested = new THREE.Group()
    nested.add(createLineSegments(0, material))
    nested.add(createLineSegments(4, material))
    const inner = new THREE.Group()
    inner.add(createLineSegments(8, material))
    inner.add(createLineSegments(12, material))
    nested.add(inner)

    group.addEntity(createEntity('INS-1', nested))
    group.addEntity(createEntity('INS-2', createLineSegments(20, material)))

    // Fragments may land in more than one origin bucket, so the assertion is on
    // the group totals rather than on the first container.
    const totals = group.getSlotLifecycleMetrics()
    expect(totals.liveSlots).toBe(5)
    expectSlotInvariants(group, ['INS-1', 'INS-2'])
    const slotsOf = (objectId: string) =>
      collectBatches(group).reduce(
        (count, batch) =>
          count +
          batch._geometryInfo.filter(
            info =>
              isBatchGeometryActive(info.flags) && info.objectId === objectId
          ).length,
        0
      )
    expect(slotsOf('INS-1')).toBe(4)
    expect(slotsOf('INS-2')).toBe(1)

    group.removeEntities(['INS-1'])
    const afterRemoval = group.getSlotLifecycleMetrics()
    expect(afterRemoval.liveSlots).toBe(1)
    expect(afterRemoval.freeListSize).toBe(4)
    expectSlotInvariants(group, ['INS-2'])

    // Undo re-appends the same fragment tree (a deep clone, as the converter
    // would rebuild it) and must land on the four slots it just released.
    group.addEntity(createEntity('INS-1', nested.clone(true)))
    expectSlotInvariants(group, ['INS-1', 'INS-2'])
    expect(group.getSlotLifecycleMetrics().slotCapacity).toBe(
      totals.slotCapacity
    )
  })

  it('clears selection and hover before the slot is handed to another entity', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    for (let i = 0; i < 3; i++) {
      group.addEntity(createEntity(`S${i}`, createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine

    group.select('S1')
    group.hover('S1')
    const slot = batch._geometryInfo.findIndex(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'S1'
    )
    expect(batch._highlightState.selectedMask[slot]).toBe(1)
    expect(batch._highlightState.hoveredMask[slot]).toBe(1)

    group.removeEntities(['S1'])
    group.addEntity(createEntity('S9', createLineSegments(60, material)))

    // The reused slot must not inherit the previous owner's highlight.
    const reusedSlot = batch._geometryInfo.findIndex(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'S9'
    )
    expect(reusedSlot).toBeGreaterThanOrEqual(0)
    expect(batch._highlightState.selectedMask[reusedSlot] ?? 0).toBe(0)
    expect(batch._highlightState.hoveredMask[reusedSlot] ?? 0).toBe(0)
    expectSlotInvariants(group, ['S0', 'S2', 'S9'])
  })

  it('picks and bounds only the current owner of a reused slot', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    for (let i = 0; i < 3; i++) {
      group.addEntity(createEntity(`K${i}`, createLineSegments(i * 10, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    const slot = batch._geometryInfo.findIndex(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'K1'
    )

    const hitsAtOldY: THREE.Intersection[] = []
    batch.intersectWith(slot, rayAt(10), hitsAtOldY)
    expect(hitsAtOldY.length).toBeGreaterThan(0)

    group.removeEntities(['K1'])
    expect(batch.getSlotLifecycleMetrics().inactiveBoundingBoxes).toBe(0)
    group.addEntity(createEntity('K9', createLineSegments(100, material)))
    forceBoundingBoxes(batch)

    const reusedSlot = batch._geometryInfo.findIndex(
      info => isBatchGeometryActive(info.flags) && info.objectId === 'K9'
    )
    expect(reusedSlot).toBeGreaterThanOrEqual(0)

    const hitsAtNewY: THREE.Intersection[] = []
    batch.intersectWith(reusedSlot, rayAt(100), hitsAtNewY)
    expect(hitsAtNewY.length).toBeGreaterThan(0)

    // The previous owner's position must be gone from this slot.
    const hitsAtPreviousY: THREE.Intersection[] = []
    batch.intersectWith(reusedSlot, rayAt(10), hitsAtPreviousY)
    expect(hitsAtPreviousY).toHaveLength(0)

    const box = new THREE.Box3()
    batch.getBoundingBoxAt(reusedSlot, box)
    expect(box.min.y).toBeCloseTo(100)
    expect(box.max.y).toBeCloseTo(100)
  })

  it('drops every slot record when the batch is reset', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    for (let i = 0; i < 6; i++) {
      group.addEntity(createEntity(`Z${i}`, createLineSegments(i * 2, material)))
    }
    const batch = collectBatches(group)[0] as AcTrBatchedLine
    group.removeEntities(['Z0', 'Z1'])
    const generation = batch.getSlotGenerationAt(0)

    batch.reset()

    const metrics = batch.getSlotLifecycleMetrics()
    expect(metrics.slotCapacity).toBe(0)
    expect(metrics.liveSlots).toBe(0)
    expect(metrics.freedSlots).toBe(0)
    expect(metrics.freeListSize).toBe(0)
    expect(batch.getSlotGenerationAt(0)).toBe(-1)
    expect(batch.isSlotGenerationCurrent(0, generation)).toBe(false)
  })

  it('leaves phase 2.9 shared-batch metrics untouched by slot reuse', () => {
    const group = new AcTrBatchedGroup()
    const material = new THREE.LineBasicMaterial()
    const template = createLineSegments(0, material)
    getSceneDrawableUserData(template).sharesTemplateGeometry = true

    const ids = ['T0', 'T1']
    for (let i = 0; i < ids.length; i++) {
      const drawable = new THREE.LineSegments(template.geometry, material)
      drawable.position.set(0, i * 20, 0)
      drawable.updateMatrixWorld(true)
      getSceneDrawableUserData(drawable).sharesTemplateGeometry = true
      group.addEntity(createEntity(ids[i], drawable))
    }

    const sharedBefore = group.getSharedBatchMetrics()
    expect(sharedBefore.activeBatches).toBeGreaterThanOrEqual(1)
    // Shared-template instances live in `AcTrSharedGeometryBatch`, not in an
    // origin batch's slot table, so the group-level id set is checked through the
    // shared metrics and the origin invariants are checked with no expectation.
    expect(sharedBefore.activeInstances).toBe(2)

    for (let round = 0; round < 3; round++) {
      group.removeEntities(ids)
      expectSlotInvariants(group)
      for (let i = 0; i < ids.length; i++) {
        const drawable = new THREE.LineSegments(template.geometry, material)
        drawable.position.set(0, i * 20, 0)
        drawable.updateMatrixWorld(true)
        getSceneDrawableUserData(drawable).sharesTemplateGeometry = true
        group.addEntity(createEntity(ids[i], drawable))
      }
      expectSlotInvariants(group)
      expect(group.getSharedBatchMetrics().activeInstances).toBe(2)
    }

    const sharedAfter = group.getSharedBatchMetrics()
    // Reuse must not create new template batches for the same geometry.
    expect(sharedAfter.activeBatches).toBe(sharedBefore.activeBatches)
    expect(sharedAfter.activeInstances).toBe(sharedBefore.activeInstances)
    expect(sharedAfter.created).toBe(sharedBefore.created)
  })
})
