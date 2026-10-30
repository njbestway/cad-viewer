#!/usr/bin/env node
/**
 * Phase 2.10 build-artifact fingerprint.
 *
 * Hashes the artifacts that actually travel between the two repositories, so the
 * integration report can state exactly which bundle cad-viewer was verified
 * against instead of "whatever was on disk".
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPO = path.resolve(HERE, '..')
const OUT = path.join(REPO, 'reports', 'phase210', 'build-artifacts.json')

const sha256 = file => {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex').toUpperCase()
}

const stat = file => {
  const info = fs.statSync(file)
  return { bytes: info.size, mtime: info.mtime.toISOString() }
}

function entry(label, file) {
  if (!fs.existsSync(file)) return { label, path: file, missing: true }
  return { label, path: file, sha256: sha256(file), ...stat(file) }
}

const dataModel = 'E:/rustpro/realdwg-web/packages/data-model'
const store = path.join(
  REPO,
  'node_modules/.pnpm/@mlightcad+data-model@file+_09d210fcb614e90526a0a6f99bbfc191',
  'node_modules/@mlightcad/data-model'
)

const artifacts = [
  entry('data-model/dist/data-model.cjs', path.join(dataModel, 'dist/data-model.cjs')),
  entry(
    'data-model/lib/database/transaction/AcDbDatabaseTransactionManager.js',
    path.join(dataModel, 'lib/database/transaction/AcDbDatabaseTransactionManager.js')
  ),
  entry(
    'data-model/lib/database/transaction/AcDbSnapshotSharingMetrics.js',
    path.join(dataModel, 'lib/database/transaction/AcDbSnapshotSharingMetrics.js')
  ),
  entry(
    'cad-viewer/store/data-model/lib/database/transaction/AcDbDatabaseTransactionManager.js',
    path.join(store, 'lib/database/transaction/AcDbDatabaseTransactionManager.js')
  ),
  entry(
    'cad-viewer/store/data-model/dist/data-model.cjs',
    path.join(store, 'dist/data-model.cjs')
  ),
  entry(
    'vendor/mlightcad-data-model-1.15.16-perf.3.tgz',
    path.join(REPO, 'vendor/mlightcad-data-model-1.15.16-perf.3.tgz')
  )
]

// A stale `dist` is the exact trap that made the prod A/B fail twice, so the
// report needs a machine check rather than a visual one.
const newer = (a, b) => {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return null
  return fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs
}

const freshness = {
  'cad-simple-viewer dist newer than its src': newer(
    path.join(REPO, 'packages/cad-simple-viewer/dist/cad-simple-viewer.js'),
    path.join(REPO, 'packages/cad-simple-viewer/src/view/AcTrView2d.ts')
  ),
  'three-renderer dist newer than its src': newer(
    path.join(REPO, 'packages/three-renderer/dist/index.js'),
    path.join(REPO, 'packages/three-renderer/src/batch/AcTrBatchedGroup.ts')
  ),
  'cad-viewer data-model copy matches realdwg-web dist': (() => {
    const a = path.join(store, 'dist/data-model.cjs')
    const b = path.join(dataModel, 'dist/data-model.cjs')
    if (!fs.existsSync(a) || !fs.existsSync(b)) return null
    return sha256(a) === sha256(b)
  })()
}

const payload = {
  phase: '2.10',
  generatedAt: new Date().toISOString(),
  node: process.version,
  artifacts,
  freshness
}
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify(payload, null, 2))
