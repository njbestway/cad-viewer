/**
 * Opt into copyleft-free DWG parsing (acadrust / MPL-2.0) for this example app.
 * `@mlightcad/cad-simple-viewer` / `@mlightcad/cad-viewer` do not register a
 * DWG converter by default.
 *
 * DWG: Architecture-B native mapping (`dwg_open` -> CadDocument -> sectioned
 * JSON -> AcDbDatabase) — NOT the `dwg -> dxf -> database` round trip — run
 * through the acadrust WASM inside the shared parser Web Worker.
 *
 * DXF deliberately keeps the built-in `AcDbNativeDxfConverter` registered by
 * {@link AcDbDatabaseConverterManager}. The acad-rust DXF reader
 * (`inputFormat: 'dxf'`) stays available for ad-hoc verification — re-register
 * it over `AcDbFileType.DXF` if needed.
 */
import {
  AcDbDatabaseConverterManager,
  AcDbFileType,
  log
} from '@mlightcad/data-model'
import { AcDbAcadRustNativeConverter } from '@njbestway/acad-rust-converter'

export function registerAcadRustConverter(parserWorkerUrl: string): void {
  const manager = AcDbDatabaseConverterManager.instance

  // Only DWG is overridden. Accessing `.instance` above has already registered
  // the built-in DXF converter (`AcDbNativeDxfConverter`), which stays active.
  manager.register(
    AcDbFileType.DWG,
    new AcDbAcadRustNativeConverter({ useWorker: true, parserWorkerUrl })
  )

  assertDwgParser(manager)
}

/**
 * Runtime guard so it is unmistakable in the console that DWG is open with
 * acad-rust native (not `dwg -> dxf`). Warns loudly if the DWG slot was
 * overwritten by a non-acad-rust converter.
 */
function assertDwgParser(manager: AcDbDatabaseConverterManager): void {
  const converter = manager.get(AcDbFileType.DWG)
  if (converter instanceof AcDbAcadRustNativeConverter) {
    log.info(
      '[acad-rust] DWG parser = AcDbAcadRustNativeConverter (native CAD->JSON->DB)'
    )
  } else {
    log.warn(
      '[acad-rust] DWG parser is NOT acad-rust native — got ' +
        `${converter?.constructor?.name ?? 'undefined'}. The example must open ` +
        'DWG through acad-rust.'
    )
  }
}
