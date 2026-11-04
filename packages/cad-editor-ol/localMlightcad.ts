import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Local `@mlightcad/*` substitution for this package.
 *
 * This package is a private fork and is developed against sibling checkouts
 * (`realdwg-web`, `mtext-renderer`, `mtext-parser`) that are maintained
 * separately. pnpm installs the versions upstream pins, so the rewrites happen
 * at resolve time instead of touching `pnpm-workspace.yaml`, `pnpm-lock.yaml`
 * or the other packages:
 *
 * - `@mlightcad/data-model` -> realdwg-web (built `lib/` or `src/`).
 * - `@mlightcad/mtext-renderer` and `@mlightcad/mtext-parser` -> the mtext
 *   checkouts, plus the checkout's own worker bundle.
 * - `three` -> the copy this package already resolves: the mtext-renderer
 *   checkout carries its own `three`, and a second copy would break every
 *   `instanceof THREE.*` across that boundary.
 *
 * Every consumer in the graph (this package, the workspace peers' dists, the
 * acad-rust converter) imports the bare specifier, so one rewrite per name
 * keeps a single instance alive. The rewrite lives here, inside the fork-only
 * package, so the shared manifests stay byte-identical to upstream.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Sibling checkouts (same layout the demo packages use). */
const SIBLING_REALDWG_ROOT = resolve(__dirname, '../../../realdwg-web')
const SIBLING_MTEXT_RENDERER_ROOT = resolve(
  __dirname,
  '../../../mtext-renderer/packages/mtext-renderer'
)
const SIBLING_MTEXT_PARSER_ROOT = resolve(__dirname, '../../../mtext-parser')

/** Built output (stable, fast) vs TypeScript sources (no rebuild needed). */
const DATA_MODEL_LIB = 'packages/data-model/lib/index.js'
const DATA_MODEL_SRC = 'packages/data-model/src/index.ts'
const MTEXT_RENDERER_ENTRY = 'dist/index.js'
const MTEXT_RENDERER_WORKER = 'dist/mtext-renderer-worker.js'
const MTEXT_PARSER_ENTRY = 'dist/parser.js'

/** Globs for the checkout trees so their own rebuilds do not thrash HMR. */
const WATCH_IGNORE = {
  realdwg: '**/realdwg-web/**',
  mtextRenderer: '**/mtext-renderer/**',
  mtextParser: '**/mtext-parser/**'
}

const OFF_VALUES = ['0', 'false', 'off', 'no']
const ON_VALUES = ['1', 'true', 'yes', 'on']

export interface LocalMlightcadAlias {
  find: RegExp
  replacement: string
}

export interface LocalMlightcad {
  /** True when at least one checkout was found and rewritten. */
  enabled: boolean
  /** One status line per family, logged by `vite.config.ts`. */
  messages: string[]
  alias: LocalMlightcadAlias[]
  /** Extra `server.fs.allow` roots so vite may serve the checkouts. */
  fsAllow: string[]
  /** `server.watch.ignored` globs for the checkouts that are in use. */
  watchIgnore: string[]
  /** Specifiers that must never be pre-bundled (their cache would go stale). */
  optimizeDepsExclude: string[]
  /** Checkout's mtext worker bundle; unset means "keep the pinned copy". */
  mtextWorkerFile?: string
}

/** An entry file resolved inside a checkout, or the reason it was skipped. */
interface Candidate {
  enabled: boolean
  entry: string
  reason: string
}

function flag(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim().toLowerCase()
}

function candidate(root: string, relative: string, label: string): Candidate {
  const entry = resolve(root, relative)
  if (existsSync(entry)) {
    return { enabled: true, entry, reason: label }
  }
  return {
    enabled: false,
    entry,
    reason: `${root} checkout not usable (missing ${relative})`
  }
}

/**
 * `three` as this package resolves it. three 0.186 exposes `build/three.cjs`
 * through the `require` condition, and that shim calls `process.emitWarning`
 * before forwarding to the ESM build (`process is not defined` in a browser),
 * so prefer the sibling `three.module.js` when it exists.
 */
function threeEntry(): string {
  try {
    const resolved = require.resolve('three')
    const esm = resolved.replace(/three\.cjs$/, 'three.module.js')
    return existsSync(esm) ? esm : resolved
  } catch {
    return ''
  }
}

