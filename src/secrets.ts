// Session secrets (#29): crypto-store passphrases plus Matrix access and
// refresh tokens. Inside the Tauri shell they live in the OS keychain behind
// shell commands; in browsers they fall back to a separate localStorage entry
// (same visibility as the old embedded record — see docs/NATIVE.md). Hot
// paths read the memory cache synchronously because the SDK session delegate
// is sync; every write primes the cache first so a failed persist never
// leaves readers seeing nothing.
import type { Session } from './sdk/generated/matrix_sdk_ffi'
import { isTauri, secretDelete, secretGet, secretSet } from './tauri'
import { isLockEnabled, unwrapSecret, wrapSecret } from './applock'

export interface SessionSecrets { session: Session; passphrase: string }
const entryName = (storeId: string) => `fern.session.${storeId}`
const fallbackKey = (storeId: string) => `fern.secrets.v1.${storeId}`
const cache = new Map<string, SessionSecrets>()

function fallbackRead(storeId: string): string | null {
  try { return localStorage.getItem(fallbackKey(storeId)) } catch { return null }
}
function fallbackWrite(storeId: string, raw: string) {
  try { localStorage.setItem(fallbackKey(storeId), raw) } catch { /* Storage quota does not block chatting. */ }
}
function fallbackRemove(storeId: string) {
  try { localStorage.removeItem(fallbackKey(storeId)) } catch { /* Nothing persisted, nothing to clear. */ }
}

/** Synchronous hot-path read; null until loaded (see loadSecrets). */
export function cachedSecrets(storeId: string): SessionSecrets | undefined {
  return cache.get(storeId)
}

/** Drop all cached plaintexts (app lock): post-lock reads re-decrypt. */
export function clearSecretsCache() {
  cache.clear()
}

function parseSecrets(raw: string): SessionSecrets | null {
  try {
    const secrets = JSON.parse(raw) as SessionSecrets
    if (typeof secrets?.passphrase !== 'string' || typeof secrets?.session !== 'object' || !secrets.session) return null
    return secrets
  } catch { return null }
}

export async function loadSecrets(storeId: string): Promise<SessionSecrets | null> {
  const hit = cache.get(storeId)
  if (hit) return hit
  const raw = isTauri() ? await secretGet(entryName(storeId)) : fallbackRead(storeId)
  if (!raw) return null
  // PIN-wrapped entries carry { enc }; locked readers get null so restore
  // reports locked instead of crashing on the envelope.
  try {
    const envelope = JSON.parse(raw) as { enc?: string }
    if (typeof envelope?.enc === 'string') {
      const open = await unwrapSecret(envelope.enc)
      const secrets = open ? parseSecrets(open) : null
      if (secrets) cache.set(storeId, secrets)
      return secrets
    }
  } catch { return null }
  const secrets = parseSecrets(raw)
  if (secrets) cache.set(storeId, secrets)
  return secrets
}

export async function persistSecrets(storeId: string, secrets: SessionSecrets): Promise<void> {
  cache.set(storeId, secrets)
  let raw = JSON.stringify(secrets)
  // A set PIN wraps entries at this layer on every backend, so disabling or
  // changing the PIN only ever rewraps here.
  if (isLockEnabled()) {
    const sealed = await wrapSecret(raw)
    if (!sealed) throw new Error('Unlock the app first: secrets cannot persist while locked.')
    raw = JSON.stringify({ enc: sealed })
  }
  if (isTauri()) await secretSet(entryName(storeId), raw)
  else fallbackWrite(storeId, raw)
}

export async function dropSecrets(storeId: string): Promise<void> {
  cache.delete(storeId)
  if (isTauri()) await secretDelete(entryName(storeId))
  else fallbackRemove(storeId)
}

// Read every stored entry as plaintext (PIN change/disable prologue).
// Entries unreadable under the current key are skipped and reported.
export async function readAllSecrets(): Promise<{ found: Map<string, SessionSecrets>; skipped: string[] }> {
  const found = new Map<string, SessionSecrets>()
  const skipped: string[] = []
  const stores = isTauri() ? await listKeychainStores() : listFallbackStores()
  for (const storeId of stores) {
    const secrets = await loadSecrets(storeId)
    if (secrets) found.set(storeId, secrets)
    else skipped.push(storeId)
  }
  return { found, skipped }
}

// Write plaintexts back under the current key state (post-rotation epilogue).
// Call only after the new PIN is set (or the lock disabled); the cache is
// dropped first so persist cannot reuse a stale wrapping.
export async function writeAllSecrets(found: Map<string, SessionSecrets>): Promise<string[]> {
  const skipped: string[] = []
  for (const [storeId, secrets] of found) {
    cache.delete(storeId)
    try { await persistSecrets(storeId, secrets) }
    catch { skipped.push(storeId) }
  }
  return skipped
}

function listFallbackStores(): string[] {
  const stores: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith('fern.secrets.v1.')) stores.push(key.slice('fern.secrets.v1.'.length))
    }
  } catch { /* Storage unreadable: nothing to rewrap. */ }
  return stores
}

async function listKeychainStores(): Promise<string[]> {
  // The keychain has no listing: stored ids come from the routing records.
  try {
    const raw = localStorage.getItem('fern.sessions.v1')
    return raw ? Object.keys(JSON.parse(raw) as Record<string, unknown>) : []
  } catch { return [] }
}

// Legacy embedded records ({ session, passphrase } in fern.sessions.v1)
// split into a public routing record plus keychain-backed secrets. Entries
// without a usable session keep their record so restore reports them instead
// of silently dropping the account.
export interface SessionRecord { userId: string; homeserverUrl: string }
export function splitLegacyRecords(raw: Record<string, Record<string, unknown>>): {
  records: Record<string, SessionRecord>; secrets: [string, SessionSecrets][]
} {
  const records: Record<string, SessionRecord> = {}
  const secrets: [string, SessionSecrets][] = []
  for (const [storeId, entry] of Object.entries(raw)) {
    const session = entry?.session as Session | undefined
    const passphrase = entry?.passphrase
    if (typeof session?.userId === 'string' && typeof session?.homeserverUrl === 'string') {
      records[storeId] = { userId: session.userId, homeserverUrl: session.homeserverUrl }
      if (typeof passphrase === 'string' && passphrase) secrets.push([storeId, { session, passphrase }])
    } else if (typeof entry?.userId === 'string' && typeof entry?.homeserverUrl === 'string') {
      records[storeId] = { userId: entry.userId as string, homeserverUrl: entry.homeserverUrl as string }
    }
  }
  return { records, secrets }
}
