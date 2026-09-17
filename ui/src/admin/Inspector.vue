<script setup lang="ts">
import WidgetInspector from './WidgetInspector.vue'
</script>

<template>
  <aside class="inspector">
    <div class="body">
      <WidgetInspector />
    </div>
  </aside>
</template>

<style scoped>
.inspector { width: 300px; flex: 0 0 auto; display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--border); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3); }
</style>
