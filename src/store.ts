import { reactive, computed, watch } from 'vue'
import { demoAccounts, demoRooms, demoMembers, initialDemoMessages } from './demo'
import type { Account, Room, Message, Member } from './types'
import { MatrixEngine } from './sdk/engine'
const demoKey = 'fern.demo.v1'
function readDemo(): { rooms?: Room[]; messages?: Record<string, Message[]> } {
  try { return JSON.parse(localStorage.getItem(demoKey) ?? '{}') } catch { return {} }
}
const saved = readDemo()
export const state = reactive({
  accounts: structuredClone(demoAccounts), rooms: saved.rooms ?? structuredClone(demoRooms),
  messages: saved.messages ?? {} as Record<string, Message[]>, activeAccountId: 'demo-home', activeRoomId: 'general',
  filter: 'all', spaceId: '', roomQuery: '', messageQuery: '', typing: [] as string[], members: [] as Member[],
  loading: false, busy: false, error: '', mobileRoom: false, details: false, toast: '',
})
export const account = computed(() => state.accounts.find(item => item.id === state.activeAccountId))
export const room = computed(() => state.rooms.find(item => item.id === state.activeRoomId && item.accountId === state.activeAccountId))
export const isDemo = computed(() => account.value?.connection === 'demo')
export const messageKey = (accountId: string, roomId: string) => `${accountId}/${roomId}`
export const messages = computed(() => state.messages[messageKey(state.activeAccountId, state.activeRoomId)] ?? [])
export const visibleMessages = computed(() => messages.value.filter(message => !state.messageQuery || `${message.body} ${message.name} ${message.attachment?.name ?? ''}`.toLowerCase().includes(state.messageQuery.toLowerCase())))
export const accountRooms = computed(() => state.rooms.filter(item => item.accountId === state.activeAccountId && item.membership !== 'left'))
export const filteredRooms = computed(() => accountRooms.value.filter(item => {
  if (item.space) return false
  if (state.spaceId && item.parent !== state.spaceId && !item.parents?.includes(state.spaceId)) return false
  if (state.filter === 'unread' && !item.unread) return false
  if (state.filter === 'people' && !item.direct) return false
  if (state.filter === 'favorites' && !item.favorite) return false
  if (state.filter === 'invites' && item.membership !== 'invited') return false
  return item.name.toLowerCase().includes(state.roomQuery.toLowerCase())
}))
export const totalUnread = computed(() => accountRooms.value.reduce((total, item) => total + item.unread, 0))
let toastTimer: ReturnType<typeof setTimeout>
export function notify(text: string) { state.toast = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => state.toast = '', 4000) }
export async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
  state.error = ''
  try { return await fn() } catch (error) { state.error = error instanceof Error ? error.message : String(error); return undefined }
}
export const engine = new MatrixEngine({
  account(value) {
    const index = state.accounts.findIndex(item => item.id === value.id)
    if (index >= 0) state.accounts[index] = value
    else state.accounts.push(value)
  },
  rooms(id, values) { state.rooms = [...state.rooms.filter(item => item.accountId !== id), ...values] },
  error(id, error) { if (state.activeAccountId === id) state.error = error },
})
let stopWatching: (() => void) | undefined
let watchGeneration = 0
let typingAt = 0
export async function selectRoom(value: Room) {
  const generation = ++watchGeneration
  stopWatching?.(); stopWatching = undefined
  state.activeRoomId = value.id; state.mobileRoom = true; state.messageQuery = ''; state.typing = []; state.members = []
  state.loading = false
  if (account.value?.connection === 'demo') {
    const key = messageKey(value.accountId, value.id)
    state.messages[key] ??= initialDemoMessages(value)
    state.members = structuredClone(demoMembers)
    value.unread = 0; value.mentions = 0
    return
  }
  if (value.membership !== 'joined') return
  state.loading = true
  await action(async () => {
    const stop = await engine.watchRoom(value.accountId, value.id, updated => {
      state.messages[messageKey(value.accountId, value.id)] = updated
      if (generation === watchGeneration) state.loading = false
    }, users => { if (generation === watchGeneration) state.typing = users })
    if (generation !== watchGeneration) { stop(); return }
    stopWatching = stop
    await engine.markRead(value.accountId, value.id)
    const members = await engine.members(value.accountId, value.id)
    if (generation === watchGeneration) state.members = members
  })
  if (generation === watchGeneration) state.loading = false
}
export function switchAccount(id: string) {
  if (id === state.activeAccountId) return
  ++watchGeneration; stopWatching?.(); stopWatching = undefined
  state.activeAccountId = id; state.activeRoomId = ''; state.spaceId = ''; state.filter = 'all'; state.error = ''; state.details = false; state.mobileRoom = false; state.typing = []; state.members = []
  const first = accountRooms.value.find(item => !item.space && item.membership === 'joined')
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
    if (isDemo.value) {
      if (edit) { edit.body = body; edit.edited = true }
      else state.messages[key].push(localMessage(body, { replyId: reply?.id, replyBody: reply?.body }))
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
    } else await engine.upload(target.accountId, target.id, file)
  })
  state.busy = false
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
export async function leaveRoom(value: Room) {
  await action(async () => {
    if (!isDemo.value) await engine.leave(value.accountId, value.id)
    else value.membership = 'left'
    if (state.activeRoomId === value.id) { ++watchGeneration; stopWatching?.(); stopWatching = undefined; state.activeRoomId = ''; state.mobileRoom = false }
    notify('You left the room')
  })
}
export async function createPoll(question: string, answers: string[]) {
  return action(async () => {
    if (!room.value) return false
    if (isDemo.value) state.messages[messageKey(state.activeAccountId, state.activeRoomId)].push(localMessage(question, { kind: 'poll', poll: { question, answers: answers.map(text => ({ id: crypto.randomUUID(), text, count: 0 })) } }))
    else await engine.poll(state.activeAccountId, state.activeRoomId, question, answers)
    return true
  })
}
export async function vote(message: Message, answerId: string) {
  if (!message.poll) return
  if (!isDemo.value) { await action(() => engine.vote(state.activeAccountId, state.activeRoomId, message.id, answerId)); return }
  const previous = message.poll.answers.find(answer => answer.id === message.poll?.voted)
  if (previous) previous.count--
  message.poll.voted = answerId
  message.poll.answers.find(answer => answer.id === answerId)!.count++
}
export function typingNotice() {
  if (isDemo.value || !room.value || Date.now() - typingAt < 4000) return
  typingAt = Date.now(); void action(() => engine.typing(state.activeAccountId, state.activeRoomId, true))
}
export async function signIn(server: string, username: string, password: string) {
  state.busy = true
  const id = await action(() => engine.login(server, username, password))
  state.busy = false
  if (id) { switchAccount(id); notify('Account connected') }
  return id
}
export async function signOut() {
  const id = state.activeAccountId
  if (isDemo.value) { notify('This is a demo account. Connect a Matrix account to sign in.'); return }
  await action(async () => {
    await engine.logout(id)
    state.accounts = state.accounts.filter(value => value.id !== id)
    state.rooms = state.rooms.filter(value => value.accountId !== id)
    for (const key of Object.keys(state.messages)) if (key.startsWith(`${id}/`)) delete state.messages[key]
    switchAccount('demo-home'); notify('Signed out of this account')
  })
}
watch(() => ({ rooms: state.rooms.filter(value => value.accountId.startsWith('demo-')), messages: Object.fromEntries(Object.entries(state.messages).filter(([key]) => key.startsWith('demo-')).map(([key, values]) => [key, values.filter(value => !value.attachment?.url?.startsWith('blob:'))])) }), value => {
  try { localStorage.setItem(demoKey, JSON.stringify(value)) } catch { /* Storage quota does not block chatting. */ }
}, { deep: true })
void selectRoom(room.value!); state.mobileRoom = false
export async function initialize() { await action(() => engine.restoreAll()) }
