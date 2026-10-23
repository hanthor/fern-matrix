import { test, expect, type Page } from '@playwright/test'

// UI-only sessions use explicit engine doubles; never contact a real account.
async function setup(page: Page) {
  await page.goto('/?demo=0')
  await expect(page.getByRole('heading', { name: 'Good conversations start here' })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the source module to the browser fixture.
    const { state, engine } = await import('/src/store.ts')
    const calls: string[] = []
    ;(window as unknown as { exitCalls: string[] }).exitCalls = calls
    engine.sessionExitStatus = async () => ({ recovery: 'Unknown', backupExists: 'unknown', lastDevice: 'unknown' })
    engine.logout = async (id: string) => { calls.push('logout:' + id); return { status: 'complete', serverRevoked: false } }
    engine.removeAccount = async (id: string) => { calls.push('remove:' + id); return { status: 'complete' } }
    state.accounts = [
      { id: 'exit-a', userId: '@alice:example.org', name: 'Alice', color: '#477962', connection: 'offline' },
      { id: 'exit-b', userId: '@bob:example.org', name: 'Bob', color: '#477962', connection: 'offline' },
    ]
    state.rooms = []; state.messages = {}; state.activeAccountId = 'exit-a'; state.activeRoomId = ''
  })
  await page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { exitCalls: string[] }).exitCalls)
}

test('local removal identifies the selected account and cancellation erases nothing', async ({ page }) => {
  await setup(page)
  await page.locator('.settings-account').filter({ hasText: '@bob:example.org' })
    .getByRole('button', { name: 'Remove', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove this session from this device?' })
  await expect(dialog.getByText('@bob:example.org', { exact: false })).toBeVisible()
  await expect(dialog.getByText('This erases local credentials', { exact: false })).toBeVisible()
  await expect(dialog.getByText('Recovery status could not be confirmed', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Erase local session data' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.settings-account')).toHaveCount(2)
  expect(await calls(page)).toEqual([])
})

test('sign out requires acknowledgement and remains bound to its original session', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await expect(dialog.getByText('@alice:example.org', { exact: false })).toBeVisible()
  await expect(dialog.getByText('The server backup could not be checked.')).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { switchAccount } = await import('/src/store.ts')
    switchAccount('exit-b')
  })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Sign out and erase local data' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await calls(page)).toEqual(['logout:exit-a'])
  // Frappe renders both a toast and its accessible announcement.
  await expect(page.getByText('The server session may still be active.', { exact: false }).filter({ visible: true }).first()).toBeVisible()
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.activeAccountId
  })).toBe('exit-b')
})

test('Escape cancels without deleting either local session', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await calls(page)).toEqual([])
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.accounts.length
  })).toBe(2)
})

test('mounted security controls react to Enabled, Unknown, and account switches', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Enabled', verified: 'Verified' })
    engine.listenForVerificationRequests = async () => {}
  })
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Unknown', verified: 'Unknown' })
  })
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toHaveCount(0)
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    engine.security = async () => ({ deviceId: 'A', fingerprint: '', recovery: 'Enabled', verified: 'Verified' })
  })
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Security', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { switchAccount } = await import('/src/store.ts')
    switchAccount('exit-b')
  })
  await expect(page.getByRole('button', { name: 'Reset recovery', exact: true })).toHaveCount(0)
})

test('locking cancels an acknowledged exit and Enter cannot execute it', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await dialog.getByRole('checkbox').check()
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { appLocked } = await import('/src/store.ts')
    appLocked.value = true
  })
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Enter')
  expect(await calls(page)).toEqual([])
})

