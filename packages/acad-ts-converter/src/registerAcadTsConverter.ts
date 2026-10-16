import { AcDbDatabaseConverterManager, AcDbFileType } from '@mlightcad/data-model'

import { AcDbAcadTsConverter } from './AcDbAcadTsConverter'

/**
 * Register the acad-ts based converter as this app's DWG parser. Pure
 * TypeScript (no worker / no WASM) — acad-ts parses the DWG on the calling
 * thread, so no asset URLs are required. Re-registering replaces any prior DWG
 * converter in the slot (last writer wins), which is how the example swaps this
 * experimental parser in for A/B verification against acad-rust / LibreDWG.
 */
export function registerAcadTsConverter(): void {
  const converter = new AcDbAcadTsConverter({ useWorker: false })
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, converter)
}
