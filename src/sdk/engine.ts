import type { ClientInterface, Session, SyncServiceInterface, TaskHandleInterface, RoomInterface, TimelineInterface, TimelineItemInterface, EventTimelineItem, MediaSourceInterface, SessionVerificationControllerInterface, SessionVerificationRequestDetails, RoomListEntriesWithDynamicAdaptersResultInterface, RoomDescription, ShieldState, SsoHandlerInterface, GrantQrLoginProgressListener, QrLoginProgressListener } from './generated/matrix_sdk_ffi'
import type { OAuthAuthorizationDataInterface } from './generated/matrix_sdk'
import type { Account, Room, Message, Member, DirectoryRoom, SpaceChild } from '../types'
import type { RoomNotificationMode } from './generated/matrix_sdk_ffi'
import { applyDiffs } from '../diff'
import { extractMentions, markdownToHtml, stripReplyFallback } from '../format'
import { formatGeoUri, locationTextAlternative, parseGeoUri } from '../location'
import { forwardBlockReason } from '../forward'
import { elementCallJoin, isCallJoinedEcho, parseWidgetEvent, unsupportedWidgetMessage, type WidgetInfo } from '../widgets'
import { parseKnockRequests, type KnockRequest } from '../knock'
import { cachedSecrets, dropSecrets, loadSecrets, persistSecrets, splitLegacyRecords, type SessionRecord, type SessionSecrets } from '../secrets'

