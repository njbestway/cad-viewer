#!/usr/bin/env node
/**
 * Phase 2.12 Task A1 — close-out manifest for the Phase 2.11 candidate commit.
 *
 * The Phase 2.11 evidence was produced from a working tree that was never
 * committed, so "which source produced these numbers" has to be answered by a
 * manifest instead of a `git log`. This tool captures everything a later reader
 * needs to re-derive the same build:
 *
 * - the exact staged set (path, index status, blob id) plus the full staged diff
 *   bundle and its SHA256,
 * - the realdwg-web source identity — which is *not* its HEAD, see `risk` below,
 * - the data-model tarball and the digest of the installed copy,
 * - the renderer build artifacts the measurements ran against,
 * - toolchain versions and the verbatim test commands,
 * - the rollback recipe.
 *
 * `reports/` is git-ignored, so none of this lands in the commit itself; the
 * manifest points at the artifacts by path + digest.
 *
 *   node tools/phase212-closeout-manifest.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const outDir = path.join(repoRoot, 'reports', 'phase212')
const realdwgRoot = path.resolve(repoRoot, '..', 'realdwg-web')

const git = (args, cwd = repoRoot) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).replace(/\r\n/g, '\n')

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex').toUpperCase()

const fileDigest = file => {
  const bytes = readFileSync(file)
  return { file: path.relative(repoRoot, file).replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes) }
}

/** Stable digest over a directory tree: `relpath:sha256` lines, sorted. */
const treeDigest = dir => {
  const lines = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) lines.push(`${path.relative(dir, full).replace(/\\/g, '/')}:${sha256(readFileSync(full))}`)
    }
  }
  walk(dir)
  return { files: lines.length, sha256: sha256(lines.join('\n')) }
}

mkdirSync(outDir, { recursive: true })

/* ------------------------------------------------------------ cad-viewer */

const stagedRaw = git(['diff', '--cached', '--name-status']).trim()

/**
 * Which phase owns a staged path. Task A1 asks for a standalone, checkoutable
 * Phase 2.11 commit, so the index has to be splittable afterwards: corrections
 * to Phase 2.11 reports ship *with* the Phase 2.11 commit (otherwise the commit
 * still carries the wrong aggregation claim), while Phase 2.12 tooling does not.
 */
const phaseOf = file =>
  /(^|\/)phase212-/.test(file) || /(^|\/)PHASE212_/.test(file) ? 'phase212' : 'phase211'

const staged = stagedRaw
  .split('\n')
  .filter(Boolean)
  .map(line => {
    const [status, ...rest] = line.split('\t')
    const file = rest[rest.length - 1]
    const normalized = file.replace(/\\/g, '/')
    return {
      status,
      path: normalized,
      phase: phaseOf(normalized),
      blob: git(['rev-parse', `:${file}`]).trim()
    }
  })

/**
 * `.gitignore:62` is the glob "star-star slash __tests__ slash", so every
 * regression spec under a `__tests__` directory is invisible to a plain
 * `git add -A`. Phase 2.11 shipped three such specs only because they were
 * force-added; a rebuilt index silently dropped them. This flags the ones the
 * index currently holds so the next `git add -A` cannot lose them without a
 * visible diff in this count.
 */
