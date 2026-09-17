<script setup lang="ts">
defineProps<{ label: string; hint?: string }>()
</script>

<template>
  <label class="field">
    <span class="lbl">{{ label }}</span>
    <slot />
    <span v-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.hint { font-size: var(--fs-xs); color: var(--text-dim); }
</style>
