<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { FrappeUIProvider, ToastProvider, Button, Dialog, FormControl, Dropdown, Switch, Badge, Tooltip, Alert, ErrorMessage, LoadingIndicator, useColorScheme } from 'frappe-ui'
import { ArrowLeft, ArrowUpRight, Bell, ChevronDown, ChevronRight, CircleHelp, Command, Download, FileText, Hash, Headphones, RefreshCw, Video, Home, Info, Leaf, LockKeyhole, LogOut, MessageCircle, Moon, MoreHorizontal, Plus, Search, Send, Settings, ShieldCheck, Smile, Sparkles, Star, Sun, Users, X, Paperclip, ListFilter, Inbox, Globe, PanelRightClose, Mic, Pause, Play, Square, Trash2, MapPin, LayoutGrid, ShieldAlert } from 'lucide-vue-next'
import UserAvatar from './components/UserAvatar.vue'
import MessageRow from './components/MessageRow.vue'
import QrScan from './components/QrScan.vue'
import CallView from './components/CallView.vue'
import WidgetView from './components/WidgetView.vue'
import type { WidgetInfo } from './widgets'
import type { Message, Room, DirectoryRoom, Account } from './types'
import type { SearchHit } from './store'
import type { Permalink } from './format'
import { parsePermalink } from './format'
import { keyboardCoversComposer } from './a11y'
import { VoiceRecorder, recordingSupported, formatVoiceDuration, voiceFailureMessage, type VoiceClip } from './voice'
import { requestCurrentPosition, locationTextAlternative, type Coordinates } from './location'
import { forwardPreview } from './forward'
import { HOLD_MS, HOLD_SLOP, edgeBackIntent } from './gestures'
import { isTauri, onDeepLink, openExternal, checkAppUpdate, installAppUpdate } from './tauri'
import { useI18n } from 'vue-i18n'
import { setLocale, localeNames, type Locale } from './i18n'
import { accent, ACCENT_OPTIONS, setAccent } from './accent'
import { state, account, accountName, room, isDemo, avatarUrl, openThread, closeThread, threadReply, paginateThread, downloadDiagnostics, retryConnection, accountRooms, filteredRooms, messages, visibleMessages, totalUnread, accountUnread, accountMentions, linkRoomAccounts, selectRoom, switchAccount, retireDemo, seedDemo, goToSuccessor, browserNotify, notifyPermission, quietAccounts, setAccountQuiet, enableBrowserNotify, maybeNotify, send, toggleFavorite, upload, sendVoice, sendLocation, mapProvider, setMapProvider, searchScope, accountSearchResults, focused, focusMessage, clearFocus, pins, loadPins, unpinMessage, roomWidgets, widgetsLoading, loadRoomWidgets, isWidgetApproved, knockRequests, knocksLoading, answerKnockRequest, galleryFilter, galleryItems, forwardDialog, forwardRoomId, forwardTargets, cancelForward, confirmForward, createRoom, joinRoom, acceptInvite, leaveRoom, createPoll, pollHistory, openQr, signIn, signOut, removeAccount, approveWidget, registerAccount, changePassword, activeProviderManaged, emailAddresses, emailPending, loadEmails, addEmail, confirmEmail, removeEmail, accountDevices, loadDevices, signOutOthers, lastDeviceWarning, prepareDeactivate, deactivateAccount, roomSettings, loadRoomSettings, saveRoomSettings, moderateMember, setMemberPower, createSpace, organizeSpaceChild, messageKey, jumpToFirstUnread, appLocked, lockEnabled, lockTimeoutMin, lockNote, unlockApp, lockNow, setupAppPin, changeAppPin, disableAppPin, setLockTimeoutMin, roomNotifyState, notifyDefaultsState, mentionToggleState, loadAccountNotifySettings, setRoomNotifyMode, setAccountNotifyDefault, setMentionToggle, ignoredUsersState, loadIgnoredUsers, setIgnoredUser, reportMessage, typingNotice, action, engine, cancelUpload, refreshAvatar, initialize, react, remove, notify, download } from './store'
const { colorScheme, setColorScheme } = useColorScheme()
const modal = ref('')
const modalOpen = computed({ get: () => Boolean(modal.value), set: value => { if (!value) { if (modal.value === 'verify') void closeVerification(); else modal.value = '' } } })
const form = ref({ server: 'matrix.org', username: '', password: '', name: '', topic: '', invite: '', alias: '', question: '', answers: 'A calmer workspace\nBetter mobile conversations', undisclosed: false, recoveryKey: '', newPassword: '', email: '', emailCode: '', accountPassword: '', deactivateAck: false, eraseData: true })
const loginMode = ref<'signin' | 'register'>('signin')
const draft = ref('')
const reply = ref<Message>()
const edit = ref<Message>()
const removal = ref<Message>()
const reportTarget = ref<Message | null>(null)
const reportReason = ref('')
const reportIgnore = ref(false)
function beginReport(message: Message) { reportTarget.value = message; reportReason.value = ''; reportIgnore.value = false; open('report') }
async function submitReport() {
  if (modalBusy.value || !reportTarget.value || !room.value) return
  if (!reportReason.value.trim()) { state.error = 'Say why this message is abusive.'; return }
  modalBusy.value = true
  try {
    const target = reportTarget.value
    if (await reportMessage(room.value.id, target.id, reportReason.value)) {
      if (reportIgnore.value) await setIgnoredUser(target.sender, true)
      reportTarget.value = null; modal.value = ''
    }
  } finally { modalBusy.value = false }
}
async function submitIgnore(userId: string, ignore: boolean) {
  if (modalBusy.value) return
  modalBusy.value = true
  try { await setIgnoredUser(userId, ignore) } finally { modalBusy.value = false }
}
const pendingLink = ref<{ link: Permalink; accounts: Account[] } | undefined>()
const threadDraft = ref('')
const threadReplyTo = ref<Message>()
async function openThreadFor(message: Message) {
  if (!room.value) return
  threadDraft.value = ''; threadReplyTo.value = undefined
  state.details = true
  await openThread(state.activeAccountId, room.value.id, message.id)
}
function beginThreadReply(message: Message) { threadReplyTo.value = message }
async function submitThread() {
  if (await threadReply(threadDraft.value, threadReplyTo.value?.id)) { threadDraft.value = ''; threadReplyTo.value = undefined }
}
// Jump-to-message for search hits, pins and gallery items: switch rooms when
// needed, open the focused context, then center the target event.
async function jumpToHit(hit: SearchHit) {
  const target = accountRooms.value.find(item => item.id === hit.roomId)
  if (target && target.id !== state.activeRoomId) await selectRoom(target)
  searchOpen.value = false; state.details = false
  await action(() => focusMessage(hit.roomId, hit.message.id))
  if (state.error) return
  await nextTick()
  document.querySelector(`[data-message-id="${CSS.escape(hit.message.id)}"]`)?.scrollIntoView({ block: 'center' })
}
async function jumpToEvent(roomId: string, eventId: string) {
  state.details = false
  await action(() => focusMessage(roomId, eventId))
  if (state.error) return
  await nextTick()
  document.querySelector(`[data-message-id="${CSS.escape(eventId)}"]`)?.scrollIntoView({ block: 'center' })
}
// First-unread pill: the anchor comes from the SDK notification count at
// room open; jumping reuses the jumpToEvent scroll-and-flash machinery.
const unreadAnchor = computed(() => state.firstUnread[messageKey(state.activeAccountId, state.activeRoomId)] ?? null)
function jumpUnread() { jumpToFirstUnread(messageKey(state.activeAccountId, state.activeRoomId)) }
const emojiTarget = ref<Message>()
const searchOpen = ref(false)
const timeline = ref<HTMLElement>()
const composer = ref<{ focus?: (options?: FocusOptions) => void }>()
function composerBox() { return document.querySelector<HTMLTextAreaElement>('.composer textarea') }
function viewportReveal() {
  if (!window.visualViewport) return
  if (keyboardCoversComposer(window.visualViewport.height, window.innerHeight, document.activeElement === composerBox())) {
    composerBox()?.scrollIntoView({ block: 'nearest' })
  }
}
const fileInput = ref<HTMLInputElement>()
const avatarInput = ref<HTMLInputElement>()
const detailsTab = ref('about')
function selectDetailsTab(tab: string) { detailsTab.value = tab; if (tab === 'pins') void loadPins(); if (tab === 'widgets' && room.value) void loadRoomWidgets(state.activeAccountId, room.value.id) }
// Forward dialog state for issue #36: explicit room picker with source and
// target identities always visible, plus a cross-account warning.
const forwardOpen = computed({ get: () => forwardDialog.value !== undefined, set: value => { if (!value) cancelForward() } })
const forwardOptions = computed(() => forwardTargets.value.map(item => ({ label: `${item.accountName} · ${item.room.name}`, value: item.room.id })))
const forwardTarget = computed(() => forwardTargets.value.find(item => item.room.id === forwardRoomId.value))
const forwardCrossAccount = computed(() => !!forwardDialog.value && !!forwardTarget.value && forwardTarget.value.room.accountId !== forwardDialog.value.sourceAccountId)
const settingsTab = ref('general')
const security = ref<{ deviceId: string; fingerprint?: string; recovery: string; verified: string }>()
const modalBusy = ref(false)
const endOfHistory = ref(false)
// Render window: only the latest slice of a long timeline mounts DOM rows.
// Older loaded messages stay in state and render on demand, which bounds
// layout cost for large rooms without unloading anything from the SDK.
const renderWindow = ref(150)
const renderedMessages = computed(() => {
  const all = visibleMessages.value
  return all.length > renderWindow.value ? all.slice(all.length - renderWindow.value) : all
})
const hiddenEarlier = computed(() => visibleMessages.value.length - renderedMessages.value.length)
async function showEarlier() {
  const height = timeline.value?.scrollHeight ?? 0
  renderWindow.value += 200
  await nextTick(); if (timeline.value) timeline.value.scrollTop += timeline.value.scrollHeight - height
}
const globalSearch = ref('')
const directoryQuery = ref('')
const directoryRooms = ref<DirectoryRoom[]>([])
const directoryEnd = ref(false)
let directorySession: Awaited<ReturnType<typeof engine.searchDirectory>> | undefined
let directoryGeneration = 0
const profileName = ref('')
const compactMessages = ref(localStorage.getItem('fern.compact') === 'true')
let stopCall: (() => void) | undefined
let callGeneration = 0
let callIframe: HTMLIFrameElement | undefined
const callStatus = ref<'lobby' | 'joining' | 'active' | 'error' | 'ended'>('lobby')
const callError = ref('')
const recoveryOutput = ref('')
const recoveryProgress = ref('')
const confirmReset = ref(false)
const verification = ref<{ status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[]; deviceName?: string }>({ status: 'waiting' })
let verificationAccount = ''

