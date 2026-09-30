<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { Button, ErrorMessage, LoadingIndicator } from 'frappe-ui'
import { Camera, QrCode, Upload } from 'lucide-vue-next'
import { decodeQrFile, scanQrCamera, type QrCamera } from '../qr'
import { closeQr, openQr, qrFlow, state, submitQrBytes, type QrRole } from '../store'
const props = defineProps<{ role: QrRole; server?: string }>()
const emit = defineEmits<{ close: [] }>()
const video = ref<HTMLVideoElement>()
const fileInput = ref<HTMLInputElement>()
const camera = ref<QrCamera>()
const cameraBusy = ref(false)
const cameraFailed = ref('')
const scanning = ref(false)
function stopCamera() { camera.value?.stop(); camera.value = undefined; scanning.value = false }
async function startCamera() {
  cameraFailed.value = ''
  cameraBusy.value = true
  try {
    scanning.value = true
    camera.value = await scanQrCamera(video.value!, bytes => { void submit(bytes) })
  } catch (error) {
    cameraFailed.value = error instanceof Error ? error.message : String(error)
    scanning.value = false
  }
  cameraBusy.value = false
}
async function submit(bytes: Uint8Array) {
  stopCamera()
  await submitQrBytes(bytes, props.server)
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await submit(await decodeQrFile(file))
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  }
}
function retry() { stopCamera(); openQr(props.role) }
function close() { stopCamera(); closeQr(); emit('close') }
onUnmounted(stopCamera)
</script>
<template>
  <div v-if="qrFlow" class="qr-view" role="region" :aria-label="qrFlow.role === 'login' ? 'Sign in with QR code' : 'Link a new device'">
    <ErrorMessage v-if="state.error" :message="state.error"/>
    <template v-if="qrFlow.stage === 'camera'">
      <span class="qr-icon"><QrCode :size="34"/></span>
      <h3>{{ qrFlow.role === 'login' ? 'Scan the code on your other device' : 'Scan the new device\u2019s code' }}</h3>
      <p>{{ qrFlow.role === 'login' ? 'Show a sign-in code on a device that is already signed in, then scan it here.' : 'Show the sign-in code on the new device, then scan it here to link it.' }} Only scan codes shown by your own devices.</p>
      <video ref="video" class="qr-video" :class="{ live: scanning }" playsinline muted aria-label="Camera preview for QR scanning"/>
      <p v-if="scanning" class="form-note">Point the camera at the code. Scanning stops automatically on the first hit.</p>
      <ErrorMessage v-if="cameraFailed" :message="cameraFailed"/>
      <div class="dialog-actions">
        <Button v-if="!scanning" variant="outline" :loading="cameraBusy" @click="startCamera"><Camera :size="15"/>Use camera</Button>
        <Button v-else variant="outline" @click="stopCamera">Stop camera</Button>
        <Button variant="outline" @click="fileInput?.click()"><Upload :size="15"/>Upload image</Button>
        <input ref="fileInput" type="file" accept="image/*" class="sr-only" tabindex="-1" aria-label="QR code image file" @change="upload"/>
      </div>
      <div class="dialog-actions"><Button variant="ghost" @click="close">Cancel</Button></div>
    </template>
    <template v-else-if="qrFlow.stage === 'done'">
      <h3>{{ qrFlow.role === 'login' ? 'Signed in' : 'Device linked' }}</h3>
      <p>{{ qrFlow.role === 'login' ? 'This device is signed in. Verify it from another device to clear sender warnings.' : 'The new device is linked. It still needs to verify before encrypted chats fully trust it.' }}</p>
      <div class="dialog-actions"><Button variant="solid" theme="green" @click="close">Done</Button></div>
    </template>
    <template v-else>
      <div class="qr-progress"><LoadingIndicator/><strong>{{ qrFlow.stage === 'starting' ? 'Starting a secure channel…' : qrFlow.stage === 'connecting' ? 'Connecting to the other device…' : qrFlow.stage === 'syncing' ? 'Syncing encryption keys…' : 'Confirm on the other device' }}</strong></div>
      <p v-if="qrFlow.stage === 'confirm' && qrFlow.role === 'grant' && qrFlow.verificationUri">Almost linked. Open this verification link to approve the new device: <a :href="qrFlow.verificationUri" target="_blank" rel="noopener">{{ qrFlow.verificationUri }}</a></p>
      <p v-else-if="qrFlow.stage === 'confirm' && qrFlow.role === 'grant'">The secure channel is up. Approve the new device to finish linking.</p>
      <p v-else-if="qrFlow.stage === 'confirm' && qrFlow.userCode">Enter this code on your other device: <code>{{ qrFlow.userCode }}</code></p>
      <p v-else-if="qrFlow.stage === 'confirm'">Approve the sign-in on your other device to continue.</p>
      <div class="dialog-actions"><Button variant="ghost" @click="retry">Start over</Button><Button variant="outline" @click="close">Cancel</Button></div>
    </template>
  </div>
</template>
