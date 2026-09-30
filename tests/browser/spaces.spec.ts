import { test, expect } from '@playwright/test'

// Space creation, editing and hierarchy management (#21) UI validation and
// demo paths: the create-space dialog validates and creates locally, and a
// plain room's settings carry no children section. Live hierarchy coverage
// lives in tests/integration/spaces.spec.ts.
test('create-space dialog validates the name and creates a demo space', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New conversation' }).click()
  await page.getByRole('menuitem', { name: 'Create a space' }).click()
  await expect(page.getByRole('textbox', { name: 'Space name' })).toBeVisible()
  await expect(page.getByText('New spaces are private and unencrypted.')).toBeVisible()
  // Whitespace passes native required validation, so the app rejects it.
  await page.getByRole('textbox', { name: 'Space name' }).fill('   ')
  await page.getByRole('button', { name: 'Create space' }).click()
  await expect(page.getByText('Give the space a name first.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Space name' }).fill('Demo community')
  await page.getByRole('button', { name: 'Create space' }).click()
  await expect(page.getByRole('button', { name: 'Demo community' })).toBeVisible()
  expect(errors).toEqual([])
})

test('plain room settings show no space children section', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Room actions' }).click()
  await page.getByRole('menuitem', { name: 'Room settings' }).click()
  await expect(page.getByText('ROOM DETAILS', { exact: true })).toBeVisible()
  await expect(page.getByText('CHILD ROOMS AND SPACES', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
