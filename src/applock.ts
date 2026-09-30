// Device app lock (#38): a PIN gate over the app plus real at-rest
// protection for browser fallback secrets. The PIN itself is never stored:
// PBKDF2-SHA256 derives a key-encryption key (KEK) that decrypts a check
// value, and while unlocked the in-memory KEK wraps secret entries. Locking
// drops the KEK from memory. This is a casual-access control, not disk
// forensics protection — the Tauri shell additionally keeps secrets in the
// OS keychain (see docs/NATIVE.md).
import { isTauri } from './tauri'

export interface LockRecord {
  salt: string
  iterations: number
  /** AES-GCM envelope of the constant check phrase under the PIN key. */
  check: string
  failures: number
  lockedUntil: number
}
const LOCK_KEY = 'fern.lock.v1'
const CHECK_PHRASE = 'fern-app-lock-check'
const ITERATIONS = 600_000
const MAX_BACKOFF_MS = 10 * 60_000

const subtle = () => {
  const cryptoObject = globalThis.crypto as Crypto | undefined
  const subtleCrypto = cryptoObject?.subtle
  if (!subtleCrypto) throw new Error('This device cannot do app lock: WebCrypto is unavailable.')
  return subtleCrypto
}
const bytesToBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const base64ToBytes = (raw: string) => Uint8Array.from(atob(raw), char => char.charCodeAt(0))

export function loadLockRecord(): LockRecord | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    if (!raw) return null
    const record = JSON.parse(raw) as Partial<LockRecord>
    if (typeof record.salt !== 'string' || typeof record.check !== 'string') return null
    return {
      salt: record.salt,
      check: record.check,
      iterations: typeof record.iterations === 'number' && record.iterations > 0 ? record.iterations : ITERATIONS,
      failures: typeof record.failures === 'number' && record.failures >= 0 ? record.failures : 0,
      lockedUntil: typeof record.lockedUntil === 'number' && record.lockedUntil >= 0 ? record.lockedUntil : 0,
    }
  } catch { return null }
}
function saveLockRecord(record: LockRecord) {
  try { localStorage.setItem(LOCK_KEY, JSON.stringify(record)) } catch { /* A lock that cannot persist cannot engage. */ }
}
export function clearLockRecord() {
  try { localStorage.removeItem(LOCK_KEY) } catch { /* Nothing persisted, nothing to clear. */ }
}

let kek: CryptoKey | null = null
/** In-memory key-encryption key; null while locked. Never persisted. */
export function lockKEK(): CryptoKey | null { return kek }
export function isLockEnabled(): boolean { return loadLockRecord() !== null }
export function isUnlocked(): boolean { return kek !== null }

async function deriveKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return JSON.stringify({ iv: bytesToBase64(iv.buffer), data: bytesToBase64(data) })
}
async function open(key: CryptoKey, envelope: string): Promise<string | null> {
  try {
    const { iv, data } = JSON.parse(envelope) as { iv: string; data: string }
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(data))
    return new TextDecoder().decode(plain)
  } catch { return null }
}

function validatePin(pin: string) {
  if (pin.length < 4 || pin.length > 64) throw new Error('Use a PIN of 4 to 64 characters.')
}

export async function setupPin(pin: string): Promise<void> {
  validatePin(pin)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(pin, salt, ITERATIONS)
  const record: LockRecord = { salt: bytesToBase64(salt.buffer), iterations: ITERATIONS, check: await seal(key, CHECK_PHRASE), failures: 0, lockedUntil: 0 }
  saveLockRecord(record)
  if (!localStorage.getItem(LOCK_KEY)) throw new Error('The PIN could not be saved on this device.')
  kek = key
}

export async function verifyPin(pin: string): Promise<boolean> {
  const record = loadLockRecord()
  if (!record) return true
  if (Date.now() < record.lockedUntil) {
    throw new Error(`Too many wrong attempts. Try again in ${Math.ceil((record.lockedUntil - Date.now()) / 1000)} seconds.`)
  }
  const key = await deriveKey(pin, base64ToBytes(record.salt), record.iterations)
  if ((await open(key, record.check)) !== CHECK_PHRASE) {
    const failures = record.failures + 1
    // 5 free attempts, then exponential backoff capped at ten minutes.
    const lockedUntil = failures > 5 ? Date.now() + Math.min(30_000 * 2 ** (failures - 6), MAX_BACKOFF_MS) : 0
    saveLockRecord({ ...record, failures, lockedUntil })
    return false
  }
  saveLockRecord({ ...record, failures: 0, lockedUntil: 0 })
  kek = key
  return true
}

/** Drop the in-memory key: the app is locked until the next verify. */
export function lockApp() { kek = null }

/** Disable the lock entirely (call only after verifying). */
export function disablePin() { kek = null; clearLockRecord() }

/** Wrap a secret entry while unlocked; null when locked. */
export async function wrapSecret(plaintext: string): Promise<string | null> {
  if (!kek) return null
  return seal(kek, plaintext)
}

/** Unwrap a secret entry while unlocked; null when locked or corrupt. */
export async function unwrapSecret(envelope: string): Promise<string | null> {
  if (!kek) return null
  return open(kek, envelope)
}

/** Honest capability note for settings UI. */
export function lockProtectionNote(): string {
  return isTauri()
    ? 'The PIN gates this device; secrets additionally rest in the OS keychain.'
    : 'The PIN gates this device and encrypts locally stored secrets. It does not protect against disk forensics.'
}

const PREFS_KEY = 'fern.lock.prefs'
export const LOCK_TIMEOUTS = [1, 5, 15] as const
/** Idle minutes before auto-lock; defaults to 5 on corrupt prefs. */
export function loadLockTimeout(): number {
  try {
    const minutes = (JSON.parse(localStorage.getItem(PREFS_KEY) ?? '5') as unknown) as number
    if (minutes === 0 || (LOCK_TIMEOUTS as readonly number[]).includes(minutes)) return minutes
  } catch { /* Fall through to the default. */ }
  return 5
}
/** 0 disables auto-lock; the manual lock stays available. */
export function saveLockTimeout(minutes: number) {
  if (minutes !== 0 && !(LOCK_TIMEOUTS as readonly number[]).includes(minutes)) throw new Error('Pick an auto-lock delay of 1, 5 or 15 minutes, or off.')
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(minutes)) } catch { /* A preference that cannot persist stays default. */ }
}
