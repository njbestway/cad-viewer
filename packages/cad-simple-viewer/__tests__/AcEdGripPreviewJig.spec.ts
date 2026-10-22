import { AcDbCircle, AcGePoint3d } from '@mlightcad/data-model'

import { AcEdGripPreviewJig } from '../src/editor/grip/AcEdGripPreviewJig'
import { AcEdBaseView } from '../src/editor/view/AcEdBaseView'

function createMockView(): AcEdBaseView {
  return {
    addTransientEntity: jest.fn(),
    removeTransientEntity: jest.fn()
  } as unknown as AcEdBaseView
}

describe('AcEdGripPreviewJig grip offsets stay in the XY plane', () => {
  // 人员定位立体图20250530.dxf handle 0x1B39: Circle center z = 31,110,344.
  // The grip base point carries the true elevation while the drag cursor
  // resolves on the z=0 view plane; a 3D subtraction used to translate the
  // entity down by the whole elevation, zeroing its Z on every grip move.
  const ELEVATION = 31_110_344.241

  it('computeOffset ignores the cursor/base elevation mismatch', () => {
    const circle = new AcDbCircle(
      new AcGePoint3d(2134.061, 1045.076, ELEVATION),
      50
    )
    const jig = new AcEdGripPreviewJig(
      createMockView(),
      circle,
      0,
      circle.center.clone()
    )

    const offset = jig.computeOffset({ x: 2234.061, y: 1245.076, z: 0 })

    expect(offset.x).toBeCloseTo(100, 6)
    expect(offset.y).toBeCloseTo(200, 6)
    expect(offset.z).toBe(0)
  })

  it('dragging the center grip moves the preview without flattening z', () => {
    const circle = new AcDbCircle(
      new AcGePoint3d(2134.061, 1045.076, ELEVATION),
      50
    )
    const jig = new AcEdGripPreviewJig(
      createMockView(),
      circle,
      0,
      circle.center.clone()
    )

    jig.update({ x: 2234.061, y: 1245.076, z: 0 })

    const preview = jig.entity as AcDbCircle
    expect(preview.center.x).toBeCloseTo(2234.061, 6)
    expect(preview.center.y).toBeCloseTo(1245.076, 6)
    expect(preview.center.z).toBeCloseTo(ELEVATION, 3)
    jig.end()
  })
})
