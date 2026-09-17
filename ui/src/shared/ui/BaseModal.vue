<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import BaseIcon from './BaseIcon.vue'

withDefaults(defineProps<{ title: string; width?: number; closeLabel?: string }>(), { width: 560, closeLabel: 'Close' })
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

/**
 * Escape closes the dialog. Listened for in the capture phase on the window: the admin's own
 * shortcut handler also reads Escape (it clears the widget selection), and the dialog must win
 * without that handler having to know about it.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown, true)
  panel.value?.focus()
})
onUnmounted(() => window.removeEventListener('keydown', onKeyDown, true))
</script>

<template>
  <!-- A click on the backdrop closes; one inside the panel must not, hence the .self modifier. -->
  <div class="overlay" @click.self="emit('close')">
    <section ref="panel" class="panel" role="dialog" aria-modal="true" :aria-label="title"
      tabindex="-1" :style="{ width: width + 'px' }">
      <header>
        <h2>{{ title }}</h2>
        <button type="button" class="x" :title="closeLabel" :aria-label="closeLabel" @click="emit('close')">
          <BaseIcon name="x" :size="16" />
        </button>
      </header>
      <div class="body"><slot /></div>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  padding: var(--space-4); background: rgba(0, 0, 0, .55); }
.panel { display: flex; flex-direction: column; max-width: 90vw; max-height: 85vh; min-height: 0;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md);
  box-shadow: var(--shadow); }
.panel:focus { outline: none; }
header { display: flex; align-items: center; gap: var(--space-3); flex: 0 0 auto;
  padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
h2 { flex: 1; margin: 0; font-size: var(--fs-lg); font-weight: 600; }
.x { display: inline-flex; align-items: center; justify-content: center; font: inherit; cursor: pointer;
  padding: 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); }
.x:hover { background: var(--surface-3); color: var(--text); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); }
</style>
