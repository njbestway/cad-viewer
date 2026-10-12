/**
 * Opt into copyleft-free DWG parsing (acadrust / MPL-2.0) for this example app.
 * `@mlightcad/cad-simple-viewer` / `@mlightcad/cad-viewer` do not register a
 * DWG converter by default.
 */
import { AcDbAcadRustConverter } from '@mlightcad/acad-rust-converter'
import {
  AcDbDatabaseConverterManager,
  AcDbFileType
} from '@mlightcad/data-model'

export function registerAcadRustConverter(parserWorkerUrl: string): void {
  const converter = new AcDbAcadRustConverter({
    useWorker: true,
    parserWorkerUrl
  })
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, converter)
}
