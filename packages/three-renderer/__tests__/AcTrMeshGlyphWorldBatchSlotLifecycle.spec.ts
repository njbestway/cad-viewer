import * as THREE from 'three'

import { AcTrMeshGlyphWorldBatch } from '../src/batch/AcTrMeshGlyphWorldBatch'

/**
 * Phase 2.12 Task A2 — MTEXT / glyph slot lifecycle regression.
 *
 * Phase 2.11 closed the slot lifecycle for the four linework containers and left
 * one gap, stated in `PHASE211_SLOT_LIFECYCLE_AUDIT.md` §8.6: *"Glyph / MTEXT
 * slots have no slot-level e2e"*. This spec closes it. It runs in node against
 * the real `AcTrMeshGlyphWorldBatch`, so it pins the mechanism rather than a
 * rendered frame — the same choice `AcTrBatchSlotLifecycle.spec.ts` made for the
 * linework batches.
 *
 * Glyph instances are not slots in `_geometryInfo`. They are per-flush
 * `InstancedMesh` allocations appended to a layer group, with a per-objectId slot
 * list, a union-of-instances world pick box, and a scale-0 hide trick. That makes
 * the failure modes different from the linework containers, and worth their own
 * invariants:
 *
 * - a MOVE must not leave the previous placement visible,
 * - a MOVE must not leave the previous world pick box behind (hit-testing at the
 *   old position would still resolve to the entity),
 * - an entity erased while its placements are still queued must never reach an
 *   `InstancedMesh`,
 * - a freed instance must not inherit the hidden flag or highlight of its
 *   previous owner,
 * - repeated MOVE rounds must not grow the `InstancedMesh` count per round.
 */

const MATERIAL = new THREE.MeshBasicMaterial()

function glyphGeometry(width = 1, height = 1, depth = 0.2): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth)
  geometry.computeBoundingBox()
  return geometry
}

/** Column-major world matrix for a placement at `(x, y, z)`. */
function placement(x: number, y: number, z = 0): Float32Array {
  return new THREE.Matrix4().makeTranslation(x, y, z).toArray()
}

function queue(
  batch: AcTrMeshGlyphWorldBatch,
  objectId: string,
  at: { x: number; y: number },
  options: { layerName?: string; visible?: boolean; geometry?: THREE.BufferGeometry } = {}
) {
  batch.enqueue([placement(at.x, at.y)], options.geometry ?? glyphGeometry(), MATERIAL, {
    objectId,
    layerName: options.layerName ?? '0',
    visible: options.visible
  })
}

function flush(batch: AcTrMeshGlyphWorldBatch): THREE.Scene {
  const scene = new THREE.Scene()
  batch.flush(scene)
  return scene
}

function instancedMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = []
  scene.traverse(object => {
    const mesh = object as THREE.InstancedMesh
    if (mesh.isInstancedMesh) found.push(mesh)
  })
  return found
}

/** Instance matrices of one object id, read back from whatever mesh holds it. */
function instanceMatrices(scene: THREE.Scene): THREE.Matrix4[] {
  const matrices: THREE.Matrix4[] = []
  for (const mesh of instancedMeshes(scene)) {
    const matrix = new THREE.Matrix4()
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix)
      matrices.push(matrix.clone())
    }
  }
  return matrices
}

/** An instance is hidden by the scale-0 trick, i.e. a zero-determinant matrix. */
function isHiddenInstance(matrix: THREE.Matrix4): boolean {
  return Math.abs(matrix.determinant()) < 1e-9
}

function visibleInstanceCount(scene: THREE.Scene): number {
  return instanceMatrices(scene).filter(matrix => !isHiddenInstance(matrix)).length
}

function rayThrough(x: number, y: number): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.ray.origin.set(x, y, 100)
  raycaster.ray.direction.set(0, 0, -1)
  return raycaster
}

