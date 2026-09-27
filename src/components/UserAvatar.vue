<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ name: string; size?: number; square?: boolean }>(), { size: 36, square: false })
const initials = computed(() => props.name.replace(/^@/, '').split(/[\s.:_-]+/).slice(0, 2).map(part => part[0]).join('').toUpperCase())
const colors = ['#e4e9df', '#ece1d8', '#e3e4ef', '#e8e3cf', '#dae8e7', '#eadddf']
const color = computed(() => colors[[...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length])
</script>
<template><span class="user-avatar" :class="{ square }" :style="{ width: `${size}px`, height: `${size}px`, background: color, fontSize: `${size * .31}px` }" aria-hidden="true">{{ initials }}</span></template>
