# Phase 2.9 acceptance driver — the phase 2.6/2.7 regression set (R-8 and the
# bulk replay semantics), unchanged by this phase but required to stay green.
#
#   phase26-bulk-erase-single — one command, one undo boundary, one redo boundary
#   phase26-interaction       — 50k MOVE -> undo -> redo
#   phase26-lifecycle         — close the document while a convert is parked
#   phase27-bulk-replay       — R-8 load/convert race, two full replay rounds
$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

npx playwright test `
  e2e/tests/phase26-bulk-erase-single.spec.ts `
  e2e/tests/phase26-interaction.spec.ts `
  e2e/tests/phase26-lifecycle.spec.ts `
  e2e/tests/phase27-bulk-replay.spec.ts `
  --workers=1 --reporter=line