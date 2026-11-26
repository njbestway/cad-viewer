/**
 * Publish gate for @njbestway/acad-rust-converter.
 *
 * Invoked from `prepublishOnly` AFTER a full build. npm/pnpm run
 * `prepublishOnly` right before packing and ABORT `publish` if it exits
 * non-zero, so this is the last safety net that stops a malformed / stale /
 * mis-named artifact from reaching the registry.
 *
 * It is intentionally dependency-free (only Node built-ins) so it runs in any
 * environment and never itself becomes a build-time failure mode.
 *
 * Checks (any failure => exit 1, publish blocked):
 *   1. Package metadata: name/scope, publishConfig.access, license, semver.
 *   2. Entry-point targets (main/module/types/exports) resolve to real files.
 *   3. Required shipped files exist and are non-empty (dist/*, lib/index.d.ts,
 *      LICENSE, NOTICE, README.md, package.json).
 *   4. WASM integrity: the deployed academy wasm is present, big enough, and
 *      carries the WebAssembly magic + version header (a truncated/empty or
 *      non-wasm file cannot slip through).
 *
 * Advisory (warns, does not block unless ACADRUST_REQUIRE_CLEAN_GIT=1):
 *   5. Git hygiene: uncommitted changes to tracked files usually mean you are
 *      about to publish something not yet committed.
 *
 * Env knobs:
 *   ACADRUST_ALLOW_DIRTY=1     skip the git-hygiene warning entirely.
 *   ACADRUST_REQUIRE_CLEAN_GIT=1  promote dirty-tracked-files to a hard error.
 *   ACADRUST_MIN_WASM_BYTES=<n>   override the wasm size floor (bytes).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(scriptDir, '..')

const EXPECTED_NAME = '@njbestway/acad-rust-converter'
const EXPECTED_LICENSE = '(MIT AND MPL-2.0)'
const EXPECTED_ACCESS = 'public'

// Deployed (renamed-by-vite) wasm sibling of the worker in dist/.
const WASM_DIST = 'dist/acad-rust_bg.wasm'
// WebAssembly module header: 00 61 73 6d ("\\0asm") then version 01 00 00 00.
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00]
// Reference build is ~6.75 MB; 3 MB is a conservative floor that flags a
// truncated/partial build without being sensitive to future size tuning.
const DEFAULT_MIN_WASM_BYTES = 3 * 1024 * 1024

const REQUIRED_FILES = [
  'package.json',
  'LICENSE',
  'NOTICE',
  'README.md',
  'lib/index.d.ts',
  'dist/acad-rust-converter.js',
  'dist/acad-rust-converter.umd.cjs',
  'dist/acad-rust-parser-worker.js',
  'dist/acad-rust-converter-main-thread.js'
]

const failures = []
const warnings = []

function fail(msg) {
  failures.push(msg)
}
function warn(msg) {
  warnings.push(msg)
}

/** Byte size of a path, or null if it does not exist. */
function sizeOf(rel) {
  const abs = join(pkgRoot, rel)
  if (!existsSync(abs)) return null
  return statSync(abs).size
}

const pkgPath = join(pkgRoot, 'package.json')
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (err) {
  console.error(`\n[verify-package] FATAL: cannot read/parse package.json: ${err.message}\n`)
  process.exit(1)
}

// --- 1. Metadata ---------------------------------------------------------
if (pkg.name !== EXPECTED_NAME) {
  fail(`package "name" is ${JSON.stringify(pkg.name)}, expected ${EXPECTED_NAME}`)
}
if (pkg.publishConfig?.access !== EXPECTED_ACCESS) {
  fail(`publishConfig.access is ${JSON.stringify(pkg.publishConfig?.access)}, expected "${EXPECTED_ACCESS}" (scoped public package)`)
}
if (pkg.license !== EXPECTED_LICENSE) {
  fail(`"license" is ${JSON.stringify(pkg.license)}, expected "${EXPECTED_LICENSE}" (MIT wrapper + MPL-2.0 wasm)`)
}
// Loose semver shape check (major.minor.patch with optional prerelease/build).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
  fail(`"version" is ${JSON.stringify(pkg.version)}, not a valid semver`)
}

