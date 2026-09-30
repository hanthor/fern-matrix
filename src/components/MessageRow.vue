<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Button, Dropdown, Tooltip } from 'frappe-ui'
import { Reply, SmilePlus, MoreHorizontal, FileText, Download, CheckCheck, Pencil, Pin, Trash2, Copy, MessageSquare, Play, MapPin, Forward, Share2, Flag } from 'lucide-vue-next'
import UserAvatar from './UserAvatar.vue'
import type { Message } from '../types'
import { sanitizeHtml, linkifyText, stripReplyFallback, parsePermalink } from '../format'
import { react, vote, withdrawVote, endPoll, canEndPoll, download, peekAttachment, notify, state, action, retrySend, discardSend, avatarUrl, threadUnread, mapProvider, pinMessage, beginForward, shareMessage } from '../store'
import { formatVoiceDuration } from '../voice'
import { formatGeoUri, locationTextAlternative, mapLinkFor } from '../location'
import { forwardBlockReason } from '../forward'
import { HOLD_MS, HOLD_SLOP, SWIPE_REPLY_NEAR_DX, SWIPE_RESISTANCE, SWIPE_TRACK, holdIntent, swipeReplyIntent } from '../gestures'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
// Swipe-to-reply (#44): observe only, never preventDefault or capture, so
// vertical scrolling, taps and links keep working. touch-action: pan-y (below)
// hands vertical motion to the browser; a leftward drag past the intent
// thresholds replies on release.
const swipeX = ref(0)
const swiping = ref(false)
const swipeArmed = ref(false)
// Distance-linked reveal for the reply hint: 0 at rest, 1 at the tracking
// depth, following Telegram's fade-in arrow behind the dragged bubble.
const swipeReveal = computed(() => Math.min(1, -swipeX.value / SWIPE_TRACK))
let swipeStart: { x: number; y: number; t: number; id: number } | undefined
function swipeDown(event: PointerEvent) {
  if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
  if ((event.target as HTMLElement).closest?.('a,button,input,audio,video,img')) return
  swipeStart = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
}
function swipeMove(event: PointerEvent) {
  if (!swipeStart || event.pointerId !== swipeStart.id) return
  const dx = event.clientX - swipeStart.x
  const dy = event.clientY - swipeStart.y
  if (!swiping.value) {
    if (dx > -12) return
    if (Math.abs(dy) > -dx) { swipeStart = undefined; return }
    swiping.value = true
  }
  // Rubber-band: full tracking to the reply zone, damped beyond it, so the
  // bubble follows without sliding off. The release intent still uses the
  // raw travel, so thresholds are unaffected by the damping.
  const raw = Math.min(0, dx)
  swipeX.value = raw >= -SWIPE_TRACK ? raw : -SWIPE_TRACK + (raw + SWIPE_TRACK) * SWIPE_RESISTANCE
  if (!swipeArmed.value && dx <= -SWIPE_REPLY_NEAR_DX) { swipeArmed.value = true; navigator.vibrate?.(10) }
}
function swipeEnd(event: PointerEvent, cancel = false) {
  if (!swipeStart || event.pointerId !== swipeStart.id) return
  const dx = event.clientX - swipeStart.x
  const dy = event.clientY - swipeStart.y
  const dt = performance.now() - swipeStart.t
  swipeStart = undefined
  // Resetting to zero with the drag class removed lets the CSS transition
  // spring the row back; the transition is disabled mid-drag for 1:1 follow.
  swipeX.value = 0
  const active = swiping.value
  swiping.value = false
  swipeArmed.value = false
  if (!cancel && active && swipeReplyIntent(dx, dy, dt)) emit('reply', props.message)
}
// Long-press opens the hover-button menu: the touch path for message actions
// on phones (right-click arrives as contextmenu on desktop, the manual timer
// covers engines that never fire contextmenu for a stationary touch). Opening
// goes through the row's own menu trigger so there is exactly one menu and no
// extra trigger attributes leak onto the row. Long-pressing a link opens the
// message menu rather than the link menu, matching native chat apps.
const root = ref<HTMLElement | null>(null)
function openMenu() {
  clearHold()
  root.value?.querySelector<HTMLButtonElement>('button.row-menu-trigger')?.click()
}
let holdTimer: ReturnType<typeof setTimeout> | undefined
let holdStart: { x: number; y: number } | undefined
let holdDrift = 0
function clearHold() {
  if (holdTimer !== undefined) { clearTimeout(holdTimer); holdTimer = undefined }
  holdStart = undefined
  holdDrift = 0
}
function pressDown(event: PointerEvent) {
  swipeDown(event)
  if (event.pointerType === 'mouse' || !event.isPrimary) return
  if ((event.target as HTMLElement).closest?.('a,button,input,audio,video,img')) return
  holdStart = { x: event.clientX, y: event.clientY }
  holdDrift = 0
  holdTimer = setTimeout(() => {
    holdTimer = undefined
    if (holdIntent(HOLD_MS, holdDrift)) openMenu()
    holdStart = undefined
  }, HOLD_MS)
}
function pressMove(event: PointerEvent) {
  swipeMove(event)
  if (holdStart) holdDrift = Math.max(holdDrift, Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y))
  if (holdDrift > HOLD_SLOP) clearHold()
}
function pressEnd(event: PointerEvent, cancel = false) { clearHold(); swipeEnd(event, cancel) }
onBeforeUnmount(clearHold)
const props = defineProps<{ message: Message; compact?: boolean; roomId?: string; position?: number; total?: number }>()
const emit = defineEmits<{ reply: [message: Message]; edit: [message: Message]; remove: [message: Message]; emoji: [message: Message]; link: [href: string]; thread: [message: Message]; report: [message: Message] }>()
const threadNew = computed(() => props.message.threadReplies === undefined || !props.roomId
  ? 0
  : threadUnread(state.activeAccountId, props.roomId, props.message.id, props.message.threadReplies))
