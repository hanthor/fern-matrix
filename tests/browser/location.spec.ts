import { test, expect, type Page } from '@playwright/test'

const FIX = { latitude: 53.4794, longitude: -2.2453, accuracy: 25 }
async function stubGeolocation(page: Page, outcome: 'fix' | 'denied') {
  await page.addInitScript(({ outcome, fix }: { outcome: string; fix: typeof FIX }) => {
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback, failure?: PositionErrorCallback) => {
        if (outcome === 'fix') {
          success({ coords: { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy,
            altitude: null, altitudeAccuracy: null, heading: null, speed: null },
            timestamp: Date.now() } as GeolocationPosition)
        } else {
          failure?.({ code: 1, message: 'denied' } as GeolocationPositionError)
        }
      },
    }, configurable: true })
  }, { outcome, fix: FIX })
}
async function openShare(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More composer actions' }).click()
  await page.getByRole('menuitem', { name: 'Share location' }).click()
}

test('location share preview and send', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await stubGeolocation(page, 'fix')
  await openShare(page)
  const panel = page.getByRole('region', { name: 'Location sharing' })
  await expect(panel.getByText('Location shared: 53.4794, -2.2453 (±25m)')).toBeVisible()
  await panel.getByRole('textbox', { name: 'Add a description (optional)' }).fill('Test café')
  await panel.getByRole('button', { name: 'Send location', exact: true }).click()
  const sent = page.locator('article').filter({ hasText: 'Test café' })
  await expect(sent).toHaveCount(1)
  await expect(sent.getByRole('link', { name: 'Open in OpenStreetMap' })).toHaveAttribute('href', /openstreetmap\.org/)
  await expect(sent.getByRole('link', { name: 'Open in app' })).toHaveAttribute('href', 'geo:53.4794,-2.2453;u=25')
  expect(errors).toEqual([])
})
test('map provider setting changes location links', async ({ page }) => {
  await stubGeolocation(page, 'fix')
  await openShare(page)
  const panel = page.getByRole('region', { name: 'Location sharing' })
  await expect(panel.getByText('Location shared: 53.4794, -2.2453 (±25m)')).toBeVisible()
  await panel.getByRole('button', { name: 'Send location', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.locator('[data-slot="trigger"]', { hasText: 'OpenStreetMap' }).click()
  await page.getByRole('option', { name: 'Google Maps' }).click()
  // The preference persists locally; reload to read the timeline unobstructed.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: 'Location shared:' })
    .getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute('href', /google\.com\/maps/)
})
test('denied geolocation surfaces an actionable error', async ({ page }) => {
  await stubGeolocation(page, 'denied')
  await openShare(page)
  await expect(page.getByRole('region', { name: 'Location sharing' })
    .getByText('Location access was denied.')).toBeVisible()
})
test('unsupported browsers hide location sharing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More composer actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Share location' })).toHaveCount(0)
})
