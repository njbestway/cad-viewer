/**
 * Register acad-rust (MPL-2.0) as the only DWG parser for this fork.
 *
 * `@mlightcad/cad-simple-viewer` registers no DWG converter by default, and the
 * GPL `@mlightcad/libredwg-converter` is intentionally not installed here.
 * DWG goes through Architecture-B native mapping (`dwg_open` -> CadDocument ->
 * sectioned JSON -> AcDbDatabase) inside the shared parser Web Worker.
 *
 * DXF deliberately keeps the built-in `AcDbNativeDxfConverter` registered by
 * {@link AcDbDatabaseConverterManager}.
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
 * Runtime guard so it is unmistakable in the console that DWG is opened with
 * acad-rust native (not `dwg -> dxf`).
 */
function assertDwgParser(manager: AcDbDatabaseConverterManager): void {
  const converter = manager.get(AcDbFileType.DWG)
  if (converter instanceof AcDbAcadRustNativeConverter) {
    log.info(
      '[acad-rust] DWG parser = AcDbAcadRustNativeConverter (native CAD->JSON->DB)'
    )
  } else {
    log.warn(
      '[acad-rust] DWG parser is NOT acad-rust native - got ' +
        `${converter?.constructor?.name ?? 'undefined'}.`
    )
  }
}