const ignoredButStaged = staged.filter(entry => /(^|\/)__tests__\//.test(entry.path)).map(entry => entry.path)

// The index must equal the working tree, otherwise the numbers in the reports
// were produced by code the commit does not contain. Phase 2.11 shipped exactly
// that defect: the index still pointed data-model at perf.1 while the measured
// install was perf.4, and AcTrView2d.ts imported an untracked module.
// The vendor tarballs are binary and already hashed individually, so they are
// excluded from the diff bundle: including them would turn a reviewable 400 KB
// patch into a 12 MB blob.
const stagedDiff = git(['diff', '--cached', '--binary', '--', '.', ':(exclude)vendor'])
const unstagedDiff = git(['diff', '--binary'])
const diffFile = path.join(outDir, 'cad-viewer-phase212-base.diff')
writeFileSync(diffFile, stagedDiff)

const residual = git(['status', '--porcelain', '--untracked-files=all'])
  .split('\n')
  .filter(line => line && !/^(A|M|D|R|C)\s\s/.test(line))

/* ------------------------------------------------------------ realdwg-web */

const realdwg = { path: realdwgRoot, present: existsSync(realdwgRoot) }
if (realdwg.present) {
  realdwg.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], realdwgRoot).trim()
  realdwg.head = git(['rev-parse', 'HEAD'], realdwgRoot).trim()
  realdwg.headSubject = git(['log', '-1', '--pretty=%s'], realdwgRoot).trim()
  const pkg = 'packages/data-model/package.json'
  realdwg.workTreeVersion = JSON.parse(readFileSync(path.join(realdwgRoot, pkg), 'utf8')).version
  realdwg.headVersion = JSON.parse(git(['show', `HEAD:${pkg}`], realdwgRoot)).version
  realdwg.dirtyFiles = git(['diff', '--name-only'], realdwgRoot).split('\n').filter(Boolean)
  const realdwgDiff = git(['diff', '--binary'], realdwgRoot)
  const realdwgDiffFile = path.join(outDir, 'realdwg-web-uncommitted.diff')
  writeFileSync(realdwgDiffFile, realdwgDiff)
  realdwg.diffBundle = { ...fileDigest(realdwgDiffFile) }
  realdwg.diffStat = git(['diff', '--shortstat'], realdwgRoot).trim()
  realdwg.commitSha = null
  realdwg.risk =
    `HEAD is ${realdwg.headVersion} but the tarball shipped to cad-viewer is ` +
    `${realdwg.workTreeVersion}, built from ${realdwg.dirtyFiles.length} uncommitted files. ` +
    'The data-model SHA256 therefore pins a tarball, not a commit: realdwg-web must be committed ' +
    'and the tarball rebuilt before the numbers can be reproduced from source alone.'
}

/* ------------------------------------------------------------ data-model */

const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
const activeTarball = workspaceYaml.match(/'@mlightcad\/data-model':\s*'file:(vendor\/[^']+)'/)?.[1] ?? null
const vendorDir = path.join(repoRoot, 'vendor')
const vendor = existsSync(vendorDir)
  ? readdirSync(vendorDir)
      .filter(name => name.endsWith('.tgz'))
      .sort()
      .map(name => ({ ...fileDigest(path.join(vendorDir, name)), active: `vendor/${name}` === activeTarball }))
  : []

const dataModel = { activeTarball, vendor, installed: null }
try {
  const require = createRequire(path.join(repoRoot, 'packages', 'cad-simple-viewer', 'package.json'))
  // `exports` does not always expose `./package.json`, so walk up from the
  // resolved entry point to the package root instead of assuming it.
  const findPackageRoot = start => {
    let current = path.dirname(start)
    for (;;) {
      const candidate = path.join(current, 'package.json')
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === '@mlightcad/data-model') {
        return candidate
      }
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  const manifestPath = findPackageRoot(require.resolve('@mlightcad/data-model'))
  const installedRoot = path.dirname(manifestPath)
  const installedPkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const distDir = path.join(installedRoot, 'dist')
  dataModel.installed = {
    version: installedPkg.version,
    root: path.relative(repoRoot, installedRoot).replace(/\\/g, '/'),
    dist: existsSync(distDir) ? treeDigest(distDir) : null,
    // `file:` tarballs are unpacked with their own mtimes, so the tree digest is
    // the only portable identity for the installed copy.
    note: 'dist digest = SHA256 over sorted "<relpath>:<sha256>" lines'
  }
} catch (error) {
  dataModel.installed = { error: String(error?.message ?? error) }
}

/* ------------------------------------------------------------ build artifacts */

const artifactCandidates = [
  'packages/three-renderer/dist/index.js',
  'packages/three-renderer/dist/index.umd.cjs',
  'packages/cad-simple-viewer/dist/cad-simple-viewer.js',
  'packages/cad-simple-viewer/dist/cad-simple-viewer.umd.cjs',
  'packages/cad-simple-viewer/dist/mtext-renderer-worker.js'
]
const artifacts = artifactCandidates
  .filter(rel => existsSync(path.join(repoRoot, rel)))
  .map(rel => {
    const digest = fileDigest(path.join(repoRoot, rel))
    return { ...digest, mtime: statSync(path.join(repoRoot, rel)).mtime.toISOString() }
  })
const demoDist = path.join(repoRoot, 'packages', 'cad-editor-demo', 'dist')
if (existsSync(demoDist)) {
  // The production A/B arm serves this tree; a whole-tree digest keeps a rebuilt
  // bundle from silently passing as the measured one.
  artifacts.push({ file: 'packages/cad-editor-demo/dist', ...treeDigest(demoDist) })
}

/* ------------------------------------------------------------ toolchain */

const version = (cmd, args, cwd = repoRoot) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return 'unavailable'
  }
}
const toolchain = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  pnpm: version('pnpm', ['--version']),
  playwright: (() => {
    try {
      const require = createRequire(path.join(repoRoot, 'packages', 'cad-editor-demo', 'package.json'))
      return require('@playwright/test/package.json').version
    } catch {
      return 'unavailable'
    }
  })(),
  chromium: 'Microsoft Edge 156.0.4314.50 (playwright channel: msedge, headless)'
}

