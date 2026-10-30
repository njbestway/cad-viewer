# Phase 2.9 heap series driver.
#
# Two heap measurements of the same ERASE/Undo/Redo cycle at different entity
# counts, no V8 snapshots (each is ~450 MB) — the question here is only whether
# the per-round growth scales with the entity count (per-entity retention) or
# stays flat (per-round retention).
param(
  [string]$Rounds = '8'
)

$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

foreach ($size in @('5000', '10000')) {
  $env:P29H_SIZE = $size
  $env:P29H_ROUNDS = $Rounds
  $env:P29H_TAG = "heap$size"
  $env:P29H_SNAPSHOT = '0'
  $env:P29H_SAMPLING = if ($size -eq '10000') { '1' } else { '0' }
  Write-Output "=== size $size ==="
  npx playwright test e2e/tests/phase29-heap-attribution.spec.ts --workers=1 --reporter=line
}