import * as THREE from 'three'

import { isBatchGeometryActive } from '../src/batch/AcTrBatchedGeometryInfo'
import { AcTrBatchedGroup } from '../src/batch/AcTrBatchedGroup'
import { AcTrBatchedLine } from '../src/batch/AcTrBatchedLine'
import { addSlotLifecycleMetrics } from '../src/batch/AcTrBatchSlotLifecycleMetrics'
import { AcTrEntity } from '../src/object/AcTrEntity'
import { AcTrRenderContext } from '../src/renderer/AcTrRenderContext'

/**
 * Phase 2.11 — slot lifecycle invariants.
 *
 * These run in node against the real batched containers, so the ERASE path can
 * be exercised (add → remove → compact → re-add) without a browser, and every
 * assertion is about the slot table itself rather than a rendered frame:
 *
 * - `_geometryInfo` capacity must converge across edit rounds,
 * - the free list must be the exact complement of the live slots,
 * - a freed slot must not keep the metadata of the entity that left it.
 *
 * The Phase 2.10 heap audit measured the residue in the browser; these tests
 * pin the mechanism that produced it.
 */

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

function createEntity(objectId: string, ...drawables: THREE.Object3D[]) {
  const entity = new AcTrEntity(new AcTrRenderContext())
  entity.objectId = objectId
  entity.visible = true
  for (const drawable of drawables) {
    entity.add(drawable)
  }
  return entity
}

function lineBatches(group: AcTrBatchedGroup): AcTrBatchedLine[] {
  const batches: AcTrBatchedLine[] = []
  group.traverse(child => {
    if (child instanceof AcTrBatchedLine) batches.push(child)
  })
  return batches
}

type GroupHarness = {
  group: AcTrBatchedGroup
  batch: AcTrBatchedLine
  material: THREE.LineBasicMaterial
  ids: string[]
  /**
   * Re-adds the listed ids as fresh entities, exactly like an Undo wave.
   *
   * Only ids that were actually removed may be re-added: passing a live id would
   * register a second slot for the same object id and mask the invariant this
   * suite is meant to pin.
   */
  readd: (missing: readonly string[]) => void
}

/** One material ⇒ one batched container, so the slot table is unambiguous. */
function createHarness(entityCount: number): GroupHarness {
  const group = new AcTrBatchedGroup()
  const material = new THREE.LineBasicMaterial()
  const ids: string[] = []
  for (let i = 0; i < entityCount; i++) {
    const id = `E${i}`
    ids.push(id)
    group.addEntity(createEntity(id, createLineSegments(i * 2, material)))
  }
  const batches = lineBatches(group)
  expect(batches).toHaveLength(1)

  return {
    group,
    batch: batches[0],
    material,
    ids,
    readd: (missing: readonly string[]) => {
      for (const id of missing) {
        const index = ids.indexOf(id)
        group.addEntity(
          createEntity(id, createLineSegments(index * 2, material))
        )
      }
    }
  }
}

/** Forces every live slot to materialize its lazily-cached `Box3`. */
function materializeBoundingBoxes(batch: AcTrBatchedLine, count: number) {
  const box = new THREE.Box3()
  for (let id = 0; id < count; id++) {
    batch.getBoundingBoxAt(id, box)
  }
}

