# Phase 2.12 measurement driver.
#
# Every cell starts its own Vite server (reuseExistingServer = false), so each
# invocation costs ~30 s of startup. The presets below spell out the cells the
# spec asks for so a run is one command instead of a hand-typed environment.
#
#   pwsh -File e2e\helpers\run-phase212.ps1 -Preset b
#   pwsh -File e2e\helpers\run-phase212.ps1 -Preset e50k -Suffix before
#   pwsh -File e2e\helpers\run-phase212.ps1 -Preset e50k -Serve prod -Suffix prod
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('b', 'b-arrays', 'e1k', 'e10k', 'e50k', 'e100k', 'slot', 'glyph')]
  [string]$Preset,
  [string]$Suffix = 'after',
  # `dev` serves the Vite dev server, `prod` serves `vite preview` over `dist/`.
  # `vite build` alone is not enough: worker and converter assets are copied by
  # `pnpm copy:workers` afterwards, and without it the document never opens.
  [ValidateSet('dev', 'prod')]
  [string]$Serve = 'dev',
  # Interleaved A/B: `baseline` (scheduler off) is always included, and every
  # entry here adds one `after` arm with that yield budget in ms. Phase 2.12
  # Task C studies 16 / 32 / 64, so the default preset sweeps all three.
  [string]$Budgets = '16,32,64',
  [int]$Rounds = 20
)

# Windows PowerShell 5.1 turns any native stderr line into a terminating error
# when $ErrorActionPreference is Stop, and npx always writes a deprecation
# warning to stderr. Gate on $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$reportsDir = Join-Path $repoRoot 'reports\phase212'
New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
Set-Location (Join-Path $repoRoot 'packages\cad-editor-demo')

if ($Serve -eq 'prod') {
  Write-Output '=== production build ==='
  # A plain `vite build` keeps `window.AcApDocManager` private; the flag is what
  # phase 2.8 used for dev-vs-prod. It is inlined at build time, so it has to be
  # set here rather than at test time.
  $env:VITE_E2E_EXPOSE_MANAGER = 'true'
  npx vite build *> (Join-Path $reportsDir "build-$Suffix.log")
  if ($LASTEXITCODE -ne 0) { throw "vite build failed with exit code $LASTEXITCODE" }
  pnpm run copy:workers *>> (Join-Path $reportsDir "build-$Suffix.log")
  if ($LASTEXITCODE -ne 0) { throw "copy:workers failed with exit code $LASTEXITCODE" }
}

function Invoke-Cell {
  param([hashtable]$Env, [string]$Grep, [string]$Log, [string]$Spec)
  Set-Item -Path 'env:P212_SERVE' -Value $Serve
  foreach ($key in $Env.Keys) { Set-Item -Path "env:$key" -Value $Env[$key] }
  Write-Output "=== $Log ==="
  npx playwright test "e2e/tests/$Spec" -g $Grep --timeout=3600000 --workers=1 --reporter=list *> (Join-Path $reportsDir $Log)
  $exitCode = $LASTEXITCODE
  Get-Content (Join-Path $reportsDir $Log) |
    Select-String -Pattern 'passed|failed|phase212\]' |
    Select-Object -Last 8 | ForEach-Object { $_.Line }
  if ($exitCode -ne 0) { throw "$Log failed with exit code $exitCode" }
}

$profileSpec = 'phase212-move-conversion.spec.ts'
$abSpec = 'phase212-browser-ab.spec.ts'

switch ($Preset) {
  'b' {
    # Task B — the 50k mixed fixture, snapshot sharing on, slot reuse on.
    Invoke-Cell -Spec $profileSpec -Grep 'MOVE conversion profile' -Log "b-move50000-$Suffix.log" -Env @{
      P212_SIZE = '50000'; P212_TAG = "move50000$(if ($Suffix -ne 'after') { "-$Suffix" })"
      P212_SHARING = 'on'
    }
  }
  'b-arrays' {
    # Task B2 cross-check: the same command without the typed-array argument
    # path, to separate conversion cost from entity-service cost.
    Invoke-Cell -Spec $profileSpec -Grep 'MOVE conversion profile' -Log "b-move50000-arrays-$Suffix.log" -Env @{
      P212_SIZE = '50000'; P212_TAG = "move50000-arrays$(if ($Suffix -ne 'after') { "-$Suffix" })"
      P212_SHARING = 'on'; P212_FIXTURE = 'arrays'
    }
  }
  'e1k' {
    Invoke-Cell -Spec $abSpec -Grep 'MOVE A/B' -Log "e-1k-$Suffix.log" -Env @{
      P212_AB_SIZE = '1000'; P212_AB_ROUNDS = "$Rounds"; P212_AB_BUDGETS = $Budgets
      P212_AB_TAG = "e1k$(if ($Suffix -ne 'after') { "-$Suffix" })"
    }
  }
  'e10k' {
    Invoke-Cell -Spec $abSpec -Grep 'MOVE A/B' -Log "e-10k-$Suffix.log" -Env @{
      P212_AB_SIZE = '10000'; P212_AB_ROUNDS = "$Rounds"; P212_AB_BUDGETS = $Budgets
      P212_AB_TAG = "e10k$(if ($Suffix -ne 'after') { "-$Suffix" })"
    }
  }
  'e50k' {
    Invoke-Cell -Spec $abSpec -Grep 'MOVE A/B' -Log "e-50k-$Suffix.log" -Env @{
      P212_AB_SIZE = '50000'; P212_AB_ROUNDS = "$Rounds"; P212_AB_BUDGETS = $Budgets
      P212_AB_TAG = "e50k$(if ($Suffix -ne 'after') { "-$Suffix" })"
    }
  }
  'e100k' {
    Invoke-Cell -Spec $abSpec -Grep 'MOVE A/B' -Log "e-100k-$Suffix.log" -Env @{
      P212_AB_SIZE = '100000'; P212_AB_ROUNDS = "$Rounds"; P212_AB_BUDGETS = $Budgets
      P212_AB_TAG = "e100k$(if ($Suffix -ne 'after') { "-$Suffix" })"
    }
  }
  'slot' {
    # Task F — the phase 2.11 slot matrix, re-run on the 2.12 tree.
    Invoke-Cell -Spec 'phase211-slot-lifecycle.spec.ts' -Grep 'slot convergence' -Log "f-slot-$Suffix.log" -Env @{
      P211_SIZE = '10000'; P211_ROUNDS = '20'; P211_OPS = 'erase,move'
      P211_TAG = "f2-$Suffix"; P211_SHARING = 'default'
    }
  }
  'glyph' {
    # Task A2 — MTEXT / glyph slot lifecycle. This one is a Jest suite, not an
    # e2e spec: the glyph world batch is pure geometry bookkeeping with no
    # browser dependency, so a Playwright cell would only add a server to the
    # loop. Run from the repo root so the workspace tsconfig paths resolve.
    Write-Output '=== a2-glyph-slot.log ==='
    Push-Location $repoRoot
    npx jest packages/three-renderer/__tests__/AcTrMeshGlyphWorldBatchSlotLifecycle.spec.ts `
      *> (Join-Path $reportsDir "a2-glyph-$Suffix.log")
    $exitCode = $LASTEXITCODE
    Pop-Location
    Get-Content (Join-Path $reportsDir "a2-glyph-$Suffix.log") |
      Select-String -Pattern 'Tests:|Suites:|failed' |
      Select-Object -Last 4 | ForEach-Object { $_.Line }
    if ($exitCode -ne 0) { throw "a2-glyph-$Suffix.log failed with exit code $exitCode" }
  }
}
