import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import { defineConfig, type PluginOption } from 'vite'

import { createLibEntryFileName } from '../vite-config/pluginRollupOutput'

const packageId = 'acad-rust-converter'

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
