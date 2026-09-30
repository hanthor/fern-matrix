import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLockRecord, disablePin, isLockEnabled, isUnlocked, loadLockTimeout, lockApp, lockKEK, saveLockTimeout, setupPin, unwrapSecret, verifyPin, wrapSecret } from '../src/applock'

// App PIN lock (#38): KDF round trip, wrong-PIN rejection with backoff, and
// secret wrapping bound to the unlocked key.
function fakeLocalStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  return values
}

describe('app PIN lock', () => {
  beforeEach(() => { fakeLocalStorage(); lockApp(); clearLockRecord() })

  it('rejects short PINs and starts locked', async () => {
    expect(isLockEnabled()).toBe(false)
    expect(isUnlocked()).toBe(false)
    await expect(setupPin('123')).rejects.toThrow('4 to 64')
    expect(isLockEnabled()).toBe(false)
  })

  it('sets up, verifies and wraps secrets while unlocked', async () => {
    await setupPin('correct-horse')
    expect(isLockEnabled()).toBe(true)
    expect(isUnlocked()).toBe(true)
    expect(lockKEK()).not.toBeNull()
    const sealed = await wrapSecret('{"session":"x"}')
    expect(sealed).toBeTruthy()
    expect(await unwrapSecret(sealed!)).toBe('{"session":"x"}')
    lockApp()
    expect(isUnlocked()).toBe(false)
    expect(await wrapSecret('x')).toBeNull()
    expect(await unwrapSecret(sealed!)).toBeNull()
    expect(await verifyPin('correct-horse')).toBe(true)
    expect(isUnlocked()).toBe(true)
    expect(await unwrapSecret(sealed!)).toBe('{"session":"x"}')
  })

  it('rejects wrong PINs with growing lockout', async () => {
    await setupPin('right-pin')
    lockApp()
    for (let attempt = 0; attempt < 5; attempt++) expect(await verifyPin('wrong')).toBe(false)
    // Sixth failure arms the backoff.
    expect(await verifyPin('wrong')).toBe(false)
    await expect(verifyPin('right-pin')).rejects.toThrow('Too many wrong attempts')
    expect(isUnlocked()).toBe(false)
  })

  it('defaults the auto-lock delay and validates changes', () => {
    expect(loadLockTimeout()).toBe(5)
    saveLockTimeout(15)
    expect(loadLockTimeout()).toBe(15)
    saveLockTimeout(0)
    expect(loadLockTimeout()).toBe(0)
    expect(() => saveLockTimeout(7)).toThrow('auto-lock delay')
    localStorage.setItem('fern.lock.prefs', 'bogus')
    expect(loadLockTimeout()).toBe(5)
  })

  it('disables the lock after verifying', async () => {
    await setupPin('temp-pin')
    expect(await verifyPin('temp-pin')).toBe(true)
    disablePin()
    expect(isLockEnabled()).toBe(false)
    expect(isUnlocked()).toBe(false)
    expect(await verifyPin('anything')).toBe(true)
  })
})
