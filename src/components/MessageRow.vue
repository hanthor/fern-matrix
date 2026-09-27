<script setup lang="ts">
import { computed } from 'vue'
import { Button, Dropdown } from 'frappe-ui'
import { Reply, SmilePlus, MoreHorizontal, FileText, Download, CheckCheck, Pencil, Pin, Trash2, Copy } from 'lucide-vue-next'
import UserAvatar from './UserAvatar.vue'
import type { Message } from '../types'
import { react, vote, download, notify, state, engine, isDemo, action } from '../store'
const props = defineProps<{ message: Message; compact?: boolean }>()
const emit = defineEmits<{ reply: [message: Message]; edit: [message: Message]; remove: [message: Message]; emoji: [message: Message] }>()
const time = computed(() => new Date(props.message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
const totalVotes = computed(() => props.message.poll?.answers.reduce((total, answer) => total + answer.count, 0) ?? 0)
const options = computed(() => [
  { label: 'Reply', icon: Reply, onClick: () => emit('reply', props.message) },
  { label: 'Copy text', icon: Copy, onClick: () => action(async () => { await navigator.clipboard.writeText(props.message.body); notify('Message copied') }) },
  { label: 'Pin message', icon: Pin, onClick: () => action(async () => { if (isDemo.value) notify('Message pinned in the demo'); else { await engine.pin(state.activeAccountId, state.activeRoomId, props.message.id); notify('Message pinned') } }) },
  ...(props.message.own && props.message.kind === 'text' ? [{ label: 'Edit', icon: Pencil, onClick: () => emit('edit', props.message) }] : []),
  ...(props.message.own ? [{ label: 'Remove message', icon: Trash2, onClick: () => emit('remove', props.message) }] : []),
])
function sizeLabel(size: number) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB` }
</script>
<template>
  <article class="message-row" :class="{ compact, own: message.own }" :data-message-id="message.id">
    <div class="message-avatar"><UserAvatar v-if="!compact" :name="message.name" :size="34"/><span v-else class="compact-time">{{ time }}</span></div>
    <div class="message-content">
      <div v-if="!compact" class="message-heading"><span class="sender-name">{{ message.name }}</span><span v-if="message.own" class="you-label">you</span><time :datetime="new Date(message.timestamp).toISOString()">{{ time }}</time></div>
      <div v-if="message.replyId" class="reply-preview"><Reply :size="13"/><span>{{ message.replyBody || 'Reply to a message' }}</span></div>
      <p v-if="message.kind === 'text' || message.kind === 'notice'" class="message-text" :class="{ notice: message.kind === 'notice' }">{{ message.body }} <span v-if="message.edited" class="edited">(edited)</span></p>
      <div v-if="message.kind === 'image' && message.attachment?.url" class="image-attachment"><img :src="message.attachment.url" :alt="message.attachment.name" loading="lazy"/><div><span>{{ message.body }}</span><Button variant="ghost" aria-label="Download image" @click="download(message)"><Download :size="15"/></Button></div></div>
      <Button v-else-if="message.attachment" variant="outline" class="file-attachment" @click="download(message)"><FileText :size="25"/><span><strong>{{ message.attachment.name }}</strong><small>{{ sizeLabel(message.attachment.size) }} · Click to download</small></span><Download :size="17"/></Button>
      <div v-if="message.poll" class="poll-card"><div class="poll-label">POLL · CHOOSE ONE</div><h3>{{ message.poll.question }}</h3><Button v-for="answer in message.poll.answers" :key="answer.id" variant="outline" class="poll-answer" :class="{ selected: message.poll.voted === answer.id }" @click="vote(message, answer.id)"><span class="poll-progress" :style="{ width: `${totalVotes ? answer.count / totalVotes * 100 : 0}%` }"/><span class="poll-radio">{{ message.poll.voted === answer.id ? '●' : '○' }}</span><span>{{ answer.text }}</span><span class="answer-count">{{ answer.count }}</span></Button><small>{{ totalVotes }} votes<span v-if="message.poll.voted"> · You voted</span></small></div>
      <div v-if="message.reactions.length" class="reactions"><Button v-for="reaction in message.reactions" :key="reaction.key" variant="outline" class="reaction" :class="{ selected: reaction.own }" @click="react(message, reaction.key)">{{ reaction.key }} <span>{{ reaction.count }}</span></Button><Button variant="ghost" class="add-reaction" aria-label="Add a reaction" @click="emit('emoji', message)"><SmilePlus :size="15"/></Button></div>
      <div v-if="message.status || message.own && message.read" class="message-status"><span v-if="message.status === 'failed'">Could not send</span><span v-else-if="message.status === 'sending'">Sending…</span><CheckCheck v-else :size="12"/></div>
    </div>
    <div class="message-actions"><Button variant="ghost" aria-label="React to message" @click="emit('emoji', message)"><SmilePlus :size="16"/></Button><Button variant="ghost" aria-label="Reply to message" @click="emit('reply', message)"><Reply :size="16"/></Button><Dropdown :options="options" align="end"><Button variant="ghost" aria-label="Message actions"><MoreHorizontal :size="17"/></Button></Dropdown></div>
  </article>
</template>
