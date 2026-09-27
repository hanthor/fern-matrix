import type { ClientInterface, Session, SyncServiceInterface, TaskHandleInterface, RoomInterface, TimelineInterface, TimelineItemInterface, EventTimelineItem, MediaSourceInterface, SessionVerificationControllerInterface, RoomListEntriesWithDynamicAdaptersResultInterface, RoomDescription } from './generated/matrix_sdk_ffi'
import type { Account, Room, Message, Member, DirectoryRoom } from '../types'
import { applyDiffs } from '../diff'

type Bindings = typeof import('./index')
let bindingPromise: Promise<Bindings> | undefined
export function loadSdk(): Promise<Bindings> {
  return bindingPromise ??= import('./index').then(async sdk => {
    await sdk.uniffiInitAsync()
    sdk.initPlatform({ logLevel: sdk.LogLevel.Warn, traceLogPacks: [], extraTargets: [], writeToStdoutOrSystem: false, writeToFiles: undefined }, true)
    return sdk
  }).catch(error => { bindingPromise = undefined; throw error })
}
interface SavedAccount { session: Session; storeId: string; passphrase: string }
const STORAGE_KEY = 'fern.sessions.v1'
function savedAccounts(): Record<string, SavedAccount> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('Saved sessions could not be read. Clear site data only if you have a recovery key.') }
}
function saveAccount(id: string, data: SavedAccount) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedAccounts(), [id]: data }))
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
export class MatrixEngine {
  private clients = new Map<string, ClientInterface>()
  private syncs = new Map<string, SyncServiceInterface>()
  private handles = new Map<string, TaskHandleInterface[]>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private refreshes = new Set<string>()
  private timelineCache = new Map<string, TimelineInterface>()
  private eventCache = new Map<string, EventTimelineItem>()
  private media = new Map<string, MediaSourceInterface>()
  private objectUrls = new Map<string, string>()
  private roomLists = new Map<string, RoomListEntriesWithDynamicAdaptersResultInterface>()
  private verificationControllers = new Map<string, SessionVerificationControllerInterface>()
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
  private async builder(data: SavedAccount, discover: boolean) {
    const sdk = await loadSdk()
    let builder = new sdk.ClientBuilder()
      .indexeddbStore(new sdk.IndexedDbStoreBuilder(`fern-${data.storeId}`).passphrase(data.passphrase))
      .backupDownloadStrategy(sdk.BackupDownloadStrategy.AfterDecryptionFailure)
      .setSessionDelegate({
        retrieveSessionFromKeychain: userId => {
          const entry = Object.values(savedAccounts()).find(value => value.session.userId === userId && value.storeId === data.storeId)
          if (!entry) throw new Error('Session was removed from this device.')
          return sdk.Session.new(entry.session)
        },
        saveSessionInKeychain: session => {
          data.session = session
          // Refreshes are persisted only after this login has been committed.
          if (savedAccounts()[data.storeId]) saveAccount(data.storeId, data)
        },
      })
    if (discover) builder = builder.slidingSyncVersionBuilder(sdk.SlidingSyncVersionBuilder.DiscoverNative)
    return builder
  }
  async login(server: string, username: string, password: string) {
    const sdk = await loadSdk()
    const passphrase = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const data: SavedAccount = { storeId: crypto.randomUUID(), passphrase, session: undefined as unknown as Session }
    const client = await (await this.builder(data, true)).serverNameOrHomeserverUrl(server).build()
    await client.login(username, password, 'Fern', undefined)
    if (client.slidingSyncVersion() !== sdk.SlidingSyncVersion.Native) {
      await client.logout()
      throw new Error('Fern currently requires a homeserver with native sliding sync.')
    }
    data.session = client.session()
    saveAccount(data.storeId, data)
    await this.attach(client, data.storeId)
    return data.storeId
  }
  async restoreAll() {
    const entries = Object.entries(savedAccounts())
    await Promise.allSettled(entries.map(async ([id, data]) => {
      const account: Account = { id, userId: data.session.userId, name: data.session.userId.split(':')[0].slice(1), color: '#477962', connection: 'connecting' }
      this.events.account(account)
      try {
        const sdk = await loadSdk()
        const client = await (await this.builder(data, false)).homeserverUrl(data.session.homeserverUrl).build()
        await client.restoreSession(sdk.Session.new(data.session))
        await this.attach(client, id)
      } catch (error) { this.events.account({ ...account, connection: 'error', error: errorText(error) }); this.events.error(id, errorText(error)) }
    }))
  }
  private async attach(client: ClientInterface, id: string) {
    this.clients.set(id, client)
    const account: Account = { id, userId: client.userId(), name: client.userId().split(':')[0].slice(1), color: '#477962', connection: 'connecting' }
    this.events.account(account)
    const sync = await client.syncService().withOfflineMode().finish()
    this.syncs.set(id, sync)
    const handles: TaskHandleInterface[] = []
    this.handles.set(id, handles)
    handles.push(sync.state({ onUpdate: state => {
      this.events.account({ ...account, connection: state === 1 ? 'online' : state === 3 ? 'error' : state === 4 ? 'offline' : 'connecting' })
      void this.refreshRooms(id)
    } }))
    const delegate = client.setDelegate({ didReceiveAuthError: () => this.events.account({ ...account, connection: 'error', error: 'Session expired. Sign in again.' }) })
    if (delegate) handles.push(delegate)
    const sdk = await loadSdk()
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
    this.timers.set(id, setInterval(() => void this.refreshRooms(id), 4000))
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
          return { id: info.id, accountId, name: info.displayName ?? info.id, topic: info.topic ?? '', direct: info.isDirect, space: info.isSpace, encrypted: info.encryptionState === sdk.EncryptionState.Encrypted, favorite: info.isFavourite, unread: Number(info.numUnreadNotifications), mentions: Number(info.numUnreadMentions), members: Number(info.activeMembersCount), preview: preview?.body ?? '', timestamp: preview?.timestamp ?? 0, parents: parents.map(parent => parent.roomId), membership: info.membership === sdk.Membership.Invited ? 'invited' : info.membership === sdk.Membership.Left ? 'left' : 'joined' } satisfies Room
        }))
        for (const value of batch) if (value.status === 'fulfilled') rooms.push(value.value)
      }
      if (this.alive && this.clients.has(accountId)) this.events.rooms(accountId, rooms)
    } catch (error) { this.events.error(accountId, errorText(error)) }
    finally { this.refreshes.delete(accountId) }
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
    if (event.content.tag !== 'MsgLike') { result.body = event.content.tag.replace(/([A-Z])/g, ' $1').trim(); return result }
    const content = event.content.inner.content
    result.reactions = content.reactions.map(reaction => ({ key: reaction.key, count: reaction.senders.length, own: reaction.senders.some(sender => sender.senderId === this.getClient(accountId).userId()) }))
    result.replyId = content.inReplyTo?.eventId()
    const kind = content.kind
    if (kind.tag === 'Message') {
      const message = kind.inner.content
      result.body = message.body
      result.edited = message.isEdited
      result.kind = 'text'
      const type = message.msgType
      if (type.tag === 'Image' || type.tag === 'File' || type.tag === 'Audio' || type.tag === 'Video') {
        const media = type.inner.content
        result.kind = type.tag.toLowerCase() as Message['kind']
        result.attachment = { name: media.filename, size: Number(media.info?.size ?? 0), mime: media.info?.mimetype ?? 'application/octet-stream', url: this.objectUrls.get(cacheKey) }
        this.media.set(cacheKey, media.source)
      }
    } else if (kind.tag === 'Poll') {
      result.kind = 'poll'
      result.body = kind.inner.question
      // SDK poll results map answer IDs to voter IDs, rather than users to answers.
      const userId = this.getClient(accountId).userId()
      result.poll = { question: kind.inner.question, answers: kind.inner.answers.map(answer => ({ id: answer.id, text: answer.text, count: kind.inner.votes.get(answer.id)?.length ?? 0 })), voted: [...kind.inner.votes].find(([, voters]) => voters.includes(userId))?.[0] }
    } else if (kind.tag === 'Redacted') result.body = 'Message removed'
    else if (kind.tag === 'UnableToDecrypt') result.body = 'Unable to decrypt this message. Restore your recovery key in Security settings.'
    else result.body = kind.tag
    return result
  }
  async watchRoom(accountId: string, roomId: string, onMessages: (messages: Message[]) => void, onTyping: (users: string[]) => void): Promise<() => void> {
    const room = this.getRoom(accountId, roomId)
    await this.syncs.get(accountId)?.roomListService().subscribeToRooms([roomId])
    const timeline = await room.timeline()
    this.timelineCache.set(`${accountId}/${roomId}`, timeline)
    let items: TimelineItemInterface[] = []
    const handle = await timeline.addListener({ onUpdate: updates => {
      items = applyDiffs(items, updates)
      const messages: Message[] = []
      for (const item of items) { const event = item.asEvent(); if (event) messages.push(this.parseEvent(accountId, roomId, event)) }
      onMessages(messages)
    } })
    const typing = room.subscribeToTypingNotifications({ call: users => onTyping(users.filter(user => user !== room.ownUserId())) })
    return () => { handle.cancel(); typing.cancel() }
  }
  private async timeline(accountId: string, roomId: string) {
    const key = `${accountId}/${roomId}`
    const cached = this.timelineCache.get(key)
    if (cached) return cached
    const timeline = await this.getRoom(accountId, roomId).timeline()
    this.timelineCache.set(key, timeline)
    return timeline
  }
  async send(accountId: string, roomId: string, body: string, replyId?: string, editId?: string) {
    const sdk = await loadSdk()
    const timeline = await this.timeline(accountId, roomId)
    const content = timeline.createMessageContent(new sdk.MessageType.Text({ content: { body, formatted: undefined } }))
    if (!content) throw new Error('The message could not be created.')
    if (editId) await timeline.edit(this.eventCache.get(`${accountId}/${roomId}/${editId}`)!.eventOrTransactionId, new sdk.EditedContent.RoomMessage({ content }))
    else if (replyId) await timeline.sendReply(content, replyId)
    else await timeline.send(content)
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
  async upload(accountId: string, roomId: string, file: File) {
    const sdk = await loadSdk()
    const timeline = await this.timeline(accountId, roomId)
    const params = { source: new sdk.UploadSource.Data({ bytes: await file.arrayBuffer(), filename: file.name }), caption: undefined, formattedCaption: undefined, mentions: undefined, inReplyTo: undefined }
    await timeline.sendFile(params, { mimetype: file.type || 'application/octet-stream', size: BigInt(file.size), thumbnailInfo: undefined, thumbnailSource: undefined }).join()
  }
  async download(accountId: string, roomId: string, message: Message) {
    const key = `${accountId}/${roomId}/${message.id}`
    const cached = this.objectUrls.get(key)
    if (cached) return cached
    const source = this.media.get(key)
    if (!source) throw new Error('This attachment has not finished syncing.')
    const bytes = await this.getClient(accountId).getMediaContent(source)
    // Never execute downloaded HTML/SVG as a document on this origin.
    const mime = message.attachment?.mime ?? 'application/octet-stream'
    const safeMime = /^(image\/(png|jpeg|webp|gif)|audio\/|video\/)/.test(mime) ? mime : 'application/octet-stream'
    const url = URL.createObjectURL(new Blob([bytes], { type: safeMime }))
    this.objectUrls.set(key, url)
    return url
  }
  async paginate(accountId: string, roomId: string) { return (await this.timeline(accountId, roomId)).paginateBackwards(40) }
  async markRead(accountId: string, roomId: string) { const sdk = await loadSdk(); await this.getRoom(accountId, roomId).markAsRead(sdk.ReceiptType.Read) }
  async typing(accountId: string, roomId: string, value: boolean) { await this.getRoom(accountId, roomId).typingNotice(value) }
  async favorite(accountId: string, roomId: string, value: boolean) { await this.getRoom(accountId, roomId).setIsFavourite(value, undefined); await this.refreshRooms(accountId) }
  async join(accountId: string, alias: string) { const room = await this.getClient(accountId).joinRoomByIdOrAlias(alias, []); await this.refreshRooms(accountId); return room.id() }
  async leave(accountId: string, roomId: string) { await this.getRoom(accountId, roomId).leave(); await this.refreshRooms(accountId) }
  async decline(accountId: string, roomId: string) { await this.getRoom(accountId, roomId).leave(); await this.refreshRooms(accountId) }
  async createRoom(accountId: string, name: string, topic: string, invite?: string) {
    const sdk = await loadSdk()
    const id = await this.getClient(accountId).createRoom(sdk.CreateRoomParameters.new({ name, topic, isEncrypted: true, isDirect: Boolean(invite), visibility: new sdk.RoomVisibility.Private(), preset: sdk.RoomPreset.PrivateChat, invite: invite ? [invite] : undefined }))
    await this.getClient(accountId).awaitRoomRemoteEcho(id)
    await this.refreshRooms(accountId)
    return id
  }
  async members(accountId: string, roomId: string): Promise<Member[]> {
    const iterator = await this.getRoom(accountId, roomId).members()
    const members: Member[] = []
    for (let chunk = iterator.nextChunk(100); chunk; chunk = iterator.nextChunk(100)) {
      if (!chunk.length) break
      members.push(...chunk.map(member => ({ id: member.userId, name: member.displayName ?? member.userId, role: String(member.suggestedRoleForPowerLevel) })))
    }
    return members
  }
  async invite(accountId: string, roomId: string, userId: string) { await this.getRoom(accountId, roomId).inviteUserById(userId) }
  async poll(accountId: string, roomId: string, question: string, answers: string[]) { const sdk = await loadSdk(); await (await this.timeline(accountId, roomId)).createPoll(question, answers, 1, sdk.PollKind.Disclosed) }
  async vote(accountId: string, roomId: string, eventId: string, answer: string) { await (await this.timeline(accountId, roomId)).sendPollResponse(eventId, [answer]) }
  async pin(accountId: string, roomId: string, eventId: string) { await (await this.timeline(accountId, roomId)).pinEvent(eventId) }
  async security(accountId: string) {
    const sdk = await loadSdk()
    const client = this.getClient(accountId)
    const encryption = client.encryption()
    return { deviceId: client.deviceId(), fingerprint: await encryption.ed25519Key(), recovery: sdk.RecoveryState[encryption.recoveryState()], verified: sdk.VerificationState[encryption.verificationState()] }
  }
  async recover(accountId: string, key: string) { await this.getClient(accountId).encryption().recover(key) }
  async searchDirectory(accountId: string, query: string, update: (rooms: DirectoryRoom[]) => void) {
    const directory = this.getClient(accountId).roomDirectorySearch()
    let entries: RoomDescription[] = []
    const handle = await directory.results({ onUpdate: updates => {
      entries = applyDiffs(entries, updates)
      update(entries.map(entry => ({ id: entry.roomId, name: entry.name ?? entry.alias ?? entry.roomId, topic: entry.topic ?? '', members: Number(entry.joinedMembers), alias: entry.alias })))
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
  async startCall(accountId: string, roomId: string, iframe: HTMLIFrameElement, close: () => void): Promise<() => void> {
    const sdk = await loadSdk()
    const client = this.getClient(accountId)
    const room = this.getRoom(accountId, roomId)
    if (!await client.isLivekitRtcSupported()) throw new Error('This homeserver does not advertise MatrixRTC support.')
    const callUrl = new URL(import.meta.env.VITE_ELEMENT_CALL_URL || 'https://call.element.io')
    if (callUrl.protocol !== 'https:' && callUrl.origin !== location.origin) throw new Error('The calling service must use HTTPS.')
    const widgetId = `fern-call-${crypto.randomUUID()}`
    const settings = sdk.newVirtualElementCallWidget(sdk.VirtualElementCallWidgetProperties.new({
      elementCallUrl: callUrl.href, widgetId, parentUrl: location.origin, encryption: new sdk.EncryptionSystem.PerParticipantKeys(),
    }), sdk.VirtualElementCallWidgetConfig.new({ intent: sdk.Intent.StartCall, skipLobby: false }))
    const url = await sdk.generateWebviewUrl(settings, room, { clientId: 'org.fern.matrix', languageTag: navigator.language, theme: document.documentElement.dataset.theme || 'light' })
    const widgetOrigin = new URL(url).origin
    const { driver, handle } = sdk.makeWidgetDriver(settings)
    const abort = new AbortController()
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== widgetOrigin || event.source !== iframe.contentWindow || !event.data || event.data.widgetId !== widgetId) return
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
          driver.run(room, { acquireCapabilities: () => sdk.getElementCallRequiredPermissions(client.userId(), client.deviceId()) }, { signal: abort.signal }),
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
  async startVerification(accountId: string, update: (value: { status: string; emojis?: { symbol: string; description: string }[]; numbers?: number[] }) => void) {
    const controller = await this.getClient(accountId).getSessionVerificationController()
    this.verificationControllers.set(accountId, controller)
    controller.setDelegate({
      didReceiveVerificationRequest: () => update({ status: 'requested' }),
      didAcceptVerificationRequest: () => { update({ status: 'accepted' }); void controller.startSasVerification().catch(error => this.events.error(accountId, errorText(error))) },
      didStartSasVerification: () => update({ status: 'comparing' }),
      didReceiveVerificationData: data => {
        if (data.tag === 'Emojis') update({ status: 'compare', emojis: data.inner.emojis.map(emoji => ({ symbol: emoji.symbol(), description: emoji.description() })) })
        else update({ status: 'compare', numbers: data.inner.values })
      },
      didFail: () => update({ status: 'failed' }), didCancel: () => update({ status: 'canceled' }), didFinish: () => update({ status: 'verified' }),
    })
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
    if (controller) { await controller.cancelVerification(); controller.setDelegate(undefined); this.verificationControllers.delete(accountId) }
  }
  async logout(accountId: string) {
    await this.getClient(accountId).logout()
    await this.syncs.get(accountId)?.stop()
    this.handles.get(accountId)?.forEach(handle => handle.cancel())
    clearInterval(this.timers.get(accountId))
    this.roomLists.delete(accountId); this.verificationControllers.get(accountId)?.setDelegate(undefined); this.verificationControllers.delete(accountId);
    this.clients.delete(accountId); this.syncs.delete(accountId); this.handles.delete(accountId); this.timers.delete(accountId)
    const entries = savedAccounts(); delete entries[accountId]; localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    for (const [key, url] of this.objectUrls) if (key.startsWith(`${accountId}/`)) { URL.revokeObjectURL(url); this.objectUrls.delete(key) }
    for (const map of [this.timelineCache, this.eventCache, this.media]) for (const key of map.keys()) if (key.startsWith(`${accountId}/`)) map.delete(key)
  }
  async dispose() {
    this.alive = false
    for (const controller of this.verificationControllers.values()) controller.setDelegate(undefined)
    for (const timer of this.timers.values()) clearInterval(timer)
    for (const handles of this.handles.values()) handles.forEach(handle => handle.cancel())
    await Promise.allSettled([...this.syncs.values()].map(sync => sync.stop()))
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url)
  }
}
