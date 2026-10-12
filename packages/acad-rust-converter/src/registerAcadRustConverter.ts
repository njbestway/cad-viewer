import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'

import {
  AcDbAcadRustConverter,
  type AcDbAcadRustConverterConfig
} from './AcDbAcadRustConverter'

/**
 * Build an acad-rust DWG converter without registering it. Use when you want to
 * register it yourself (e.g. under a different {@link AcDbFileType}) or keep it
 * for direct `read()` calls.
 */
export function createAcadRustConverter(
  config?: AcDbAcadRustConverterConfig
): AcDbAcadRustConverter {
  return new AcDbAcadRustConverter(config)
}

/**
 * Build an acad-rust DWG converter and register it for
 * {@link AcDbFileType.DWG} — collapsing the per-host `new` + `register`
 * boilerplate into a single call.
 *
 * ```ts
 * // Copy the assets into ./workers, then one line wires up DWG support:
 * registerAcadRustConverter({ assetBaseUrl: './workers/' })
 *
 * // Or, when a Worker cannot be used (CSP / no-worker hosts):
 * registerAcadRustConverter({ assetBaseUrl: './workers/', useWorker: false })
 * ```
 *
 * @returns the registered converter (also reachable via the manager).
 */
export function registerAcadRustConverter(
  config?: AcDbAcadRustConverterConfig
): AcDbAcadRustConverter {
  const converter = new AcDbAcadRustConverter(config)
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, converter)
  return converter
}