const spaces = computed(() => accountRooms.value.filter(value => value.space))
const favorites = computed(() => filteredRooms.value.filter(value => value.favorite && value.membership === 'joined'))
const channels = computed(() => filteredRooms.value.filter(value => !value.favorite && !value.direct && value.membership === 'joined'))
const people = computed(() => filteredRooms.value.filter(value => !value.favorite && value.direct && value.membership === 'joined'))
const invites = computed(() => filteredRooms.value.filter(value => value.membership === 'invited'))
// Focused context replaces the live window while active (same room only).
const inFocus = computed(() => focused.value?.roomId === state.activeRoomId)
const timelineMessages = computed(() => inFocus.value ? focused.value!.messages : renderedMessages.value)
const focusBase = computed(() => inFocus.value ? 0 : visibleMessages.value.length - renderedMessages.value.length)
const focusTotal = computed(() => inFocus.value ? focused.value!.messages.length : visibleMessages.value.length)
function isCompact(index: number) { const list = timelineMessages.value; const previous = list[index - 1]; const current = list[index]; return compactMessages.value || Boolean(previous && !showDate(index) && previous.sender === current.sender && current.timestamp - previous.timestamp < 5 * 60000) }
const searchResults = computed(() => {
  const query = globalSearch.value.toLowerCase()
  return accountRooms.value.filter(value => !value.space && (!query || `${value.name} ${value.topic}`.toLowerCase().includes(query)))
})
const { t } = useI18n()
const settingsTabs = computed(() => [
  { id: 'general', label: t('tabs.appearance'), icon: Sun },
  { id: 'accounts', label: t('tabs.accounts'), icon: Users },
  { id: 'security', label: t('tabs.security'), icon: ShieldCheck },
  { id: 'notifications', label: t('tabs.notifications'), icon: Bell },
  { id: 'safety', label: t('tabs.safety'), icon: ShieldAlert },
])
function submitLocale(value: unknown) { setLocale(value as Locale) }
const dialogTitle = computed(() => ({ login: t('login.title'), create: t('dialogs.create'), dm: t('dialogs.dm'), join: t('dialogs.join'), poll: t('dialogs.poll'), emoji: emojiTarget.value ? t('dialogs.emoji') : t('dialogs.emojiTitle'), settings: t('tabs.settings'), search: t('dialogs.search'), remove: t('dialogs.remove'), leave: t('dialogs.leave', { room: room.value?.name ?? t('dialogs.roomFallback') }), invite: t('dialogs.invite'), link: t('dialogs.link'), report: t('dialogs.report'), createspace: t('dialogs.createspace'), help: t('dialogs.help'), verify: t('dialogs.verify'), qrlogin: t('dialogs.qrlogin'), qrgrant: t('dialogs.qrgrant'), call: t('dialogs.call'), widget: t('dialogs.widget'), explore: t('dialogs.explore'), roomsettings: t('dialogs.roomsettings') })[modal.value] ?? 'Fern')
const emojis = ['💚', '✨', '🌿', '👍', '❤️', '🎉', '😊', '😂', '🙌', '👀', '☀️', '🔥', '🤔', '✅', '🚀', '🙏', '💡', '👏', '🎨', '☕', '🌻', '💬', '🫶', '🤍']
const accountOptions = computed(() => [
  ...state.accounts.map(value => ({ label: `${value.name}${value.id === state.activeAccountId ? ' ✓' : ''}`, description: value.userId, onClick: () => switchAccount(value.id) })),
  { label: t('nav.addAccount'), icon: Plus, onClick: () => open('login') },
  { label: t('tabs.settings'), icon: Settings, onClick: () => open('settings') },
  ...(!isDemo.value && account.value && (account.value.connection === 'offline' || account.value.connection === 'error') ? [{ label: t('nav.retryConnection'), icon: RefreshCw, onClick: () => { const id = account.value?.id; if (id) void retryConnection(id) } }] : []),
  ...(!isDemo.value ? [{ label: t('nav.signOut'), icon: LogOut, onClick: () => void signOut() }] : []),
])
const roomOptions = computed(() => [
  { label: room.value?.favorite ? t('nav.removeFavorite') : t('nav.addFavorite'), icon: Star, onClick: () => room.value && toggleFavorite(room.value) },
  { label: t('dialogs.invite'), icon: Users, onClick: () => open('invite') },
  { label: t('dialogs.roomsettings'), icon: Settings, onClick: () => open('roomsettings') },
  { label: t('nav.roomDetails'), icon: Info, onClick: () => state.details = !state.details },
  { label: t('nav.copyRoomLink'), icon: ArrowUpRight, onClick: () => action(async () => { if (isDemo.value) { notify('Demo rooms have no public Matrix link'); return }; await navigator.clipboard.writeText(`https://matrix.to/#/${encodeURIComponent(state.activeRoomId)}`); notify('Room link copied') }) },
  { label: t('nav.leaveRoom'), icon: LogOut, onClick: () => open('leave') },
])
function exploreDemo() { seedDemo(); switchAccount('demo-home'); state.mobileRoom = false }
function open(value: string) { state.error = ''; setTimeout(() => { modal.value = value; if (value === 'login') loginMode.value = 'signin'; if (value === 'settings') { profileName.value = account.value?.name ?? ''; if (settingsTab.value === 'security') void loadAccountSections() }; if (value === 'explore') void loadDirectory(); if (value === 'roomsettings') void loadRoomSettings() }, 0) }
function chooseRoom(value: Room) { if (value.accountId !== state.activeAccountId) switchAccount(value.accountId); reply.value = undefined; edit.value = undefined; endOfHistory.value = false; void selectRoom(value) }
// Unified inbox: one room list across accounts, newest first. The space rail
// stays per-account, so enabling it clears any space filter; rows from other
// accounts hop accounts on open (switchAccount aborts the stale watch by
// generation, then selectRoom takes over).
function toggleInbox() { state.inboxAll = !state.inboxAll; state.spaceId = ''; state.mobileRoom = false }
// Room long-press peeks the details panel (the touch path for room info;
// right-click arrives as contextmenu on desktop). The manual timer covers
// engines that never fire contextmenu for a stationary touch.
let roomHold: { timer: ReturnType<typeof setTimeout>; startX: number; startY: number; value: Room } | undefined
function clearRoomHold() { if (roomHold) { clearTimeout(roomHold.timer); roomHold = undefined } }
function peekRoom(value: Room) { clearRoomHold(); if (value.id !== state.activeRoomId || value.accountId !== state.activeAccountId) chooseRoom(value); detailsTab.value = 'about'; state.details = true }
function roomHoldDown(event: PointerEvent, value: Room) {
  if (event.pointerType === 'mouse' || !event.isPrimary) return
  clearRoomHold()
  roomHold = { timer: setTimeout(() => { const held = roomHold; roomHold = undefined; if (held) peekRoom(held.value) }, HOLD_MS), startX: event.clientX, startY: event.clientY, value }
}
function roomHoldMove(event: PointerEvent) {
  if (roomHold && Math.hypot(event.clientX - roomHold.startX, event.clientY - roomHold.startY) > HOLD_SLOP) clearRoomHold()
}
function roomHoldUp() { clearRoomHold() }
function openLink(href: string) {
  const link = parsePermalink(href)
  if (!link) return
  if (link.kind === 'user') { form.value.invite = link.target; open('dm'); return }
  const candidates = linkRoomAccounts(link.target)
  if (!candidates.length) {
    if (link.target.startsWith('#')) { form.value.alias = link.target; open('join') }
    else notify('That room is not in any connected account')
    return
  }
  if (candidates.some(item => item.id === state.activeAccountId)) goToLink(state.activeAccountId, link)
  else { pendingLink.value = { link, accounts: candidates }; open('link') }
}
function goToLink(accountId: string, link: Permalink) {
  const target = state.rooms.find(item => item.accountId === accountId && item.id === link.target)
  if (!target) { notify('That room is not in this account'); return }
  if (accountId !== state.activeAccountId) switchAccount(accountId)
  reply.value = undefined; edit.value = undefined; endOfHistory.value = false; state.mobileRoom = true
  void selectRoom(target)
  if (link.kind === 'event' && link.eventId) state.jumpToEvent = link.eventId
  modal.value = ''; pendingLink.value = undefined
}
function chooseFilter(value: string) { state.filter = value; state.spaceId = ''; state.mobileRoom = false }
function chooseSpace(value: Room) { state.spaceId = state.spaceId === value.id ? '' : value.id; state.filter = 'all'; state.mobileRoom = false }
function beginReply(value: Message) { reply.value = value; edit.value = undefined; focusComposer() }
function beginEdit(value: Message) { edit.value = value; reply.value = undefined; draft.value = value.body; focusComposer() }
function focusComposer() { void nextTick(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()) }
async function submitMessage() {
  const text = draft.value
  if (await send(text, reply.value, edit.value)) {
    if (draft.value === text) draft.value = ''
    reply.value = undefined; edit.value = undefined; mention.value = undefined
    await scrollToEnd()
  }
}
const mention = ref<{ query: string; start: number; index: number } | undefined>()
const mentionMatches = computed(() => {
  if (!mention.value) return []
  const query = mention.value.query.trim().toLowerCase()
  const people = state.members
    .filter(item => !ignoredUsersState.value.includes(item.id)
      && (item.name.toLowerCase().includes(query) || item.id.toLowerCase().includes(query)))
    .slice(0, 6)
  const everyone = query === '' || 'room'.includes(query) || 'everyone'.includes(query)
    ? [{ id: '@room', name: 'Everyone', role: 'Notify the whole room' }]
    : []
  return [...everyone, ...people]
})
function composerInput() { typingNotice(); void nextTick(updateMention) }
function updateMention() {
  const cursor = composerBox()?.selectionStart ?? -1
  if (cursor < 0) { mention.value = undefined; return }
  const match = draft.value.slice(0, cursor).match(/(^|[\s(])@([\w .:+-]*)$/)
  if (!match) { mention.value = undefined; return }
  mention.value = { query: match[2], start: cursor - match[2].length - 1, index: 0 }
}
function insertMention(target: { id: string; name: string }) {
  const active = mention.value
  if (!active) return
  const cursor = composerBox()?.selectionStart ?? draft.value.length
  const pill = target.id === '@room' ? '@room ' : `[${target.name}](https://matrix.to/#/${target.id}) `
  draft.value = draft.value.slice(0, active.start) + pill + draft.value.slice(cursor)
  mention.value = undefined
  void nextTick(() => {
    const element = composerBox()
    if (element) { const position = active.start + pill.length; element.setSelectionRange(position, position); element.focus() }
  })
}
function keydown(event: KeyboardEvent) {
  if (mention.value && mentionMatches.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = mentionMatches.value.length
      mention.value.index = (mention.value.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insertMention(mentionMatches.value[mention.value.index]); return }
    if (event.key === 'Escape') { event.preventDefault(); mention.value = undefined; return }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submitMessage() }
}
function shortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); open('search') }
  if (event.key === 'Escape') { if (modal.value === 'verify') void closeVerification(); else if (modal.value) modal.value = ''; else if (reply.value || edit.value) { reply.value = undefined; edit.value = undefined } else if (state.details) state.details = false; else state.mobileRoom = false }
}
async function scrollToEnd() { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight }
function showEmoji(value?: Message) { emojiTarget.value = value; open('emoji') }
async function pickEmoji(value: string) { if (emojiTarget.value) await react(emojiTarget.value, value); else { draft.value += value; focusComposer() }; modal.value = '' }
function dateLabel(time: number) { const date = new Date(time); return date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) }
function showDate(index: number) { const list = timelineMessages.value; return index === 0 || new Date(list[index].timestamp).toDateString() !== new Date(list[index - 1].timestamp).toDateString() }
function previewTime(timestamp: number) { return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' }
let oidcPopup: Window | null = null
let oidcFlow = ''
let oidcKind: 'oidc' | 'sso' = 'oidc'
function oidcRedirectUri() {
  // The native shell cannot receive an https callback: the provider returns
  // to the registered fernmatrix:// scheme, which the shell forwards into
  // the webview (#29).
  if (isTauri()) return 'fernmatrix://oidc-callback'
  return new URL('oidc-callback.html', location.href).href
}
async function startSso() {
  if (isDemo.value) { notify('Connect an account to use SSO'); return }
  // Starting over abandons any previous pending request; nothing was saved.
  if (oidcFlow) {
    oidcPopup?.close(); oidcPopup = null
    await action(() => (oidcKind === 'sso' ? engine.cancelSsoLogin(oidcFlow) : engine.cancelOidcLogin(oidcFlow)))
    oidcFlow = ''
  }
  modalBusy.value = true
  try {
    const methods = await action(() => engine.loginMethods(form.value.server))
    if (!methods) return
    // Prefer modern OIDC; fall back to legacy SSO where that is all the
    // homeserver offers. Either way nothing is saved until approval lands.
    const starter = methods.oidc
      ? { kind: 'oidc' as const, run: (uri: string) => engine.startOidcLogin(form.value.server, uri) }
      : methods.sso
        ? { kind: 'sso' as const, run: (uri: string) => engine.startSsoLogin(form.value.server, uri) }
        : undefined
    if (!starter) { state.error = 'This homeserver does not advertise SSO or modern login.'; return }
    const started = await action(() => starter.run(oidcRedirectUri()))
    if (!started) return
    oidcKind = starter.kind
    oidcFlow = started.flowId
    if (isTauri()) {
      // No popup in the shell: the system browser carries the login and the
      // provider returns through the fernmatrix:// deep link.
      await openExternal(started.url)
    } else {
      oidcPopup = window.open(started.url, 'fern-sso', 'width=480,height=640')
      if (!oidcPopup) {
        state.error = 'Allow popups to continue with SSO.'
        await action(() => (oidcKind === 'sso' ? engine.cancelSsoLogin(oidcFlow) : engine.cancelOidcLogin(oidcFlow)))
        oidcFlow = ''
        return
      }
    }
    modal.value = ''
  } finally { modalBusy.value = false }
}
function onOidcMessage(event: MessageEvent) {
  // The callback page shares this origin; anything else (or a popup that is
  // not the one this flow opened) cannot complete a sign-in.
  if (event.origin !== location.origin || event.source !== oidcPopup) return
  const url = (event.data as { type?: unknown; url?: unknown } | null)?.type === 'fern-oidc-callback'
    && typeof (event.data as { url?: unknown }).url === 'string'
    ? (event.data as { url: string }).url : undefined
  if (!url) return
  completeOidcFromUrl(url)
}
function completeOidcFromUrl(url: string) {
  // A URL without a pending request completes nothing: the engine rejects
  // unknown flows and mismatched redirect targets, so a foreign deep link
  // can neither sign in nor confuse a request.
  if (!oidcFlow) return
  const flowId = oidcFlow; oidcFlow = ''
  const kind = oidcKind
  oidcPopup?.close(); oidcPopup = null
  void (async () => {
    const id = await action(() => (kind === 'sso' ? engine.finishSsoLogin(flowId, url) : engine.finishOidcLogin(flowId, url)))
    if (id) { switchAccount(id); retireDemo(); notify('Account connected') }
  })()
}
async function modalSubmit() {
  if (modalBusy.value) return
  modalBusy.value = true
  try {
    let success: unknown
    if (modal.value === 'login') {
      if (loginMode.value === 'register') {
        const created = await registerAccount(form.value.server, form.value.username, form.value.password)
        // SSO-only servers provision through the provider: route there now.
        if (created === 'sso') { modalBusy.value = false; await startSso(); return }
        success = created === 'ok'
      } else success = await signIn(form.value.server, form.value.username, form.value.password)
      form.value.password = ''
    }
    if (modal.value === 'create' || modal.value === 'dm') success = await createRoom(form.value.name || form.value.invite, form.value.topic, modal.value === 'dm' ? form.value.invite : undefined)
    if (modal.value === 'createspace') success = await createSpace(form.value.name, form.value.topic)
    if (modal.value === 'join') success = await joinRoom(form.value.alias)
    if (modal.value === 'poll') {
      const answers = form.value.answers.split('\n').map(value => value.trim()).filter(Boolean)
      if (answers.length < 2 || answers.length > 20) { state.error = 'Add between 2 and 20 answers, one per line.'; return }
      success = await createPoll(form.value.question, answers, form.value.undisclosed ? 'undisclosed' : 'disclosed')
    }
    if (modal.value === 'invite') success = await action(async () => { if (!isDemo.value) await engine.invite(state.activeAccountId, state.activeRoomId, form.value.invite); notify(isDemo.value ? 'Invitation recorded in the local demo' : 'Invitation sent'); return true })
    if (success) { modal.value = ''; form.value.name = ''; form.value.topic = ''; form.value.invite = ''; form.value.alias = ''; form.value.question = ''; form.value.answers = ''; form.value.undisclosed = false }
  } finally { modalBusy.value = false }
}
function loadAccountSections() {
  form.value.deactivateAck = false
  void loadSecurity()
  void loadEmails()
  void loadDevices()
  void prepareDeactivate()
}
const updateNote = ref('')
const updateVersion = ref('')
const updateBusy = ref(false)
async function submitCheckUpdate() {
  updateBusy.value = true; state.error = ''
  try {
    const found = await checkAppUpdate()
    if (found) { updateVersion.value = found.version; updateNote.value = t('updates.ready', { version: found.version }) }
    else updateNote.value = t('updates.uptodate')
  } catch (error) { state.error = error instanceof Error ? error.message : String(error) }
  finally { updateBusy.value = false }
}
async function submitInstallUpdate() {
  updateBusy.value = true; state.error = ''
  try {
    await installAppUpdate(stage => { updateNote.value = stage === 'downloading' ? t('updates.downloading') : t('updates.installing') })
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); updateBusy.value = false }
}
const pinUnlock = ref('')
const pinSetup = ref('')
const pinSetupConfirm = ref('')
const pinCurrent = ref('')
const pinNew = ref('')
const lockBusy = ref(false)
async function submitUnlock() {
  lockBusy.value = true
  try {
    if (await unlockApp(pinUnlock.value)) { pinUnlock.value = ''; pokeLock() }
    else state.error = t('lock.wrong')
  } finally { lockBusy.value = false }
}
async function submitSetupPin() {
  if (pinSetup.value !== pinSetupConfirm.value) { state.error = t('lock.mismatch'); return }
  lockBusy.value = true
  try { if (await setupAppPin(pinSetup.value)) { pinSetup.value = ''; pinSetupConfirm.value = ''; pokeLock() } }
  finally { lockBusy.value = false }
}
async function submitChangePin() {
  lockBusy.value = true
  try { if (await changeAppPin(pinCurrent.value, pinNew.value)) { pinCurrent.value = ''; pinNew.value = '' } }
  finally { lockBusy.value = false }
}
async function submitDisablePin() {
  lockBusy.value = true
  try { await disableAppPin(pinCurrent.value); pinCurrent.value = '' }
  finally { lockBusy.value = false }
}
// Auto-lock: pointer/key activity plus hidden tabs feed a 15s watchdog that
// locks after the configured idle minutes (0 means manual locking only).
let lastLockActivity = Date.now()
let lockWatch: ReturnType<typeof setInterval> | undefined
function pokeLock() { lastLockActivity = Date.now() }
function watchLockStop() { if (lockWatch) clearInterval(lockWatch); lockWatch = undefined }
function watchLock() {
  watchLockStop()
  lockWatch = setInterval(() => {
    if (!lockEnabled.value || appLocked.value || !lockTimeoutMin.value) return
    if (Date.now() - lastLockActivity >= lockTimeoutMin.value * 60_000) lockNow()
  }, 15_000)
}
async function submitPasswordChange() {
  if (!form.value.password || !form.value.newPassword) { state.error = 'Enter the current and a new password.'; return }
  modalBusy.value = true
  try {
    if (await changePassword(form.value.password, form.value.newPassword)) { form.value.password = ''; form.value.newPassword = '' }
  } finally { modalBusy.value = false }
}
async function submitAddEmail() {
  if (!form.value.email.trim()) { state.error = 'Enter an email address.'; return }
  modalBusy.value = true
  try {
    if (await addEmail(form.value.email.trim())) form.value.email = ''
  } finally { modalBusy.value = false }
}
async function submitConfirmEmail() {
  if (!form.value.emailCode.trim() || !form.value.accountPassword) { state.error = 'Enter the emailed code and the account password.'; return }
  modalBusy.value = true
  try {
    if (await confirmEmail(form.value.emailCode.trim(), form.value.accountPassword)) { form.value.emailCode = ''; form.value.accountPassword = '' }
  } finally { modalBusy.value = false }
}
async function submitRemoveEmail(address: string) {
  if (!form.value.accountPassword) { state.error = 'Enter the account password to remove an email address.'; return }
  modalBusy.value = true
  try {
    if (await removeEmail(address, form.value.accountPassword)) form.value.accountPassword = ''
  } finally { modalBusy.value = false }
}
async function submitSignOutOthers() {
  if (!form.value.accountPassword) { state.error = 'Enter the account password to sign out other sessions.'; return }
  modalBusy.value = true
  try {
    await signOutOthers(form.value.accountPassword)
    form.value.accountPassword = ''
  } finally { modalBusy.value = false }
}
async function submitDeactivate() {
  if (!form.value.deactivateAck) { state.error = 'Confirm that you understand deactivation is permanent.'; return }
  if (!form.value.accountPassword) { state.error = 'Enter the account password to deactivate.'; return }
  modalBusy.value = true
  try {
    if (await deactivateAccount(form.value.accountPassword, form.value.eraseData)) {
      form.value.accountPassword = ''; form.value.deactivateAck = false; modal.value = ''
    }
  } finally { modalBusy.value = false }
}
const roomForm = ref({ name: '', topic: '', history: 'shared', join: 'invite', removePicture: false, unbanId: '' })
const roomPowerDraft = ref('50')
const roomPictureInput = ref<HTMLInputElement>()
const roomConfirm = ref<{ what: 'kick' | 'ban'; id: string } | null>(null)
const spaceConfirm = ref<string | null>(null)
const spaceChildDraft = ref('')
const spaceCandidates = computed(() => !roomSettings.value ? [] as { label: string; value: string }[] : accountRooms.value
  .filter(value => value.membership === 'joined' && value.id !== roomSettings.value!.roomId
    && !roomSettings.value!.children.some(child => child.id === value.id))
  .map(value => ({ label: `${value.name}${value.space ? ' (space)' : ''}`, value: value.id })))
