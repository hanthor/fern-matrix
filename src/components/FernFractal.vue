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
    <svg viewBox="48 10 104 220" preserveAspectRatio="xMidYMid slice" focusable="false">
      <path v-for="(path, index) in paths" :key="index" :d="path" :style="{ '--frond': index }"/>
    </svg>
  </div>
</template>

<style scoped>
.fern-fractal {
  /* A viewport layer, not part of the form's scrollable layout. */
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: var(--fern);
  pointer-events: none;
  opacity: .42;
}
.fern-fractal::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 65% 35%, var(--fern-soft), transparent 75%);
}
svg { display: block; width: 100%; height: 100%; position: relative; }
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

</style>
