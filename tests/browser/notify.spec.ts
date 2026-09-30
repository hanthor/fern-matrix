import { test, expect } from '@playwright/test'

// Notification rules (#23) UI validation and demo paths: the settings tab
// explains browser delivery and gates server-side rules behind a real
// account. Live rule coverage lives in tests/integration/notify.spec.ts;
// delivery suppression and routing in tests/notify.test.ts.
test('notifications tab explains delivery and gates rules in the demo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect(page.getByText('Stay in the conversation')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Desktop notifications' })).toBeVisible()
  await expect(page.getByText('Connect your account to change notification rules.')).toBeVisible()
  await expect(page.getByText('Background push is not available: closed tabs stay silent because Fern provisions no push gateway (see docs/PUSH.md).')).toBeVisible()
  await expect(page.getByText('QUIET ACCOUNTS', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
