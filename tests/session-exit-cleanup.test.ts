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
  })], ['fern.draft.a/room', 'draft']])
  vi.stubGlobal('localStorage', {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
  result = 'success'; deleted = []
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: () => unknown) => work() } })
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
  it('finishes a durable cleanup before any target SDK restoration on fresh startup', async () => {
    data.set('fern.removing.a', '1')
    data.set('fern.sessions.v1', JSON.stringify({ a: { userId: '@a:example.org', homeserverUrl: 'https://example.org' } }))
    const account = vi.fn(), cleanupPending = vi.fn()
    const sdk = new MatrixEngine({ account, cleanupPending, rooms() {}, error() {} })
    await sdk.restoreAll()
    expect(account).not.toHaveBeenCalled()
    expect(cleanupPending).not.toHaveBeenCalled()
    expect(deleted).toEqual(['fern-a', 'fern-a::matrix-sdk-crypto', 'fern-a::matrix-sdk-state'])
    expect(dropSecrets).toHaveBeenCalledWith('a', true)
    expect(data.has('fern.draft.a/room')).toBe(false)
    expect(records().a).toBeUndefined()
    expect(data.get('fern.removing.a')).toBe('1')
  })
  it('keeps startup cleanup actionable when another window still blocks databases', async () => {
    vi.useFakeTimers(); result = 'blocked'
    data.set('fern.removing.a', '1')
    data.set('fern.sessions.v1', JSON.stringify({ a: { userId: '@a:example.org', homeserverUrl: 'https://example.org' } }))
    const account = vi.fn(), cleanupPending = vi.fn()
    const sdk = new MatrixEngine({ account, cleanupPending, rooms() {}, error() {} })
    const pending = sdk.restoreAll()
    await vi.advanceTimersByTimeAsync(5001); await pending
    expect(account).not.toHaveBeenCalled()
    expect(cleanupPending).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.stringContaining('Close other Fern windows'), 'restart-required')
    expect(records().a).toBeDefined()
  })
  it('does not reclassify non-database startup errors as restart-required', async () => {
    data.set('fern.removing.a', '1')
    data.set('fern.sessions.v1', JSON.stringify({ a: { userId: '@a:example.org', homeserverUrl: 'https://example.org' } }))
    vi.mocked(dropSecrets).mockRejectedValueOnce(new Error('private'))
    const cleanupPending = vi.fn()
    await new MatrixEngine({ account() {}, cleanupPending, rooms() {}, error() {} }).restoreAll()
    expect(cleanupPending).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.stringContaining('secret-delete'), 'error')
    expect(records().a).toBeDefined()
  })

  it('waits through transient blocking for confirmed deletion success', async () => {
    result = 'blocked-then-success'
    await engine().removeAccount('a')
    expect(records().a).toBeUndefined()
    expect(deleted).toHaveLength(3)
  })
  it('exposes only allowlisted cleanup stages, never underlying storage errors', async () => {
    vi.mocked(dropSecrets).mockRejectedValueOnce(new Error('private-secret-or-backend-message'))
    try { await engine().removeAccount('a'); throw new Error('expected rejection') }
    catch (error) {
      expect(error).toBeInstanceOf(LocalCleanupError)
      expect((error as LocalCleanupError).stages).toEqual(['secret-delete'])
      expect((error as Error).message).toContain('Incomplete steps: secret-delete')
      expect((error as Error).message).not.toContain('private-secret-or-backend-message')
    }
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
  it('does not start verification when its controller arrives after removal', async () => {
    const sdk = engine()
    let finish!: (value: unknown) => void
    ;(sdk as unknown as { clients: Map<string, unknown> }).clients.set('late-verification', {
      getSessionVerificationController: () => new Promise(resolve => { finish = resolve }),
    })
    const controller = { setDelegate: vi.fn(), requestDeviceVerification: vi.fn() }
    const update = vi.fn()
    const pending = sdk.startVerification('late-verification', update)
    await sdk.removeAccount('late-verification')
    finish(controller)
    await expect(pending).rejects.toThrow('Session removed')
    expect(controller.requestDeviceVerification).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect((sdk as unknown as { verificationControllers: Map<string, unknown> }).verificationControllers.size).toBe(0)
  })
  it('does not cache a timeline produced after local removal', async () => {
    const sdk = engine()
    let finish!: (value: unknown) => void
    const room = { timeline: () => new Promise(resolve => { finish = resolve }) }
    ;(sdk as unknown as { clients: Map<string, unknown> }).clients.set('late-timeline', { getRoom: () => room })
    const onMessages = vi.fn()
    const pending = sdk.watchRoom('late-timeline', '!room', onMessages, () => {})
    await Promise.resolve()
    await sdk.removeAccount('late-timeline')
    finish({ addListener: vi.fn() })
    await expect(pending).rejects.toThrow('Session removed')
    expect(onMessages).not.toHaveBeenCalled()
    expect((sdk as unknown as { timelineCache: Map<string, unknown> }).timelineCache.size).toBe(0)
  })
  it('does not create a media URL after removal while a download is pending', async () => {
    const sdk = engine()
    let finish!: (value: Uint8Array) => void
    ;(sdk as unknown as { clients: Map<string, unknown> }).clients.set('late-media', {
      getMediaContent: () => new Promise(resolve => { finish = resolve }),
    })
    ;(sdk as unknown as { media: Map<string, unknown> }).media.set('late-media/!room/$event', {})
    const pending = sdk.download('late-media', '!room', { id: '$event' } as import('../src/types').Message)
    await sdk.removeAccount('late-media')
    finish(new Uint8Array())
    await expect(pending).rejects.toThrow('Session removed')
    expect((sdk as unknown as { objectUrls: Map<string, unknown> }).objectUrls.size).toBe(0)
  })
  it('serializes actual routing refresh and removal without dropping another account', async () => {
    const locks: string[] = []
    let tail = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request(name: string, _options: unknown, work: () => unknown) {
      locks.push(name)
      const pending = tail.then(work)
      tail = pending.catch(() => {})
      return pending
    } } })
    const sdk = engine()
    await (sdk as unknown as { builder(data: { storeId: string; passphrase: string }, discover: boolean): Promise<unknown> })
      .builder({ storeId: 'b', passphrase: 'passphrase' }, false)
    const removal = sdk.removeAccount('a')
    delegateCapture.value!.saveSessionInKeychain({ userId: '@b:example.org', homeserverUrl: 'https://new.example.org' } as import('../src/sdk/generated/matrix_sdk_ffi').Session)
    await removal
    await tail
    expect(records()).toEqual({ b: { userId: '@b:example.org', homeserverUrl: 'https://new.example.org' } })
    expect(locks.filter(name => name === 'fern.session-routing')).toHaveLength(2)
  })
  it('does not offer restart when the durable tombstone failed and databases are blocked', async () => {
    vi.useFakeTimers(); result = 'blocked'
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'fern.removing.marker-failed') throw new Error('storage denied')
      write(key, value)
    })
    const pending = expect(engine().removeAccount('marker-failed')).rejects.toMatchObject({
      stages: expect.arrayContaining(['tombstone', 'database-app', 'database-crypto', 'database-state']),
    })
    await vi.advanceTimersByTimeAsync(5001); await pending
    expect(data.has('fern.removing.marker-failed')).toBe(false)
  })
  it('keeps mixed database and secret failures as errors, not restart-required', async () => {
    result = 'error'
    vi.mocked(dropSecrets).mockRejectedValueOnce(new Error('unavailable'))
    await expect(engine().removeAccount('a')).rejects.toBeInstanceOf(LocalCleanupError)
    expect(records().a).toBeDefined()
  })
  it.each(['error', 'throw'] as const)('does not report %s database deletion as success', async failure => {
    const sdk = engine(); result = failure
    await expect(sdk.removeAccount('a')).resolves.toEqual({ status: 'restart-required' })
    expect(deleted).toHaveLength(3)
    expect(records().a).toBeDefined()
    result = 'success'
    await sdk.removeAccount('a')
    expect(records().a).toBeUndefined()
  })
  it.each(['hang', 'blocked'] as const)('bounds %s deletion and allows a later local-only retry', async failure => {
    vi.useFakeTimers(); result = failure
    const sdk = engine()
    const pending = expect(sdk.removeAccount('a')).resolves.toEqual({ status: 'restart-required' })
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
    data.set('fern.sessions.v1', JSON.stringify({ 'revoked-target': { userId: '@a:example.org', homeserverUrl: 'https://example.org' } }))
    const logout = vi.fn(async () => {})
    ;(sdk as unknown as { clients: Map<string, unknown> }).clients.set('revoked-target', { logout })
    result = 'error'
    await expect(sdk.logout('revoked-target')).resolves.toEqual({ status: 'restart-required', serverRevoked: true })
    expect(logout).toHaveBeenCalledTimes(1)
    expect(records()['revoked-target']).toBeDefined()
    result = 'success'
    await sdk.removeAccount('revoked-target')
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
