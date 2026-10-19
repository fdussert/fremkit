<script setup lang="ts">
/**
 * Tells the sections of one pane what the window wants of them: all of them, or only those a
 * search found (opened), and whether the pane is a single block shown bare. A pane is already a
 * narrow view, so its sections start open; folding one is remembered as anywhere else.
 */
import { provide } from 'vue'
import { SECTION_SCOPE } from '../../shared/ui/BaseSection.vue'

const props = defineProps<{ matches: ReadonlySet<string> | null; bare: boolean }>()

provide(SECTION_SCOPE, {
  shown: (id: string) => !props.matches || props.matches.has(id),
  forced: (id: string) => !!props.matches && props.matches.has(id),
  get bare() { return props.bare },
  defaultOpen: true,
})
</script>

<template><slot /></template>
