import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Local `@mlightcad/data-model` substitution.
 *
 * This package is a private fork and may be developed against the realdwg-web
 * monorepo checkout (where data-model lives) instead of the version installed
 * by pnpm. Only the `@mlightcad/data-model` specifier is rewritten: its own
 * imports of `@mlightcad/common`, `@mlightcad/geometry-engine`,
 * `@mlightcad/graphic-interface` and `@mlightcad/emf-converter` are resolved
 * from the checkout's own `node_modules`, so the whole family stays on one
 * version (no 1.15.16 / 1.15.21 mix) and the graph keeps a single instance.
 *
 * The rewrite lives here, inside the fork-only package, so the root
 * `pnpm-workspace.yaml` overrides and `pnpm-lock.yaml` stay byte-identical to
 * upstream and never cause merge conflicts.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Sibling checkout of the realdwg-web monorepo (dev-app convention). */
const SIBLING_REALDWG_ROOT = resolve(__dirname, '../../../realdwg-web')

/** Built output (stable, fast) vs TypeScript sources (no rebuild needed). */
const ENTRY_LIB = 'packages/data-model/lib/index.js'
const ENTRY_SRC = 'packages/data-model/src/index.ts'

const OFF_VALUES = ['0', 'false', 'off', 'no']
const ON_VALUES = ['1', 'true', 'yes', 'on']

export interface LocalMlightcadAlias {
  find: RegExp
  replacement: string
}

export interface LocalMlightcad {
  /** True when the checkout was found and the rewrite is applied. */
  enabled: boolean
  /** Human readable status, logged by `vite.config.ts`. */
  reason: string
  /** Absolute path the specifier is rewritten to (empty when disabled). */
  entry: string
  alias: LocalMlightcadAlias[]
  /** Extra `server.fs.allow` roots so vite may serve the checkout. */
  fsAllow: string[]
  /** Specifiers that must never be pre-bundled (their cache would go stale). */
  optimizeDepsExclude: string[]
}

const disabledResult = (reason: string, entry = ''): LocalMlightcad => ({
  enabled: false,
  reason,
  entry,
  alias: [],
  fsAllow: [],
  optimizeDepsExclude: []
})

/**
 * Resolve the local data-model rewrite from the environment.
 *
 * - `CAD_LOCAL_REALDWG` — checkout root, defaults to the sibling
 *   `../../../realdwg-web`; set to `0` / `false` / `off` to disable the
 *   rewrite entirely (CI, other machines, or to verify the pinned version).
 * - `CAD_LOCAL_REALDWG_SRC` — `1` (or `true` / `yes` / `on`) aliases
 *   `src/index.ts` instead of `lib/index.js` so data-model edits are compiled
 *   on the fly; the default consumes the built `lib/`.
 */
export function localMlightcad(
  env: NodeJS.ProcessEnv = process.env
): LocalMlightcad {
  const rootValue = (env.CAD_LOCAL_REALDWG ?? '').trim()
  if (OFF_VALUES.includes(rootValue.toLowerCase())) {
    return disabledResult('CAD_LOCAL_REALDWG is off')
  }
  const root = rootValue ? resolve(rootValue) : SIBLING_REALDWG_ROOT
  const useSrc = ON_VALUES.includes(
    (env.CAD_LOCAL_REALDWG_SRC ?? '').trim().toLowerCase()
  )
  const entry = resolve(root, useSrc ? ENTRY_SRC : ENTRY_LIB)

  if (!existsSync(entry)) {
    return disabledResult(
      `${root} checkout not usable (missing ${useSrc ? ENTRY_SRC : ENTRY_LIB})`,
      entry
    )
  }

  return {
    enabled: true,
    reason: useSrc ? 'realdwg-web sources' : 'realdwg-web build',
    entry,
    // Exact match: deep imports (`@mlightcad/data-model/...`) keep resolving
    // through package.json exports instead of being hijacked.
    alias: [{ find: /^@mlightcad\/data-model$/, replacement: entry }],
    fsAllow: [root],
    optimizeDepsExclude: ['@mlightcad/data-model']
  }
}
