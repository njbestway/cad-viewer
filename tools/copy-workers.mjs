/**
 * Copy web worker assets for packages in this monorepo.
 *
 * Producer (cad-simple-viewer):
 *   node tools/copy-workers.mjs
 *   → copies mtext worker into ./dist
 *   → copies proprietary dwg workers when that package is available
 *   → does NOT copy acadrust — hosts/examples must depend on
 *     @mlightcad/acad-rust-converter and copy those assets themselves
 *
 * Consumer (examples):
 *   node tools/copy-workers.mjs dist/workers
 *   → copies *-worker.js from @mlightcad/cad-simple-viewer/dist
 *   → copies acadrust worker + wasm from @mlightcad/acad-rust-converter when present
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import {
  ACADRUST_CONVERTER_PACKAGE,
  ACADRUST_MAIN_THREAD_FILE,
  ACADRUST_PARSER_WORKER_FILE,
  ACADRUST_WASM_FILE,
  DWG_CONVERTER_PACKAGE,
  DWG_PARSER_MAIN_FILE,
  DWG_PARSER_WORKER_FILE,
  MTEXT_RENDERER_PACKAGE,
  MTEXT_RENDERER_WORKER_FILE
} from './worker-assets.mjs'

const packageRoot = process.cwd()
const require = createRequire(join(packageRoot, 'package.json'))
const destRelative = process.argv[2]

function pkgRoot(name) {
  const entry = require.resolve(name)
  let dir = dirname(entry)
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.name === name) {
        return dir
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Package root not found: ${name}`)
    }
    dir = parent
  }
}

function tryPkgRoot(name) {
  try {
    return pkgRoot(name)
  } catch {
    return null
  }
}

function copy(from, to) {
  if (!existsSync(from)) {
    throw new Error(`Missing asset: ${from}`)
  }
  copyFileSync(from, to)
  console.log(`Copied ${from} -> ${to}`)
}

function copyIfExists(from, to) {
  if (!existsSync(from)) {
    console.log(`Skipped (not found): ${from}`)
    return false
  }
  copyFileSync(from, to)
  console.log(`Copied ${from} -> ${to}`)
  return true
}

function copyOptionalWorker(pkgName, workerFile, outDir) {
  const root = tryPkgRoot(pkgName)
  if (!root) {
    console.log(`Skipped (package not found): ${pkgName}`)
    return
  }
  copyIfExists(join(root, 'dist', workerFile), join(outDir, workerFile))
}

/**
 * Like {@link copyOptionalWorker}, but treats the asset as mandatory once the
 * package is installed. Used for the acadrust worker + wasm pair: they deploy
 * as an atomic set, and a half-copy (worker present, sibling wasm missing) only
 * surfaces as a runtime `acad-rust_bg.wasm` 404. Fail the build instead. A host
 * that does not depend on the package at all is still skipped cleanly.
 */
function copyWhenPackagePresent(pkgName, file, outDir) {
  const root = tryPkgRoot(pkgName)
  if (!root) {
    console.log(`Skipped (package not found): ${pkgName}`)
    return
  }
  copy(join(root, 'dist', file), join(outDir, file))
}

function copyProducerWorkers() {
  const outDir = join(packageRoot, 'dist')
  mkdirSync(outDir, { recursive: true })
  // Optional proprietary converter.
  copyOptionalWorker(DWG_CONVERTER_PACKAGE, DWG_PARSER_WORKER_FILE, outDir)
  copyOptionalWorker(DWG_CONVERTER_PACKAGE, DWG_PARSER_MAIN_FILE, outDir)
  copy(
    join(pkgRoot(MTEXT_RENDERER_PACKAGE), 'dist', MTEXT_RENDERER_WORKER_FILE),
    join(outDir, MTEXT_RENDERER_WORKER_FILE)
  )
}

function copyAcadRustAssets(outDir) {
  // acadrust is the default open-source DWG path: when a host depends on the
  // converter, the worker and its sibling wasm must land together (atomic pair:
  // a half-copy only surfaces as a runtime wasm 404, so copyWhenPackagePresent
  // hard-fails).
  copyWhenPackagePresent(
    ACADRUST_CONVERTER_PACKAGE,
    ACADRUST_PARSER_WORKER_FILE,
    outDir
  )
  copyWhenPackagePresent(
    ACADRUST_CONVERTER_PACKAGE,
    ACADRUST_WASM_FILE,
    outDir
  )
  // The main-thread transcoder is an optional escape hatch (only used when a
  // host sets `useWorker: false`), so copy it opportunistically rather than
  // failing builds that never exercise it.
  const root = tryPkgRoot(ACADRUST_CONVERTER_PACKAGE)
  if (root) {
    copyIfExists(
      join(root, 'dist', ACADRUST_MAIN_THREAD_FILE),
      join(outDir, ACADRUST_MAIN_THREAD_FILE)
    )
  }
}

function copyFromCadSimpleViewer(destRelativePath) {
  const srcDir = join(pkgRoot('@mlightcad/cad-simple-viewer'), 'dist')
  if (!existsSync(srcDir)) {
    throw new Error(
      `Missing ${srcDir}. Run copy:workers in @mlightcad/cad-simple-viewer first.`
    )
  }

  const workers = readdirSync(srcDir).filter(
    name => name.endsWith('-worker.js') || name === DWG_PARSER_MAIN_FILE
  )
  if (workers.length === 0) {
    throw new Error(
      `No *-worker.js files in ${srcDir}. Run copy:workers in @mlightcad/cad-simple-viewer first.`
    )
  }

  const outDir = resolve(packageRoot, destRelativePath)
  mkdirSync(outDir, { recursive: true })

  for (const name of workers) {
    copy(join(srcDir, name), join(outDir, name))
  }

  // acadrust is host-owned; copy when the example depends on the converter.
  copyAcadRustAssets(outDir)
}

if (destRelative) {
  copyFromCadSimpleViewer(destRelative)
} else {
  copyProducerWorkers()
}