async function submitSpaceChild(remove: boolean, id: string) {
  if (modalBusy.value) return
  modalBusy.value = true
  try {
    if (remove) { if (await organizeSpaceChild(id, true)) spaceConfirm.value = null }
    else if (spaceChildDraft.value) { if (await organizeSpaceChild(spaceChildDraft.value, false)) spaceChildDraft.value = '' }
  } finally { modalBusy.value = false }
}
watch(roomSettings, value => {
  if (value && modal.value === 'roomsettings') {
    roomForm.value.name = value.name; roomForm.value.topic = value.topic
    roomForm.value.history = value.historyVisibility; roomForm.value.join = value.joinRule
    roomForm.value.removePicture = false; roomConfirm.value = null; spaceConfirm.value = null; spaceChildDraft.value = ''
  }
})
function roomPowerOf(id: string) { return roomSettings.value?.power?.users[id] ?? roomSettings.value?.power?.usersDefault ?? 0 }
async function submitRoomSettings() {
  if (modalBusy.value) return
  const file = roomPictureInput.value?.files?.[0]
  modalBusy.value = true
  try {
    if (await saveRoomSettings({ name: roomForm.value.name, topic: roomForm.value.topic,
      avatar: file ? { mime: file.type || 'image/png', data: await file.arrayBuffer() } : undefined,
      removeAvatar: roomForm.value.removePicture, historyVisibility: roomForm.value.history, joinRule: roomForm.value.join })) {
      if (roomPictureInput.value) roomPictureInput.value.value = ''
    }
  } finally { modalBusy.value = false }
}
async function submitModerate(what: 'kick' | 'ban' | 'unban', id: string) {
  if (modalBusy.value) return
  modalBusy.value = true
  try {
    if (await moderateMember(what, id)) roomConfirm.value = null
  } finally { modalBusy.value = false }
}
async function submitRoomNotify(mode: string) {
  if (modalBusy.value || !room.value) return
  modalBusy.value = true
  try { await setRoomNotifyMode(state.activeAccountId, room.value.id, mode as 'default' | 'all' | 'mentions' | 'mute') } finally { modalBusy.value = false }
}
async function submitPower(id: string) {
  if (modalBusy.value) return
  modalBusy.value = true
  try { await setMemberPower(id, Number(roomPowerDraft.value)) } finally { modalBusy.value = false }
}
async function loadSecurity() {
  if (isDemo.value) { security.value = { deviceId: 'LOCAL-DEMO', recovery: 'Demo only', verified: 'Not connected' }; return }
  security.value = undefined
  const result = await action(() => engine.security(state.activeAccountId))
  if (result) {
    security.value = result
    const id = state.activeAccountId
    void action(() => engine.listenForVerificationRequests(id, value => {
      if (state.activeAccountId !== id) return
      verificationAccount = id
      verification.value = value
      if (value.status === 'incoming') modal.value = 'verify'
    }))
  }
}
async function loadDirectory() {
  const generation = ++directoryGeneration
  directorySession?.stop(); directorySession = undefined
  directoryRooms.value = []; directoryEnd.value = false
  if (isDemo.value) {
    directoryRooms.value = accountRooms.value.filter(value => !value.space && !value.direct && value.name.toLowerCase().includes(directoryQuery.value.toLowerCase())).map(value => ({ id: value.id, name: value.name, topic: value.topic || 'A welcoming place to connect', members: value.members }))
    directoryEnd.value = true; return
  }
  modalBusy.value = true
  const result = await action(() => engine.searchDirectory(state.activeAccountId, directoryQuery.value, values => { if (generation === directoryGeneration) directoryRooms.value = values }))
  if (result) { if (generation !== directoryGeneration || modal.value !== 'explore') result.stop(); else { directorySession = result; directoryEnd.value = await result.atEnd() } }
  modalBusy.value = false
}
async function moreDirectory() { if (!directorySession) return; modalBusy.value = true; await action(async () => { await directorySession!.next(); directoryEnd.value = await directorySession!.atEnd() }); modalBusy.value = false }
async function joinDirectory(value: DirectoryRoom) {
  const existing = accountRooms.value.find(item => item.id === value.id)
  if (existing) { chooseRoom(existing); modal.value = ''; return }
  const id = await joinRoom(value.alias ?? value.id)
  if (id) modal.value = ''
}
async function knockDirectory(value: DirectoryRoom) {
  modalBusy.value = true
  await action(async () => {
    if (isDemo.value) { notify('Connect your Matrix account to knock'); return }
    await engine.knockRoom(state.activeAccountId, value.alias ?? value.id)
    notify('Knock sent — a moderator will review your request')
  })
  modalBusy.value = false
}
const knockConfirm = ref<string | null>(null)
async function submitKnock(userId: string, accept: boolean) {
  modalBusy.value = true
  await answerKnockRequest(userId, accept)
  knockConfirm.value = null
  modalBusy.value = false
}
async function updateProfile() {
  if (!profileName.value.trim()) return
  await action(async () => { if (isDemo.value) account.value!.name = profileName.value.trim(); else await engine.updateProfile(state.activeAccountId, profileName.value.trim()); notify('Display name updated') })
}
async function uploadAvatar() {
  const file = avatarInput.value?.files?.[0]
  if (!file) return
  await action(async () => {
    if (isDemo.value) { notify('Profile pictures need a connected account'); return }
    await engine.uploadAvatar(state.activeAccountId, file.type || 'image/png', await file.arrayBuffer())
    await refreshAvatar(state.activeAccountId, account.value!.userId)
    notify('Profile picture updated')
  })
  if (avatarInput.value) avatarInput.value.value = ''
}
function startCall() {
  callStatus.value = 'lobby'
  callError.value = ''
  modal.value = 'call'
}
function joinCall() {
  if (isDemo.value) { notify('Connect your Matrix account to start a call'); modal.value = ''; return }
  callStatus.value = 'joining'
  if (callIframe) void wireCall(callIframe)
}
async function wireCall(iframe: HTMLIFrameElement) {
  const accountId = state.activeAccountId
  const roomId = state.activeRoomId
  const generation = ++callGeneration
  const result = await action(() => engine.startCall(accountId, roomId, iframe, () => {
    stopCall?.(); stopCall = undefined
    if (generation === callGeneration && modal.value === 'call') callStatus.value = 'ended'
  }))
  if (!result) { callError.value = state.error; state.error = ''; callStatus.value = 'error'; return }
  if (generation !== callGeneration || modal.value !== 'call') { result(); return }
  callStatus.value = 'active'
  stopCall = result
}
function retryCall() {
  callStatus.value = 'joining'
  callError.value = ''
  if (callIframe) void wireCall(callIframe)
}
// Room widgets (#45): approval before first load, then the same guarded
// widget-driver bridge as calls. Approvals persist per account, widget and
// URL; changing the widget address re-asks.
const activeWidget = ref<WidgetInfo | null>(null)
const widgetStatus = ref<'approval' | 'loading' | 'active' | 'error' | 'ended'>('approval')
const widgetError = ref('')
let stopWidget: (() => void) | undefined
let widgetGeneration = 0
let widgetIframe: HTMLIFrameElement | undefined
function openWidget(widget: WidgetInfo) {
  activeWidget.value = widget
  widgetError.value = ''
  widgetStatus.value = !isDemo.value && isWidgetApproved(state.activeAccountId, widget) ? 'loading' : 'approval'
  modal.value = 'widget'
}
function approveWidgetOpen() {
  const widget = activeWidget.value
  if (!widget) return
  if (isDemo.value) { notify('Connect your Matrix account to open widgets'); modal.value = ''; return }
  approveWidget(state.activeAccountId, widget)
  widgetStatus.value = 'loading'
  if (widgetIframe) void wireWidget(widgetIframe)
}
function catchWidgetIframe(iframe: HTMLIFrameElement) {
  widgetIframe = iframe
  if (widgetStatus.value === 'loading') void wireWidget(iframe)
}
async function wireWidget(iframe: HTMLIFrameElement) {
  const widget = activeWidget.value
  if (!widget) return
  const accountId = state.activeAccountId
  const roomId = state.activeRoomId
  const generation = ++widgetGeneration
  const result = await action(() => engine.startWidget(accountId, roomId, widget, iframe, () => {
    stopWidget?.(); stopWidget = undefined
    if (generation === widgetGeneration && modal.value === 'widget') widgetStatus.value = 'ended'
  }))
  if (!result) { widgetError.value = state.error; state.error = ''; widgetStatus.value = 'error'; return }
  if (generation !== widgetGeneration || modal.value !== 'widget') { result(); return }
  widgetStatus.value = 'active'
  stopWidget = result
}
function retryWidget() {
  widgetStatus.value = 'loading'
  widgetError.value = ''
  if (widgetIframe) void wireWidget(widgetIframe)
}
// Edge-swipe back to the room list (#44): observe only, on the phone layout
// while a conversation covers the list. Never preventDefault, so scrolling
// and the browser's own gestures keep working.
let edgeStart: { x: number; y: number; id: number } | undefined
// Follow-finger state for the edge-back dismiss animation: the conversation
// tracks the drag (damped past 120px), springs back on cancel, and slides
// away before the list swaps in on commit — the Telegram dismiss pattern.
const edgeX = ref(0)
const edgeDrag = ref(false)
const edgeLeaving = ref(false)
function phoneLayout() { return window.matchMedia('(max-width: 760px)').matches }
function edgeDown(event: PointerEvent) {
  if (!event.isPrimary || !state.mobileRoom || !phoneLayout() || edgeLeaving.value) return
  if (event.clientX > 24) return
  if ((event.target as HTMLElement).closest?.('input,textarea')) return
  edgeStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
  edgeX.value = 0
  edgeDrag.value = true
}
function edgeMove(event: PointerEvent) {
  if (!edgeStart || event.pointerId !== edgeStart.id) return
  const dx = Math.max(0, event.clientX - edgeStart.x)
  edgeX.value = dx <= 120 ? dx : 120 + (dx - 120) * 0.35
}
function edgeEnd(event: PointerEvent, cancel = false) {
  if (!edgeStart || event.pointerId !== edgeStart.id) return
  const dx = event.clientX - edgeStart.x
  const dy = event.clientY - edgeStart.y
  const startX = edgeStart.x
  edgeStart = undefined
  edgeDrag.value = false
  if (!cancel && edgeBackIntent(startX, dx, dy, true)) {
    edgeX.value = 0
    edgeLeaving.value = true
    setTimeout(() => { edgeLeaving.value = false; state.mobileRoom = false }, 180)
  } else edgeX.value = 0
}
async function enableRecovery() {
  if (isDemo.value) { notify('Connect an account to set up key recovery'); return }
  modalBusy.value = true
  const result = await action(() => engine.enableRecovery(state.activeAccountId, status => recoveryProgress.value = status))
  if (result) { recoveryOutput.value = result; await loadSecurity() }
  modalBusy.value = false
}
async function startVerification() {
  if (isDemo.value) { notify('Connect an account to verify this device'); return }
  verificationAccount = state.activeAccountId
  verification.value = { status: 'waiting' }
  open('verify')
  await action(() => engine.startVerification(verificationAccount, value => verification.value = value))
}
async function acceptIncomingVerification() {
  verification.value = { ...verification.value, status: 'accepted' }
  await action(() => engine.acceptVerificationRequest(verificationAccount))
}
async function approveVerification(matches: boolean) {
  await action(async () => {
    await engine.finishVerification(verificationAccount, matches)
    if (!matches) verification.value = { ...verification.value, status: 'mismatch' }
  })
}
async function closeVerification() {
  const shouldCancel = !['verified', 'failed', 'canceled', 'mismatch'].includes(verification.value.status)
  modal.value = ''
  if (shouldCancel && verificationAccount) await action(() => engine.cancelVerification(verificationAccount))
}
async function resetRecovery() {
  if (isDemo.value) { notify('Connect an account to reset key recovery'); return }
  modalBusy.value = true
  const result = await action(() => engine.resetRecovery(state.activeAccountId))
  if (result) { recoveryOutput.value = result; confirmReset.value = false; await loadSecurity(); notify('Recovery key replaced — save the new key') }
  modalBusy.value = false
}
async function saveRecoveryKey() {
  const url = URL.createObjectURL(new Blob([`Fern Matrix recovery key\nAccount: ${account.value?.userId}\n\n${recoveryOutput.value}\n`], { type: 'text/plain' }))
  const link = document.createElement('a'); link.href = url; link.download = 'matrix-recovery-key.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function recoverKeys() {
  if (isDemo.value) { notify('Connect your Matrix account to restore encrypted history'); return }
  modalBusy.value = true
  await action(async () => { await engine.recover(state.activeAccountId, form.value.recoveryKey.trim()); form.value.recoveryKey = ''; await loadSecurity(); notify('Recovery key restored') })
  modalBusy.value = false
}

