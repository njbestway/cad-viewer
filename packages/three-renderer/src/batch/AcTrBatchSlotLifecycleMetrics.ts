import {
  AcTrBatchGeometryFlags,
  isBatchGeometryActive
} from './AcTrBatchedGeometryInfo'

/**
 * Phase 2.11 Task B1 — packed-slot lifecycle counters for one batched container.
 *
 * The Phase 2.10 measurement (`+1800 slots/round` on a 1000-entity ERASE/Undo
 * cycle, free list observed at zero on every sample) narrowed the residue to the
 * batch slot table but could not say *why* the free list never received an id.
 * These counters answer that by instrumenting the two functions that own the
 * lifecycle — {@link reserveGeometryId} and {@link deleteGeometryById} — plus the
 * compaction pass that runs between them.
 *
 * Counters are plain numbers on the batch object, so the cost when nobody reads
 * them is a handful of increments per insert/delete, not a per-slot array.
 */
export interface BatchSlotLifecycleMetrics {
  /** Slot records ever created by the append path (never decreases). */
  allocatedSlots: number
  /** `_geometryInfo` length: high-water mark of records, including dead ones. */
  slotCapacity: number

  /** Slots whose `flags` still carry `Active`. */
  liveSlots: number
  /** Slots whose `flags` are `None` (soft-deleted, awaiting reuse). */
  freedSlots: number
  /** Slot records assigned from the free list instead of appended. */
  reusedSlots: number

  /** Ids currently waiting for reuse. */
  freeListSize: number
  /** Successful `push` operations on the free list. */
  freeListPushCount: number
  /** Successful `shift` operations on the free list (pops). */
  freeListPopCount: number

  /** Every call to the delete entry point, including no-ops. */
  deleteGeometryCalls: number
  /** Calls that returned without freeing (out of range, inactive, or dropped). */
  deleteGeometrySkipped: number
  /** Calls that targeted an already-freed slot — the double-free signal. */
  duplicateFreeAttempts: number

  /** Dead-or-live slots that still hold a `Box3`. */
  liveBoundingBoxes: number
  /** Soft-deleted slots that still hold a `Box3`. Non-zero means staleness. */
  inactiveBoundingBoxes: number
  /** Soft-deleted slots that still hold a `hiddenDrawSnapshot`. */
  retainedHiddenSnapshots: number

  /** Largest `slotCapacity` ever observed for this batch. */
  slotHighWaterMark: number
}

/**
 * Mutable counters owned by one batched container.
 *
 * Kept separate from {@link BatchSlotLifecycleMetrics} because the gauges need a
 * scan of the slot table and the counters must stay O(1) on the hot path.
 */
export interface AcTrBatchSlotLifecycleCounters {
  allocatedSlots: number
  reusedSlots: number
  freedSlots: number
  freeListPushCount: number
  freeListPopCount: number
  freeListDroppedByOptimize: number
  deleteGeometryCalls: number
  deleteGeometrySkipped: number
  duplicateFreeAttempts: number
  slotHighWaterMark: number
}

/** Creates a zeroed counter block for one batch. */
export function createSlotLifecycleCounters(): AcTrBatchSlotLifecycleCounters {
  return {
    allocatedSlots: 0,
    reusedSlots: 0,
    freedSlots: 0,
    freeListPushCount: 0,
    freeListPopCount: 0,
    freeListDroppedByOptimize: 0,
    deleteGeometryCalls: 0,
    deleteGeometrySkipped: 0,
    duplicateFreeAttempts: 0,
    slotHighWaterMark: 0
  }
}

/**
 * Recomputes the free list from the slot table.
 *
 * Every soft-deleted slot must be reachable for reuse, and a reused id must be
 * handed out exactly once, so the list is rebuilt by ascending id rather than
 * patched. That also makes the three Phase 2.11 free-list invariants structural
 * instead of defensive: no active id (the loop skips active slots), no duplicate
 * id (one push per slot), no out-of-range id (indices come from the array).
 *
 * @param geometryInfo - Slot table of the batch.
 * @param availableGeometryIds - Pool to overwrite in place.
 * @param counters - Optional lifecycle counters for the audit.
 * @returns How many ids the previous list held that the rebuild dropped, i.e.
 *   ids that were pooled while their slot was still active (must always be 0).
 */
export function rebuildAvailableGeometryIds<T extends { flags: number }>(
  geometryInfo: readonly T[],
  availableGeometryIds: number[],
  counters?: AcTrBatchSlotLifecycleCounters
) {
  const previousSize = availableGeometryIds.length
  availableGeometryIds.length = 0

  for (let id = 0; id < geometryInfo.length; id++) {
    if (!isBatchGeometryActive(geometryInfo[id].flags)) {
      availableGeometryIds.push(id)
    }
  }

  // A pooled id whose slot is active would mean the slot is both live and
  // reusable. The rebuild drops it; count it so an audit can see it happen.
  const dropped = Math.max(0, previousSize - availableGeometryIds.length)
  if (counters) {
    counters.freeListDroppedByOptimize += dropped
  }
  return dropped
}