test('unfinished cleanup stays explicit and failed cleanup retries locally, never signing out twice', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { engine } = await import('/src/store.ts')
    // @ts-expect-error Vite browser fixture.
    const { markSessionRemoving } = await import('/src/session-storage.ts')
    engine.logout = async (id: string) => {
      ;(window as unknown as { exitCalls: string[] }).exitCalls.push('logout:' + id)
      markSessionRemoving(id)
      throw new Error('cleanup failed')
    }
    engine.removeAccount = async (id: string) => {
      ;(window as unknown as { exitCalls: string[] }).exitCalls.push('remove:' + id)
      return { status: 'restart-required' }
    }
  })
  await page.getByRole('button', { name: 'Sign out of current account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of this session?' })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Sign out and erase local data' }).click()
  await expect(dialog.getByText('Local cleanup failed.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Restart Fern to finish cleanup' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Sign out and erase local data' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Retry local cleanup' }).click()
  await expect(dialog.getByText('Local erasure is not complete.', { exact: false })).toBeVisible()
  expect(await calls(page)).toEqual(['logout:exit-a', 'remove:exit-a'])
  await dialog.getByRole('button', { name: 'Close', exact: true }).filter({ hasText: 'Close' }).click()
  await expect(page.getByRole('region', { name: 'Local cleanup unfinished' })).toBeVisible()
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return { ids: state.accounts.map((item: { id: string }) => item.id), selected: state.activeAccountId }
  })).toEqual({ ids: ['exit-b'], selected: 'exit-b' })
})

test('pending banner survives an explicit restart while another page blocks a database, then clears only after deletion', async ({ page, context }) => {
  test.setTimeout(45_000)
  await page.goto('/?demo=0')
  const blocker = await context.newPage()
  await blocker.goto('/?demo=0')
  const id = 'pending-ui-restart'
  const database = `fern-${id}::matrix-sdk-state`
  await blocker.evaluate(async database => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(database)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        ;(window as unknown as { heldCleanupDb: IDBDatabase }).heldCleanupDb = request.result
        // Deliberately retain this connection on versionchange.
        resolve()
      }
    })
  }, database)
  await page.evaluate(id => {
    localStorage.setItem('fern.sessions.v1', JSON.stringify({ [id]: { userId: '@pending:example.org', homeserverUrl: 'https://example.invalid' } }))
    localStorage.setItem(`fern.removing.${id}`, '1')
  }, id)
  await page.reload()
  const banner = page.getByRole('region', { name: 'Local cleanup unfinished' })
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner.getByText('Local erasure is not complete.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Good conversations start here' })).toBeVisible()
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.accounts.length
  })).toBe(0)
  await Promise.all([
    page.waitForEvent('load'),
    banner.getByRole('button', { name: 'Restart Fern to finish cleanup' }).click(),
  ])
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await blocker.close()
  await Promise.all([
    page.waitForEvent('load'),
    banner.getByRole('button', { name: 'Restart Fern to finish cleanup' }).click(),
  ])
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('fern.sessions.v1') ?? '{}')[id] === undefined, id)).toBe(true)
  await expect(banner).toHaveCount(0)
  expect(await page.evaluate(async database => (await indexedDB.databases()).some(db => db.name === database), database)).toBe(false)
})

test('an unread saved draft is not erased by a fallback, account switch, or restart attempt', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    const key = 'fern.draft.exit-a/unread-room'
    const get = Storage.prototype.getItem
    const set = Storage.prototype.setItem
    const remove = Storage.prototype.removeItem
    set.call(localStorage, key, 'Keep this saved draft')
    const testState = { mutations: [] as string[], nonce: 'same-page', rawRead: () => get.call(localStorage, key) }
    ;(window as unknown as { draftReadTest: typeof testState }).draftReadTest = testState
    Storage.prototype.getItem = function (candidate: string) {
      if (this === localStorage && candidate === key) throw new Error('Simulated read failure')
      return get.call(this, candidate)
    }
    Storage.prototype.setItem = function (candidate: string, value: string) {
      if (this === localStorage && candidate === key) testState.mutations.push('set:' + value)
      return set.call(this, candidate, value)
    }
    Storage.prototype.removeItem = function (candidate: string) {
      if (this === localStorage && candidate === key) testState.mutations.push('remove')
      return remove.call(this, candidate)
    }
    state.pendingCleanups = [{
      account: { id: 'pending-read-test', userId: '@pending:example.org', name: 'Pending', color: '#477962', connection: 'offline' },
      status: 'restart-required', busy: false,
    }]
    state.activeRoomId = 'unread-room'
  })
  await expect.poll(() => page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { state } = await import('/src/store.ts')
    return state.error
  })).toContain('A draft could not be saved or loaded.')
  await page.getByRole('region', { name: 'Local cleanup unfinished' })
    .getByRole('button', { name: 'Restart Fern to finish cleanup' }).click()
  // Reload would destroy this in-memory sentinel. The read error must abort it.
  expect(await page.evaluate(() => {
    const value = (window as unknown as { draftReadTest: { nonce: string; mutations: string[]; rawRead(): string | null } }).draftReadTest
    return value ? { nonce: value.nonce, mutations: value.mutations, saved: value.rawRead() } : null
  })).toEqual({ nonce: 'same-page', mutations: [], saved: 'Keep this saved draft' })
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser fixture.
    const { switchAccount } = await import('/src/store.ts')
    switchAccount('exit-b')
  })
  // Wait through the account watcher and queued storage work before inspecting
  // the mutation log. Deletes and writes work; only reads of this key throw.
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await navigator.locks.request('fern.session-secret.exit-a', () => {})
  })
  expect(await page.evaluate(() => {
    const value = (window as unknown as { draftReadTest: { mutations: string[]; rawRead(): string | null } }).draftReadTest
    return { mutations: value.mutations, saved: value.rawRead() }
  })).toEqual({ mutations: [], saved: 'Keep this saved draft' })
})

