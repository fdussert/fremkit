<script setup lang="ts">
import WidgetInspector from './WidgetInspector.vue'
import PageInspector from './PageInspector.vue'
import SelectionInspector from './SelectionInspector.vue'
import { useAdminStore } from './store'

const s = useAdminStore()
</script>

<template>
  <aside class="inspector">
    <!-- Several selected: what they share. -->
    <div v-if="s.state.selection.length > 1" class="body">
      <SelectionInspector />
    </div>
    <!-- A widget's inspector keeps its header fixed and scrolls its own sections. -->
    <WidgetInspector v-else-if="s.selected.value" />
    <!-- With no widget selected, the inspector edits the page being shown. -->
    <div v-else class="body">
      <WidgetInspector />
      <PageInspector />
    </div>
  </aside>
</template>

<style scoped>
.inspector { width: 300px; flex: 0 0 auto; display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--border); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3); }
</style>
