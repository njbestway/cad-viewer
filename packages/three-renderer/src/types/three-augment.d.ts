import type { MaterialEventMap } from 'three'

/**
 * `@types/three` 0.186 no longer declares `Material.id`, although three.js
 * still assigns it (read-only, non-enumerable) in the `Material` constructor
 * and the renderer relies on it as the program cache key. CAD batching code
 * has always used it to deduplicate style materials, so restore the runtime
 * guarantee in the type surface.
 *
 * Remove this augmentation once `@types/three` ships the property again.
 */
declare module 'three' {
  // The type parameter list must match the original declaration exactly for
  // interface merging; it is intentionally unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Material<TEventMap extends MaterialEventMap = MaterialEventMap> {
    readonly id: number
  }
}
