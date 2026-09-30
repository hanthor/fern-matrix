import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appLocked, browserNotify, changeAppPin, disableAppPin, lockEnabled, lockNow, maybeNotify, setupAppPin, unlockApp } from '../src/store'
import { loadSecrets, persistSecrets } from '../src/secrets'
import type { Message, Room } from '../src/types'

// Device app lock (#38) through the store: PIN lifecycle, secret-envelope
// persistence while locked, and notification silence behind the lock.
const room = (id: string): Room => ({ id, accountId: 'demo-home', name: id, topic: '', direct: false,
  space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: 2, preview: '',
  timestamp: 0, membership: 'joined' })
const message = (id: string): Message => ({ id, sender: '@them:x', name: 'Them',
  body: 'hello', timestamp: 0, own: false, kind: 'text', reactions: [] })
const secrets = { session: { userId: '@a:x', deviceId: 'D', accessToken: 'secret-token', homeserverUrl: 'https://x' }, passphrase: 'pw' }

function fakeLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
  })
  return values
}

describe('store app lock', () => {
  let stored: Map<string, string>
  beforeEach(() => { stored = fakeLocalStorage() })

  it('sets up, locks, unlocks and wraps stored secrets', async () => {
    browserNotify.value = true
    // A pre-existing plaintext entry must move under the new key at setup.
    await persistSecrets('s1', secrets as never)
    expect(stored.get('fern.secrets.v1.s1')).toContain('secret-token')
    expect(await setupAppPin('1234')).toBe(true)
    expect(lockEnabled.value).toBe(true)
    expect(appLocked.value).toBe(false)
    const raw = stored.get('fern.secrets.v1.s1')!
    expect(raw).toContain('"enc"')
    expect(raw).not.toContain('secret-token')
    lockNow()
    expect(appLocked.value).toBe(true)
    expect(await loadSecrets('s1')).toBeNull()
    // Locked screens stay silent even for mention-worthy messages.
    expect(maybeNotify('demo-home', room('general'), message('m1'))).toBe(false)
    expect(await unlockApp('wrong')).toBe(false)
    expect(appLocked.value).toBe(true)
    expect(await unlockApp('1234')).toBe(true)
    expect(appLocked.value).toBe(false)
    expect(await loadSecrets('s1')).toEqual(secrets)
  })

  it('changes the PIN by rewrapping stored secrets', async () => {
    expect(await setupAppPin('1234')).toBe(true)
    await persistSecrets('s2', secrets as never)
    expect(await changeAppPin('1234', '5678')).toBe(true)
    lockNow()
    expect(await unlockApp('1234')).toBe(false)
    expect(await unlockApp('5678')).toBe(true)
    expect(await loadSecrets('s2')).toEqual(secrets)
    expect(await changeAppPin('nope', '0000')).toBe(false)
  })

  it('disables the lock back to plaintext storage', async () => {
    expect(await setupAppPin('1234')).toBe(true)
    await persistSecrets('s3', secrets as never)
    expect(await disableAppPin('1234')).toBe(true)
    expect(lockEnabled.value).toBe(false)
    expect(stored.get('fern.secrets.v1.s3')).toContain('secret-token')
    expect(await loadSecrets('s3')).toEqual(secrets)
  })
})
