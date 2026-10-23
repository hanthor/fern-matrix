<script setup lang="ts">
import { computed } from 'vue'
import { Alert, Button, Dialog, LoadingIndicator } from 'frappe-ui'
import { useI18n } from 'vue-i18n'
import type { SessionExitState } from '../session-exit'
import { isTauri } from '../tauri'

const props = defineProps<{ state: SessionExitState }>()
const emit = defineEmits<{
  cancel: []
  confirm: []
  review: []
  acknowledge: [value: boolean]
}>()
const { t } = useI18n()
const native = isTauri()
const open = computed({
  get: () => props.state.target !== null,
  set: value => { if (!value && !props.state.busy) emit('cancel') },
})
const mode = computed(() => props.state.target?.mode ?? 'signout')
</script>

<template>
  <Dialog v-model:open="open" :title="t(`sessionExit.${mode}Title`)">
    <div v-if="state.target" class="dialog-form">
      <p><strong>{{ state.target.name }}</strong><br/>{{ state.target.userId }}<br/><small>{{ t('sessionExit.localSession', { id: state.target.id }) }}</small></p>
      <p>{{ t(`sessionExit.${mode}Description`) }}</p>
      <p>{{ t('sessionExit.historyWarning') }}</p>
      <Alert v-if="native" theme="red" :title="t('sessionExit.nativeWarning')"/>
      <p v-if="state.checking" role="status"><LoadingIndicator/> {{ t('sessionExit.checking') }}</p>
      <template v-else>
        <p role="status">{{ t(`sessionExit.recovery.${state.status.recovery}`) }}</p>
        <p v-if="state.status.backupExists === false">{{ t('sessionExit.noBackup') }}</p>
        <p v-else-if="state.status.backupExists === 'unknown'">{{ t('sessionExit.backupUnknown') }}</p>
        <p v-if="state.status.lastDevice === true">{{ t('sessionExit.lastDevice') }}</p>
        <p v-else-if="state.status.lastDevice === 'unknown'">{{ t('sessionExit.devicesUnknown') }}</p>
      </template>
      <label class="form-check">
        <input type="checkbox" :checked="state.acknowledged" :disabled="state.busy"
          @change="emit('acknowledge', ($event.target as HTMLInputElement).checked)"/>
        {{ t('sessionExit.acknowledge') }}
      </label>
      <Alert v-if="state.error" theme="red" :title="t(`sessionExit.errors.${state.error}`)"/>
    </div>
    <template #actions>
      <Button variant="outline" :disabled="state.busy" @click="emit('cancel')">{{ t('settings.cancel') }}</Button>
      <Button variant="outline" :disabled="state.busy || state.error === 'missing'" @click="emit('review')">{{ t('sessionExit.review') }}</Button>
      <Button variant="solid" theme="red" :loading="state.busy"
        :disabled="state.checking || state.busy || !state.acknowledged || state.error === 'missing'"
        @click="emit('confirm')">{{ t(`sessionExit.${mode}Action`) }}</Button>
    </template>
  </Dialog>
</template>
