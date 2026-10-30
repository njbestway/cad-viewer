# Phase 2.9 Task D driver — 20-round 10k run.
#
# Kept in a script because the interactive PowerShell session cannot accept the
# long inline command (it lands in a continuation prompt and never executes).
$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

$env:P29_ROUND_SIZE = '10000'
$env:P29_ROUNDS = '20'
$env:P29_SESSIONS = '1'
$env:P29_ROUND_OPS = 'erase,move'
$env:P29_TAG = 'r20'

npx playwright test e2e/tests/phase29-resource-lifecycle.spec.ts --workers=1 --reporter=line
