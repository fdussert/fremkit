/**
 * End-to-end tests of the admin and the dashboard, against the real server and the built UI.
 * See docs/contributing.md: `pnpm --filter ui build && pnpm e2e`.
 *
 * Chromium always; WebKit too when its Playwright build is installed, because the kiosk and the
 * admin windows of the helper are WebKit. CI installs Chromium only.
 */
import { existsSync } from 'node:fs'
import { defineConfig, devices, webkit } from '@playwright/test'
import { MAX_WORKERS } from './fixtures/server.js'

const ci = !!process.env.CI
const withWebkit = process.env.E2E_WEBKIT !== '0' && existsSync(webkit.executablePath())

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  // One server per worker, on ports 4330–4339 (or from E2E_FIRST_PORT).
  workers: ci ? 2 : Math.min(4, MAX_WORKERS),
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // The editor fits the Edge's 2560 px board into what is left of the window: a wide one keeps
    // a grid cell several pixels across, so mouse drags land on the cell they aim at.
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    ...(withWebkit ? [{ name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1920, height: 1080 } } }] : []),
  ],
})