async function loadEarlier() {
  if (isDemo.value) { endOfHistory.value = true; return }
  const height = timeline.value?.scrollHeight ?? 0
  modalBusy.value = true
  const end = await action(() => engine.paginate(state.activeAccountId, state.activeRoomId))
  if (end !== undefined) endOfHistory.value = end
  await nextTick(); if (timeline.value) timeline.value.scrollTop += timeline.value.scrollHeight - height
  modalBusy.value = false
}
function attach(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void upload(file); (event.target as HTMLInputElement).value = '' }
// Voice recording state for issue #17. The recorder lives here (not in the
// store) because it owns microphone hardware; only finished clips cross into
// the store for encrypted sending.
const voiceSupported = recordingSupported()
const voiceStatus = ref<'idle' | 'recording' | 'paused' | 'preview'>('idle')
const voiceElapsed = ref(0)
const voicePreview = ref<{ clip: VoiceClip; url: string }>()
const voiceError = ref('')
const voiceInterrupted = ref(false)
let voiceRecorder: VoiceRecorder | undefined
function resetVoicePreview() { if (voicePreview.value) URL.revokeObjectURL(voicePreview.value.url); voicePreview.value = undefined }
async function startVoice() {
  if (voiceStatus.value === 'recording' || voiceStatus.value === 'paused') return
  resetVoicePreview(); voiceError.value = ''; voiceInterrupted.value = false
  const recorder = new VoiceRecorder({ onTick: elapsed => { voiceElapsed.value = elapsed }, onInterrupted: () => { voiceInterrupted.value = true } })
  voiceRecorder = recorder
  try {
    await recorder.start()
    voiceElapsed.value = 0
    voiceStatus.value = 'recording'
  } catch (error) { voiceRecorder = undefined; voiceError.value = error instanceof Error ? error.message : voiceFailureMessage('unavailable') }
}
function pauseVoice() { voiceRecorder?.pause(); voiceStatus.value = 'paused' }
function resumeVoice() { voiceRecorder?.resume(); voiceStatus.value = 'recording' }
function cancelVoice() { voiceRecorder?.cancel(); voiceRecorder = undefined; voiceStatus.value = 'idle'; voiceElapsed.value = 0 }
async function stopVoice() {
  const recorder = voiceRecorder
  if (!recorder) return
  try {
    const clip = await recorder.stop()
    voiceInterrupted.value = clip.interrupted
    voicePreview.value = { clip, url: URL.createObjectURL(clip.blob) }
    voiceStatus.value = 'preview'
  } catch (error) { voiceError.value = error instanceof Error ? error.message : voiceFailureMessage('unavailable'); voiceStatus.value = 'idle' }
  finally { voiceRecorder = undefined }
}
function discardVoice() { resetVoicePreview(); voiceStatus.value = 'idle'; voiceElapsed.value = 0; voiceInterrupted.value = false }
async function sendVoicePreview() {
  const preview = voicePreview.value
  if (!preview) return
  if (await sendVoice(preview.clip)) { discardVoice(); await scrollToEnd() }
}
// One-time location sharing for issue #18. A single fix is requested only
// from the explicit share action, shown for review, and sent only on
// confirmation — there is no background tracking anywhere in this flow.
const locationSupported = typeof navigator !== 'undefined' && !!navigator.geolocation?.getCurrentPosition
const locationStatus = ref<'idle' | 'locating' | 'preview'>('idle')
const locationFix = ref<Coordinates>()
const locationDescription = ref('')
const locationError = ref('')
let locationRequest = 0
async function beginLocationShare() {
  if (locationStatus.value !== 'idle' || state.busy) return
  locationError.value = ''; locationDescription.value = ''; locationFix.value = undefined
  locationStatus.value = 'locating'
  const request = ++locationRequest
  try {
    const fix = await requestCurrentPosition()
    if (request !== locationRequest) return
    locationFix.value = fix
    locationStatus.value = 'preview'
  } catch (error) {
    if (request !== locationRequest) return
    locationError.value = error instanceof Error ? error.message : 'Your location could not be determined.'
    locationStatus.value = 'idle'
  }
}
function cancelLocationShare() { locationRequest++; locationStatus.value = 'idle'; locationFix.value = undefined; locationError.value = '' }
async function sendLocationShare() {
  const fix = locationFix.value
  if (!fix) return
  if (await sendLocation({ ...fix, description: locationDescription.value })) { cancelLocationShare(); await scrollToEnd() }
}
function dropFile(event: DragEvent) { event.preventDefault(); const file = event.dataTransfer?.files[0]; if (file) void upload(file) }
watch(() => [state.activeAccountId, state.activeRoomId], (_value, previous) => {
  if (previous) { const key = `fern.draft.${previous[0]}/${previous[1]}`; if (draft.value) localStorage.setItem(key, draft.value); else localStorage.removeItem(key) }
  draft.value = localStorage.getItem(`fern.draft.${state.activeAccountId}/${state.activeRoomId}`) ?? ''
  reply.value = undefined; edit.value = undefined; mention.value = undefined; endOfHistory.value = false; renderWindow.value = 150
  cancelVoice(); discardVoice(); cancelLocationShare(); clearFocus()
  if (detailsTab.value === 'pins') void loadPins()
  void scrollToEnd()
})
watch(draft, value => { const key = `fern.draft.${state.activeAccountId}/${state.activeRoomId}`; if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) })
watch(() => messages.value.at(-1)?.id, (id, previous) => {
  const nearEnd = !timeline.value || timeline.value.scrollHeight - timeline.value.scrollTop - timeline.value.clientHeight < 180
  if (nearEnd || !previous || messages.value.at(-1)?.own) void scrollToEnd()
  const latest = messages.value.at(-1)
  if (latest && id !== previous && room.value) maybeNotify(state.activeAccountId, room.value, latest)
})
watch(() => [state.jumpToEvent, renderedMessages.value.length], async () => {
  const id = state.jumpToEvent
  if (!id || !timeline.value) return
  // Expand the render window to cover the target first: explicit navigation
  // wins over windowing, so event focus also works for older messages.
  const position = visibleMessages.value.findIndex(message => message.id === id)
  if (position >= 0) renderWindow.value = Math.max(renderWindow.value, visibleMessages.value.length - position + 20)
  await nextTick()
  let target = timeline.value.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
  let rounds = 0
  while (!target && !endOfHistory.value && !isDemo.value && rounds < 5) {
    await loadEarlier()
    await nextTick()
    target = timeline.value.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    rounds += 1
  }
  const found = target
  if (found) {
    found.scrollIntoView({ block: 'center' })
    found.classList.add('jump-flash')
    setTimeout(() => found.classList.remove('jump-flash'), 2400)
  } else notify('The linked message is not loaded in this room')
  state.jumpToEvent = ''
})
watch(modal, (_value, previous) => {
  if (previous === 'explore') { ++directoryGeneration; directorySession?.stop(); directorySession = undefined }
  if (previous === 'call') { ++callGeneration; stopCall?.(); stopCall = undefined; callIframe = undefined }
  if (previous === 'widget') { ++widgetGeneration; stopWidget?.(); stopWidget = undefined; widgetIframe = undefined; activeWidget.value = null }
  if (previous === 'settings') { recoveryOutput.value = ''; form.value.recoveryKey = ''; confirmReset.value = false }
})
watch(compactMessages, value => localStorage.setItem('fern.compact', String(value)))
let stopDeepLink: (() => void) | undefined
onMounted(() => { document.addEventListener('keydown', shortcut); document.addEventListener('pointerdown', pokeLock); document.addEventListener('keydown', pokeLock); watchLock(); window.addEventListener('message', onOidcMessage); window.visualViewport?.addEventListener('resize', viewportReveal); void onDeepLink(completeOidcFromUrl).then(stop => { stopDeepLink = stop ?? undefined }); void initialize(); void scrollToEnd() })
onUnmounted(() => { document.removeEventListener('keydown', shortcut); document.removeEventListener('pointerdown', pokeLock); document.removeEventListener('keydown', pokeLock); watchLockStop(); window.removeEventListener('message', onOidcMessage); window.visualViewport?.removeEventListener('resize', viewportReveal); stopDeepLink?.(); stopCall?.(); directorySession?.stop(); if (verificationAccount) void engine.cancelVerification(verificationAccount); void engine.dispose() })
</script>

