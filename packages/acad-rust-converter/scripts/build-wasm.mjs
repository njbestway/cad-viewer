/**
 * Build the acadrust WASM bridge for @mlightcad/acad-rust-converter.
 *
 * Pipeline:
 *   1. cargo build --release --target wasm32-unknown-unknown  (rust/Cargo.toml)
 *   2. wasm-bindgen --target web --out-dir wasm/pkg <built .wasm>
 *
 * The generated `wasm/pkg/acad_rust_converter.js` glue is imported by
 * `src/worker.ts` and bundled into `dist/acad-rust-parser-worker.js`; the
 * sibling `wasm/pkg/acad_rust_converter_bg.wasm` is copied to
 * `dist/acad-rust_bg.wasm` by vite.config.worker.ts.
 *
 * Prerequisites (see README): rustup + cargo, the `wasm32-unknown-unknown`
 * target, and the `wasm-bindgen` CLI pinned to 0.2.126 (must match the crate
 * dependency exactly or the glue schema check fails).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const manifestPath = join(packageRoot, 'rust', 'Cargo.toml')
const target = 'wasm32-unknown-unknown'
const libName = 'acad_rust_converter'
const builtWasm = join(
  packageRoot,
  'rust',
  'target',
  target,
  'release',
  `${libName}.wasm`
)
const outDir = join(packageRoot, 'wasm', 'pkg')

/** Honour a project-local CARGO_HOME (this repo uses E:\rust\.cargo). */
function buildEnv() {
  const env = { ...process.env }
  const cargoHome = env.CARGO_HOME
  if (cargoHome) {
    const cargoBin = join(cargoHome, 'bin')
    env.PATH = `${cargoBin}${delimiter}${env.PATH ?? ''}`
    // cargo reads PATH (Unix) / Path (Windows); set both to be safe.
    env.Path = env.PATH
  }
  return env
}

const delimiter = process.platform === 'win32' ? ';' : ':'

function fail(message) {
  console.error(`\n[acad-rust-converter] ${message}\n`)
  process.exit(1)
}

function run(command, args, label) {
  console.log(`[acad-rust-converter] ${label}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: buildEnv(),
    stdio: 'inherit',
    // On Windows cargo/wasm-bindgen are .exe; CreateProcess appends the
    // extension when searching PATH, so a bare name resolves. shell stays off
    // to avoid argument-quoting surprises.
    shell: false
  })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(
        `'${command}' was not found on PATH.\n` +
          'Install the Rust toolchain (https://rustup.rs) and the wasm-bindgen CLI:\n' +
          '  cargo install wasm-bindgen-cli --version 0.2.126\n' +
          'Or point CARGO_HOME at a directory whose bin/ contains them.'
      )
    }
    fail(`${label} failed to start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${label} exited with code ${result.status}`)
  }
}

// 1. Compile the crate to wasm32.
run(
  process.env.CARGO_BIN ?? 'cargo',
  [
    'build',
    '--release',
    '--target',
    target,
    '--manifest-path',
    manifestPath
  ],
  'cargo build'
)

if (!existsSync(builtWasm)) {
  fail(`Expected wasm artifact not found: ${builtWasm}`)
}

// 2. Generate the ESM (--target web) glue + optimized wasm.
run(
  process.env.WASM_BINDGEN_BIN ?? 'wasm-bindgen',
  [
    builtWasm,
    '--target',
    'web',
    '--out-dir',
    outDir
  ],
  'wasm-bindgen'
)

const glue = join(outDir, `${libName}.js`)
const wasm = join(outDir, `${libName}_bg.wasm`)
for (const artifact of [glue, wasm]) {
  if (!existsSync(artifact)) {
    fail(`wasm-bindgen did not produce ${artifact}`)
  }
}

console.log(
  `[acad-rust-converter] WASM ready:\n  ${glue}\n  ${wasm}`
)
