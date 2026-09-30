import { test, expect } from '@playwright/test'

// Device app lock (#38) through the real settings UI in the demo: setting a
// PIN gates the app behind the lock screen on reload, a wrong PIN refuses,
// and the right PIN reopens the app.
test('PIN setup locks the app until the right PIN unlocks it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByText('DEVICE LOCK')).toBeVisible()
  await page.getByLabel('New PIN').fill('2468')
  await page.getByLabel('Confirm PIN').fill('2468')
  await page.getByRole('button', { name: 'Lock with PIN' }).click()
  await expect(page.getByRole('button', { name: 'Lock now' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Unlock Fern' })).toBeVisible()
  await page.getByLabel('App PIN').fill('0000')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Unlock Fern' })
  await expect(dialog.getByText('Wrong PIN. Try again.')).toBeVisible()
  await page.getByLabel('App PIN').fill('2468')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Unlock Fern' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
