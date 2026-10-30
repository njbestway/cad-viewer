import { defineConfig, devices } from '@playwright/test'

/**
 * Production-build variant of `playwright.config.ts`.
 *
 * Phase 2.8 Task F asks for the browser numbers to be measured on both the dev
 * server and a production bundle: Vite's dev pipeline serves unminified modules
 * through a transform middleman, which changes parse/compile time and therefore
 * the long-task profile. Same tests, same fixtures, different bundle.
 *
 * `vite build` is called directly instead of `pnpm build` on purpose: the latter
 * runs `vue-tsc` first, and a type error in an unrelated demo file must not
 * block a performance measurement.
 *
 * `VITE_E2E_EXPOSE_MANAGER=true` is what makes the production bundle reachable
 * from a spec: `App.vue` only assigns `window.AcApDocManager` in dev builds or
 * when that flag is set. Without it every probe reads `undefined` and the run
 * hangs on its first poll instead of failing.
 *
 * ```powershell
 * $env:PLAYWRIGHT_BROWSER_CHANNEL='chrome'
 * npx playwright test -c playwright.prod.config.ts e2e/tests/phase28-erase-undo.spec.ts
 * ```
 */
const PORT = 4174
const BASE_URL = `http://127.0.0.1:${PORT}`
const defaultChannel = process.platform === 'win32' ? 'msedge' : 'chrome'
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? defaultChannel

// Exported before the web server is spawned, so `vite build` sees it. Setting it
// in the command line instead would have to be shell specific (`cmd.exe` and
// PowerShell disagree), and this file is the single place that decides the
// measurement bundle's configuration.
process.env.VITE_E2E_EXPOSE_MANAGER = 'true'

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-prod' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 420_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: browserChannel }
    }
  ]
})
