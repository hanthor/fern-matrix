<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Alert, Button, LoadingIndicator } from 'frappe-ui'
import { LayoutGrid, PhoneOff, RotateCcw, X } from 'lucide-vue-next'
import { unsupportedWidgetMessage, widgetCapabilitiesSummary, type WidgetInfo, type WidgetKind } from '../widgets'

// Room widget surface (#45): Fern owns approval, header, loading, error and
// ended states in frappe-ui. Supported widgets (Element Call, Jitsi) load in
// the sandboxed frame through the engine widget-driver bridge; anything else
// is refused with an actionable message and never loads third-party content.
export type WidgetStatus = 'approval' | 'loading' | 'active' | 'error' | 'ended'
const props = defineProps<{ widget: WidgetInfo; status: WidgetStatus; error?: string }>()
const emit = defineEmits<{ approve: []; decline: []; iframe: [iframe: HTMLIFrameElement]; leave: []; retry: []; close: [] }>()
const frame = ref<HTMLIFrameElement>()
onMounted(() => { if (frame.value) emit('iframe', frame.value) })
function kindLabel(kind: WidgetKind) { return kind === 'element_call' ? 'Element Call' : kind === 'jitsi' ? 'Jitsi' : 'Unsupported' }
function host(url: string) { try { return new URL(url).hostname } catch { return url } }
</script>
<template>
  <div class="widget-view" role="region" :aria-label="`Room widget ${props.widget.name}`">
    <template v-if="props.status === 'approval'">
      <div class="widget-state"><span class="widget-ended-icon"><LayoutGrid :size="34"/></span><h3>Open “{{ props.widget.name }}”?</h3><p>{{ kindLabel(props.widget.kind) }} widget · {{ host(props.widget.url) }} · added by {{ props.widget.sender }}</p><p>{{ widgetCapabilitiesSummary(props.widget.kind) }}</p><p v-if="props.widget.kind === 'unknown'" class="form-note">{{ unsupportedWidgetMessage(props.widget) }}</p><div class="dialog-actions"><Button variant="ghost" @click="emit('decline')">{{ props.widget.kind === 'unknown' ? 'Close' : 'Decline' }}</Button><Button v-if="props.widget.kind !== 'unknown'" variant="solid" theme="green" @click="emit('approve')">Approve and open</Button></div></div>
    </template>
    <template v-else>
      <header class="widget-header"><span class="details-icon"><LayoutGrid :size="20"/></span><span><strong>{{ props.widget.name }}</strong><small>{{ kindLabel(props.widget.kind) }} widget</small></span><Button variant="ghost" theme="red" aria-label="Leave widget" @click="emit('leave')"><PhoneOff :size="17"/></Button></header>
      <template v-if="props.status === 'loading'">
        <div class="widget-state"><LoadingIndicator/><p>Opening the widget…</p><div class="dialog-actions"><Button variant="outline" @click="emit('close')"><X :size="15"/>Cancel</Button></div></div>
      </template>
      <template v-else-if="props.status === 'error'">
        <div class="widget-state"><Alert theme="red" :title="props.error || 'The widget could not start.'"/><div class="dialog-actions"><Button variant="ghost" @click="emit('close')">Close</Button><Button variant="solid" theme="green" @click="emit('retry')"><RotateCcw :size="15"/>Try again</Button></div></div>
      </template>
      <template v-else-if="props.status === 'ended'">
        <div class="widget-state"><span class="widget-ended-icon"><LayoutGrid :size="34"/></span><h3>Widget closed</h3><p>Reopen it any time from the room widgets.</p><div class="dialog-actions"><Button variant="ghost" @click="emit('close')">Close</Button><Button variant="solid" theme="green" @click="emit('retry')">Reopen</Button></div></div>
      </template>
      <iframe v-show="props.status === 'active'" ref="frame" :title="props.widget.name" allow="camera; microphone; display-capture; autoplay; encrypted-media" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/>
    </template>
  </div>
</template>
<style scoped>
.widget-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.widget-header > span { flex: 1; min-width: 0; }
.widget-header strong { display: block; font-size: 13px; }
.widget-header small { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 10px; }
.widget-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 28px 0; text-align: center; }
.widget-state h3 { margin: 0; font-size: 14px; }
.widget-state p { margin: 0; color: var(--subtle); font-size: 11px; }
.widget-ended-icon { color: var(--muted); }
.widget-view iframe { width: 100%; height: min(65dvh, 650px); border: 0; border-radius: 9px; background: var(--sidebar); }
</style>
