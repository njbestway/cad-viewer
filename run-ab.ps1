# Phase 2.9 Task F driver — interleaved A/B of the two phase 2.8 switches.
#
# Args passed through to the spec as environment variables. Defaults here are the
# spec's own defaults (50k, 5 samples per arm, four arms, both operations), so a
# bare invocation is the reportable run.
param(
  [string]$Size = '50000',
  [string]$Samples = '5',
  [string]$Ops = 'erase,move',
  [string]$Arms = 'both,none,discard,yield',
  [string]$Budgets = '300,64,32',
  [string]$Tag = 'ab50k'
)

$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

$env:P29AB_SIZE = $Size
$env:P29AB_SAMPLES = $Samples
$env:P29AB_OPS = $Ops
$env:P29AB_ARMS = $Arms
$env:P29AB_BUDGETS = $Budgets
$env:P29AB_TAG = $Tag

npx playwright test e2e/tests/phase29-latency-ab.spec.ts --workers=1 --reporter=line
