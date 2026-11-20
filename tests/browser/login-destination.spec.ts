import { test, expect, type Page } from '@playwright/test'
import QRCode from 'qrcode'

type DestinationProbe = {
  methods: unknown[][]
  logins: unknown[][]
  registrations: number
  finishDiscovery?: () => void
}

async function mockAuth(page: Page, discovery: 'success' | 'failed' | 'pending' = 'success') {
  await page.evaluate(async discovery => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe: DestinationProbe = { methods: [], logins: [], registrations: 0 }
    ;(window as unknown as { destinationProbe: DestinationProbe }).destinationProbe = probe
    engine.loginMethods = async (...args: unknown[]) => {
      probe.methods.push(args)
      if (discovery === 'failed') throw new Error('Synthetic discovery unavailable')
      if (discovery === 'pending') await new Promise<void>(resolve => { probe.finishDiscovery = resolve })
      return { password: true, sso: false, oidc: false }
    }
    engine.login = async (...args: unknown[]) => {
      probe.logins.push(args)
      throw new Error('Synthetic password refusal')
    }
    engine.registerAvailable = async () => { probe.registrations++; throw new Error('Unexpected registration request') }
  }, discovery)
}

async function probe(page: Page) {
  return page.evaluate(() => {
    const { methods, logins, registrations } = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
    return { methods, logins, registrations }
  })
}

for (const server of [undefined, 'https://wrong.example/custom']) {
  test(`full Matrix ID overrides ${server ? 'an explicitly entered URL' : 'the default server'} before credentials are sent`, async ({ page }) => {
    await page.goto('/?demo=0')
    await mockAuth(page)
    const form = page.locator('.gate-login')
    const homeserver = form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)
    if (server) await homeserver.fill(server)
    await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
    await expect(homeserver).toHaveValue('other.example')
    expect(await homeserver.evaluate(el => (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly)).toBe(true)
    await expect(form.getByRole('status')).toContainText('Full Matrix IDs choose their own homeserver.')
    await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
    await form.getByRole('button', { name: 'Connect account', exact: true }).click()
    await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
    expect(await probe(page)).toEqual({
      methods: [['other.example', true]],
      logins: [['other.example', '@synthetic:other.example', 'synthetic-password', false, true]],
      registrations: 0,
    })
    expect(new URL(page.url()).search).toBe('?demo=0')
  })
}

test('a short username keeps the explicitly selected homeserver URL editable', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  const form = page.locator('.gate-login')
  const homeserver = form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('synthetic')
  await expect(homeserver).toBeEditable()
  await homeserver.fill('https://custom.example/matrix')
  await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
  await form.getByRole('button', { name: 'Connect account', exact: true }).click()
  await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
  expect(await probe(page)).toEqual({
    methods: [['https://custom.example/matrix', false]],
    logins: [['https://custom.example/matrix', 'synthetic', 'synthetic-password', false, false]],
    registrations: 0,
  })
})

for (const input of [
  { username: '@synthetic', server: 'matrix.org' },
  { username: '@synthetic:', server: 'matrix.org' },
  { username: '@synthetic:other.example/path', server: 'matrix.org' },
  { username: 'synthetic', server: 'https://user:secret@other.example' },
  { username: 'synthetic', server: 'javascript:alert(1)' },
]) {
  test(`invalid auth destination is rejected before SDK discovery: ${input.username} / ${input.server}`, async ({ page }) => {
    await page.goto('/?demo=0')
    await mockAuth(page)
    const form = page.locator('.gate-login')
    await form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill(input.server)
    await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill(input.username)
    await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
    await form.getByRole('button', { name: 'Connect account', exact: true }).click()
    await expect(form.getByRole('alert')).toBeVisible()
    expect(await probe(page)).toEqual({ methods: [], logins: [], registrations: 0 })
  })
}

test('failed full-ID discovery never falls back to the previously selected server', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page, 'failed')
  const form = page.locator('.gate-login')
  await form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('https://previous.example')
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
  await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
  await form.getByRole('button', { name: 'Connect account', exact: true }).click()
  await expect(form.getByRole('alert')).toBeVisible()
  expect(await probe(page)).toEqual({ methods: [['other.example', true]], logins: [], registrations: 0 })
  await expect(form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('other.example')
})

