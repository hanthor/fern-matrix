import { afterEach, expect, it, vi } from 'vitest'
const backend = vi.hoisted(() => ({ read: undefined as undefined | Promise<string> }))
vi.mock('../src/tauri', () => ({
  isTauri: () => true, secretGet: () => backend.read, secretDelete: vi.fn(), secretSet: vi.fn(),
}))
vi.mock('../src/applock', () => ({ isLockEnabled: () => false, unwrapSecret: vi.fn(), wrapSecret: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('does not return or cache a native secret read that settles after removal', async () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  })
  let finish!: (raw: string) => void
  backend.read = new Promise(resolve => { finish = resolve })
  const secrets = await import('../src/secrets')
  const storage = await import('../src/session-storage')
  const reading = secrets.loadSecrets('late-native-read')
  storage.markSessionRemoving('late-native-read')
  finish(JSON.stringify({ session: { userId: '@a:example.org' }, passphrase: 'test-only' }))
  expect(await reading).toBeNull()
  expect(secrets.cachedSecrets('late-native-read')).toBeUndefined()
})