/**
 * Reads the full metric set for one batch.
 *
 * @param counters - Cumulative counters of the batch.
 * @param geometryInfo - Slot table of the batch.
 * @param availableGeometryIds - Current free list.
 * @returns The metric record, with gauges computed from the slot table.
 */
export function collectSlotLifecycleMetrics<T extends {
  flags: number
  boundingBox?: unknown
  hiddenDrawSnapshot?: unknown
}>(
  counters: AcTrBatchSlotLifecycleCounters,
  geometryInfo: readonly T[],
  availableGeometryIds: readonly number[]
): BatchSlotLifecycleMetrics {
  let liveSlots = 0
  let freedSlots = 0
  let liveBoundingBoxes = 0
  let inactiveBoundingBoxes = 0
  let retainedHiddenSnapshots = 0

  for (let id = 0; id < geometryInfo.length; id++) {
    const info = geometryInfo[id]
    const active = isBatchGeometryActive(info.flags)
    if (active) {
      liveSlots++
      if (info.boundingBox != null) liveBoundingBoxes++
    } else {
      freedSlots++
      if (info.boundingBox != null) inactiveBoundingBoxes++
      if (info.hiddenDrawSnapshot !== undefined) retainedHiddenSnapshots++
    }
  }

  return {
    allocatedSlots: counters.allocatedSlots,
    slotCapacity: geometryInfo.length,

    liveSlots,
    freedSlots,
    reusedSlots: counters.reusedSlots,

    freeListSize: availableGeometryIds.length,
    freeListPushCount: counters.freeListPushCount,
    freeListPopCount: counters.freeListPopCount,

    deleteGeometryCalls: counters.deleteGeometryCalls,
    deleteGeometrySkipped: counters.deleteGeometrySkipped,
    duplicateFreeAttempts: counters.duplicateFreeAttempts,

    liveBoundingBoxes,
    inactiveBoundingBoxes,
    retainedHiddenSnapshots,

    slotHighWaterMark: Math.max(counters.slotHighWaterMark, geometryInfo.length)
  }
}

/** Summed metrics of every batched container under one group. */
export interface AcTrBatchSlotLifecycleTotals extends BatchSlotLifecycleMetrics {
  /** Number of batched containers that reported. */
  batchCount: number
  /** Containers with at least one live slot. */
  batchCountLive: number
  /** Containers whose every slot is soft-deleted but still resident. */
  batchCountAllFreed: number
}

/** Adds two metric records; used to fold per-batch data into group totals. */
export function addSlotLifecycleMetrics(
  target: BatchSlotLifecycleMetrics,
  source: BatchSlotLifecycleMetrics
) {
  target.allocatedSlots += source.allocatedSlots
  target.slotCapacity += source.slotCapacity
  target.liveSlots += source.liveSlots
  target.freedSlots += source.freedSlots
  target.reusedSlots += source.reusedSlots
  target.freeListSize += source.freeListSize
  target.freeListPushCount += source.freeListPushCount
  target.freeListPopCount += source.freeListPopCount
  target.deleteGeometryCalls += source.deleteGeometryCalls
  target.deleteGeometrySkipped += source.deleteGeometrySkipped
  target.duplicateFreeAttempts += source.duplicateFreeAttempts
  target.liveBoundingBoxes += source.liveBoundingBoxes
  target.inactiveBoundingBoxes += source.inactiveBoundingBoxes
  target.retainedHiddenSnapshots += source.retainedHiddenSnapshots
  target.slotHighWaterMark = Math.max(
    target.slotHighWaterMark,
    source.slotHighWaterMark
  )
  return target
}

/** Zeroed accumulator for {@link addSlotLifecycleMetrics}. */
export function createSlotLifecycleTotals(): AcTrBatchSlotLifecycleTotals {
  return {
    ...collectSlotLifecycleMetrics(
      createSlotLifecycleCounters(),
      [] as Array<{ flags: number }>,
      []
    ),
    batchCount: 0,
    batchCountLive: 0,
    batchCountAllFreed: 0
  }
}

/**
 * Flags a slot record as reusable without touching its array position.
 *
 * Clearing `flags` is what makes the slot inactive; the metadata release is what
 * keeps a freed slot from pinning a `Box3` (and, on hidden slots, a copy of its
 * GPU range) for the life of the document. Phase 2.10 measured those two as the
 * only retained objects traceable to a freed slot.
 *
 * @param info - Slot record being released.
 */
export function releaseSlotMetadata(info: {
  flags: number
  boundingBox?: unknown
  hiddenDrawSnapshot?: unknown
}) {
  info.flags = AcTrBatchGeometryFlags.None
  if (info.boundingBox !== undefined) info.boundingBox = null
  delete info.hiddenDrawSnapshot
}