test('dismissing a full-ID sign-in during discovery prevents late credential submission', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.locator('.demo-card').getByRole('button', { name: 'Connect your account', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await mockAuth(page, 'pending')
  await dialog.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
  await dialog.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
  await dialog.getByRole('button', { name: 'Connect account', exact: true }).click()
  await expect.poll(async () => (await probe(page)).methods.length).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.evaluate(async () => {
    (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe.finishDiscovery!()
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  expect(await probe(page)).toEqual({ methods: [['other.example', true]], logins: [], registrations: 0 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('registration requires a localpart and never discovers a supplied full Matrix ID', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog).toBeVisible()
  // Reset observations after entering registration: that entry may discover
  // supported password/SSO methods, but it never receives the new username.
  await mockAuth(page)
  const username = dialog.getByLabel(/^Username\s*\*?\s*\(required\)$/)
  await expect(username).toHaveAttribute('placeholder', 'you')
  await username.fill('@synthetic:other.example')
  await expect(dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('matrix.org')
  await expect(dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toBeEditable()
  await dialog.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-password')
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(dialog.getByText('Registration needs a local username, not a full Matrix ID. Omit @ and the homeserver.', { exact: true })).toBeVisible()
  expect(await probe(page)).toEqual({ methods: [], logins: [], registrations: 0 })
})

for (const kind of ['sso', 'oidc'] as const) {
  test(`full Matrix ID selects the logical server for ${kind.toUpperCase()}`, async ({ page }) => {
    await page.goto('/?demo=0')
    await mockAuth(page)
    await page.evaluate(async kind => {
      // @ts-expect-error Vite resolves this browser-only source import.
      const { engine } = await import('/src/store.ts')
      const probe = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
      engine.loginMethods = async (...args: unknown[]) => {
        probe.methods.push(args)
        return { password: false, sso: kind === 'sso', oidc: kind === 'oidc' }
      }
      const start = async (...args: unknown[]) => { probe.logins.push(args); throw new Error('Synthetic provider stopped') }
      engine.startSsoLogin = start
      engine.startOidcLogin = start
    }, kind)
    const form = page.locator('.gate-login')
    await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
    await form.getByRole('button', { name: 'Continue with SSO', exact: true }).click()
    await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
    const calls = await probe(page)
    expect(calls.methods).toEqual([['other.example', true]])
    const callback = new URL('oidc-callback.html', page.url()).href
    expect(calls.logins).toEqual([kind === 'sso'
      ? ['other.example', callback, true]
      : ['other.example', callback, undefined, false, true]])
  })
}

test('Register turns a full ID into explicit localpart confirmation on its logical server', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  const form = page.locator('.gate-login')
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
  await form.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('must-not-carry-over')
  await form.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog.getByRole('button', { name: 'Create account', exact: true })).toBeVisible()
  await expect(dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('other.example')
  await expect(dialog.getByLabel(/^Username\s*\*?\s*\(required\)$/)).toHaveValue('synthetic')
  await expect(dialog.getByLabel(/^Password\s*\*?\s*\(required\)$/)).toHaveValue('')
  expect(await probe(page)).toEqual({ methods: [['other.example', true]], logins: [], registrations: 0 })
})

test('failed Register discovery keeps the full-ID input and previous explicit server unchanged', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page, 'failed')
  const form = page.locator('.gate-login')
  await form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('https://previous.example')
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
  await form.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(form.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(form.getByLabel(/^Username\s*\*?\s*\(required\)$/)).toHaveValue('@synthetic:other.example')
  expect(await probe(page)).toEqual({ methods: [['other.example', true]], logins: [], registrations: 0 })
  // Removing full-ID authority reveals the unchanged manually selected endpoint.
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('synthetic')
  await expect(form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('https://previous.example')
})

test('registration sends availability and create requests to the SDK-discovered delegated endpoint', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  await page.locator('.gate-login').getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:logical.example')
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog).toBeVisible()
  await mockAuth(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
    engine.loginMethods = async (...args: unknown[]) => {
      probe.methods.push(args)
      return { password: true, sso: false, oidc: false, homeserverUrl: 'https://delegate.example/matrix' }
    }
    engine.registerAvailable = async (...args: unknown[]) => { probe.logins.push(['available', ...args]); return true }
    engine.register = async (...args: unknown[]) => {
      probe.registrations++
      probe.logins.push(['register', ...args])
      throw new Error('Synthetic registration stopped before account creation')
    }
  })
  await dialog.getByLabel(/^Password\s*\*?\s*\(required\)$/).fill('synthetic-new-password')
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect.poll(async () => (await probe(page)).registrations).toBe(1)
  expect(await probe(page)).toEqual({
    methods: [['logical.example', false]],
    logins: [
      ['available', 'https://delegate.example/matrix', 'synthetic'],
      ['register', 'https://delegate.example/matrix', 'synthetic', 'synthetic-new-password'],
    ],
    registrations: 1,
  })
  await expect(dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('logical.example')
})

test('SSO from registration accepts an empty username and validates only the selected server', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog).toBeVisible()
  await mockAuth(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
    engine.loginMethods = async (...args: unknown[]) => { probe.methods.push(args); return { password: false, sso: true, oidc: false } }
    engine.startSsoLogin = async (...args: unknown[]) => { probe.logins.push(args); throw new Error('Synthetic provider stopped') }
  })
  await dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('provider.example')
  await dialog.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('')
  await dialog.getByRole('button', { name: 'Continue with SSO', exact: true }).click()
  await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
  expect((await probe(page)).methods).toEqual([['provider.example', false]])
  expect((await probe(page)).logins[0][0]).toBe('provider.example')
})

test('QR scanning inherits the full-ID logical server when the code has no server hint', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
    engine.loginQrLogin = async (server: string, _bytes: Uint8Array, redirectUri: string, _progress: unknown, _signal: unknown, logicalServer: boolean) => {
      probe.logins.push([server, redirectUri, logicalServer])
      throw new Error('Synthetic QR stopped before relay contact')
    }
  })
  const form = page.locator('.gate-login')
  await form.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('https://previous.example')
  await form.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:other.example')
  await form.getByRole('button', { name: 'Scan QR code to sign in', exact: true }).click()
  // Valid MSC4108 bytes with a relay but no server hint; decoding is real,
  // while the SDK boundary is stubbed before any network or credential work.
  const relay = [...'https://127.0.0.1:9/synthetic'].map(character => character.charCodeAt(0))
  const bytes = Uint8Array.from([77, 65, 84, 82, 73, 88, 2, 3, ...new Array(32).fill(7), relay.length >> 8, relay.length & 255, ...relay])
  const image = await QRCode.toBuffer([{ data: bytes, mode: 'byte' }], { type: 'png' })
  await page.getByLabel('QR code image file').setInputFiles({ name: 'synthetic-qr.png', mimeType: 'image/png', buffer: image })
  await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
  expect(await probe(page)).toEqual({
    methods: [],
    logins: [['other.example', new URL('oidc-callback.html', page.url()).href, true]],
    registrations: 0,
  })
})

