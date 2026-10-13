/**
 * Force this example to parse BOTH DXF and DWG with the acad-rust library
 * (MPL-2.0), so the editor reflects acad-rust's real behavior end to end.
 *
 * - DWG: Architecture-B native mapping (`dwg_open` -> CadDocument -> sectioned
 *   JSON -> AcDbDatabase) — NOT the `dwg -> dxf -> database` round trip.
 * - DXF: the same Architecture-B native reader fed DXF bytes
 *   (`dxf_open` -> CadDocument -> JSON -> AcDbDatabase) via `inputFormat: 'dxf'`.
 *   This REPLACES the `AcDbNativeDxfConverter` that
 *   {@link AcDbDatabaseConverterManager} registers for DXF by default (register
 *   is a Map.set override), so the built-in DXF parser is not used.
 *
 * Both run the acadrust WASM inside the shared parser Web Worker.
 */
import { AcDbAcadRustNativeConverter } from '@mlightcad/acad-rust-converter'
import {
  AcDbDatabaseConverterManager,
  AcDbFileType,
  log
} from '@mlightcad/data-model'

export function registerAcadRustConverter(parserWorkerUrl: string): void {
  const manager = AcDbDatabaseConverterManager.instance

  // Accessing `.instance` above already registered the built-in DXF converter;
  // re-registering DXF below overrides it with the acad-rust native reader.
  manager.register(
    AcDbFileType.DWG,
    new AcDbAcadRustNativeConverter({ useWorker: true, parserWorkerUrl })
  )
  manager.register(
    AcDbFileType.DXF,
    new AcDbAcadRustNativeConverter({
      useWorker: true,
      parserWorkerUrl,
      inputFormat: 'dxf'
    })
  )

  assertAcadRustParsers(manager)
}

/**
 * Runtime guard so it is unmistakable in the console that the example is open
 * with acad-rust (not the built-in DXF, not `dwg -> dxf`) for both formats.
 * Warns loudly if any slot was overwritten by a non-acad-rust converter.
 */
function assertAcadRustParsers(manager: AcDbDatabaseConverterManager): void {
  for (const fileType of [AcDbFileType.DWG, AcDbFileType.DXF] as const) {
    const converter = manager.get(fileType)
    if (converter instanceof AcDbAcadRustNativeConverter) {
      log.info(
        `[acad-rust] ${fileType.toUpperCase()} parser = AcDbAcadRustNativeConverter (native CAD->JSON->DB)`
      )
    } else {
      log.warn(
        `[acad-rust] ${fileType.toUpperCase()} parser is NOT acad-rust native — got ` +
          `${converter?.constructor?.name ?? 'undefined'}. The example must open ` +
          `${fileType.toUpperCase()} through acad-rust.`
      )
    }
  }
}
