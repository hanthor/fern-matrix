import { expect, test, type Page } from '@playwright/test'

type Mode = 'normal' | 'selection' | 'focus' | 'snapshot' | 'unknown'
async function prepare(page: Page, mode: Mode = 'normal') {
  await page.goto('/')
  await page.bringToFront()
  await page.evaluate(async mode => {
    // @ts-expect-error Browser imports are resolved by Vite.
    const store = await import('/src/store.ts')
    const { state, engine, selectRoom } = store
    const accountId = state.activeAccountId
    state.accounts.find((item: { id: string }) => item.id === accountId).connection = 'online'
    const template = state.rooms.find((item: { accountId: string; space?: boolean }) => item.accountId === accountId && !item.space)
    const origin = { ...template, id: '!origin:test', name: 'Link origin', unread: 0, mentions: 0, membership: 'joined' }
    const target = { ...template, id: '!target:test', name: 'Link target', unread: 5, mentions: 0, membership: 'joined' }
    state.rooms.push(origin, target)
    const message = (id: string) => ({ id, sender: '@test:x', name: 'Test', body: id, timestamp: 1, own: false, kind: 'text', reactions: [] })
    const link = { ...message('$link'), body: 'Open older event',
      formattedBody: '<p><a href="https://matrix.to/#/!target:test/$old-event">Open older event</a></p>' }
    const focuses: string[] = [], scrolls: Array<string | null> = [], receipts: string[] = []
    let paginations = 0, staleStops = 0
    let finishSelection!: () => void, finishFocus!: () => void, rejectFocus!: () => void, deliverSnapshot!: () => void
    engine.members = async () => []
    engine.ignoredUsers = async () => []
    engine.pollModPower = async () => false
    engine.markEventRead = async (_account: string, roomId: string, eventId: string) => { receipts.push(roomId + '/' + eventId); return true }
    engine.paginate = async () => { ++paginations; return true }
    engine.watchRoom = async (_account: string, roomId: string, update: (items: unknown[]) => void) => {
      update(roomId === origin.id ? [link] : [message('$live-latest')])
      if (roomId === target.id && mode === 'selection') return new Promise<() => void>(resolve => {
        finishSelection = () => resolve(() => { ++staleStops })
      })
      return () => {}
    }
    engine.focusEvent = async (_account: string, _room: string, eventId: string, update: (items: unknown[]) => void) => {
      focuses.push(eventId)
      if (mode === 'unknown') throw new Error('Event is unavailable')
      const snapshot = () => update([{ ...message(eventId), formattedBody: link.formattedBody }])
      deliverSnapshot = snapshot
      if (mode === 'snapshot' || mode === 'focus') update([])
      else snapshot()
      if (mode === 'focus') return new Promise<() => void>((resolve, reject) => {
        rejectFocus = () => reject(new Error('Abandoned focus failed'))
        finishFocus = () => { snapshot(); resolve(() => { ++staleStops }) }
      })
      return () => { ++staleStops }
    }
    Element.prototype.scrollIntoView = function () { scrolls.push(this.getAttribute('data-message-id')) }
    Object.assign(window, {
      finishEventSelection: () => finishSelection(),
      finishEventFocus: () => finishFocus(),
      rejectEventFocus: () => rejectFocus(),
      deliverEventSnapshot: () => deliverSnapshot(),
      eventEvidence: () => ({ focuses, scrolls, receipts, paginations, staleStops }),
    })
    await selectRoom(origin)
  }, mode)
  await expect(page.getByRole('link', { name: 'Open older event' })).toBeVisible()
}
async function evidence(page: Page) {
  return page.evaluate(() => (window as unknown as { eventEvidence(): {
    focuses: string[]; scrolls: Array<string | null>; receipts: string[]; paginations: number; staleStops: number
  } }).eventEvidence())
}
async function frames(page: Page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function clickLink(page: Page) { await page.getByRole('link', { name: 'Open older event' }).click() }

test('joined old-event link uses SDK focus, never five-page live history search', async ({ page }) => {
  await prepare(page)
  await clickLink(page)
  await expect(page.locator('article[data-message-id="$old-event"]')).toBeVisible()
  await expect.poll(async () => (await evidence(page)).scrolls).toContain('$old-event')
  expect(await evidence(page)).toMatchObject({ focuses: ['$old-event'], paginations: 0 })
  expect((await evidence(page)).receipts).not.toContain('!target:test/$live-latest')
})

test('selection completion cannot focus or publish over newer room navigation', async ({ page }) => {
  await prepare(page, 'selection')
  await clickLink(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, selectRoom } = await import('/src/store.ts')
    await selectRoom(state.rooms.find((item: { id: string }) => item.id === '!origin:test'))
    state.error = 'New view error'
    ;(window as unknown as { finishEventSelection(): void }).finishEventSelection()
  })
  await frames(page)
  expect(await evidence(page)).toMatchObject({ focuses: [], paginations: 0, staleStops: 1 })
  await expect(page.getByText('New view error', { exact: true })).toBeVisible()
  await expect(page.getByText('Viewing message context')).toHaveCount(0)
})

