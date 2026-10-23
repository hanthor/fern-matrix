<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { fernPaths } from '../fern-fractal'

withDefaults(defineProps<{ paused?: boolean }>(), { paused: false })
const paths = fernPaths()
const hidden = ref(false)
const reduced = ref(true) // Never animate before reading the user's preference.
let media: MediaQueryList | undefined
function visibility() { hidden.value = document.hidden }
function preference() { reduced.value = media?.matches ?? true }
onMounted(() => {
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  preference()
  visibility()
  media.addEventListener('change', preference)
  document.addEventListener('visibilitychange', visibility)
})
onUnmounted(() => {
  media?.removeEventListener('change', preference)
  document.removeEventListener('visibilitychange', visibility)
})
</script>

<template>
  <div class="fern-fractal" :class="{ 'is-paused': hidden || paused, 'is-still': reduced }" aria-hidden="true">
    <svg viewBox="0 0 200 240" focusable="false">
      <path v-for="(path, index) in paths" :key="index" :d="path" :style="{ '--frond': index }"/>
    </svg>
  </div>
</template>

<style scoped>
.fern-fractal {
  width: clamp(160px, 28vh, 240px);
  width: clamp(160px, 28dvh, 240px);
  aspect-ratio: 5 / 6;
  flex: none;
  position: relative;
  color: var(--fern);
  pointer-events: none;
  margin-bottom: 8px;
}
.fern-fractal::before {
  content: '';
  position: absolute;
  inset: 12% -20%;
  border-radius: 50%;
  background: radial-gradient(ellipse, var(--fern-soft), transparent 70%);
}
svg { display: block; width: 100%; height: 100%; position: relative; overflow: visible; }
path {
  fill: none;
  stroke: currentColor;
  stroke-width: .8;
  stroke-linecap: round;
  opacity: .82;
  transform-origin: 100px 230px;
  animation: frond-unfurl 1.4s ease-out both;
  animation-delay: calc(var(--frond) * 70ms);
}
.is-paused path { animation-play-state: paused; }
.is-still path { animation: none; }
@keyframes frond-unfurl {
  from { opacity: 0; transform: translateY(5px) scale(.96); }
  to { opacity: .82; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) { path { animation: none; } }
@media (max-height: 520px) { .fern-fractal { width: 100px; } }
</style>
