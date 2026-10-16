import {
  AcGiMTextData,
  AcGiSubEntityTraits,
  AcGiTextStyle
} from '@mlightcad/data-model'
import { MTextData, MTextObject } from '@mlightcad/mtext-renderer'
import * as THREE from 'three'

import { AcTrMTextRenderer } from '../renderer/AcTrMTextRenderer'
import { AcTrRenderContext } from '../renderer/AcTrRenderContext'
import { resolveMTextRenderRoot } from '../util/AcTrObjectUserData'
import { AcTrGlyphEntity } from './AcTrGlyphEntity'

/**
 * Display object for a CAD MTEXT entity rendered through the mtext-renderer.
 */
export class AcTrMText extends AcTrGlyphEntity {
  /** Source MTEXT data from the CAD database. */
  private _text: AcGiMTextData

  /**
   * WCS extrusion normal when this text is authored in a plane tilted away from
   * world +Z; `undefined` for planar text (handled by the 2D path).
   */
  private _wcsNormal?: THREE.Vector3

  /** WCS reading (baseline) direction supplied directly (MTEXT `direction`). */
  private _wcsReading?: THREE.Vector3

  /** OCS rotation in radians, used to derive the reading direction (TEXT). */
  private _wcsRotation = 0

  /**
   * Creates an MTEXT display object.
   *
   * @param text MTEXT content and placement from the CAD database.
   * @param traits CAD sub-entity traits used to resolve color and layer behavior.
   * @param style Text style applied by the mtext-renderer.
   * @param context Active renderer context that owns style and batching policy.
   * @param delay When `true`, skips the initial draw so callers can finish setup first.
   */
  constructor(
    text: AcGiMTextData,
    traits: AcGiSubEntityTraits,
    style: AcGiTextStyle,
    context: AcTrRenderContext,
    _delay: boolean = false
  ) {
    super(context, traits, { ...style })
    this._text = text
    // Geometry is built by syncDraw/asyncDraw in AcTrView2d / AcTrGroup so
    // font-awaiting asyncDraw can run without blocking other entity converts.
  }

  /**
   * Supplies the source entity's extrusion normal (and either an explicit WCS
   * reading direction for MTEXT or the OCS rotation for TEXT) so the planar
   * mtext-renderer result can be re-oriented into its true 3D plane.
   *
   * The data-model flattens text extrusion to a 2D plan-view rotation
   * (`AcDbText.extrusionDrawingAdjust`) and the shared renderer only ever applies
   * a `setFromAxisAngle(+Z, …)`, so the out-of-plane tilt is lost unless restored
   * here. Axis-aligned extrusions (normal parallel to Z, including the (0,0,-1)
   * mirror the 2D path already handles) are ignored.
   *
   * @param normal Extrusion / plane normal (DXF group 210).
   * @param rotation OCS rotation in radians (used only when `reading` is absent).
   * @param reading Optional WCS reading (baseline) direction (MTEXT group 11).
   */
  setWorldOrientation(
    normal: { x: number; y: number; z: number },
    rotation: number,
    reading?: { x: number; y: number; z: number }
  ) {
    const n = new THREE.Vector3(normal.x, normal.y, normal.z)
    if (n.lengthSq() < 1e-12) return
    n.normalize()
    // Normal parallel to world Z → planar (or the -Z mirror the 2D path already
    // handles); there is no 3D tilt to restore.
    if (Math.abs(n.x) < 1e-6 && Math.abs(n.y) < 1e-6) return
    this._wcsNormal = n
    this._wcsRotation = Number.isFinite(rotation) ? rotation : 0
    if (reading) {
      const r = new THREE.Vector3(reading.x, reading.y, reading.z)
      if (r.lengthSq() > 1e-12) this._wcsReading = r.normalize()
    }
  }

  /**
   * Builds the mtext-renderer payload.
   *
   * The insertion Z is always flattened to 0. This is the *primary* strategy
   * for text elevation and it matches the whole plan renderer, which lives on
   * the z = 0 plane: hatch and linework batches (circles, polylines, lines with
   * no per-vertex z) also sit at z = 0 and stack via `renderOrder`, not the
   * depth buffer. Keeping a real elevation here (some anchors resolve to
   * z ~ 3.1e7 after the data-model's OCS->WCS transform) would be the lone
   * entity family relying on a wide orthographic depth window, which dilutes
   * the 24-bit depth buffer for everyone; `AcTrView2d.syncDepthRangeToScene`
   * stays a fallback net for genuinely 3D content instead. The plan position
   * (x, y) already matches the projected linework, so a z = 0 anchor keeps text
   * where the flat path placed it.
   *
   * Tilted text still needs the true 3D orientation, so we drop `directionVector`
   * (the renderer would only fold it into an in-plane Z rotation) and let
   * {@link applyWorldOrientation} tilt the flattened result about the anchor.
   *
   * @returns MTEXT payload suitable for the mtext-renderer.
   */
  private toPlanViewMTextData(): MTextData {
    const source = this._text as MTextData
    const position = source.position
    const flat = { x: position.x, y: position.y, z: 0 }
    if (this._wcsNormal) {
      const { directionVector: _omit, ...rest } = source as MTextData & {
        directionVector?: unknown
      }
      return { ...rest, position: flat } as MTextData
    }
    return { ...source, position: flat }
  }

