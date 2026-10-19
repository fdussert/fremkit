<script setup lang="ts">
/**
 * "Copy settings from…": a drop-down of every other widget of the same kind — wherever it is
 * shown, on a page or in a bar, on any screen — whose settings can be pasted onto the one being
 * edited. Configuring a widget once and reusing it is the point; the caller owns
 * the write, so the same component serves a tile (`updateInstance`) and a bar widget
 * (`updateNavWidget`), each as one undo step.
 *
 * Every key of the source is copied, including those the manifest scopes to the other rendering:
 * the editor only shows the ones that matter here, and a key this rendering ignores is harmless.
 */
import { computed, ref } from 'vue'
import { pick, useI18n } from '../shared/i18n'
import { useAdminStore } from './store'

const props = defineProps<{ widgetId: string; instanceId: string }>()
const emit = defineEmits<{ copy: [settings: Record<string, unknown>] }>()

const s = useAdminStore()
const { t } = useI18n()

/** The widget's own name, used when an instance carries no title of its own. */
const widgetName = computed(() => pick(s.state.manifests[props.widgetId]?.name) || props.widgetId)

interface Source { id: string; label: string; settings: Record<string, unknown> }

const sources = computed<Source[]>(() => {
  const cfg = s.state.config
  if (!cfg) return []
  // Named after where it is first shown; the screen is only worth naming when there are several.
  const named = cfg.screens.length > 1
  const out: Source[] = []
  const seen = new Set<string>()
  for (const scr of cfg.screens) {
    const prefix = named ? `${scr.name} · ` : ''
    for (const p of scr.pages) {
      for (const item of p.items) {
        const w = cfg.widgets[item.instanceId]
        if (!w || w.widgetId !== props.widgetId || item.instanceId === props.instanceId || seen.has(item.instanceId)) continue
        seen.add(item.instanceId)
        out.push({ id: item.instanceId, label: `${prefix}${p.name} · ${w.title || widgetName.value}`, settings: w.settings })
      }
    }
    for (const item of scr.nav) {
      const w = cfg.widgets[item.instanceId]
      if (!w || w.widgetId !== props.widgetId || item.instanceId === props.instanceId || seen.has(item.instanceId)) continue
      seen.add(item.instanceId)
      out.push({ id: item.instanceId, label: prefix + t('admin.settings.copyFromBar', { name: widgetName.value }), settings: w.settings })
    }
  }
  return out
})

/** Bound to '' so the drop-down reads as an action: it snaps back to its placeholder after a copy. */
const value = ref('')

function onChange(event: Event): void {
  const select = event.target as HTMLSelectElement
  const source = sources.value.find((o) => o.id === select.value)
  select.value = ''
  value.value = ''
  if (source) emit('copy', { ...source.settings })
}
</script>

<template>
  <select v-if="sources.length" class="copyFrom" :value="value"
    :aria-label="t('admin.settings.copyFrom')" @change="onChange">
    <option value="">{{ t('admin.settings.copyFrom') }}</option>
    <option v-for="o in sources" :key="o.id" :value="o.id">{{ o.label }}</option>
  </select>
</template>

<style scoped>
.copyFrom { width: 100%; box-sizing: border-box; margin-bottom: var(--space-3);
  font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
</style>