for (const destination of ['room', 'account'] as const) {
  test('late focused subscription cannot scroll after newer ' + destination, async ({ page }) => {
    await prepare(page, 'focus')
    await clickLink(page)
    await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
    await page.evaluate(async destination => {
      // @ts-expect-error Vite source fixture.
      const { state, selectRoom, switchAccount } = await import('/src/store.ts')
      if (destination === 'room') await selectRoom(state.rooms.find((item: { id: string }) => item.id === '!origin:test'))
      else switchAccount(state.accounts.find((item: { id: string }) => item.id !== state.activeAccountId).id)
      state.error = 'Newer context'
      ;(window as unknown as { finishEventFocus(): void }).finishEventFocus()
    }, destination)
    await frames(page)
    expect((await evidence(page)).scrolls).not.toContain('$old-event')
    expect((await evidence(page)).staleStops).toBe(1)
    await expect(page.getByText('Viewing message context')).toHaveCount(0)
    await expect(page.getByText('Newer context', { exact: true })).toBeVisible()
  })
}

test('focus handle readiness waits for its actual target snapshot', async ({ page }) => {
  await prepare(page, 'snapshot')
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
  await page.evaluate(() => (window as unknown as { deliverEventSnapshot(): void }).deliverEventSnapshot())
  await expect.poll(async () => (await evidence(page)).scrolls).toContain('$old-event')
  expect((await evidence(page)).paginations).toBe(0)
})

test('unknown event reports a meaningful owned failure without paging', async ({ page }) => {
  await prepare(page, 'unknown')
  await clickLink(page)
  await expect(page.getByText('Event is unavailable', { exact: true })).toBeVisible()
  expect((await evidence(page)).paginations).toBe(0)
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
})

test('the same link can be activated again after its first focused jump', async ({ page }) => {
  await prepare(page)
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).scrolls.filter(id => id === '$old-event').length).toBe(1)
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).scrolls.filter(id => id === '$old-event').length).toBe(2)
  expect((await evidence(page)).focuses).toEqual(['$old-event', '$old-event'])
})

test('current unread intent uses focus and is consumed before a newer request', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, jumpToFirstUnread, messageKey } = await import('/src/store.ts')
    const key = messageKey(state.activeAccountId, state.activeRoomId)
    state.firstUnread[key] = { id: '$first-unread', count: 1 }
    jumpToFirstUnread(key)
  })
  await expect.poll(async () => (await evidence(page)).scrolls).toContain('$first-unread')
  expect((await evidence(page)).paginations).toBe(0)
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state } = await import('/src/store.ts')
    return state.jumpToEvent
  })).toBe('')
})

test('a newer event wins while the earlier room selection is pending', async ({ page }) => {
  await prepare(page, 'selection')
  await clickLink(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state } = await import('/src/store.ts')
    state.jumpToEvent = '$new-event'
  })
  await expect.poll(async () => (await evidence(page)).scrolls).toContain('$new-event')
  await page.evaluate(() => (window as unknown as { finishEventSelection(): void }).finishEventSelection())
  await frames(page)
  expect((await evidence(page)).focuses).toEqual(['$new-event'])
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
  expect((await evidence(page)).paginations).toBe(0)
})

