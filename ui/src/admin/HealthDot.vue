<script setup lang="ts">
/**
 * The dot that says something needs attention: red for an error, orange for a warning, nothing
 * at all when every widget is well — or only has an update waiting, which is not a problem.
 * Used on the pages list, the screens selector and the top bar.
 */
import type { HealthLevel } from './health'

defineProps<{ level: HealthLevel; title?: string }>()
</script>

<template>
  <span v-if="level === 'error' || level === 'warning'" class="health-dot" :class="level" :title="title" role="img" :aria-label="title" />
</template>

<style scoped>
.health-dot { display: inline-block; flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  box-shadow: 0 0 0 2px var(--surface); }
.health-dot.error { background: var(--danger); }
.health-dot.warning { background: var(--warn); }
</style>