// --- 2. Entry-point targets ---------------------------------------------
const entryTargets = new Set()
for (const key of ['main', 'module', 'types', 'typings', 'browser']) {
  if (typeof pkg[key] === 'string') entryTargets.add(pkg[key])
}
const walkExports = (value) => {
  if (typeof value === 'string') entryTargets.add(value)
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walkExports(v)
  }
}
if (pkg.exports) walkExports(pkg.exports)
for (const target of entryTargets) {
  if (sizeOf(target) === null) {
    fail(`package.json entry-point "${target}" does not exist on disk`)
  }
}

// --- 3. Required files present + non-empty ------------------------------
for (const rel of REQUIRED_FILES) {
  const bytes = sizeOf(rel)
  if (bytes === null) fail(`missing required file: ${rel}`)
  else if (bytes === 0) fail(`required file is empty (0 bytes): ${rel}`)
}

// --- 4. WASM integrity ---------------------------------------------------
const minWasm = Number(process.env.ACADRUST_MIN_WASM_BYTES ?? DEFAULT_MIN_WASM_BYTES)
const wasmAbs = join(pkgRoot, WASM_DIST)
const wasmBytes = sizeOf(WASM_DIST)
if (wasmBytes === null) {
  fail(`missing deployed wasm: ${WASM_DIST}`)
} else if (wasmBytes < minWasm) {
  fail(`${WASM_DIST} is ${wasmBytes} bytes, below the ${minWasm}-byte floor (truncated/empty build?)`)
} else {
  // Read the 8-byte header without loading the whole multi-MB file.
  try {
    const fd = readFileSync(wasmAbs)
    const header = [...fd.subarray(0, 8)]
    const magicOk = WASM_MAGIC.every((b, i) => header[i] === b)
    const versionOk = WASM_VERSION.every((b, i) => header[4 + i] === b)
    if (!magicOk) fail(`${WASM_DIST} is not a valid WebAssembly module (bad magic: ${header.slice(0, 4).join(',')})`)
    else if (!versionOk) fail(`${WASM_DIST} has an unexpected wasm version header: ${header.slice(4, 8).join(',')}`)
  } catch (err) {
    fail(`could not read wasm header from ${WASM_DIST}: ${err.message}`)
  }
}

// --- 5. Git hygiene (advisory) ------------------------------------------
const allowDirty = process.env.ACADRUST_ALLOW_DIRTY === '1'
const requireClean = process.env.ACADRUST_REQUIRE_CLEAN_GIT === '1'
if (!allowDirty) {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: pkgRoot,
    encoding: 'utf8'
  })
  if (res.status === 0) {
    const dirty = res.stdout.trim().split('\n').filter(Boolean)
    if (dirty.length > 0) {
      const msg = `uncommitted changes to tracked files (${dirty.length}):\n    ${dirty.join('\n    ')}`
      if (requireClean) fail(msg)
      else warn(`${msg}\n  (commit first, or set ACADRUST_ALLOW_DIRTY=1 to silence, or ACADRUST_REQUIRE_CLEAN_GIT=1 to make this fatal)`)
    }
  }
  // git missing / not a repo / other error: silently skip (advisory only).
}

// --- Report --------------------------------------------------------------
for (const w of warnings) console.warn(`[verify-package] WARN: ${w}`)

if (failures.length > 0) {
  console.error(`\n[verify-package] ${failures.length} problem(s) found — refusing to publish:\n`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('\n[verify-package] Fix the above (or run `pnpm run build`) and retry `npm publish`.\n')
  process.exit(1)
}

const wasmSize = wasmBytes ?? 0
console.log(
  `\n[verify-package] OK — ${EXPECTED_NAME}@${pkg.version} looks publish-ready ` +
  `(${(wasmSize / 1024 / 1024).toFixed(2)} MB wasm, all required artifacts present).\n`
)
