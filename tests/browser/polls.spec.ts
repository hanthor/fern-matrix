import { test, expect, type Page } from '@playwright/test'

async function createPoll(page: Page, question: string, answers: string, undisclosed = false) {
  await page.getByRole('button', { name: 'More composer actions' }).click()
  await page.getByRole('menuitem', { name: 'Create a poll' }).click()
  await expect(page.getByRole('heading', { name: 'Create a poll' })).toBeVisible()
  await page.getByLabel('Question').fill(question)
  await page.getByLabel('Answers').fill(answers)
  if (undisclosed) await page.getByRole('checkbox', { name: 'Hide results until the poll ends' }).check()
  await page.getByRole('button', { name: 'Create poll', exact: true }).click()
}

test('create, vote, withdraw and end a poll', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await createPoll(page, 'Browser poll?', 'Red\nGreen')
  const card = page.locator('article').filter({ hasText: 'Browser poll?' }).last()
  await expect(card.getByText('POLL · CHOOSE ONE')).toBeVisible()
  await card.getByRole('button', { name: /Red/ }).click()
  await expect(card.getByText('You voted')).toBeVisible()
  await card.getByRole('button', { name: 'Withdraw vote' }).click()
  await expect(card.getByText('You voted')).toHaveCount(0)
  await card.getByRole('button', { name: 'Red' }).click()
  await card.getByRole('button', { name: 'End poll' }).click()
  await expect(card.getByText('POLL · ENDED')).toBeVisible()
  await expect(card.getByText('Poll ended')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Red' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('undisclosed poll and end permission note', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await createPoll(page, 'Secret browser poll?', 'Alpha\nBeta', true)
  const card = page.locator('article').filter({ hasText: 'Secret browser poll?' }).last()
  await expect(card.getByText(/UNDISCLOSED/)).toBeVisible()
  // Leo's seeded poll belongs to someone else: no End button, just the rule.
  const seeded = page.locator('article').filter({ hasText: 'What should we explore first?' }).first()
  await expect(seeded.getByText('Only the creator or a moderator can end this poll.')).toBeVisible()
  await expect(seeded.getByRole('button', { name: 'End poll' })).toHaveCount(0)
})

test('polls tab lists history and jumps', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await createPoll(page, 'History browser poll?', 'One\nTwo')
  await page.getByRole('button', { name: 'Room information' }).click()
  await page.getByRole('button', { name: 'Polls', exact: true }).click()
  const details = page.getByRole('complementary', { name: 'Room details' })
  await expect(details.getByText('History browser poll?')).toBeVisible()
  await expect(details.getByText('What should we explore first?')).toBeVisible()
  await details.getByRole('button', { name: 'Jump to poll' }).first().click()
  await expect(page.getByText('Viewing message context')).toBeVisible()
  await page.getByRole('button', { name: 'Back to live' }).click()
  await expect(page.getByText('Viewing message context')).toHaveCount(0)
})
