import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import { defineConfig, type PluginOption } from 'vite'

const packageId = 'acad-rust-converter'

/**
 * Rolls the `{packageId}` library entry name for a given output format.
 * Inlined here (previously imported from the cad-viewer monorepo's
 * `packages/vite-config`) so this package is self-contained in its own repo.
 */
function createLibEntryFileName(
  pkgId: string,
  format: string,
  entryName = 'index'
): string {
  const base = entryName === 'register' ? `${pkgId}-register` : pkgId
  return format === 'es' ? `${base}.js` : `${base}.umd.cjs`
}

/**
 * Main library bundle: the public converter API (`src/index.ts`).
 *
 * Emits `dist/acad-rust-converter.js` (ESM) + `dist/acad-rust-converter.umd.cjs`
 * (CJS). The WASM worker is built separately by `vite.config.worker.ts` so the
 * (larger) parser glue never lands in the main entry chunk.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      name: packageId,
      fileName: format => createLibEntryFileName(packageId, format)
    },
    minify: true
  },
  plugins: [peerDepsExternal() as PluginOption]
})