type Bindings = typeof import('./index')
let bindingPromise: Promise<Bindings> | undefined
let cachedSdk: Bindings | undefined
export function loadSdk(): Promise<Bindings> {
  return bindingPromise ??= import('./index').then(async sdk => {
    cachedSdk = sdk
    await sdk.uniffiInitAsync()
    sdk.initPlatform({ logLevel: sdk.LogLevel.Warn, traceLogPacks: [], extraTargets: [], writeToStdoutOrSystem: false, writeToFiles: undefined }, true)
    return sdk
  }).catch(error => { bindingPromise = undefined; throw error })
}
export interface QrProgress { stage: 'starting' | 'connecting' | 'confirm' | 'syncing' | 'done'; verificationUri?: string; userCode?: string }
function mapQrState(tag: string, inner: { verificationUri?: string; userCode?: string }): QrProgress {
  if (tag === 'EstablishingSecureChannel') return { stage: 'connecting' }
  if (tag === 'WaitingForAuth' || tag === 'WaitingForToken') return { stage: 'confirm', verificationUri: inner.verificationUri, userCode: inner.userCode }
  if (tag === 'SyncingSecrets') return { stage: 'syncing' }
  if (tag === 'Done') return { stage: 'done' }
  return { stage: 'starting' }
}
function stateTag(state: unknown): string { return (state as { tag?: unknown }).tag as string ?? 'Starting' }
function stateInner(state: unknown): { verificationUri?: string; userCode?: string } { return (state as { inner?: { verificationUri?: string; userCode?: string } }).inner ?? {} }
export type NotifyMode = 'all' | 'mentions' | 'mute'
function modeFromSdk(sdk: Bindings, mode: RoomNotificationMode): NotifyMode {
  if (mode === sdk.RoomNotificationMode.Mute) return 'mute'
  if (mode === sdk.RoomNotificationMode.MentionsAndKeywordsOnly) return 'mentions'
  return 'all'
}
function modeToSdk(sdk: Bindings, mode: NotifyMode): RoomNotificationMode {
  return mode === 'mute' ? sdk.RoomNotificationMode.Mute
    : mode === 'mentions' ? sdk.RoomNotificationMode.MentionsAndKeywordsOnly : sdk.RoomNotificationMode.AllMessages
}
// Call-widget guard rails, kept pure for unit tests: the calling service
// must be HTTPS unless it is this same origin, and inbound widget traffic
// must match the widget origin, the iframe that started the call, and the
// call's widget ID before anything reaches the driver.
export function callServiceUrl(raw: string | undefined, origin: string): URL {
  const url = new URL(raw || 'https://call.element.io')
  if (url.protocol !== 'https:' && url.origin !== origin) {
    throw new Error('The calling service must use HTTPS.')
  }
  return url
}
export function isCallMessage(event: { origin: string; source: unknown; data?: { widgetId?: string } | null },
  widgetOrigin: string, iframeWindow: unknown, widgetId: string): boolean {
  return !!event.data && event.origin === widgetOrigin && event.source === iframeWindow
    && event.data.widgetId === widgetId
}
export function exactBytes(bytes: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(bytes.byteLength)
  exact.set(bytes)
  return exact.buffer as ArrayBuffer
}
// Actionable mapping for QR scan failures: decline/cancel/expiry read as
// user states, relay failures as connectivity, everything else verbatim.
export function qrScanError(error: unknown, role: 'grant' | 'login'): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/declin/i.test(detail)) return 'The other device declined the request. Start again if that was a mistake.'
  if (/cancell?ed|abort/i.test(detail)) return 'The QR sign-in was cancelled.'
  if (/expir|timeout|timed out/i.test(detail)) return 'The QR code expired. Ask the other device to show a fresh code and try again.'
  if (/rendezvous|relay|channel|network|fetch|connection|connect/i.test(detail)) return 'The sign-in relay could not be reached. Check the connection and try a fresh code.'
  return `${role === 'grant' ? 'Linking' : 'Signing in'} over QR failed (${detail.slice(0, 140)}).`
}
// In-memory working bundle: secrets ride the cache/keychain, never the record.
interface SavedAccount { storeId: string; passphrase: string; session?: Session }
const STORAGE_KEY = 'fern.sessions.v1'
function readSessionRecords(): Record<string, Record<string, unknown>> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('Saved sessions could not be read. Clear site data only if you have a recovery key.') }
}
// Legacy embedded records ({ session, passphrase }) split into public routing
// records plus keychain-backed secrets. Adoption rewrites the record only
// after the secrets persist, so a failed keychain write retries on the next
// launch instead of stranding the account.
let adoptingSecrets: Promise<void> | null = null
function savedAccounts(): Record<string, SessionRecord> {
  const { records, secrets } = splitLegacyRecords(readSessionRecords())
  if (secrets.length && !adoptingSecrets) adoptingSecrets = adoptLegacySecrets(secrets).finally(() => { adoptingSecrets = null })
  return records
}
async function adoptLegacySecrets(secrets: [string, SessionSecrets][]): Promise<void> {
  for (const [storeId, entry] of secrets) {
    if (cachedSecrets(storeId)) continue
    try { await persistSecrets(storeId, entry) }
    catch { continue }
    const raw = readSessionRecords()
    const record = splitLegacyRecords({ [storeId]: raw[storeId] }).records[storeId]
    if (record) localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...raw, [storeId]: record }))
  }
}
function saveRecord(id: string, record: SessionRecord) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readSessionRecords(), [id]: record }))
}
async function commitSession(storeId: string, secrets: SessionSecrets): Promise<Session> {
  await persistSecrets(storeId, secrets)
  saveRecord(storeId, { userId: secrets.session.userId, homeserverUrl: secrets.session.homeserverUrl })
  return secrets.session
}
// App.vue persists per-room drafts under this prefix; the engine owns erasing
// them because account removal must not leave another account's input behind.
const draftPrefix = (id: string) => `fern.draft.${id}/`
// Deletes the databases the SDK spreads one account across. Used by removal
// and by abandoned login attempts so failed starts leave no orphaned stores.
function dropTempStore(storeId: string): Promise<void> {
  return Promise.all([
    deleteIdbDatabase(`fern-${storeId}`),
    deleteIdbDatabase(`fern-${storeId}::matrix-sdk-crypto`),
    deleteIdbDatabase(`fern-${storeId}::matrix-sdk-state`),
  ]).then(() => {})
}
function deleteIdbDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.deleteDatabase(name)
      // Deletion completes once the SDK's connections close; resolving on
      // blocked keeps removal idempotent while callers poll for absence.
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    } catch { resolve() }
  })
}
export interface EngineEvents {
  account(account: Account): void
  rooms(accountId: string, rooms: Room[]): void
  error(accountId: string, message: string): void
}
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const value = error as { inner?: { message?: string }; message?: string }
  return value?.inner?.message ?? value?.message ?? String(error)
}
// The SDK retries internally without flipping its sync-service state, so
// server downtime is detected here: consecutive room-list poll failures flip
// the account offline, with exponential backoff bounding the retry rate.
export const OFFLINE_AFTER_FAILURES = 3
export function pollDelay(failures: number) { return Math.min(4000 * 2 ** Math.max(0, failures), 60000) }
function isAuthFailure(error: unknown) {
  return /401|403|forbidden|unauthor|unknown token|invalid token|expired|session|logged out|signed out|M_UNKNOWN_TOKEN/i.test(errorText(error))
}
// Matrix error bodies to actionable copy. Callers pass a fallback for
// empty or unparseable bodies so no failure renders blank.
function matrixError(body: any, fallback: string): string {
  const detail = body?.error ? String(body.error) : ''
  switch (body?.errcode) {
    case 'M_USER_IN_USE': return 'That username is taken on this server.'
    case 'M_INVALID_USERNAME': return 'That username is not allowed. Use lowercase letters, digits and . _ - = / +.'
    case 'M_WEAK_PASSWORD': case 'M_PASSWORD_TOO_SHORT': return 'That password is too weak. Use a longer one.'
    case 'M_THREEPID_IN_USE': return 'That email address belongs to another account.'
    case 'M_THREEPID_NOT_FOUND': return 'That email address was never verified here.'
    case 'M_FORBIDDEN': return detail && !/invalid/i.test(detail) ? `The server refused this action (${detail}).` : 'The server refused this action. Check the password, or manage this account with your login provider.'
    case 'M_UNKNOWN_TOKEN': return 'This session has expired. Sign in again.'
    case 'M_UNRECOGNIZED': return 'This server does not support that action.'
    case 'M_LIMIT_EXCEEDED': return 'Too many attempts. Wait a while and try again.'
    default: return detail || fallback
  }
}
// Never execute downloaded HTML/SVG as a document on this origin: only
// renderable media keeps its type, everything else downloads as bytes.
export function safeMediaMime(mime: string | undefined): string {
  return /^(image\/(png|jpeg|webp|gif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(mime ?? '')
    ? mime!
    : 'application/octet-stream'
}

// Maps the SDK authenticity shield to render data. Red carries an
// SDK-provided explanation; grey marks unverified senders without details.
export function shieldOf(shields: ShieldState | undefined): Message['shield'] {
  if (shields?.tag === 'Red') return { level: 'red', message: shields.inner.message }
  if (shields?.tag === 'Grey') return { level: 'grey' }
  return undefined
}
export class MatrixEngine {
  private clients = new Map<string, ClientInterface>()
  private syncs = new Map<string, SyncServiceInterface>()
  private handles = new Map<string, TaskHandleInterface[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private refreshFailures = new Map<string, number>()
  private refreshMarkedOffline = new Set<string>()
  // Rooms this client created encrypted: sends wait until the SDK confirms
  // the encryption state instead of risking a plaintext opener.
  private createdEncrypted = new Set<string>()
  private refreshes = new Set<string>()
  private timelineCache = new Map<string, TimelineInterface>()
  private eventCache = new Map<string, EventTimelineItem>()
  private media = new Map<string, MediaSourceInterface>()
  private objectUrls = new Map<string, string>()
  private roomLists = new Map<string, RoomListEntriesWithDynamicAdaptersResultInterface>()
  private verificationControllers = new Map<string, SessionVerificationControllerInterface>()
  private pendingVerifications = new Map<string, SessionVerificationRequestDetails>()
  // Guards an attach that is still awaiting SDK setup when its account is
  // removed: stale attaches must stop their own sync instead of registering it.
  private attachTokens = new Map<string, number>()
  private alive = true
  constructor(private events: EngineEvents) {}
  getClient(id: string) {
    const client = this.clients.get(id)
    if (!client) throw new Error('This account is not connected. Sign in or retry the connection.')
    return client
  }
  private getRoom(accountId: string, roomId: string) {
    const room = this.getClient(accountId).getRoom(roomId)
    if (!room) throw new Error('The room has not finished syncing.')
    return room
  }
  private clearVerification(accountId: string, controller: SessionVerificationControllerInterface) {
    const isCurrent = this.verificationControllers.get(accountId) === controller
    if (isCurrent) this.verificationControllers.delete(accountId)
    this.pendingVerifications.delete(accountId)
    if (isCurrent) controller.setDelegate(undefined)
  }
  private deferClearVerification(accountId: string, controller: SessionVerificationControllerInterface) {
    queueMicrotask(() => this.clearVerification(accountId, controller))
  }
  private async builder(data: SavedAccount, discover: boolean) {
    const sdk = await loadSdk()
    let builder = new sdk.ClientBuilder()
      .indexeddbStore(new sdk.IndexedDbStoreBuilder(`fern-${data.storeId}`).passphrase(data.passphrase))
      .backupDownloadStrategy(sdk.BackupDownloadStrategy.AfterDecryptionFailure)
      .threadsEnabled(true, false)
      .autoEnableCrossSigning(true)
      .setSessionDelegate({
        retrieveSessionFromKeychain: userId => {
          const found = Object.entries(savedAccounts()).find(([storeId, record]) => record.userId === userId && storeId === data.storeId)
          const secrets = found ? cachedSecrets(found[0]) : undefined
          if (!secrets) throw new Error('Sign in again on this device: the saved session secret is missing.')
          return sdk.Session.new(secrets.session)
        },
        saveSessionInKeychain: session => {
          data.session = session
          // Refreshes are persisted only after this login has been committed.
          if (savedAccounts()[data.storeId]) {
            // The cache primes synchronously for the delegate; a failed
            // keychain write surfaces instead of silently losing the rotation.
            persistSecrets(data.storeId, { session, passphrase: data.passphrase })
              .catch(error => { this.events.error(data.storeId, `Saving the refreshed session failed (${errorText(error)}). Sign in again if sync stops.`) })
            saveRecord(data.storeId, { userId: session.userId, homeserverUrl: session.homeserverUrl })
          }
        },
      })
    if (discover) builder = builder.slidingSyncVersionBuilder(sdk.SlidingSyncVersionBuilder.DiscoverNative)
    return builder
  }
  // Forced-native variant for homeservers whose simplified sliding-sync
  // endpoint works but whose /versions omits the advertisement flag
  // (Spindle, upstream tuna-os/spindle#507). Discovery stays the default
  // everywhere else; only explicit callers opt out of the flag check.
  private async nativeBuilder(data: SavedAccount) {
    const sdk = await loadSdk()
    const discovering = await this.builder(data, false)
    return discovering.slidingSyncVersionBuilder(sdk.SlidingSyncVersionBuilder.Native)
  }
  async login(server: string, username: string, password: string, forceNativeSync = false) {
    const sdk = await loadSdk()
    const passphrase = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const data: SavedAccount = { storeId: crypto.randomUUID(), passphrase }
    const client = await (forceNativeSync ? await this.nativeBuilder(data) : await this.builder(data, true)).serverNameOrHomeserverUrl(server).build()
    await client.login(username, password, 'Fern', undefined)
    if (client.slidingSyncVersion() !== sdk.SlidingSyncVersion.Native) {
      await client.logout()
      throw new Error('Fern currently requires a homeserver with native sliding sync.')
    }
    data.session = await commitSession(data.storeId, { session: client.session(), passphrase: data.passphrase })
    await this.attach(client, data.storeId)
    return data.storeId
  }
  // Pending OIDC flows live only in memory: starting a flow persists nothing,
  // so a cancelled or abandoned request cannot strand credentials on disk.
  // The popup-based redirect keeps the page (and its WASM state) alive, which
  // the opaque PKCE authorization data requires.
  private oidcFlows = new Map<string, { client: ClientInterface; auth: OAuthAuthorizationDataInterface; data: SavedAccount; redirectUri: string }>()
  // Begins a modern OIDC login. Returns the flow id plus the IdP URL to open
  // in a popup; the IdP redirects to redirectUri (a static callback page that
  // forwards the callback URL to this window) and the caller completes the
  // flow with finishOidcLogin. Throws before persisting anything.
  async startOidcLogin(server: string, redirectUri: string, staticRegistrations?: Map<string, string>, forceNativeSync = false): Promise<{ flowId: string; url: string }> {
    const sdk = await loadSdk()
    const passphrase = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const data: SavedAccount = { storeId: crypto.randomUUID(), passphrase }
    const client = await (forceNativeSync ? await this.nativeBuilder(data) : await this.builder(data, true)).serverNameOrHomeserverUrl(server).build()
    try {
      const auth = await client.urlForOidc(sdk.OidcConfiguration.new({
        clientName: 'Fern', redirectUri, clientUri: server,
        logoUri: undefined, tosUri: undefined, policyUri: undefined,
        staticRegistrations: staticRegistrations ?? new Map(),
      }), undefined, undefined, undefined, undefined)
      const flowId = crypto.randomUUID()
      this.oidcFlows.set(flowId, { client, auth, data, redirectUri })
      return { flowId, url: auth.loginUrl() }
    } catch (error) {
      await client.logout().catch(() => {})
      // The store created for the attempt must not linger as an orphan.
      await dropTempStore(data.storeId)
      throw error
    }
  }
  // Completes an OIDC login with the callback URL the IdP redirected to. The
  // SDK validates state and PKCE internally; the redirect target is checked
  // here so a foreign callback cannot complete (or confuse) a flow.
  async finishOidcLogin(flowId: string, callbackUrl: string): Promise<string> {
    const flow = this.oidcFlows.get(flowId)
    this.oidcFlows.delete(flowId)
    if (!flow) throw new Error('This sign-in request expired or was already completed. Start again from login.')
    if (!callbackUrl.startsWith(flow.redirectUri)) throw new Error('This sign-in response does not match the pending request.')
    try {
      await flow.client.loginWithOidcCallback(callbackUrl)
    } catch (error) { await dropTempStore(flow.data.storeId); throw error }
    flow.data.session = await commitSession(flow.data.storeId, { session: flow.client.session(), passphrase: flow.data.passphrase })
    await this.attach(flow.client, flow.data.storeId)
    return flow.data.storeId
  }
  async cancelOidcLogin(flowId: string) {
    const flow = this.oidcFlows.get(flowId)
    this.oidcFlows.delete(flowId)
    if (flow) {
      await flow.client.abortOidcAuth(flow.auth).catch(() => {})
      await dropTempStore(flow.data.storeId)
    }
  }
  // QR login/link scanning (MSC4108). The display role is unimplemented:
  // this FFI exposes QrCodeData.fromBytes but no byte/URI accessor, so Fern
  // can only scan codes shown by the other device, never show its own.
  // Both roles share the stage machine; only the handler and the final
  // session commit differ.
  // Existing device scans a new device's code and authorizes it. Resolves
  // once the new device is granted; the grant-side client keeps its session.
  async grantQrLogin(accountId: string, bytes: Uint8Array, onProgress: (state: QrProgress) => void, signal?: AbortSignal) {
    const sdk = await loadSdk()
    const qr = sdk.QrCodeData.fromBytes(exactBytes(bytes))
    const handler = this.getClient(accountId).newGrantLoginWithQrCodeHandler()
    const listener: GrantQrLoginProgressListener = { onUpdate: state => onProgress(mapQrState(stateTag(state), stateInner(state))) }
    try {
      await handler.scan(qr, listener, signal ? { signal } : undefined)
    } catch (error) {
      throw new Error(qrScanError(error, 'grant'))
    }
  }
  // Fresh device scans an existing device's code and signs in. The server
  // defaults to the code's homeserver hint when the code carries one.
  async loginQrLogin(server: string, bytes: Uint8Array, redirectUri: string, onProgress: (state: QrProgress) => void, signal?: AbortSignal): Promise<string> {
    const sdk = await loadSdk()
    const passphrase = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const data: SavedAccount = { storeId: crypto.randomUUID(), passphrase }
    const client = await (await this.builder(data, true)).serverNameOrHomeserverUrl(server).build()
    try {
      const qr = sdk.QrCodeData.fromBytes(exactBytes(bytes))
      const handler = client.newLoginWithQrCodeHandler(sdk.OidcConfiguration.new({
        clientName: 'Fern', redirectUri, clientUri: server,
        logoUri: undefined, tosUri: undefined, policyUri: undefined, staticRegistrations: new Map(),
      }))
      const listener: QrLoginProgressListener = { onUpdate: state => onProgress(mapQrState(stateTag(state), stateInner(state))) }
      await handler.scan(qr, listener, signal ? { signal } : undefined)
    } catch (error) {
      await client.logout().catch(() => {})
      await dropTempStore(data.storeId)
      throw new Error(qrScanError(error, 'login'))
    }
    data.session = await commitSession(data.storeId, { session: client.session(), passphrase: data.passphrase })
    await this.attach(client, data.storeId)
    return data.storeId
  }
  // Legacy SSO fallback for homeservers without modern OIDC (e.g. Synapse
  // with an OIDC provider configured). Same popup contract as OIDC; the
  // handler completes the wrapped client, which is then attached normally.
  private ssoFlows = new Map<string, { client: ClientInterface; handler: SsoHandlerInterface; data: SavedAccount; redirectUri: string }>()
  async startSsoLogin(server: string, redirectUri: string): Promise<{ flowId: string; url: string }> {
    await loadSdk()
    const passphrase = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const data: SavedAccount = { storeId: crypto.randomUUID(), passphrase }
    const client = await (await this.builder(data, true)).serverNameOrHomeserverUrl(server).build()
    try {
      const handler = await client.startSsoLogin(redirectUri, undefined)
      const flowId = crypto.randomUUID()
      this.ssoFlows.set(flowId, { client, handler, data, redirectUri })
      return { flowId, url: handler.url() }
    } catch (error) {
      await client.logout().catch(() => {})
      await dropTempStore(data.storeId)
      throw error
    }
  }
  async finishSsoLogin(flowId: string, callbackUrl: string): Promise<string> {
    const flow = this.ssoFlows.get(flowId)
    this.ssoFlows.delete(flowId)
    if (!flow) throw new Error('This sign-in request expired or was already completed. Start again from login.')
    if (!callbackUrl.startsWith(flow.redirectUri)) throw new Error('This sign-in response does not match the pending request.')
    try {
      await flow.handler.finish(callbackUrl)
    } catch (error) { await dropTempStore(flow.data.storeId); throw error }
    flow.data.session = await commitSession(flow.data.storeId, { session: flow.client.session(), passphrase: flow.data.passphrase })
    await this.attach(flow.client, flow.data.storeId)
    return flow.data.storeId
  }
  async cancelSsoLogin(flowId: string) {
    // No abort API exists for legacy SSO; dropping the pending flow is safe
    // because nothing was persisted.
    const flow = this.ssoFlows.get(flowId)
    this.ssoFlows.delete(flowId)
    if (flow) await dropTempStore(flow.data.storeId)
  }
  // Discovers which login flows a homeserver offers, without creating a
  // session or touching disk (in-memory store). Drives the login UI: SSO is
  // offered only when the server supports it.
  async loginMethods(server: string): Promise<{ password: boolean; sso: boolean; oidc: boolean }> {
    const sdk = await loadSdk()
    const client = await (await new sdk.ClientBuilder().inMemoryStore()).serverNameOrHomeserverUrl(server).build()
    const details = await client.homeserverLoginDetails()
    return { password: details.supportsPasswordLogin(), sso: details.supportsSsoLogin(), oidc: details.supportsOidcLogin() }
  }
  /** Re-prime the secrets cache (post-unlock): reads decrypt with the live key. */
  async warmSecrets(): Promise<void> {
    await Promise.allSettled(Object.keys(savedAccounts()).map(id => loadSecrets(id)))
  }
  async restoreAll() {
    const entries = Object.entries(savedAccounts())
    await Promise.allSettled(entries.map(async ([id, record]) => {
      const account: Account = { id, userId: record.userId, name: record.userId.split(':')[0].slice(1), color: '#477962', connection: 'connecting' }
      this.events.account(account)
      try {
        const secrets = cachedSecrets(id) ?? await loadSecrets(id)
        if (!secrets) throw new Error('The saved session secret is missing on this device. Sign in again.')
        const sdk = await loadSdk()
        const client = await (await this.builder({ storeId: id, passphrase: secrets.passphrase }, false)).homeserverUrl(record.homeserverUrl).build()
        await client.restoreSession(sdk.Session.new(secrets.session))
        await this.attach(client, id)
      } catch (error) { this.events.account({ ...account, connection: 'error', error: errorText(error) }); this.events.error(id, errorText(error)) }
    }))
  }
  private async checkSessionAlive(id: string, account: Account, syncState: number) {
    const record = savedAccounts()[id]
    const session = record ? (cachedSecrets(id) ?? await loadSecrets(id))?.session : undefined
    if (session?.accessToken && record?.homeserverUrl) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch(`${record.homeserverUrl.replace(/\/*$/, '')}/_matrix/client/v3/account/whoami`,
          { headers: { Authorization: `Bearer ${session.accessToken}` }, signal: controller.signal })
        // 401 alone decides: unknown endpoints must never read as expired.
        if (response.status === 401) {
          this.events.account({ ...account, connection: 'error', error: 'Session expired. Sign in again.' })
          this.events.error(id, 'Session expired. Sign in again.')
          return
        }
      } catch { /* Unreachable homeserver: plain offline below. */ }
      finally { clearTimeout(timeout) }
    }
    this.events.account({ ...account, connection: syncState === 3 ? 'error' : 'offline',
      ...(syncState === 3 ? { error: 'Sync error. Retrying automatically.' } : {}) })
    void this.refreshRooms(id)
  }
  private async attach(client: ClientInterface, id: string) {
    const token = (this.attachTokens.get(id) ?? 0) + 1
    this.attachTokens.set(id, token)
    const current = () => this.alive && this.attachTokens.get(id) === token && savedAccounts()[id] !== undefined
    this.clients.set(id, client)
    const account: Account = { id, userId: client.userId(), name: client.userId().split(':')[0].slice(1), color: '#477962', connection: 'connecting' }
    this.events.account(account)
    const sdk = await loadSdk()
    // Restored sessions must re-check capability: a homeserver that lost
    // native sliding sync after login gets a clear error, not a dead sync.
    if (client.slidingSyncVersion() !== sdk.SlidingSyncVersion.Native) {
      const unsupported = 'This homeserver does not offer native sliding sync, which Fern requires.'
      this.events.account({ ...account, connection: 'error', error: unsupported })
      this.events.error(id, unsupported)
      return
    }
    const sync = await client.syncService().withOfflineMode().finish()
    this.syncs.set(id, sync)
    const handles: TaskHandleInterface[] = []
    this.handles.set(id, handles)
    handles.push(sync.state({ onUpdate: state => {
      if (!current()) return
      if (state === 1) {
        this.events.account({ ...account, connection: 'online' })
        void this.refreshRooms(id)
        return
      }
      if (state === 3 || state === 4) {
        // A stalled sync cannot tell a dead token from a dead network, and
        // the auth delegate does not always fire first: one whoami decides
        // the copy so expired sessions never read as plain offline.
        void this.checkSessionAlive(id, account, state)
        return
      }
      this.events.account({ ...account, connection: 'connecting' })
    } }))
    const delegate = client.setDelegate({ didReceiveAuthError: () => this.events.account({ ...account, connection: 'error', error: 'Session expired. Sign in again.' }) })
    if (delegate) handles.push(delegate)
    const allRooms = await sync.roomListService().allRooms()
    let setup = false
    const setupEntries = () => {
      if (setup || !this.alive) return
      setup = true
      const entries = allRooms.entriesWithDynamicAdapters(200, { onUpdate: () => void this.refreshRooms(id) })
      this.roomLists.set(id, entries)
      handles.push(entries.entriesStream())
      const controller = entries.controller()
      controller.setFilter(new sdk.RoomListEntriesDynamicFilterKind.NonLeft())
      controller.addOnePage()
    }
    const loading = allRooms.loadingState({ onUpdate: state => { if (state.tag === 'Loaded') setupEntries() } })
    handles.push(loading.stateStream)
    if (loading.state.tag === 'Loaded') setupEntries()
    await sync.start()
    // The account may have been removed while sync was starting: stop our own
    // sync and leave the shared maps to the remover instead of resurrecting it.
    if (!current()) { await sync.stop().catch(() => {}); return }
    // Room-list poll with exponential backoff while failing, so a dead server
    // does not spin hot and recovery is picked up within a bounded delay.
    const poll = () => {
      if (!this.alive || !this.clients.has(id)) return
      // Reachability first (it owns the offline detector), then the local
      // room-list refresh; neither step rejects.
      void this.pingServer(id).then(() => this.refreshRooms(id)).finally(() => {
        if (!this.alive || !this.clients.has(id)) return
        this.timers.set(id, setTimeout(poll, pollDelay(this.refreshFailures.get(id) ?? 0)))
      })
    }
    this.timers.set(id, setTimeout(poll, 4000))
    try { account.name = await client.displayName() } catch { /* MXID fallback */ }
    this.events.account({ ...account, connection: 'online' })
    await this.refreshRooms(id)
  }
  async refreshRooms(accountId: string) {
    if (!this.alive || this.refreshes.has(accountId)) return
    this.refreshes.add(accountId)
    try {
      const sdk = await loadSdk()
      const client = this.getClient(accountId)
      const rooms: Room[] = []
      // Bound parallel I/O for large account histories.
      const sdkRooms = client.rooms()
      for (let offset = 0; offset < sdkRooms.length; offset += 20) {
        const batch = await Promise.allSettled(sdkRooms.slice(offset, offset + 20).map(async room => {
          const [info, latest, parents] = await Promise.all([room.roomInfo(), room.latestEvent(), client.spaceService().joinedParentsOfChild(room.id()).catch(() => [])])
          const preview = latest ? this.parseEvent(accountId, room.id(), latest) : undefined
          return { id: info.id, accountId, name: info.displayName ?? info.id, topic: info.topic ?? '', direct: info.isDirect, space: info.isSpace, encrypted: info.encryptionState === sdk.EncryptionState.Encrypted, favorite: info.isFavourite, unread: Number(info.numUnreadNotifications), mentions: Number(info.numUnreadMentions), members: Number(info.activeMembersCount), preview: preview?.body ?? '', timestamp: preview?.timestamp ?? 0, parents: parents.map(parent => parent.roomId), membership: info.membership === sdk.Membership.Invited ? 'invited' : info.membership === sdk.Membership.Left ? 'left' : 'joined', successor: info.successorRoom?.roomId } satisfies Room
        }))
        for (const value of batch) if (value.status === 'fulfilled') rooms.push(value.value)
      }
      if (this.alive && this.clients.has(accountId)) this.events.rooms(accountId, rooms)
    } catch (error) { this.events.error(accountId, errorText(error)) }
    finally { this.refreshes.delete(accountId) }
  }
  private noteRefreshSuccess(accountId: string) {
    this.refreshFailures.set(accountId, 0)
    if (this.refreshMarkedOffline.delete(accountId)) {
      const userId = this.clients.get(accountId)?.userId()
      if (userId) this.events.account({ id: accountId, userId, name: userId.split(':')[0].slice(1), color: '#477962', connection: 'online' })
    }
  }
  private noteRefreshFailure(accountId: string, error: unknown) {
    const failures = (this.refreshFailures.get(accountId) ?? 0) + 1
    this.refreshFailures.set(accountId, failures)
    if (isAuthFailure(error)) {
      // Expiry has its own status path via the auth delegate; report once and
      // never let it flip a signed-out account to a plain offline state.
      if (failures === 1) this.events.error(accountId, errorText(error))
      return
    }
    if (failures >= OFFLINE_AFTER_FAILURES) this.markOffline(accountId)
  }
  private markOffline(accountId: string) {
    if (this.refreshMarkedOffline.has(accountId)) return
    this.refreshMarkedOffline.add(accountId)
    const userId = this.clients.get(accountId)?.userId()
    const message = 'Connection lost. Retrying automatically — use Retry connection to probe now.'
    if (userId) this.events.account({ id: accountId, userId, name: userId.split(':')[0].slice(1), color: '#477962', connection: 'offline', error: message })
    this.events.error(accountId, 'Connection lost. Retrying automatically.')
  }
  // Lightweight reachability probe against the public versions endpoint. The
  // room list reads the local store, so only this request actually notices a
  // dead server; failures feed the offline detector above.
  private async pingServer(accountId: string) {
    const client = this.clients.get(accountId)
    if (!client || !this.alive) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const base = client.homeserver().replace(/\/*$/, '')
      const response = await fetch(`${base}/_matrix/client/versions`, { signal: controller.signal })
      if (!response.ok) throw new Error(`The server answered ${response.status}.`)
      this.noteRefreshSuccess(accountId)
    } catch (error) { this.noteRefreshFailure(accountId, error) }
    finally { clearTimeout(timeout) }
  }
  // Manual re-probe for an offline or errored account: resets the backoff and
  // checks reachability immediately instead of waiting for the next tick.
  async retryConnection(accountId: string) {
    const userId = this.getClient(accountId).userId()
    this.refreshFailures.set(accountId, 0)
    this.refreshMarkedOffline.delete(accountId)
    this.events.account({ id: accountId, userId, name: userId.split(':')[0].slice(1), color: '#477962', connection: 'connecting' })
    await this.pingServer(accountId)
    if ((this.refreshFailures.get(accountId) ?? 0) === 0) {
      await this.refreshRooms(accountId)
      this.events.account({ id: accountId, userId, name: userId.split(':')[0].slice(1), color: '#477962', connection: 'online' })
    } else this.markOffline(accountId)
  }
  private parseEvent(accountId: string, roomId: string, event: EventTimelineItem): Message {
    const identity = event.eventOrTransactionId
    const id = identity.tag === 'EventId' ? identity.inner.eventId : identity.inner.transactionId
    const cacheKey = `${accountId}/${roomId}/${id}`
    this.eventCache.set(cacheKey, event)
    const profile = event.senderProfile
    const result: Message = { id, sender: event.sender, name: profile.tag === 'Ready' ? profile.inner.displayName ?? event.sender : event.sender, body: '', timestamp: Number(event.timestamp), own: event.isOwn, kind: 'notice', reactions: [], read: event.readReceipts.size }
    if (event.localSendState?.tag === 'NotSentYet') result.status = 'sending'
    if (event.localSendState?.tag === 'SendingFailed') result.status = 'failed'
    result.shield = shieldOf(event.lazyProvider.getShields(true))
    if (event.content.tag !== 'MsgLike') { result.body = event.content.tag.replace(/([A-Z])/g, ' $1').trim(); return result }
    const content = event.content.inner.content
    result.reactions = content.reactions.map(reaction => ({ key: reaction.key, count: reaction.senders.length, own: reaction.senders.some(sender => sender.senderId === this.getClient(accountId).userId()) }))
    result.replyId = content.inReplyTo?.eventId()
    result.threadRoot = content.threadRoot ?? undefined
    const summary = content.threadSummary
    result.threadReplies = summary ? Number(summary.numReplies()) : undefined
    const kind = content.kind
    if (kind.tag === 'Message') {
      const message = kind.inner.content
      result.body = stripReplyFallback(message.body)
      result.edited = message.isEdited
      result.kind = 'text'
      const type = message.msgType
      if (type.tag === 'Location') {
        // One-time shares render from coordinates with a text alternative;
        // anything unparseable stays plain text so no variant renders empty.
        const content = type.inner.content as { body: string; geoUri: string; description?: string; zoomLevel?: number }
        const coords = parseGeoUri(content.geoUri)
        const description = content.description?.trim() || undefined
        if (coords) {
          result.kind = 'location'
          result.body = locationTextAlternative({ ...coords, description })
          result.location = { ...coords, description, ...(content.zoomLevel !== undefined ? { zoom: content.zoomLevel } : {}) }
        } else {
          result.kind = 'text'
          result.body = content.body || 'Location shared in an unsupported format.'
        }
      } else if (type.tag === 'Emote') {
        result.kind = 'emote'
      } else if (type.tag === 'Image' || type.tag === 'File' || type.tag === 'Audio' || type.tag === 'Video') {
        const media = type.inner.content
        result.kind = type.tag.toLowerCase() as Message['kind']
        result.attachment = { name: media.filename, size: Number(media.info?.size ?? 0), mime: media.info?.mimetype ?? 'application/octet-stream', url: this.objectUrls.get(cacheKey) }
        if (type.tag === 'Audio') {
          // Voice and audio details ride the MSC1767 audio block beside the
          // plain attachment info; normalize the 0..1024 waveform to 0..1.
          const details = (media as { audio?: { duration?: number; waveform?: number[] }; voice?: unknown }).audio
          const infoDuration = (media.info as { duration?: number } | undefined)?.duration
          const duration = Number(infoDuration ?? details?.duration ?? NaN)
          if (Number.isFinite(duration)) result.attachment.duration = duration
          if (details?.waveform?.length) result.attachment.waveform = details.waveform.map(value => Math.round((Math.min(1024, Math.max(0, value)) / 1024) * 1000) / 1000)
          if ((media as { voice?: unknown }).voice) result.attachment.voice = true
        }
        this.media.set(cacheKey, media.source)
      }
    } else if (kind.tag === 'Poll') {
      result.kind = 'poll'
      result.body = kind.inner.question
      // SDK poll results map answer IDs to voter IDs, rather than users to answers.
      const userId = this.getClient(accountId).userId()
      // PollKind is a numeric enum at runtime; match the loaded SDK value
      // when available so a raw ordinal never silently mislabels the kind.
      const undisclosed = cachedSdk ? kind.inner.kind === cachedSdk.PollKind.Undisclosed : (kind.inner.kind as unknown) === 1
      result.poll = {
        question: kind.inner.question,
        answers: kind.inner.answers.map(answer => ({ id: answer.id, text: answer.text, count: kind.inner.votes.get(answer.id)?.length ?? 0 })),
        voted: [...kind.inner.votes].find(([, voters]) => voters.includes(userId))?.[0],
        kind: undisclosed ? 'undisclosed' : 'disclosed',
        ended: kind.inner.endTime !== undefined && kind.inner.endTime !== null,
        edited: kind.inner.hasBeenEdited === true,
      }
    } else if (kind.tag === 'Redacted') result.body = 'Message removed'
    else if (kind.tag === 'UnableToDecrypt') result.body = 'Unable to decrypt this message. Restore your recovery key in Security settings.'
    else result.body = kind.tag
    return result
  }
  async watchRoom(accountId: string, roomId: string, onMessages: (messages: Message[]) => void, onTyping: (users: string[]) => void): Promise<() => void> {
    const key = `${accountId}/${roomId}`
    const room = this.getRoom(accountId, roomId)
    await this.syncs.get(accountId)?.roomListService().subscribeToRooms([roomId])
    const timeline = await room.timeline()
    this.timelineCache.set(key, timeline)
    let items: TimelineItemInterface[] = []
    const handle = await timeline.addListener({ onUpdate: updates => {
      items = applyDiffs(items, updates)
      const messages: Message[] = []
      for (const item of items) { const event = item.asEvent(); if (event) messages.push(this.parseEvent(accountId, roomId, event)) }
      onMessages(messages)
    } })
    const typing = room.subscribeToTypingNotifications({ call: users => onTyping(users.filter(user => user !== room.ownUserId())) })
    // Drop this watch's timeline object so rapid room switches cannot
    // accumulate native timelines. The identity check keeps a stale stop from
    // evicting a newer watch's timeline; send/paginate recreate lazily.
    return () => {
      handle.cancel(); typing.cancel()
      if (this.timelineCache.get(key) === timeline) this.timelineCache.delete(key)
    }
  }
  private async timeline(accountId: string, roomId: string) {
    const key = `${accountId}/${roomId}`
    const cached = this.timelineCache.get(key)
    if (cached) return cached
    const timeline = await this.getRoom(accountId, roomId).timeline()
    this.timelineCache.set(key, timeline)
    return timeline
  }
  private async messageContent(timeline: TimelineInterface, body: string, emote = false) {
    const sdk = await loadSdk()
    const formatted = markdownToHtml(body)
    const mentions = extractMentions(body)
    const payload = { body, formatted: formatted ? sdk.FormattedBody.new({ format: new sdk.MessageFormat.Html(), body: formatted }) : undefined }
    const text = emote ? new sdk.MessageType.Emote({ content: payload }) : new sdk.MessageType.Text({ content: payload })
    let content = timeline.createMessageContent(text)
    if (!content) throw new Error('The message could not be created.')
    if (mentions.userIds.length || mentions.room) content = content.withMentions(sdk.Mentions.new({ userIds: mentions.userIds, room: mentions.room }))
    return content
  }
  async send(accountId: string, roomId: string, body: string, replyId?: string, editId?: string) {
    await this.ensureEncryptionReady(accountId, roomId)
    const timeline = await this.timeline(accountId, roomId)
    const content = await this.messageContent(timeline, body)
    if (editId) await timeline.edit(this.eventCache.get(`${accountId}/${roomId}/${editId}`)!.eventOrTransactionId, new (await loadSdk()).EditedContent.RoomMessage({ content }))
    else if (replyId) await timeline.sendReply(content, replyId)
    else await timeline.send(content)
  }
  async sendEmote(accountId: string, roomId: string, body: string) {
    await this.ensureEncryptionReady(accountId, roomId)
    const timeline = await this.timeline(accountId, roomId)
    await timeline.send(await this.messageContent(timeline, body, true))
  }
  async setRoomName(accountId: string, roomId: string, name: string) {
    if (!name.trim()) throw new Error('Usage: /name <room name>')
    await this.sendRoomState(accountId, roomId, 'm.room.name', { name: name.trim() }, 'Renaming the room failed.')
    await this.refreshRooms(accountId)
  }
  async setRoomTopic(accountId: string, roomId: string, topic: string) {
    await this.sendRoomState(accountId, roomId, 'm.room.topic', { topic }, 'Saving the room topic failed.')
    await this.refreshRooms(accountId)
  }
  private threadTimelines = new Map<string, TimelineInterface>()
  async threadTimeline(accountId: string, roomId: string, rootId: string) {
    const key = `${accountId}/${roomId}/${rootId}`
    const cached = this.threadTimelines.get(key)
    if (cached) return cached
    const sdk = await loadSdk()
    const timeline = await this.getRoom(accountId, roomId).timelineWithConfiguration({
      focus: new sdk.TimelineFocus.Thread({ rootEventId: rootId }),
      filter: new sdk.TimelineFilter.All(), internalIdPrefix: undefined,
      dateDividerMode: sdk.DateDividerMode.Daily, trackReadReceipts: true, reportUtds: false,
    })
    this.threadTimelines.set(key, timeline)
    return timeline
  }
  // Focused context around one event for jump-to-message (search results,
  // pins, gallery, permalinks). Focusing a missing or redacted event throws
  // actionably instead of rendering an empty view.
  async focusEvent(accountId: string, roomId: string, eventId: string, onMessages: (messages: Message[]) => void): Promise<() => void> {
    const sdk = await loadSdk()
    const timeline = await this.getRoom(accountId, roomId).timelineWithConfiguration({
      focus: new sdk.TimelineFocus.Event({ eventId, numContextEvents: 20, hideThreadedEvents: false }),
      filter: new sdk.TimelineFilter.OnlyMessage({ types: [sdk.RoomMessageEventMessageType.Audio, sdk.RoomMessageEventMessageType.Emote, sdk.RoomMessageEventMessageType.File, sdk.RoomMessageEventMessageType.Image, sdk.RoomMessageEventMessageType.Location, sdk.RoomMessageEventMessageType.Notice, sdk.RoomMessageEventMessageType.Text, sdk.RoomMessageEventMessageType.Video, sdk.RoomMessageEventMessageType.Other] }), internalIdPrefix: undefined,
      dateDividerMode: sdk.DateDividerMode.Daily, trackReadReceipts: false, reportUtds: false,
    })
    let items: TimelineItemInterface[] = []
    const handle = await timeline.addListener({ onUpdate: updates => {
      items = applyDiffs(items, updates)
      const messages: Message[] = []
      for (const item of items) { const event = item.asEvent(); if (event) messages.push(this.parseEvent(accountId, roomId, event)) }
      onMessages(messages)
    } })
    return () => handle.cancel()
  }
  // Best-effort preview of one pinned event: the focused message when the
  // event resolves, undefined when it was redacted, deleted or never synced.
  // Focused timelines are never cached, so every preview cleans up after
  // itself even on the failure paths.
  async pinPreview(accountId: string, roomId: string, eventId: string): Promise<Message | undefined> {
    let stop: (() => void) | undefined
    try {
      return await new Promise<Message | undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), 15_000)
        void this.focusEvent(accountId, roomId, eventId, messages => {
          // Focused context can open on an empty batch; only the first batch
          // carrying timeline items decides the preview.
          if (!messages.length) return
          clearTimeout(timer)
          resolve(messages.find(message => message.id === eventId))
        }).then(value => { stop = value }).catch(() => { clearTimeout(timer); resolve(undefined) })
      })
    } finally { stop?.() }
  }
  // Pinned ids plus whether this account may pin or unpin (power-level
  // aware, so the UI can disable the control with a reason instead of
  // attempting a forbidden state event).
  async pinState(accountId: string, roomId: string): Promise<{ ids: string[]; canPin: boolean }> {
    const info = await this.getRoom(accountId, roomId).roomInfo()
    return { ids: [...info.pinnedEventIds], canPin: info.powerLevels?.canOwnUserPinUnpin() ?? false }
  }
  // Pin state echoes through sync, so both mutators settle: they resolve only
  // once room info reflects the change (bounded), keeping pins UI and tests
  // deterministic instead of racing the state sync.
  async pin(accountId: string, roomId: string, eventId: string) { return this.settlePin(accountId, roomId, eventId, true) }
  async unpin(accountId: string, roomId: string, eventId: string) { return this.settlePin(accountId, roomId, eventId, false) }
  private async settlePin(accountId: string, roomId: string, eventId: string, present: boolean): Promise<boolean> {
    let changed: boolean
    try {
      changed = present
        ? await (await this.timeline(accountId, roomId)).pinEvent(eventId)
        : await (await this.timeline(accountId, roomId)).unpinEvent(eventId)
    } catch (error) {
      // Forbidden pin mutators fail actionably as false (no power), not as a
      // throw, so permission-aware UI can disable the control up front. The
      // FFI error carries the Matrix errcode in its inner payload.
      const inner = (error as { tag?: string; inner?: { kind?: { tag?: string }; code?: string } })
      if (inner?.tag === 'MatrixApi' && (inner.inner?.code === 'M_FORBIDDEN' || inner.inner?.kind?.tag === 'Forbidden')) return false
      throw error
    }
    if (!changed) return false
    const deadline = Date.now() + 15_000
    for (;;) {
      const { ids } = await this.pinState(accountId, roomId)
      if (ids.includes(eventId) === present) return true
      if (Date.now() >= deadline) throw new Error('The pinned messages did not update yet. Try again in a moment.')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  async watchThread(accountId: string, roomId: string, rootId: string, onMessages: (messages: Message[]) => void): Promise<() => void> {
    const timeline = await this.threadTimeline(accountId, roomId, rootId)
    let items: TimelineItemInterface[] = []
    const handle = await timeline.addListener({ onUpdate: updates => {
      items = applyDiffs(items, updates)
      const messages: Message[] = []
      for (const item of items) { const event = item.asEvent(); if (event) messages.push(this.parseEvent(accountId, roomId, event)) }
      onMessages(messages)
    } })
    return () => handle.cancel()
  }
  async paginateThread(accountId: string, roomId: string, rootId: string) { return (await this.threadTimeline(accountId, roomId, rootId)).paginateBackwards(40) }
  async sendThreadReply(accountId: string, roomId: string, rootId: string, body: string, replyId?: string) {
    const timeline = await this.threadTimeline(accountId, roomId, rootId)
    const content = await this.messageContent(timeline, body)
    if (replyId) await timeline.sendReply(content, replyId)
    else await timeline.send(content)
  }
  async markThreadRead(accountId: string, roomId: string, rootId: string, eventId: string) {
    const sdk = await loadSdk()
    await (await this.threadTimeline(accountId, roomId, rootId)).sendReadReceipt(sdk.ReceiptType.Read, eventId)
  }
  // Rotate the account backup key after explicit confirmation. The previous
  // recovery key stops working; devices holding history keys keep them, but
  // history encrypted only under the old backup needs the old key.
  async resetRecovery(accountId: string): Promise<string> {
    return this.getClient(accountId).encryption().resetRecoveryKey()
  }
  private sendHandle(accountId: string, roomId: string, messageId: string) {
    return this.eventCache.get(`${accountId}/${roomId}/${messageId}`)?.lazyProvider.getSendHandle()
  }
  // Retry a failed local echo through the SDK send queue, which keeps the
  // original transaction id so the retry cannot duplicate the message.
  async retrySend(accountId: string, roomId: string, messageId: string) {
    const handle = this.sendHandle(accountId, roomId, messageId)
    if (!handle) throw new Error('This message can no longer be retried. Copy its text and send it again.')
    await handle.tryResend()
  }
  // Abort a queued local echo that has not been sent yet. Returns false when
  // the event already left the queue, in which case redaction is the recourse.
  async discardSend(accountId: string, roomId: string, messageId: string): Promise<boolean> {
    const handle = this.sendHandle(accountId, roomId, messageId)
    if (!handle) throw new Error('This message can no longer be discarded.')
    return handle.abort()
  }
  async react(accountId: string, roomId: string, eventId: string, key: string) {
    const event = this.eventCache.get(`${accountId}/${roomId}/${eventId}`)
    if (!event) throw new Error('This message is no longer in the timeline.')
    await (await this.timeline(accountId, roomId)).toggleReaction(event.eventOrTransactionId, key)
  }
  async remove(accountId: string, roomId: string, eventId: string) {
    const event = this.eventCache.get(`${accountId}/${roomId}/${eventId}`)
    if (!event) throw new Error('This message is no longer in the timeline.')
    await (await this.timeline(accountId, roomId)).redactEvent(event.eventOrTransactionId, undefined)
  }
  // Forces megolm session rotation for key hygiene: the next sent message
  // uses and shares a fresh session, so superseded sessions are obtainable
  // afterwards only by explicit key request.
  async discardRoomKey(accountId: string, roomId: string) { await this.getRoom(accountId, roomId).discardRoomKey() }
  // Rooms created encrypted must never emit a plaintext opener while the
  // SDK's encryption state is still syncing: wait for confirmation, bounded,
  // then fail actionably instead of leaking. Rooms with any other origin are
  // untouched, so legitimately unencrypted rooms keep working.
  private async ensureEncryptionReady(accountId: string, roomId: string) {
    if (!this.createdEncrypted.has(`${accountId}/${roomId}`)) return
    const sdk = await loadSdk()
    const deadline = Date.now() + 30_000
    for (;;) {
      const info = await this.getRoom(accountId, roomId).roomInfo()
      if (info.encryptionState === sdk.EncryptionState.Encrypted) return
      if (Date.now() >= deadline) throw new Error('Room encryption is not ready yet. Wait a moment and retry the send.')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  async upload(accountId: string, roomId: string, file: File): Promise<{ done: Promise<void>; cancel: () => void }> {
    const sdk = await loadSdk()
    const timeline = await this.timeline(accountId, roomId)
    const params = { source: new sdk.UploadSource.Data({ bytes: await file.arrayBuffer(), filename: file.name }), caption: undefined, formattedCaption: undefined, mentions: undefined, inReplyTo: undefined }
    // Images and files share the file API: the dedicated sendImage rejects
    // every call in this SDK build (InvalidAttachmentData across five live
    // variants), and FileInfo thumbnails only support plaintext URLs, which
    // would leak image content in encrypted rooms. Metadata stays correct.
    const handle = timeline.sendFile(params, { mimetype: file.type || 'application/octet-stream', size: BigInt(file.size), thumbnailInfo: undefined, thumbnailSource: undefined })
    return { done: handle.join(), cancel: () => handle.cancel() }
  }
  // Voice clips ride the dedicated SDK voice API so the event carries the
  // MSC1767 audio block (duration, waveform preview) and the MSC3245 voice
  // flag, with media encrypted exactly like any other attachment.
  async sendVoice(accountId: string, roomId: string, clip: { bytes: ArrayBuffer; filename: string; mime: string; durationMs: number; waveform: number[] }): Promise<{ done: Promise<void>; cancel: () => void }> {
    const sdk = await loadSdk()
    await this.ensureEncryptionReady(accountId, roomId)
    const timeline = await this.timeline(accountId, roomId)
    const params = { source: new sdk.UploadSource.Data({ bytes: clip.bytes, filename: clip.filename }), caption: undefined, formattedCaption: undefined, mentions: undefined, inReplyTo: undefined }
    const handle = timeline.sendVoiceMessage(params,
      { duration: Math.max(0, Math.round(clip.durationMs)), size: BigInt(clip.bytes.byteLength), mimetype: clip.mime || 'application/octet-stream' },
      clip.waveform.map(value => Math.min(1, Math.max(0, value))))
    return { done: handle.join(), cancel: () => handle.cancel() }
  }
  // Forwarding re-sends content as the forwarder into an explicitly chosen
  // room: plaintext is decrypted from the source room and re-encrypted for
  // the target, so ciphertext never moves between rooms and every forward is
  // a deliberate new send. Refuses anything the classifier rejects.
  async forwardMessage(sourceAccountId: string, sourceRoomId: string, message: Message, targetAccountId: string, targetRoomId: string): Promise<void> {
    const blocked = forwardBlockReason(message)
    if (blocked) throw new Error(blocked)
    if (message.kind === 'location' && message.location) {
      await this.sendLocation(targetAccountId, targetRoomId, { ...message.location })
      return
    }
    if (message.kind === 'text') {
      await this.send(targetAccountId, targetRoomId, message.body)
      return
    }
    if (message.kind === 'emote') {
      await this.sendEmote(targetAccountId, targetRoomId, message.body)
      return
    }
    const attachment = message.attachment!
    const url = await this.download(sourceAccountId, sourceRoomId, message)
    const bytes = await (await fetch(url)).arrayBuffer()
    if (message.kind === 'audio') {
      await this.sendVoice(targetAccountId, targetRoomId, { bytes, filename: attachment.name,
        mime: attachment.mime, durationMs: attachment.duration ?? 0, waveform: attachment.waveform ?? [] })
      return
    }
    const operation = await this.upload(targetAccountId, targetRoomId, new File([bytes], attachment.name, { type: attachment.mime }))
    await operation.done
  }
  // Deliberate one-time location share: a single fix with a text body, sent
  // as a Sender asset. There is no watchPosition or beacon path — background
  // tracking cannot start from here.
  async sendLocation(accountId: string, roomId: string, location: { lat: number; lon: number; uncertainty?: number; description?: string }): Promise<void> {
    const sdk = await loadSdk()
    await this.ensureEncryptionReady(accountId, roomId)
    const timeline = await this.timeline(accountId, roomId)
    const description = location.description?.trim() || undefined
    await timeline.sendLocation(locationTextAlternative({ ...location, description }), formatGeoUri(location),
      description, undefined, sdk.AssetType.Sender, undefined)
  }
  async download(accountId: string, roomId: string, message: Message) {
    const key = `${accountId}/${roomId}/${message.id}`
    const cached = this.objectUrls.get(key)
    if (cached) return cached
    const source = this.media.get(key)
    if (!source) throw new Error('This attachment has not finished syncing.')
    const bytes = await this.getClient(accountId).getMediaContent(source)
    const url = URL.createObjectURL(new Blob([bytes], { type: safeMediaMime(message.attachment?.mime) }))
    this.objectUrls.set(key, url)
    return url
  }
  // Authenticated profile picture through the client's media API. Cached per
  // account so room timelines do not refetch it; revoked with the account's
  // other object URLs on logout or removal.
  async profileAvatar(accountId: string, userId: string): Promise<string | undefined> {
    const sdk = await loadSdk()
    const key = `${accountId}/avatar/${userId}`
    const cached = this.objectUrls.get(key)
    if (cached) return cached
    const profile = await this.getClient(accountId).getProfile(userId)
    if (!profile.avatarUrl) return undefined
    const bytes = await this.getClient(accountId).getMediaContent(sdk.MediaSource.fromUrl(profile.avatarUrl))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
    this.objectUrls.set(key, url)
    return url
  }
  forgetAvatar(accountId: string, userId: string) {
    const key = `${accountId}/avatar/${userId}`
    const cached = this.objectUrls.get(key)
    if (cached) { URL.revokeObjectURL(cached); this.objectUrls.delete(key) }
  }
  async paginate(accountId: string, roomId: string) { return (await this.timeline(accountId, roomId)).paginateBackwards(40) }
  async markRead(accountId: string, roomId: string) { const sdk = await loadSdk(); await this.getRoom(accountId, roomId).markAsRead(sdk.ReceiptType.Read) }
  async typing(accountId: string, roomId: string, value: boolean) { await this.getRoom(accountId, roomId).typingNotice(value) }
  async favorite(accountId: string, roomId: string, value: boolean) { await this.getRoom(accountId, roomId).setIsFavourite(value, undefined); await this.refreshRooms(accountId) }
  async join(accountId: string, alias: string) { const room = await this.getClient(accountId).joinRoomByIdOrAlias(alias, []); await this.refreshRooms(accountId); return room.id() }
  async leave(accountId: string, roomId: string) { await this.getRoom(accountId, roomId).leave(); await this.refreshRooms(accountId) }
  async decline(accountId: string, roomId: string) { await this.getRoom(accountId, roomId).leave(); await this.refreshRooms(accountId) }
  // Room upgrades are a tombstone state event pointing at the replacement.
  // The successor surfaces on Room.successor for navigation; the old room
  // keeps working for history.
  async tombstoneRoom(accountId: string, roomId: string, replacementId: string, reason: string) {
    if (!reason.trim()) throw new Error('Say why this room is being replaced.')
    await this.sendRoomState(accountId, roomId, 'm.room.tombstone',
      { body: reason.trim(), replacement_room: replacementId }, 'Replacing this room failed.')
    await this.refreshRooms(accountId)
  }
  async createRoom(accountId: string, name: string, topic: string, invite?: string) {
    const sdk = await loadSdk()
    const id = await this.getClient(accountId).createRoom(sdk.CreateRoomParameters.new({ name, topic, isEncrypted: true, isDirect: Boolean(invite), visibility: new sdk.RoomVisibility.Private(), preset: sdk.RoomPreset.PrivateChat, invite: invite ? [invite] : undefined }))
    await this.getClient(accountId).awaitRoomRemoteEcho(id)
    await this.refreshRooms(accountId)
    this.createdEncrypted.add(`${accountId}/${id}`)
    return id
  }
  async members(accountId: string, roomId: string): Promise<Member[]> {
    const iterator = await this.getRoom(accountId, roomId).members()
    const members: Member[] = []
    for (let chunk = iterator.nextChunk(100); chunk; chunk = iterator.nextChunk(100)) {
      if (!chunk.length) break
      // The FFI keeps historic members (kicked, banned, left) with their
      // membership state, so only the active roster is returned.
      for (const member of chunk) {
        const membership = String((member.membership as { tag?: string })?.tag ?? member.membership).toLowerCase()
        if (membership !== 'join' && membership !== 'invite') continue
        members.push({ id: member.userId, name: member.displayName ?? member.userId, role: String(member.suggestedRoleForPowerLevel), membership })
      }
    }
    return members
  }
  async invite(accountId: string, roomId: string, userId: string) { await this.getRoom(accountId, roomId).inviteUserById(userId) }
  // Room settings and moderation over authenticated REST: the FFI exposes
  // permission checks but no state-sending mutations, so the server remains
  // the authority and its refusals surface through matrixError.
  private async uploadBytes(accountId: string, mimeType: string, data: ArrayBuffer): Promise<string> {
    const session = this.sessionOf(accountId)
    let response: Response
    try {
      response = await fetch(`${session.homeserverUrl.replace(/\/+$/, '')}/_matrix/media/v3/upload`, { method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}`, 'content-type': mimeType }, body: data })
    } catch { throw new Error('The homeserver could not be reached. Check the connection and try again.') }
    const parsed = await response.json().catch(() => null)
    if (response.status >= 400 || !parsed?.content_uri) throw new Error(matrixError(parsed, 'The upload failed. Try again.'))
    return String(parsed.content_uri)
  }
  private async roomState(accountId: string, roomId: string, type: string): Promise<any> {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`)
    if (call.status === 404) return null
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Reading the room settings failed.'))
    return call.body
  }
  private async sendRoomState(accountId: string, roomId: string, type: string, body: unknown, fallback: string, stateKey = '') {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}${stateKey ? `/${encodeURIComponent(stateKey)}` : ''}`, 'PUT', body)
    if (call.status >= 400) throw new Error(matrixError(call.body, fallback))
  }
  async roomSettings(accountId: string, roomId: string) {
    const [name, topic, avatar, history, join, power] = await Promise.all([
      this.roomState(accountId, roomId, 'm.room.name'), this.roomState(accountId, roomId, 'm.room.topic'),
      this.roomState(accountId, roomId, 'm.room.avatar'), this.roomState(accountId, roomId, 'm.room.history_visibility'),
      this.roomState(accountId, roomId, 'm.room.join_rules'), this.roomState(accountId, roomId, 'm.room.power_levels'),
    ])
    // Permissions come from the same server-side power levels the server
    // enforces: the FFI room-info snapshot can lag sync right after changes.
    const users: Record<string, number> = power?.users ?? {}
    const me = this.sessionOf(accountId).userId
    const own = typeof users[me] === 'number' ? users[me] : (power?.users_default ?? 0)
    const atLeast = (need: number) => own >= need
    const stateDefault = power?.state_default ?? 50
    return {
      name: name?.name ?? '', topic: topic?.topic ?? '', avatar: avatar?.url ?? '',
      historyVisibility: history?.history_visibility ?? 'shared', joinRule: join?.join_rule ?? 'invite',
      power: power ? { users, usersDefault: power.users_default ?? 0, stateDefault,
        eventsDefault: power.events_default ?? 0, ban: power.ban ?? 50, kick: power.kick ?? 50, redact: power.redact ?? 50, invite: power.invite ?? 0 } : null,
      permissions: { own, state: atLeast(stateDefault), ban: atLeast(power?.ban ?? 50), kick: atLeast(power?.kick ?? 50), invite: atLeast(power?.invite ?? 0) },
    }
  }
  // Only changed fields are sent, so a moderator never trips over a level
  // they hold but did not touch (history visibility needs 100 here).
  async saveRoomSettings(accountId: string, roomId: string, value: { name: string; topic: string; avatar?: { mime: string; data: ArrayBuffer }; removeAvatar?: boolean; historyVisibility: string; joinRule: string }) {
    if (!value.name.trim()) throw new Error('Give the room a name first.')
    const current = await this.roomSettings(accountId, roomId)
    if (value.name.trim() !== current.name) await this.sendRoomState(accountId, roomId, 'm.room.name', { name: value.name.trim() }, 'Saving the room name failed.')
    if (value.topic !== current.topic) await this.sendRoomState(accountId, roomId, 'm.room.topic', { topic: value.topic }, 'Saving the room topic failed.')
    if (value.avatar) await this.sendRoomState(accountId, roomId, 'm.room.avatar', { url: await this.uploadBytes(accountId, value.avatar.mime, value.avatar.data) }, 'Saving the room picture failed.')
    else if (value.removeAvatar && current.avatar) await this.sendRoomState(accountId, roomId, 'm.room.avatar', {}, 'Removing the room picture failed.')
    if (value.historyVisibility !== current.historyVisibility) await this.sendRoomState(accountId, roomId, 'm.room.history_visibility', { history_visibility: value.historyVisibility }, 'Saving history visibility failed.')
    if (value.joinRule !== current.joinRule) await this.sendRoomState(accountId, roomId, 'm.room.join_rules', { join_rule: value.joinRule }, 'Saving the join rule failed.')
    await this.refreshRooms(accountId)
  }
  async moderate(accountId: string, roomId: string, what: 'kick' | 'ban' | 'unban', userId: string, reason?: string) {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/${what}`, 'POST',
      { user_id: userId, ...(reason ? { reason } : {}) })
    if (call.status >= 400) throw new Error(matrixError(call.body, `The server refused to ${what} this member.`))
  }
  // Power levels are read-modify-write: re-read the event, change one entry,
  // write it back. Concurrent edits last-write-wins on the server.
  async setPowerLevel(accountId: string, roomId: string, userId: string, level: number) {
    if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error('Power levels run from 0 to 100.')
    const current = await this.roomState(accountId, roomId, 'm.room.power_levels')
    if (!current) throw new Error('This room has no power levels to edit.')
    await this.sendRoomState(accountId, roomId, 'm.room.power_levels',
      { ...current, users: { ...(current.users ?? {}), [userId]: level } }, 'Saving the power level failed.')
  }
  // Spaces are created over authenticated REST: the FFI createRoom has no
  // room-type field, so creation_content carries m.space and the server
  // stays authoritative. Spaces are unencrypted by convention.
  async createSpace(accountId: string, name: string, topic: string) {
    if (!name.trim()) throw new Error('Give the space a name first.')
    const call = await this.authedCall(accountId, '/_matrix/client/v3/createRoom', 'POST',
      { name: name.trim(), topic, creation_content: { type: 'm.space' }, preset: 'private_chat', visibility: 'private' })
    if (call.status >= 400 || !call.body?.room_id) throw new Error(matrixError(call.body, 'Creating the space failed.'))
    await this.refreshRooms(accountId)
    return String(call.body.room_id)
  }
  // Hierarchy reads paginate the FFI space list to the end (paginate
  // no-ops once endReached), guarded so a hostile graph cannot spin.
  async spaceChildren(accountId: string, spaceId: string): Promise<SpaceChild[]> {
    const list = await this.getClient(accountId).spaceService().spaceRoomList(spaceId)
    const seen = new Map<string, SpaceChild>()
    for (let guard = 0; guard < 50; guard++) {
      for (const entry of list.rooms()) {
        if (seen.has(entry.roomId)) continue
        const membership = String((entry.state as { tag?: string } | undefined)?.tag ?? '').toLowerCase() || 'unknown'
        seen.set(entry.roomId, { id: entry.roomId, name: entry.displayName, topic: entry.topic ?? '',
          space: String((entry.roomType as { tag?: string })?.tag ?? '').toLowerCase() === 'space',
          members: Number(entry.numJoinedMembers), children: Number(entry.childrenCount), membership, via: [...entry.via] })
      }
      const state = list.paginationState() as { tag?: string; inner?: { endReached?: boolean } }
      if (state?.tag === 'Idle' && state.inner?.endReached) break
      await list.paginate()
    }
    return [...seen.values()]
  }
  // Spaces this account may organize (may send m.space.child). The FFI
  // derives this from power levels, matching what the server enforces.
  async editableSpaces(accountId: string): Promise<string[]> {
    return (await this.getClient(accountId).spaceService().editableSpaces()).map(space => space.roomId)
  }
  // Child links go over REST like the other state mutations: the FFI
  // add/remove helpers fail opaquely (ClientError.Generic) on fresh rooms,
  // and the server stays authoritative with mapped refusals. Removal sends
  // {} rather than redacting (spec #2252: redacted state resolves oddly).
  async addSpaceChild(accountId: string, spaceId: string, childId: string) {
    const via = new URL(this.sessionOf(accountId).homeserverUrl).host
    await this.sendRoomState(accountId, spaceId, 'm.space.child', { via: [via] },
      'Adding rooms to this space failed. Only moderators can organize it.', childId)
    await this.refreshRooms(accountId)
  }
  async removeSpaceChild(accountId: string, spaceId: string, childId: string) {
    await this.sendRoomState(accountId, spaceId, 'm.space.child', {},
      'Removing rooms from this space failed. Only moderators can organize it.', childId)
    await this.refreshRooms(accountId)
  }
  // Notification rules over the FFI notification settings: per-room modes
  // (mute, mentions-only, all, or the account default) plus account-wide
  // defaults per room kind and mention toggles. The server stores the push
  // rules; reads here always reflect what it enforces.
  async roomNotify(accountId: string, roomId: string): Promise<{ mode: NotifyMode; custom: boolean }> {
    const sdk = await loadSdk()
    const room = await this.getRoom(accountId, roomId)
    const info = await room.roomInfo()
    const settings = await this.getClient(accountId).getNotificationSettings()
    const current = await settings.getRoomNotificationSettings(roomId,
      info.encryptionState === sdk.EncryptionState.Encrypted, info.isDirect)
    const custom = await settings.getUserDefinedRoomNotificationMode(roomId)
    return { mode: modeFromSdk(sdk, current.mode), custom: custom !== undefined }
  }
  // The FFI derives its delete list from its local push-rule cache, which
  // can lag sync after a fast mode change and orphan the counterpart rule
  // (an Override mute survives a switch to mentions-only, and reads keep
  // reporting mute). Deleting the counterpart server-side makes the switch
  // deterministic; a 404 just means there was nothing to remove.
  private async deletePushRule(accountId: string, kind: 'override' | 'room', ruleId: string) {
    const call = await this.authedCall(accountId,
      `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(ruleId)}`, 'DELETE')
    if (call.status === 404) return
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Updating notification rules failed.'))
  }
  async setRoomNotify(accountId: string, roomId: string, mode: NotifyMode | 'default') {
    const sdk = await loadSdk()
    const settings = await this.getClient(accountId).getNotificationSettings()
    if (mode === 'default') {
      await settings.restoreDefaultRoomNotificationMode(roomId)
      await this.deletePushRule(accountId, 'override', roomId)
      await this.deletePushRule(accountId, 'room', roomId)
    } else {
      await settings.setRoomNotificationMode(roomId, modeToSdk(sdk, mode))
      await this.deletePushRule(accountId, mode === 'mute' ? 'room' : 'override', roomId)
    }
  }
  async notifyDefaults(accountId: string): Promise<{ encrypted: boolean; direct: boolean; mode: NotifyMode }[]> {
    const sdk = await loadSdk()
    const settings = await this.getClient(accountId).getNotificationSettings()
    const combos = [{ encrypted: false, direct: false }, { encrypted: true, direct: false },
      { encrypted: false, direct: true }, { encrypted: true, direct: true }]
    return Promise.all(combos.map(async combo => ({ ...combo,
      mode: modeFromSdk(sdk, await settings.getDefaultRoomNotificationMode(combo.encrypted, combo.direct)) })))
  }
  // Account defaults only distinguish all messages from mentions-only:
  // muting is a per-room override. The server stores both settings the same
  // way, so rejecting mute here keeps reads honest.
  async setNotifyDefault(accountId: string, encrypted: boolean, direct: boolean, mode: Exclude<NotifyMode, 'mute'>) {
    if ((mode as NotifyMode) === 'mute') throw new Error('Account defaults cannot mute: mute a room instead.')
    const sdk = await loadSdk()
    await (await this.getClient(accountId).getNotificationSettings())
      .setDefaultRoomNotificationMode(encrypted, direct, modeToSdk(sdk, mode))
  }
  async mentionToggles(accountId: string): Promise<{ user: boolean; room: boolean }> {
    const settings = await this.getClient(accountId).getNotificationSettings()
    const [user, room] = await Promise.all([settings.isUserMentionEnabled(), settings.isRoomMentionEnabled()])
    return { user, room }
  }
  async setMentionToggle(accountId: string, which: 'user' | 'room', enabled: boolean) {
    const settings = await this.getClient(accountId).getNotificationSettings()
    if (which === 'user') await settings.setUserMentionEnabled(enabled)
    else await settings.setRoomMentionEnabled(enabled)
  }
  // User safety over REST: the ignore list is per-account account data (so
  // it follows the user across sessions and devices), and reports go to
  // the room's server moderators. Ignoring is personal and invisible to
  // moderators; kicking and banning are room powers covered by moderate().
  async ignoredUsers(accountId: string): Promise<string[]> {
    const userId = this.sessionOf(accountId).userId
    const call = await this.authedCall(accountId,
      `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.ignored_user_list`, 'GET')
    if (call.status === 404) return []
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Reading the ignore list failed.'))
    const list = call.body?.ignored_users
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  }
  async setIgnored(accountId: string, userId: string, ignore: boolean) {
    if (userId === this.sessionOf(accountId).userId) throw new Error('You cannot ignore yourself.')
    const current = await this.ignoredUsers(accountId)
    const next = ignore ? [...new Set([...current, userId])] : current.filter(entry => entry !== userId)
    if (next.length === current.length && ignore === current.includes(userId)) return
    const ownId = this.sessionOf(accountId).userId
    const call = await this.authedCall(accountId,
      `/_matrix/client/v3/user/${encodeURIComponent(ownId)}/account_data/m.ignored_user_list`, 'PUT',
      { ignored_users: next })
    if (call.status >= 400) throw new Error(matrixError(call.body, ignore ? 'Ignoring this user failed.' : 'Unignoring this user failed.'))
  }
  async reportEvent(accountId: string, roomId: string, eventId: string, reason: string) {
    if (!reason.trim()) throw new Error('Say why this message is abusive.')
    const call = await this.authedCall(accountId,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/report/${encodeURIComponent(eventId)}`, 'POST',
      { score: -100, reason: reason.trim() })
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Reporting this message failed.'))
  }
  async poll(accountId: string, roomId: string, question: string, answers: string[], kind: 'disclosed' | 'undisclosed' = 'disclosed') { const sdk = await loadSdk(); await (await this.timeline(accountId, roomId)).createPoll(question, answers, 1, kind === 'undisclosed' ? sdk.PollKind.Undisclosed : sdk.PollKind.Disclosed) }
  async vote(accountId: string, roomId: string, eventId: string, answer: string) { await (await this.timeline(accountId, roomId)).sendPollResponse(eventId, [answer]) }
  async withdrawVote(accountId: string, roomId: string, eventId: string) { await (await this.timeline(accountId, roomId)).sendPollResponse(eventId, []) }
  async threadPoll(accountId: string, roomId: string, rootId: string, question: string, answers: string[], kind: 'disclosed' | 'undisclosed' = 'disclosed') { const sdk = await loadSdk(); await (await this.threadTimeline(accountId, roomId, rootId)).createPoll(question, answers, 1, kind === 'undisclosed' ? sdk.PollKind.Undisclosed : sdk.PollKind.Disclosed) }
  // Response path for thread-resident polls through the thread timeline.
  async threadVote(accountId: string, roomId: string, rootId: string, eventId: string, answer: string) { await (await this.threadTimeline(accountId, roomId, rootId)).sendPollResponse(eventId, [answer]) }
  async endPoll(accountId: string, roomId: string, eventId: string, text = 'The poll has ended.') { await (await this.timeline(accountId, roomId)).endPoll(eventId, text) }
  // Room-level half of poll-end permission: the creator can always end their
  // own poll, and members who may redact others can end anyone's (mirrors the
  // pin/unpin power-level pattern instead of attempting a forbidden event).
  async pollModPower(accountId: string, roomId: string) { return (await this.getRoom(accountId, roomId).roomInfo()).powerLevels?.canOwnUserRedactOther() ?? false }
  async security(accountId: string) {
    const sdk = await loadSdk()
    const client = this.getClient(accountId)
    const encryption = client.encryption()
    return { deviceId: client.deviceId(), fingerprint: await encryption.ed25519Key(), recovery: sdk.RecoveryState[encryption.recoveryState()], verified: sdk.VerificationState[encryption.verificationState()] }
  }
  async recover(accountId: string, key: string) { await this.getClient(accountId).encryption().recover(key) }
  async searchDirectory(accountId: string, query: string, update: (rooms: DirectoryRoom[]) => void) {
    const sdk = await loadSdk()
    const directory = this.getClient(accountId).roomDirectorySearch()
    let entries: RoomDescription[] = []
    const handle = await directory.results({ onUpdate: updates => {
      entries = applyDiffs(entries, updates)
      update(entries.map(entry => ({ id: entry.roomId, name: entry.name ?? entry.alias ?? entry.roomId, topic: entry.topic ?? '', members: Number(entry.joinedMembers), alias: entry.alias, knockable: entry.joinRule === sdk.PublicRoomJoinRule.Knock || entry.joinRule === sdk.PublicRoomJoinRule.KnockRestricted })))
    } })
    try { await directory.search(query || undefined, 30, undefined) }
    catch (error) { handle.cancel(); throw error }
    return { stop: () => handle.cancel(), next: () => directory.nextPage(), atEnd: () => directory.isAtLastPage() }
  }
  async updateProfile(accountId: string, name: string) {
    const client = this.getClient(accountId)
    await client.setDisplayName(name)
    this.events.account({ id: accountId, userId: client.userId(), name, connection: 'online', color: '#477962' })
  }
  async uploadAvatar(accountId: string, mimeType: string, data: ArrayBuffer) {
    await this.getClient(accountId).uploadAvatar(mimeType, data)
  }
  async startCall(accountId: string, roomId: string, iframe: HTMLIFrameElement, close: () => void): Promise<() => void> {
    const sdk = await loadSdk()
    const client = this.getClient(accountId)
    const room = this.getRoom(accountId, roomId)
    if (!await client.isLivekitRtcSupported()) throw new Error('This homeserver does not advertise MatrixRTC support.')
    const callUrl = callServiceUrl(import.meta.env.VITE_ELEMENT_CALL_URL, location.origin)
    const widgetId = `fern-call-${crypto.randomUUID()}`
    const settings = sdk.newVirtualElementCallWidget(sdk.VirtualElementCallWidgetProperties.new({
      elementCallUrl: callUrl.href, widgetId, parentUrl: location.origin, encryption: new sdk.EncryptionSystem.PerParticipantKeys(),
    }), sdk.VirtualElementCallWidgetConfig.new({ intent: sdk.Intent.StartCall, skipLobby: false, preload: true, hideHeader: true, confineToRoom: true }))
    const url = await sdk.generateWebviewUrl(settings, room, { clientId: 'org.fern.matrix', languageTag: navigator.language, theme: document.documentElement.dataset.theme || 'light' })
    const widgetOrigin = new URL(url).origin
    const { driver, handle } = sdk.makeWidgetDriver(settings)
    const abort = new AbortController()
    // Preloaded Element Call waits for our join instead of showing its own
    // lobby. The first widget message proves the transport is live, so the
    // join goes out then; a timer covers a silent webview. Sent once.
    let joinSent = false
    const sendJoin = () => {
      if (joinSent || abort.signal.aborted) return
      joinSent = true
      iframe.contentWindow?.postMessage(elementCallJoin(widgetId), widgetOrigin)
    }
    const joinFallback = setTimeout(sendJoin, 2500)
    const onMessage = (event: MessageEvent) => {
      if (!isCallMessage(event, widgetOrigin, iframe.contentWindow, widgetId)) return
      if (isCallJoinedEcho(event.data)) {
        // Echo Element Call posts once joined: ack locally instead of
        // relaying, so the widget driver never chokes on the unknown action.
        iframe.contentWindow?.postMessage({ ...event.data, response: {} }, widgetOrigin)
        return
      }
      if (event.data.action === 'io.element.close' || event.data.action === 'im.vector.hangup') {
        iframe.contentWindow?.postMessage({ ...event.data, response: {} }, widgetOrigin)
        close(); return
      }
      sendJoin()
      void handle.send(JSON.stringify(event.data), { signal: abort.signal }).catch(error => { if (!abort.signal.aborted) this.events.error(accountId, errorText(error)) })
    }
    window.addEventListener('message', onMessage)
    const run = async () => {
      try {
        await Promise.all([
          driver.run(room, { acquireCapabilities: () => sdk.getElementCallRequiredPermissions(client.userId(), client.deviceId()) }, { signal: abort.signal }),
          (async () => { while (!abort.signal.aborted) { const message = await handle.recv({ signal: abort.signal }); if (message === undefined) break; iframe.contentWindow?.postMessage(JSON.parse(message), widgetOrigin) } })(),
        ])
      } catch (error) { if (!abort.signal.aborted) this.events.error(accountId, errorText(error)) }
    }
    void run()
    iframe.src = url
    return () => { clearTimeout(joinFallback); abort.abort(); window.removeEventListener('message', onMessage); iframe.src = 'about:blank' }
  }
  // ---- Room widgets (#45) ----
  // Generic widget path reusing the widget-driver bridge from calls: state
  // events come from server-authoritative REST, settings are built from the
  // event URL, and the same origin/source/ID validation guards the traffic.
  // Element Call widgets get the call permissions; Jitsi widgets read room
  // membership only and send nothing.
  async listRoomWidgets(accountId: string, roomId: string): Promise<WidgetInfo[]> {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`)
    if (call.status === 403) throw new Error('This room does not share its widgets with you.')
    if (call.status >= 400) throw new Error(matrixError(call.body, 'The room widgets could not be loaded.'))
    const widgets: WidgetInfo[] = []
    for (const event of Array.isArray(call.body) ? call.body : []) {
      if (event?.type !== 'm.widget' && event?.type !== 'im.vector.modular.widgets') continue
      const info = parseWidgetEvent(String(event.state_key ?? ''), String(event.sender ?? ''), (event.content ?? {}) as { type?: unknown; name?: unknown; url?: unknown })
      if (info) widgets.push(info)
    }
    return widgets
  }
  // ---- Knock requests (#41) ----
  // Knocking memberships are moderated over server-authoritative REST:
  // accepting invites the knocker, declining kicks the knocking membership,
  // mirroring the SDK knock actions.
  async knockRoom(accountId: string, roomIdOrAlias: string, serverNames: string[] = []) {
    const sdk = await loadSdk()
    await this.getClient(accountId).knock(roomIdOrAlias, undefined, serverNames)
  }
  async pollKnockRequests(accountId: string, roomId: string): Promise<KnockRequest[]> {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members?membership=knock`)
    if (call.status === 403) throw new Error('This room does not share its knock requests with you.')
    if (call.status >= 400) throw new Error(matrixError(call.body, 'The knock requests could not be loaded.'))
    return parseKnockRequests(call.body)
  }
  async answerKnock(accountId: string, roomId: string, userId: string, accept: boolean) {
    const call = await this.authedCall(accountId, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/${accept ? 'invite' : 'kick'}`, 'POST',
      accept ? { user_id: userId } : { user_id: userId, reason: 'Knock declined' })
    if (call.status >= 400) throw new Error(matrixError(call.body, accept ? 'The knock could not be accepted.' : 'The knock could not be declined.'))
  }
  async startWidget(accountId: string, roomId: string, widget: WidgetInfo, iframe: HTMLIFrameElement, close: () => void): Promise<() => void> {
    if (widget.kind === 'unknown') throw new Error(unsupportedWidgetMessage(widget))
    let service: URL
    try { service = new URL(widget.url) } catch { throw new Error('This widget has an unusable address. Ask a moderator to fix it.') }
    if (service.protocol !== 'https:' && service.origin !== location.origin) throw new Error('Widgets must load over HTTPS.')
    const sdk = await loadSdk()
    const client = this.getClient(accountId)
    const room = this.getRoom(accountId, roomId)
    const settings = sdk.WidgetSettings.create({ widgetId: `fern-widget-${crypto.randomUUID()}`, initAfterContentLoad: true, rawUrl: widget.url })
    const url = await sdk.generateWebviewUrl(settings, room, { clientId: 'org.fern.matrix', languageTag: navigator.language, theme: document.documentElement.dataset.theme || 'light' })
    const widgetOrigin = new URL(url).origin
    const capabilities = widget.kind === 'element_call'
      ? sdk.getElementCallRequiredPermissions(client.userId(), client.deviceId())
      : sdk.WidgetCapabilities.create({ read: [new sdk.WidgetEventFilter.StateWithType({ eventType: 'm.room.member' })], send: [], requiresClient: true, updateDelayedEvent: false, sendDelayedEvent: false })
    const { driver, handle } = sdk.makeWidgetDriver(settings)
    const abort = new AbortController()
    const onMessage = (event: MessageEvent) => {
      if (!isCallMessage(event, widgetOrigin, iframe.contentWindow, settings.widgetId)) return
      if (event.data.action === 'io.element.close' || event.data.action === 'im.vector.hangup') {
        iframe.contentWindow?.postMessage({ ...event.data, response: {} }, widgetOrigin)
        close(); return
      }
      void handle.send(JSON.stringify(event.data), { signal: abort.signal }).catch(error => { if (!abort.signal.aborted) this.events.error(accountId, errorText(error)) })
    }
    window.addEventListener('message', onMessage)
    const run = async () => {
      try {
        await Promise.all([
          driver.run(room, { acquireCapabilities: () => capabilities }, { signal: abort.signal }),
          (async () => { while (!abort.signal.aborted) { const message = await handle.recv({ signal: abort.signal }); if (message === undefined) break; iframe.contentWindow?.postMessage(JSON.parse(message), widgetOrigin) } })(),
        ])
      } catch (error) { if (!abort.signal.aborted) this.events.error(accountId, errorText(error)) }
    }
    void run()
    iframe.src = url
    return () => { abort.abort(); window.removeEventListener('message', onMessage); iframe.src = 'about:blank' }
  }
  async enableRecovery(accountId: string, progress: (status: string) => void) {
    const encryption = this.getClient(accountId).encryption()
    if (await encryption.backupExistsOnServer()) throw new Error('This account already has a backup. Restore its existing recovery key instead.')
    return encryption.enableRecovery(true, undefined, { onUpdate: status => progress(status.tag) })
  }
  private verificationDelegate(accountId: string, controller: SessionVerificationControllerInterface, update: (value: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[]; deviceName?: string }) => void) {
    this.verificationControllers.set(accountId, controller)
    controller.setDelegate({
      didReceiveVerificationRequest: details => {
        this.pendingVerifications.set(accountId, details)
        update({ status: 'incoming', deviceName: details.deviceDisplayName ?? details.senderProfile.displayName ?? details.deviceId })
      },
      didAcceptVerificationRequest: () => { update({ status: 'accepted' }); void controller.startSasVerification().catch(error => this.events.error(accountId, errorText(error))) },
      didStartSasVerification: () => update({ status: 'comparing' }),
      didReceiveVerificationData: data => {
        if (data.tag === 'Emojis') update({ status: 'compare', emojis: data.inner.emojis.map(emoji => ({ symbol: emoji.symbol(), description: emoji.description() })) })
        else update({ status: 'compare', numbers: data.inner.values })
      },
      didFail: () => { update({ status: 'failed' }); this.deferClearVerification(accountId, controller) },
      didCancel: () => { update({ status: 'canceled' }); this.deferClearVerification(accountId, controller) },
      didFinish: () => { update({ status: 'verified' }); this.deferClearVerification(accountId, controller) },
    })
  }
  async listenForVerificationRequests(accountId: string, update: (value: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[]; deviceName?: string }) => void) {
    const controller = this.verificationControllers.get(accountId) ?? await this.getClient(accountId).getSessionVerificationController()
    this.verificationDelegate(accountId, controller, update)
  }
  async acceptVerificationRequest(accountId: string) {
    const controller = this.verificationControllers.get(accountId)
    const details = this.pendingVerifications.get(accountId)
    if (!controller || !details) throw new Error('There is no pending verification request for this account.')
    await controller.acknowledgeVerificationRequest(details.senderProfile.userId, details.flowId)
    await controller.acceptVerificationRequest()
    this.pendingVerifications.delete(accountId)
  }
  async startVerification(accountId: string, update: (value: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[]; deviceName?: string }) => void) {
    const controller = this.verificationControllers.get(accountId) ?? await this.getClient(accountId).getSessionVerificationController()
    this.verificationDelegate(accountId, controller, update)
    await controller.requestDeviceVerification()
  }
  async finishVerification(accountId: string, matches: boolean) {
    const controller = this.verificationControllers.get(accountId)
    if (!controller) throw new Error('Start verification first.')
    if (matches) await controller.approveVerification()
    else await controller.declineVerification()
  }
  async cancelVerification(accountId: string) {
    const controller = this.verificationControllers.get(accountId)
    if (controller) {
      const pending = this.pendingVerifications.get(accountId)
      if (pending) await controller.acknowledgeVerificationRequest(pending.senderProfile.userId, pending.flowId)
      await controller.cancelVerification()
      this.clearVerification(accountId, controller)
    }
  }
  // Sign out: revoke the server session when reachable, then always erase the
  // local account. Local erasure never throws for server failures, so a dead
  // network cannot strand credentials on this device.
  async logout(accountId: string): Promise<{ serverRevoked: boolean }> {
    let serverRevoked = false
    try { await this.getClient(accountId).logout(); serverRevoked = true } catch { serverRevoked = false }
    await this.eraseLocal(accountId)
    return { serverRevoked }
  }
  // Remove a local account without contacting the server, for sessions that
  // are already invalid or unreachable. Idempotent: unknown ids resolve.
  async removeAccount(accountId: string) {
    await this.eraseLocal(accountId)
  }
  // ---- Account registration, credentials and deactivation (#39) ----
  // First-party account REST over the saved session token. The SDK owns
  // sync and crypto; these management calls have no FFI surface, so they
  // ride plain fetch with the same token the session delegate persists.
  private restBase(server: string) {
    const base = server.includes('://') ? server : `https://${server}`
    return base.replace(/\/+$/, '')
  }
  private sessionOf(accountId: string) {
    const session = cachedSecrets(accountId)?.session
    if (!session?.accessToken || !session.homeserverUrl) throw new Error('This account is not signed in on this device.')
    return session
  }
  private async restCall(base: string, path: string, token: string | undefined, method: string, body?: unknown): Promise<{ status: number; body: any }> {
    let response: Response
    try {
      response = await fetch(`${base}${path}`, { method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) })
    } catch {
      throw new Error('The homeserver could not be reached. Check the connection and try again.')
    }
    let parsed: any = null
    try { parsed = await response.json() } catch { /* empty body */ }
    return { status: response.status, body: parsed }
  }
  private authedCall(accountId: string, path: string, method = 'GET', body?: unknown) {
    const session = this.sessionOf(accountId)
    return this.restCall(session.homeserverUrl.replace(/\/+$/, ''), path, session.accessToken, method, body)
  }
  // UIAA password dance: single-shot auth first (accepted by Synapse-style
  // servers), then one retry with the challenge session (required by
  // Spindle-style servers). Anything else surfaces as a mapped error.
  private async uiaa(accountId: string, method: string, path: string, body: Record<string, unknown>, password: string, fallback: string): Promise<any> {
    const userId = this.sessionOf(accountId).userId
    const auth = (session?: string) => ({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, ...(session ? { session } : {}) })
    let call = await this.authedCall(accountId, path, method, { ...body, auth: auth() })
    if (call.status === 401 && (call.body?.session || call.body?.flows)) {
      call = await this.authedCall(accountId, path, method, { ...body, auth: auth(call.body.session) })
    }
    if (call.status >= 400) throw new Error(matrixError(call.body, fallback))
    return call.body
  }
  // Registration capability: true when the name is free, false when taken,
  // throws when the server offers no open registration at all.
  async registerAvailable(server: string, username: string): Promise<boolean> {
    const call = await this.restCall(this.restBase(server), `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`, undefined, 'GET')
    if (call.status === 200) return call.body?.available !== false
    if (call.body?.errcode === 'M_USER_IN_USE') return false
    if (call.status === 403) throw new Error('This server does not offer open registration. Ask for an invite or use SSO if the server provides it.')
    if (call.status === 429) throw new Error('Too many attempts. Wait a while and try again.')
    throw new Error(matrixError(call.body, 'Registration could not be checked on this server.'))
  }
  // Registers with dummy/password UIAA stages. SSO-only servers throw an
  // ssoRequired error: their provider provisions the account, so callers
  // route through the SSO starter instead. Returns the new user id; the
  // caller signs in normally afterwards.
  async register(server: string, username: string, password: string): Promise<string> {
    const base = this.restBase(server)
    const attempt = (auth?: unknown) => this.restCall(base, '/_matrix/client/v3/register', undefined, 'POST',
      { username, password, initial_device_display_name: 'Fern', ...(auth ? { auth } : {}) })
    let call = await attempt()
    if (call.status === 401 && call.body?.session) {
      const stages: string[] = (call.body.flows ?? []).flatMap((flow: { stages?: string[] }) => flow.stages ?? [])
      if (stages.includes('m.login.sso')) {
        const error = new Error('This server creates accounts through your login provider. Continue with SSO — it provisions the account on first sign-in.')
        ;(error as { ssoRequired?: boolean }).ssoRequired = true
        throw error
      }
      if (stages.includes('m.login.dummy')) call = await attempt({ type: 'm.login.dummy', session: call.body.session })
    }
    if (call.status === 403 && /disabled|not allowed/i.test(call.body?.error ?? '')) {
      throw new Error('This server does not offer open registration. Ask for an invite or use SSO if the server provides it.')
    }
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Registration failed on this server.'))
    if (!call.body?.user_id) throw new Error('The server did not return a new account. Try signing in instead.')
    return call.body.user_id as string
  }
  // Password change with the UIAA dance. logoutDevices rotates every other
  // session out, which is also the expired-session proof path in tests.
  async changePassword(accountId: string, current: string, next: string, logoutDevices = true): Promise<void> {
    try {
      await this.uiaa(accountId, 'POST', '/_matrix/client/v3/account/password',
        { new_password: next, logout_devices: logoutDevices }, current, 'The password could not be changed.')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (/forbidden|not accepted|invalid/i.test(detail) && this.providerManaged(accountId)) {
        throw new Error('This account is managed by your login provider. Change the password there, not in Fern.')
      }
      throw error
    }
  }
  // Capability detection across password and OIDC accounts: refresh tokens
  // only exist on provider-managed (OIDC) sessions, which cannot change
  // passwords or emails homeserver-side.
  providerManaged(accountId: string): boolean {
    return (cachedSecrets(accountId)?.session?.refreshToken ?? undefined) !== undefined
  }
  async emails(accountId: string): Promise<{ medium: string; address: string }[]> {
    const call = await this.authedCall(accountId, '/_matrix/client/v3/account/3pid')
    if (call.status === 404 || call.body?.errcode === 'M_UNRECOGNIZED') throw new Error('This server does not support email addresses.')
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Email addresses could not be loaded.'))
    return (call.body?.threepids ?? []).map((item: { medium: string; address: string }) => ({ medium: item.medium, address: item.address }))
  }
  async requestEmailToken(accountId: string, email: string, clientSecret: string): Promise<string> {
    const call = await this.authedCall(accountId, '/_matrix/client/v3/account/3pid/email/requestToken',
      'POST', { client_secret: clientSecret, email, send_attempt: 1 })
    if (call.status >= 400) throw new Error(matrixError(call.body, 'The server could not send a verification email.'))
    if (!call.body?.sid) throw new Error('The server did not start email verification. Try again later.')
    return call.body.sid as string
  }
  async confirmEmailToken(accountId: string, clientSecret: string, sid: string, code: string, password: string): Promise<void> {
    await this.uiaa(accountId, 'POST', '/_matrix/client/v3/account/3pid',
      { three_pid_creds: { sid, client_secret: clientSecret }, bind: true }, password, 'The email address could not be verified.')
  }
  async removeEmail(accountId: string, address: string, password: string): Promise<void> {
    await this.uiaa(accountId, 'POST', '/_matrix/client/v3/account/3pid/delete',
      { medium: 'email', address }, password, 'The email address could not be removed.')
  }
  async devices(accountId: string): Promise<{ id: string; name: string; current: boolean }[]> {
    const session = this.sessionOf(accountId)
    const call = await this.authedCall(accountId, '/_matrix/client/v3/devices')
    if (call.status >= 400) throw new Error(matrixError(call.body, 'Sessions could not be loaded.'))
    return (call.body?.devices ?? []).map((device: { device_id: string; display_name?: string }) =>
      ({ id: device.device_id, name: device.display_name ?? device.device_id, current: device.device_id === session.deviceId }))
  }
  // Deletes one session by device id with its own UIAA dance. Targeted
  // deletion keeps shared fixture tokens alive in tests; signOutOthers is
  // the blunt UI variant on top.
  async deleteDevice(accountId: string, deviceId: string, password: string): Promise<void> {
    await this.uiaa(accountId, 'DELETE', `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`, {}, password, 'That session could not be signed out.')
  }
  // Signs every other session out; the count tells the UI what changed.
  async signOutOthers(accountId: string, password: string): Promise<number> {
    const others = (await this.devices(accountId)).filter(device => !device.current)
    for (const device of others) await this.deleteDevice(accountId, device.id, password)
    return others.length
  }
  async lastDevice(accountId: string): Promise<boolean> {
    try {
      return await this.getClient(accountId).encryption().isLastDevice()
    } catch {
      return false
    }
  }
  // Irreversible server-side deactivation with password UIAA, then the same
  // isolated local erasure as sign-out. Callers confirm twice: the UI gates
  // on an explicit acknowledgment and the last-device warning.
  async deactivate(accountId: string, password: string, erase: boolean): Promise<void> {
    const sdk = await loadSdk()
    const userId = this.sessionOf(accountId).userId
    try {
      await this.getClient(accountId).deactivateAccount(
        new sdk.AuthData.Password({ passwordDetails: { identifier: userId, password } }), erase)
    } catch {
      // The FFI call is single-shot auth: servers needing session-bound UIAA
      // fall through to the REST dance, which also produces the mapped
      // wrong-password copy. Either path failing leaves the account intact.
      try {
        await this.uiaa(accountId, 'POST', '/_matrix/client/v3/account/deactivate', { erase }, password, 'Deactivation failed.')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (/forbidden|refused|not accepted|invalid|unauthor|bad password/i.test(detail)) {
          throw new Error('That password was not accepted. Deactivation keeps the account untouched.')
        }
        throw error
      }
    }
    await this.eraseLocal(accountId)
  }
  private async eraseLocal(accountId: string) {
    this.attachTokens.set(accountId, (this.attachTokens.get(accountId) ?? 0) + 1)
    // Records are keyed by store id, so the account id drops its own stores.
    const storeId = savedAccounts()[accountId] ? accountId : undefined
    await this.syncs.get(accountId)?.stop().catch(() => {})
    this.handles.get(accountId)?.forEach(handle => { try { handle.cancel() } catch { /* Handles may already be stopped. */ } })
    const timer = this.timers.get(accountId)
    if (timer) clearTimeout(timer)
    this.roomLists.delete(accountId); this.verificationControllers.get(accountId)?.setDelegate(undefined); this.verificationControllers.delete(accountId); this.pendingVerifications.delete(accountId)
    this.clients.delete(accountId); this.syncs.delete(accountId); this.handles.delete(accountId); this.timers.delete(accountId)
    this.refreshFailures.delete(accountId); this.refreshMarkedOffline.delete(accountId)
    for (const key of [...this.createdEncrypted]) if (key.startsWith(`${accountId}/`)) this.createdEncrypted.delete(key)
    this.attachTokens.delete(accountId)
    const entries = savedAccounts(); delete entries[accountId]; localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    await dropSecrets(accountId).catch(error => { this.events.error(accountId, `Removing the saved secret failed (${errorText(error)}). Remove the account again to retry.`) })
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith(draftPrefix(accountId))) localStorage.removeItem(key)
    }
    for (const [key, url] of this.objectUrls) if (key.startsWith(`${accountId}/`)) { URL.revokeObjectURL(url); this.objectUrls.delete(key) }
    for (const map of [this.timelineCache, this.threadTimelines, this.eventCache, this.media]) for (const key of map.keys()) if (key.startsWith(`${accountId}/`)) map.delete(key)
    // The dropped wrappers are collected while the remaining accounts keep
    // syncing, which releases the connections so these deletions complete;
    // callers poll indexedDB.databases() for absence.
    if (storeId) await dropTempStore(storeId)
  }
  async dispose() {
    this.alive = false
    this.oidcFlows.clear()
    this.ssoFlows.clear()
    for (const controller of this.verificationControllers.values()) controller.setDelegate(undefined)
    this.pendingVerifications.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const handles of this.handles.values()) handles.forEach(handle => handle.cancel())
    await Promise.allSettled([...this.syncs.values()].map(sync => sync.stop()))
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url)
  }
}
