<script setup lang="ts">
/**
 * A block of a settings pane that does not fold (a screen's name, the language, the theme): the
 * search hides it like a section when it did not find it, and reveals it by the same id.
 */
import { inject } from 'vue'
import { SECTION_SCOPE } from '../../shared/ui/BaseSection.vue'

defineProps<{ id: string }>()
const scope = inject(SECTION_SCOPE, null)
</script>

<template>
  <div v-if="!scope || scope.shown(id)" class="block" :data-section="id"><slot /></div>
</template>

<style scoped>
.block { margin-bottom: var(--space-3); }
</style>
