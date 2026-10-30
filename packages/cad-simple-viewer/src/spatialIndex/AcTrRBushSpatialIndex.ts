import { AcDbObjectId } from '@mlightcad/data-model'
import RBush from 'rbush'

import { AcEdSpatialQueryResultItem } from '../editor/view'
import { isFiniteSpatialBBox } from '../view/AcTrGroupWcsBboxAssert'
import {
  AcTrSpatialIndex,
  AcTrSpatialIndexBBox,
  AcTrSpatialIndexStats,
  AcTrSpatialSearchOptions,
  estimateSpatialItemsBytes,
  isSpatialBoxFullyInside
} from './AcTrSpatialIndex'

/** Approx. Map entry overhead (key pointer + value pointer + slot). */
const ID_MAP_ENTRY_BYTES = 40
/** Rough R-tree node overhead relative to leaf item payload. */
const RBUSH_TREE_OVERHEAD_FACTOR = 1.4

export class AcTrRBushSpatialIndex implements AcTrSpatialIndex {
  private readonly tree: RBush<AcEdSpatialQueryResultItem>
  private readonly idMap: Map<AcDbObjectId, AcEdSpatialQueryResultItem>

  constructor(maxEntries?: number) {
    this.tree = new RBush<AcEdSpatialQueryResultItem>(maxEntries)
    this.idMap = new Map<AcDbObjectId, AcEdSpatialQueryResultItem>()
  }

  insert(item: AcEdSpatialQueryResultItem) {
    // RBush parent-node bounds use Math.min/max; a single NaN bbox poisons the
    // tree so every later search returns empty (pick / osnap fail globally).
    if (!isFiniteSpatialBBox(item)) {
      return
    }
    const hasId = typeof item.id === 'string' && item.id.length > 0
    // Empty ids (hatch fill islands) must not share one Map slot — otherwise
    // later inserts overwrite earlier islands and only the last stays pickable.
    if (hasId) {
      const existing = this.idMap.get(item.id)
      if (existing) {
        if (
          existing.minX === item.minX &&
          existing.minY === item.minY &&
          existing.maxX === item.maxX &&
          existing.maxY === item.maxY
        ) {
          return
        }
        this.remove(existing, (a, b) => a.id === b.id)
        this.idMap.delete(item.id)
      }
    }
    this.tree.insert(item)
    if (hasId) {
      this.idMap.set(item.id, item)
    }
  }

  load(items: readonly AcEdSpatialQueryResultItem[]) {
    const finiteItems = items.filter(isFiniteSpatialBBox)
    this.tree.load(finiteItems)
    for (const item of finiteItems) {
      if (typeof item.id === 'string' && item.id.length > 0) {
        this.idMap.set(item.id, item)
      }
    }
  }

  remove(
    item: AcEdSpatialQueryResultItem,
    equals?: (
      a: AcEdSpatialQueryResultItem,
      b: AcEdSpatialQueryResultItem
    ) => boolean
  ): void {
    this.tree.remove(
      item,
      equals ??
        ((a, b) =>
          a === b ||
          (a.id === b.id &&
            a.minX === b.minX &&
            a.minY === b.minY &&
            a.maxX === b.maxX &&
            a.maxY === b.maxY))
    )
    if (typeof item.id === 'string' && item.id.length > 0) {
      this.idMap.delete(item.id)
    }
  }

  removeById(id: AcDbObjectId): void {
    if (!(typeof id === 'string' && id.length > 0)) {
      return
    }
    this.removeIndexedById(id)
  }

  /**
   * Removes many items by id in one pass.
   *
   * @param ids Ids of previously inserted items
   */
  removeByIds(ids: readonly AcDbObjectId[]): void {
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]
      if (typeof id === 'string' && id.length > 0) {
        this.removeIndexedById(id)
      }
    }
  }

  /**
   * Removes the tree entry stored for `id` using its real bounding box.
   *
   * RBush only descends into nodes that **contain** the bbox of the item being
   * removed. Building a placeholder bbox therefore silently leaves every entry
   * stored away from that box in the tree (stale picks / growing memory), which
   * is why the indexed item is used instead.
   *
   * The id map and the tree are maintained in lockstep, so a missing id map
   * entry means there is nothing to remove.
   */
  private removeIndexedById(id: string): void {
    const item = this.idMap.get(id)
    if (!item) {
      return
    }
    // `item` is the same object reference that lives in the tree, so the
    // default identity comparison removes exactly that entry.
    this.tree.remove(item)
    this.idMap.delete(id)
  }

  /**
   * Returns the item currently indexed for {@link id}, when present.
   */
  getById(id: AcDbObjectId): AcEdSpatialQueryResultItem | undefined {
    if (!(typeof id === 'string' && id.length > 0)) {
      return undefined
    }
    return this.idMap.get(id)
  }

  clear() {
    this.tree.clear()
    this.idMap.clear()
  }

  search(
    bbox: AcTrSpatialIndexBBox,
    options?: AcTrSpatialSearchOptions
  ): AcEdSpatialQueryResultItem[] {
    const hits = this.tree.search(bbox)
    if (options?.selectionMode !== 'window') {
      return hits
    }
    return hits.filter(item => isSpatialBoxFullyInside(item, bbox))
  }

  collides(bbox: AcTrSpatialIndexBBox): boolean {
    return this.tree.collides(bbox)
  }

  all(): AcEdSpatialQueryResultItem[] {
    return this.tree.all()
  }

  getStats(): AcTrSpatialIndexStats {
    const items = this.tree.all()
    const itemCount = items.length
    const itemBytes = estimateSpatialItemsBytes(items)
    const idMapBytes = this.idMap.size * ID_MAP_ENTRY_BYTES
    return {
      kind: 'rbush',
      itemCount,
      estimatedBytes: Math.round(
        itemBytes * RBUSH_TREE_OVERHEAD_FACTOR + idMapBytes
      )
    }
  }
}
