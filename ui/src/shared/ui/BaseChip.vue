<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'accent' | 'danger' }>(), { tone: 'neutral' })
</script>

<template><span class="chip" :class="tone"><slot /></span></template>

<style scoped>
.chip { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); line-height: 1;
  padding: 4px 8px; border-radius: 999px; background: var(--surface-3); color: var(--text-muted); white-space: nowrap; }
.chip.accent { background: var(--accent); color: var(--on-accent); }
.chip.danger { background: var(--danger); color: var(--on-accent); }
</style>
