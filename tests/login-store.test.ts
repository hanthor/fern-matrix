import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_FERN_DEMO', '0') })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('sign-in error privacy and hint state', () => {
  it('preserves typed credential refusal without exposing server-controlled details', async () => {
    const store = await import('../src/store')
    vi.spyOn(store.engine, 'login').mockRejectedValue({ tag: 'MatrixApi', inner: { code: 'M_FORBIDDEN', msg: 'private-name private-password' } })
    await store.signIn('example.org', 'private-name', 'private-password')
    expect(store.passwordLoginRejected.value).toBe(true)
    expect(store.state.error).toBe('Sign-in was not accepted. Check your homeserver, username and password.')
    expect(store.state.busy).toBe(false)
  })
  it('clears old hints on a transient failure and never probes account existence', async () => {
    const store = await import('../src/store')
    store.passwordLoginRejected.value = true
    vi.spyOn(store.engine, 'login').mockRejectedValue(new Error('private-name: network failed M_FORBIDDEN'))
    const available = vi.spyOn(store.engine, 'registerAvailable')
    await store.signIn('example.org', 'private-name', 'private-password')
    expect(store.passwordLoginRejected.value).toBe(false)
    expect(store.state.error).not.toContain('private-name')
    expect(available).not.toHaveBeenCalled()
  })
})

it('suppresses errors and hints after the submitting view is dismissed', async () => {
  const store = await import('../src/store')
  let reject!: (error: unknown) => void
  vi.spyOn(store.engine, 'login').mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
  let owns = true
  const attempt = store.signIn('example.org', 'private-name', 'private-password', () => owns)
  owns = false; store.state.error = 'New view error'
  reject({ tag: 'MatrixApi', inner: { code: 'M_FORBIDDEN' } })
  await attempt
  expect(store.state.error).toBe('New view error')
  expect(store.passwordLoginRejected.value).toBe(false)
})

it('does not register after dismissal during an availability check', async () => {
  const store = await import('../src/store')
  let resolve!: (available: boolean) => void
  vi.spyOn(store.engine, 'registerAvailable').mockImplementation(() => new Promise(yes => { resolve = yes }))
  const register = vi.spyOn(store.engine, 'register')
  let owns = true
  const attempt = store.registerAccount('example.org', 'private-name', 'private-password', () => owns)
  owns = false; resolve(true)
  expect(await attempt).toBe(false)
  expect(register).not.toHaveBeenCalled()
})

it('uses the SDK-discovered registration endpoint but retains the logical sign-in server', async () => {
  const store = await import('../src/store')
  const available = vi.spyOn(store.engine, 'registerAvailable').mockResolvedValue(true)
  const register = vi.spyOn(store.engine, 'register').mockResolvedValue('@alice:other.example')
  const login = vi.spyOn(store.engine, 'login').mockRejectedValue(new Error('Stop synthetic follow-on login'))
  await store.registerAccount('other.example', 'alice', 'synthetic', () => true, 'https://delegate.example.net')
  expect(available).toHaveBeenCalledWith('https://delegate.example.net', 'alice')
  expect(register).toHaveBeenCalledWith('https://delegate.example.net', 'alice', 'synthetic')
  expect(login).toHaveBeenCalledWith('other.example', 'alice', 'synthetic')
})