const threadLabel = computed(() => {
  const total = props.message.threadReplies ?? 0
  const replies = total === 1 ? t('message.threadOne') : t('message.threadMany', { total })
  return threadNew.value ? `${t('message.threadIn', { replies })}, ${t('message.threadNew', { count: threadNew.value })}` : t('message.threadIn', { replies })
})
const renderedBody = computed(() => props.message.formattedBody
  ? sanitizeHtml(props.message.formattedBody)
  : linkifyText(stripReplyFallback(props.message.body)))
function onBodyClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest?.('a')
  const href = anchor?.getAttribute('href') ?? ''
  if (!href || !parsePermalink(href)) return
  event.preventDefault()
  emit('link', href)
}
const time = computed(() => new Date(props.message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
const avatar = computed(() => avatarUrl(state.activeAccountId, props.message.sender))
const totalVotes = computed(() => props.message.poll?.answers.reduce((total, answer) => total + answer.count, 0) ?? 0)
const options = computed(() => [
  { label: t('message.menuReply'), icon: Reply, onClick: () => emit('reply', props.message) },
  { label: t('message.menuCopy'), icon: Copy, onClick: () => action(async () => { await navigator.clipboard.writeText(props.message.body); notify('Message copied') }) },
  { label: t('message.menuPin'), icon: Pin, onClick: () => action(async () => { await pinMessage(props.message); notify('Message pinned') }) },
  ...(forwardBlockReason(props.message)
    ? [{ label: t('message.menuForward'), icon: Forward, disabled: true, description: forwardBlockReason(props.message) }]
    : [{ label: t('message.menuForward'), icon: Forward, onClick: () => beginForward(props.message) }]),
  { label: t('message.menuShare'), icon: Share2, onClick: () => action(() => shareMessage(props.message)) },
  ...(props.message.own && props.message.kind === 'text' ? [{ label: t('message.menuEdit'), icon: Pencil, onClick: () => emit('edit', props.message) }] : []),
  ...(props.message.own ? [{ label: t('message.menuRemove'), icon: Trash2, onClick: () => emit('remove', props.message) }] : []),
  ...(!props.message.own ? [{ label: t('message.menuReport'), icon: Flag, onClick: () => emit('report', props.message) }] : []),
])
function sizeLabel(size: number) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB` }
</script>
<template>
  <article ref="root" class="message-row" :class="{ compact, own: message.own, swiping }" :data-message-id="message.id" :aria-posinset="position" :aria-setsize="total" :style="swipeX ? { transform: `translateX(${swipeX}px)` } : undefined" @pointerdown="pressDown" @pointermove="pressMove" @pointerup="pressEnd($event)" @pointercancel="pressEnd($event, true)" @contextmenu.prevent="openMenu">
    <span v-if="swiping" class="swipe-hint" :class="{ armed: swipeArmed }" :style="{ opacity: swipeReveal, transform: `scale(${0.7 + 0.3 * swipeReveal})` }" aria-hidden="true"><Reply :size="16"/></span>
    <div class="message-avatar"><UserAvatar v-if="!compact" :name="message.name" :size="34" :image="avatar"/><span v-else class="compact-time">{{ time }}</span></div>
    <div class="message-content">
      <div v-if="!compact" class="message-heading"><span class="sender-name">{{ message.name }}</span><span v-if="message.own" class="you-label">{{ t('message.you') }}</span><time :datetime="new Date(message.timestamp).toISOString()">{{ time }}</time></div>
      <div v-if="message.replyId" class="reply-preview"><Reply :size="13"/><span>{{ message.replyBody || t('message.replyFallback') }}</span></div>
      <p v-if="message.kind === 'text' || message.kind === 'emote' || message.kind === 'notice'" class="message-text" :class="{ notice: message.kind === 'notice', emote: message.kind === 'emote' }" v-html="renderedBody" @click="onBodyClick"/><span v-if="message.edited && (message.kind === 'text' || message.kind === 'emote' || message.kind === 'notice')" class="edited">{{ t('message.edited') }}</span><Button v-if="message.threadReplies && !message.threadRoot" variant="ghost" class="thread-button" :aria-label="threadLabel" @click="emit('thread', message)"><MessageSquare :size="14"/>{{ message.threadReplies === 1 ? t('message.threadOne') : t('message.threadMany', { total: message.threadReplies }) }}<span v-if="threadNew" class="thread-new">{{ t('message.threadNew', { count: threadNew }) }}</span></Button>
      <div v-if="message.kind === 'image' && message.attachment?.url" class="image-attachment"><img :src="message.attachment.url" :alt="message.attachment.name" loading="lazy"/><div><span>{{ message.body }}</span><Button variant="ghost" :aria-label="t('message.downloadImage')" @click="download(message)"><Download :size="15"/></Button></div></div>
      <div v-else-if="message.kind === 'audio' && message.attachment" class="voice-message"><div v-if="message.attachment.waveform?.length" class="voice-waveform" aria-hidden="true"><span v-for="(bar, index) in message.attachment.waveform" :key="index" :style="{ height: `${Math.max(8, Math.round(bar * 100))}%` }"/></div><audio v-if="message.attachment.url" :src="message.attachment.url" controls preload="none" :aria-label="t('message.voiceFrom', { name: message.name, duration: message.attachment.duration !== undefined ? t('message.voiceLong', { duration: formatVoiceDuration(message.attachment.duration) }) : '' })"/><Button v-else variant="outline" class="voice-load" :icon="Play" :aria-label="t('message.loadVoice', { name: message.name })" @click="peekAttachment(message)"><span><strong>{{ message.attachment.voice ? t('message.voiceMessage') : t('message.audioMessage') }}</strong><small>{{ message.attachment.duration !== undefined ? `${formatVoiceDuration(message.attachment.duration)} · ` : '' }}{{ sizeLabel(message.attachment.size) }}</small></span></Button><small v-if="message.attachment.url && message.attachment.duration !== undefined" class="voice-duration">{{ formatVoiceDuration(message.attachment.duration) }}</small><Button v-if="message.attachment.url" variant="ghost" :aria-label="t('message.downloadVoice')" @click="download(message)"><Download :size="15"/></Button></div>
      <div v-else-if="message.kind === 'location' && message.location" class="location-message"><MapPin :size="25"/><span><strong>{{ message.location.description || t('message.sharedLocation') }}</strong><small>{{ locationTextAlternative(message.location) }}</small></span><a :href="mapLinkFor(message.location, mapProvider)" target="_blank" rel="noopener">{{ mapProvider === 'google' ? t('message.openGoogle') : t('message.openOsm') }}</a><a :href="formatGeoUri(message.location)">{{ t('message.openInApp') }}</a></div>
      <Button v-else-if="message.attachment" variant="outline" class="file-attachment" @click="download(message)"><FileText :size="25"/><span><strong>{{ message.attachment.name }}</strong><small>{{ sizeLabel(message.attachment.size) }} · {{ t('message.clickDownload') }}</small></span><Download :size="17"/></Button>
      <div v-if="message.poll" class="poll-card"><div class="poll-label">{{ t('message.pollTag') }} · {{ message.poll.ended ? t('message.pollEnded') : t('message.pollChoose') }}<span v-if="message.poll.kind === 'undisclosed'"> · {{ t('message.pollBlind') }}</span><span v-if="message.poll.edited"> · {{ t('message.pollEdited') }}</span></div><h3>{{ message.poll.question }}</h3><Button v-for="answer in message.poll.answers" :key="answer.id" variant="outline" class="poll-answer" :class="{ selected: message.poll.voted === answer.id }" :disabled="message.poll.ended" @click="vote(message, answer.id)"><span class="poll-progress" :style="{ width: `${totalVotes ? answer.count / totalVotes * 100 : 0}%` }"/><span class="poll-radio">{{ message.poll.voted === answer.id ? '●' : '○' }}</span><span>{{ answer.text }}</span><span class="answer-count">{{ answer.count }}</span></Button><small>{{ t('message.votes', { count: totalVotes }) }}<span v-if="message.poll.voted"> · {{ t('message.youVoted') }}</span><span v-if="message.poll.ended"> · {{ t('message.pollOver') }}</span></small><div v-if="!message.poll.ended" class="poll-actions"><Button v-if="message.poll.voted" variant="ghost" @click="withdrawVote(message)">{{ t('message.withdrawVote') }}</Button><Button v-if="canEndPoll(message)" variant="ghost" @click="endPoll(message)">{{ t('message.endPoll') }}</Button><small v-else>{{ t('message.endNote') }}</small></div></div>
      <div v-if="message.reactions.length" class="reactions"><Button v-for="reaction in message.reactions" :key="reaction.key" variant="outline" class="reaction" :class="{ selected: reaction.own }" @click="react(message, reaction.key)">{{ reaction.key }} <span>{{ reaction.count }}</span></Button><Button variant="ghost" class="add-reaction" :aria-label="t('message.addReaction')" @click="emit('emoji', message)"><SmilePlus :size="15"/></Button></div>
      <div v-if="message.shield" class="message-shield" :class="message.shield.level"><Tooltip :text="message.shield.message ?? t('message.shieldFallback')"><span>{{ message.shield.level === 'red' ? t('message.shieldRed') : t('message.shieldAmber') }}</span></Tooltip></div>
      <div v-if="message.status || message.own && message.read" class="message-status"><template v-if="message.status === 'failed'"><span>{{ t('message.sendFailed') }}</span><Button variant="ghost" :aria-label="t('message.retrySending')" @click="retrySend(message)">{{ t('message.retry') }}</Button><Button variant="ghost" :aria-label="t('message.discardUnsent')" @click="discardSend(message)">{{ t('message.discard') }}</Button></template><span v-else-if="message.status === 'sending'">{{ t('message.sending') }}</span><CheckCheck v-else :size="12"/></div>
    </div>
    <div class="message-actions"><Button variant="ghost" :aria-label="t('message.reactTo')" @click="emit('emoji', message)"><SmilePlus :size="16"/></Button><Button variant="ghost" :aria-label="t('message.replyTo')" @click="emit('reply', message)"><Reply :size="16"/></Button><Dropdown :options="options" align="end"><Button variant="ghost" class="row-menu-trigger" :aria-label="t('message.messageActions')"><MoreHorizontal :size="17"/></Button></Dropdown></div>
  </article>
</template>
<style scoped>
.message-row { touch-action: pan-y; position: relative; transition: transform 0.18s ease-out; }
.message-row.swiping { transition: none; }
.swipe-hint { position: absolute; right: 10px; top: 50%; translate: 0 -50%; color: var(--fern); opacity: 0; }
.swipe-hint.armed { color: var(--fern); filter: saturate(1.4); }
</style>
