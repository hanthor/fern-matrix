<script setup lang="ts">
import { computed } from 'vue'
import { loginDestination } from '../login'
import { FormControl } from 'frappe-ui'
import { useI18n } from 'vue-i18n'
const props = defineProps<{ registering?: boolean; busy?: boolean }>()
const server = defineModel<string>('server', { required: true })
const username = defineModel<string>('username', { required: true })
const password = defineModel<string>('password', { required: true })
const { t } = useI18n()
const destination = computed(() => loginDestination(username.value, server.value, props.registering))
const fullId = computed(() => !props.registering && username.value.startsWith('@'))
</script>
<template>
  <FormControl :model-value="fullId && !destination.error ? destination.server : server" @update:model-value="server = String($event)" :label="t('login.server')" placeholder="matrix.org" :disabled="busy || fullId" autocapitalize="none" spellcheck="false" required/>
  <FormControl v-model="username" :label="t('login.username')" :placeholder="registering ? 'you' : 'you or @you:matrix.org'" :disabled="busy" autocomplete="username" autocapitalize="none" spellcheck="false" required/>
  <p v-if="fullId" class="login-destination-note" role="status">{{ t('login.fullIdDestination') }} <strong v-if="!destination.error">{{ destination.server }}</strong></p>
  <p v-if="registering" class="form-note">{{ t('login.localpartNote') }}</p>
  <FormControl v-model="password" type="password" :label="t('login.password')" :disabled="busy" :autocomplete="registering ? 'new-password' : 'current-password'" required/>
</template>
