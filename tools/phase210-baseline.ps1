# Phase 2.10 Task A1 - immutable integration baseline for cad-viewer.
#
# Phase 2.6-2.9 were never committed, so there is no per-phase commit to diff
# against and none will be invented. What this writes instead is a restorable
# baseline: the tracked diff vs HEAD, a tar of every untracked file, and a
# manifest that pins the toolchain, the data-model resolution chain and the
# vendored tarball hashes. Restore = `git apply` the diff + untar the archive.
$ErrorActionPreference = 'Stop'
$repo = 'E:\rustpro\cad-viewer'
$out = Join-Path $repo 'reports\phase210'
New-Item -ItemType Directory -Path $out -Force | Out-Null

Push-Location $repo

git diff HEAD --output (Join-Path $out 'cadviewer-baseline-tracked.diff')

$untracked = git ls-files --others --exclude-standard
$untracked | Out-File -Encoding utf8 (Join-Path $out 'cadviewer-baseline-untracked.txt')
$listFile = Join-Path $out 'untracked-for-tar.txt'
# tar.exe rejects a BOM, which Set-Content -Encoding utf8 adds on PowerShell 5.1.
[System.IO.File]::WriteAllLines($listFile, $untracked, (New-Object System.Text.UTF8Encoding($false)))
if ($untracked.Count -gt 0) {
  cmd /c "tar -czf `"$out\cadviewer-baseline-untracked.tar.gz`" -T `"$listFile`""
}
Remove-Item $listFile -Force

$manifest = @()
$manifest += "phase 2.10 baseline manifest"
$manifest += "generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$manifest += ''
$manifest += '## cad-viewer'
$manifest += "HEAD: $(git rev-parse HEAD)"
$manifest += "branch: $(git rev-parse --abbrev-ref HEAD)"
$manifest += "head-subject: $(git log -1 --pretty=%s)"
$manifest += "head-date: $(git log -1 --pretty=%ci)"
$manifest += "tracked-changes: $((git status --porcelain | Where-Object { $_ -notmatch '^\?\?' }).Count) entries"
$manifest += "untracked-files: $($untracked.Count)"
$manifest += ''
$manifest += '## toolchain'
$manifest += "node: $(node --version)"
$manifest += "pnpm: $(pnpm --version)"
$manifest += ''
$manifest += '## data-model resolution chain'
$manifest += (Select-String -Path (Join-Path $repo 'pnpm-workspace.yaml') -Pattern 'data-model').Line.Trim()
$dmPath = Join-Path $repo 'packages\cad-simple-viewer\node_modules\@mlightcad\data-model'
$manifest += "resolved: $((Get-Item $dmPath).LinkTarget)"
$manifest += "installed: $((Get-Content (Join-Path $dmPath 'package.json') | Select-String -Pattern '\"version\"').Line.Trim())"
$manifest += ''
$manifest += '## vendored data-model tarballs'
foreach ($file in Get-ChildItem (Join-Path $repo 'vendor') -Filter '*.tgz' | Sort-Object Name) {
  $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
  $manifest += ('{0}  {1}  {2} bytes' -f $hash, $file.Name, $file.Length)
}
$manifest += ''
$manifest += '## realdwg-web (source of the vendored tarballs)'
Push-Location 'E:\rustpro\realdwg-web'
$manifest += "HEAD: $(git rev-parse HEAD)"
$manifest += "branch: $(git rev-parse --abbrev-ref HEAD)"
$manifest += "head-subject: $(git log -1 --pretty=%s)"
$manifest += "data-model version: $((Get-Content 'packages\data-model\package.json' | Select-String -Pattern '\"version\"').Line.Trim())"
$manifest += "working-tree: $((git status --porcelain).Count) entries"
Pop-Location

$manifest | Out-File -Encoding utf8 (Join-Path $out 'BASELINE_MANIFEST.txt')

Pop-Location
Get-Content (Join-Path $out 'BASELINE_MANIFEST.txt')