  /**
   * Overrides the renderer's planar placement quaternion with the text's true
   * 3D orientation `[reading, up, normal]`. No-op for planar text so the shared
   * 2D path is untouched. The arbitrary-axis basis matches
   * `AcGeMatrix3d.setFromExtrusionDirection` so the reading direction lines up
   * with the anchor the data-model already projected.
   */
  private applyWorldOrientation(rendered: MTextObject) {
    const n = this._wcsNormal
    if (!n) return
    let e1 = this._wcsReading
    if (!e1) {
      const xAxis =
        Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64
          ? new THREE.Vector3(0, 1, 0).cross(n)
          : new THREE.Vector3(0, 0, 1).cross(n)
      xAxis.normalize()
      const yAxis = new THREE.Vector3().crossVectors(n, xAxis)
      e1 = xAxis
        .multiplyScalar(Math.cos(this._wcsRotation))
        .addScaledVector(yAxis, Math.sin(this._wcsRotation))
        .normalize()
    }
    const e2 = new THREE.Vector3().crossVectors(n, e1).normalize()
    const basis = new THREE.Matrix4().makeBasis(e1, e2, n)
    // The anchor lives on the renderer's inner placement group; the sync path
    // wraps that group under an `MText` node whose own origin is world (0, 0, 0)
    // (see {@link resolveMTextRenderRoot}). The tilt must be applied to the
    // placement root so it rotates *about* the anchor. Rotating the wrapper
    // instead swings the anchor-offset child around the world origin and
    // translates the text far away.
    const placementRoot = resolveMTextRenderRoot(rendered)
    placementRoot.quaternion.setFromRotationMatrix(basis)
    placementRoot.updateMatrix()
    placementRoot.updateMatrixWorld(true)
  }

  /**
   * Key for sharing mesh buffers across identical complex-linetype TEXT labels.
   * Placement is applied via this object's transform, not baked into the key.
   *
   * Deliberately keyed on glyph *shape* inputs only (content, height, font,
   * width factors). Position, in-plane rotation, and the true-3D orientation
   * (`_wcsNormal` / `_wcsReading` / `_wcsRotation`, applied by
   * {@link applyWorldOrientation}) are all transforms, so two labels that share
   * the key but differ in placement or tilt still render correctly from one
   * shared buffer — the orientation must NOT enter this key or sharing would
   * break for tilted duplicates.
   */
  get linetypeGlyphShareKey(): string {
    return [
      this._text.text,
      this._text.height,
      this._style.font ?? '',
      this._style.extendedFont ?? '',
      this._style.widthFactor ?? 1,
      this._text.widthFactor ?? 1
    ].join('\0')
  }

  /** @inheritdoc */
  protected override contentShareKey(): string {
    return this.linetypeGlyphShareKey
  }

  /**
   * @inheritdoc
   */
  protected override getDrawPosition() {
    // Complex-linetype labels store WCS placement on this.position.
    const textPos = this._text.position
    if (
      textPos &&
      textPos.x === 0 &&
      textPos.y === 0 &&
      textPos.z === 0 &&
      (this.position.x !== 0 || this.position.y !== 0 || this.position.z !== 0)
    ) {
      return {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z
      }
    }
    return textPos
  }

  /**
   * Annotative MTEXT must stay unbatched so paper-space viewports can rescale
   * individual drawables for the active annotation scale.
   */
  override resolveDrawMode() {
    if ((this.userData as { annotationScale?: unknown }).annotationScale) {
      return 'unbatch'
    }
    return super.resolveDrawMode()
  }

  /**
   * @inheritdoc
   */
  protected override renderSync(renderer: AcTrMTextRenderer) {
    const rendered = renderer.syncRenderMText(
      this.toPlanViewMTextData(),
      this._style,
      this._colorSettings
    )
    this.applyWorldOrientation(rendered)
    return rendered
  }

  /**
   * @inheritdoc
   */
  protected override async renderAsync(renderer: AcTrMTextRenderer) {
    const rendered = await renderer.asyncRenderMText(
      this.toPlanViewMTextData(),
      this._style,
      this._colorSettings
    )
    this.applyWorldOrientation(rendered)
    return rendered
  }

  /**
   * Copies annotation-scale metadata onto the rendered glyph root so it
   * survives unbatched cloning into the scene graph.
   */
  protected override attachRendered(rendered: MTextObject) {
    super.attachRendered(rendered)
    const annotationScale = (
      this.userData as { annotationScale?: unknown }
    ).annotationScale
    if (!annotationScale) return
    const root = resolveMTextRenderRoot(rendered)
    ;(root.userData as { annotationScale?: unknown }).annotationScale =
      annotationScale
  }

  /**
   * @inheritdoc
   */
  protected override describeRenderFailure() {
    return `mtext '${this._text.text}'`
  }

  /**
   * Preserves MTEXT payload across INSERT template clones.
   *
   * {@link AcTrEntity.fastDeepClone} would otherwise create a plain
   * {@link AcTrEntity} shell that can no longer {@link asyncDraw} glyphs.
   */
  override fastDeepClone(shareGeometry: boolean = false) {
    const cloned = new AcTrMText(
      {
        ...this._text,
        position: { ...this._text.position }
      },
      this.traitsForClone(),
      { ...this._style },
      this.renderContext
    )
    cloned.copyGlyphIdentity(this)
    cloned._wcsNormal = this._wcsNormal?.clone()
    cloned._wcsReading = this._wcsReading?.clone()
    cloned._wcsRotation = this._wcsRotation
    this.copyGeometry(this, cloned, shareGeometry)
    return cloned
  }
}