test('QR opened from registration snapshots its selected server before the modal changes', async ({ page }) => {
  await page.goto('/?demo=0')
  await mockAuth(page)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a Matrix account' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/).fill('selected.example')
  await dialog.getByLabel(/^Username\s*\*?\s*\(required\)$/).fill('@synthetic:different.example')
  await expect(dialog.getByLabel(/^Homeserver\s*\*?\s*\(required\)$/)).toHaveValue('selected.example')
  await mockAuth(page)
  await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-only source import.
    const { engine } = await import('/src/store.ts')
    const probe = (window as unknown as { destinationProbe: DestinationProbe }).destinationProbe
    engine.loginQrLogin = async (server: string, _bytes: Uint8Array, redirectUri: string, _progress: unknown, _signal: unknown, logicalServer: boolean) => {
      probe.logins.push([server, redirectUri, logicalServer])
      throw new Error('Synthetic QR stopped before relay contact')
    }
  })
  await dialog.getByRole('button', { name: 'Scan QR code to sign in', exact: true }).click()
  const relay = [...'https://127.0.0.1:9/synthetic'].map(character => character.charCodeAt(0))
  const bytes = Uint8Array.from([77, 65, 84, 82, 73, 88, 2, 3, ...new Array(32).fill(7), relay.length >> 8, relay.length & 255, ...relay])
  const image = await QRCode.toBuffer([{ data: bytes, mode: 'byte' }], { type: 'png' })
  await page.getByLabel('QR code image file').setInputFiles({ name: 'synthetic-qr.png', mimeType: 'image/png', buffer: image })
  await expect.poll(async () => (await probe(page)).logins.length).toBe(1)
  expect(await probe(page)).toEqual({
    methods: [],
    logins: [['selected.example', new URL('oidc-callback.html', page.url()).href, false]],
    registrations: 0,
  })
})
