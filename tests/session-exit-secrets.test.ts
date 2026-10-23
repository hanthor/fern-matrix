import { afterEach, expect, it, vi } from 'vitest'
import { dropSecrets } from '../src/secrets'
vi.mock('../src/tauri', () => ({ isTauri: () => false, secretDelete: vi.fn(), secretGet: vi.fn(), secretSet: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())
it('strict exit deletion propagates browser storage failures without changing legacy default behavior', async () => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: () => unknown) => work() } })
  vi.stubGlobal('localStorage', { removeItem() { throw new Error('storage denied') } })
  await expect(dropSecrets('a', true)).rejects.toThrow('storage denied')
  await expect(dropSecrets('a')).resolves.toBeUndefined()
})

it('strict browser cleanup refuses unsupported cross-tab coordination', async () => {
  vi.stubGlobal('navigator', {})
  const removeItem = vi.fn()
  vi.stubGlobal('localStorage', { removeItem })
  await expect(dropSecrets('a', true)).rejects.toThrow('Web Locks')
  expect(removeItem).not.toHaveBeenCalled()
})
it('bounds queued lock acquisition without deleting data outside the lock', async () => {
  vi.useFakeTimers()
  const removeItem = vi.fn()
  vi.stubGlobal('localStorage', { removeItem })
  vi.stubGlobal('navigator', { locks: { request: (_name: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('lock wait aborted')))
  }) } })
  const pending = expect(dropSecrets('a', true)).rejects.toThrow('lock wait aborted')
  await vi.advanceTimersByTimeAsync(5001); await pending
  expect(removeItem).not.toHaveBeenCalled()
  vi.useRealTimers()
})
