import {
  AcDbEntity,
  AcGePoint3d,
  AcGePoint3dLike,
  AcGeVector3d
} from '@mlightcad/data-model'

import { AcEdPreviewJig } from '../input/AcEdPreviewJig'
import { AcEdBaseView } from '../view/AcEdBaseView'

/**
 * Preview jig that applies {@link AcDbEntity.subMoveGripPointsAt} on a clone
 * while the user drags a grip handle.
 */
export class AcEdGripPreviewJig extends AcEdPreviewJig<AcGePoint3dLike> {
  private readonly _view: AcEdBaseView
  private readonly _sourceClone: AcDbEntity
  private readonly _gripIndex: number
  private readonly _gripBaseWcs: AcGePoint3d
  private _previewEntity: AcDbEntity | null = null

  constructor(
    view: AcEdBaseView,
    entity: AcDbEntity,
    gripIndex: number,
    gripBaseWcs: AcGePoint3dLike
  ) {
    super(view)
    this._view = view
    const sourceClone = entity.clone()
    if (!sourceClone) {
      throw new Error('Failed to clone entity for grip preview.')
    }
    this._sourceClone = sourceClone
    this._gripIndex = gripIndex
    this._gripBaseWcs = new AcGePoint3d(gripBaseWcs)
  }

  get entity(): AcDbEntity | null {
    return this._previewEntity
  }

  update(point: AcGePoint3dLike) {
    if (this._previewEntity) {
      this._view.removeTransientEntity(this._previewEntity.objectId)
      this._previewEntity = null
    }

    const preview = this._sourceClone.clone()
    if (!preview) return

    preview.subMoveGripPointsAt([this._gripIndex], this.computeOffset(point))
    this._previewEntity = preview
  }

  computeOffset(point: AcGePoint3dLike): AcGeVector3d {
    // The drag cursor resolves on the z=0 view plane (see
    // `AcEdGripEditSession.resolveWcs`), while the grip base keeps the
    // entity's true elevation. Subtracting them in 3D would inject a bogus
    // Z delta — dragging an elevated circle's center grip (z = 31,110,344)
    // to empty space would translate the entity by -31,110,344 and flatten
    // its Z to 0 (and would inflate quadrant-grip radii via the 3D
    // distance-to-center). This view is strictly 2D (orthographic, plan
    // only), so grip stretch is an XY-plane operation, matching the point
    // prompt layer which also pins z to 0; entity elevation is preserved.
    return new AcGeVector3d(
      point.x - this._gripBaseWcs.x,
      point.y - this._gripBaseWcs.y,
      0
    )
  }

  override render(): void {
    if (this._previewEntity) {
      this._view.addTransientEntity(this._previewEntity)
    }
  }

  override end(): void {
    if (this._previewEntity) {
      this._view.removeTransientEntity(this._previewEntity.objectId)
      this._previewEntity = null
    }
  }
}
