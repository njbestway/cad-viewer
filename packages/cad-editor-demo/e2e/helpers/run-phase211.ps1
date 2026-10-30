# Phase 2.11 measurement driver.
#
# One dev server per invocation is expensive (about 30 s on this machine) and a
# dozen cells make the matrix tedious to type, so the runs are spelled out here.
# Every cell writes its own log; the JSON rows are merged by tag/size/rounds/op.
#
#   pwsh -File e2e\helpers\run-phase211.ps1 -Preset f
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('f', 'k1', 'k10', 'k50', 'race', 'close')]
  [string]$Preset,
  [string]$Suffix = 'after',
  # Optional arm filter; lets one cell per invocation fit a foreground shell.
  [ValidateSet('', 'on', 'off')]
  [string]$Arm = ''
)

# Windows PowerShell 5.1 turns any native stderr line into a terminating error when
# $ErrorActionPreference is Stop, and npx always writes a deprecation warning to
# stderr. Keep the preference at Continue and gate on $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$reportsDir = Join-Path $repoRoot 'reports\phase211'
Set-Location (Join-Path $repoRoot 'packages\cad-editor-demo')

function Invoke-Cell {
  param([hashtable]$Env, [string]$Grep, [string]$Log, [string]$Spec)
  foreach ($key in $Env.Keys) { Set-Item -Path "env:$key" -Value $Env[$key] }
  Write-Output "=== $Log ==="
  npx playwright test "e2e/tests/$Spec" -g $Grep --timeout=3600000 --workers=1 --reporter=list *> (Join-Path $reportsDir $Log)
  $exitCode = $LASTEXITCODE
  Get-Content (Join-Path $reportsDir $Log) | Select-String -Pattern 'passed|failed|phase211\]' | Select-Object -Last 6 | ForEach-Object { $_.Line }
  if ($exitCode -ne 0) { throw "$Log failed with exit code $exitCode" }
}

$slotSpec = 'phase211-slot-lifecycle.spec.ts'

switch ($Preset) {
  'f' {
    # Task F — 50k, both snapshot-sharing arms, ERASE and MOVE.
    if ($Arm -ne 'off') {
      Invoke-Cell -Spec $slotSpec -Grep 'slot convergence' -Log "f-50k-on-$Suffix.log" -Env @{
        P211_SIZE = '50000'; P211_ROUNDS = '6'; P211_OPS = 'erase,move'
        P211_TAG = "f50b-on"; P211_SHARING = 'on'
      }
    }
    if ($Arm -ne 'on') {
      Invoke-Cell -Spec $slotSpec -Grep 'slot convergence' -Log "f-50k-off-$Suffix.log" -Env @{
        P211_SIZE = '50000'; P211_ROUNDS = '6'; P211_OPS = 'erase,move'
        P211_TAG = "f50b-off"; P211_SHARING = 'off'
      }
    }
  }
  'k1' {
    # Task E — the reuse-pattern cell, three independent sessions.
    foreach ($session in 1..3) {
      Invoke-Cell -Spec $slotSpec -Grep 'slot convergence' -Log "e1-k1-session$session-$Suffix.log" -Env @{
        P211_SIZE = '1000'; P211_ROUNDS = '100'; P211_OPS = 'erase,move'
        P211_TAG = "k1$(if ($session -gt 1) { [char](96 + $session) })"; P211_SHARING = 'default'
      }
    }
  }
  'k10' {
    # Task E — long session heap convergence.
    Invoke-Cell -Spec $slotSpec -Grep 'slot convergence' -Log "e1-k10-$Suffix.log" -Env @{
      P211_SIZE = '10000'; P211_ROUNDS = '50'; P211_OPS = 'erase,move'
      P211_TAG = 'k10b'; P211_SHARING = 'default'
    }
  }
  'k50' {
    # Task E — publish-level capacity cell (the 50k x 50 budget cell runs last).
    Invoke-Cell -Spec $slotSpec -Grep 'slot convergence' -Log "e1-k50-$Suffix.log" -Env @{
      P211_SIZE = '50000'; P211_ROUNDS = '20'; P211_OPS = 'erase,move'
      P211_TAG = 'k50b'; P211_SHARING = 'default'
    }
  }
  'race' {
    # Task D16/D17/D18 plus the close-document release test.
    Invoke-Cell -Spec $slotSpec -Grep 'D16|D17|D18|close document' -Log "d-race-$Suffix.log" -Env @{
      P211_SIZE = '300'; P211_ROUNDS = '4'; P211_OPS = 'erase'; P211_TAG = 'race'; P211_SHARING = 'default'
    }
  }
  'close' {
    Invoke-Cell -Spec $slotSpec -Grep 'close document' -Log "d-close-$Suffix.log" -Env @{
      P211_SIZE = '300'; P211_ROUNDS = '4'; P211_OPS = 'erase'; P211_TAG = 'close'; P211_SHARING = 'default'
    }
  }
}
