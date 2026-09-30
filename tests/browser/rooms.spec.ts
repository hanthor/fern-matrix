import { test, expect } from '@playwright/test'

// Room settings and member management (#20) UI validation and demo paths:
// the settings dialog opens prefilled, moderator-only controls stay gated in
// the demo, and the members panel lists the demo roster. Live admin/member
// role coverage lives in tests/integration/rooms.spec.ts.
test('room settings dialog shows members and gates moderator controls in the demo', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Room actions' }).click()
  await page.getByRole('menuitem', { name: 'Room settings' }).click()
  await expect(page.getByText('ROOM DETAILS', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Room name' })).toHaveValue('General')
  await expect(page.getByText('Admin · power 0', { exact: true })).toBeVisible()
  await expect(page.getByText('Moderator · power 0', { exact: true })).toBeVisible()
  await expect(page.getByText('Only moderators can change these settings — ask one.')).toBeVisible()
  await expect(page.getByText('Only moderators can change members — ask one.')).toBeVisible()
  await expect(page.getByText(/removing a member never revokes keys they already hold/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save room settings' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ban', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('room members panel lists the demo roster', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Room members' }).click()
  await expect(page.getByText('PEOPLE IN THIS ROOM', { exact: true })).toBeVisible()
  await expect(page.locator('.member-row', { hasText: 'Maya Chen' })).toBeVisible()
  await expect(page.locator('.member-row', { hasText: 'Nora Williams' })).toBeVisible()
  expect(errors).toEqual([])
})
