<script setup lang="ts">
import { computed } from 'vue'
import { Alert, Button, Dialog, LoadingIndicator } from 'frappe-ui'
import { useI18n } from 'vue-i18n'
import type { SessionExitState } from '../session-exit'
import { isTauri } from '../tauri'

const props = defineProps<{ state: SessionExitState; restartDisabled?: boolean }>()
const emit = defineEmits<{
  restart: []
  retry: []
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
      <template v-if="state.outcome">
        <Alert theme="red" :title="t(state.outcome.status === 'restart-required' ? 'sessionExit.restartRequired' : 'sessionExit.cleanupError')"/>
        <p v-if="state.outcome.status !== 'error' && state.outcome.serverRevoked === false">{{ t('sessionExit.serverStillActive') }}</p>
        <p v-if="native">{{ t('sessionExit.nativeWarning') }}</p>
      </template>
      <template v-else>
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
      </template>
      <Alert v-if="state.error" theme="red" :title="t(`sessionExit.errors.${state.error}`)"/>
    </div>
    <template #actions>
      <Button variant="outline" :disabled="state.busy" @click="emit('cancel')">{{ t(state.outcome ? 'sessionExit.close' : 'settings.cancel') }}</Button>
      <Button v-if="state.outcome?.status === 'restart-required'" variant="solid" :disabled="restartDisabled" @click="emit('restart')">{{ t('sessionExit.restart') }}</Button>
      <Button v-else-if="state.outcome?.status === 'error'" variant="solid" :loading="state.busy" @click="emit('retry')">{{ t('sessionExit.retryLocal') }}</Button>
      <template v-else>
      <Button variant="outline" :disabled="state.busy || state.error === 'missing'" @click="emit('review')">{{ t('sessionExit.review') }}</Button>
      <Button variant="solid" theme="red" :loading="state.busy"
        :disabled="state.checking || state.busy || !state.acknowledged || state.error === 'missing'"
        @click="emit('confirm')">{{ t(`sessionExit.${mode}Action`) }}</Button>
      </template>
    </template>
  </Dialog>
</template>
