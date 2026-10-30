# Snapshots the repository state that phase 2.9 has to be delivered with: the
# tracked diff against HEAD, a status file, the list of new (still untracked)
# files, and the SHA256 of every vendored data-model tarball. Re-run it after
# any change so the archive always matches the tree it describes.
$ErrorActionPreference = 'Stop'
$repo = 'E:\rustpro\cad-viewer'
$out = Join-Path $repo 'reports\phase29'
New-Item -ItemType Directory -Path $out -Force | Out-Null

Push-Location $repo

git diff HEAD --output (Join-Path $out 'phase29-tracked.diff')

$status = @()
$status += "HEAD: $(git rev-parse HEAD)"
$status += "branch: $(git rev-parse --abbrev-ref HEAD)"
$status += "head-subject: $(git log -1 --pretty=%s)"
$status += "head-date: $(git log -1 --pretty=%ci)"
$status += ''
$status += 'git status --porcelain:'
$status += (git status --porcelain)
$status | Out-File -Encoding utf8 (Join-Path $out 'phase29-status.txt')

$untracked = git ls-files --others --exclude-standard |
  Where-Object { $_ -match 'phase29|tools/phase29|run-(r20|r50|ab|heap|regression)|PHASE29' }
$untracked = @('new (untracked) files belonging to phase 2.9:') + $untracked
$untracked | Out-File -Encoding utf8 (Join-Path $out 'phase29-new-files.txt')

$sha = @('SHA256 of the vendored data-model tarballs:')
foreach ($file in Get-ChildItem (Join-Path $repo 'vendor') -Filter '*.tgz' | Sort-Object Name) {
  $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
  $sha += ('{0}  {1}  {2} bytes' -f $hash, $file.Name, $file.Length)
}
$sha | Out-File -Encoding utf8 (Join-Path $out 'phase29-vendor-sha256.txt')

Pop-Location
$diffLines = (Get-Content (Join-Path $out 'phase29-tracked.diff') | Measure-Object -Line).Lines
Write-Output "tracked diff: $diffLines lines"
Write-Output ('untracked phase 2.9 files: ' + ($untracked.Count - 1))
Get-Content (Join-Path $out 'phase29-vendor-sha256.txt')