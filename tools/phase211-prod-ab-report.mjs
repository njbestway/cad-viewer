/**
 * Phase 2.11 Task A3 — production-build A/B report.
 *
 * Reads the merged A/B output written by `phase210-browser-ab.spec.ts` against
 * the production bundle, extracts the `prod / 1000` arm, stamps every artifact
 * with a SHA256 and writes `reports/phase211/phase211-prod-ab.json`. Restores
 * `reports/phase210/phase210-browser-ab.json` afterwards so the Phase 2.10
 * record keeps a build it actually measured.
 *
 *   node tools/phase211-prod-ab-report.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const repoRoot = process.cwd()
const current = 'reports/phase210/phase210-browser-ab.json'
const backup = 'reports/phase211/.backup-phase210-browser-ab.json'

const sha = p => {
  if (!fs.existsSync(p)) return { path: p, missing: true }
  const buf = fs.readFileSync(p)
  return {
    path: path.relative(repoRoot, p).replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase()
  }
}

const merged = JSON.parse(fs.readFileSync(current, 'utf8'))
const prod = merged.modes?.prod
const size1000 = prod?.sizes?.['1000']
if (!size1000) throw new Error('prod/1000 block missing from the A/B output')

const assetsDir = path.join(repoRoot, 'packages/cad-editor-demo/dist/assets')
const assets = fs.existsSync(assetsDir)
  ? fs
      .readdirSync(assetsDir)
      .filter(f => f.endsWith('.js') || f.endsWith('.css'))
      .map(f => sha(path.join(assetsDir, f)))
  : []

const out = {
  phase: '2.11',
  task: 'A3',
  generatedAt: new Date().toISOString(),
  what: 'Production-build A/B for the snapshot-sharing release candidate: one bundle, two runtime configurations of the same feature flag.',
  bundle: {
    demoApp: 'packages/cad-editor-demo dist (vite build, VITE_E2E_EXPOSE_MANAGER=true)',
    assets,
    dataModel: sha(
      'packages/cad-editor-demo/node_modules/@mlightcad/data-model/dist/data-model.cjs'
    ),
    dataModelEsm: sha(
      'packages/cad-editor-demo/node_modules/@mlightcad/data-model/lib/database/transaction/AcDbDatabaseTransactionManager.js'
    ),
    threeRenderer: sha('packages/three-renderer/dist/index.js'),
    cadSimpleViewer: sha('packages/cad-simple-viewer/dist/index.js'),
    vendorTarball: sha('vendor/mlightcad-data-model-1.15.16-perf.4.tgz')
  },
  arms: {
    note: 'sharing off = shipping default; sharing on = candidate. Set per session through AcDbDatabaseTransactionManager.snapshotSharing, so both arms run the identical bundle.',
    samples: size1000.samples,
    runs: size1000.runs
  }
}

fs.writeFileSync(
  'reports/phase211/phase211-prod-ab.json',
  JSON.stringify(out, null, 2) + '\n'
)

// Keep the phase 2.10 record intact: this run used a different bundle.
fs.copyFileSync(backup, current)
fs.rmSync(backup)

console.log(JSON.stringify({ prod1000: size1000.samples, assets: assets.length }, null, 1))
