<script lang="ts">
/**
 * Which sections are open, kept per browser rather than in the config: it is a habit of the
 * person editing, not a property of the screen they are editing, and it must not travel to
 * another machine through a saved config.
 *
 * Module scope, so every section on the page reads and writes the same record.
 */
import { reactive } from 'vue'

const KEY = 'fremkit.sections'

function load(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, boolean> } catch { return {} }
}

const open = reactive<Record<string, boolean>>(load())

function remember(id: string, value: boolean): void {
  open[id] = value
  try { localStorage.setItem(KEY, JSON.stringify(open)) } catch { /* private window: this session only */ }
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import BaseIcon from './BaseIcon.vue'

const props = withDefaults(defineProps<{
  /** Stable id, since it is what the open state is remembered under. */
  id: string
  title: string
  /** Whether the section starts open the first time it is seen. */
  defaultOpen?: boolean
  /** A short count or state shown on the right of the header, visible while folded. */
  badge?: string
}>(), { defaultOpen: false, badge: '' })

const isOpen = computed(() => open[props.id] ?? props.defaultOpen)
</script>

<template>
  <details class="section" :open="isOpen" @toggle="remember(props.id, ($event.target as HTMLDetailsElement).open)">
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
/* Back to the panel's own surface, so what is inside the section sits on the page, not on the bar. */
.body { padding: var(--space-3); background: var(--surface); }
</style>
