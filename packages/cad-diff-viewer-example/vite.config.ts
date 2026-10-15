import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { exampleRollupOutput } from '../vite-config/pluginRollupOutput'
import {
  ACADRUST_CONVERTER_PACKAGE,
  ACADRUST_PARSER_WORKER_FILE,
  ACADRUST_WASM_FILE,
  LIBREDWG_CONVERTER_PACKAGE,
  LIBREDWG_PARSER_WASM_FILE,
  LIBREDWG_PARSER_WORKER_FILE,
  MTEXT_RENDERER_WORKER_FILE
} from '../../tools/worker-assets.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const realdwgRoot = resolve(__dirname, '../../../realdwg-web')
const libredwgDist = `./node_modules/${LIBREDWG_CONVERTER_PACKAGE}/dist`
const libredwgWasmSrc = resolve(
  __dirname,
  'node_modules',
  LIBREDWG_CONVERTER_PACKAGE,
  'dist',
  LIBREDWG_PARSER_WASM_FILE
)
// Local fork: acadrust (MPL-2.0) parser worker + wasm pair.
const acadRustDist = `./node_modules/${ACADRUST_CONVERTER_PACKAGE}/dist`
const acadRustWasmSrc = resolve(
  __dirname,
  'node_modules',
  ACADRUST_CONVERTER_PACKAGE,
  'dist',
  ACADRUST_WASM_FILE
)

export default defineConfig({
  base: './',
  server: {
    fs: {
      allow: [resolve(__dirname, '../..'), realdwgRoot]
    },
    watch: {
      ignored: ['**/realdwg-web/**']
    }
  },
  build: {
    modulePreload: false,
    minify: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: exampleRollupOutput
    }
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: `./node_modules/@mlightcad/cad-simple-viewer/dist/${MTEXT_RENDERER_WORKER_FILE}`,
          dest: 'workers',
          rename: { stripBase: true }
        },
        {
          src: `${libredwgDist}/${LIBREDWG_PARSER_WORKER_FILE}`,
          dest: 'workers',
          rename: { stripBase: true }
        },
        ...(existsSync(libredwgWasmSrc)
          ? [
              {
                src: `${libredwgDist}/${LIBREDWG_PARSER_WASM_FILE}`,
                dest: 'workers',
                rename: { stripBase: true }
              }
            ]
          : []),
        // Local fork: acadrust (MPL-2.0) parser worker + wasm pair.
        {
          src: `${acadRustDist}/${ACADRUST_PARSER_WORKER_FILE}`,
          dest: 'workers',
          rename: { stripBase: true }
        },
        ...(existsSync(acadRustWasmSrc)
          ? [
              {
                src: `${acadRustDist}/${ACADRUST_WASM_FILE}`,
                dest: 'workers',
                rename: { stripBase: true }
              }
            ]
          : [])
      ]
    })
  ]
})
