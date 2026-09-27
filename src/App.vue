<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { FrappeUIProvider, Button, Dialog, FormControl, Dropdown, Switch, useColorScheme } from 'frappe-ui'
import { ArrowLeft, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, CircleHelp, Command, FileText, Hash, Headphones, Video, Home, Info, Leaf, LockKeyhole, LogOut, MessageCircle, Moon, MoreHorizontal, Plus, Search, Send, Settings, ShieldCheck, Smile, Sparkles, Star, Sun, Users, X, Paperclip, ListFilter, Inbox, Globe, PanelRightClose } from 'lucide-vue-next'
import UserAvatar from './components/UserAvatar.vue'
import MessageRow from './components/MessageRow.vue'
import type { Message, Room, DirectoryRoom } from './types'
import { state, account, room, isDemo, accountRooms, filteredRooms, messages, visibleMessages, totalUnread, selectRoom, switchAccount, send, toggleFavorite, upload, createRoom, joinRoom, acceptInvite, leaveRoom, createPoll, signIn, signOut, typingNotice, action, engine, initialize, react, remove, notify, download } from './store'
const { colorScheme, setColorScheme } = useColorScheme()
const modal = ref('')
const modalOpen = computed({ get: () => Boolean(modal.value), set: value => { if (!value) modal.value = '' } })
const form = ref({ server: 'matrix.org', username: '', password: '', name: '', topic: '', invite: '', alias: '', question: '', answers: 'A calmer workspace\nBetter mobile conversations', recoveryKey: '' })
const draft = ref('')
const reply = ref<Message>()
const edit = ref<Message>()
const removal = ref<Message>()
const emojiTarget = ref<Message>()
const searchOpen = ref(false)
const timeline = ref<HTMLElement>()
const composer = ref<{ inputElement?: HTMLTextAreaElement }>()
const fileInput = ref<HTMLInputElement>()
const detailsTab = ref('about')
const settingsTab = ref('general')
const security = ref<{ deviceId: string; fingerprint?: string; recovery: string; verified: string }>()
const modalBusy = ref(false)
const endOfHistory = ref(false)
const globalSearch = ref('')
const directoryQuery = ref('')
const directoryRooms = ref<DirectoryRoom[]>([])
const directoryEnd = ref(false)
let directorySession: Awaited<ReturnType<typeof engine.searchDirectory>> | undefined
let directoryGeneration = 0
const profileName = ref('')
const compactMessages = ref(localStorage.getItem('fern.compact') === 'true')
const notifications = ref(false)
const callFrame = ref<HTMLIFrameElement>()
let stopCall: (() => void) | undefined
let callGeneration = 0
const recoveryOutput = ref('')
const recoveryProgress = ref('')
const verification = ref<{ status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }>({ status: 'waiting' })
let verificationAccount = ''

