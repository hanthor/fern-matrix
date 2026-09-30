// Tauri shell bridge (#29). Everything here is inert outside the native
// shell: browser and PWA builds never load the Tauri plugins.

/** True inside the Tauri webview, where the shell runtime is injected. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Listen for OS deep links (fernmatrix://…) inside the shell. Resolves to an
 * unlisten function, or undefined outside Tauri where no import is attempted.
 */
export async function onDeepLink(callback: (url: string) => void): Promise<(() => void) | undefined> {
  if (!isTauri()) return undefined
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  return onOpenUrl(urls => { for (const url of urls) callback(url) })
}

/** Open a URL in the system browser inside the shell; a no-op in browsers. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) return
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

const SECRET_SERVICE = 'com.fernmatrix.app'

/**
 * OS-keychain secret entry inside the shell (null when missing); outside the
 * shell these all resolve inertly so callers fall back to browser storage.
 */
export async function secretGet(name: string): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string | null>('secret_get', { service: SECRET_SERVICE, name })
}

export async function secretSet(name: string, value: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('secret_set', { service: SECRET_SERVICE, name, value })
}

export async function secretDelete(name: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('secret_delete', { service: SECRET_SERVICE, name })
}

/**
 * Signed desktop update check inside the shell (null when absent or outside
 * the shell). Verification uses the pubkey in tauri.conf.json; the updater
 * stays inert until signed releases publish latest.json.
 */
export async function checkAppUpdate(): Promise<{ version: string } | null> {
  if (!isTauri()) return null
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  return update ? { version: update.version } : null
}

/** Download, install and relaunch into the available update (shell only). */
export async function installAppUpdate(onStage: (stage: 'downloading' | 'installing') => void): Promise<boolean> {
  if (!isTauri()) return false
  const { check } = await import('@tauri-apps/plugin-updater')
  const { relaunch } = await import('@tauri-apps/plugin-process')
  const update = await check()
  if (!update) return false
  onStage('downloading')
  await update.downloadAndInstall()
  onStage('installing')
  await relaunch()
  return true
}
