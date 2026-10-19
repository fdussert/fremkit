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
/* The pages and the widgets' search stay put; only the widgets scroll (WidgetLibrary). A long
   list of pages scrolls on its own rather than pushing the search out of reach. */
.sidebar { width: 280px; flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0;
  padding: var(--space-3) var(--space-3) 0; background: var(--surface); border-right: 1px solid var(--border); }
.sidebar > :first-child { flex: 0 0 auto; max-height: 40%; overflow-y: auto; }
</style>