/* ------------------------------------------------------------ evidence */

/**
 * Every raw artifact this phase produced, by path and digest.
 *
 * `reports/` is git-ignored, so this list *is* the archive manifest: a reviewer
 * can walk it, hash the file they were given, and compare. Files above
 * `LARGE_FILE_BYTES` (the 417 MB decompressed heap snapshot) are listed by size
 * only, because hashing them costs more than the value it adds.
 */
const LARGE_FILE_BYTES = 20 * 1024 * 1024
const evidenceRoot = path.join(repoRoot, 'reports', 'phase212')
const evidence = []
const walkEvidence = dir => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkEvidence(full)
      continue
    }
    // The manifest cannot include itself: its digest would change as it is written.
    if (full === path.join(evidenceRoot, 'phase212-git-state.json')) continue
    const bytes = statSync(full).size
    const rel = path.relative(repoRoot, full).replace(/\\/g, '/')
    evidence.push(
      bytes > LARGE_FILE_BYTES
        ? { file: rel, bytes, sha256: null, note: 'not hashed: exceeds 20 MB' }
        : { file: rel, bytes, sha256: fileDigest(full).sha256 }
    )
  }
}
walkEvidence(evidenceRoot)

/* ------------------------------------------------------------ manifest */

const manifest = {
  phase: '2.12',
  task: 'A1',
  generatedAt: new Date().toISOString(),
  note:
    'No commit is made by the agent: the user commits. `commitSha` stays null until then; ' +
    '`headAtCapture` is the base the staged diff applies to.',
  cadViewer: {
    path: repoRoot.replace(/\\/g, '/'),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    headAtCapture: git(['rev-parse', 'HEAD']).trim(),
    headSubject: git(['log', '-1', '--pretty=%s']).trim(),
    commitSha: null,
    staged: {
      count: staged.length,
      added: staged.filter(entry => entry.status === 'A').length,
      modified: staged.filter(entry => entry.status === 'M').length,
      deleted: staged.filter(entry => entry.status === 'D').length,
      files: staged
    },
    indexMatchesWorkTree: unstagedDiff.trim().length === 0,
    splitByPhase: {
      phase211: staged.filter(entry => entry.phase === 'phase211').length,
      phase212: staged.filter(entry => entry.phase === 'phase212').length,
      howToSplit: [
        'git stash push --keep-index --include-untracked   # park Phase 2.12 work',
        'git commit -m "Phase 2.11 slot lifecycle"          # the standalone baseline',
        'git stash pop'
      ]
    },
    gitignoreTraps: {
      rule: '.gitignore:62 `**/__tests__/` ignores every test directory, so `git add -A` skips them',
      stagedUnderTestsDir: ignoredButStaged.length,
      files: ignoredButStaged,
      forceAdd: 'git add -f <spec>   # required for any new file under __tests__/' 
    },
    excludedOnPurpose: [
      'packages/cad-editor-demo/.tmp-p28/**  (throwaway prod-boot screenshots)',
      'packages/cad-editor-demo/.tmp-p28-prod-*.mjs  (throwaway boot probes)',
      '.tmp-p28/**  (repo-root scratch from the phase 2.8 investigation: analysis scripts and a 43 KB view2d.diff; pre-existing, not this phase\'s)',
      'reports/phase212/hs1-r100.heapsnapshot  (417 MB, decompressed from the 62 MB .gz in reports/phase211)'
    ],
    diffBundle: fileDigest(diffFile),
    residualUntracked: residual,
    notTracked: {
      reports:
        '`reports` is git-ignored (.gitignore) on purpose: the trace for a single 50k run is 4.1 MB ' +
        'and the phase 2.11 heap snapshots are 62 MB gzipped each. Artifacts are referenced here by ' +
        'path + digest instead of riding in git history.',
      forceAdd: 'git add -f reports/phase212  # only if a review really needs the raw bytes in-tree'
    }
  },
  realdwgWeb: realdwg,
  dataModel,
  buildArtifacts: artifacts,
  buildArtifactsNote:
    '`packages/cad-simple-viewer/dist` was rebuilt during Task E (2026-10-30) because `vite build` '
    + 'of the demo consumes that dist, not `src`. The digests below are therefore the Phase 2.12 '
    + 'artifacts; the Phase 2.11 numbers recorded before the rebuild no longer describe the tree. '
    + 'Check `mtime` per file before quoting a digest.',
  evidence: {
    root: 'reports/phase212',
    note:
      'Raw evidence is git-ignored by design (`.gitignore` rule `reports`). This list is the archive '
      + 'manifest: path + bytes + SHA256 for every artifact, with the single oversized file called out.',
    count: evidence.length,
    files: evidence
  },
  toolchain,
  testCommands: [
    'npx jest packages/three-renderer packages/cad-simple-viewer   # 196 suites / 1343 tests',
    'npx jest packages/three-renderer/__tests__/AcTrMeshGlyphWorldBatchSlotLifecycle.spec.ts   # Task A2 glyph slots, 8 tests',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset e1k -Rounds 20',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset e10k -Rounds 20',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset e50k -Rounds 20',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset e50k -Serve prod -Suffix prod -Rounds 20',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset e100k -Serve prod -Suffix prod -Rounds 8   # fixture does not open',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset b -Suffix ""   # baseline 50k profile + trace',
    'P212_SCHED=1 P212_SCHED_BUDGET=16 powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset b -Suffix after   # after profile + trace',
    'node tools/phase212-profile-analyze.mjs move50000 move50000-after',
    'powershell -NoProfile -File packages/cad-editor-demo/e2e/helpers/run-phase212.ps1 -Preset slot -Suffix after   # phase 2.11 matrix: fails at fixture open, see F report 6.1'
  ],
  rollback: {
    beforeCommit: [
      'git reset            # drop the whole staged set, working tree untouched',
      'git restore --staged .   # same effect, keeps the index vs worktree split explicit'
    ],
    afterCommit: [
      'git reset --soft HEAD~1   # keep the tree, unstage the commit (safe: local only)',
      'git checkout <headAtCapture> -- .   # only if the tree itself must be reverted',
      'pnpm install              # restores node_modules to the pre-commit data-model pin'
    ],
    dataModel: [
      `revert pnpm-workspace.yaml to the previous tarball override and re-run pnpm install`,
      `the previous pin is recorded in this manifest under dataModel.vendor (active=false entries)`
    ],
    caveat:
      'Rolling back the commit does NOT roll back realdwg-web: that repo is dirty and its uncommitted ' +
      'diff is preserved at reports/phase212/realdwg-web-uncommitted.diff.'
  }
}

