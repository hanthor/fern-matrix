import { test, expect, type Page } from '@playwright/test'

// Account lifecycle UI in the demo (#39): validation errors render in the
// dialog Alert, demo refusals arrive as toast notifications, and the
// deactivation consequences are disclosed before any server is contacted.
// Live register/password/deactivate behavior is covered by
// tests/integration/account.spec.ts against real homeservers.
async function openSecurity(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your conversations belong to you' })).toBeVisible()
}

test('password change validates input and refuses honestly in the demo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await openSecurity(page)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Enter the current and a new password.')).toBeVisible()
  await page.getByLabel('Current password').fill('old-secret')
  await page.getByLabel('New password').fill('new-secret')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('The demo has no password to change.').first()).toBeVisible()
  expect(errors).toEqual([])
})

test('email form validates and refuses honestly in the demo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await openSecurity(page)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByText('Enter an email address.')).toBeVisible()
  await page.getByLabel('New email address').fill('you@example.org')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByText('The demo has no email addresses.').first()).toBeVisible()
  expect(errors).toEqual([])
})

test('registration explains availability and surfaces server refusals', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account' }).click()
  await expect(page.getByRole('heading', { name: 'Add a Matrix account' })).toBeVisible()
  await page.getByRole('button', { name: 'Create an account' }).click()
  await expect(page.getByText('Fern checks availability first')).toBeVisible()
  // No real account may be created by a UI test: refuse availability.
  await page.route('**/register/available**', route => route.fulfill({
    status: 403, contentType: 'application/json', body: '{}',
  }))
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await dialog.getByLabel('Username').fill('fern-ui-probe')
  await dialog.getByLabel('Password').fill('probe-secret')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('This server does not offer open registration. Ask for an invite or use SSO if the server provides it.')).toBeVisible()
  expect(errors).toEqual([])
})

test('deactivation consequences are disclosed before any confirmation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await openSecurity(page)
  await expect(page.getByText('DEACTIVATE ACCOUNT')).toBeVisible()
  await expect(page.getByText('Deactivation is permanent: the account and its server-side history are gone')).toBeVisible()
  // The demo cannot deactivate, so no confirmation form is offered and no
  // last-device warning applies to it.
  await expect(page.getByText('This is the only signed-in device.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deactivate account' })).toHaveCount(0)
  expect(errors).toEqual([])
})