for (const interruption of ['lock', 'cleanup-error'] as const) {
  test(`restart aborts when ${interruption} arrives during awaited draft persistence`, async ({ page }) => {
    await setup(page)
    await page.keyboard.press('Escape')
    await page.evaluate(async () => {
      // @ts-expect-error Vite browser fixture.
      const { state } = await import('/src/store.ts')
      localStorage.setItem('fern.draft.exit-b/held-room', 'Preserve the other account draft')
      state.activeAccountId = 'exit-b'
      state.activeRoomId = 'held-room'
      state.pendingCleanups = [{
        account: { id: 'pending-await-test', userId: '@pending:example.org', name: 'Pending', color: '#477962', connection: 'offline' },
        status: 'restart-required', busy: false,
      }]
      let release!: () => void
      let acquired!: () => void
      const acquiredPromise = new Promise<void>(resolve => { acquired = resolve })
      const hold = new Promise<void>(resolve => { release = resolve })
      const testState = { nonce: 'same-page', release, finished: false }
      ;(window as unknown as { draftWaitTest: typeof testState }).draftWaitTest = testState
      void navigator.locks.request('fern.session-secret.exit-b', async () => {
        acquired(); await hold
      }).then(() => { testState.finished = true })
      await acquiredPromise
    })
    const restart = page.getByRole('region', { name: 'Local cleanup unfinished' })
      .getByRole('button', { name: 'Restart Fern to finish cleanup' })
    await restart.click()
    await expect.poll(() => page.evaluate(async () => {
      const locks = await navigator.locks.query()
      return locks.pending?.some(lock => lock.name === 'fern.session-secret.exit-b') ?? false
    })).toBe(true)
    await page.evaluate(async interruption => {
      // @ts-expect-error Vite browser fixture.
      const { state, appLocked } = await import('/src/store.ts')
      if (interruption === 'lock') appLocked.value = true
      else state.pendingCleanups.push({
        account: { id: 'marker-failed', userId: '@other:example.org', name: 'Other', color: '#477962', connection: 'offline' },
        status: 'error', busy: false,
      })
      ;(window as unknown as { draftWaitTest: { release(): void } }).draftWaitTest.release()
    }, interruption)
    await expect.poll(() => page.evaluate(async () => {
      const testState = (window as unknown as { draftWaitTest?: { finished: boolean } }).draftWaitTest
      const locks = await navigator.locks.query()
      return !!testState?.finished && !locks.pending?.some(lock => lock.name === 'fern.session-secret.exit-b')
        && !locks.held?.some(lock => lock.name === 'fern.session-secret.exit-b')
    })).toBe(true)
    expect(await page.evaluate(() => ({
      nonce: (window as unknown as { draftWaitTest?: { nonce: string } }).draftWaitTest?.nonce,
      draft: localStorage.getItem('fern.draft.exit-b/held-room'),
    }))).toEqual({ nonce: 'same-page', draft: 'Preserve the other account draft' })
    if (interruption === 'lock') await expect(page.getByRole('dialog', { name: 'Unlock Fern' })).toBeVisible()
    else await expect(restart).toBeDisabled()
  })
}
