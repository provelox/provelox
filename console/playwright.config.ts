import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the console against a real Provelox API. They create and remove throwaway apps named e2e-*,
 * and never touch anything else. Point them at a running console:
 *
 *   E2E_PASSWORD=<admin password> npm run e2e                     (console on http://localhost:4300)
 *   E2E_BASE_URL=http://console.example.test E2E_PASSWORD=... npm run e2e
 *
 * They use the Chrome installed on the machine, so no browser is downloaded.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  // the first visit to a page can include the dev server compiling it
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4300',
    // The Chrome on this machine, so nothing is downloaded. CI sets E2E_CHANNEL=bundled to use Playwright's Chromium.
    channel: process.env.E2E_CHANNEL === 'bundled' ? undefined : 'chrome',
    // Signed in once by globalSetup; every test starts from that session
    storageState: 'e2e/.auth.json',
    // A trace records what is typed into forms, and the external run signs in to a real instance: keep none of it
    trace: process.env.E2E_PASSWORD ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Without E2E_BASE_URL it starts the dev console itself, or reuses one already running on :4300
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:4300/login',
        reuseExistingServer: true,
        timeout: 120_000,
      },
  globalSetup: './e2e/global-setup.ts',
});
