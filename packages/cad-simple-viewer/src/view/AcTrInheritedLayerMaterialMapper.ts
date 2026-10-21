import { AcGiSubEntityTraits } from '@mlightcad/data-model'
import {
  AcTrRenderer,
  getMaterialMetadata,
  getSceneDrawableUserData,
  hasByLayerBinding,
  setMaterialMetadata,
  syncStyleMaterialIdFromMaterials
} from '@mlightcad/three-renderer'
import * as THREE from 'three'

/**
 * Remaps layer metadata and material bindings when block contents inherit an INSERT layer.
 *
 * AutoCAD requires entities authored on layer "0" inside a block to inherit the INSERT's
 * layer for ByLayer traits. This mapper mutates drawable `userData.layerName` and rebinds
 * materials via the renderer style cache so subsequent layer-level style edits target the
 * correct material instances.
 */
export class AcTrInheritedLayerMaterialMapper {
  /**
   * @param getLayerTraits - Resolves live layer-table traits for an effective layer name.
   * @param renderer - Renderer used to rebind materials through the style cache.
   */
  constructor(
    private readonly getLayerTraits: (
      layerName: string
    ) => Partial<AcGiSubEntityTraits> | undefined,
    private readonly renderer: AcTrRenderer
  ) {}

  /**
   * Remaps materials for objects in a layer bucket after INSERT decomposition.
   *
   * @param objects - Root objects in the current layer bucket to traverse and remap.
   * @param sourceLayerName - Layer name found in the block definition before inheritance.
   * @param effectiveLayerName - Final layer name used by rendering and style updates.
   */
  remap(
    objects: THREE.Object3D[],
    sourceLayerName: string,
    effectiveLayerName: string
  ): void {
    if (sourceLayerName === effectiveLayerName) {
      return
    }

    const layerTraits = this.getLayerTraits(effectiveLayerName)

    const remapNodeMaterial = (node: THREE.Object3D) => {
      const drawable = node as THREE.Object3D & {
        material?: THREE.Material | THREE.Material[]
      }
      const material = drawable.material
      if (!material) {
        return
      }
      if (Array.isArray(material)) {
        const materials = material as THREE.Material[]
        drawable.material = materials.map(entry => {
          if (!this.shouldRemap(entry, sourceLayerName)) {
            return entry
          }
          return (
            this.renderer.getLayerBoundMaterial(
              this.promoteLayerZeroByLayerColor(entry, sourceLayerName),
              effectiveLayerName,
              layerTraits
            ) ?? entry
          )
        })
        syncStyleMaterialIdFromMaterials(
          getSceneDrawableUserData(node),
          drawable.material as THREE.Material[]
        )
        return
      }
      if (!this.shouldRemap(material as THREE.Material, sourceLayerName)) {
        return
      }

      const remappedMaterial = this.renderer.getLayerBoundMaterial(
        this.promoteLayerZeroByLayerColor(
          material as THREE.Material,
          sourceLayerName
        ),
        effectiveLayerName,
        layerTraits
      )
      if (!remappedMaterial) {
        return
      }
      drawable.material = remappedMaterial
      syncStyleMaterialIdFromMaterials(
        getSceneDrawableUserData(node),
        remappedMaterial
      )
    }

    // Coalesced block lines and instanced drawables are emitted as leaves that
    // carry no userData.layerName of their own; their layer is only propagated
    // from the enclosing shell during flatten, which runs after remap. Walk with
    // the nearest authored layer so those layer-0 leaves still inherit the INSERT
    // layer (colour and scene-layer bucketing) on the first render.
    const walk = (
      node: THREE.Object3D,
      inheritedLayerName: string | undefined
    ) => {
      const ownLayerName = node.userData.layerName as string | undefined
      const sourceLayer = ownLayerName ?? inheritedLayerName
      // Only layer-"0" (or the current source bucket) inherits INSERT traits.
      // Attributes/text on other layers must keep their own layer materials.
      if (sourceLayer === sourceLayerName) {
        node.userData.layerName = effectiveLayerName
        remapNodeMaterial(node)
      }
      for (const child of node.children) {
        walk(child, sourceLayer)
      }
    }

    for (const object of objects) {
      walk(object, undefined)
    }
  }

  /**
   * Layer-0 block contents with ByLayer color resolve to ACI-7 foreground materials before
   * INSERT remapping. Those materials must still inherit the INSERT layer when their colour
   * is layer-bound, while explicit ACI-7 entities on layer 0 stay untouched.
   *
   * @param material - Candidate material to evaluate for INSERT-layer rebinding.
   * @param sourceLayerName - Layer name from the block definition before inheritance.
   * @returns True when the material should be rebound to the INSERT layer.
   */
  private shouldRemap(
    material: THREE.Material,
    sourceLayerName: string
  ): boolean {
    const metadata = getMaterialMetadata(material)
    if (metadata.isForeground !== true) {
      return true
    }
    if (sourceLayerName !== '0') {
      return false
    }
    if (metadata.isByLayerColor === true) {
      return true
    }
    return (
      sourceLayerName === '0' &&
      (metadata.isByLayerLineType === true ||
        metadata.isByLayerLineWeight === true ||
        metadata.isByLayerTransparency === true)
    )
  }

  /**
   * Some DXF conversion paths lose `isByLayerColor` on layer-0 block contents while still
   * retaining other ByLayer markers (lineType/lineWeight/transparency). For AutoCAD-compatible
   * INSERT inheritance, treat such colours as inheritable when remapping from layer "0".
   *
   * That repair is only for the ByLayer→ACI-7 (foreground) case. Explicit absolute colours
   * (`isByLayerColor === false` and not foreground) must never be promoted — otherwise a
   * solid hatch with ACI 251 on layer 0 inherits the INSERT layer colour (often ACI 7 white)
   * and legend headers / non-ByLayer fills wash out.
   *
   * @param material - Material whose ByLayer metadata may need normalization.
   * @param sourceLayerName - Source bucket layer name (typically `"0"`).
   * @returns The same material instance, possibly with patched metadata.
   */
  private promoteLayerZeroByLayerColor(
    material: THREE.Material,
    sourceLayerName: string
  ): THREE.Material {
    const metadata = getMaterialMetadata(material)
    if (metadata.isByLayerColor === false && metadata.isForeground !== true) {
      return material
    }
    const hasAnyOtherByLayerBinding =
      hasByLayerBinding(metadata) && metadata.isByLayerColor !== true

    if (sourceLayerName === '0' && hasAnyOtherByLayerBinding) {
      setMaterialMetadata(material, { isByLayerColor: true })
    }
    return material
  }
}
