<script setup lang="ts">
import PagesList from './PagesList.vue'
import WidgetLibrary from './WidgetLibrary.vue'
</script>

<template>
  <aside class="sidebar">
    <PagesList />
    <WidgetLibrary />
  </aside>
</template>

<style scoped>
.sidebar { width: 280px; flex: 0 0 auto; overflow-y: auto; padding: var(--space-3);
  background: var(--surface); border-right: 1px solid var(--border); }
</style>