const outFile = path.join(outDir, 'phase212-git-state.json')
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`staged           ${manifest.cadViewer.staged.count} files (${staged.filter(s => s.status === 'A').length} added, ${staged.filter(s => s.status === 'M').length} modified, ${staged.filter(s => s.status === 'D').length} deleted)`)
console.log(`split             phase211 ${manifest.cadViewer.splitByPhase.phase211} / phase212 ${manifest.cadViewer.splitByPhase.phase212}`)
console.log(`under __tests__  ${ignoredButStaged.length} staged only via git add -f`)
console.log(`index==worktree  ${manifest.cadViewer.indexMatchesWorkTree}`)
console.log(`diff bundle      ${manifest.cadViewer.diffBundle.bytes} B  ${manifest.cadViewer.diffBundle.sha256}`)
console.log(`data model       ${dataModel.activeTarball}  ${dataModel.vendor.find(v => v.active)?.sha256 ?? 'missing'}`)
console.log(`evidence         ${evidence.length} files under reports/phase212`)
console.log(`installed        ${dataModel.installed?.version ?? '?'}  dist ${dataModel.installed?.dist?.sha256 ?? '-'}`)
console.log(`realdwg-web      HEAD ${realdwg.head?.slice(0, 8) ?? '-'} (${realdwg.headVersion ?? '?'})  tree ${realdwg.workTreeVersion ?? '?'}  dirty ${realdwg.dirtyFiles?.length ?? 0}`)
console.log(`wrote            ${path.relative(repoRoot, outFile).replace(/\\/g, '/')}`)
