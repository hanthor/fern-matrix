import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedSecrets, dropSecrets, loadSecrets, persistSecrets, splitLegacyRecords } from '../src/secrets'
import type { Session } from '../src/sdk/generated/matrix_sdk_ffi'

// Session secrets (#29): outside the Tauri shell everything persists through
// a localStorage fallback so browsers keep working; the split keeps routing
// records free of tokens and passphrases.
const session = (userId: string): Session => ({ userId, deviceId: 'DEV', accessToken: 'token', homeserverUrl: 'https://example.org' }) as Session

function fakeLocalStorage() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  vi.stubGlobal('localStorage', storage)
  return values
}

describe('secret fallback storage', () => {
  beforeEach(() => { fakeLocalStorage() })

  it('round-trips secrets through the fallback and caches them', async () => {
    fakeLocalStorage()
    expect(cachedSecrets('s1')).toBeUndefined()
    await persistSecrets('s1', { session: session('@a:x'), passphrase: 'pw' })
    expect(cachedSecrets('s1')?.passphrase).toBe('pw')
    expect(await loadSecrets('s1')).toEqual({ session: session('@a:x'), passphrase: 'pw' })
  })

  it('returns null for missing or corrupt entries', async () => {
    fakeLocalStorage()
    expect(await loadSecrets('missing')).toBeNull()
    localStorage.setItem('fern.secrets.v1.broken', 'not json')
    expect(await loadSecrets('broken')).toBeNull()
    localStorage.setItem('fern.secrets.v1.naked', JSON.stringify({ nope: true }))
    expect(await loadSecrets('naked')).toBeNull()
  })

  it('drops secrets from fallback and cache', async () => {
    fakeLocalStorage()
    await persistSecrets('gone', { session: session('@a:x'), passphrase: 'pw' })
    await dropSecrets('gone')
    expect(cachedSecrets('gone')).toBeUndefined()
    expect(await loadSecrets('gone')).toBeNull()
  })
})

describe('splitLegacyRecords', () => {
  it('splits embedded secrets from routing records', () => {
    const legacy = { s1: { session: session('@a:x'), passphrase: 'pw' } } as Record<string, Record<string, unknown>>
    const { records, secrets } = splitLegacyRecords(legacy)
    expect(records).toEqual({ s1: { userId: '@a:x', homeserverUrl: 'https://example.org' } })
    expect(secrets).toEqual([['s1', { session: session('@a:x'), passphrase: 'pw' }]])
  })

  it('keeps new-shape records and drops unusable entries', () => {
    const mixed = {
      fresh: { userId: '@b:x', homeserverUrl: 'https://example.org' },
      junk: { nope: 1 },
    } as Record<string, Record<string, unknown>>
    const { records, secrets } = splitLegacyRecords(mixed)
    expect(records).toEqual({ fresh: { userId: '@b:x', homeserverUrl: 'https://example.org' } })
    expect(secrets).toEqual([])
  })
})
