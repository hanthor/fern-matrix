import { reactive, computed, watch, ref } from 'vue'
import { demoAccounts, demoRooms, demoMembers, initialDemoMessages } from './demo'
import { markdownToHtml } from './format'
import { clipExtension } from './voice'
import { locationTextAlternative, type MapProvider } from './location'
import { forwardBlockReason, forwardPreview } from './forward'
import { parseSlashCommand } from './slash'
import { disablePin, isLockEnabled, isUnlocked, loadLockTimeout, lockApp, lockProtectionNote, saveLockTimeout, setupPin, verifyPin } from './applock'
import { clearSecretsCache, readAllSecrets, writeAllSecrets } from './secrets'
import type { WidgetInfo } from './widgets'
import type { KnockRequest } from './knock'
import { decodeQrLoginBytes } from './qr'
import type { QrProgress } from './sdk/engine'
import { version as appVersion } from '../package.json'
import type { Account, Room, Message, Member, SpaceChild } from './types'
import type { NotifyMode } from './sdk/engine'
// Map links on location messages are configurable (OpenStreetMap default,
// Google opt-in); persisted locally, never sent anywhere. Storage access is
// guarded so node-environment unit suites can import the store.
function storedMapProvider(): MapProvider {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('fern.maps') === 'google' ? 'google' : 'osm' }
  catch { return 'osm' }
}
export const mapProvider = ref<MapProvider>(storedMapProvider())
export function setMapProvider(value: MapProvider) {
  mapProvider.value = value
  try { localStorage.setItem('fern.maps', value) } catch { /* non-browser */ }
}
import { MatrixEngine } from './sdk/engine'
const demoKey = 'fern.demo.v1'
function readDemo(): { rooms?: Room[]; messages?: Record<string, Message[]> } {
  try { return JSON.parse(localStorage.getItem(demoKey) ?? '{}') } catch { return {} }
}
// Demo availability: the local tour ships only on the dedicated demo
// instance (GitHub Pages sets VITE_FERN_DEMO=1 at build time) or an explicit
// ?demo=1 override, plus always under unit tests exercising the fixtures.
// Everywhere else the app starts empty and prompts for login/account
// creation; ?demo=0 forces the gate even on the demo instance.
export function demoEnabled(): boolean {
  // Explicit URL override wins over the build flag.
  if (typeof location !== 'undefined') {
    try {
      const param = new URLSearchParams(location.search).get('demo')
      if (param === '1' || param === '0') return param === '1'
    } catch { /* non-URL runtime */ }
  }
  const flag = (import.meta.env?.VITE_FERN_DEMO as string | undefined) ?? ''
  if (flag === '1' || flag === '0') return flag === '1'
  if (typeof process !== 'undefined' && (process.env?.VITEST === 'true' || process.env?.NODE_ENV === 'test')) return true
  return false
}
const demoSeeded = demoEnabled()
const saved: { rooms?: Room[]; messages?: Record<string, Message[]> } = demoSeeded ? readDemo() : {}
export const state = reactive({
  accounts: demoSeeded ? structuredClone(demoAccounts) : [] as Account[],
  rooms: demoSeeded ? (saved.rooms ?? structuredClone(demoRooms)) : [] as Room[],
  messages: demoSeeded ? (saved.messages ?? {}) : {} as Record<string, Message[]>,
  activeAccountId: demoSeeded ? 'demo-home' : '', activeRoomId: demoSeeded ? 'general' : '',
  filter: 'all', spaceId: '', roomQuery: '', messageQuery: '', typing: [] as string[], members: [] as Member[],
  inboxAll: false,
  loading: false, busy: false, error: '', mobileRoom: false, details: false,
  lastRoom: {} as Record<string, string>, jumpToEvent: '',
  firstUnread: {} as Record<string, { id: string; count: number }>,
  avatars: {} as Record<string, string>, uploading: false,
  thread: undefined as { accountId: string; roomId: string; rootId: string; root: Message | undefined; messages: Message[]; end: boolean; loading: boolean } | undefined,
  threadSeen: {} as Record<string, number>,
})
const avatarInflight = new Map<string, Promise<string | undefined>>()
export function avatarKey(accountId: string, userId: string) { return `${accountId}/avatar/${userId}` }
export const avatarUrl = (accountId: string, userId: string) => state.avatars[avatarKey(accountId, userId)]
// Memoized profile-picture fetch feeding UserAvatar images. Failures resolve
// to undefined so a missing avatar never blocks the timeline.
export function ensureAvatar(accountId: string, userId: string): Promise<string | undefined> {
  const key = avatarKey(accountId, userId)
  if (state.avatars[key] || isDemoAccount(accountId)) return Promise.resolve(state.avatars[key])
  const inflight = avatarInflight.get(key)
  if (inflight) return inflight
  const pending = engine.profileAvatar(accountId, userId)
    .then(url => { if (url) state.avatars[key] = url; return url })
    .catch(() => undefined)
    .finally(() => { if (avatarInflight.get(key) === pending) avatarInflight.delete(key) })
  avatarInflight.set(key, pending)
  return pending
}
function isDemoAccount(accountId: string) { return state.accounts.find(item => item.id === accountId)?.connection === 'demo' }
export function refreshAvatar(accountId: string, userId: string) {
  engine.forgetAvatar(accountId, userId)
  delete state.avatars[avatarKey(accountId, userId)]
  return ensureAvatar(accountId, userId)
}
let uploadCancel: (() => void) | undefined
export function cancelUpload() { uploadCancel?.(); uploadCancel = undefined }
export interface Diagnostics {
  app: string
  generatedAt: string
  accounts: { userId: string; connection: string; rooms: number; messages: number }[]
}
// Allowlist support export: per-account counts and connection states only.
// Access tokens, passphrases, recovery keys, message bodies, drafts, errors
// and media bytes are never selected, so they cannot leak into the file.
export function diagnostics(): Diagnostics {
  return {
    app: appVersion,
    generatedAt: new Date().toISOString(),
    accounts: state.accounts.map(account => ({
      userId: account.userId,
      connection: account.connection,
      rooms: state.rooms.filter(room => room.accountId === account.id).length,
      messages: Object.entries(state.messages)
        .filter(([key]) => key.startsWith(`${account.id}/`))
        .reduce((total, [, list]) => total + list.length, 0),
    })),
  }
}
export function downloadDiagnostics() {
  const blob = new Blob([JSON.stringify(diagnostics(), null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'fern-diagnostics.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
}
export const threadKey = (accountId: string, roomId: string, rootId: string) => `${accountId}/${roomId}/${rootId}`
export function threadUnread(accountId: string, roomId: string, rootId: string, total: number) {
  return Math.max(0, total - (state.threadSeen[threadKey(accountId, roomId, rootId)] ?? 0))
}
let stopThread: (() => void) | undefined
const threadMarked = new Set<string>()
export function closeThread() {
  stopThread?.(); stopThread = undefined
  if (state.thread) for (const key of [...threadMarked]) if (key.startsWith(threadKey(state.thread.accountId, state.thread.roomId, state.thread.rootId))) threadMarked.delete(key)
  state.thread = undefined
}
function markThreadLatest(view: { accountId: string; roomId: string; rootId: string }, messages: Message[]) {
  const latest = [...messages].reverse().find(item => item.id.startsWith('$') && !item.own)
  const marker = threadKey(view.accountId, view.roomId, view.rootId) + '/' + (latest?.id ?? 'none')
  if (threadMarked.has(marker)) return
  threadMarked.add(marker)
  if (latest) void action(() => engine.markThreadRead(view.accountId, view.roomId, view.rootId, latest.id))
}
export async function openThread(accountId: string, roomId: string, rootId: string) {
  closeThread()
  const loaded = state.messages[messageKey(accountId, roomId)] ?? []
  const root = loaded.find(item => item.id === rootId)
  state.thread = { accountId, roomId, rootId, root, messages: [], end: false, loading: true }
  if (isDemoAccount(accountId)) {
    state.thread.messages = loaded.filter(item => item.id === rootId || item.threadRoot === rootId)
    state.thread.end = true
    state.thread.loading = false
    markThreadSeen(accountId, roomId, rootId, root?.threadReplies ?? state.thread.messages.length)
    return
  }
  try {
    stopThread = await engine.watchThread(accountId, roomId, rootId, updated => {
      if (!state.thread || state.thread.rootId !== rootId) return
      state.thread.messages = updated
      state.thread.loading = false
      markThreadSeen(accountId, roomId, rootId, updated.filter(item => item.threadRoot).length || root?.threadReplies)
      markThreadLatest({ accountId, roomId, rootId }, updated)
    })
  } catch (error) {
    state.thread.loading = false
    state.error = error instanceof Error ? error.message : String(error)
  }
}
function markThreadSeen(accountId: string, roomId: string, rootId: string, total?: number) {
  if (total !== undefined) state.threadSeen[threadKey(accountId, roomId, rootId)] = total
}
export async function threadReply(body: string, replyTo?: string) {
  const view = state.thread
  if (!view || !body.trim()) return false
  if (isDemoAccount(view.accountId)) {
    const key = messageKey(view.accountId, view.roomId)
    state.messages[key].push(localMessage(body, { threadRoot: view.rootId }))
    view.messages = state.messages[key].filter(item => item.id === view.rootId || item.threadRoot === view.rootId)
    markThreadSeen(view.accountId, view.roomId, view.rootId, (view.root?.threadReplies ?? 0) + 1)
    return true
  }
  await action(() => engine.sendThreadReply(view.accountId, view.roomId, view.rootId, body, replyTo))
  return !state.error
}
export async function paginateThread() {
  const view = state.thread
  if (!view || view.end || isDemoAccount(view.accountId)) return
  const end = await action(() => engine.paginateThread(view.accountId, view.roomId, view.rootId))
  if (end) view.end = true
}
export const account = computed(() => state.accounts.find(item => item.id === state.activeAccountId))
export const room = computed(() => state.rooms.find(item => item.id === state.activeRoomId && item.accountId === state.activeAccountId))
export const isDemo = computed(() => account.value?.connection === 'demo')
export const messageKey = (accountId: string, roomId: string) => `${accountId}/${roomId}`
export const messages = computed(() => state.messages[messageKey(state.activeAccountId, state.activeRoomId)] ?? [])
export const visibleMessages = computed(() => messages.value.filter(message =>
  !ignoredUsersState.value.includes(message.sender)
  && (!state.messageQuery || matchMessage(message, state.messageQuery))))
// Pure matcher shared by room filtering and account-wide search: body,
// sender, attachment name and poll question. Search covers synced loaded
// messages only — encrypted history has no server-side plaintext index.
export function matchMessage(message: Message, query: string): boolean {
  const haystack = `${message.body} ${message.name} ${message.attachment?.name ?? ''} ${message.poll?.question ?? ''}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(part => haystack.includes(part))
}
export const searchScope = ref<'room' | 'account'>('room')
export interface SearchHit { roomId: string; roomName: string; message: Message }
export const accountSearchResults = computed<SearchHit[]>(() => {
  if (searchScope.value !== 'account' || !state.messageQuery.trim()) return []
  const hits: SearchHit[] = []
  for (const item of accountRooms.value) {
    for (const message of state.messages[messageKey(item.accountId, item.id)] ?? []) {
      if (matchMessage(message, state.messageQuery)) hits.push({ roomId: item.id, roomName: item.name, message })
    }
  }
  return hits.sort((a, b) => b.message.timestamp - a.message.timestamp).slice(0, 100)
})
// Jump-to-message context for search results, pins, gallery and permalinks.
// The live watch keeps running underneath; clearing focus returns to it.
export const focused = ref<{ roomId: string; eventId: string; messages: Message[] } | undefined>()
let focusStop: (() => void) | undefined
export async function focusMessage(roomId: string, eventId: string) {
  clearFocus()
  const accountId = state.activeAccountId
  if (isDemoAccount(accountId)) {
    // Demo rooms have no SDK client: slice the surrounding loaded messages.
    const loaded = state.messages[messageKey(accountId, roomId)] ?? []
    const index = loaded.findIndex(item => item.id === eventId)
    if (index === -1) throw new Error('That message is not loaded in this room.')
    focused.value = { roomId, eventId, messages: loaded.slice(Math.max(0, index - 20), index + 21) }
    return
  }
  const stop = await engine.focusEvent(accountId, roomId, eventId,
    updated => { if (focused.value?.eventId === eventId) focused.value.messages = updated })
  focusStop = stop
  focused.value = { roomId, eventId, messages: [] }
}
export function clearFocus() { focusStop?.(); focusStop = undefined; focused.value = undefined }
export interface PinItem { eventId: string; message?: Message; missing: boolean; canPin: boolean }
export const pins = ref<PinItem[]>([])
export const pinsRoom = ref('')
const demoPins: Record<string, string[]> = {}
export async function loadPins() {
  if (!room.value) return
  const target = room.value
  pins.value = []
  pinsRoom.value = ''
  await action(async () => {
    if (isDemo.value) {
      const key = messageKey(target.accountId, target.id)
      pins.value = (demoPins[key] ?? []).map(eventId => {
        const message = state.messages[key]?.find(item => item.id === eventId)
        return { eventId, message, missing: !message, canPin: true }
      })
    } else {
      const { ids, canPin } = await engine.pinState(target.accountId, target.id)
      const live = state.messages[messageKey(target.accountId, target.id)] ?? []
      pins.value = await Promise.all(ids.map(async eventId => {
        // A redacted pin is unfocusable but still sits in the live timeline
        // as removed; anything else unresolvable renders as unavailable.
        const removed = live.find(item => item.id === eventId && item.body === 'Message removed')
        const message = (await engine.pinPreview(target.accountId, target.id, eventId)) ?? removed
        return { eventId, message, missing: !message, canPin }
      }))
    }
    pinsRoom.value = target.id
  })
}
export async function pinMessage(message: Message) {
  if (!room.value) return
  const target = room.value
  await action(async () => {
    if (isDemo.value) {
      const key = messageKey(target.accountId, target.id)
      demoPins[key] ??= []
      if (!demoPins[key].includes(message.id)) demoPins[key].push(message.id)
    } else await engine.pin(target.accountId, target.id, message.id)
  })
  if (!state.error && pinsRoom.value === target.id) await loadPins()
}
export async function unpinMessage(eventId: string) {
  if (!room.value) return
  const target = room.value
  await action(async () => {
    if (isDemo.value) {
      const key = messageKey(target.accountId, target.id)
      demoPins[key] = (demoPins[key] ?? []).filter(id => id !== eventId)
    } else await engine.unpin(target.accountId, target.id, eventId)
  })
  if (!state.error && pinsRoom.value === target.id) await loadPins()
}
export const galleryFilter = ref<'all' | 'media' | 'files'>('all')
export const galleryItems = computed(() => messages.value.filter(message => {
  if (!message.attachment) return false
  if (galleryFilter.value === 'media') return message.kind === 'image' || message.kind === 'video' || message.kind === 'audio'
  if (galleryFilter.value === 'files') return message.kind === 'file'
  return true
}).slice().reverse())
export const accountRooms = computed(() => state.rooms.filter(item => item.accountId === state.activeAccountId && item.membership !== 'left'))
function inSpace(item: Room, spaceId: string) {
  // Ancestor walk so nested subspace rooms filter with the top space.
  // Visited set keeps a hostile parent graph from looping.
  const seen = new Set<string>([item.id])
  let frontier = [item]
  while (frontier.length) {
    const next: Room[] = []
    for (const current of frontier) {
      const parents = [...(current.parent ? [current.parent] : []), ...(current.parents ?? [])]
      for (const parent of parents) {
        if (parent === spaceId) return true
        if (seen.has(parent)) continue
        seen.add(parent)
        const room = state.rooms.find(entry => entry.id === parent && entry.accountId === item.accountId)
        if (room) next.push(room)
      }
    }
    frontier = next
  }
  return false
}
export const accountName = (id: string) => state.accounts.find(item => item.id === id)?.name ?? ''
// Unified inbox: all accounts merged newest-first when enabled, otherwise the
// active account in sync order. Space filtering stays per-account (the rail
// lists the active account's spaces), so other-account rooms drop out while a
// space is selected.
export const inboxRooms = computed(() => state.inboxAll && state.accounts.length > 1
  ? state.rooms.filter(item => !item.space && item.membership !== 'left').sort((a, b) => b.timestamp - a.timestamp)
  : accountRooms.value)
export const filteredRooms = computed(() => inboxRooms.value.filter(item => {
  if (item.space) return false
  if (state.spaceId && !inSpace(item, state.spaceId)) return false
  if (state.filter === 'unread' && !item.unread) return false
  if (state.filter === 'people' && !item.direct) return false
  if (state.filter === 'favorites' && !item.favorite) return false
  if (state.filter === 'invites' && item.membership !== 'invited') return false
  return item.name.toLowerCase().includes(state.roomQuery.toLowerCase())
}))
export const totalUnread = computed(() => inboxRooms.value.reduce((total, item) => total + item.unread, 0))
export const linkRoomAccounts = (target: string) => state.accounts.filter(account => state.rooms.some(item => item.accountId === account.id && item.id === target && item.membership === 'joined'))
export const accountUnread = (id: string) => state.rooms.filter(item => item.accountId === id && item.membership !== 'left').reduce((total, item) => total + item.unread, 0)
export const accountMentions = (id: string) => state.rooms.filter(item => item.accountId === id && item.membership !== 'left').reduce((total, item) => total + item.mentions, 0)
// Lazily loaded: frappe-ui's root index pulls an extensionless resource import
// that Vite resolves but the Node test graph cannot, and toasts are UI-only.
export function notify(text: string) {
  void import('frappe-ui').then(({ toast }) => toast(text)).catch(() => {})
}
export async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
  state.error = ''
  try { return await fn() } catch (error) { state.error = error instanceof Error ? error.message : String(error); return undefined }
}
export const engine = new MatrixEngine({
  account(value) {
    const index = state.accounts.findIndex(item => item.id === value.id)
    if (index >= 0) state.accounts[index] = value
    else state.accounts.push(value)
    if (value.connection === 'online') void ensureAvatar(value.id, value.userId)
  },
  rooms(id, values) { state.rooms = [...state.rooms.filter(item => item.accountId !== id), ...values] },
  error(id, error) { if (state.activeAccountId === id) state.error = error },
})
let stopWatching: (() => void) | undefined
let watchGeneration = 0
let typingAt = 0
// First-unread anchor from the SDK notification count: an approximation
// (notifications do not map 1:1 onto trailing messages), clamped so the
// pill always lands on a loaded message.
export function firstUnreadAnchor(messages: Message[], unread: number) {
  if (unread <= 0 || !messages.length) return null
  const index = Math.min(messages.length - 1, Math.max(0, messages.length - unread))
  return { id: messages[index].id, count: unread }
}
export function noteFirstUnread(key: string, messages: Message[], unread: number) {
  const anchor = firstUnreadAnchor(messages, unread)
  if (anchor) state.firstUnread[key] = anchor
  else delete state.firstUnread[key]
}
export function jumpToFirstUnread(key: string) {
  const anchor = state.firstUnread[key]
  if (!anchor) return false
  delete state.firstUnread[key]
  state.jumpToEvent = anchor.id
  return true
}
export async function selectRoom(value: Room) {
  const generation = ++watchGeneration
  stopWatching?.(); stopWatching = undefined
  closeThread()
  state.activeRoomId = value.id; state.lastRoom[value.accountId] = value.id; state.mobileRoom = true; state.messageQuery = ''; state.typing = []; state.members = []
  state.loading = false
  const key = messageKey(value.accountId, value.id)
  const pendingUnread = value.unread
  delete state.firstUnread[key]
  if (account.value?.connection === 'demo') {
    state.messages[key] ??= initialDemoMessages(value)
    noteFirstUnread(key, state.messages[key], pendingUnread)
    state.members = structuredClone(demoMembers)
    value.unread = 0; value.mentions = 0
    pollModPower.value = false
    return
  }
  if (value.membership !== 'joined') return
  state.loading = true
  await action(async () => {
    const stop = await engine.watchRoom(value.accountId, value.id, updated => {
      state.messages[messageKey(value.accountId, value.id)] = updated
      if (pendingUnread > 0 && !state.firstUnread[key]) noteFirstUnread(key, updated, pendingUnread)
      for (const message of updated) void ensureAvatar(value.accountId, message.sender)
      if (generation === watchGeneration) state.loading = false
    }, users => { if (generation === watchGeneration) state.typing = users })
    if (generation !== watchGeneration) { stop(); return }
    stopWatching = stop
    await engine.markRead(value.accountId, value.id)
    value.unread = 0; value.mentions = 0
    const members = await engine.members(value.accountId, value.id)
    const ignored = isDemoAccount(value.accountId) ? [] : await engine.ignoredUsers(value.accountId)
    if (generation === watchGeneration) {
      state.members = members
      ignoredUsersState.value = ignored
      for (const member of members) void ensureAvatar(value.accountId, member.id)
    }
  })
  if (generation === watchGeneration) state.loading = false
  if (generation === watchGeneration) void refreshPollPower()
}
export function switchAccount(id: string) {
  if (id === state.activeAccountId) return
  ++watchGeneration; stopWatching?.(); stopWatching = undefined
  if (state.activeRoomId) state.lastRoom[state.activeAccountId] = state.activeRoomId
  closeThread()
  state.activeAccountId = id; state.activeRoomId = ''; state.spaceId = ''; state.filter = 'all'; state.error = ''; state.details = false; state.mobileRoom = false; state.typing = []; state.members = []
  const joined = accountRooms.value.filter(item => !item.space && item.membership === 'joined')
  const first = joined.find(item => item.id === state.lastRoom[id]) ?? joined[0]
  if (first) { void selectRoom(first); state.mobileRoom = false }
}
function localMessage(body: string, props: Partial<Message> = {}): Message {
  return { id: crypto.randomUUID(), sender: account.value!.userId, name: account.value!.name, body, timestamp: Date.now(), own: true, kind: 'text', reactions: [], ...props }
}
export async function send(body: string, reply?: Message, edit?: Message) {
  if (!room.value || !body.trim() || state.busy) return false
  const target = room.value
  const key = messageKey(target.accountId, target.id)
  state.busy = true; state.error = ''
  try {
    // Slash commands only fire on fresh messages: replies and edits send literally.
    const command = !reply && !edit ? parseSlashCommand(body.trim()) : null
    if (command && command.name !== 'literal') {
      if (command.name === 'unknown') { state.error = command.command; return false }
      if (isDemo.value) {
        if (command.name === 'me') {
          state.messages[key].push(localMessage(command.text, { kind: 'emote' }))
          target.preview = `You: ${command.text}`; target.timestamp = Date.now()
        } else if (command.name === 'topic') target.topic = command.text
        else if (command.name === 'name') target.name = command.text
        else { state.error = `/${command.name} is not available in the offline demo.`; return false }
        return true
      }
      switch (command.name) {
        case 'me': await engine.sendEmote(target.accountId, target.id, command.text); break
        case 'topic': await engine.setRoomTopic(target.accountId, target.id, command.text); break
        case 'name': await engine.setRoomName(target.accountId, target.id, command.text); break
        case 'invite': await engine.invite(target.accountId, target.id, command.userId); break
        case 'join': {
          const id = await engine.join(target.accountId, command.target)
          const joined = accountRooms.value.find(item => item.id === id)
          if (joined) await selectRoom(joined)
          break
        }
        case 'leave': await leaveRoom(target); break
      }
      return true
    }
    if (command) body = command.text
    if (isDemo.value) {
      const formattedBody = markdownToHtml(body)
      if (edit) { edit.body = body; if (formattedBody) edit.formattedBody = formattedBody; else delete edit.formattedBody; edit.edited = true }
      else state.messages[key].push(localMessage(body, { replyId: reply?.id, replyBody: reply?.body, ...(formattedBody ? { formattedBody } : {}) }))
      target.preview = `You: ${body}`; target.timestamp = Date.now()
    } else await engine.send(target.accountId, target.id, body, reply?.id, edit?.id)
    return true
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); return false }
  finally { state.busy = false }
}
export async function react(message: Message, key: string) {
  if (!room.value) return
  if (!isDemo.value) { await action(() => engine.react(state.activeAccountId, room.value!.id, message.id, key)); return }
  const reaction = message.reactions.find(item => item.key === key)
  if (reaction) { reaction.count += reaction.own ? -1 : 1; reaction.own = !reaction.own; if (!reaction.count) message.reactions = message.reactions.filter(item => item !== reaction) }
  else message.reactions.push({ key, count: 1, own: true })
}
export async function remove(message: Message) {
  if (!room.value) return
  if (isDemo.value) { message.body = 'Message removed'; message.kind = 'notice'; message.attachment = undefined; message.poll = undefined; message.reactions = [] }
  else await action(() => engine.remove(state.activeAccountId, state.activeRoomId, message.id))
}
export async function toggleFavorite(value: Room) {
  if (isDemo.value) value.favorite = !value.favorite
  else await action(() => engine.favorite(value.accountId, value.id, !value.favorite))
}
export async function upload(file: File) {
  if (!room.value) return
  if (file.size > 50 * 1024 * 1024) { state.error = 'Please choose a file smaller than 50 MB.'; return }
  const target = room.value
  state.busy = true
  await action(async () => {
    if (isDemo.value) {
      const url = URL.createObjectURL(file)
      state.messages[messageKey(target.accountId, target.id)].push(localMessage(file.name, { kind: file.type.startsWith('image/') ? 'image' : 'file', attachment: { name: file.name, size: file.size, mime: file.type, url } }))
    } else {
      state.uploading = true
      try {
        const operation = await engine.upload(target.accountId, target.id, file)
        uploadCancel = operation.cancel
        await operation.done
      } finally {
        uploadCancel = undefined
        state.uploading = false
      }
    }
  })
  state.busy = false
}
export async function sendVoice(clip: { blob: Blob; mime: string; durationMs: number; waveform: number[] }) {
  if (!room.value || state.busy) return false
  if (clip.blob.size > 50 * 1024 * 1024) { state.error = 'Please choose a voice message smaller than 50 MB.'; return false }
  const target = room.value
  const filename = `voice-message.${clipExtension(clip.mime)}`
  state.busy = true
  const outcome = await action(async () => {
    if (isDemo.value) {
      const url = URL.createObjectURL(clip.blob)
      state.messages[messageKey(target.accountId, target.id)].push(localMessage('Voice message', { kind: 'audio',
        attachment: { name: filename, size: clip.blob.size, mime: clip.mime, url, duration: clip.durationMs, waveform: clip.waveform, voice: true } }))
      target.preview = 'You: Voice message'; target.timestamp = Date.now()
      return true
    }
    state.uploading = true
    try {
      const operation = await engine.sendVoice(target.accountId, target.id,
        { bytes: await clip.blob.arrayBuffer(), filename, mime: clip.mime, durationMs: clip.durationMs, waveform: clip.waveform })
      uploadCancel = operation.cancel
      await operation.done
      return true
    } finally {
      uploadCancel = undefined
      state.uploading = false
    }
  })
  state.busy = false
  return outcome ?? false
}
export async function sendLocation(location: { lat: number; lon: number; uncertainty?: number; description?: string }) {
  if (!room.value || state.busy) return false
  const target = room.value
  const description = location.description?.trim() || undefined
  state.busy = true
  const outcome = await action(async () => {
    if (isDemo.value) {
      const body = locationTextAlternative({ ...location, description })
      state.messages[messageKey(target.accountId, target.id)].push(localMessage(body, { kind: 'location',
        location: { lat: location.lat, lon: location.lon, ...(location.uncertainty !== undefined ? { uncertainty: location.uncertainty } : {}), ...(description ? { description } : {}) } }))
      target.preview = `You: ${body}`; target.timestamp = Date.now()
      return true
    }
    await engine.sendLocation(target.accountId, target.id, { ...location, description })
    return true
  })
  state.busy = false
  return outcome ?? false
}
export interface ForwardDialog { message: Message; sourceRoomId: string; sourceRoomName: string; sourceAccountId: string; sourceAccountName: string }
export const forwardDialog = ref<ForwardDialog | undefined>()
export const forwardRoomId = ref('')
export const forwardTargets = computed(() => state.rooms.filter(item => item.membership === 'joined' && !item.space)
  .map(item => ({ room: item, accountName: state.accounts.find(value => value.id === item.accountId)?.name ?? item.accountId }))
  .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.room.name.localeCompare(b.room.name)))
export function beginForward(message: Message) {
  const reason = forwardBlockReason(message)
  if (reason || !room.value) { if (reason) state.error = reason; return }
  forwardDialog.value = { message, sourceRoomId: room.value.id, sourceRoomName: room.value.name,
    sourceAccountId: room.value.accountId, sourceAccountName: account.value?.name ?? room.value.accountId }
  forwardRoomId.value = forwardTargets.value.find(item => item.room.accountId === room.value!.accountId)?.room.id
    ?? forwardTargets.value[0]?.room.id ?? ''
}
export function cancelForward() { forwardDialog.value = undefined; forwardRoomId.value = '' }
export async function confirmForward() {
  const dialog = forwardDialog.value
  const target = forwardTargets.value.find(item => item.room.id === forwardRoomId.value)?.room
  if (!dialog || !target) { state.error = 'Choose a joined room to forward into.'; return false }
  const outcome = await action(async () => {
    if (isDemo.value) {
      const owner = state.accounts.find(value => value.id === target.accountId) ?? account.value!
      const key = messageKey(target.accountId, target.id)
      state.messages[key] ??= []
      const source = dialog.message
      const kind = source.kind === 'location' || source.kind === 'file' || source.kind === 'image' || source.kind === 'audio' || source.kind === 'video' || source.kind === 'emote' ? source.kind : 'text'
      state.messages[key].push({ ...localMessage(source.body, { kind,
        ...(source.attachment ? { attachment: { ...source.attachment } } : {}),
        ...(source.location ? { location: { ...source.location } } : {}) }),
        sender: owner.userId, name: owner.name, own: true, timestamp: Date.now() })
      target.preview = `${owner.name}: ${forwardPreview(source)}`; target.timestamp = Date.now()
    } else {
      await engine.forwardMessage(dialog.sourceAccountId, dialog.sourceRoomId, dialog.message, target.accountId, target.id)
    }
    return true
  })
  if (outcome) cancelForward()
  return outcome ?? false
}
// Shell share contract (outbound only): a title, the message text and a
// matrix.to permalink. Native share uses the platform sheet when present and
// stays silent on dismiss; otherwise the link is copied. Inbound
// share-target handling belongs to the native shell (#29/#30), not this web
// shell — the manifest deliberately declares no share_target yet.
export async function shareMessage(message: Message) {
  if (!room.value) return
  const url = `https://matrix.to/#/${encodeURIComponent(room.value.id)}/${encodeURIComponent(message.id)}`
  const text = message.body || message.attachment?.name || 'Shared message from Fern'
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ title: 'Fern message', text, url }) }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) throw error }
    return
  }
  await navigator.clipboard.writeText(`${text}\n${url}`)
  notify('Message link copied')
}
export async function peekAttachment(message: Message) {
  await action(async () => {
    if (!message.attachment || message.attachment.url) return
    message.attachment.url = await engine.download(state.activeAccountId, state.activeRoomId, message)
  })
}
export async function download(message: Message) {
  await action(async () => {
    if (!message.attachment) return
    const url = message.attachment.url ?? await engine.download(state.activeAccountId, state.activeRoomId, message)
    message.attachment.url = url
    const link = document.createElement('a'); link.href = url; link.download = message.attachment.name; link.click()
  })
}
export async function createRoom(name: string, topic: string, invite?: string) {
  const id = await action(async () => {
    if (!isDemo.value) return engine.createRoom(state.activeAccountId, name, topic, invite)
    const id = crypto.randomUUID()
    state.rooms.push({ id, accountId: state.activeAccountId, name, topic, direct: !!invite, space: false, encrypted: true, favorite: false, unread: 0, mentions: 0, members: invite ? 2 : 1, preview: 'Room created', timestamp: Date.now(), membership: 'joined' })
    return id
  })
  const created = state.rooms.find(item => item.id === id && item.accountId === state.activeAccountId)
  if (created) await selectRoom(created)
  return id
}
export async function createSpace(name: string, topic: string) {
  const id = await action(async () => {
    if (!isDemo.value) return engine.createSpace(state.activeAccountId, name, topic)
    if (!name.trim()) throw new Error('Give the space a name first.')
    const id = crypto.randomUUID()
    state.rooms.push({ id, accountId: state.activeAccountId, name: name.trim(), topic, direct: false, space: true, encrypted: false, favorite: false, unread: 0, mentions: 0, members: 1, preview: 'Space created', timestamp: Date.now(), membership: 'joined' })
    return id
  })
  return id
}
export async function joinRoom(alias: string) {
  const id = await action(async () => {
    if (!isDemo.value) return engine.join(state.activeAccountId, alias)
    return createRoom(alias.split(':')[0].replace(/^[#!]/, ''), 'Joined in local demo')
  })
  const joined = state.rooms.find(item => item.id === id && item.accountId === state.activeAccountId)
  if (joined) await selectRoom(joined)
  return id
}
export async function acceptInvite(value: Room) {
  if (isDemo.value) { value.membership = 'joined'; await selectRoom(value) }
  else { await action(() => engine.join(value.accountId, value.id)); const joined = state.rooms.find(item => item.id === value.id && item.accountId === value.accountId); if (joined) await selectRoom(joined) }
}
// ---- Room and account notification rules (#23) ----
// Browser delivery state lives here so permission, quiet accounts and the
// per-room mode cache are testable without a DOM. The OS/browser verdict is
// requested at most once per denial: a stored denial only ever shows the
// settings note, never another prompt.
const notifyPrefKey = 'fern.notify'
const quietPrefKey = 'fern.quiet'
function readNotifyPref(): boolean {
  try { return JSON.parse(localStorage.getItem(notifyPrefKey) ?? '{}').enabled === 'true' } catch { return false }
}
function readQuietPref(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(quietPrefKey) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, boolean> : {}
  } catch { return {} }
}
export const browserNotify = ref(readNotifyPref())
export const notifyPermission = ref('default')
export const quietAccounts = ref<Record<string, boolean>>(readQuietPref())
const notifiedIds = new Set<string>()
const notifyModes = new Map<string, NotifyMode>()
const notifyKey = (accountId: string, roomId: string) => `${accountId}/${roomId}`
export function roomNotifyMode(accountId: string, roomId: string): NotifyMode | undefined {
  return notifyModes.get(notifyKey(accountId, roomId))
}
// Test seam for the mode cache: production fills it from the server.
export function cacheRoomNotifyMode(accountId: string, roomId: string, mode: NotifyMode | undefined) {
  if (mode === undefined) notifyModes.delete(notifyKey(accountId, roomId))
  else notifyModes.set(notifyKey(accountId, roomId), mode)
}
export async function refreshRoomNotify(accountId: string, roomId: string) {
  if (isDemoAccount(accountId)) return
  const mode = await action(() => engine.roomNotify(accountId, roomId).then(result => result.mode))
  if (mode !== undefined) notifyModes.set(notifyKey(accountId, roomId), mode)
}
export async function setRoomNotifyMode(accountId: string, roomId: string, mode: NotifyMode | 'default') {
  const ok = await action(() => engine.setRoomNotify(accountId, roomId, mode))
  if (ok === undefined) return false
  if (mode === 'default') notifyModes.delete(notifyKey(accountId, roomId))
  else notifyModes.set(notifyKey(accountId, roomId), mode)
  roomNotifyState.value = mode === 'default' ? null : { mode, custom: true }
  notify(mode === 'default' ? 'Room follows the account notification default'
    : mode === 'mute' ? 'Room muted' : mode === 'mentions' ? 'Room notifies on mentions only' : 'Room notifies for all messages')
  return true
}
export function setAccountQuiet(accountId: string, quiet: boolean) {
  const next = { ...quietAccounts.value }
  if (quiet) next[accountId] = true
  else delete next[accountId]
  quietAccounts.value = next
  try { localStorage.setItem(quietPrefKey, JSON.stringify(next)) } catch { /* non-browser */ }
  notify(quiet ? 'This account stays quiet: no desktop notifications' : 'Desktop notifications on for this account')
}
// ---- Room widgets (#45) ----
// First-load approval is per account, widget and URL: changing the widget
// address re-asks. Demo rooms carry labelled samples so the approval flow is
// explorable without an account; approving in the demo still needs one.
const widgetApprovalKey = 'fern.widgets.approved'
function readWidgetApprovals(): Record<string, true> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(widgetApprovalKey) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, true> : {}
  } catch { return {} }
}
export const widgetApprovals = ref<Record<string, true>>(readWidgetApprovals())
const widgetApprovalId = (accountId: string, widget: WidgetInfo) => `${accountId}/${widget.id}/${widget.url}`
export function isWidgetApproved(accountId: string, widget: WidgetInfo): boolean {
  return !!widgetApprovals.value[widgetApprovalId(accountId, widget)]
}
export function approveWidget(accountId: string, widget: WidgetInfo) {
  const next = { ...widgetApprovals.value, [widgetApprovalId(accountId, widget)]: true as const }
  widgetApprovals.value = next
  try { localStorage.setItem(widgetApprovalKey, JSON.stringify(next)) } catch { /* non-browser */ }
}
export const roomWidgets = ref<WidgetInfo[]>([])
export const widgetsLoading = ref(false)
export function demoWidgets(roomId: string): WidgetInfo[] {
  if (roomId !== 'general') return []
  return [
    { id: 'standup', kind: 'jitsi', name: 'Team standup (sample)', url: 'https://meet.example.org/standup', type: 'jitsi', sender: '@maya:matrix.org' },
    { id: 'board', kind: 'unknown', name: 'Sketch board (sample)', url: 'https://board.example.org/x', type: 'net.nordeck.whiteboard', sender: '@leo:matrix.org' },
  ]
}
export async function loadRoomWidgets(accountId: string, roomId: string) {
  if (isDemoAccount(accountId)) { roomWidgets.value = demoWidgets(roomId); return }
  widgetsLoading.value = true
  const result = await action(() => engine.listRoomWidgets(accountId, roomId))
  roomWidgets.value = result ?? []
  widgetsLoading.value = false
}
export async function enableBrowserNotify(value: boolean) {
  if (!value) {
    browserNotify.value = false
    try { localStorage.setItem(notifyPrefKey, JSON.stringify({ enabled: 'false' })) } catch { /* non-browser */ }
    return
  }
  if (typeof Notification === 'undefined') {
    state.error = 'This browser does not support desktop notifications.'
    return
  }
  if (Notification.permission === 'denied') {
    notifyPermission.value = 'denied'
    browserNotify.value = false
    try { localStorage.setItem(notifyPrefKey, JSON.stringify({ enabled: 'false' })) } catch { /* non-browser */ }
    state.error = 'Notifications are blocked for Fern in this browser. Allow them in the site settings to hear from your rooms.'
    return
  }
  if (Notification.permission === 'granted') {
    notifyPermission.value = 'granted'
    browserNotify.value = true
  } else {
    const permission = await Notification.requestPermission()
    notifyPermission.value = permission
    browserNotify.value = permission === 'granted'
  }
  try { localStorage.setItem(notifyPrefKey, JSON.stringify({ enabled: String(browserNotify.value) })) } catch { /* non-browser */ }
  notify(browserNotify.value ? 'Notifications enabled while Fern is open' : 'Notification permission was not granted')
}
// One desktop notification per message at most: muted rooms, quiet
// accounts, self-sent messages and visible-window messages stay silent.
// Clicking routes to the room, even across accounts. Returns true when a
// notification was shown; pure enough for unit tests except the final
// Notification construction.
export function shouldNotify(accountId: string, room: Room, message: Message): boolean {
  if (!browserNotify.value) return false
  if (typeof document !== 'undefined' && !document.hidden) return false
  if (message.own) return false
  if (quietAccounts.value[accountId]) return false
  if (notifyModes.get(notifyKey(accountId, room.id)) === 'mute') return false
  if (notifiedIds.has(message.id)) return false
  if (ignoredUsersState.value.includes(message.sender)) return false
  return true
}
export function markNotified(message: Message) { notifiedIds.add(message.id) }
// ---- User safety (#27): ignore lists and reports ----
// Ignoring is per-account server-side account data, so it follows the user
// across sessions and stays invisible to room moderators. The active
// account's list filters the timeline, mention completion and desktop
// notifications; reporting notifies the room's server moderators.
export const ignoredUsersState = ref<string[]>([])
export async function loadIgnoredUsers() {
  ignoredUsersState.value = isDemo.value ? []
    : await action(() => engine.ignoredUsers(state.activeAccountId)) ?? []
}
export async function setIgnoredUser(userId: string, ignore: boolean) {
  if (isDemo.value) { notify('Connect your Matrix account to ignore users.'); return false }
  const ok = await action(() => engine.setIgnored(state.activeAccountId, userId, ignore))
  if (ok === undefined) return false
  await loadIgnoredUsers()
  notify(ignore ? 'User ignored: their messages stay hidden' : 'User unignored')
  return true
}
export async function reportMessage(roomId: string, eventId: string, reason: string) {
  if (isDemo.value) { notify('Connect your Matrix account to report messages.'); return false }
  const ok = await action(() => engine.reportEvent(state.activeAccountId, roomId, eventId, reason))
  if (ok === undefined) return false
  notify('Message reported to the room server moderators')
  return true
}
export const roomNotifyState = ref<{ mode: NotifyMode; custom: boolean } | null>(null)
export const notifyDefaultsState = ref<{ encrypted: boolean; direct: boolean; mode: NotifyMode }[]>([])
export const mentionToggleState = ref<{ user: boolean; room: boolean }>({ user: true, room: true })
export async function loadRoomNotifyState() {
  roomNotifyState.value = null
  const current = room.value
  if (!current || isDemo.value) return
  roomNotifyState.value = await action(() => engine.roomNotify(state.activeAccountId, current.id)) ?? null
  const cached = notifyKey(state.activeAccountId, current.id)
  if (roomNotifyState.value) notifyModes.set(cached, roomNotifyState.value.mode)
}
export async function loadAccountNotifySettings() {
  if (isDemo.value) return
  notifyDefaultsState.value = await action(() => engine.notifyDefaults(state.activeAccountId)) ?? []
  mentionToggleState.value = await action(() => engine.mentionToggles(state.activeAccountId)) ?? { user: true, room: true }
}
export async function setAccountNotifyDefault(encrypted: boolean, direct: boolean, mode: Exclude<NotifyMode, 'mute'>) {
  const ok = await action(() => engine.setNotifyDefault(state.activeAccountId, encrypted, direct, mode))
  if (ok === undefined) return false
  await loadAccountNotifySettings()
  notify('Account notification default saved')
  return true
}
export async function setMentionToggle(which: 'user' | 'room', enabled: boolean) {
  const ok = await action(() => engine.setMentionToggle(state.activeAccountId, which, enabled))
  if (ok === undefined) return false
  await loadAccountNotifySettings()
  return true
}
export async function openNotificationTarget(accountId: string, roomId: string) {
  if (accountId !== state.activeAccountId) switchAccount(accountId)
  const target = state.rooms.find(item => item.accountId === accountId && item.id === roomId)
  if (target) { await selectRoom(target); state.mobileRoom = true }
}
export function maybeNotify(accountId: string, room: Room, message: Message) {
  if (appLocked.value) return false
  if (!shouldNotify(accountId, room, message)) return false
  markNotified(message)
  try {
    const shown = new Notification(message.name || room.name,
      { body: message.body, tag: notifyKey(accountId, room.id), icon: `${import.meta.env.BASE_URL}fern.svg` })
    shown.onclick = () => openNotificationTarget(accountId, room.id)
  } catch { /* headless or blocked contexts stay silent */ }
  return true
}
export async function goToSuccessor() {
  const current = room.value
  const target = current?.successor
  if (!current || !target) return false
  // A tombstoned room stays readable for history; the replacement takes
  // over when it is joined, otherwise the server decides the join.
  const known = state.rooms.find(item => item.accountId === current.accountId && item.id === target && item.membership === 'joined')
  if (known) { await selectRoom(known); state.mobileRoom = true; return true }
  if (isDemo.value) return false
  const id = await action(() => engine.join(state.activeAccountId, target))
  return id !== undefined
}
export async function leaveRoom(value: Room) {
  await action(async () => {
    if (!isDemo.value) await engine.leave(value.accountId, value.id)
    else value.membership = 'left'
    if (state.activeRoomId === value.id) { ++watchGeneration; stopWatching?.(); stopWatching = undefined; state.activeRoomId = ''; state.mobileRoom = false }
    notify('You left the room')
  })
}
// Room-level half of poll-end permission, refreshed per room like the pin
// power check: the poll creator can always end their own poll, and members
// who may redact others can end anyone's.
export const pollModPower = ref(false)
async function refreshPollPower() {
  if (!room.value || isDemo.value) { pollModPower.value = false; return }
  pollModPower.value = await action(() => engine.pollModPower(state.activeAccountId, state.activeRoomId)) ?? false
}
export async function createPoll(question: string, answers: string[], kind: 'disclosed' | 'undisclosed' = 'disclosed') {
  return action(async () => {
    if (!room.value) return false
    if (isDemo.value) state.messages[messageKey(state.activeAccountId, state.activeRoomId)].push(localMessage(question, { kind: 'poll', poll: { question, answers: answers.map(text => ({ id: crypto.randomUUID(), text, count: 0 })), kind, ended: false, edited: false } }))
    else await engine.poll(state.activeAccountId, state.activeRoomId, question, answers, kind)
    return true
  })
}
export async function vote(message: Message, answerId: string) {
  if (!message.poll || message.poll.ended) return
  if (!isDemo.value) { await action(() => engine.vote(state.activeAccountId, state.activeRoomId, message.id, answerId)); return }
  const previous = message.poll.answers.find(answer => answer.id === message.poll?.voted)
  if (previous) previous.count--
  message.poll.voted = answerId
  message.poll.answers.find(answer => answer.id === answerId)!.count++
}
export async function withdrawVote(message: Message) {
  if (!message.poll || !message.poll.voted || message.poll.ended) return
  if (!isDemo.value) { await action(() => engine.withdrawVote(state.activeAccountId, state.activeRoomId, message.id)); return }
  const previous = message.poll.answers.find(answer => answer.id === message.poll?.voted)
  if (previous) previous.count--
  message.poll.voted = undefined
}
export function canEndPoll(message: Message) {
  return !!message.poll && !message.poll.ended && (message.own || pollModPower.value)
}
export async function endPoll(message: Message) {
  if (!message.poll || message.poll.ended) return
  if (!canEndPoll(message)) { notify('Only the poll creator or a moderator can end this poll.'); return }
  if (isDemo.value) { message.poll.ended = true; notify('Poll ended'); return }
  await action(() => engine.endPoll(state.activeAccountId, state.activeRoomId, message.id))
  if (!state.error) notify('Poll ended')
}
// Poll history for the room details tab: every loaded poll, newest first,
// paginated with the room timeline through the shared Load-more-history flow.
export const pollHistory = computed(() => messages.value.filter(message => message.kind === 'poll').slice().reverse())
// QR login/link scanning (MSC4108). Separate from account creation
// (password/SSO/OIDC) and from device verification (SAS): this flow only
// ever scans a code shown by the other device. Displaying a code is blocked
// upstream (no QR byte accessor in this FFI) and has no UI.
export type QrRole = 'login' | 'grant'
export interface QrFlow {
  role: QrRole
  stage: 'camera' | 'starting' | 'connecting' | 'confirm' | 'syncing' | 'done'
  serverName?: string
  verificationUri?: string
  userCode?: string
}
export const qrFlow = ref<QrFlow | undefined>()
let qrAbort: AbortController | undefined
export function openQr(role: QrRole) {
  qrAbort?.abort(); qrAbort = undefined
  state.error = ''
  qrFlow.value = { role, stage: 'camera' }
}
export function closeQr() {
  qrAbort?.abort(); qrAbort = undefined
  qrFlow.value = undefined
}
// Runs a scanned code: validates it locally first (no server contact), then
// scans. Cancellation aborts silently; other failures surface actionably.
export async function submitQrBytes(bytes: Uint8Array, server?: string, redirectUri?: string) {
  const flow = qrFlow.value
  if (!flow) return
  state.error = ''
  const decoded = await action(() => decodeQrLoginBytes(bytes))
  if (!decoded) return
  flow.serverName = decoded.serverName
  if (isDemo.value) {
    state.error = flow.role === 'login'
      ? 'QR sign-in is unavailable in the local demo. The code itself is valid — connect to a homeserver to use it.'
      : 'QR linking needs a connected account. The code itself is valid — connect an account to link a device.'
    return
  }
  if (flow.role === 'login' && !(decoded.serverName ?? server)) {
    state.error = 'This code does not name a homeserver. Enter your homeserver, then scan again.'
    return
  }
  qrAbort?.abort(); qrAbort = new AbortController()
  const signal = qrAbort.signal
  flow.stage = 'starting'
  const onProgress = (update: QrProgress) => {
    if (qrFlow.value !== flow || signal.aborted) return
    flow.stage = update.stage
    flow.verificationUri = update.verificationUri
    flow.userCode = update.userCode
  }
  try {
    if (flow.role === 'grant') {
      await engine.grantQrLogin(state.activeAccountId, bytes, onProgress, signal)
      if (qrFlow.value === flow && !signal.aborted) notify('New device linked')
    } else {
      const id = await engine.loginQrLogin(decoded.serverName ?? server!, bytes,
        redirectUri ?? `${location.origin}/oidc-callback.html`, onProgress, signal)
      if (qrFlow.value === flow && !signal.aborted) { switchAccount(id); retireDemo(); notify('Account connected') }
    }
  } catch (error) {
    // A cancelled scan is silent: the dialog is already gone by design.
    if (!signal.aborted) state.error = error instanceof Error ? error.message : String(error)
  }
}
export async function retrySend(message: Message) {
  if (isDemo.value) { notify('The demo has no send queue to retry.'); return }
  await action(async () => { await engine.retrySend(state.activeAccountId, state.activeRoomId, message.id); notify('Sending again') })
}
export async function discardSend(message: Message) {
  if (isDemo.value) { notify('The demo has no send queue to discard from.'); return }
  const aborted = await action(() => engine.discardSend(state.activeAccountId, state.activeRoomId, message.id))
  if (aborted === undefined) return
  notify(aborted ? 'Unsent message discarded' : 'The message already sent; remove it to retract')
}
export function typingNotice() {
  if (isDemo.value || !room.value || Date.now() - typingAt < 4000) return
  typingAt = Date.now(); void action(() => engine.typing(state.activeAccountId, state.activeRoomId, true))
}
export async function signIn(server: string, username: string, password: string) {
  state.busy = true
  const id = await action(() => engine.login(server, username, password))
  state.busy = false
  if (id) { switchAccount(id); retireDemo(); notify('Account connected') }
  return id
}
// A real account replaces the demo: the demo is onboarding, not a second
// account alongside the user's own. It returns only when the last real
// account leaves the device (see seedDemo).
export function retireDemo() {
  if (!state.accounts.some(item => item.id === 'demo-home')) return
  if (!state.accounts.some(item => item.id !== 'demo-home')) return
  if (state.activeAccountId === 'demo-home') return
  clearAccountState('demo-home')
}
export function seedDemo() {
  if (state.accounts.some(item => item.id === 'demo-home')) return
  state.accounts.push(...structuredClone(demoAccounts))
  const saved = readDemo()
  for (const room of saved.rooms ?? demoRooms) {
    if (!state.rooms.some(item => item.id === room.id && item.accountId === room.accountId)) {
      state.rooms.push(structuredClone(room))
    }
  }
  for (const [key, messages] of Object.entries(saved.messages ?? {})) {
    if (!state.messages[key]) state.messages[key] = structuredClone(messages)
  }
}
export async function signOut() {
  const id = state.activeAccountId
  if (isDemo.value) { notify('This is a demo account. Connect a Matrix account to sign in.'); return }
  await action(async () => {
    // Sign out revokes the server session when reachable and always erases
    // the local account: credentials, drafts, crypto store and cached media.
    const result = await engine.logout(id)
    clearAccountState(id)
    // Leaving the last account returns to the login gate unless this build
    // serves the demo tour.
    if (demoEnabled()) { seedDemo(); switchAccount('demo-home') }
    else if (state.accounts[0]) switchAccount(state.accounts[0].id)
    else { state.activeAccountId = ''; state.activeRoomId = '' }
    notify(result?.serverRevoked === false
      ? 'Signed out on this device. The server session may still be active.'
      : 'Signed out of this account')
  })
}
export function retryConnection(id: string) {
  // Manual re-probe for an offline or errored account: resets the backoff and
  // polls immediately instead of waiting for the next scheduled tick.
  return action(() => engine.retryConnection(id))
}
export async function removeAccount(id: string) {
  if (state.accounts.find(value => value.id === id)?.connection === 'demo') { notify('The demo account cannot be removed.'); return }
  await action(async () => {
    // Remove erases the local account without contacting the server, for
    // sessions that are already invalid or unreachable.
    await engine.removeAccount(id)
    clearAccountState(id)
    if (state.activeAccountId === id) {
      if (demoEnabled()) { seedDemo(); switchAccount('demo-home') }
      else if (state.accounts[0]) switchAccount(state.accounts[0].id)
      else { state.activeAccountId = ''; state.activeRoomId = '' }
    }
    notify('Removed this account from this device')
  })
}
function clearAccountState(id: string) {
  if (state.thread?.accountId === id) closeThread()
  state.accounts = state.accounts.filter(value => value.id !== id)
  state.rooms = state.rooms.filter(value => value.accountId !== id)
  for (const key of Object.keys(state.messages)) if (key.startsWith(`${id}/`)) delete state.messages[key]
}
watch(() => ({ rooms: state.rooms.filter(value => value.accountId.startsWith('demo-')), messages: Object.fromEntries(Object.entries(state.messages).filter(([key]) => key.startsWith('demo-')).map(([key, values]) => [key, values.filter(value => !value.attachment?.url?.startsWith('blob:'))])) }), value => {
  // A retired demo keeps its last snapshot for a future reseed instead of
  // persisting the emptied rooms over it.
  if (!state.accounts.some(item => item.id === 'demo-home')) return
  try { localStorage.setItem(demoKey, JSON.stringify(value)) } catch { /* Storage quota does not block chatting. */ }
}, { deep: true })
void selectRoom(room.value!); state.mobileRoom = false
let restored = false
export async function initialize() {
  // Session restore waits behind the app lock: secrets are unreadable until
  // the PIN verifies, and unlocking calls initialize again to finish the job.
  if (restored || appLocked.value) return
  restored = true
  await action(() => engine.restoreAll())
  // A reload with saved sessions must not resurrect the demo alongside them.
  retireDemo()
}
// ---- Device app lock (#38) ----
// The PIN gates the whole app and (outside the OS keychain) encrypts stored
// secrets with a PIN-derived key. Desktop notifications stay silent while
// locked so message bodies never leak onto a locked screen.
export const appLocked = ref(isLockEnabled() && !isUnlocked())
export const lockEnabled = ref(isLockEnabled())
export const lockTimeoutMin = ref(loadLockTimeout())
export const lockNote = lockProtectionNote()
export function setLockTimeoutMin(minutes: number) {
  try { saveLockTimeout(minutes); lockTimeoutMin.value = minutes }
  catch (error) { state.error = error instanceof Error ? error.message : String(error) }
}
export async function unlockApp(pin: string): Promise<boolean> {
  state.error = ''
  try {
    // Wrong-PIN copy belongs to the caller (translated lock screen); only
    // lockout failures surface here.
    if (!await verifyPin(pin)) return false
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); return false }
  appLocked.value = false
  await engine.warmSecrets()
  await initialize()
  return true
}
export function lockNow() { lockApp(); clearSecretsCache(); appLocked.value = true }
export async function setupAppPin(pin: string): Promise<boolean> {
  state.error = ''
  try {
    await setupPin(pin)
    // Existing plaintext entries must move under the new key now, not on
    // some later persist: otherwise setting a PIN leaves old secrets exposed.
    const { found } = await readAllSecrets()
    const skipped = await writeAllSecrets(found)
    if (skipped.length) state.error = `${skipped.length} stored session(s) could not be secured. Sign those accounts in again.`
  }
  catch (error) { state.error = error instanceof Error ? error.message : String(error); return false }
  lockEnabled.value = true
  appLocked.value = false
  return true
}
export async function changeAppPin(oldPin: string, newPin: string): Promise<boolean> {
  state.error = ''
  try {
    if (!await verifyPin(oldPin)) { state.error = 'The current PIN is wrong.'; return false }
    const { found, skipped } = await readAllSecrets()
    await setupPin(newPin)
    const failed = await writeAllSecrets(found)
    const stuck = skipped.length + failed.length
    if (stuck) state.error = `PIN changed, but ${stuck} stored session(s) could not be re-secured. Sign those accounts in again.`
    return true
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); return false }
}
export async function disableAppPin(pin: string): Promise<boolean> {
  state.error = ''
  try {
    if (!await verifyPin(pin)) { state.error = 'The current PIN is wrong.'; return false }
    const { found, skipped } = await readAllSecrets()
    disablePin()
    const failed = await writeAllSecrets(found)
    const stuck = skipped.length + failed.length
    if (stuck) state.error = `Lock removed, but ${stuck} stored session(s) stayed encrypted. Sign those accounts in again.`
    lockEnabled.value = false
    appLocked.value = false
    return true
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); return false }
}
// ---- Account registration, credentials and deactivation (#39) ----
// Registration creates the account server-side, then signs in normally so
// the session path stays identical to password login. SSO-only servers
// report 'sso' so the UI can route through the provider instead.
export async function registerAccount(server: string, username: string, password: string): Promise<'ok' | 'sso' | false> {
  // Registration needs no signed-in account: demo users onboard this way.
  state.busy = true
  try {
    const available = await action(() => engine.registerAvailable(server, username))
    if (available === undefined) return false
    if (!available) { state.error = 'That username is taken on this server.'; return false }
    try {
      await engine.register(server, username, password)
    } catch (error) {
      if ((error as { ssoRequired?: boolean }).ssoRequired) { state.error = (error as Error).message; return 'sso' }
      state.error = error instanceof Error ? error.message : String(error)
      return false
    }
    const id = await action(() => engine.login(server, username, password))
    if (!id) return false
    switchAccount(id); retireDemo(); notify('Account created and connected')
    return 'ok'
  } finally { state.busy = false }
}
export async function changePassword(current: string, next: string, logoutOthers = true) {
  if (isDemo.value) { notify('The demo has no password to change.'); return false }
  await action(() => engine.changePassword(state.activeAccountId, current, next, logoutOthers))
  if (state.error) return false
  notify(logoutOthers ? 'Password changed. Other sessions were signed out.' : 'Password changed.')
  return true
}
// Provider-managed (OIDC/SSO) accounts cannot change passwords or emails
// homeserver-side; the UI gates those forms on this flag with a reason.
export const activeProviderManaged = computed(() =>
  !isDemo.value && engine.providerManaged(state.activeAccountId))
