# Phase 2.9 Task D driver — 50-round 10k run, three independent browser sessions.
#
# `P29_SESSIONS` is handled inside the spec: the session loop wraps the tests, so
# one invocation produces six serial runs (3 sessions x 2 operations) and each
# session gets a fresh browser context from Playwright.
$ErrorActionPreference = 'Stop'
Set-Location E:\rustpro\cad-viewer\packages\cad-editor-demo

$env:P29_ROUND_SIZE = '10000'
$env:P29_ROUNDS = '50'
$env:P29_SESSIONS = '3'
$env:P29_ROUND_OPS = 'erase,move'
$env:P29_TAG = 'r50'

npx playwright test e2e/tests/phase29-resource-lifecycle.spec.ts --workers=1 --reporter=line