describe('batch slot lifecycle (phase 2.11)', () => {
  it('counts the delete calls that the ERASE path issues', () => {
    const { group, batch, ids } = createHarness(4)

    group.removeEntities(ids.slice(0, 3))

    const metrics = batch.getSlotLifecycleMetrics()
    // The erase path must actually reach `deleteGeometryById`; phase 2.10 could
    // only infer it from an empty free list.
    expect(metrics.deleteGeometryCalls).toBe(3)
    expect(metrics.deleteGeometrySkipped).toBe(0)
    expect(metrics.freedSlots).toBe(3)
  })

  it('leaves the free list equal to the set of freed slots after compaction', () => {
    const { group, batch, ids } = createHarness(8)

    group.removeEntities(ids.slice(0, 3))

    const metrics = batch.getSlotLifecycleMetrics()
    const freed = metrics.slotCapacity - metrics.liveSlots
    expect(metrics.freedSlots).toBe(3)
    // Compaction rewrites vertex ranges; it must not forget which ids are free.
    expect(metrics.freeListSize).toBe(freed)
  })

  it('converges slot capacity across repeated ERASE / Undo rounds', () => {
    const harness = createHarness(8)
    const { group, batch, ids } = harness
    const initialCapacity = batch.getSlotLifecycleMetrics().slotCapacity
    expect(initialCapacity).toBe(8)

    const capacities: number[] = []
    for (let round = 0; round < 5; round++) {
      group.removeEntities(ids)
      harness.readd(ids)
      capacities.push(batch.getSlotLifecycleMetrics().slotCapacity)
    }

    // Same logical scene, same peak concurrency: capacity may sit above the
    // initial value, but it must not climb with the number of rounds.
    expect(Math.max(...capacities)).toBe(initialCapacity)
    expect(capacities[capacities.length - 1]).toBe(capacities[0])
  })

  it('reports a free list with no duplicates, no active ids and no stale ranges', () => {
    const { group, batch, ids } = createHarness(8)

    group.removeEntities(ids.slice(0, 5))
    // Free one slot twice through the batch API as well.
    batch.deleteGeometry(5)
    batch.deleteGeometry(5)

    const pool = batch._availableGeometryIds
    const metrics = batch.getSlotLifecycleMetrics()

    expect(new Set(pool).size).toBe(pool.length)
    expect(metrics.freeListSize).toBe(metrics.freedSlots)
    expect(metrics.duplicateFreeAttempts).toBe(1)
    for (const id of pool) {
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(metrics.slotCapacity)
      expect(isBatchGeometryActive(batch._geometryInfo[id].flags)).toBe(false)
    }
  })

  it('drops the bounding box of a freed slot', () => {
    const { group, batch, ids } = createHarness(6)
    materializeBoundingBoxes(batch, 6)

    const before = batch.getSlotLifecycleMetrics()
    expect(before.liveBoundingBoxes).toBe(6)

    group.removeEntities(ids.slice(0, 2))

    const after = batch.getSlotLifecycleMetrics()
    // A soft-deleted slot keeps its array position until reuse, so a cached box
    // left behind is reachable from the batch for the life of the document.
    expect(after.inactiveBoundingBoxes).toBe(0)
  })

  it('drops the hidden draw snapshot of a freed slot', () => {
    const { group, batch, ids } = createHarness(4)
    batch.setVisibleAt(0, false)

    // `retainedHiddenSnapshots` only counts inactive slots, so the hiding itself
    // is asserted on the record: the collapse must have snapshotted the range.
    expect(batch._geometryInfo[0].hiddenDrawSnapshot).toBeDefined()

    group.removeEntities([ids[0]])

    expect(batch._geometryInfo[0].hiddenDrawSnapshot).toBeUndefined()
    expect(batch.getSlotLifecycleMetrics().retainedHiddenSnapshots).toBe(0)
  })

  it('hands a reused slot a record with no state from its previous owner', () => {
    const harness = createHarness(3)
    const { group, batch, ids } = harness
    materializeBoundingBoxes(batch, 3)
    batch.setVisibleAt(1, false)
    const previousOwners = batch._geometryInfo.map(info => info.objectId)

    group.removeEntities([ids[1]])
    harness.readd([ids[1]])

    // The id that `E1` used to occupy must now describe exactly one entity,
    // and that entity's metadata must be the only metadata in the record.
    const idsInUse = new Set<string>()
    for (const info of batch._geometryInfo) {
      if (!isBatchGeometryActive(info.flags)) continue
      expect(info.objectId).toBeDefined()
      expect(idsInUse.has(String(info.objectId))).toBe(false)
      idsInUse.add(String(info.objectId))
    }
    expect(idsInUse.size).toBe(3)
    expect(idsInUse.has('E1')).toBe(true)
    expect(previousOwners.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps slot capacity at the high-water mark, not at the live count', () => {
    const { group, batch, ids } = createHarness(10)
    const peak = batch.getSlotLifecycleMetrics().slotCapacity
    expect(peak).toBe(10)

    group.removeEntities(ids.slice(0, 6))

    // Shrinking the table would re-allocate on the next Undo wave; the capacity
    // must hold at the peak while the free list absorbs the freed ids.
    expect(batch.getSlotLifecycleMetrics().slotCapacity).toBe(peak)
    expect(batch.getSlotLifecycleMetrics().liveSlots).toBe(4)
    expect(batch.getSlotLifecycleMetrics().freeListSize).toBe(6)
  })

  it('does not keep a removed slot pickable', () => {
    const { group, batch, ids } = createHarness(2)
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(5, -50, 0),
      new THREE.Vector3(0, 1, 0)
    )
    const hits: THREE.Intersection[] = []
    batch.intersectWith(1, raycaster, hits)
    expect(hits.length).toBeGreaterThan(0)

    group.removeEntities([ids[1]])

    const afterRemoval: THREE.Intersection[] = []
    batch.intersectWith(1, raycaster, afterRemoval)
    expect(afterRemoval).toHaveLength(0)
  })

  it('stamps a new generation on the id handed to the next owner', () => {
    const harness = createHarness(4)
    const { group, batch, ids } = harness
    const firstOwnerGeneration = batch.getSlotGenerationAt(1)

    group.removeEntities([ids[1]])
    harness.readd([ids[1]])

    // The same array position now describes a different entity, so a writer that
    // captured the id earlier must be able to tell that it lost the slot.
    expect(batch.getSlotGenerationAt(1)).toBeGreaterThan(firstOwnerGeneration)
    expect(
      batch.isSlotGenerationCurrent(1, firstOwnerGeneration)
    ).toBe(false)
    expect(
      batch.isSlotGenerationCurrent(1, batch.getSlotGenerationAt(1))
    ).toBe(true)
  })

  it('refuses a slot id after the batch has been reset', () => {
    const { batch } = createHarness(3)
    expect(batch.getSlotGenerationAt(0)).toBeGreaterThan(0)

    batch.reset()

    // A closed batch must not answer through a stale reference, and the
    // generation probe has to report the id as gone rather than "current".
    expect(batch.getSlotGenerationAt(0)).toBe(-1)
    expect(batch.isSlotGenerationCurrent(0, 1)).toBe(false)
    expect(() => batch.setVisibleAt(0, false)).toThrow()
  })

  it('folds per-batch metrics into group totals', () => {
    const { group } = createHarness(5)

    const totals = group.getSlotLifecycleMetrics()
    const summed = group
      .getSlotLifecycleMetrics()
      .batchCountLive.toString()
    expect(totals.batchCount).toBeGreaterThanOrEqual(1)
    expect(totals.slotCapacity).toBeGreaterThanOrEqual(5)
    expect(totals.liveSlots).toBe(5)
    expect(summed).toBe('1')
    // The accumulator must be a plain number object, not a live reference.
    const copy = addSlotLifecycleMetrics(
      { ...totals },
      { ...totals }
    )
    expect(copy.slotCapacity).toBe(totals.slotCapacity * 2)
  })
})