export interface EmailAddress { medium: string; address: string }
export const emailAddresses = ref<EmailAddress[]>([])
export const emailPending = ref<{ sid: string; clientSecret: string; email: string } | undefined>()
export async function loadEmails() {
  emailAddresses.value = []
  if (isDemo.value) return
  emailAddresses.value = await action(() => engine.emails(state.activeAccountId)) ?? []
}
export async function addEmail(email: string) {
  if (isDemo.value) { notify('The demo has no email addresses.'); return false }
  const clientSecret = crypto.randomUUID()
  const sid = await action(() => engine.requestEmailToken(state.activeAccountId, email, clientSecret))
  if (sid === undefined) return false
  emailPending.value = { sid, clientSecret, email }
  notify('Check your inbox for the verification code')
  return true
}
export async function confirmEmail(code: string, password: string) {
  const pending = emailPending.value
  if (!pending) return false
  await action(() => engine.confirmEmailToken(state.activeAccountId, pending.clientSecret, pending.sid, code, password))
  if (state.error) return false
  emailPending.value = undefined
  await loadEmails()
  notify('Email address added')
  return true
}
export async function removeEmail(address: string, password: string) {
  await action(() => engine.removeEmail(state.activeAccountId, address, password))
  if (state.error) return false
  await loadEmails()
  notify('Email address removed')
  return true
}
export interface AccountDevice { id: string; name: string; current: boolean }
export const accountDevices = ref<AccountDevice[]>([])
export async function loadDevices() {
  accountDevices.value = []
  if (isDemo.value) return
  accountDevices.value = await action(() => engine.devices(state.activeAccountId)) ?? []
}
export async function signOutOthers(password: string) {
  const removed = await action(() => engine.signOutOthers(state.activeAccountId, password))
  if (removed === undefined) return
  await loadDevices()
  notify(removed ? `Signed out ${removed} other session${removed === 1 ? '' : 's'}` : 'No other sessions to sign out')
}
export const lastDeviceWarning = ref(false)
export async function prepareDeactivate() {
  lastDeviceWarning.value = isDemo.value
    ? false
    : await action(() => engine.lastDevice(state.activeAccountId)) ?? false
}
// Deactivation is irreversible server-side: the UI confirms twice (an
// explicit acknowledgment plus the last-device warning) before calling in.
export async function deactivateAccount(password: string, erase: boolean) {
  const id = state.activeAccountId
  if (isDemo.value) { notify('The demo account cannot be deactivated.'); return false }
  await action(() => engine.deactivate(id, password, erase))
  if (state.error) return false
  clearAccountState(id)
  if (state.activeAccountId === id) { seedDemo(); switchAccount('demo-home') }
  notify('Account deactivated')
  return true
}
export interface RoomSettings { roomId: string; name: string; topic: string; avatar: string; historyVisibility: string; joinRule: string; encrypted: boolean; space: boolean; power: { users: Record<string, number>; usersDefault: number; stateDefault: number; eventsDefault: number; ban: number; kick: number; redact: number; invite: number } | null; permissions: { own: number; state: boolean; ban: boolean; kick: boolean; invite: boolean }; members: Member[]; children: SpaceChild[]; canOrganize: boolean }
export const roomSettings = ref<RoomSettings | null>(null)
export async function loadRoomSettings() {
  roomSettings.value = null
  const current = room.value
  if (!current) return
  if (isDemo.value) {
    roomSettings.value = { roomId: current.id, name: current.name, topic: current.topic, avatar: '', historyVisibility: 'shared', joinRule: 'invite', encrypted: current.encrypted, space: current.space, power: null, permissions: { own: 0, state: false, ban: false, kick: false, invite: false }, members: state.members, children: [], canOrganize: false }
    return
  }
  const loaded = await action(() => engine.roomSettings(state.activeAccountId, current.id))
  if (!loaded) return
  const members = await action(() => engine.members(state.activeAccountId, current.id)) ?? []
  let children: SpaceChild[] = []
  let canOrganize = false
  if (current.space) {
    children = await action(() => engine.spaceChildren(state.activeAccountId, current.id)) ?? []
    canOrganize = (await action(() => engine.editableSpaces(state.activeAccountId)) ?? []).includes(current.id)
  }
  roomSettings.value = { ...loaded, roomId: current.id, encrypted: current.encrypted, space: current.space, members, children, canOrganize }
  await loadRoomNotifyState()
  await loadKnockRequests()
}
// ---- Knock requests (#41) ----
export const knockRequests = ref<KnockRequest[]>([])
export const knocksLoading = ref(false)
export async function loadKnockRequests() {
  knockRequests.value = []
  const settings = roomSettings.value
  if (!settings || isDemo.value || (!settings.permissions.invite && !settings.permissions.kick)) return
  knocksLoading.value = true
  knockRequests.value = await action(() => engine.pollKnockRequests(state.activeAccountId, settings.roomId)) ?? []
  knocksLoading.value = false
}
export async function answerKnockRequest(userId: string, accept: boolean) {
  const settings = roomSettings.value
  if (!settings || isDemo.value) { notify('Connect your account to moderate knock requests.'); return false }
  const ok = await action(() => engine.answerKnock(state.activeAccountId, settings.roomId, userId, accept))
  if (ok === undefined) return false
  await loadKnockRequests()
  notify(accept ? 'Knock accepted — invite sent' : 'Knock declined')
  return true
}
export async function organizeSpaceChild(childId: string, remove: boolean) {
  if (!roomSettings.value) return false
  if (isDemo.value) { notify('Space organizing needs a connected account.'); return false }
  const ok = await action(() => remove
    ? engine.removeSpaceChild(state.activeAccountId, roomSettings.value!.roomId, childId)
    : engine.addSpaceChild(state.activeAccountId, roomSettings.value!.roomId, childId))
  if (ok === undefined) return false
  await loadRoomSettings()
  notify(remove ? 'Room removed from the space' : 'Room added to the space')
  return true
}
export async function saveRoomSettings(value: { name: string; topic: string; avatar?: { mime: string; data: ArrayBuffer }; removeAvatar?: boolean; historyVisibility: string; joinRule: string }) {
  if (!roomSettings.value) return false
  if (isDemo.value) { notify('Room settings need a connected account.'); return false }
  const ok = await action(() => engine.saveRoomSettings(state.activeAccountId, roomSettings.value!.roomId, value))
  if (ok === undefined) return false
  await loadRoomSettings()
  notify('Room settings saved')
  return true
}
export async function moderateMember(what: 'kick' | 'ban' | 'unban', userId: string) {
  if (!roomSettings.value) return false
  if (isDemo.value) { notify('Member moderation needs a connected account.'); return false }
  const ok = await action(() => engine.moderate(state.activeAccountId, roomSettings.value!.roomId, what, userId))
  if (ok === undefined) return false
  await loadRoomSettings()
  notify(what === 'kick' ? 'Member removed' : what === 'ban' ? 'Member banned' : 'Ban lifted')
  return true
}
export async function setMemberPower(userId: string, level: number) {
  if (!roomSettings.value) return false
  if (isDemo.value) { notify('Power levels need a connected account.'); return false }
  const ok = await action(() => engine.setPowerLevel(state.activeAccountId, roomSettings.value!.roomId, userId, level))
  if (ok === undefined) return false
  await loadRoomSettings()
  notify('Power level saved')
  return true
}