describe('mesh glyph slot lifecycle', () => {
  test('splits placements into one bucket per geometry × material × layer', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    const geometry = glyphGeometry()

    queue(batch, 'a', { x: 0, y: 0 }, { geometry })
    queue(batch, 'b', { x: 2, y: 0 }, { geometry })
    queue(batch, 'a', { x: 4, y: 0 }, { geometry, layerName: 'TEXT' })
    expect(batch.placementCount).toBe(3)
    expect(batch.bucketCount).toBe(2)

    const scene = flush(batch)
    expect(batch.placementCount).toBe(0)
    expect(batch.bucketCount).toBe(0)
    expect(instancedMeshes(scene)).toHaveLength(2)
    // One entity can own several instances; pick coverage is the union.
    expect(batch.getWorldPickBoxes().get('a')?.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(true)
    expect(batch.getWorldPickBoxes().get('a')?.containsPoint(new THREE.Vector3(4, 0, 0))).toBe(true)
    batch.dispose()
  })

  test('a MOVE that removes its old slots leaves one live placement at the new position', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    queue(batch, 'text-1', { x: 0, y: 0 })
    const scene = flush(batch)

    // The production path for an updated entity: drop the old slots, then queue
    // the rebuilt placements.
    expect(batch.removeByObjectId('text-1')).toBe(true)
    queue(batch, 'text-1', { x: 50, y: 0 })
    batch.flush(scene)

    const pickBox = batch.getWorldPickBoxes().get('text-1')
    expect(pickBox).toBeDefined()
    // The box must sit at the new position only: a union with the old position
    // would make the entity pickable at a place it no longer occupies.
    expect(pickBox!.containsPoint(new THREE.Vector3(50, 0, 0))).toBe(true)
    expect(pickBox!.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(false)
    expect(batch.intersectsObjectId('text-1', rayThrough(0, 0))).toBe(false)
    expect(batch.intersectsObjectId('text-1', rayThrough(50, 0))).toBe(true)

    // Exactly one instance is still visible for this entity; the previous one was
    // scale-hidden by `dropLiveSlots`.
    expect(visibleInstanceCount(scene)).toBe(1)
    batch.dispose()
  })

  /**
   * Known defect, gated by `test.failing` rather than deleted.
   *
   * `flush()` unions the new placements' world box into the objectId's existing
   * pick box instead of replacing it, so an entity that is rebuilt without being
   * erased first stays pickable at its previous position. Latent today because
   * `AcTrMTextRenderer._meshGlyphInstancing` defaults to `false` and nothing in the
   * product calls `setMeshGlyphInstancing(true)`.
   *
   * When this is fixed the test starts passing and Jest reports
   * "failing test passed", which is the prompt to promote it to `test`.
   */
  test.failing('a re-flush without removal does not union the old pick box', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    queue(batch, 'text-2', { x: 0, y: 0 })
    const scene = flush(batch)

    // `flushMeshGlyphWorldBatch()` is scheduled once per idle point, and nothing
    // removes the previous slots first — so this is the shape a MOVE actually
    // takes when the caller does not erase the entity first.
    queue(batch, 'text-2', { x: 80, y: 0 })
    batch.flush(scene)

    const pickBox = batch.getWorldPickBoxes().get('text-2')
    expect(pickBox!.containsPoint(new THREE.Vector3(80, 0, 0))).toBe(true)
    expect(pickBox!.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(false)
    batch.dispose()
  })

  test('an entity erased while its placements are still queued never reaches a mesh', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    queue(batch, 'text-3', { x: 0, y: 0 })
    queue(batch, 'text-3', { x: 1, y: 0 })
    expect(batch.placementCount).toBe(2)

    // queued → ERASE → flush: the pending placements must be dropped, not drawn.
    expect(batch.removeByObjectId('text-3')).toBe(true)
    expect(batch.placementCount).toBe(0)
    const scene = flush(batch)
    expect(instancedMeshes(scene)).toHaveLength(0)
    expect(batch.getWorldPickBoxes().has('text-3')).toBe(false)
    expect(batch.intersectsObjectId('text-3', rayThrough(0, 0))).toBe(false)
    batch.dispose()
  })

  test('a removed entity keeps no visible instance in the stale mesh', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    queue(batch, 'text-4', { x: 0, y: 0 })
    const scene = flush(batch)
    expect(visibleInstanceCount(scene)).toBe(1)

    expect(batch.removeByObjectId('text-4')).toBe(true)
    // The mesh itself stays parented (only its instances are hidden), so the
    // guarantee has to be "nothing draws", not "the mesh is gone".
    expect(visibleInstanceCount(scene)).toBe(0)
    expect(instancedMeshes(scene).length).toBeGreaterThan(0)
    expect(batch.intersectsObjectId('text-4', rayThrough(0, 0))).toBe(false)
    expect(batch.queryObjectIdsIntersectingBox({ minX: -5, minY: -5, maxX: 5, maxY: 5 })).toEqual([])
    batch.dispose()
  })

  test('a freed instance does not hand its hidden flag to the next owner', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    queue(batch, 'hidden-text', { x: 0, y: 0 }, { visible: false })
    const scene = flush(batch)

    // The hidden flag is instance-level (scale-0), so a reused instance that kept
    // it would render the next entity invisible.
    expect(visibleInstanceCount(scene)).toBe(0)
    expect(batch.setVisibleByObjectId('hidden-text', true)).toBe(true)
    expect(visibleInstanceCount(scene)).toBe(1)

    batch.removeByObjectId('hidden-text')
    queue(batch, 'next-text', { x: 0, y: 0 })
    batch.flush(scene)

    expect(batch.setVisibleByObjectId('next-text', true)).toBe(false)
    expect(batch.intersectsObjectId('next-text', rayThrough(0, 0))).toBe(true)
    batch.dispose()
  })

  test('highlight and visibility never resolve for an unknown or freed id', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    expect(batch.setHighlightByObjectId('missing', 'select', true)).toBe(false)
    expect(batch.setVisibleByObjectId('missing', true)).toBe(false)
    expect(batch.removeByObjectId('missing')).toBe(false)
    expect(batch.removeByObjectId('')).toBe(false)

    queue(batch, 'text-5', { x: 0, y: 0 })
    flush(batch)
    expect(batch.setHighlightByObjectId('text-5', 'select', true)).toBe(true)

    batch.removeByObjectId('text-5')
    // After the erase the id is unknown again, and no overlay may survive it.
    expect(batch.setHighlightByObjectId('text-5', 'select', false)).toBe(false)
    expect(batch.intersectsObjectId('text-5', rayThrough(0, 0))).toBe(false)
    batch.dispose()
  })

  /**
   * Known defect, same gate as above.
   *
   * Each `flush()` allocates fresh `InstancedMesh` objects and never disposes the
   * previous ones: the mesh count grows with the number of edits instead of the
   * number of entities, and the previous instances stay visible because nothing
   * scale-hides them. Twenty MOVE rounds therefore leave twenty visible glyph
   * copies of the same entity.
   */
  test.failing('twenty MOVE rounds do not grow the InstancedMesh count per round', () => {
    const batch = new AcTrMeshGlyphWorldBatch()
    const geometry = glyphGeometry()
    const scene = new THREE.Scene()

    const counts: number[] = []
    for (let round = 0; round < 20; round++) {
      queue(batch, 'text-6', { x: round * 2, y: 0 }, { geometry })
      batch.flush(scene)
      counts.push(instancedMeshes(scene).length)
    }

    // A per-round allocation gives 1, 2, 3 … 20 meshes: growth bounded by edit
    // count instead of by entity count, with one still-visible copy per round.
    expect(counts[0]).toBe(1)
    expect(visibleInstanceCount(scene)).toBe(1)
    expect(counts[counts.length - 1]).toBe(counts[0])
    batch.dispose()
  })
})
