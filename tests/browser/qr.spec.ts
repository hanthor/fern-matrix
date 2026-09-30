import { test, expect, type Page } from '@playwright/test'
import QRCode from 'qrcode'

// QR scan roles in the demo: decoding is real, the relay step honestly
// reports that it needs a connected account.
function loginBytes(): number[] {
  const out: number[] = [77, 65, 84, 82, 73, 88, 2, 3, ...new Array(32).fill(7)]
  const url = [...'https://127.0.0.1:9/x'].map(c => c.charCodeAt(0))
  out.push((url.length >> 8) & 0xff, url.length & 0xff, ...url)
  return out
}

async function openGrant(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await page.getByRole('button', { name: 'Link a new device' }).click()
  await expect(page.getByRole('heading', { name: 'Link a new device' })).toBeVisible()
}

test('qr link dialog rejects bad uploads and denied cameras', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await openGrant(page)
  // A non-image file fails before any decoding.
  await page.getByLabel('QR code image file').setInputFiles({
    name: 'code.txt', mimeType: 'text/plain', buffer: Buffer.from('not a qr code'),
  })
  await expect(page.getByRole('region', { name: 'Link a new device' }).getByText('That file is not a readable image.')).toBeVisible()
  // A valid image with no code fails at the decode step.
  const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.getByLabel('QR code image file').setInputFiles({
    name: 'blank.png', mimeType: 'image/png', buffer: blank,
  })
  await expect(page.getByRole('region', { name: 'Link a new device' }).getByText('No QR code was found in that image.')).toBeVisible()
  expect(errors).toEqual([])
})

test('qr link dialog handles a denied camera', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    }, configurable: true })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await openGrant(page)
  await page.getByRole('button', { name: 'Use camera' }).click()
  await expect(page.getByRole('region', { name: 'Link a new device' }).getByText('Camera access was denied.')).toBeVisible()
  expect(errors).toEqual([])
})

test('qr link dialog decodes a real code and stops honestly', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await openGrant(page)
  const png = await QRCode.toBuffer([{ data: Uint8Array.from(loginBytes()), mode: 'byte' }], { type: 'png' })
  await page.getByLabel('QR code image file').setInputFiles({
    name: 'login.png', mimeType: 'image/png', buffer: png,
  })
  // Decoding succeeds (a real login code), then the demo honestly reports
  // the relay step needs a connected account.
  await expect(page.getByRole('region', { name: 'Link a new device' }).getByText('QR linking needs a connected account.')).toBeVisible()
})

test('qr sign-in is a distinct login entry point', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account' }).click()
  await page.getByRole('button', { name: 'Sign in with QR code' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in with QR code' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sign in with QR code' })
    .getByText('Scan the code on your other device')).toBeVisible()
})
