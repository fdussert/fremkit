<script setup lang="ts">
defineProps<{ selected?: boolean; grab?: boolean }>()
</script>

<template>
  <div class="card" :class="{ selected, grab }"><slot /></div>
</template>

<style scoped>
.card { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3); display: flex; align-items: center; gap: var(--space-3); }
.card.grab { cursor: grab; }
.card.selected { border-color: var(--accent); background: var(--surface-3); }
</style>
