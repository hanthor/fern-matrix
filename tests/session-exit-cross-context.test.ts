import { afterEach, expect, it, vi } from 'vitest'

const wrapping = vi.hoisted(() => ({ wait: undefined as undefined | Promise<string> }))
vi.mock('../src/applock', () => ({
  isLockEnabled: () => true,
  wrapSecret: () => wrapping.wait!,
  unwrapSecret: vi.fn(),
}))
vi.mock('../src/tauri', () => ({ isTauri: () => false, secretGet: vi.fn(), secretSet: vi.fn(), secretDelete: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it.each(['wrapping', 'queued-lock'] as const)('a separate context cannot resurrect a secret paused at %s', async pause => {
  const values = new Map<string, string>([['fern.sessions.v1', JSON.stringify({
    'cross-context': { userId: '@a:example.org', homeserverUrl: 'https://example.org' },
  })]])
  let releaseLock!: () => void
  let lockTail: Promise<unknown> = pause === 'queued-lock' ? new Promise<void>(resolve => { releaseLock = resolve }) : Promise.resolve()
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, work: () => unknown) => {
    const next = lockTail.then(work); lockTail = next.catch(() => {}); return next
  } } })
  vi.stubGlobal('localStorage', {
    get length() { return values.size },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('indexedDB', { deleteDatabase() {
    const request = { onsuccess: null } as unknown as IDBOpenDBRequest
    queueMicrotask(() => request.onsuccess?.call(request, new Event('success')))
    return request
  } })
  let finish!: (value: string) => void
  wrapping.wait = new Promise<string>(resolve => { finish = resolve })
  // Independent module instances model separate JS realms: no shared cache or
  // engine sessionWrites registry; only the persisted storage is shared.
  vi.resetModules()
  const writer = await import('../src/secrets')
  const writing = writer.persistSecrets('cross-context', {
    session: { userId: '@a:example.org', homeserverUrl: 'https://example.org' } as import('../src/sdk/generated/matrix_sdk_ffi').Session,
    passphrase: 'test-only',
  })
  const rejected = expect(writing).rejects.toThrow('removed from this device')
  if (pause === 'queued-lock') {
    finish('wrapped-test-value')
    for (let n = 0; n < 10; n++) await Promise.resolve()
  }
  vi.resetModules()
  const { MatrixEngine } = await import('../src/sdk/engine')
  const remover = new MatrixEngine({ account() {}, rooms() {}, error() {} })
  const removal = remover.removeAccount('cross-context')
  if (pause === 'queued-lock') releaseLock()
  await removal
  expect(values.get('fern.removing.cross-context')).toBe('1')
  finish('wrapped-test-value')
  await rejected
  expect(values.has('fern.secrets.v1.cross-context')).toBe(false)
  expect(writer.cachedSecrets('cross-context')).toBeUndefined()
  expect(JSON.parse(values.get('fern.sessions.v1')!)['cross-context']).toBeUndefined()
})