/**
 * Resolve the local checkouts from the environment.
 *
 * - `CAD_LOCAL_REALDWG` — checkout root, defaults to the sibling
 *   `../../../realdwg-web`; `0` / `false` / `off` disables the rewrite
 *   entirely (CI, other machines, or to verify the pinned version).
 * - `CAD_LOCAL_REALDWG_SRC` — `1` (or `true` / `yes` / `on`) aliases
 *   `src/index.ts` instead of `lib/index.js` so data-model edits are compiled
 *   on the fly; the default consumes the built `lib/`.
 * - `CAD_LOCAL_MTEXT` — `0` / `false` / `off` disables the mtext rewrites;
 *   otherwise they are applied whenever the sibling checkouts are present.
 */
export function localMlightcad(
  env: NodeJS.ProcessEnv = process.env
): LocalMlightcad {
  const messages: string[] = []
  const alias: LocalMlightcadAlias[] = []
  const fsAllow: string[] = []
  const watchIgnore: string[] = []
  const optimizeDepsExclude: string[] = []
  let mtextWorkerFile: string | undefined

  const realdwgFlag = (env.CAD_LOCAL_REALDWG ?? '').trim()
  if (OFF_VALUES.includes(realdwgFlag.toLowerCase())) {
    messages.push('@mlightcad/data-model: pinned (CAD_LOCAL_REALDWG is off)')
  } else {
    const root = realdwgFlag ? resolve(realdwgFlag) : SIBLING_REALDWG_ROOT
    const useSrc = ON_VALUES.includes(flag(env, 'CAD_LOCAL_REALDWG_SRC'))
    const dataModel = candidate(
      root,
      useSrc ? DATA_MODEL_SRC : DATA_MODEL_LIB,
      useSrc ? 'realdwg-web sources' : 'realdwg-web build'
    )
    if (dataModel.enabled) {
      messages.push(
        `@mlightcad/data-model <- ${dataModel.entry} (${dataModel.reason})`
      )
      // Exact matches: deep imports keep resolving through package.json
      // exports instead of being hijacked.
      alias.push({
        find: /^@mlightcad\/data-model$/,
        replacement: dataModel.entry
      })
      fsAllow.push(root)
      watchIgnore.push(WATCH_IGNORE.realdwg)
      optimizeDepsExclude.push('@mlightcad/data-model')
    } else {
      messages.push(`@mlightcad/data-model: pinned (${dataModel.reason})`)
    }
  }

  if (OFF_VALUES.includes(flag(env, 'CAD_LOCAL_MTEXT'))) {
    messages.push('@mlightcad/mtext-*: pinned (CAD_LOCAL_MTEXT is off)')
  } else {
    const renderer = candidate(
      SIBLING_MTEXT_RENDERER_ROOT,
      MTEXT_RENDERER_ENTRY,
      'mtext-renderer checkout'
    )
    const parser = candidate(
      SIBLING_MTEXT_PARSER_ROOT,
      MTEXT_PARSER_ENTRY,
      'mtext-parser checkout'
    )
    if (renderer.enabled && parser.enabled) {
      messages.push(
        `@mlightcad/mtext-renderer <- ${renderer.entry} (${renderer.reason})`
      )
      messages.push(
        `@mlightcad/mtext-parser <- ${parser.entry} (${parser.reason})`
      )
      alias.push({
        find: /^@mlightcad\/mtext-renderer$/,
        replacement: renderer.entry
      })
      alias.push({
        find: /^@mlightcad\/mtext-parser$/,
        replacement: parser.entry
      })
      const three = threeEntry()
      if (three) {
        alias.push({ find: /^three$/, replacement: three })
        messages.push(`three <- ${three} (single copy)`)
      }
      fsAllow.push(SIBLING_MTEXT_RENDERER_ROOT, SIBLING_MTEXT_PARSER_ROOT)
      watchIgnore.push(WATCH_IGNORE.mtextRenderer, WATCH_IGNORE.mtextParser)
      optimizeDepsExclude.push(
        '@mlightcad/mtext-renderer',
        '@mlightcad/mtext-parser'
      )
      const worker = resolve(SIBLING_MTEXT_RENDERER_ROOT, MTEXT_RENDERER_WORKER)
      if (existsSync(worker)) {
        // The worker is a separate bundle that no alias can reach: copying the
        // checkout's own build keeps the main thread and the worker in step.
        messages.push(`mtext worker <- ${worker}`)
        mtextWorkerFile = worker
      } else {
        messages.push(`mtext worker: pinned (missing ${MTEXT_RENDERER_WORKER})`)
      }
    } else {
      messages.push(
        `@mlightcad/mtext-*: pinned (${[
          renderer.enabled ? '' : renderer.reason,
          parser.enabled ? '' : parser.reason
        ]
          .filter(Boolean)
          .join('; ')})`
      )
    }
  }

  return {
    enabled: alias.length > 0,
    messages,
    alias,
    fsAllow,
    watchIgnore,
    optimizeDepsExclude,
    mtextWorkerFile
  }
}
