import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const decode = vi.hoisted(() => vi.fn())
vi.mock('../src/qr', async original => ({ ...await original<typeof import('../src/qr')>(), decodeQrLoginBytes: decode }))
beforeEach(() => { vi.resetModules(); vi.stubEnv('VITE_FERN_DEMO', '0'); vi.stubGlobal('location', { origin: 'https://fern.example' }); decode.mockReset() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('QR flow ownership', () => {
  it.each([false, true])('closing/reopening during decode cannot dispatch or replace errors (reject=%s)', async reject => {
    const store = await import('../src/store')
    const pending = deferred<{ serverName: string }>()
    decode.mockReturnValueOnce(pending.promise)
    const login = vi.spyOn(store.engine, 'loginQrLogin').mockResolvedValue('unused')
    store.openQr('login')
    const attempt = store.submitQrBytes(new Uint8Array([1]), 'example.org')
    store.closeQr(); store.openQr('login'); store.state.error = 'New view error'
    if (reject) pending.reject(new Error('Old decode error'))
    else pending.resolve({ serverName: 'example.org' })
    await attempt
    expect(login).not.toHaveBeenCalled()
    expect(store.state.error).toBe('New view error')
    expect(store.qrFlow.value?.stage).toBe('camera')
  })
  it('close aborts active work and suppresses late SDK errors', async () => {
    const store = await import('../src/store')
    decode.mockResolvedValue({ serverName: 'example.org' })
    const pending = deferred<string>()
    let signal: AbortSignal | undefined
    const login = vi.spyOn(store.engine, 'loginQrLogin').mockImplementation((_server, _bytes, _uri, _progress, abort) => { signal = abort; return pending.promise })
    store.openQr('login')
    const attempt = store.submitQrBytes(new Uint8Array([1]), 'example.org', 'https://fern.example/fern-matrix/oidc-callback.html')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(login.mock.calls[0]?.[2]).toBe('https://fern.example/fern-matrix/oidc-callback.html')
    store.closeQr(); store.state.error = 'New view error'
    expect(signal?.aborted).toBe(true)
    pending.reject(new Error('Late SDK error')); await attempt
    expect(store.state.error).toBe('New view error')
  })
})

describe('camera lifecycle', () => {
  it('stops late permission streams without attaching or playing video', async () => {
    const { scanQrCamera } = await import('../src/qr')
    const pending = deferred<MediaStream>()
    const stop = vi.fn(), play = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending.promise } })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const video = { srcObject: null, play } as unknown as HTMLVideoElement
    const abort = new AbortController()
    const starting = scanQrCamera(video, vi.fn(), abort.signal)
    abort.abort()
    pending.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await starting
    expect(stop).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
    expect(video.srcObject).toBeNull()
  })
  it('stops tracks even while video playback remains pending', async () => {
    const { scanQrCamera } = await import('../src/qr')
    const playback = deferred<void>(), stop = vi.fn()
    const play = vi.fn(() => playback.promise)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const video = { srcObject: null, play } as unknown as HTMLVideoElement
    const abort = new AbortController()
    const starting = scanQrCamera(video, vi.fn(), abort.signal)
    await vi.waitFor(() => expect(play).toHaveBeenCalled())
    abort.abort()
    expect(stop).toHaveBeenCalledTimes(1)
    playback.resolve(); await starting
    expect(video.srcObject).toBeNull()
  })
})

it('a late aborted camera cannot detach a newer stream', async () => {
  const { scanQrCamera } = await import('../src/qr')
  const permission = deferred<MediaStream>()
  const oldStop = vi.fn(), newerStream = { newer: true }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const video = { srcObject: null, play: vi.fn() } as unknown as HTMLVideoElement
  const abort = new AbortController()
  const starting = scanQrCamera(video, vi.fn(), abort.signal)
  abort.abort()
  video.srcObject = newerStream as unknown as MediaStream
  permission.resolve({ getTracks: () => [{ stop: oldStop }] } as unknown as MediaStream)
  await starting
  expect(oldStop).toHaveBeenCalledTimes(1)
  expect(video.srcObject).toBe(newerStream)
})

it('keeps the decoded QR server authoritative over the form fallback', async () => {
  const store = await import('../src/store')
  decode.mockResolvedValue({ serverName: 'code.example' })
  const login = vi.spyOn(store.engine, 'loginQrLogin').mockRejectedValue(new Error('Synthetic stop'))
  store.openQr('login')
  await store.submitQrBytes(new Uint8Array([1]), 'form.example', 'https://fern.example/callback', true)
  expect(login.mock.calls[0]?.[0]).toBe('code.example')
  expect(login.mock.calls[0]?.[5]).toBe(true)
})
