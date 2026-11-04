import { createReadStream, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'
import peerDepsExternal from 'rollup-plugin-peer-deps-external'
import { visualizer } from 'rollup-plugin-visualizer'
import {
  type ConfigEnv,
  type Connect,
  defineConfig,
  type LibraryFormats,
  type Plugin,
  type PluginOption
} from 'vite'
import dts from 'vite-plugin-dts'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import svgLoader from 'vite-svg-loader'

import {
  ACADRUST_CONVERTER_PACKAGE,
  ACADRUST_PARSER_WORKER_FILE,
  ACADRUST_WASM_FILE,
  MTEXT_RENDERER_WORKER_FILE
} from '../../tools/worker-assets.mjs'
import { createLibEntryFileName } from '../vite-config/pluginRollupOutput'
import { localMlightcad } from './localMlightcad'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageId = 'cad-editor-ol'
const require = createRequire(import.meta.url)
/** Prefer package sources so unused exports (e.g. MlToolBar) can tree-shake. */
const uiComponentsSrc = resolve(
  dirname(require.resolve('@mlightcad/ui-components/package.json')),
  'src/index.ts'
)

const CAD_DATA_DIR = resolve(__dirname, '../../caddata')
const CAD_DATA_ROUTE = '/cad-data/'

/**
 * Extensions the local cad-data route serves with an explicit `Content-Type`.
 * Everything else falls back to `application/octet-stream`, which is fine for
 * `.shx` / `.pfb` fonts and `.dxf` / `.dwg` sample drawings.
 */
const CAD_DATA_MIME: Record<string, string> = {
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Serve the repo-root `caddata/` directory (a checkout of
 * https://github.com/mlightcad/cad-data holding `data/`, `fonts/` and
 * `templates/`) at `/cad-data/*` in `vite dev` and `vite preview`.
 * `dev/App.vue` points the viewer's `baseUrl` here so fonts, templates and
 * sample drawings load locally. No-ops when the checkout is missing.
 */
function localCadDataPlugin(): Plugin[] {
  if (!existsSync(CAD_DATA_DIR)) {
    console.warn(
      `[cad-editor-ol] caddata/ checkout not found at "${CAD_DATA_DIR}"; ` +
        'clone https://github.com/mlightcad/cad-data into the repo root as ' +
        'caddata/ to serve CAD assets locally.'
    )
    return []
  }
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith(CAD_DATA_ROUTE)) {
      return next()
    }
    let rel: string
    try {
      rel = decodeURIComponent(url.slice(CAD_DATA_ROUTE.length))
    } catch {
      res.statusCode = 400
      return res.end('bad request')
    }
    const filePath = resolve(CAD_DATA_DIR, rel)
    // Contain reads to within the cad-data root (block `..` traversal).
    if (
      !(filePath === CAD_DATA_DIR || filePath.startsWith(CAD_DATA_DIR + sep)) ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      res.statusCode = 404
      return res.end('cad-data file not found')
    }
    res.setHeader(
      'Content-Type',
      CAD_DATA_MIME[extname(filePath).toLowerCase()] ??
        'application/octet-stream'
    )
    // no-cache so files replaced inside caddata/ are picked up on the next load.
    res.setHeader('Cache-Control', 'no-cache')
    createReadStream(filePath).pipe(res)
  }
  return [
    {
      name: 'local-cad-data',
      configureServer(server) {
        server.middlewares.use(middleware)
      },
      configurePreviewServer(server) {
        server.middlewares.use(middleware)
      }
    }
  ]
}

/** acadrust (MPL-2.0) parser worker + wasm, copied next to each other. */
const acadRustDist = `./node_modules/${ACADRUST_CONVERTER_PACKAGE}/dist`
const acadRustWasmSrc = resolve(
  __dirname,
  'node_modules',
  ACADRUST_CONVERTER_PACKAGE,
  'dist',
  ACADRUST_WASM_FILE
)

/** MTEXT layout/shaping worker shipped by `@mlightcad/cad-simple-viewer`. */
const pinnedMtextWorkerSrc = `./node_modules/@mlightcad/cad-simple-viewer/dist/${MTEXT_RENDERER_WORKER_FILE}`

