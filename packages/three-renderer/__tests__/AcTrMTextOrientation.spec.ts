import * as THREE from 'three'

import { AcTrMText } from '../src/object/AcTrMText'

/**
 * White-box access to the private orientation fields / method without building a
 * full display object (which needs a render context, style and traits).
 */
interface OrientationTestApi {
  setWorldOrientation(
    normal: { x: number; y: number; z: number },
    rotation: number,
    reading?: { x: number; y: number; z: number }
  ): void
  applyWorldOrientation(rendered: THREE.Object3D): void
  _wcsNormal?: THREE.Vector3
  _wcsReading?: THREE.Vector3
  _wcsRotation: number
}

function newMText(): OrientationTestApi {
  return Object.create(AcTrMText.prototype) as OrientationTestApi
}

/**
 * Mirrors the sync renderer output: an `MText` wrapper whose single child is the
 * placement root that actually carries the anchor. `applyWorldOrientation` must
 * tilt the *child*, never the wrapper (tilting the wrapper swings the anchor
 * around the world origin and translates the text far away).
 */
function fakeRendered(): { wrapper: THREE.Object3D; root: THREE.Object3D } {
  const wrapper = new THREE.Group()
  const root = new THREE.Group()
  wrapper.add(root)
  return { wrapper, root }
}

const IDENTITY = new THREE.Quaternion()

describe('AcTrMText.setWorldOrientation', () => {
  it('ignores planar extrusions (normal parallel to world Z)', () => {
    const up = newMText()
    up.setWorldOrientation({ x: 0, y: 0, z: 1 }, 0.5)
    // Early return fires before any field is written (no 3D tilt to restore).
    expect(up._wcsNormal).toBeUndefined()

    // The (0,0,-1) mirror is already handled by the 2D path.
    const down = newMText()
    down.setWorldOrientation({ x: 0, y: 0, z: -1 }, 0.5)
    expect(down._wcsNormal).toBeUndefined()
  })

  it('ignores degenerate normals', () => {
    const text = newMText()
    text.setWorldOrientation({ x: 0, y: 0, z: 0 }, 0.5)
    expect(text._wcsNormal).toBeUndefined()
  })

  it('records a tilted normal, rotation and reading direction', () => {
    const text = newMText()
    text.setWorldOrientation({ x: 1, y: 0, z: 0 }, 0.7, { x: 0, y: 1, z: 0 })
    expect(text._wcsNormal).toEqual(new THREE.Vector3(1, 0, 0))
    expect(text._wcsRotation).toBe(0.7)
    expect(text._wcsReading).toEqual(new THREE.Vector3(0, 1, 0))
  })
})

describe('AcTrMText.applyWorldOrientation', () => {
  it('is a no-op for planar text (wrapper and root both stay identity)', () => {
    const text = newMText()
    text.setWorldOrientation({ x: 0, y: 0, z: 1 }, 0)
    const { wrapper, root } = fakeRendered()

    text.applyWorldOrientation(wrapper)

    expect(wrapper.quaternion.equals(IDENTITY)).toBe(true)
    expect(root.quaternion.equals(IDENTITY)).toBe(true)
  })

  it('tilts the placement root (not the wrapper) into the true 3D plane', () => {
    // Normal along +X with no explicit reading and zero OCS rotation resolves to
    // the arbitrary-axis basis [e1=(0,1,0), e2=(0,0,1), n=(1,0,0)] — the same
    // basis the data-model uses, so the reading direction lines up.
    const text = newMText()
    text.setWorldOrientation({ x: 1, y: 0, z: 0 }, 0)

    const expected = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0)
      )
    )

    const { wrapper, root } = fakeRendered()
    text.applyWorldOrientation(wrapper)

    // The pitfall guard: orientation must land on the placement root.
    expect(root.quaternion.angleTo(expected)).toBeLessThan(1e-6)
    expect(wrapper.quaternion.equals(IDENTITY)).toBe(true)
  })

  it('honors an explicit reading direction over the derived basis', () => {
    const text = newMText()
    // Tilted plane normal +X, reading supplied directly along world +Y.
    text.setWorldOrientation({ x: 1, y: 0, z: 0 }, 0, { x: 0, y: 1, z: 0 })

    const expected = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 1, 0), // e1 == reading
        new THREE.Vector3(0, 0, 1), // e2 == n x reading
        new THREE.Vector3(1, 0, 0) // n
      )
    )

    const { wrapper, root } = fakeRendered()
    text.applyWorldOrientation(wrapper)

    expect(root.quaternion.angleTo(expected)).toBeLessThan(1e-6)
    expect(wrapper.quaternion.equals(IDENTITY)).toBe(true)
  })
})
