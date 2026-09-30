import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
test('desktop conversations, sending, replies, edits, reactions, polls and persistence', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('An actual message from the browser test')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const sent = page.locator('article').filter({ has: page.locator('.message-text').filter({ hasText: 'An actual message from the browser test' }) })
  await expect(sent).toBeVisible()
  await sent.hover()
  await sent.getByRole('button', { name: 'Reply to message', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('A reply with context')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: 'A reply with context' }).locator('.reply-preview')).toContainText('An actual message')
  await sent.hover()
  await sent.getByRole('button', { name: 'Message actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Edited browser message')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('article').filter({ hasText: 'Edited browser message' })).toContainText('(edited)')
  const edited = page.locator('article').filter({ hasText: 'Edited browser message' }).filter({ hasNot: page.locator('.reply-preview') })
  await edited.hover()
  await edited.getByRole('button', { name: 'React to message', exact: true }).click()
  await page.getByRole('button', { name: 'Choose 💚', exact: true }).click()
  await expect(edited.locator('.reaction')).toContainText('1')
  await edited.locator('.reaction').click()
  await expect(edited.locator('.reaction')).toHaveCount(0)
  await page.getByRole('button', { name: 'More composer actions' }).click()
  await page.getByRole('menuitem', { name: 'Create a poll' }).click()
  await page.getByRole('textbox', { name: /^Question/ }).fill('Does the poll work?')
  await page.getByRole('textbox', { name: /^Answers/ }).fill('Yes\nAbsolutely')
  await page.getByRole('button', { name: 'Create poll', exact: true }).click()
  const poll = page.locator('.poll-card').filter({ hasText: 'Does the poll work?' })
  await poll.getByRole('button', { name: /Absolutely/ }).click()
  await expect(poll).toContainText('1 votes')
  await page.reload()
  await expect(page.locator('.message-text').filter({ hasText: 'Edited browser message' })).toBeVisible()
  expect(errors).toEqual([])
})
test('account isolation, draft isolation, room creation, settings and global search', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Personal draft')
  await page.getByRole('button', { name: 'Switch to Alex · Work' }).click()
  await expect(page.getByRole('heading', { name: 'Team lounge', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveValue('')
  await expect(page.getByText('Personal draft', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  const workRow = page.locator('.settings-account', { hasText: 'Alex · Work' })
  await expect(workRow.getByText('@alex:studio.example · demo', { exact: true })).toBeVisible()
  await expect(workRow.getByText('4', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Switch to Alex Morgan' }).click()
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveValue('Personal draft')
  await page.locator('.room-list').getByRole('button', { name: /^Design/ }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Alex · Work' }).click()
  await expect(page.getByRole('heading', { name: 'Team lounge', exact: true })).toBeVisible()
  await page.locator('.room-list').getByRole('button', { name: /^Product/ }).click()
  await expect(page.getByRole('heading', { name: 'Product', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Alex Morgan' }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Alex · Work' }).click()
  await expect(page.getByRole('heading', { name: 'Product', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Alex Morgan' }).click()
  await expect(page.getByRole('heading', { name: 'Design', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create a room', exact: true }).click()
  await page.getByRole('textbox', { name: /^Room name/ }).fill('Browser room')
  await page.getByRole('textbox', { name: 'Topic', exact: true }).fill('A new space')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Browser room', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByRole('searchbox', { name: 'Find a conversation', exact: true }).fill('Maya')
  await page.getByRole('dialog').getByRole('button', { name: /Maya Chen/ }).click()
  await expect(page.getByRole('heading', { name: 'Maya Chen', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByText('LOCAL-DEMO', { exact: true })).toBeVisible()
})
test('formatted composer, mention completion and link routing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Hello **bold** and *italic*')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const formatted = page.locator('article').filter({ hasText: 'Hello bold and italic' }).last()
  await expect(formatted.locator('strong')).toHaveText('bold')
  await expect(formatted.locator('em')).toHaveText('italic')
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Hi @maya')
  await expect(page.getByRole('listbox', { name: 'Mention someone' })).toBeVisible()
  await expect(page.getByRole('option', { name: /Maya Chen/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveValue(/matrix\.to\/#\/@maya:matrix\.org/)
  await expect(page.getByRole('listbox', { name: 'Mention someone' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const mention = page.locator('article').filter({ hasText: 'Hi Maya Chen' }).last()
  await expect(mention.locator('a')).toHaveAttribute('href', 'https://matrix.to/#/@maya:matrix.org')
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Find me at @friend:example.org')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.locator('article').filter({ hasText: 'Find me' }).last().locator('a').click()
  await expect(page.getByRole('dialog')).toContainText('Start a private, encrypted conversation.')
  await expect(page.getByRole('textbox', { name: 'Matrix user ID' })).toHaveValue('@friend:example.org')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    await import('/src/store.ts').then(module => { module.state.jumpToEvent = 'm1' })
  })
  await expect(page.locator('.jump-flash')).toBeVisible()
  expect(errors).toEqual([])
})
test('thread timelines open, reply and navigate back', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /2 replies in thread/ }).click()
  await expect(page.getByRole('button', { name: 'Back to conversation' })).toBeVisible()
  const panel = page.getByRole('complementary', { name: 'Room details' })
  await expect(panel.getByText('Could not agree more', { exact: false })).toBeVisible()
  await expect(panel.getByText('Adding this to the principles doc', { exact: false })).toBeVisible()
  await page.getByRole('textbox', { name: 'Thread reply composer' }).fill('Threaded hello')
  await page.getByRole('button', { name: 'Send thread reply' }).click()
  await expect(panel.getByText('Threaded hello', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to conversation' }).click()
  await page.getByRole('button', { name: 'Close room details' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to conversation' })).toHaveCount(0)
  expect(errors).toEqual([])
})
test('phone navigation, room details and sending have no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('searchbox', { name: 'Search conversations' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).not.toBeVisible()
  await page.locator('.room-item').filter({ hasText: 'General' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('Hello from mobile')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText('Hello from mobile', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Room information' }).click()
  await expect(page.getByRole('complementary', { name: 'Room details' })).toBeVisible()
  await page.getByRole('button', { name: 'Close room details' }).click()
  await page.getByRole('button', { name: 'Back to conversations' }).click()
  await expect(page.getByRole('searchbox', { name: 'Search conversations' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
test('long timelines render a bounded window within budget', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  // 4x CPU throttling stands in for a low-end mobile profile; see
  // docs/DEVELOPMENT.md for the agreed budgets and how to re-measure.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const stats = await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state } = await import('/src/store.ts')
    const key = `${state.activeAccountId}/${state.activeRoomId}`
    const batch = Array.from({ length: 2000 }, (_, index) => ({
      id: `perf-${index}`, sender: '@perf:demo', name: 'Perf', body: `Perf message ${index}`,
      timestamp: Date.now() - (2000 - index) * 1000, own: index % 2 === 0, kind: 'text', reactions: [],
    }))
    const start = performance.now()
    state.messages[key] = [...(state.messages[key] ?? []), ...batch]
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      loaded: state.messages[key].length,
      rows: document.querySelectorAll('article.message-row').length,
      ms: Math.round(performance.now() - start),
    }
  })
  console.log(`timeline render: ${stats.rows} rows for ${stats.loaded} loaded messages in ${stats.ms}ms (4x throttle)`)
  expect(stats.loaded).toBeGreaterThan(1000)
  // The render window caps mounted rows no matter how much is loaded.
  expect(stats.rows).toBeLessThanOrEqual(150)
  expect(stats.ms).toBeLessThan(12000)
  await page.getByRole('button', { name: /Show \d+ earlier messages/ }).click()
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('article.message-row').length)).toBeGreaterThan(150)
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
})
test('landmarks, names, dialog, touch targets and keyboard flow', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Accounts and spaces' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible()
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeVisible()
  // Every visible control exposes an accessible name.
  const unnamed = await page.evaluate(() => {
    const bad: string[] = []
    for (const element of document.querySelectorAll('button, a, input, select, textarea')) {
      const box = (element as HTMLElement).getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      const name = (element.getAttribute('aria-label') || element.textContent ||
        (element as HTMLInputElement).value || element.getAttribute('placeholder') ||
        element.getAttribute('title') || '').trim()
      if (!name) bad.push(`<${element.tagName.toLowerCase()} class="${element.className}">`)
    }
    return bad
  })
  expect(unnamed).toEqual([])
  // Exactly one selected tab is current in each tab group.
  expect(await page.locator('.filter-tabs [aria-current="true"]').count()).toBe(1)
  // Dialogs carry dialog semantics and Escape dismisses them.
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Visible buttons meet the 24px minimum target size.
  const small = await page.evaluate(() => {
    const bad: string[] = []
    for (const element of document.querySelectorAll('button')) {
      const box = (element as HTMLElement).getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      if (box.width < 24 || box.height < 24) {
        bad.push(`${element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 24)} ${Math.round(box.width)}x${Math.round(box.height)}`)
      }
    }
    return bad
  })
  console.log(`desktop buttons below 24px: ${JSON.stringify(small)}`)
  expect(small).toEqual([])
  // Full keyboard journey: focus the composer, type, and send with Enter.
  await page.getByRole('textbox', { name: 'Message composer' }).focus()
  await page.keyboard.type('Keyboard-only message')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Keyboard-only message', { exact: true })).toBeVisible()
  // Phone viewport: visible controls meet the same minimum target size.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.room-item').filter({ hasText: 'General' }).click()
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  const mobileSmall = await page.evaluate(() => {
    const bad: string[] = []
    for (const element of document.querySelectorAll('button')) {
      const box = (element as HTMLElement).getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      if (box.width < 24 || box.height < 24) {
        bad.push(`${element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 24)} ${Math.round(box.width)}x${Math.round(box.height)}`)
      }
    }
    return bad
  })
  console.log(`mobile buttons below 24px: ${JSON.stringify(mobileSmall)}`)
  expect(mobileSmall).toEqual([])
  expect(errors).toEqual([])
})
test('narrow reflow, forced colors and mention targets', async ({ browser }) => {
  const context = await browser.newContext({ forcedColors: 'active', viewport: { width: 320, height: 568 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('/')
    // Landmarks survive forced-colors emulation.
    await expect(page.getByRole('navigation', { name: 'Accounts and spaces' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible()
    // Narrow viewports reflow without horizontal scrolling.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.locator('.room-item').filter({ hasText: 'General' }).click()
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const composer = page.getByRole('textbox', { name: 'Message composer' })
    await composer.focus()
    expect(await composer.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
    // Mention candidates meet the minimum target size.
    await composer.fill('Hi @')
    await expect(page.getByRole('listbox', { name: 'Mention someone' })).toBeVisible()
    const small = await page.evaluate(() => {
      const bad: string[] = []
      for (const element of document.querySelectorAll('.mention-popup button')) {
        const box = (element as HTMLElement).getBoundingClientRect()
        if (box.height < 24) bad.push(`${element.textContent?.trim().slice(0, 20)} ${Math.round(box.height)}px`)
      }
      return bad
    })
    expect(small).toEqual([])
  } finally {
    await context.close()
  }
  expect(errors).toEqual([])
})
test('vendored Matrix Rust SDK WASM initializes in a real browser', async ({ page }) => {
  await page.goto('/')
  await page.route('https://matrix-test.invalid/**', route => route.fulfill({ json: { versions: ['v1.11'], unstable_features: { 'org.matrix.simplified_msc3575': true } } }))
  const result = await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { loadSdk } = await import('/src/sdk/engine.ts')
    const sdk = await loadSdk()
    const builder = new sdk.ClientBuilder()
    const client = await builder.homeserverUrl('https://matrix-test.invalid').indexeddbStore(new sdk.IndexedDbStoreBuilder(`fern-test-${crypto.randomUUID()}`).passphrase('isolated-test-store-passphrase')).build()
    return { homeserver: client.homeserver(), builder: typeof builder.build, indexedDb: typeof sdk.IndexedDbStoreBuilder, send: typeof sdk.MessageType.Text, sync: typeof sdk.SlidingSyncVersionBuilder.DiscoverNative }
  })
  expect(result).toMatchObject({ homeserver: 'https://matrix-test.invalid/', builder: 'function', indexedDb: 'function', send: 'function' })
})
test('diagnostics export carries counts without message content or secrets', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message composer' }).fill('A secret browser draft')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download diagnostics', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe('fern-diagnostics.json')
  const text = await readFile(await download.path() as string, 'utf8')
  const payload = JSON.parse(text)
  expect(payload.app).toMatch(/^\d+\.\d+\.\d+$/)
  expect(payload.accounts.length).toBeGreaterThan(0)
  for (const entry of payload.accounts) expect(Object.keys(entry).sort()).toEqual(['connection', 'messages', 'rooms', 'userId'])
  expect(text).not.toContain('A secret browser draft')
  expect(text).not.toContain('passphrase')
  expect(errors).toEqual([])
})
test('event focus reaches messages older than the render window', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Browser imports are resolved by the Vite development server.
    const { state } = await import('/src/store.ts')
    const key = `${state.activeAccountId}/${state.activeRoomId}`
    const batch = Array.from({ length: 300 }, (_, index) => ({
      id: `old-${index}`, sender: '@perf:demo', name: 'Perf', body: `Old message ${index}`,
      timestamp: Date.now() - (400 - index) * 60000, own: false, kind: 'text', reactions: [],
    }))
    state.messages[key] = [...batch, ...(state.messages[key] ?? [])]
    state.jumpToEvent = 'old-0'
  })
  await expect(page.locator('.jump-flash')).toBeVisible()
  expect(errors).toEqual([])
})