test('navigation during rendered focus cannot run a stale scroll continuation', async ({ page }) => {
  await prepare(page, 'snapshot')
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, selectRoom } = await import('/src/store.ts')
    const observer = new MutationObserver(() => {
      if (!document.querySelector('article[data-message-id="$old-event"]')) return
      observer.disconnect()
      Object.assign(window, { renderNavigationObserved: true })
      void selectRoom(state.rooms.find((item: { id: string }) => item.id === '!origin:test'))
      state.error = 'New render destination'
    })
    observer.observe(document.body, { childList: true, subtree: true })
    ;(window as unknown as { deliverEventSnapshot(): void }).deliverEventSnapshot()
  })
  await expect(page.getByRole('heading', { name: 'Link origin', exact: true })).toBeVisible()
  await frames(page)
  expect(await page.evaluate(() => (window as unknown as { renderNavigationObserved?: boolean }).renderNavigationObserved)).toBe(true)
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
  await expect(page.getByText('New render destination', { exact: true })).toBeVisible()
})

test('missing focused snapshot ends with a useful error rather than a silent no-op', async ({ page }) => {
  await prepare(page, 'snapshot')
  await clickLink(page)
  await expect(page.getByText('The linked message could not be loaded. It may be unavailable or inaccessible.', { exact: true })).toBeVisible({ timeout: 20_000 })
  expect((await evidence(page)).paginations).toBe(0)
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
})

for (const intent of ['query', 'thread', 'direct-focus'] as const) {
  test('newer ' + intent + ' intent survives deferred selection', async ({ page }) => {
    await prepare(page, 'selection')
    await clickLink(page)
    await page.evaluate(async intent => {
      // @ts-expect-error Vite source fixture.
      const { state, focusMessage } = await import('/src/store.ts')
      if (intent === 'query') state.messageQuery = 'newer query'
      else if (intent === 'thread') {
        state.details = true
        state.thread = { accountId: state.activeAccountId, roomId: state.activeRoomId, rootId: '$thread', messages: [], loading: false, end: true }
      } else await focusMessage(state.activeRoomId, '$direct-focus')
      ;(window as unknown as { finishEventSelection(): void }).finishEventSelection()
    }, intent)
    await frames(page)
    expect((await evidence(page)).focuses).toEqual(intent === 'direct-focus' ? ['$direct-focus'] : [])
    expect((await evidence(page)).scrolls).not.toContain('$old-event')
    if (intent === 'query') expect(await page.evaluate(async () => {
      // @ts-expect-error Vite source fixture.
      return (await import('/src/store.ts')).state.messageQuery
    })).toBe('newer query')
  })
}

test('late focus rejection does not replace a newer query error', async ({ page }) => {
  await prepare(page, 'focus')
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state } = await import('/src/store.ts')
    state.messageQuery = 'new query'
    state.error = 'New query error'
    ;(window as unknown as { rejectEventFocus(): void }).rejectEventFocus()
  })
  await frames(page)
  await expect(page.getByText('New query error', { exact: true })).toBeVisible()
  await expect(page.getByText('Abandoned focus failed', { exact: true })).toHaveCount(0)
})

test('an unjoined event link never starts room selection, focus or pagination', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, engine } = await import('/src/store.ts')
    state.rooms.find((item: { id: string }) => item.id === '!target:test').membership = 'invited'
    engine.join = async () => { throw new Error('Unexpected network join') }
  })
  await clickLink(page)
  await expect(page.getByRole('heading', { name: 'Link origin', exact: true })).toBeVisible()
  expect(await evidence(page)).toMatchObject({ focuses: [], paginations: 0 })
  await expect(page.locator('[data-sonner-toaster]')).toHaveCount(1)
  await expect(page.getByText('That room is not in any connected account', { exact: true })).toBeVisible()
})

