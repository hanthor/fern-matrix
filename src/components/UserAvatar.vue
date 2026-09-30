<script setup lang="ts">
import { computed } from 'vue'
import { Avatar } from 'frappe-ui'
// Thin wrapper preserving Fern's call sites (pixel sizes, square rooms) while
// rendering Frappe's Avatar: themed initial fallback plus real image support
// for authenticated profile pictures. Exact pixels come from inline style;
// the size bucket only drives the fallback glyph scale.
const props = withDefaults(defineProps<{ name: string; size?: number; square?: boolean; image?: string }>(), { size: 36, square: false, image: undefined })
const themes = ['gray', 'green', 'blue', 'violet', 'amber', 'red'] as const
const theme = computed(() => themes[[...props.name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % themes.length])
const bucket = computed(() => props.size <= 20 ? 'xs' : props.size <= 24 ? 'sm' : props.size <= 28 ? 'md' : props.size <= 33 ? 'lg' : props.size <= 40 ? 'xl' : props.size <= 46 ? '2xl' : '3xl')
</script>
<template><Avatar class="user-avatar" :label="name" :image="image" :size="bucket" :shape="square ? 'square' : 'circle'" :theme="theme" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true"/></template>
