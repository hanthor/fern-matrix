import { test, expect } from '@playwright/test'

// User safety (#27) UI validation and demo paths: the safety tab explains
// consequences and gates controls, and the report dialog requires a reason.
// Live ignore/report coverage lives in tests/integration/safety.spec.ts;
// filtering in tests/safety.test.ts.
test('safety tab explains consequences and gates controls in the demo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Safety', exact: true }).click()
  await expect(page.getByText('Your safety comes first')).toBeVisible()
  await expect(page.getByText('Connect your account to ignore users and report messages.')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('report dialog requires a reason before sending', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const reported = page.locator('.message-row', { hasText: 'Small details, big difference' })
  await reported.hover()
  await reported.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('menuitem', { name: 'Report message' }).click()
  await expect(page.getByText('Reporting sends this message to the room server')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report message', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Why is this abusive?' }).fill('spam fixture')
  await expect(page.getByRole('button', { name: 'Report message', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
