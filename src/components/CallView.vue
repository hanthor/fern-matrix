<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Alert, Button, LoadingIndicator } from 'frappe-ui'
import { Globe, LockKeyhole, PhoneOff, RotateCcw, Video, X } from 'lucide-vue-next'
import UserAvatar from './UserAvatar.vue'

// Re-skinned room-call surface (#46): Fern owns the lobby, header, loading,
// error and ended states in frappe-ui; the Element Call widget bundle keeps
// owning media tiles and in-widget controls. The bridge (origin/source/ID
// validation, capabilities, cleanup) stays in engine.startCall untouched.
export type CallStatus = 'lobby' | 'joining' | 'active' | 'error' | 'ended'
const props = defineProps<{ roomName: string; direct: boolean; encrypted: boolean; status: CallStatus; error?: string }>()
const emit = defineEmits<{ iframe: [iframe: HTMLIFrameElement]; join: []; leave: []; retry: []; close: [] }>()
const frame = ref<HTMLIFrameElement>()
onMounted(() => { if (frame.value) emit('iframe', frame.value) })
</script>
<template>
  <div class="call-view" role="region" aria-label="Room call">
    <header class="call-header">
      <UserAvatar :name="props.roomName" :size="34"/>
      <span><strong>{{ props.roomName }}</strong><small><LockKeyhole v-if="props.encrypted" :size="11"/> <Globe v-else :size="11"/> {{ props.encrypted ? 'Encrypted call' : 'Call' }} · Element Call</small></span>
      <Button variant="ghost" theme="red" aria-label="Leave call" @click="emit('leave')"><PhoneOff :size="17"/></Button>
    </header>
    <template v-if="props.status === 'lobby'">
      <div class="call-state"><span class="call-ended-icon"><Video :size="34"/></span><h3>Call with {{ props.roomName }}</h3><p>Calls use Element Call and your homeserver’s MatrixRTC service.</p><div class="dialog-actions"><Button variant="ghost" @click="emit('close')">Not now</Button><Button variant="solid" theme="green" @click="emit('join')"><Video :size="15"/>Join call</Button></div></div>
    </template>
    <template v-if="props.status === 'joining'">
      <div class="call-state"><LoadingIndicator/><p>Joining the call…</p><div class="dialog-actions"><Button variant="outline" @click="emit('close')"><X :size="15"/>Cancel</Button></div></div>
    </template>
    <template v-if="props.status === 'error'">
      <div class="call-state"><Alert theme="red" :title="props.error || 'The call could not start.'"/><div class="dialog-actions"><Button variant="ghost" @click="emit('close')">Close</Button><Button variant="solid" theme="green" @click="emit('retry')"><RotateCcw :size="15"/>Try again</Button></div></div>
    </template>
    <template v-if="props.status === 'ended'">
      <div class="call-state"><span class="call-ended-icon"><Video :size="34"/></span><h3>Call ended</h3><p>Everyone else keeps going without you — rejoin any time.</p><div class="dialog-actions"><Button variant="ghost" @click="emit('close')">Close</Button><Button variant="solid" theme="green" @click="emit('retry')"><Video :size="15"/>Rejoin</Button></div></div>
    </template>
    <iframe v-show="props.status === 'active'" ref="frame" title="Element Call" allow="camera; microphone; display-capture; autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/>
    <p v-if="props.status === 'active'" class="form-note">Calls use Element Call and your homeserver’s MatrixRTC service.</p>
  </div>
</template>
<style scoped>
.call-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.call-header > span { flex: 1; min-width: 0; }
.call-header strong { display: block; font-size: 13px; }
.call-header small { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 10px; }
.call-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 0; text-align: center; }
.call-state h3 { margin: 0; font-size: 14px; }
.call-state p { margin: 0; color: var(--subtle); font-size: 11px; }
.call-ended-icon { color: var(--muted); }
</style>
