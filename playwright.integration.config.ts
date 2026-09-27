import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/integration', testMatch: '*.spec.ts', timeout: 120_000,
  expect: { timeout: 30_000 }, workers: 1, fullyParallel: false,
  // No traces/screenshots/HAR: these can contain sessions and decrypted messages.
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { executablePath: process.env.FERN_CHROMIUM_PATH || undefined } },
  reporter: [['list']],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
})
