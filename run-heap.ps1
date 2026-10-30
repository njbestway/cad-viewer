# Phase 2.9 heap attribution driver.
#
# Two V8 heap snapshots around a fixed number of ERASE/Undo/Redo rounds; the
# diff is produced afterwards by tools/phase29-heap-diff.mjs. Not a gate.
param(
  [string]$Size = '5000',
  [string]$Rounds = '8',
  [string]$Tag = 'heap',
  [string]$Sampling = '1'
)

$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

$env:P29H_SIZE = $Size
$env:P29H_ROUNDS = $Rounds
$env:P29H_TAG = $Tag
$env:P29H_SAMPLING = $Sampling

npx playwright test e2e/tests/phase29-heap-attribution.spec.ts --workers=1 --reporter=line