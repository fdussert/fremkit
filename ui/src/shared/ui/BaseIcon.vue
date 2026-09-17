<script setup lang="ts">
import { computed } from 'vue'
import { iconSvg } from '../icons'
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
// The markup comes from a frozen constant table, never from user input.
const svg = computed(() => iconSvg(props.name, props.size))
</script>

<template><span class="icon" v-html="svg" /></template>

<style scoped>
.icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
</style>
