import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTauri, onDeepLink, openExternal, secretDelete, secretGet, secretSet, checkAppUpdate, installAppUpdate } from '../src/tauri'

// Tauri shell bridge (#29): outside the native shell everything is inert and
// no Tauri plugin is ever imported. Inside the shell the deep link carries an
// OIDC callback into the existing validated finish path.
const globalWindow = globalThis as unknown as { window?: Record<string, unknown> }
const savedWindow = globalWindow.window
afterEach(() => {
  vi.unmock('@tauri-apps/plugin-deep-link')
  vi.unmock('@tauri-apps/plugin-opener')
  if (savedWindow === undefined) delete globalWindow.window
  else globalWindow.window = savedWindow
})

describe('tauri shell bridge', () => {
  it('is inert outside the shell', async () => {
    delete globalWindow.window
    expect(isTauri()).toBe(false)
    await expect(onDeepLink(() => { throw new Error('must not fire') })).resolves.toBeUndefined()
    await expect(openExternal('fernmatrix://oidc-callback?code=x')).resolves.toBeUndefined()
  })

  it('routes shell deep links into the callback', async () => {
    globalWindow.window = { __TAURI_INTERNALS__: {} }
    expect(isTauri()).toBe(true)
    const seen: string[] = []
    const listeners: ((urls: string[]) => void)[] = []
    vi.doMock('@tauri-apps/plugin-deep-link', () => ({
      onOpenUrl: async (callback: (urls: string[]) => void) => {
        listeners.push(callback)
        return () => { listeners.length = 0 }
      },
    }))
    const stop = await onDeepLink(url => seen.push(url))
    listeners.forEach(emit => emit(['fernmatrix://oidc-callback?code=abc']))
    expect(seen).toEqual(['fernmatrix://oidc-callback?code=abc'])
    stop?.()
    expect(listeners).toHaveLength(0)
  })
})

describe('tauri secret bridge', () => {
  it('stays inert outside the shell', async () => {
    delete globalWindow.window
    await expect(secretGet('fern.session.x')).resolves.toBeNull()
    await expect(secretSet('fern.session.x', 'v')).resolves.toBeUndefined()
    await expect(secretDelete('fern.session.x')).resolves.toBeUndefined()
  })

  it('invokes the keychain commands inside the shell', async () => {
    globalWindow.window = { __TAURI_INTERNALS__: {} }
    const calls: { command: string; args: Record<string, unknown> }[] = []
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args })
        return command === 'secret_get' ? 'stored' : undefined
      },
    }))
    await expect(secretGet('fern.session.x')).resolves.toBe('stored')
    await secretSet('fern.session.x', 'v')
    await secretDelete('fern.session.x')
    expect(calls.map(call => call.command)).toEqual(['secret_get', 'secret_set', 'secret_delete'])
    expect(calls[0].args).toEqual({ service: 'com.fernmatrix.app', name: 'fern.session.x' })
    vi.doUnmock('@tauri-apps/api/core')
  })
})

describe('tauri updater bridge', () => {
  it('stays inert outside the shell', async () => {
    delete globalWindow.window
    await expect(checkAppUpdate()).resolves.toBeNull()
    await expect(installAppUpdate(() => { throw new Error('must not stage') })).resolves.toBe(false)
  })

  it('checks and installs inside the shell', async () => {
    globalWindow.window = { __TAURI_INTERNALS__: {} }
    const stages: string[] = []
    let installed = false
    let relaunched = false
    vi.doMock('@tauri-apps/plugin-updater', () => ({
      check: async () => ({
        version: '0.2.0',
        downloadAndInstall: async () => { installed = true },
      }),
    }))
    vi.doMock('@tauri-apps/plugin-process', () => ({ relaunch: async () => { relaunched = true } }))
    await expect(checkAppUpdate()).resolves.toEqual({ version: '0.2.0' })
    await expect(installAppUpdate(stage => stages.push(stage))).resolves.toBe(true)
    expect(installed).toBe(true)
    expect(relaunched).toBe(true)
    expect(stages).toEqual(['downloading', 'installing'])
    vi.doUnmock('@tauri-apps/plugin-updater')
    vi.doUnmock('@tauri-apps/plugin-process')
  })

  it('reports no update without installing', async () => {
    globalWindow.window = { __TAURI_INTERNALS__: {} }
    vi.doMock('@tauri-apps/plugin-updater', () => ({ check: async () => null }))
    await expect(checkAppUpdate()).resolves.toBeNull()
    await expect(installAppUpdate(() => { throw new Error('must not stage') })).resolves.toBe(false)
    vi.doUnmock('@tauri-apps/plugin-updater')
  })
})
