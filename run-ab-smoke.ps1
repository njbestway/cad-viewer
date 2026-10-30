# Phase 2.9 Task F smoke — mechanics only, deliberately small so a bug in the
# arm/interleave bookkeeping surfaces in minutes instead of hours.
$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

$env:P29AB_SIZE = '10000'
$env:P29AB_SAMPLES = '2'
$env:P29AB_OPS = 'erase'
$env:P29AB_ARMS = 'both,none,discard,yield'
$env:P29AB_BUDGETS = '64,32'
$env:P29AB_TAG = 'smoke'

npx playwright test e2e/tests/phase29-latency-ab.spec.ts --workers=1 --reporter=line
