import { isTauri } from './tauri'

const removing = new Set<string>()
export function isSessionRemoving(id: string): boolean {
  return removing.has(id) || (typeof localStorage !== 'undefined' && localStorage.getItem(`fern.removing.${id}`) === '1')
}
export function markSessionRemoving(id: string) {
  removing.add(id)
  localStorage.setItem(`fern.removing.${id}`, '1')
}
async function storageLock<T>(name: string, strict: boolean, work: () => T): Promise<T> {
  // Native cross-process coordination remains explicitly unqualified.
  if (isTauri()) return work()
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) {
    if (strict) throw new Error('Safe session removal needs browser Web Locks support. Use a supported browser to retry.')
    return work()
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    return await locks.request(name, { signal: controller.signal }, () => {
      clearTimeout(timer)
      return work()
    })
  } finally { clearTimeout(timer) }
}
export function sessionStorageLock<T>(id: string, strict: boolean, work: () => T): Promise<T> {
  return storageLock(`fern.session-secret.${id}`, strict, work)
}
export function routingStorageLock<T>(strict: boolean, work: () => T): Promise<T> {
  return storageLock('fern.session-routing', strict, work)
}
export async function saveSessionDraft(id: string, roomId: string, text: string): Promise<void> {
  if (!id || !roomId) return
  // Values are captured by the caller, not read after lock acquisition.
  await sessionStorageLock(id, false, () => {
    if (isSessionRemoving(id)) return
    const key = `fern.draft.${id}/${roomId}`
    if (text) localStorage.setItem(key, text)
    else localStorage.removeItem(key)
  })
}
export function readSessionDraft(id: string, roomId: string): string {
  return !id || !roomId || isSessionRemoving(id) ? '' : localStorage.getItem(`fern.draft.${id}/${roomId}`) ?? ''
}
export async function deleteSessionDrafts(id: string): Promise<void> {
  await sessionStorageLock(id, true, () => {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith(`fern.draft.${id}/`)) localStorage.removeItem(key)
    }
  })
}
