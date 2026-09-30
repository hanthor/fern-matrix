import { test, expect } from '@playwright/test'

// Login gate: with ?demo=0 the app starts empty and prompts for an account
// instead of loading the tour; the escape hatch seeds the demo in place.
test('login gate prompts for an account with a demo escape hatch', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  await page.goto('/?demo=0')
  await expect(page.getByRole('heading', { name: 'Good conversations start here' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect your account' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible()
  await page.getByRole('button', { name: 'Explore the demo' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