const spaces = computed(() => accountRooms.value.filter(value => value.space))
const favorites = computed(() => filteredRooms.value.filter(value => value.favorite && value.membership === 'joined'))
const channels = computed(() => filteredRooms.value.filter(value => !value.favorite && !value.direct && value.membership === 'joined'))
const people = computed(() => filteredRooms.value.filter(value => !value.favorite && value.direct && value.membership === 'joined'))
const invites = computed(() => filteredRooms.value.filter(value => value.membership === 'invited'))
const files = computed(() => messages.value.filter(value => value.attachment))
const searchResults = computed(() => {
  const query = globalSearch.value.toLowerCase()
  return accountRooms.value.filter(value => !value.space && (!query || `${value.name} ${value.topic}`.toLowerCase().includes(query)))
})
const dialogTitle = computed(() => ({ login: 'Add a Matrix account', create: 'Create a room', dm: 'Start a conversation', join: 'Join a room', poll: 'Create a poll', emoji: emojiTarget.value ? 'Add a reaction' : 'A little expression', settings: 'Settings', search: 'Find a conversation', remove: 'Remove this message?', leave: `Leave ${room.value?.name ?? 'room'}?`, invite: 'Invite someone', help: 'Welcome to Fern', verify: 'Verify this device', call: 'Room call', explore: 'Explore public rooms' })[modal.value] ?? 'Fern')
const emojis = ['💚', '✨', '🌿', '👍', '❤️', '🎉', '😊', '😂', '🙌', '👀', '☀️', '🔥', '🤔', '✅', '🚀', '🙏', '💡', '👏', '🎨', '☕', '🌻', '💬', '🫶', '🤍']
const accountOptions = computed(() => [
  ...state.accounts.map(value => ({ label: `${value.name}${value.id === state.activeAccountId ? ' ✓' : ''}`, description: value.userId, onClick: () => switchAccount(value.id) })),
  { label: 'Add account', icon: Plus, onClick: () => open('login') },
  { label: 'Settings', icon: Settings, onClick: () => open('settings') },
  ...(!isDemo.value ? [{ label: 'Sign out', icon: LogOut, onClick: () => void signOut() }] : []),
])
const roomOptions = computed(() => [
  { label: room.value?.favorite ? 'Remove from favorites' : 'Add to favorites', icon: Star, onClick: () => room.value && toggleFavorite(room.value) },
  { label: 'Invite someone', icon: Users, onClick: () => open('invite') },
  { label: 'Room details', icon: Info, onClick: () => state.details = !state.details },
  { label: 'Copy room link', icon: ArrowUpRight, onClick: () => action(async () => { if (isDemo.value) { notify('Demo rooms have no public Matrix link'); return }; await navigator.clipboard.writeText(`https://matrix.to/#/${encodeURIComponent(state.activeRoomId)}`); notify('Room link copied') }) },
  { label: 'Leave room', icon: LogOut, onClick: () => open('leave') },
])
function open(value: string) { state.error = ''; setTimeout(() => { modal.value = value; if (value === 'settings') { profileName.value = account.value?.name ?? ''; if (settingsTab.value === 'security') void loadSecurity() }; if (value === 'explore') void loadDirectory() }, 0) }
function chooseRoom(value: Room) { reply.value = undefined; edit.value = undefined; endOfHistory.value = false; void selectRoom(value) }
function chooseFilter(value: string) { state.filter = value; state.spaceId = ''; state.mobileRoom = false }
function chooseSpace(value: Room) { state.spaceId = state.spaceId === value.id ? '' : value.id; state.filter = 'all'; state.mobileRoom = false }
function beginReply(value: Message) { reply.value = value; edit.value = undefined; focusComposer() }
function beginEdit(value: Message) { edit.value = value; reply.value = undefined; draft.value = value.body; focusComposer() }
function focusComposer() { void nextTick(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()) }
async function submitMessage() {
  const text = draft.value
  if (await send(text, reply.value, edit.value)) {
    if (draft.value === text) draft.value = ''
    reply.value = undefined; edit.value = undefined
    await scrollToEnd()
  }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submitMessage() }
}
function shortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); open('search') }
  if (event.key === 'Escape') { if (modal.value) modal.value = ''; else if (reply.value || edit.value) { reply.value = undefined; edit.value = undefined } else if (state.details) state.details = false; else state.mobileRoom = false }
}
async function scrollToEnd() { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight }
function showEmoji(value?: Message) { emojiTarget.value = value; open('emoji') }
async function pickEmoji(value: string) { if (emojiTarget.value) await react(emojiTarget.value, value); else { draft.value += value; focusComposer() }; modal.value = '' }
function dateLabel(time: number) { const date = new Date(time); return date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) }
function showDate(index: number) { return index === 0 || new Date(visibleMessages.value[index].timestamp).toDateString() !== new Date(visibleMessages.value[index - 1].timestamp).toDateString() }
function isCompact(index: number) { const previous = visibleMessages.value[index - 1]; const current = visibleMessages.value[index]; return compactMessages.value || Boolean(previous && !showDate(index) && previous.sender === current.sender && current.timestamp - previous.timestamp < 5 * 60000) }
function previewTime(timestamp: number) { return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' }
async function modalSubmit() {
  if (modalBusy.value) return
  modalBusy.value = true
  try {
    let success: unknown
    if (modal.value === 'login') { success = await signIn(form.value.server, form.value.username, form.value.password); form.value.password = '' }
    if (modal.value === 'create' || modal.value === 'dm') success = await createRoom(form.value.name || form.value.invite, form.value.topic, modal.value === 'dm' ? form.value.invite : undefined)
    if (modal.value === 'join') success = await joinRoom(form.value.alias)
    if (modal.value === 'poll') {
      const answers = form.value.answers.split('\n').map(value => value.trim()).filter(Boolean)
      if (answers.length < 2 || answers.length > 20) { state.error = 'Add between 2 and 20 answers, one per line.'; return }
      success = await createPoll(form.value.question, answers)
    }
    if (modal.value === 'invite') success = await action(async () => { if (!isDemo.value) await engine.invite(state.activeAccountId, state.activeRoomId, form.value.invite); notify(isDemo.value ? 'Invitation recorded in the local demo' : 'Invitation sent'); return true })
    if (success) { modal.value = ''; form.value.name = ''; form.value.topic = ''; form.value.invite = ''; form.value.alias = ''; form.value.question = '' }
  } finally { modalBusy.value = false }
}
async function loadSecurity() {
  if (isDemo.value) { security.value = { deviceId: 'LOCAL-DEMO', recovery: 'Demo only', verified: 'Not connected' }; return }
  security.value = undefined
  const result = await action(() => engine.security(state.activeAccountId))
  if (result) security.value = result
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
async function updateProfile() {
  if (!profileName.value.trim()) return
  await action(async () => { if (isDemo.value) account.value!.name = profileName.value.trim(); else await engine.updateProfile(state.activeAccountId, profileName.value.trim()); notify('Display name updated') })
}
async function startCall() {
  if (isDemo.value) { notify('Connect your Matrix account to start a call'); return }
  const accountId = state.activeAccountId
  const roomId = state.activeRoomId
  const generation = ++callGeneration
  modal.value = 'call'
  await nextTick()
  const result = await action(() => engine.startCall(accountId, roomId, callFrame.value!, () => modal.value = ''))
  if (result) { if (generation !== callGeneration || modal.value !== 'call') result(); else stopCall = result }
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
async function approveVerification(matches: boolean) {
  await action(() => engine.finishVerification(verificationAccount, matches))
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
async function enableNotifications(value: boolean) {
  if (!value) { notifications.value = false; return }
  if (!('Notification' in window)) { state.error = 'This browser does not support desktop notifications.'; return }
  const permission = await Notification.requestPermission()
  notifications.value = permission === 'granted'
  notify(notifications.value ? 'Notifications enabled while Fern is open' : 'Notification permission was not granted')
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
function dropFile(event: DragEvent) { event.preventDefault(); const file = event.dataTransfer?.files[0]; if (file) void upload(file) }
watch(() => [state.activeAccountId, state.activeRoomId], (_value, previous) => {
  if (previous) { const key = `fern.draft.${previous[0]}/${previous[1]}`; if (draft.value) localStorage.setItem(key, draft.value); else localStorage.removeItem(key) }
  draft.value = localStorage.getItem(`fern.draft.${state.activeAccountId}/${state.activeRoomId}`) ?? ''
  reply.value = undefined; edit.value = undefined; endOfHistory.value = false
  void scrollToEnd()
})
watch(draft, value => { const key = `fern.draft.${state.activeAccountId}/${state.activeRoomId}`; if (value) localStorage.setItem(key, value); else localStorage.removeItem(key) })
watch(() => messages.value.at(-1)?.id, (id, previous) => {
  const nearEnd = !timeline.value || timeline.value.scrollHeight - timeline.value.scrollTop - timeline.value.clientHeight < 180
  if (nearEnd || !previous || messages.value.at(-1)?.own) void scrollToEnd()
  const latest = messages.value.at(-1)
  if (notifications.value && latest && !latest.own && id !== previous && document.hidden) new Notification(latest.name, { body: latest.body, icon: `${import.meta.env.BASE_URL}fern.svg` })
})
watch(modal, (value, previous) => {
  if (previous === 'verify' && value !== 'verify' && verificationAccount) void action(() => engine.cancelVerification(verificationAccount))
  if (previous === 'explore') { ++directoryGeneration; directorySession?.stop(); directorySession = undefined }
  if (previous === 'call') { ++callGeneration; stopCall?.(); stopCall = undefined }
  if (previous === 'settings') { recoveryOutput.value = ''; form.value.recoveryKey = '' }
})
watch(compactMessages, value => localStorage.setItem('fern.compact', String(value)))
onMounted(() => { document.addEventListener('keydown', shortcut); void initialize(); void scrollToEnd() })
onUnmounted(() => { document.removeEventListener('keydown', shortcut); stopCall?.(); directorySession?.stop(); void engine.dispose() })
</script>

<template>
<FrappeUIProvider>
  <div class="app-shell" :class="{ 'mobile-conversation': state.mobileRoom, 'with-details': state.details }">
    <nav class="account-rail" aria-label="Accounts and spaces">
      <Button variant="ghost" class="fern-logo" aria-label="Fern home" @click="chooseFilter('all')"><Leaf :size="25"/></Button>
      <div class="rail-separator"/>
      <Button variant="ghost" class="rail-item" :class="{ active: !state.spaceId }" aria-label="All conversations" @click="chooseFilter('all')"><Home :size="20"/></Button>
      <Button v-for="space in spaces" :key="space.id" variant="ghost" class="rail-item space-item" :class="{ active: state.spaceId === space.id }" :aria-label="space.name" :title="space.name" @click="chooseSpace(space)"><span>{{ space.name.split(' ').map(v => v[0]).slice(0, 2).join('') }}</span></Button>
      <Button variant="ghost" class="rail-item" aria-label="Join a room" title="Join a room" @click="open('join')"><Plus :size="20"/></Button>
      <div class="rail-bottom"><Button variant="ghost" class="rail-item" aria-label="Help" @click="open('help')"><CircleHelp :size="20"/></Button><Button v-for="value in state.accounts" :key="value.id" variant="ghost" class="rail-account" :class="{ active: state.activeAccountId === value.id }" :aria-label="`Switch to ${value.name}`" :title="value.userId" @click="switchAccount(value.id)"><UserAvatar :name="value.name" :size="34"/><span v-if="value.connection === 'online'" class="account-online"/></Button><Button variant="ghost" class="rail-item add-account" aria-label="Add account" @click="open('login')"><Plus :size="18"/></Button></div>
    </nav>

    <aside class="room-sidebar" aria-label="Conversations">
      <div class="workspace-header"><Dropdown :options="accountOptions" class="account-menu"><Button variant="ghost" class="workspace-trigger"><span><strong>{{ state.spaceId ? spaces.find(v => v.id === state.spaceId)?.name : 'Your conversations' }}</strong><small>{{ account?.userId }}</small></span><ChevronDown :size="15"/></Button></Dropdown><Dropdown :options="[{ label: 'Create a room', icon: Hash, onClick: () => open('create') }, { label: 'Message someone', icon: MessageCircle, onClick: () => open('dm') }, { label: 'Join a room', icon: Globe, onClick: () => open('join') }, { label: 'Explore public rooms', icon: Search, onClick: () => open('explore') }]"><Button variant="ghost" class="new-conversation" aria-label="New conversation"><Plus :size="20"/></Button></Dropdown></div>
      <div class="sidebar-search"><Search :size="16"/><FormControl v-model="state.roomQuery" type="search" aria-label="Search conversations" placeholder="Find a conversation" variant="subtle"/><kbd>⌘ K</kbd></div>
      <div class="filter-tabs"><Button v-for="tab in [{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'people', label: 'People' }]" :key="tab.value" variant="ghost" :class="{ selected: state.filter === tab.value }" @click="chooseFilter(tab.value)">{{ tab.label }}<span v-if="tab.value === 'unread' && totalUnread" class="filter-count">{{ totalUnread }}</span></Button><Dropdown :options="[{ label: 'Favorites', icon: Star, onClick: () => chooseFilter('favorites') }, { label: 'Invitations', icon: Inbox, onClick: () => chooseFilter('invites') }]"><Button variant="ghost" aria-label="More filters"><ListFilter :size="15"/></Button></Dropdown></div>
      <div class="room-list">
        <template v-for="section in [{ name: 'Favorites', icon: Star, items: favorites }, { name: 'Rooms', icon: Hash, items: channels }, { name: 'Direct messages', icon: MessageCircle, items: people }, { name: 'Invitations', icon: Inbox, items: invites }]" :key="section.name">
          <div v-if="section.items.length" class="section-label"><component :is="section.icon" :size="12"/><span>{{ section.name }}</span><span class="section-count">{{ section.items.length }}</span></div>
          <Button v-for="value in section.items" :key="value.id" variant="ghost" class="room-item" :class="{ selected: state.activeRoomId === value.id, unread: value.unread }" @click="chooseRoom(value)">
            <UserAvatar v-if="value.direct" :name="value.name" :size="36"/><span v-else class="room-icon"><Hash :size="19"/><span v-if="value.encrypted" class="room-lock"><LockKeyhole :size="9"/></span></span>
            <span class="room-item-text"><strong>{{ value.name }}</strong><small>{{ value.preview || 'Start a conversation' }}</small></span><span class="room-item-meta"><time>{{ previewTime(value.timestamp) }}</time><span v-if="value.unread" class="unread-badge" :class="{ mention: value.mentions }">{{ value.mentions ? '@' : value.unread }}</span></span>
          </Button>
        </template>
        <div v-if="!filteredRooms.length" class="sidebar-empty"><Search :size="24"/><strong>No conversations here yet</strong><span>Try another filter or start a room.</span><Button variant="outline" @click="open('create')">Create a room</Button></div>
      </div>
      <div v-if="isDemo" class="demo-card"><span class="demo-icon"><Sparkles :size="17"/></span><div><strong>A little look around</strong><p>You’re exploring the local demo.</p><Button variant="ghost" class="connect-account" @click="open('login')">Connect your account <ArrowUpRight :size="13"/></Button></div></div>
      <div class="sidebar-footer"><Dropdown :options="accountOptions" side="top"><Button variant="ghost" class="profile-trigger"><UserAvatar :name="account?.name ?? 'Guest'" :size="30"/><span><strong>{{ account?.name }}</strong><small><span class="status-dot" :class="account?.connection"/>{{ isDemo ? 'Local demo' : account?.connection }}</small></span></Button></Dropdown><Button variant="ghost" aria-label="Open settings" @click="open('settings')"><Settings :size="18"/></Button></div>
    </aside>

    <main class="conversation" @dragover.prevent @drop="dropFile">
      <template v-if="room">
        <header class="conversation-header"><Button variant="ghost" class="mobile-back" aria-label="Back to conversations" @click="state.mobileRoom = false"><ArrowLeft :size="22"/></Button><span v-if="!room.direct" class="header-room-icon"><Hash :size="25"/></span><UserAvatar v-else :name="room.name" :size="36"/><div class="header-title"><h1>{{ room.name }}<LockKeyhole v-if="room.encrypted" :size="13"/></h1><p>{{ room.topic || (room.direct ? 'A conversation just for you' : 'A space for your conversations') }}</p></div><div class="header-actions"><Button variant="ghost" aria-label="Start room call" @click="startCall"><Video :size="19"/></Button><Button variant="ghost" aria-label="Search messages" :class="{ 'action-active': searchOpen }" @click="searchOpen = !searchOpen"><Search :size="19"/></Button><Button variant="ghost" aria-label="Room members" @click="state.details = true; detailsTab = 'members'"><Users :size="19"/><span class="member-count">{{ room.members }}</span></Button><span class="action-divider"/><Button variant="ghost" aria-label="Room information" :class="{ 'action-active': state.details }" @click="state.details = !state.details"><Info :size="19"/></Button><Dropdown :options="roomOptions" align="end"><Button variant="ghost" aria-label="Room actions"><MoreHorizontal :size="20"/></Button></Dropdown></div></header>
        <div v-if="searchOpen" class="message-search"><Search :size="16"/><FormControl v-model="state.messageQuery" type="search" placeholder="Search loaded messages in this room" aria-label="Search messages"/><span>{{ visibleMessages.length }} results</span><Button variant="ghost" aria-label="Close message search" @click="searchOpen = false; state.messageQuery = ''"><X :size="16"/></Button></div>
        <div v-if="state.error && !modal" class="error-banner" role="alert"><Info :size="16"/><span>{{ state.error }}</span><Button variant="ghost" aria-label="Dismiss error" @click="state.error = ''"><X :size="15"/></Button></div>
        <div v-if="room.membership === 'invited'" class="invite-view"><span class="invite-illustration"><Inbox :size="35"/></span><h2>You’re invited to {{ room.name }}</h2><p>Join the conversation with {{ room.members }} people.</p><div><Button variant="solid" theme="green" @click="acceptInvite(room)">Accept invitation</Button><Button variant="outline" @click="leaveRoom(room)">Decline</Button></div></div>
        <template v-else>
          <div ref="timeline" class="timeline" aria-label="Message history" aria-live="polite"><div class="timeline-inner"><div class="history-control"><Button v-if="!endOfHistory" variant="ghost" :loading="modalBusy" @click="loadEarlier">Load earlier messages</Button><span v-else>This is the beginning of the conversation</span></div><div v-if="state.loading" class="loading-messages">Loading your conversation…</div><div v-if="!state.loading && !visibleMessages.length" class="empty-conversation"><span><MessageCircle :size="30"/></span><h2>{{ state.messageQuery ? 'No messages found' : `Welcome to ${room.name}` }}</h2><p>{{ state.messageQuery ? 'Try a different search. Search covers loaded messages.' : 'Every good conversation starts with a hello.' }}</p></div>
            <template v-for="(message, index) in visibleMessages" :key="message.id"><div v-if="showDate(index)" class="date-divider"><span>{{ dateLabel(message.timestamp) }}</span></div><MessageRow :message="message" :compact="isCompact(index)" @reply="beginReply" @edit="beginEdit" @emoji="showEmoji" @remove="removal = $event; open('remove')"/></template>
          </div></div>
          <div class="composer-area"><div v-if="state.typing.length" class="typing-indicator">{{ state.typing.map(v => v.split(':')[0].replace('@', '')).join(', ') }} {{ state.typing.length === 1 ? 'is' : 'are' }} typing<span>•••</span></div><div v-if="reply || edit" class="composer-context"><span><strong>{{ edit ? 'Editing your message' : `Replying to ${reply?.name}` }}</strong><small>{{ (edit || reply)?.body }}</small></span><Button variant="ghost" aria-label="Cancel reply or edit" @click="reply = undefined; edit = undefined"><X :size="16"/></Button></div><div class="composer"><FormControl ref="composer" v-model="draft" type="textarea" :rows="1" :placeholder="`Message ${room.direct ? room.name : '#' + room.name.toLowerCase()}`" aria-label="Message composer" @keydown="keydown" @input="typingNotice"/><div class="composer-toolbar"><div><Button variant="ghost" aria-label="Attach a file" :disabled="state.busy" @click="fileInput?.click()"><Paperclip :size="19"/></Button><Button variant="ghost" aria-label="Insert emoji" @click="showEmoji()"><Smile :size="19"/></Button><Dropdown :options="[{ label: 'Create a poll', icon: ListFilter, onClick: () => open('poll') }]"><Button variant="ghost" aria-label="More composer actions"><Plus :size="19"/></Button></Dropdown></div><div class="composer-send"><span>Enter to send <span>· Shift + Enter for a new line</span></span><Button variant="solid" theme="green" class="send-button" :disabled="!draft.trim()" :loading="state.busy" aria-label="Send message" @click="submitMessage"><Send :size="16"/></Button></div></div></div><input ref="fileInput" type="file" class="sr-only" tabindex="-1" @change="attach"/><div class="encryption-note"><LockKeyhole v-if="room.encrypted" :size="10"/><Globe v-else :size="10"/><span>{{ isDemo ? 'Local demo · messages stay in this browser' : room.encrypted ? 'This conversation is end-to-end encrypted' : 'This room is not encrypted' }}</span></div></div>
        </template>
      </template>
      <div v-else class="welcome-view"><span class="welcome-logo"><Leaf :size="44"/></span><span class="eyebrow">A LITTLE SPACE TO CONNECT</span><h1>Good conversations.<br/>A quieter home.</h1><p>Choose a conversation, start something new,<br/>or bring your Matrix accounts together.</p><Button variant="solid" theme="green" @click="open('create')">Start a conversation <Plus :size="16"/></Button></div>
    </main>

    <aside v-if="state.details && room" class="details-panel" aria-label="Room details"><header><strong>Room details</strong><Button variant="ghost" aria-label="Close room details" @click="state.details = false"><PanelRightClose :size="18"/></Button></header><div class="details-hero"><span class="details-icon"><Hash v-if="!room.direct" :size="33"/><UserAvatar v-else :name="room.name" :size="58"/></span><h2>{{ room.name }}</h2><p>{{ room.members }} members</p><span class="encrypted-chip"><LockKeyhole v-if="room.encrypted" :size="12"/><Globe v-else :size="12"/>{{ room.encrypted ? 'Encrypted room' : 'Public conversation' }}</span></div><div class="details-tabs"><Button v-for="tab in ['about', 'members', 'files']" :key="tab" variant="ghost" :class="{ selected: detailsTab === tab }" @click="detailsTab = tab">{{ tab }}</Button></div><div class="details-body"><template v-if="detailsTab === 'about'"><span class="detail-label">ABOUT THIS ROOM</span><p>{{ room.topic || 'No topic set yet.' }}</p><span class="detail-label">ROOM ID</span><code>{{ isDemo ? 'Local demonstration room' : room.id }}</code><Button variant="ghost" class="detail-action" @click="toggleFavorite(room)"><Star :size="17"/>{{ room.favorite ? 'Remove from favorites' : 'Add to favorites' }}</Button><Button variant="ghost" class="detail-action" @click="open('invite')"><Users :size="17"/>Invite people</Button><div class="privacy-card"><ShieldCheck :size="22"/><h3>Your space. Your conversation.</h3><p>{{ isDemo ? 'Connect your account to chat securely across the Matrix network.' : room.encrypted ? 'Encryption is handled locally by the Matrix Rust SDK.' : 'Messages in this room can be read by your homeserver.' }}</p></div><Button variant="ghost" theme="red" class="detail-action" @click="open('leave')"><LogOut :size="17"/>Leave room</Button></template><template v-if="detailsTab === 'members'"><div class="members-heading"><span class="detail-label">PEOPLE IN THIS ROOM</span><Button variant="ghost" aria-label="Invite member" @click="open('invite')"><Plus :size="16"/></Button></div><div v-for="member in state.members" :key="member.id" class="member-row"><UserAvatar :name="member.name" :size="34"/><span><strong>{{ member.name }}</strong><small>{{ member.role }}</small></span></div><p v-if="!state.members.length">Members will appear after the room syncs.</p></template><template v-if="detailsTab === 'files'"><span class="detail-label">SHARED IN LOADED MESSAGES</span><Button v-for="message in files" :key="message.id" variant="ghost" class="shared-file" @click="download(message)"><FileText :size="21"/><span>{{ message.attachment?.name }}<small>{{ message.name }}</small></span></Button><p v-if="!files.length">No shared files in this conversation yet.</p></template></div></aside>

    <Transition name="toast"><div v-if="state.toast" class="app-toast" role="status"><Check :size="17"/>{{ state.toast }}</div></Transition>
  </div>

  <Dialog v-model:open="modalOpen" :title="dialogTitle" :size="modal === 'call' ? '5xl' : modal === 'settings' ? '2xl' : 'lg'">
    <div v-if="state.error" class="dialog-error" role="alert">{{ state.error }}</div>
    <form v-if="['login', 'create', 'dm', 'join', 'poll', 'invite'].includes(modal)" class="dialog-form" @submit.prevent="modalSubmit">
      <template v-if="modal === 'login'"><div class="login-description"><span><Leaf :size="24"/></span><p>A home for all your conversations.<br/>Connect any account on a compatible Matrix homeserver.</p></div><FormControl v-model="form.server" label="Homeserver" placeholder="matrix.org" required/><FormControl v-model="form.username" label="Username" placeholder="@you:matrix.org" autocomplete="username" required/><FormControl v-model="form.password" type="password" label="Password" autocomplete="current-password" required/><p class="form-note">Your account and encrypted history are stored on this device. Your server must support password login and native sliding sync.</p></template>
      <template v-if="modal === 'create'"><FormControl v-model="form.name" label="Room name" placeholder="A name for your space" required/><FormControl v-model="form.topic" type="textarea" label="Topic" placeholder="What will you talk about?"/><p class="form-note"><LockKeyhole :size="13"/>New rooms are private and encrypted.</p></template>
      <template v-if="modal === 'dm' || modal === 'invite'"><FormControl v-model="form.invite" label="Matrix user ID" placeholder="@someone:matrix.org" pattern="^@.+:.+$" required/><p class="form-note">{{ modal === 'dm' ? 'Start a private, encrypted conversation.' : 'They’ll receive an invitation to this room.' }}</p></template>
      <template v-if="modal === 'join'"><FormControl v-model="form.alias" label="Room alias or ID" placeholder="#community:matrix.org" required/><p class="form-note">Ask someone for the room’s Matrix alias or ID.</p><Button variant="outline" @click="open('explore')"><Globe :size="15"/>Explore public rooms</Button></template>
      <template v-if="modal === 'poll'"><FormControl v-model="form.question" label="Question" placeholder="What would you like to ask?" required/><FormControl v-model="form.answers" type="textarea" :rows="5" label="Answers" placeholder="One answer per line" required/><p class="form-note">Everyone can choose one answer. Results are visible to the room.</p></template>
      <div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Cancel</Button><Button variant="solid" theme="green" type="submit" :loading="modalBusy">{{ modal === 'login' ? 'Connect account' : modal === 'join' ? 'Join room' : modal === 'poll' ? 'Create poll' : modal === 'invite' ? 'Send invitation' : modal === 'dm' ? 'Start conversation' : 'Create room' }}</Button></div>
    </form>
    <div v-if="modal === 'emoji'" class="emoji-grid"><Button v-for="emoji in emojis" :key="emoji" variant="ghost" :aria-label="`Choose ${emoji}`" @click="pickEmoji(emoji)">{{ emoji }}</Button></div>
    <div v-if="modal === 'search'" class="global-search"><FormControl v-model="globalSearch" type="search" placeholder="Find a room or person…" aria-label="Find a conversation" autofocus/><Button v-for="value in searchResults" :key="value.id" variant="ghost" @click="chooseRoom(value); modal = ''"><Hash v-if="!value.direct" :size="19"/><UserAvatar v-else :name="value.name" :size="26"/><span>{{ value.name }}<small>{{ value.topic || value.preview }}</small></span><ChevronRight :size="16"/></Button><p v-if="!searchResults.length">No matching conversations.</p><small class="form-note">⌘ / Ctrl + K to open · Esc to close</small></div>
    <div v-if="modal === 'remove'" class="confirmation"><p>This will remove your message from the conversation.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Cancel</Button><Button theme="red" variant="solid" @click="removal && remove(removal); modal = ''">Remove message</Button></div></div>
    <div v-if="modal === 'leave'" class="confirmation"><p>You’ll stop receiving messages from this room.</p><div class="dialog-actions"><Button variant="ghost" @click="modal = ''">Stay in room</Button><Button theme="red" variant="solid" @click="room && leaveRoom(room); modal = ''">Leave room</Button></div></div>
    <div v-if="modal === 'settings'" class="settings-layout"><nav><Button v-for="tab in [{ id: 'general', label: 'Appearance', icon: Sun }, { id: 'accounts', label: 'Accounts', icon: Users }, { id: 'security', label: 'Security', icon: ShieldCheck }, { id: 'notifications', label: 'Notifications', icon: Bell }]" :key="tab.id" variant="ghost" :class="{ selected: settingsTab === tab.id }" @click="settingsTab = tab.id; if (tab.id === 'security') loadSecurity()"><component :is="tab.icon" :size="16"/>{{ tab.label }}</Button></nav><div class="settings-content"><template v-if="settingsTab === 'general'"><h3>Make yourself at home</h3><p>Little preferences, a space that feels like you.</p><div class="settings-row"><span><strong>Appearance</strong><small>Choose a color scheme</small></span><FormControl :model-value="colorScheme" type="select" aria-label="Color scheme" :options="[{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }, { label: 'System', value: 'system' }]" @update:model-value="setColorScheme($event as 'light' | 'dark' | 'system')"/></div><div class="settings-row"><span><strong>Compact messages</strong><small>More conversation, less space</small></span><Switch v-model="compactMessages" aria-label="Compact messages"/></div><div class="settings-about"><Leaf :size="19"/><span>Fern <small>0.1.0 · Frappe UI + Matrix Rust SDK</small></span></div></template><template v-if="settingsTab === 'accounts'"><h3>All your accounts. One home.</h3><p>Account stores, drafts, and timelines stay separate.</p><div class="profile-edit"><FormControl v-model="profileName" label="Your display name"/><Button variant="outline" @click="updateProfile">Save</Button></div><div v-for="value in state.accounts" :key="value.id" class="settings-account"><UserAvatar :name="value.name"/><span><strong>{{ value.name }}</strong><small>{{ value.userId }}</small></span><Button variant="outline" :disabled="value.id === state.activeAccountId" @click="switchAccount(value.id)">{{ value.id === state.activeAccountId ? 'Active' : 'Switch' }}</Button></div><Button variant="solid" theme="green" @click="open('login')"><Plus :size="15"/>Add account</Button><Button v-if="!isDemo" variant="ghost" theme="red" @click="signOut(); modal = ''">Sign out of current account</Button></template><template v-if="settingsTab === 'security'"><h3>Your conversations belong to you</h3><p>Encryption runs on your device through the Rust SDK.</p><div class="security-summary"><ShieldCheck :size="28"/><span>{{ isDemo ? 'Local demonstration' : 'Device security' }}<small>{{ security?.verified ?? 'Loading device information…' }}</small></span></div><div v-if="security" class="security-info"><span>Device ID <code>{{ security.deviceId }}</code></span><span>Key recovery <strong>{{ security.recovery }}</strong></span><span v-if="security.fingerprint">Fingerprint <code>{{ security.fingerprint }}</code></span></div><FormControl v-model="form.recoveryKey" type="password" label="Recovery key" placeholder="Enter your existing recovery key" autocomplete="off"/><Button variant="outline" :disabled="!form.recoveryKey.trim()" :loading="modalBusy" @click="recoverKeys">Restore encrypted history</Button><Button variant="outline" @click="startVerification">Verify with another device</Button><Button v-if="security?.recovery === 'Disabled'" variant="outline" :loading="modalBusy" @click="enableRecovery">Set up key recovery</Button><p v-if="recoveryProgress && modalBusy" class="form-note">{{ recoveryProgress }}</p><div v-if="recoveryOutput" class="recovery-output"><strong>Save your recovery key</strong><p>Keep this key somewhere safe. You’ll need it to restore encrypted history on another device.</p><code>{{ recoveryOutput }}</code><Button variant="outline" @click="saveRecoveryKey">Download recovery key</Button></div><p class="form-note">Compare the emoji or numbers on both devices before approving verification.</p></template><template v-if="settingsTab === 'notifications'"><h3>Stay in the conversation</h3><p>Browser notifications work while Fern is open.</p><div class="settings-row"><span><strong>Desktop notifications</strong><small>For new messages in the selected room</small></span><Switch :model-value="notifications" aria-label="Desktop notifications" @update:model-value="enableNotifications(Boolean($event))"/></div><p class="form-note">Background push and per-room notification rules are not yet available.</p></template></div></div>
    <div v-if="modal === 'explore'" class="directory-view"><form @submit.prevent="loadDirectory"><FormControl v-model="directoryQuery" type="search" aria-label="Search public rooms" placeholder="Find a community…"/><Button variant="solid" theme="green" type="submit" :loading="modalBusy">Search</Button></form><p class="form-note">{{ isDemo ? 'Local demo communities' : 'Public rooms on your homeserver' }}</p><div v-for="value in directoryRooms" :key="value.id" class="directory-row"><span class="room-icon"><Hash :size="19"/></span><div><strong>{{ value.name }}</strong><p>{{ value.topic }}</p><small>{{ value.members }} members</small></div><Button variant="outline" @click="joinDirectory(value)">{{ accountRooms.some(item => item.id === value.id) ? 'Open' : 'Join' }}</Button></div><p v-if="!directoryRooms.length && !modalBusy" class="form-note">No rooms found. Try a different search.</p><Button v-if="!directoryEnd" variant="outline" :loading="modalBusy" @click="moreDirectory">Load more rooms</Button></div>
    <div v-if="modal === 'call'" class="call-view"><iframe ref="callFrame" title="Element Call" allow="camera; microphone; display-capture; autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/><p class="form-note">Calls use Element Call and your homeserver’s MatrixRTC service.</p></div>
    <div v-if="modal === 'verify'" class="verification-view"><ShieldCheck :size="38"/><h3>{{ verification.status === 'verified' ? 'Device verified' : verification.status === 'compare' ? 'Do these match?' : 'Check your other device' }}</h3><p v-if="verification.status === 'waiting' || verification.status === 'requested'">Open a verified Matrix client and accept the verification request.</p><p v-if="verification.status === 'accepted' || verification.status === 'comparing'">Waiting for the security comparison…</p><p v-if="verification.status === 'compare'">Compare these with your other device. Only approve if every value matches.</p><div v-if="verification.emojis" class="verification-emojis"><span v-for="emoji in verification.emojis" :key="emoji.description"><strong>{{ emoji.symbol }}</strong><small>{{ emoji.description }}</small></span></div><div v-if="verification.numbers" class="verification-numbers">{{ verification.numbers.join(' · ') }}</div><p v-if="verification.status === 'verified'">Your devices can now trust each other.</p><p v-if="verification.status === 'failed' || verification.status === 'canceled'">Verification {{ verification.status }}. Close this dialog and try again.</p><div class="dialog-actions"><Button v-if="verification.status === 'compare'" theme="red" variant="outline" @click="approveVerification(false)">They don’t match</Button><Button v-if="verification.status === 'compare'" variant="solid" theme="green" @click="approveVerification(true)">They match</Button><Button v-else variant="outline" @click="modal = ''">{{ verification.status === 'verified' ? 'Done' : 'Close' }}</Button></div></div>
    <div v-if="modal === 'help'" class="help-content"><span class="welcome-logo"><Leaf :size="35"/></span><h2>A calmer place to connect.</h2><p>Fern brings the Frappe UI design language to Matrix, with Cinny-inspired spaces and account navigation.</p><p>The demo is local. Connect an account for real encrypted messaging, room management, reactions, files, and polls.</p><div class="help-shortcuts"><span>Find a conversation <kbd>Ctrl / ⌘ K</kbd></span><span>Send a message <kbd>Enter</kbd></span><span>New line <kbd>Shift Enter</kbd></span></div><p class="form-note">Early development: QR / OIDC login, threads, background push, and full Element X parity remain on the roadmap.</p><Button variant="solid" theme="green" @click="open('login')">Connect your account <ArrowUpRight :size="15"/></Button></div>
  </Dialog>
</FrappeUIProvider>
</template>
