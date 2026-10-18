import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { SourceMap } from 'rollup'
import type { Plugin } from 'vite'

/** Trailing `//# sourceMappingURL=<url>` banner that `tsc` appends. */
const SOURCE_MAP_BANNER = /\/\/# sourceMappingURL=(\S+)[ \t\r\n]*$/

/** Only output names that `tsc` had to URL-encode can hit this bug. */
const BRACKETED_FILE_NAME = /[[\]]/

/**
 * Decode the `sourceMappingURL` banner that `tsc` emits URL-encoded when an
 * output file name contains characters such as `[` / `]`.
 *
 * Example (acad-ts): `dist/IO/Templates/CadTemplate[T].js` ends with
 * `//# sourceMappingURL=CadTemplate%5BT%5D.js.map`, but the map on disk is
 * still named `CadTemplate[T].js.map`. Vite resolves the banner with
 * `path.resolve` (no URL decoding), misses the file and warns:
 *
 *   Failed to load source map for .../CadTemplate[T].js
 *   ENOENT: .../CadTemplate%5BT%5D.js.map
 *
 * Handling the file in `load` decodes the banner before Vite's own
 * `extractSourcemapFromFile` runs, so the map stays attached instead of
 * being dropped.
 */
export function fixEncodedSourceMapUrl(): Plugin {
  return {
    name: 'mlightcad:fix-encoded-sourcemap-url',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.js') || !BRACKETED_FILE_NAME.test(id)) {
        return null
      }
      const code = await readFile(id, 'utf-8')
      const banner = code.match(SOURCE_MAP_BANNER)
      if (!banner || !banner[1].includes('%5B')) {
        return null
      }

      let mapPath: string
      try {
        mapPath = resolve(dirname(id), decodeURIComponent(banner[1]))
      } catch {
        return null
      }

      let map: SourceMap | null = null
      if (existsSync(mapPath)) {
        try {
          map = JSON.parse(await readFile(mapPath, 'utf-8')) as SourceMap
        } catch {
          map = null
        }
      }
      return {
        code: code.slice(0, banner.index).trimEnd(),
        map
      }
    }
  }
}