export default defineConfig(({ command, mode }: ConfigEnv) => {
  // Private fork: prefer the sibling checkouts over the pinned installs.
  const local = localMlightcad()
  for (const message of local.messages) {
    console.info(`[cad-editor-ol] ${message}`)
  }

  // viteStaticCopy resolves `src` through fast-glob, which needs forward
  // slashes: a backslash in an absolute Windows path (`\r`, `\m`, ...) is read
  // as an escape and the match comes back empty.
  const mtextWorkerSrc = local.mtextWorkerFile
    ? local.mtextWorkerFile.replace(/\\/g, '/')
    : pinnedMtextWorkerSrc

  const plugins: PluginOption[] = [
    vue() as PluginOption,
    svgLoader(),
    libInjectCss() as PluginOption,
    peerDepsExternal() as PluginOption,
    viteStaticCopy({
      targets: [
        {
          src: mtextWorkerSrc,
          dest: 'assets',
          rename: { stripBase: true }
        },
        {
          src: `${acadRustDist}/${ACADRUST_PARSER_WORKER_FILE}`,
          dest: 'assets',
          rename: { stripBase: true }
        },
        ...(existsSync(acadRustWasmSrc)
          ? [
              {
                src: `${acadRustDist}/${ACADRUST_WASM_FILE}`,
                dest: 'assets',
                rename: { stripBase: true }
              }
            ]
          : [])
      ]
    }) as PluginOption,
    dts({
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
      beforeWriteFile: (filePath, content) => {
        const normalized = filePath.replace(/\\/g, '/')
        if (normalized.endsWith('/dist/index.d.ts')) {
          return {
            filePath: filePath.replace(/index\.d\.ts$/, `${packageId}.d.ts`),
            content: content.replace(
              '//# sourceMappingURL=index.d.ts.map',
              `//# sourceMappingURL=${packageId}.d.ts.map`
            )
          }
        }
      }
    }) as PluginOption,
    ...localCadDataPlugin()
  ]

  if (mode === 'analyze') {
    plugins.push(visualizer())
  }

  return {
    outDir: 'dist',
    resolve: {
      alias: [
        // Must stay first: every consumer in the graph (this package, the
        // workspace peers' dists, the acad-rust converter) imports the bare
        // specifier, so one rewrite keeps a single instance alive. No-op when
        // the checkout is missing.
        ...local.alias,
        {
          // ui-components' published `module` is a single prebundled file that
          // always injects MlToolBar CSS. Point at sources so Rollup can drop it.
          find: /^@mlightcad\/ui-components$/,
          replacement: uiComponentsSrc
        }
      ]
    },
    server: local.enabled
      ? {
          fs: {
            // The rewritten entries live outside this workspace.
            allow: [resolve(__dirname, '../..'), ...local.fsAllow]
          },
          watch: {
            // The checkouts rebuild their own outputs; ignore them so they do
            // not thrash HMR (same treatment as the demo packages).
            ignored: local.watchIgnore
          }
        }
      : undefined,
    optimizeDeps: {
      // The CAD Script plugin is a workspace package compiled by Vite in dev.
      // The rewritten entries must not be pre-bundled either: their cache goes
      // stale on every checkout rebuild (`504 Outdated Optimize Dep`).
      exclude:
        command === 'serve'
          ? ['@mlightcad/cad-script-plugin', ...local.optimizeDepsExclude]
          : []
    },
    build: {
      lib: {
        entry: 'src/index.ts',
        name: packageId,
        fileName: format => createLibEntryFileName(packageId, format),
        formats: ['es'] as LibraryFormats[]
      },
      minify: true,
      rollupOptions: {
        // CAD Script plugin is a peer: loaded at runtime via dynamic import.
        external: [
          '@mlightcad/cad-script-plugin',
          '@mlightcad/cad-script-plugin/register',
          '@mlightcad/cad-script-plugin/style.css'
        ],
        output: {
          chunkFileNames: `${packageId}-[name]-[hash].js`,
          assetFileNames: `${packageId}[extname]`
        }
      }
    },
    plugins
  }
})
