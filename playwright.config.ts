import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser', timeout: 60000, expect: { timeout: 15000 }, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, launchOptions: { executablePath: process.env.FERN_CHROMIUM_PATH || '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' } },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 120000 },
})
