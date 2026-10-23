import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixEngine, LocalCleanupError } from '../src/sdk/engine'
import { dropSecrets, persistSecrets } from '../src/secrets'

vi.mock('../src/secrets', async importOriginal => ({
  ...await importOriginal<typeof import('../src/secrets')>(),
  dropSecrets: vi.fn(async () => {}),
  persistSecrets: vi.fn(async () => {}),
}))
const delegateCapture = vi.hoisted(() => ({ value: undefined as undefined | {
  saveSessionInKeychain: (session: import('../src/sdk/generated/matrix_sdk_ffi').Session) => void
  retrieveSessionFromKeychain: (id: string) => unknown
} }))
vi.mock('../src/sdk/index', () => ({
  uniffiInitAsync: vi.fn(async () => {}), initPlatform: vi.fn(),
  LogLevel: { Warn: 0 }, BackupDownloadStrategy: { AfterDecryptionFailure: 0 },
  ClientBuilder: class {
    indexeddbStore() { return this }
    backupDownloadStrategy() { return this }
    threadsEnabled() { return this }
    autoEnableCrossSigning() { return this }
    setSessionDelegate(delegate: typeof delegateCapture.value) { delegateCapture.value = delegate; return this }
  },
  IndexedDbStoreBuilder: class { passphrase() { return this } },
}))
let data: Map<string, string>
let result: 'success' | 'error' | 'blocked' | 'blocked-then-success' | 'throw' | 'hang'
let deleted: string[]
beforeEach(() => {
  data = new Map([['fern.sessions.v1', JSON.stringify({
    a: { userId: '@a:example.org', homeserverUrl: 'https://example.org' },
    b: { userId: '@b:example.org', homeserverUrl: 'https://example.org' },
  })], ['fern.draft.a.room', 'draft']])
  vi.stubGlobal('localStorage', {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
  result = 'success'; deleted = []
  vi.stubGlobal('indexedDB', { deleteDatabase(name: string) {
    deleted.push(name)
    if (result === 'throw') throw new Error('unavailable')
    const request = { onsuccess: null, onerror: null, onblocked: null } as unknown as IDBOpenDBRequest
    const current = result
    queueMicrotask(() => {
      if (current === 'success') request.onsuccess?.call(request, new Event('success'))
      if (current === 'error') request.onerror?.call(request, new Event('error'))
      if (current === 'blocked' || current === 'blocked-then-success') request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent)
      if (current === 'blocked-then-success') queueMicrotask(() => request.onsuccess?.call(request, new Event('success')))
    })
    return request
  } })
  vi.mocked(dropSecrets).mockReset().mockResolvedValue()
  vi.mocked(persistSecrets).mockReset().mockResolvedValue()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function engine() { return new MatrixEngine({ account() {}, rooms() {}, error() {} }) }
function records() { return JSON.parse(data.get('fern.sessions.v1')!) }

describe('actual engine local-cleanup contract', () => {
  it('blocks late delegate writes and waits for an accepted refresh before secret deletion', async () => {
    const sdk = engine()
    data.set('fern.sessions.v1', JSON.stringify({ c: { userId: '@c:example.org', homeserverUrl: 'https://example.org' } }))
    await (sdk as unknown as { builder(data: { storeId: string; passphrase: string }, discover: boolean): Promise<unknown> })
      .builder({ storeId: 'c', passphrase: 'passphrase' }, false)
    let finish!: () => void
    vi.mocked(persistSecrets).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const session = { userId: '@c:example.org', homeserverUrl: 'https://example.org' } as import('../src/sdk/generated/matrix_sdk_ffi').Session
    delegateCapture.value!.saveSessionInKeychain(session)
    const removal = sdk.removeAccount('c')
    for (let n = 0; n < 10; n++) await Promise.resolve()
    expect(dropSecrets).not.toHaveBeenCalled()
    delegateCapture.value!.saveSessionInKeychain(session)
    expect(persistSecrets).toHaveBeenCalledTimes(1)
    expect(() => delegateCapture.value!.retrieveSessionFromKeychain('@c:example.org')).toThrow('local cleanup')
    finish(); await removal
    expect(dropSecrets).toHaveBeenCalledWith('c', true)
    delegateCapture.value!.saveSessionInKeychain(session)
    expect(persistSecrets).toHaveBeenCalledTimes(1)
    expect(records().c).toBeUndefined()
  })
  it('bounds stalled secret writes without racing deletion and permits retry', async () => {
    vi.useFakeTimers()
    const sdk = engine()
    data.set('fern.sessions.v1', JSON.stringify({ d: { userId: '@d:example.org', homeserverUrl: 'https://example.org' } }))
    await (sdk as unknown as { builder(data: { storeId: string; passphrase: string }, discover: boolean): Promise<unknown> })
      .builder({ storeId: 'd', passphrase: 'passphrase' }, false)
    let finish!: () => void
    vi.mocked(persistSecrets).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    delegateCapture.value!.saveSessionInKeychain({ userId: '@d:example.org', homeserverUrl: 'https://example.org' } as import('../src/sdk/generated/matrix_sdk_ffi').Session)
    const pending = expect(sdk.removeAccount('d')).rejects.toBeInstanceOf(LocalCleanupError)
    await vi.advanceTimersByTimeAsync(5001); await pending
    expect(dropSecrets).not.toHaveBeenCalled()
    expect(deleted).toHaveLength(3)
    expect(records().d).toBeDefined()
    expect(data.get('fern.removing.d')).toBe('1')
    finish(); await Promise.resolve()
    const retry = sdk.removeAccount('d')
    await vi.runAllTimersAsync(); await retry
    expect(dropSecrets).toHaveBeenCalledWith('d', true)
    expect(records().d).toBeUndefined()
  })
  it('reports a durable cleanup tombstone instead of restoring the saved session', async () => {
    data.set('fern.removing.a', '1')
    data.set('fern.sessions.v1', JSON.stringify({ a: { userId: '@a:example.org', homeserverUrl: 'https://example.org' } }))
    const account = vi.fn()
    const sdk = new MatrixEngine({ account, rooms() {}, error() {} })
    await sdk.restoreAll()
    expect(account).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', connection: 'error', error: expect.stringContaining('Local cleanup is incomplete') }))
  })

  it('waits through transient blocking for confirmed deletion success', async () => {
    result = 'blocked-then-success'
    await engine().removeAccount('a')
    expect(records().a).toBeUndefined()
    expect(deleted).toHaveLength(3)
  })
  it('attempts every database after secret failure and retains retry identity', async () => {
    const sdk = engine()
    vi.mocked(dropSecrets).mockRejectedValueOnce(new Error('keychain unavailable'))
    await expect(sdk.removeAccount('a')).rejects.toBeInstanceOf(LocalCleanupError)
    expect(dropSecrets).toHaveBeenCalledWith('a', true)
    expect(deleted).toEqual(['fern-a', 'fern-a::matrix-sdk-crypto', 'fern-a::matrix-sdk-state'])
    expect(records().a).toBeDefined()
    await sdk.removeAccount('a')
    expect(deleted).toHaveLength(6)
    expect(records().a).toBeUndefined()
    expect(records().b).toBeDefined()
  })
  it.each(['error', 'throw'] as const)('does not report %s database deletion as success', async failure => {
    const sdk = engine(); result = failure
    await expect(sdk.removeAccount('a')).rejects.toBeInstanceOf(LocalCleanupError)
    expect(deleted).toHaveLength(3)
    expect(records().a).toBeDefined()
    result = 'success'
    await sdk.removeAccount('a')
    expect(records().a).toBeUndefined()
  })
  it.each(['hang', 'blocked'] as const)('bounds %s deletion and allows a later local-only retry', async failure => {
    vi.useFakeTimers(); result = failure
    const sdk = engine()
    const pending = expect(sdk.removeAccount('a')).rejects.toBeInstanceOf(LocalCleanupError)
    await vi.advanceTimersByTimeAsync(5001)
    await pending
    expect(records().a).toBeDefined()
    result = 'success'
    const retry = sdk.removeAccount('a')
    await vi.runAllTimersAsync()
    await retry
    expect(records().a).toBeUndefined()
  })
  it('does not falsely succeed after server revocation with partial local cleanup', async () => {
    const sdk = engine()
    const logout = vi.fn(async () => {})
    ;(sdk as unknown as { clients: Map<string, unknown> }).clients.set('a', { logout })
    result = 'error'
    await expect(sdk.logout('a')).rejects.toThrow('may already be revoked')
    expect(logout).toHaveBeenCalledTimes(1)
    expect(records().a).toBeDefined()
    result = 'success'
    await sdk.removeAccount('a')
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