for (const mode of ['focus', 'snapshot'] as const) {
  for (const intent of ['query', 'thread'] as const) {
    test(intent + ' cancels owned ' + mode + ' work before a late successful callback', async ({ page }) => {
      await prepare(page, mode)
      await clickLink(page)
      await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
      await page.evaluate(async ({ mode, intent }) => {
        // @ts-expect-error Vite source fixture.
        const { state } = await import('/src/store.ts')
        if (intent === 'query') state.messageQuery = 'Newer filter'
        else { state.details = true; state.thread = { accountId: state.activeAccountId, roomId: state.activeRoomId, rootId: '$new-thread', messages: [], loading: false, end: true } }
        state.error = 'Current intent error'
        const controls = window as unknown as { finishEventFocus(): void; deliverEventSnapshot(): void }
        if (mode === 'focus') controls.finishEventFocus()
        else controls.deliverEventSnapshot()
      }, { mode, intent })
      await frames(page)
      expect((await evidence(page)).staleStops).toBe(1)
      expect((await evidence(page)).scrolls).not.toContain('$old-event')
      await expect(page.getByText('Viewing message context')).toHaveCount(0)
      await expect(page.getByText('Current intent error', { exact: true })).toBeVisible()
    })
  }
}

test('unmount cancels snapshot waiting and cannot publish a late focus', async ({ page }) => {
  await prepare(page, 'snapshot')
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
  const unmounted = await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state } = await import('/src/store.ts')
    state.error = 'Before unmount'
    const root = document.querySelector('#app') as Element & { __vue_app__?: { unmount(): void } }
    if (!root.__vue_app__) return false
    root.__vue_app__.unmount()
    ;(window as unknown as { deliverEventSnapshot(): void }).deliverEventSnapshot()
    return true
  })
  expect(unmounted).toBe(true)
  await frames(page)
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
  expect(await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, focused } = await import('/src/store.ts')
    return { error: state.error, focused: Boolean(focused.value) }
  })).toEqual({ error: 'Before unmount', focused: false })
})

test('failure publication retains its lease across a newer direct focus microtask', async ({ page }) => {
  await prepare(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, engine, focusMessage } = await import('/src/store.ts')
    let rejectOld!: (error: Error) => void
    // Deliberately non-async: reject queues the store catch first, then the
    // newer focus runs before the component's rejection continuation.
    engine.focusEvent = (_account: string, _room: string, id: string, update: (items: unknown[]) => void) => {
      if (id === '$old-event') return new Promise<() => void>((_resolve, reject) => { rejectOld = reject })
      update([{ id, sender: '@test:x', name: 'Test', body: 'New direct focus', timestamp: 1, own: false, kind: 'text', reactions: [] }])
      return Promise.resolve(() => {})
    }
    Object.assign(window, { rejectThenFocus: () => {
      rejectOld(new Error('Old focus error'))
      queueMicrotask(() => { void focusMessage(state.activeRoomId, '$direct-new'); state.error = 'New direct focus error' })
    } })
  })
  await clickLink(page)
  await expect(page.getByText('Viewing message context')).toBeVisible()
  await page.evaluate(() => (window as unknown as { rejectThenFocus(): void }).rejectThenFocus())
  await frames(page)
  await expect(page.getByText('New direct focus error', { exact: true })).toBeVisible()
  await expect(page.locator('article[data-message-id="$direct-new"]')).toBeVisible()
  await expect(page.getByText('Old focus error', { exact: true })).toHaveCount(0)
})

test('lock and return cannot revive a deferred old focus', async ({ page }) => {
  await prepare(page, 'focus')
  await clickLink(page)
  await expect.poll(async () => (await evidence(page)).focuses).toEqual(['$old-event'])
  await page.evaluate(async () => {
    // @ts-expect-error Vite source fixture.
    const { state, appLocked, lockNow } = await import('/src/store.ts')
    lockNow()
    // Exercise the store's lock boundary without saving a PIN or credentials.
    appLocked.value = false
    state.error = 'Returned from lock'
    ;(window as unknown as { finishEventFocus(): void }).finishEventFocus()
  })
  await frames(page)
  expect((await evidence(page)).staleStops).toBe(1)
  expect((await evidence(page)).scrolls).not.toContain('$old-event')
  await expect(page.getByText('Viewing message context')).toHaveCount(0)
  await expect(page.getByText('Returned from lock', { exact: true })).toBeVisible()
})
