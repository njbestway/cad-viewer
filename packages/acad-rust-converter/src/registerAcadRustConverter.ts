import {
  type AcDbDatabase,
  AcDbDatabaseConverter,
  AcDbDatabaseConverterManager,
  type AcDbDatabaseConverterReadOptions,
  AcDbFileType} from '@mlightcad/data-model'

import {
  AcDbAcadRustConverter,
  type AcDbAcadRustConverterConfig
} from './AcDbAcadRustConverter'
import { AcDbAcadRustNativeConverter } from './AcDbAcadRustNativeConverter'

/**
 * A DWG converter produced by {@link createAcadRustConverter} /
 * {@link registerAcadRustConverter}: the data-model {@link AcDbDatabaseConverter}
 * surface plus a {@link dispose} hook that releases the underlying WASM worker(s)
 * and their linear-memory heap. The base `AcDbDatabaseConverter` class has no
 * teardown method, so this intersection is what makes disposal reachable to
 * hosts that create one converter per document.
 */
export type AcadRustConverter = AcDbDatabaseConverter<null> & {
  /** Terminate the cached WASM worker(s); safe to call more than once. */
  dispose(): void
}

/**
 * Build an acad-rust DWG converter without registering it. Use when you want to
 * register it yourself (e.g. under a different {@link AcDbFileType}) or keep it
 * for direct `read()` calls.
 *
 * `architecture` picks the DWG path:
 *   * `'dxf'` (default) — {@link AcDbAcadRustConverter} (Architecture A: acadrust
 *     `dwg_to_dxf` + the MIT native DXF converter).
 *   * `'native'` — {@link AcDbAcadRustNativeConverter} (Architecture B: acadrust
 *     `CadDocument` section mapping), wrapped so that a native open/section
 *     failure transparently retries through Architecture A.
 */
export function createAcadRustConverter(
  config?: AcDbAcadRustConverterConfig
): AcadRustConverter {
  if (config?.architecture === 'native') {
    return new AcDbAcadRustNativeWithFallback(config)
  }
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
 *
 * // Opt into the Architecture-B sectioned path (Slice 0: header + tables):
 * registerAcadRustConverter({ assetBaseUrl: './workers/', architecture: 'native' })
 * ```
 *
 * @returns the registered converter (also reachable via the manager).
 */
export function registerAcadRustConverter(
  config?: AcDbAcadRustConverterConfig
): AcadRustConverter {
  const converter = createAcadRustConverter(config)
  AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, converter)
  return converter
}

/**
 * Architecture-B converter with a fallback to Architecture A.
 *
 * Slice 0's native path only populates header + symbol tables and can fail on a
 * DWG the sectioned reader cannot service (an unsupported version, or a section
 * serde the pinned acadrust build rejects). Rather than surface that as an open
 * failure, retry the same bytes through Architecture A (`dwg_to_dxf` + the MIT
 * DXF converter). Because Slice 0's native mapping writes only named table
 * records (re-added by name on retry, not duplicated per entity) and header
 * scalars (idempotent), re-running A on the partially-written `db` stays safe.
 *
 * @internal Exported only for tests; hosts should go through
 * {@link createAcadRustConverter} / {@link registerAcadRustConverter}.
 */
export class AcDbAcadRustNativeWithFallback extends AcDbDatabaseConverter<null> {
  private readonly native: AcDbAcadRustNativeConverter
  private readonly fallback: AcDbAcadRustConverter

  constructor(config?: AcDbAcadRustConverterConfig) {
    super(config)
    this.native = new AcDbAcadRustNativeConverter(config)
    // The fallback must always be Architecture A (`dxf`), never re-enter native.
    this.fallback = new AcDbAcadRustConverter({ ...config, architecture: 'dxf' })
  }

  async read(
    data: ArrayBuffer,
    db: AcDbDatabase,
    options?: AcDbDatabaseConverterReadOptions
  ): Promise<void> {
    try {
      await this.native.read(data, db, options)
    } catch (nativeError) {
      // Hand the bar back to a clean slate for the retried pass, then run A.
      await this.fallback.read(data, db, options).catch(() => {
        // If A also fails, surface the original native error (more specific to
        // why the sectioned path was chosen); otherwise the A error wins below.
        throw nativeError
      })
    }
  }

  /**
   * Release both wrapped converters — the native sectioned client and the
   * Architecture-A fallback each own a WASM worker — so a host that built one
   * converter per document fully tears down the workers + wasm heaps.
   */
  dispose(): void {
    this.native.dispose()
    this.fallback.dispose()
  }
}
