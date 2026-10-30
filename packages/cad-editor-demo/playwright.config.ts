import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://127.0.0.1:${PORT}`
/**
 * Phase 2.12 Task E runs the same spec against the dev server and against the
 * production bundle. A scheduling change can look different once Vite stops
 * serving module-per-file and the tree is minified, so `P212_SERVE=prod`
 * switches the webServer to `vite preview` over an existing `dist`.
 *
 *   pnpm --filter @mlightcad/cad-editor-demo exec vite build
 *   $env:P212_SERVE='prod'; npx playwright test e2e/tests/phase212-browser-ab.spec.ts
 */
const SERVE = process.env.P212_SERVE === 'prod' ? 'preview' : 'dev'
const defaultChannel = process.platform === 'win32' ? 'msedge' : 'chrome'
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? defaultChannel

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: {
    command: `pnpm ${SERVE} --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    // Avoid accidentally reusing unrelated local processes that happen to bind the port.
    // We always start a dedicated Vite server for e2e to keep behavior stable across shells.
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: browserChannel }
    }
  ]
})
