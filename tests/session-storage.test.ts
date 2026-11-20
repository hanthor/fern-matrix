import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/tauri', () => ({ isTauri: () => false }))
let data: Map<string, string>
let queues: Map<string, Promise<unknown>>
beforeEach(() => {
  vi.resetModules()
  data = new Map(); queues = new Map()
  vi.stubGlobal('localStorage', {
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
  vi.stubGlobal('navigator', { locks: {
    request(name: string, options: { signal: AbortSignal }, work: () => unknown) {
      const prior = queues.get(name) ?? Promise.resolve()
      const next = prior.catch(() => {}).then(() => {
        if (options.signal.aborted) throw new Error('aborted')
        return work()
      })
      queues.set(name, next)
      return next
    },
  } })
})
afterEach(() => vi.unstubAllGlobals())

it('blocks stale-tab drafts inside the same lock as deletion, preserving another account', async () => {
  const staleTab = await import('../src/session-storage')
  vi.resetModules()
  const remover = await import('../src/session-storage')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const held = staleTab.sessionStorageLock('a', false, () => gate)
  const lateDraft = staleTab.saveSessionDraft('a', '!room', 'must not reappear')
  remover.markSessionRemoving('a')
  const removal = remover.deleteSessionDrafts('a')
  await remover.saveSessionDraft('b', '!room', 'survivor')
  release()
  await Promise.all([held, lateDraft, removal])
  expect(data.has('fern.draft.a/!room')).toBe(false)
  expect(data.get('fern.draft.b/!room')).toBe('survivor')
  expect(staleTab.readSessionDraft('a', '!room')).toBe('')
  await staleTab.saveSessionDraft('a', '!room', 'after successful cleanup')
  expect(data.has('fern.draft.a/!room')).toBe(false)
})

it('serializes routing read-modify-write across independent module instances', async () => {
  const first = await import('../src/session-storage')
  vi.resetModules()
  const second = await import('../src/session-storage')
  data.set('fern.sessions.v1', JSON.stringify({ a: {}, b: {} }))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const held = first.routingStorageLock(false, () => gate)
  first.markSessionRemoving('a')
  const remove = first.routingStorageLock(true, () => {
    const entries = JSON.parse(data.get('fern.sessions.v1')!)
    delete entries.a
    data.set('fern.sessions.v1', JSON.stringify(entries))
  })
  const refresh = second.routingStorageLock(false, () => {
    if (second.isSessionRemoving('a')) return
    const entries = JSON.parse(data.get('fern.sessions.v1')!)
    entries.a = { stale: true }
    data.set('fern.sessions.v1', JSON.stringify(entries))
  })
  const add = second.routingStorageLock(false, () => {
    const entries = JSON.parse(data.get('fern.sessions.v1')!)
    entries.c = {}
    data.set('fern.sessions.v1', JSON.stringify(entries))
  })
  release(); await Promise.all([held, remove, refresh, add])
  expect(Object.keys(JSON.parse(data.get('fern.sessions.v1')!)).sort()).toEqual(['b', 'c'])
})

it('refuses strict cleanup without shared locking instead of reporting deletion', async () => {
  vi.stubGlobal('navigator', {})
  const storage = await import('../src/session-storage')
  data.set('fern.draft.a/!room', 'retained')
  await expect(storage.deleteSessionDrafts('a')).rejects.toThrow('Web Locks')
  expect(data.get('fern.draft.a/!room')).toBe('retained')
})
