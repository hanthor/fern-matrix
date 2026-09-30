import { test, expect } from '@playwright/test'

// Headless Chromium has no microphone: the fake-device flags provide a silent
// capture stream and auto-grant the permission prompt.
test.use({ launchOptions: { executablePath: process.env.FERN_CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } })

test('voice recording, preview and send', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Record a voice message', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Voice message recorder' })
  await expect(panel.getByText(/Recording · 0:/)).toBeVisible()
  await panel.getByRole('button', { name: 'Pause recording', exact: true }).click()
  await expect(panel.getByText(/Paused ·/)).toBeVisible()
  await panel.getByRole('button', { name: 'Resume recording', exact: true }).click()
  await expect(panel.getByText(/Recording · 0:/)).toBeVisible()
  await panel.getByRole('button', { name: 'Stop and preview recording', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Send voice message', exact: true })).toBeVisible()
  await expect(panel.locator('audio')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Send voice message', exact: true }).click()
  const sent = page.locator('article').filter({ has: page.locator('audio[aria-label^="Voice message from"]') })
  await expect(sent).toHaveCount(1)
  expect(errors).toEqual([])
})
test('denied microphone surfaces an actionable error', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    }, configurable: true })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Record a voice message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Voice message recorder' })
    .getByText('Microphone access was denied.')).toBeVisible()
})
test('unsupported browsers hide the microphone', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record a voice message', exact: true })).toHaveCount(0)
})
