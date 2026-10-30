/**
 * Phase 2.11 Task A1 — snapshot-sharing metrics contract close-out.
 *
 * Verifies the installed `@mlightcad/data-model` build against the Phase 2.10
 * 18-field metrics contract and records the vendor tarball SHA256, so the
 * "metrics contract unchanged" claim is a re-runnable check rather than a
 * hand-copied table. Writes `reports/phase211/phase211-closeout-2.10.json`.
 *
 *   node tools/phase211-metrics-contract.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const installed = 'packages/cad-editor-demo/node_modules/@mlightcad/data-model'
const distPath = path.resolve(installed, 'dist/data-model.cjs')
const metricsModule = path.resolve(
  installed,
  'lib/database/transaction/AcDbSnapshotSharingMetrics.js'
)
const integrityModule = path.resolve(
  installed,
  'lib/database/transaction/AcDbSnapshotSharingIntegrity.js'
)

// The rollup bundle (`dist/data-model.cjs`) does not re-export the phase 2.10
// metrics contract, so the contract is verified against the ESM `lib/` tree the
// browser build actually consumes.
const metrics = await import(pathToFileURL(metricsModule).href)
const integrity = await import(pathToFileURL(integrityModule).href).catch(
  () => undefined
)
const mod = {
  ...require(distPath),
  ...metrics,
  ...(integrity ?? {})
}
const factory = mod.acdbCreateSnapshotSharingMetrics
if (typeof factory !== 'function') {
  throw new Error('acdbCreateSnapshotSharingMetrics is not exported by the installed bundle')
}
const zeros = factory()
const keys = Object.keys(zeros)

const hash = p =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()

const result = {
  phase: '2.11',
  task: 'A1',
  generatedAt: new Date().toISOString(),
  packageVersion: require(path.resolve(installed, 'package.json')).version,
  installedDist: {
    path: installed,
    sha256: hash(distPath),
    bytes: fs.statSync(distPath).size
  },
  metricsContract: {
    fieldCount: keys.length,
    fields: keys,
    allZero: keys.every(k => zeros[k] === 0)
  },
  vendorTarball: {
    file: 'vendor/mlightcad-data-model-1.15.16-perf.4.tgz',
    sha256: hash('vendor/mlightcad-data-model-1.15.16-perf.4.tgz'),
    bytes: fs.statSync('vendor/mlightcad-data-model-1.15.16-perf.4.tgz').size
  },
  integrityProbe: {
    exported: typeof mod.AcDbSnapshotIntegrityProbe === 'function',
    fingerprintExported: typeof mod.acdbFingerprintSnapshot === 'function'
  }
}

console.log(JSON.stringify(result, null, 2))
fs.mkdirSync('reports/phase211', { recursive: true })
fs.writeFileSync(
  'reports/phase211/phase211-closeout-2.10.json',
  JSON.stringify(result, null, 2) + '\n'
)
