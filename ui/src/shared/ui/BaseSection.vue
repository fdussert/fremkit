<script lang="ts">
/**
 * Which sections are open, kept per browser rather than in the config: it is a habit of the
 * person editing, not a property of the screen they are editing, and it must not travel to
 * another machine through a saved config.
 *
 * Module scope, so every section on the page reads and writes the same record.
 */
import { reactive, type InjectionKey } from 'vue'

const KEY = 'fremkit.sections'

function load(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, boolean> } catch { return {} }
}

const open = reactive<Record<string, boolean>>(load())

function remember(id: string, value: boolean): void {
  open[id] = value
  try { localStorage.setItem(KEY, JSON.stringify(open)) } catch { /* private window: this session only */ }
}

/** Opens or folds several sections at once — an "expand all" — and remembers it like a click. */
export function setSectionsOpen(ids: readonly string[], value: boolean): void {
  for (const id of ids) open[id] = value
  try { localStorage.setItem(KEY, JSON.stringify(open)) } catch { /* private window: this session only */ }
}

/**
 * What a container says about the sections inside it, without those sections knowing who it is:
 * the settings window's search hides the ones it did not find and opens the ones it did, and a
 * pane holding a single section shows it bare, since there is nothing to fold it away from.
 */
export interface SectionScope {
  /** False hides the section altogether. */
  shown(id: string): boolean
  /** True opens it whatever was remembered, without remembering it. */
  forced(id: string): boolean
  /** Its body alone, no header, nothing to fold. */
  bare: boolean
  /** Open until the person folds it, whatever the section's own default. */
  defaultOpen?: boolean
}
export const SECTION_SCOPE: InjectionKey<SectionScope> = Symbol('sectionScope')
</script>

<script setup lang="ts">
import { computed, inject } from 'vue'
import BaseIcon from './BaseIcon.vue'

const props = withDefaults(defineProps<{
  /** Stable id, since it is what the open state is remembered under. */
  id: string
  title: string
  /** Whether the section starts open the first time it is seen. */
  defaultOpen?: boolean
  /** A short count or state shown on the right of the header, visible while folded. */
  badge?: string
  /** Open whatever was remembered, without remembering it: a search showing what it found. */
  forceOpen?: boolean
}>(), { defaultOpen: false, badge: '', forceOpen: false })

const scope = inject(SECTION_SCOPE, null)
const shown = computed(() => !scope || scope.shown(props.id))
const forced = computed(() => props.forceOpen || !!scope?.forced(props.id))
const isOpen = computed(() => forced.value || (open[props.id] ?? (props.defaultOpen || !!scope?.defaultOpen)))

/** The toggle a forced opening fires is not the person's choice, so it is not kept. */
function onToggle(e: Event): void {
  if (!forced.value) remember(props.id, (e.target as HTMLDetailsElement).open)
}
</script>

<template>
  <div v-if="shown && scope?.bare" class="bare" :data-section="id"><slot /></div>
  <details v-else-if="shown" class="section" :data-section="id" :open="isOpen" @toggle="onToggle">
    <summary>
      <BaseIcon class="chevron" name="chevron-down" :size="14" />
      <span class="title">{{ title }}</span>
      <span v-if="badge" class="badge">{{ badge }}</span>
    </summary>
    <div class="body"><slot /></div>
  </details>
</template>

<style scoped>
/* A framed block with its own header bar: folded sections then read as a stack of titles. */
.section { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  margin-bottom: var(--space-2); overflow: hidden; }
summary { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3);
  cursor: pointer; list-style: none; user-select: none; color: var(--text-muted);
  font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--text); }
/* An open section names itself in full strength, and its header is ruled off from its body. */
[open] > summary { color: var(--text); border-bottom: 1px solid var(--border); }
.title { flex: 1; min-width: 0; }
.badge { color: var(--text-dim); font-weight: 400; text-transform: none; letter-spacing: 0; }
.chevron { transition: transform .12s ease; transform: rotate(-90deg); }
[open] > summary .chevron { transform: none; }
.bare { margin-bottom: var(--space-3); }
/* Back to the panel's own surface, so what is inside the section sits on the page, not on the bar. */
.body { padding: var(--space-3); background: var(--surface); }
</style>