<template>
<FrappeUIProvider>
  <div v-if="appLocked" class="lock-screen" role="dialog" aria-modal="true" :aria-label="t('lock.dialog')"><div class="lock-card"><Leaf :size="34"/><h1>{{ t('lock.title') }}</h1><p>{{ t('lock.prompt') }}</p><form @submit.prevent="submitUnlock"><FormControl v-model="pinUnlock" type="password" :label="t('lock.pin')" placeholder="••••" autocomplete="current-password" :aria-label="t('lock.pinEntry')"/><ErrorMessage v-if="state.error" :message="state.error"/><Button variant="solid" theme="green" type="submit" :loading="lockBusy">{{ t('lock.unlock') }}</Button></form></div></div>
  <div class="app-shell" :class="{ 'mobile-conversation': state.mobileRoom, 'with-details': state.details }">
    <template v-if="!state.accounts.length">
      <div class="welcome-gate"><span class="welcome-logo"><Leaf :size="44"/></span><span class="eyebrow">FERN · MATRIX</span><h1>{{ t('gate.title') }}</h1><p>{{ t('gate.subtitle') }}</p><div class="gate-actions"><Button variant="solid" theme="green" @click="open('login')">{{ t('nav.connectAccount') }} <ArrowUpRight :size="15"/></Button><Button variant="outline" @click="loginMode = 'register'; open('login')">{{ t('login.createAccount') }}</Button><Button variant="ghost" @click="exploreDemo">{{ t('gate.explore') }}</Button></div></div>
    </template>
    <template v-else>
    <nav class="account-rail" :aria-label="t('nav.accountsSpaces')">
      <Button variant="ghost" class="fern-logo" :aria-label="t('nav.fernHome')" @click="chooseFilter('all')"><Leaf :size="25"/></Button>
      <div class="rail-separator"/>
      <Button variant="ghost" class="rail-item" :class="{ active: !state.spaceId }" :aria-label="t('nav.allConversations')" @click="chooseFilter('all')"><Home :size="20"/></Button>
      <Tooltip v-for="space in spaces" :key="space.id" :text="space.name"><Button variant="ghost" class="rail-item space-item" :class="{ active: state.spaceId === space.id }" :aria-label="space.name" @click="chooseSpace(space)"><span>{{ space.name.split(' ').map(v => v[0]).slice(0, 2).join('') }}</span></Button></Tooltip>
      <Tooltip :text="t('nav.joinRoom')"><Button variant="ghost" class="rail-item" :aria-label="t('nav.joinRoom')" @click="open('join')"><Plus :size="20"/></Button></Tooltip>
      <div class="rail-bottom"><Tooltip :text="t('nav.helpShortcuts')"><Button variant="ghost" class="rail-item" :aria-label="t('nav.help')" @click="open('help')"><CircleHelp :size="20"/></Button></Tooltip><Tooltip v-for="value in state.accounts" :key="value.id" :text="value.userId"><Button variant="ghost" class="rail-account" :class="{ active: state.activeAccountId === value.id }" :aria-label="t('nav.switchTo', { name: value.name }) + (accountUnread(value.id) ? t('nav.unreadSuffix', { count: accountUnread(value.id) }) : '')" @click="switchAccount(value.id)"><UserAvatar :name="value.name" :size="34"/><span v-if="value.connection === 'online'" class="account-online"/></Button></Tooltip><Tooltip :text="t('nav.addAccount')"><Button variant="ghost" class="rail-item add-account" :aria-label="t('nav.addAccount')" @click="open('login')"><Plus :size="18"/></Button></Tooltip></div>
    </nav>

    <aside class="room-sidebar" :aria-label="t('nav.conversations')">
      <div class="workspace-header"><div class="workspace-title"><span><strong>{{ state.spaceId ? spaces.find(v => v.id === state.spaceId)?.name : t('nav.yourConversations') }}</strong><small>{{ state.inboxAll && state.accounts.length > 1 ? t('nav.inboxAll') : account?.userId }}</small></span></div><Dropdown :options="[{ label: t('dialogs.create'), icon: Hash, onClick: () => open('create') }, { label: t('dialogs.createspace'), icon: LayoutGrid, onClick: () => open('createspace') }, { label: t('nav.messageSomeone'), icon: MessageCircle, onClick: () => open('dm') }, { label: t('nav.joinRoom'), icon: Globe, onClick: () => open('join') }, { label: t('dialogs.explore'), icon: Search, onClick: () => open('explore') }]"><Button variant="ghost" class="new-conversation" :aria-label="t('nav.newConversation')"><Plus :size="20"/></Button></Dropdown></div>
      <div class="sidebar-search"><Search :size="16"/><FormControl v-model="state.roomQuery" type="search" :aria-label="t('nav.searchConversations')" :placeholder="t('dialogs.search')" variant="subtle"/><kbd>⌘ K</kbd></div>
      <div class="filter-tabs"><Button v-for="tab in [{ value: 'all', label: t('nav.filterAll') }, { value: 'unread', label: t('nav.filterUnread') }, { value: 'people', label: t('nav.filterPeople') }]" :key="tab.value" variant="ghost" :class="{ selected: state.filter === tab.value }" :aria-current="state.filter === tab.value ? 'true' : undefined" @click="chooseFilter(tab.value)">{{ tab.label }}<span v-if="tab.value === 'unread' && totalUnread" class="filter-count">{{ totalUnread }}</span></Button><Dropdown :options="[{ label: t('nav.sectionFavorites'), icon: Star, onClick: () => chooseFilter('favorites') }, { label: t('nav.sectionInvites'), icon: Inbox, onClick: () => chooseFilter('invites') }]"><Button variant="ghost" :aria-label="t('nav.moreFilters')"><ListFilter :size="15"/></Button></Dropdown><Button v-if="state.accounts.length > 1" variant="ghost" class="inbox-toggle" :class="{ selected: state.inboxAll }" :aria-pressed="state.inboxAll ? 'true' : 'false'" @click="toggleInbox">{{ t('nav.inboxAll') }}</Button></div>
      <div class="room-list">
        <template v-for="section in [{ name: t('nav.sectionFavorites'), icon: Star, items: favorites }, { name: t('nav.sectionRooms'), icon: Hash, items: channels }, { name: t('nav.sectionDMs'), icon: MessageCircle, items: people }, { name: t('nav.sectionInvites'), icon: Inbox, items: invites }]" :key="section.name">
          <div v-if="section.items.length" class="section-label"><component :is="section.icon" :size="12"/><span>{{ section.name }}</span><span class="section-count">{{ section.items.length }}</span></div>
          <Button v-for="value in section.items" :key="`${value.accountId}/${value.id}`" variant="ghost" class="room-item" :class="{ selected: state.activeRoomId === value.id, unread: value.unread }" @click="chooseRoom(value)" @pointerdown="roomHoldDown($event, value)" @pointermove="roomHoldMove" @pointerup="roomHoldUp" @pointercancel="roomHoldUp" @contextmenu.prevent="peekRoom(value)">
            <UserAvatar v-if="value.direct" :name="value.name" :size="36"/><span v-else class="room-icon"><Hash :size="19"/><span v-if="value.encrypted" class="room-lock"><LockKeyhole :size="9"/></span></span>
            <span class="room-item-text"><strong>{{ value.name }}</strong><small>{{ value.preview || t('dialogs.dm') }}<span v-if="state.inboxAll && state.accounts.length > 1"> · {{ accountName(value.accountId) }}</span></small></span><span class="room-item-meta"><time>{{ previewTime(value.timestamp) }}</time><Badge v-if="value.unread" size="sm" :theme="value.mentions ? 'red' : 'green'" :label="value.mentions ? '@' : String(value.unread)"/></span>
          </Button>
        </template>
        <div v-if="!filteredRooms.length" class="sidebar-empty"><Search :size="24"/><strong>{{ t('nav.noConversations') }}</strong><span>{{ t('nav.tryAnotherFilter') }}</span><Button variant="outline" @click="open('create')">{{ t('dialogs.create') }}</Button></div>
      </div>
      <div v-if="isDemo" class="demo-card"><span class="demo-icon"><Sparkles :size="17"/></span><div><strong>{{ t('timeline.lookAround') }}</strong><p>{{ t('nav.demoExploring') }}</p><Button variant="ghost" class="connect-account" @click="open('login')">{{ t('nav.connectAccount') }} <ArrowUpRight :size="13"/></Button></div></div>
      <div class="sidebar-footer"><Dropdown :options="accountOptions" side="top"><Button variant="ghost" class="profile-trigger"><UserAvatar :name="account?.name ?? t('nav.guest')" :size="30" :image="account ? avatarUrl(account.id, account.userId) : undefined"/><span><strong>{{ account?.name }}</strong><small><span class="status-dot" :class="account?.connection"/>{{ isDemo ? t('nav.localDemo') : account?.connection }}</small></span></Button></Dropdown><Button variant="ghost" :aria-label="t('nav.openSettings')" @click="open('settings')"><Settings :size="18"/></Button></div>
    </aside>

    <main class="conversation" :class="{ 'edge-drag': edgeDrag, 'edge-leave': edgeLeaving }" :style="edgeX && !edgeLeaving ? { transform: `translateX(${edgeX}px)` } : undefined" @dragover.prevent @drop="dropFile" @pointerdown="edgeDown" @pointermove="edgeMove" @pointerup="edgeEnd($event)" @pointercancel="edgeEnd($event, true)">
      <template v-if="room">
        <header class="conversation-header"><Button variant="ghost" class="mobile-back" :aria-label="t('nav.backToConversations')" @click="state.mobileRoom = false"><ArrowLeft :size="22"/></Button><span v-if="!room.direct" class="header-room-icon"><Hash :size="25"/></span><UserAvatar v-else :name="room.name" :size="36"/><div class="header-title"><h1>{{ room.name }}<LockKeyhole v-if="room.encrypted" :size="13"/></h1><p>{{ room.topic || (room.direct ? t('nav.topicDirect') : t('nav.topicRoom')) }}</p></div><div class="header-actions"><Button variant="ghost" :aria-label="t('nav.startCall')" @click="startCall"><Video :size="19"/></Button><Button variant="ghost" :aria-label="t('nav.searchMessages')" :class="{ 'action-active': searchOpen }" @click="searchOpen = !searchOpen"><Search :size="19"/></Button><Button variant="ghost" :aria-label="t('nav.roomMembers')" @click="state.details = true; detailsTab = 'members'"><Users :size="19"/><span class="member-count">{{ room.members }}</span></Button><span class="action-divider"/><Button variant="ghost" :aria-label="t('nav.roomInfo')" :class="{ 'action-active': state.details }" @click="state.details = !state.details"><Info :size="19"/></Button><Dropdown :options="roomOptions" align="end"><Button variant="ghost" :aria-label="t('nav.roomActions')"><MoreHorizontal :size="20"/></Button></Dropdown></div></header><div v-if="room?.successor" class="upgrade-banner"><span>{{ t('timeline.upgradedNotice') }}</span><Button variant="outline" @click="goToSuccessor()">{{ t('timeline.continueReplacement') }}</Button></div>
        <div v-if="searchOpen" class="message-search"><Search :size="16"/><FormControl v-model="state.messageQuery" type="search" :placeholder="t('nav.searchLoaded')" :aria-label="t('nav.searchMessages')"/><div class="search-scope" role="group" :aria-label="t('nav.searchScope')"><Button variant="ghost" :class="{ selected: searchScope === 'room' }" @click="searchScope = 'room'">{{ t('nav.thisRoom') }}</Button><Button variant="ghost" :class="{ selected: searchScope === 'account' }" @click="searchScope = 'account'">{{ t('nav.allRooms') }}</Button></div><span>{{ t('nav.resultsCount', { count: searchScope === 'account' ? accountSearchResults.length : visibleMessages.length }) }}</span><Button variant="ghost" :aria-label="t('nav.closeSearch')" @click="searchOpen = false; state.messageQuery = ''"><X :size="16"/></Button></div><div v-if="searchOpen && searchScope === 'account' && state.messageQuery.trim()" class="search-results" role="listbox" :aria-label="t('nav.matchingAcross')"><p class="form-note">{{ t('nav.loadedOnly') }}</p><Button v-for="hit in accountSearchResults" :key="hit.message.id" variant="ghost" class="search-hit" role="option" :aria-label="t('nav.jumpToInRoom', { room: hit.roomName })" @click="jumpToHit(hit)"><span><strong>{{ hit.roomName }}</strong><small>{{ hit.message.name }} · {{ hit.message.body.slice(0, 90) }}</small></span></Button><p v-if="!accountSearchResults.length" class="form-note">{{ t('nav.noMatches') }}</p></div>
        <div v-if="state.error && !modal" class="error-banner" role="alert"><Info :size="16"/><span>{{ state.error }}</span><Button variant="ghost" :aria-label="t('nav.dismissError')" @click="state.error = ''"><X :size="15"/></Button></div>
        <div v-if="room.membership === 'invited'" class="invite-view"><span class="invite-illustration"><Inbox :size="35"/></span><h2>{{ t('timeline.inviteTitle', { name: room.name }) }}</h2><p>{{ t('timeline.inviteSubtitle', { members: room.members }) }}</p><div><Button variant="solid" theme="green" @click="acceptInvite(room)">{{ t('timeline.acceptInvite') }}</Button><Button variant="outline" @click="leaveRoom(room)">{{ t('timeline.decline') }}</Button></div></div>
        <template v-else>
          <div ref="timeline" class="timeline" role="feed" :aria-label="t('nav.messageHistory')" aria-live="polite" :aria-busy="state.loading"><div class="timeline-inner"><div v-if="inFocus" class="focus-banner"><span>{{ t('timeline.viewingContext') }}</span><Button variant="ghost" @click="clearFocus">{{ t('timeline.backToLive') }}</Button></div><div v-if="!inFocus" class="history-control"><Button v-if="hiddenEarlier > 0" variant="ghost" @click="showEarlier">{{ t('timeline.showEarlier', { count: hiddenEarlier }) }}</Button><Button v-else-if="!endOfHistory" variant="ghost" :loading="modalBusy" @click="loadEarlier">{{ t('timeline.loadEarlier') }}</Button><span v-else>{{ t('timeline.beginningOf') }}</span></div><div v-if="state.loading" class="loading-messages"><LoadingIndicator/> {{ t('timeline.loadingConversation') }}</div><div v-else-if="inFocus && !focused!.messages.length" class="loading-messages"><LoadingIndicator/> {{ t('timeline.loadingContext') }}</div><div v-else-if="!timelineMessages.length" class="empty-conversation"><span><MessageCircle :size="30"/></span><h2>{{ state.messageQuery ? t('timeline.noMessages') : t('timeline.welcomeTo', { room: room.name }) }}</h2><p>{{ state.messageQuery ? t('timeline.tryDifferent') : t('timeline.emptyHello') }}</p></div>
            <template v-for="(message, index) in timelineMessages" :key="message.id"><div v-if="showDate(index)" class="date-divider"><span>{{ dateLabel(message.timestamp) }}</span></div><MessageRow :message="message" :compact="isCompact(index)" :room-id="room.id" :position="focusBase + index + 1" :total="focusTotal" @reply="beginReply" @edit="beginEdit" @emoji="showEmoji" @remove="removal = $event; open('remove')" @link="openLink" @thread="openThreadFor" @report="beginReport"/></template>
          </div></div>
          <div class="composer-area"><div v-if="unreadAnchor" class="unread-pill"><Button variant="outline" :aria-label="t('message.unreadJump', { count: unreadAnchor.count })" @click="jumpUnread"><ChevronDown :size="15"/>{{ t('message.threadNew', { count: unreadAnchor.count }) }}</Button></div><div v-if="state.uploading" class="uploading-indicator"><LoadingIndicator/> {{ t('composer.uploading') }} <Button variant="ghost" :aria-label="t('composer.cancelUpload')" @click="cancelUpload">{{ t('composer.cancelUpload') }}</Button></div><div v-if="state.typing.length" class="typing-indicator">{{ state.typing.length === 1 ? t('composer.typingOne', { names: state.typing.map(v => v.split(':')[0].replace('@', '')).join(', ') }) : t('composer.typingMany', { names: state.typing.map(v => v.split(':')[0].replace('@', '')).join(', ') }) }}<span>•••</span></div><div v-if="mention && mentionMatches.length" class="mention-popup" role="listbox" :aria-label="t('composer.mentionSomeone')"><Button v-for="(item, index) in mentionMatches" :key="item.id" variant="ghost" role="option" :aria-selected="index === mention.index" :class="{ selected: index === mention.index }" @click="insertMention(item)"><UserAvatar v-if="item.id !== '@room'" :name="item.name" :size="26"/><span><strong>{{ item.id === '@room' ? '@room' : item.name }}</strong><small>{{ item.id === '@room' ? t('composer.mentionNotifyRoom') : item.id }}</small></span></Button></div><div v-if="reply || edit" class="composer-context"><span><strong>{{ edit ? t('composer.editing') : t('composer.replying', { name: reply?.name }) }}</strong><small>{{ (edit || reply)?.body }}</small></span><Button variant="ghost" :aria-label="t('composer.cancelReply')" @click="reply = undefined; edit = undefined"><X :size="16"/></Button></div><div v-if="voiceSupported && (voiceStatus !== 'idle' || voiceError)" class="voice-panel" role="region" :aria-label="t('composer.voiceRecorder')"><ErrorMessage v-if="voiceError" :message="voiceError"/><div v-if="voiceStatus === 'recording' || voiceStatus === 'paused'" class="voice-recording"><span class="voice-dot" :class="{ paused: voiceStatus === 'paused' }" aria-hidden="true"/><strong>{{ voiceStatus === 'paused' ? t('composer.paused') : t('composer.recording') }} · {{ formatVoiceDuration(voiceElapsed) }}</strong><Button v-if="voiceStatus === 'recording'" variant="outline" :icon="Pause" :aria-label="t('composer.pauseRecording')" @click="pauseVoice"/><Button v-else variant="outline" :icon="Play" :aria-label="t('composer.resumeRecording')" @click="resumeVoice"/><Button variant="ghost" :icon="X" :aria-label="t('composer.cancelRecording')" @click="cancelVoice"/><Button variant="solid" theme="green" :icon="Square" :aria-label="t('composer.stopPreview')" @click="stopVoice"/></div><div v-else-if="voiceStatus === 'preview' && voicePreview" class="voice-preview"><div class="voice-waveform" aria-hidden="true"><span v-for="(bar, index) in voicePreview.clip.waveform" :key="index" :style="{ height: `${Math.max(8, Math.round(bar * 100))}%` }"/></div><strong>{{ formatVoiceDuration(voicePreview.clip.durationMs) }}</strong><audio :src="voicePreview.url" controls :aria-label="t('composer.previewVoice', { duration: formatVoiceDuration(voicePreview.clip.durationMs) })"/><p v-if="voiceInterrupted" class="voice-note">{{ t('composer.interrupted') }}</p><Button variant="ghost" :icon="Trash2" :aria-label="t('composer.discardRecording')" @click="discardVoice"/><Button variant="solid" theme="green" :icon="Send" :aria-label="t('composer.sendVoice')" :loading="state.busy" @click="sendVoicePreview"/></div></div><div v-if="locationStatus !== 'idle' || locationError" class="voice-panel" role="region" :aria-label="t('composer.locationSharing')"><ErrorMessage v-if="locationError" :message="locationError"/><div v-if="locationStatus === 'locating'" class="voice-recording"><LoadingIndicator/><strong>{{ t('composer.locating') }}</strong><span class="voice-note">{{ t('composer.onetime') }}</span><Button variant="ghost" :icon="X" :aria-label="t('composer.cancelSharing')" @click="cancelLocationShare"/></div><div v-else-if="locationStatus === 'preview' && locationFix" class="location-preview"><MapPin :size="25"/><span><strong>{{ locationTextAlternative({ ...locationFix, description: locationDescription || undefined }) }}</strong><small>{{ t('composer.reviewMap', { provider: mapProvider === 'google' ? 'Google Maps' : 'OpenStreetMap' }) }}</small></span><FormControl v-model="locationDescription" :placeholder="t('composer.addDescription')" :aria-label="t('composer.addDescription')"/><Button variant="ghost" :icon="X" :aria-label="t('composer.cancelSharing')" @click="cancelLocationShare"/><Button variant="solid" theme="green" :icon="Send" :aria-label="t('composer.sendLocation')" :loading="state.busy" @click="sendLocationShare"/></div></div><div class="composer"><FormControl ref="composer" v-model="draft" type="textarea" :rows="1" :placeholder="t('composer.messageTo', { name: room.direct ? room.name : '#' + room.name.toLowerCase() })" :aria-label="t('composer.label')" @keydown="keydown" @input="composerInput"/><div class="composer-toolbar"><div><Button variant="ghost" :aria-label="t('composer.attachFile')" :disabled="state.busy" @click="fileInput?.click()"><Paperclip :size="19"/></Button><Button variant="ghost" :aria-label="t('composer.insertEmoji')" @click="showEmoji()"><Smile :size="19"/></Button><Button v-if="voiceSupported" variant="ghost" :icon="Mic" :aria-label="t('composer.recordVoice')" :disabled="state.busy || voiceStatus === 'recording' || voiceStatus === 'paused'" @click="startVoice"/><Dropdown :options="[{ label: t('composer.createPoll'), icon: ListFilter, onClick: () => open('poll') }, ...(locationSupported ? [{ label: t('composer.shareLocation'), icon: MapPin, onClick: () => beginLocationShare() }] : [])]"><Button variant="ghost" :aria-label="t('composer.moreActions')"><Plus :size="19"/></Button></Dropdown></div><div class="composer-send"><span>{{ t('composer.sendHint') }} <span>· {{ t('composer.sendHintNewline') }}</span></span><Button variant="solid" theme="green" class="send-button" :disabled="!draft.trim()" :loading="state.busy" :aria-label="t('composer.send')" @click="submitMessage"><Send :size="16"/></Button></div></div></div><input ref="fileInput" type="file" class="sr-only" tabindex="-1" :aria-label="t('composer.attachFile')" @change="attach"/><div class="encryption-note"><LockKeyhole v-if="room.encrypted" :size="10"/><Globe v-else :size="10"/><span>{{ isDemo ? t('composer.demoNote') : room.encrypted ? t('composer.encryptedNote') : t('composer.plainNote') }}</span></div></div>
        </template>
      </template>
      <div v-else class="welcome-view"><span class="welcome-logo"><Leaf :size="44"/></span><span class="eyebrow">A LITTLE SPACE TO CONNECT</span><h1>Good conversations.<br/>A quieter home.</h1><p>Choose a conversation, start something new,<br/>or bring your Matrix accounts together.</p><Button variant="solid" theme="green" @click="open('create')">Start a conversation <Plus :size="16"/></Button></div>
    </main>

    <aside v-if="state.details && room" class="details-panel" :aria-label="t('nav.roomDetails')"><template v-if="state.thread"><header><Button variant="ghost" :aria-label="t('details.backToConversation')" @click="closeThread"><ArrowLeft :size="18"/></Button><strong>{{ t('details.thread') }}</strong><Button variant="ghost" :aria-label="t('details.closeDetails')" @click="state.details = false"><PanelRightClose :size="18"/></Button></header><div class="thread-root"><span class="detail-label">{{ t('details.originalMessage') }}</span><p v-if="state.thread.root"><strong>{{ state.thread.root.name }}</strong> {{ state.thread.root.body }}</p><p v-else>{{ t('details.originalMissing') }}</p></div><div class="thread-replies"><Button v-if="!state.thread.end && !state.thread.loading" variant="ghost" @click="paginateThread">{{ t('details.loadEarlierReplies') }}</Button><span v-if="state.thread.loading" class="thread-loading">{{ t('details.loadingThread') }}</span><MessageRow v-for="message in state.thread.messages.filter(item => item.threadRoot)" :key="message.id" :message="message" :room-id="state.thread.roomId" @reply="beginThreadReply" @edit="beginEdit" @emoji="showEmoji" @remove="removal = $event; open('remove')" @link="openLink" @report="beginReport"/></div><div v-if="threadReplyTo" class="composer-context"><span>{{ t('composer.replying', { name: threadReplyTo.name }) }}</span><Button variant="ghost" :aria-label="t('details.cancelThreadReply')" @click="threadReplyTo = undefined"><X :size="14"/></Button></div><form class="thread-composer" @submit.prevent="submitThread"><FormControl v-model="threadDraft" type="textarea" :rows="2" :placeholder="t('details.threadPlaceholder')" :aria-label="t('details.threadComposer')"/><Button variant="solid" theme="green" type="submit" :aria-label="t('details.sendThreadReply')" :disabled="!threadDraft.trim()"><Send :size="16"/></Button></form></template><template v-else><header><strong>{{ t('nav.roomDetails') }}</strong><Button variant="ghost" :aria-label="t('details.closeDetails')" @click="state.details = false"><PanelRightClose :size="18"/></Button></header><div class="details-hero"><span class="details-icon"><Hash v-if="!room.direct" :size="33"/><UserAvatar v-else :name="room.name" :size="58"/></span><h2>{{ room.name }}</h2><p>{{ t('details.membersN', { count: room.members }) }}</p><span class="encrypted-chip"><LockKeyhole v-if="room.encrypted" :size="12"/><Globe v-else :size="12"/>{{ room.encrypted ? t('details.encryptedRoom') : t('details.publicRoom') }}</span></div><div class="details-tabs"><Button v-for="tab in [{ id: 'about', label: t('details.tabAbout') }, { id: 'members', label: t('details.tabMembers') }, { id: 'pins', label: t('details.tabPins') }, { id: 'polls', label: t('details.tabPolls') }, { id: 'media', label: t('details.tabMedia') }, { id: 'widgets', label: t('details.tabWidgets') }]" :key="tab.id" variant="ghost" :class="{ selected: detailsTab === tab.id }" :aria-current="detailsTab === tab.id ? 'true' : undefined" @click="selectDetailsTab(tab.id)">{{ tab.label }}</Button></div><div class="details-body"><template v-if="detailsTab === 'about'"><span class="detail-label">{{ t('details.aboutRoom') }}</span><p>{{ room.topic || t('details.noTopic') }}</p><span class="detail-label">{{ t('details.roomId') }}</span><code>{{ isDemo ? t('details.localDemoRoom') : room.id }}</code><Button variant="ghost" class="detail-action" @click="toggleFavorite(room)"><Star :size="17"/>{{ room.favorite ? t('nav.removeFavorite') : t('nav.addFavorite') }}</Button><Button variant="ghost" class="detail-action" @click="open('invite')"><Users :size="17"/>{{ t('details.invitePeople') }}</Button><div class="privacy-card"><ShieldCheck :size="22"/><h3>{{ t('details.privacyTitle') }}</h3><p>{{ isDemo ? t('details.privacyDemo') : room.encrypted ? t('details.privacyEncrypted') : t('details.privacyPublic') }}</p></div><Button variant="ghost" theme="red" class="detail-action" @click="open('leave')"><LogOut :size="17"/>{{ t('nav.leaveRoom') }}</Button></template><template v-if="detailsTab === 'members'"><div class="members-heading"><span class="detail-label">{{ t('details.peopleInRoom') }}</span><Button variant="ghost" :aria-label="t('details.inviteMember')" @click="open('invite')"><Plus :size="16"/></Button></div><div v-for="member in state.members" :key="member.id" class="member-row"><UserAvatar :name="member.name" :size="34" :image="avatarUrl(state.activeAccountId, member.id)"/><span><strong>{{ member.name }}</strong><small>{{ member.role }}{{ ignoredUsersState.includes(member.id) ? ' · ignored' : '' }}</small></span><Button v-if="member.id !== account?.userId && !ignoredUsersState.includes(member.id)" variant="ghost" @click="submitIgnore(member.id, true)">Ignore</Button><Button v-if="ignoredUsersState.includes(member.id)" variant="ghost" @click="submitIgnore(member.id, false)">Unignore</Button></div><p v-if="!state.members.length">{{ t('details.membersSync') }}</p></template><template v-if="detailsTab === 'pins'"><span class="detail-label">{{ t('details.pinnedMessages') }}</span><p v-if="pins.length && !pins[0].canPin" class="form-note">{{ t('details.unpinNeedsPower') }}</p><div v-for="pin in pins" :key="pin.eventId" class="shared-file"><FileText :size="21"/><span v-if="pin.message"><strong>{{ pin.message.body.slice(0, 90) }}</strong><small>{{ pin.message.name }}</small></span><span v-else><strong>{{ t('details.unavailable') }}</strong><small>{{ t('details.removedUnsynced') }}</small></span><Button v-if="pin.message" variant="ghost" :aria-label="t('details.jumpToPinned')" @click="jumpToEvent(room.id, pin.eventId)">{{ t('details.jump') }}</Button><Button variant="ghost" :disabled="!pin.canPin" :title="pin.canPin ? undefined : t('details.unpinNeedsPower')" :aria-label="t('details.unpinMessage') + (pin.canPin ? '' : t('details.unpinPowerSuffix'))" @click="unpinMessage(pin.eventId)">{{ t('details.unpin') }}</Button></div><p v-if="!pins.length">{{ t('details.noPins') }}</p></template><template v-if="detailsTab === 'polls'"><span class="detail-label">{{ t('details.pollHistory') }}</span><div v-for="poll in pollHistory" :key="poll.id" class="shared-file"><span v-if="poll.poll"><strong>{{ poll.poll.question }}</strong><small>{{ poll.name }} · {{ poll.poll.ended ? t('details.pollEnded') : t('details.pollOpen') }}{{ poll.poll.kind === 'undisclosed' ? t('details.undisclosedSuffix') : '' }}</small></span><Button variant="ghost" :aria-label="t('details.jumpToPoll')" @click="jumpToEvent(room.id, poll.id)">{{ t('details.jump') }}</Button></div><p v-if="!pollHistory.length">{{ t('details.noPolls') }}</p><Button v-if="!endOfHistory" variant="ghost" @click="loadEarlier">{{ t('details.loadMoreHistory') }}</Button></template><template v-if="detailsTab === 'widgets'"><span class="detail-label">{{ t('details.roomWidgets') }}</span><p v-if="widgetsLoading" class="form-note">{{ t('details.loadingWidgets') }}</p><div v-for="widget in roomWidgets" :key="widget.id" class="member-row"><LayoutGrid :size="17"/><span><strong>{{ widget.name }}</strong><small>{{ widget.kind === 'element_call' ? 'Element Call' : widget.kind === 'jitsi' ? 'Jitsi' : t('details.unsupportedWidget') }} · {{ t('details.addedBy', { sender: widget.sender }) }}</small></span><Button variant="outline" :aria-label="t('details.openWidget', { name: widget.name })" @click="openWidget(widget)">{{ t('details.open') }}</Button></div><p v-if="!roomWidgets.length && !widgetsLoading" class="form-note">{{ t('details.noWidgets') }}</p><p class="form-note">{{ t('details.widgetsNote') }}</p></template><template v-if="detailsTab === 'media'"><span class="detail-label">{{ t('details.sharedInLoaded') }}</span><div class="search-scope" role="group" :aria-label="t('details.galleryFilter')"><Button variant="ghost" :class="{ selected: galleryFilter === 'all' }" @click="galleryFilter = 'all'">{{ t('nav.filterAll') }}</Button><Button variant="ghost" :class="{ selected: galleryFilter === 'media' }" @click="galleryFilter = 'media'">{{ t('details.filterMedia') }}</Button><Button variant="ghost" :class="{ selected: galleryFilter === 'files' }" @click="galleryFilter = 'files'">{{ t('details.filterFiles') }}</Button></div><div v-for="item in galleryItems" :key="item.id" class="shared-file"><img v-if="item.kind === 'image' && item.attachment?.url" :src="item.attachment.url" :alt="item.attachment.name" loading="lazy" class="gallery-thumb"/><FileText v-else :size="21"/><span><strong>{{ item.attachment?.name }}</strong><small>{{ item.name }}</small></span><Button variant="ghost" :aria-label="t('details.jumpToMessage')" @click="jumpToEvent(room.id, item.id)">{{ t('details.jump') }}</Button><Button variant="ghost" :aria-label="t('details.downloadFile')" @click="download(item)"><Download :size="15"/></Button></div><p v-if="!galleryItems.length">{{ t('details.noSharedFiles') }}</p><Button v-if="!endOfHistory" variant="ghost" @click="loadEarlier">{{ t('details.loadMoreHistory') }}</Button></template></div></template></aside>
    </template>

    <ToastProvider/>
  </div>

  <Dialog v-model:open="modalOpen" :title="dialogTitle" :size="modal === 'call' || modal === 'widget' ? '5xl' : modal === 'settings' ? '2xl' : 'lg'">
    <Alert v-if="state.error" theme="red" :title="state.error"/>
    <form v-if="['login', 'create', 'createspace', 'dm', 'join', 'poll', 'invite'].includes(modal)" class="dialog-form" @submit.prevent="modalSubmit">
      <template v-if="modal === 'login'"><div class="login-description"><span><Leaf :size="24"/></span><p>{{ t('login.tagline1') }}<br/>{{ t('login.tagline2') }}</p></div><FormControl v-model="form.server" :label="t('login.server')" placeholder="matrix.org" required/><FormControl v-model="form.username" :label="t('login.username')" placeholder="@you:matrix.org" autocomplete="username" required/><FormControl v-model="form.password" type="password" :label="t('login.password')" autocomplete="current-password" required/><p class="form-note">{{ t('login.note') }}</p><Button variant="outline" :loading="modalBusy" @click.prevent="startSso">{{ t('login.sso') }}</Button><Button variant="outline" @click.prevent="openQr('login'); modal = 'qrlogin'">{{ t('login.qr') }}</Button><p class="form-note">{{ t('login.ssoNote') }}</p><template v-if="loginMode === 'register'"><p class="form-note">{{ t('login.registerNote') }}</p></template><div class="dialog-actions"><Button variant="ghost" @click="loginMode = loginMode === 'register' ? 'signin' : 'register'">{{ loginMode === 'register' ? t('login.backToSignin') : t('login.createAccount') }}</Button></div></template>
      <template v-if="modal === 'create'"><FormControl v-model="form.name" label="Room name" placeholder="A name for your space" required/><FormControl v-model="form.topic" type="textarea" label="Topic" placeholder="What will you talk about?"/><p class="form-note"><LockKeyhole :size="13"/>New rooms are private and encrypted.</p></template>
      <template v-if="modal === 'createspace'"><FormControl v-model="form.name" label="Space name" placeholder="A name for your community" required/><FormControl v-model="form.topic" type="textarea" label="Topic" placeholder="What is this space about?"/><p class="form-note">New spaces are private and unencrypted. Add rooms to them from Room settings.</p></template>
      <template v-if="modal === 'dm' || modal === 'invite'"><FormControl v-model="form.invite" label="Matrix user ID" placeholder="@someone:matrix.org" pattern="^@.+:.+$" required/><p class="form-note">{{ modal === 'dm' ? 'Start a private, encrypted conversation.' : 'They’ll receive an invitation to this room.' }}</p></template>
      <template v-if="modal === 'join'"><FormControl v-model="form.alias" label="Room alias or ID" placeholder="#community:matrix.org" required/><p class="form-note">Ask someone for the room’s Matrix alias or ID.</p><Button variant="outline" @click="open('explore')"><Globe :size="15"/>Explore public rooms</Button></template>
      <template v-if="modal === 'poll'"><FormControl v-model="form.question" label="Question" placeholder="What would you like to ask?" required/><FormControl v-model="form.answers" type="textarea" :rows="5" label="Answers" placeholder="One answer per line" required/><label class="form-check"><input v-model="form.undisclosed" type="checkbox"/>Hide results until the poll ends</label><p class="form-note">Everyone can choose one answer. {{ form.undisclosed ? 'Votes stay hidden until the poll ends.' : 'Results are visible to the room.' }}</p></template>
      <div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Cancel</Button><Button variant="solid" theme="green" type="submit" :loading="modalBusy">{{ modal === 'login' ? (loginMode === 'register' ? t('login.submitCreate') : t('login.submitConnect')) : modal === 'join' ? 'Join room' : modal === 'poll' ? 'Create poll' : modal === 'invite' ? 'Send invitation' : modal === 'dm' ? 'Start conversation' : modal === 'createspace' ? 'Create space' : 'Create room' }}</Button></div>
    </form>
    <div v-if="modal === 'emoji'" class="emoji-grid"><Button v-for="emoji in emojis" :key="emoji" variant="ghost" :aria-label="`Choose ${emoji}`" @click="pickEmoji(emoji)">{{ emoji }}</Button></div>
    <div v-if="modal === 'search'" class="global-search"><FormControl v-model="globalSearch" type="search" placeholder="Find a room or person…" aria-label="Find a conversation" autofocus/><Button v-for="value in searchResults" :key="value.id" variant="ghost" @click="chooseRoom(value); modal = ''"><Hash v-if="!value.direct" :size="19"/><UserAvatar v-else :name="value.name" :size="26"/><span>{{ value.name }}<small>{{ value.topic || value.preview }}</small></span><ChevronRight :size="16"/></Button><p v-if="!searchResults.length">No matching conversations.</p><small class="form-note">⌘ / Ctrl + K to open · Esc to close</small></div>
    <div v-if="modal === 'remove'" class="confirmation"><p>This will remove your message from the conversation.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Cancel</Button><Button theme="red" variant="solid" @click="removal && remove(removal); modal = ''">Remove message</Button></div></div>
    <div v-if="modal === 'report' && reportTarget" class="dialog-form"><p>Reporting sends this message to the room server's moderators with your reason. It does not remove the message or tell the sender.</p><FormControl v-model="reportReason" type="textarea" label="Why is this abusive?" placeholder="Harassment, spam, illegal content…" required/><label class="form-check"><input v-model="reportIgnore" type="checkbox"/>Also ignore {{ reportTarget.name }}: hide their messages, mentions and notifications for this account</label><p class="form-note">Ignoring is personal and invisible to moderators. Kicking or banning stays a moderator power in Room settings.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Cancel</Button><Button theme="red" variant="solid" :loading="modalBusy" :disabled="!reportReason.trim()" @click="submitReport">Report message</Button></div></div>
    <div v-if="modal === 'leave'" class="confirmation"><p>You’ll stop receiving messages from this room.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Stay in room</Button><Button theme="red" variant="solid" @click="room && leaveRoom(room); modal = ''">Leave room</Button></div></div>
    <div v-if="modal === 'roomsettings'"><Alert v-if="state.error" theme="red" :title="state.error"/><template v-if="roomSettings"><span class="detail-label">ROOM DETAILS</span><div class="profile-edit"><FormControl v-model="roomForm.name" label="Room name"/><FormControl v-model="roomForm.topic" label="Topic" placeholder="What is this room about?"/></div><div class="profile-edit"><input ref="roomPictureInput" type="file" accept="image/png,image/jpeg" class="sr-only" tabindex="-1" aria-label="Room picture file"/><Button variant="outline" @click="roomPictureInput?.click()">Choose room picture</Button><label class="form-check"><input v-model="roomForm.removePicture" type="checkbox"/>Remove the room picture on save</label></div><span class="detail-label">ACCESS</span><div class="profile-edit"><FormControl :model-value="roomForm.history" type="select" aria-label="History visibility" :options="[{ label: 'Shared since selection', value: 'shared' }, { label: 'Shared since invite', value: 'invited' }, { label: 'Visible to anyone', value: 'world_readable' }, { label: 'Joined members only', value: 'joined' }]" @update:model-value="roomForm.history = String($event)"/><FormControl :model-value="roomForm.join" type="select" aria-label="Join rule" :options="[{ label: 'Invite only', value: 'invite' }, { label: 'Public', value: 'public' }, { label: 'Knock to join', value: 'knock' }]" @update:model-value="roomForm.join = String($event)"/></div><div class="profile-edit"><FormControl v-if="!isDemo && roomNotifyState" :model-value="roomNotifyState.custom ? roomNotifyState.mode : 'default'" label="Notifications for this room" aria-label="Room notifications" type="select" :options="[{ label: 'Account default', value: 'default' }, { label: 'All messages', value: 'all' }, { label: 'Mentions only', value: 'mentions' }, { label: 'Muted', value: 'mute' }]" @update:model-value="submitRoomNotify(String($event))"/><p v-if="isDemo" class="form-note">Connect your account to change notification rules.</p></div><p v-if="roomSettings.encrypted" class="form-note">Names, topics and access rules can change in encrypted rooms, but removing a member never revokes keys they already hold.</p><p v-if="!roomSettings.permissions.state" class="form-note">Only moderators can change these settings — ask one.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Close</Button><Button variant="solid" theme="green" :disabled="!roomSettings.permissions.state" :loading="modalBusy" @click="submitRoomSettings">Save room settings</Button></div><span class="detail-label">MEMBERS</span><div v-for="member in roomSettings.members" :key="member.id" class="member-row"><UserAvatar :name="member.name" :size="34"/><span><strong>{{ member.name }}</strong><small>{{ member.role }} · power {{ roomPowerOf(member.id) }}</small></span><template v-if="roomConfirm?.id === member.id"><Button variant="solid" theme="red" :loading="modalBusy" @click="submitModerate(roomConfirm.what, member.id)">Confirm {{ roomConfirm.what }}</Button><Button variant="ghost" @click="roomConfirm = null">Cancel</Button></template><template v-else><Button v-if="roomSettings.permissions.kick" variant="ghost" theme="red" @click="roomConfirm = { what: 'kick', id: member.id }">Remove</Button><Button v-if="roomSettings.permissions.ban" variant="ghost" theme="red" @click="roomConfirm = { what: 'ban', id: member.id }">Ban</Button><Button v-if="member.id !== account?.userId && !ignoredUsersState.includes(member.id)" variant="ghost" :loading="modalBusy" @click="submitIgnore(member.id, true)">Ignore</Button><Button v-if="ignoredUsersState.includes(member.id)" variant="ghost" :loading="modalBusy" @click="submitIgnore(member.id, false)">Unignore</Button></template></div><p v-if="!roomSettings.members.length" class="form-note">Members will appear after the room syncs.</p><div v-if="roomSettings.permissions.state" class="profile-edit"><FormControl :model-value="roomPowerDraft" label="Power level" placeholder="0 to 100" inputmode="numeric" @update:model-value="roomPowerDraft = String($event)"/><p class="form-note">Levels run from 0 to 100. Type a level, then use Set power on a member; concurrent edits last-write-wins on the server.</p></div><div v-for="member in roomSettings.members" :key="`power-${member.id}`" class="member-row"><span><strong>{{ member.name }}</strong><small>current power {{ roomPowerOf(member.id) }}</small></span><Button v-if="roomSettings.permissions.state" variant="outline" :loading="modalBusy" :aria-label="`Set power for ${member.name}`" @click="submitPower(member.id)">Set power</Button></div><div v-if="roomSettings.permissions.ban" class="profile-edit"><FormControl v-model="roomForm.unbanId" label="Banned user ID" placeholder="@someone:matrix.org"/><Button variant="outline" :loading="modalBusy" @click="submitModerate('unban', roomForm.unbanId)">Lift ban</Button></div><template v-if="roomSettings.permissions.invite || roomSettings.permissions.kick"><span class="detail-label">KNOCK REQUESTS</span><p v-if="knocksLoading" class="form-note">Loading knock requests…</p><div v-for="request in knockRequests" :key="request.userId" class="member-row"><span><strong>{{ request.userId }}</strong><small>{{ request.reason ?? 'No reason given' }}</small></span><template v-if="knockConfirm === request.userId"><Button variant="solid" theme="red" :loading="modalBusy" @click="submitKnock(request.userId, false)">Confirm decline</Button><Button variant="ghost" @click="knockConfirm = null">Cancel</Button></template><template v-else><Button v-if="roomSettings.permissions.invite" variant="solid" theme="green" :loading="modalBusy" @click="submitKnock(request.userId, true)">Accept</Button><Button v-if="roomSettings.permissions.kick" variant="ghost" theme="red" @click="knockConfirm = request.userId">{{ t('timeline.decline') }}</Button></template></div><p v-if="!knockRequests.length && !knocksLoading" class="form-note">No pending knock requests.</p></template><p v-if="!roomSettings.permissions.ban && !roomSettings.permissions.kick" class="form-note">Only moderators can change members — ask one.</p><template v-if="roomSettings.space"><span class="detail-label">CHILD ROOMS AND SPACES</span><div v-for="child in roomSettings.children" :key="child.id" class="member-row"><Hash v-if="!child.space" :size="17"/><LayoutGrid v-else :size="17"/><span><strong>{{ child.name }}</strong><small>{{ child.space ? 'Space' : 'Room' }} · {{ child.members }} members{{ child.space ? ` · ${child.children} subspaces` : '' }}</small></span><template v-if="spaceConfirm === child.id"><Button variant="solid" theme="red" :loading="modalBusy" @click="submitSpaceChild(true, child.id)">Confirm remove</Button><Button variant="ghost" @click="spaceConfirm = null">Cancel</Button></template><template v-else><Button v-if="roomSettings.canOrganize" variant="ghost" theme="red" @click="spaceConfirm = child.id">Remove</Button></template></div><p v-if="!roomSettings.children.length" class="form-note">No rooms in this space yet.</p><div v-if="roomSettings.canOrganize" class="profile-edit"><FormControl :model-value="spaceChildDraft" label="Add a room" aria-label="Add a room to this space" type="select" :options="spaceCandidates" @update:model-value="spaceChildDraft = String($event)"/><Button variant="outline" :loading="modalBusy" :disabled="!spaceChildDraft" @click="submitSpaceChild(false, '')">Add to space</Button></div><p v-if="!roomSettings.canOrganize" class="form-note">Only moderators can organize this space — ask one.</p></template></template><p v-else class="form-note">Loading room settings…</p></div>
    <div v-if="modal === 'link' && pendingLink" class="confirmation"><p>This link opens <strong>{{ pendingLink.link.target }}</strong> in one of your other accounts. Choose where to open it.</p><div v-for="item in pendingLink.accounts" :key="item.id" class="settings-account"><UserAvatar :name="item.name" :image="avatarUrl(item.id, item.userId)"/><span><strong>{{ item.name }}</strong><small>{{ item.userId }} · {{ item.connection }}</small></span><Button variant="outline" @click="goToLink(item.id, pendingLink.link)">Open here</Button></div><div class="dialog-actions"><Button variant="ghost" @click="modal = ''; pendingLink = undefined">Cancel</Button></div></div>
    <div v-if="modal === 'settings'" class="settings-layout"><nav><Button v-for="tab in settingsTabs" :key="tab.id" variant="ghost" :class="{ selected: settingsTab === tab.id }" @click="settingsTab = tab.id; if (tab.id === 'security') loadAccountSections(); if (tab.id === 'notifications') void loadAccountNotifySettings(); if (tab.id === 'safety') void loadIgnoredUsers()"><component :is="tab.icon" :size="16"/>{{ tab.label }}</Button></nav><div class="settings-content"><template v-if="settingsTab === 'general'"><h3>{{ t('settings.generalTitle') }}</h3><p>{{ t('settings.generalSub') }}</p><div class="settings-row"><span><strong>{{ t('tabs.appearance') }}</strong><small>{{ t('settings.appearanceHint') }}</small></span><FormControl :model-value="colorScheme" type="select" :aria-label="t('settings.colorScheme')" :options="[{ label: t('settings.themeLight'), value: 'light' }, { label: t('settings.themeDark'), value: 'dark' }, { label: t('settings.themeSystem'), value: 'system' }]" @update:model-value="setColorScheme($event as 'light' | 'dark' | 'system')"/></div><div class="settings-row"><span><strong>{{ t('settings.compact') }}</strong><small>{{ t('settings.compactHint') }}</small></span><Switch v-model="compactMessages" :aria-label="t('settings.compact')"/></div><div class="settings-row"><span><strong>{{ t('settings.accent') }}</strong><small>{{ t('settings.accentHint') }}</small></span><FormControl :model-value="accent" type="select" :aria-label="t('settings.accent')" :options="ACCENT_OPTIONS" @update:model-value="setAccent($event)"/></div><div class="settings-row"><span><strong>{{ t('settings.mapLinks') }}</strong><small>{{ t('settings.mapHint') }}</small></span><FormControl :model-value="mapProvider" type="select" :aria-label="t('settings.mapLinks')" :options="[{ label: 'OpenStreetMap', value: 'osm' }, { label: 'Google Maps', value: 'google' }]" @update:model-value="setMapProvider($event as 'osm' | 'google')"/></div><div class="settings-row"><span><strong>{{ t('settings.diagnostics') }}</strong><small>{{ t('settings.diagnosticsHint') }}</small></span><Button variant="outline" @click="downloadDiagnostics"><Download :size="15"/>{{ t('settings.downloadDiagnostics') }}</Button></div><div v-if="isTauri()" class="settings-row"><span><strong>{{ t('updates.title') }}</strong><small>{{ updateNote || t('updates.default') }}</small></span><Button v-if="!updateVersion" variant="outline" :loading="updateBusy" @click="submitCheckUpdate">{{ t('updates.check') }}</Button><Button v-else variant="solid" theme="green" :loading="updateBusy" @click="submitInstallUpdate">{{ t('updates.install', { version: updateVersion }) }}</Button></div><div class="settings-row"><span><strong>{{ t('locale.title') }}</strong><small>{{ t('locale.hint') }}</small></span><FormControl :model-value="$i18n.locale" :aria-label="t('locale.title')" type="select" :options="localeNames(t)" @update:model-value="submitLocale"/></div><div class="settings-about"><Leaf :size="19"/><span>Fern <small>0.1.0 · Frappe UI + Matrix Rust SDK</small></span></div></template><template v-if="settingsTab === 'accounts'"><h3>{{ t('settings.accountsTitle') }}</h3><p>{{ t('settings.accountsSub') }}</p><div class="profile-edit"><FormControl v-model="profileName" :label="t('settings.displayName')"/><Button variant="outline" @click="updateProfile">{{ t('settings.save') }}</Button></div><div class="profile-edit"><input ref="avatarInput" type="file" accept="image/png,image/jpeg" class="sr-only" tabindex="-1" :aria-label="t('settings.profilePictureFile')" @change="uploadAvatar"/><Button variant="outline" @click="avatarInput?.click()">{{ t('settings.uploadPicture') }}</Button></div><div v-for="value in state.accounts" :key="value.id" class="settings-account"><UserAvatar :name="value.name" :image="avatarUrl(value.id, value.userId)"/><span><strong>{{ value.name }}</strong><small>{{ value.userId }} · {{ value.connection }}</small></span><Badge v-if="accountUnread(value.id)" size="sm" :theme="accountMentions(value.id) ? 'red' : 'green'" :label="accountMentions(value.id) ? '@' : String(accountUnread(value.id))"/><Button variant="outline" :disabled="value.id === state.activeAccountId" @click="switchAccount(value.id)">{{ value.id === state.activeAccountId ? t('settings.active') : t('settings.switch') }}</Button><Button v-if="value.connection !== 'demo'" variant="ghost" theme="red" @click="removeAccount(value.id)">{{ t('settings.remove') }}</Button></div><Button variant="solid" theme="green" @click="open('login')"><Plus :size="15"/>{{ t('nav.addAccount') }}</Button><Button v-if="!isDemo" variant="ghost" theme="red" @click="signOut(); modal = ''">{{ t('settings.signOutCurrent') }}</Button></template><template v-if="settingsTab === 'security'"><h3>{{ t('settings.securityTitle') }}</h3><p>{{ t('settings.securitySub') }}</p><div class="security-summary"><ShieldCheck :size="28"/><span>{{ isDemo ? t('settings.localDemoSec') : t('settings.deviceSecurity') }}<small>{{ security?.verified ?? t('settings.loadingDevice') }}</small></span></div><div v-if="security" class="security-info"><span>{{ t('settings.deviceId') }} <code>{{ security.deviceId }}</code></span><span>{{ t('settings.keyRecovery') }} <strong>{{ security.recovery }}</strong></span><span v-if="security.fingerprint">{{ t('settings.fingerprint') }} <code>{{ security.fingerprint }}</code></span></div><FormControl v-model="form.recoveryKey" type="password" :label="t('settings.recoveryKey')" :placeholder="t('settings.recoveryKeyPh')" autocomplete="off"/><Button variant="outline" :disabled="!form.recoveryKey.trim()" :loading="modalBusy" @click="recoverKeys">{{ t('settings.restoreHistory') }}</Button><Button variant="outline" @click="startVerification">{{ t('settings.verifyDevice') }}</Button><Button variant="outline" @click="openQr('grant'); modal = 'qrgrant'">{{ t('settings.linkDevice') }}</Button><span class="detail-label">{{ t('lock.section') }}</span><p class="form-note">{{ lockNote }}</p><template v-if="!lockEnabled"><div class="profile-edit"><FormControl v-model="pinSetup" type="password" :label="t('lock.newPin')" :placeholder="t('settings.pinMin')" autocomplete="new-password"/><FormControl v-model="pinSetupConfirm" type="password" :label="t('lock.confirmPin')" autocomplete="new-password"/></div><Button variant="outline" :loading="lockBusy" @click="submitSetupPin">{{ t('lock.setup') }}</Button></template><template v-else><div class="settings-row"><span><strong>{{ t('lock.autoLock') }}</strong><small>{{ t('lock.autoLockHint') }}</small></span><FormControl :model-value="lockTimeoutMin" type="select" :aria-label="t('lock.autoLock')" :options="[{ label: t('lock.delays.one'), value: 1 }, { label: t('lock.delays.five'), value: 5 }, { label: t('lock.delays.fifteen'), value: 15 }, { label: t('lock.delays.manual'), value: 0 }]" @update:model-value="setLockTimeoutMin(Number($event))"/></div><Button variant="outline" @click="lockNow">{{ t('lock.lockNow') }}</Button><div class="profile-edit"><FormControl v-model="pinCurrent" type="password" :label="t('lock.currentPin')" autocomplete="current-password"/><FormControl v-model="pinNew" type="password" :label="t('lock.newPin')" autocomplete="new-password"/></div><Button variant="outline" :loading="lockBusy" @click="submitChangePin">{{ t('lock.change') }}</Button><Button variant="ghost" theme="red" :loading="lockBusy" @click="submitDisablePin">{{ t('lock.remove') }}</Button></template><Button v-if="security?.recovery === 'Disabled'" variant="outline" :loading="modalBusy" @click="enableRecovery">{{ t('settings.setupRecovery') }}</Button><Button v-else variant="outline" @click="confirmReset = true">{{ t('settings.resetRecovery') }}</Button><p v-if="confirmReset" class="form-note">{{ t('settings.resetNote') }}</p><div v-if="confirmReset" class="dialog-actions"><Button variant="outline" @click="confirmReset = false">{{ t('settings.cancel') }}</Button><Button variant="solid" theme="red" :loading="modalBusy" @click="resetRecovery">{{ t('settings.resetShow') }}</Button></div><p v-if="recoveryProgress && modalBusy" class="form-note">{{ recoveryProgress }}</p><div v-if="recoveryOutput" class="recovery-output"><strong>{{ t('settings.saveRecoveryTitle') }}</strong><p>{{ t('settings.saveRecoverySub') }}</p><code>{{ recoveryOutput }}</code><Button variant="outline" @click="saveRecoveryKey">{{ t('settings.downloadRecovery') }}</Button></div><span class="detail-label">{{ t('settings.passwordSection') }}</span><p v-if="activeProviderManaged" class="form-note">{{ t('settings.providerPasswordNote') }}</p><template v-else><div class="profile-edit"><FormControl v-model="form.password" type="password" :label="t('settings.currentPassword')" autocomplete="current-password"/><FormControl v-model="form.newPassword" type="password" :label="t('settings.newPassword')" autocomplete="new-password"/></div><Button variant="outline" :loading="modalBusy" @click="submitPasswordChange">{{ t('settings.changePassword') }}</Button><p class="form-note">{{ t('settings.changeSignsOut') }}</p></template><span class="detail-label">{{ t('settings.emailSection') }}</span><p v-if="activeProviderManaged" class="form-note">{{ t('settings.providerEmailNote') }}</p><template v-else><div v-for="item in emailAddresses" :key="item.address" class="member-row"><span><strong>{{ item.address }}</strong><small>{{ item.medium }}</small></span><Button variant="ghost" theme="red" :aria-label="t('settings.removeEmailAria')" @click="submitRemoveEmail(item.address)">{{ t('settings.remove') }}</Button></div><p v-if="!emailAddresses.length" class="form-note">{{ t('settings.noEmails') }}</p><div v-if="!emailPending" class="profile-edit"><FormControl v-model="form.email" :label="t('settings.newEmail')" placeholder="you@example.org"/><Button variant="outline" :loading="modalBusy" @click="submitAddEmail">{{ t('settings.sendCode') }}</Button></div><div v-else class="profile-edit"><FormControl v-model="form.emailCode" :label="t('settings.verificationCode')"/><FormControl v-model="form.accountPassword" type="password" :label="t('settings.accountPassword')"/><Button variant="outline" :loading="modalBusy" @click="submitConfirmEmail">{{ t('settings.verify') }}</Button></div></template><span class="detail-label">{{ t('settings.sessionsSection') }}</span><div v-for="device in accountDevices" :key="device.id" class="member-row"><span><strong>{{ device.name }}</strong><small>{{ device.current ? t('settings.thisDevice') : device.id }}</small></span></div><p v-if="!accountDevices.length" class="form-note">{{ t('settings.sessionsSync') }}</p><div v-if="!isDemo" class="profile-edit"><FormControl v-model="form.accountPassword" type="password" :label="t('settings.accountPassword')"/><Button variant="outline" :loading="modalBusy" @click="submitSignOutOthers">{{ t('settings.signOutOthers') }}</Button></div><span class="detail-label">{{ t('settings.deactivateSection') }}</span><p class="form-note">{{ t('settings.deactivateNote') }}</p><p v-if="lastDeviceWarning" class="form-note">{{ t('settings.lastDevice') }}</p><template v-if="!isDemo"><label class="form-check"><input v-model="form.deactivateAck" type="checkbox"/>{{ t('settings.understandUndone') }}</label><label class="form-check"><input v-model="form.eraseData" type="checkbox"/>{{ t('settings.eraseHistory') }}</label><div class="profile-edit"><FormControl v-model="form.accountPassword" type="password" :label="t('settings.accountPassword')"/><Button variant="solid" theme="red" :loading="modalBusy" @click="submitDeactivate">{{ t('settings.deactivateAccount') }}</Button></div></template><p class="form-note">{{ t('settings.compareEmoji') }}</p></template><template v-if="settingsTab === 'notifications'"><h3>Stay in the conversation</h3><p>Browser notifications work while Fern is open.</p><div class="settings-row"><span><strong>Desktop notifications</strong><small>For new messages while you are away</small></span><Switch :model-value="browserNotify" aria-label="Desktop notifications" @update:model-value="enableBrowserNotify(Boolean($event))"/></div><p v-if="notifyPermission === 'denied'" class="form-note">Notifications are blocked for Fern in this browser. Allow them in the site settings — Fern will not ask again.</p><template v-if="!isDemo"><span class="detail-label">QUIET ACCOUNTS</span><div v-for="value in state.accounts.filter(item => item.connection !== 'demo')" :key="value.id" class="settings-row"><span><strong>Quiet {{ value.name }}</strong><small>No desktop notifications for this account</small></span><Switch :model-value="!!quietAccounts[value.id]" :aria-label="`Quiet ${value.name}`" @update:model-value="setAccountQuiet(value.id, Boolean($event))"/></div><span class="detail-label">ACCOUNT DEFAULTS</span><div v-for="entry in notifyDefaultsState" :key="`${entry.encrypted}-${entry.direct}`" class="profile-edit"><FormControl :model-value="entry.mode" :label="entry.direct ? (entry.encrypted ? 'Encrypted direct messages' : 'Direct messages') : (entry.encrypted ? 'Encrypted chats' : 'Group chats')" type="select" :options="[{ label: 'All messages', value: 'all' }, { label: 'Mentions only', value: 'mentions' }]" @update:model-value="setAccountNotifyDefault(entry.encrypted, entry.direct, $event as 'all' | 'mentions')"/></div><div class="settings-row"><span><strong>Mentions of me</strong><small>Notify when someone names you</small></span><Switch :model-value="mentionToggleState.user" aria-label="Mentions of me" @update:model-value="setMentionToggle('user', Boolean($event))"/></div><div class="settings-row"><span><strong>Room mentions</strong><small>Notify on @room announcements</small></span><Switch :model-value="mentionToggleState.room" aria-label="Room mentions" @update:model-value="setMentionToggle('room', Boolean($event))"/></div></template><p v-else class="form-note">Connect your account to change notification rules.</p><p class="form-note">Background push is not available: closed tabs stay silent because Fern provisions no push gateway (see docs/PUSH.md).</p></template><template v-if="settingsTab === 'safety'"><h3>Your safety comes first</h3><p>Ignoring hides someone's messages, mentions and notifications for this account only. Reporting sends a message to the room server's moderators. Neither tells the other person, and neither needs moderator power — kicking and banning stay in Room settings.</p><template v-if="!isDemo"><div v-for="userId in ignoredUsersState" :key="userId" class="member-row"><span><strong>{{ userId }}</strong><small>ignored · hidden everywhere for this account</small></span><Button variant="ghost" :loading="modalBusy" @click="submitIgnore(userId, false)">Unignore</Button></div><p v-if="!ignoredUsersState.length" class="form-note">Nobody ignored on this account.</p></template><p v-else class="form-note">Connect your account to ignore users and report messages.</p></template></div></div>
    <div v-if="modal === 'explore'" class="directory-view"><form @submit.prevent="loadDirectory"><FormControl v-model="directoryQuery" type="search" aria-label="Search public rooms" placeholder="Find a community…"/><Button variant="solid" theme="green" type="submit" :loading="modalBusy">Search</Button></form><p class="form-note">{{ isDemo ? 'Local demo communities' : 'Public rooms on your homeserver' }}</p><div v-for="value in directoryRooms" :key="value.id" class="directory-row"><span class="room-icon"><Hash :size="19"/></span><div><strong>{{ value.name }}</strong><p>{{ value.topic }}</p><small>{{ value.members }} members{{ value.knockable ? ' · knock to join' : '' }}</small></div><Button v-if="value.knockable && !accountRooms.some(item => item.id === value.id)" variant="outline" aria-label="Knock to join {{ value.name }}" :loading="modalBusy" @click="knockDirectory(value)">Knock</Button><Button variant="outline" @click="joinDirectory(value)">{{ accountRooms.some(item => item.id === value.id) ? 'Open' : 'Join' }}</Button></div><p v-if="!directoryRooms.length && !modalBusy" class="form-note">No rooms found. Try a different search.</p><Button v-if="!directoryEnd" variant="outline" :loading="modalBusy" @click="moreDirectory">Load more rooms</Button></div>
    <WidgetView v-if="modal === 'widget' && activeWidget" :widget="activeWidget" :status="widgetStatus" :error="widgetError" @iframe="catchWidgetIframe" @approve="approveWidgetOpen" @decline="modal = ''" @leave="modal = ''" @retry="retryWidget" @close="modal = ''"/>
    <CallView v-if="modal === 'call' && room" :room-name="room.name" :direct="room.direct" :encrypted="room.encrypted" :status="callStatus" :error="callError" @iframe="callIframe = $event" @join="joinCall" @leave="modal = ''" @retry="retryCall" @close="modal = ''"/>
    <div v-if="modal === 'verify'" class="verification-view"><ShieldCheck :size="38"/><h3>{{ verification.status === 'verified' ? 'Device verified' : verification.status === 'compare' ? 'Do these match?' : verification.status === 'incoming' ? 'A device wants to verify' : verification.status === 'mismatch' ? 'Comparison did not match' : 'Check your other device' }}</h3><p v-if="verification.status === 'waiting' || verification.status === 'requested'">Open another Matrix device and accept this verification request.</p><p v-if="verification.status === 'incoming'">{{ verification.deviceName }} is requesting to verify this session. Only continue if you started this request on a device you control.</p><p v-if="verification.status === 'accepted' || verification.status === 'comparing'">Waiting for the security comparison…</p><p v-if="verification.status === 'compare'">Compare these with your other device. Only approve if every value matches.</p><div v-if="verification.emojis" class="verification-emojis"><span v-for="emoji in verification.emojis" :key="emoji.description"><strong>{{ emoji.symbol }}</strong><small>{{ emoji.description }}</small></span></div><div v-if="verification.numbers" class="verification-numbers">{{ verification.numbers.join(' · ') }}</div><p v-if="verification.status === 'verified'">Your devices can now trust each other.</p><p v-if="verification.status === 'mismatch'">Neither device was verified. Close this dialog and start again if you want to compare a new request.</p><p v-if="verification.status === 'failed' || verification.status === 'canceled'">Verification {{ verification.status }}. Close this dialog and try again.</p><div class="dialog-actions"><template v-if="verification.status === 'incoming'"><Button theme="red" variant="outline" @click="closeVerification">Decline request</Button><Button variant="solid" theme="green" @click="acceptIncomingVerification">Accept request</Button></template><template v-else-if="verification.status === 'compare'"><Button theme="red" variant="outline" @click="approveVerification(false)">They don’t match</Button><Button variant="solid" theme="green" @click="approveVerification(true)">They match</Button></template><Button v-else variant="outline" @click="closeVerification">{{ verification.status === 'verified' || verification.status === 'mismatch' ? 'Done' : 'Close' }}</Button></div></div>
    <div v-if="modal === 'qrlogin'"><QrScan role="login" :server="form.server" @close="modal = ''"/></div>
    <div v-if="modal === 'qrgrant'"><QrScan role="grant" @close="modal = ''"/></div>
    <div v-if="modal === 'help'" class="help-content"><span class="welcome-logo"><Leaf :size="35"/></span><h2>A calmer place to connect.</h2><p>Fern speaks Frappe UI on Matrix: Frappe components in a spaces-and-accounts layout.</p><p>The demo is local. Connect an account for real encrypted messaging, room management, reactions, files, and polls.</p><div class="help-shortcuts"><span>Find a conversation <kbd>Ctrl / ⌘ K</kbd></span><span>Send a message <kbd>Enter</kbd></span><span>New line <kbd>Shift Enter</kbd></span></div><p class="form-note">Early development: QR code display, threads, background push, and full Element X parity remain on the roadmap.</p><Button variant="solid" theme="green" @click="open('login')">Connect your account <ArrowUpRight :size="15"/></Button></div>
  </Dialog>
  <Dialog v-model:open="forwardOpen" title="Forward message"><div v-if="forwardDialog" class="dialog-form"><p class="form-note">From <strong>{{ forwardDialog.message.name }}</strong> in <strong>{{ forwardDialog.sourceRoomName }}</strong> ({{ forwardDialog.sourceAccountName }})</p><p class="forward-preview">{{ forwardPreview(forwardDialog.message) }}</p><FormControl v-model="forwardRoomId" type="select" label="Forward to" :options="forwardOptions"/><p v-if="forwardCrossAccount && forwardTarget" class="form-note">This leaves {{ forwardDialog.sourceAccountName }} rooms — members of {{ forwardTarget.accountName }} ({{ forwardTarget.room.name }}) will be able to read it.</p></div><template #actions><Button variant="ghost" @click="cancelForward">Cancel</Button><Button variant="solid" theme="green" :loading="state.busy" @click="confirmForward">Forward</Button></template></Dialog>
</FrappeUIProvider>
</template>
