<script setup lang="ts">
/**
 * What a widget's manifest asks for.
 *
 * A widget is third-party code and the manifest is written by its author, so the host enforces
 * it whatever is shown here — but nobody consents to what they cannot see. `compact` is the
 * one-line form for a library card; the full form lists each entry.
 */
import { computed } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { notGranted, widgetPermissions } from './permissions'
import type { WidgetManifest, WidgetPermissionSet } from '../shared/types'

const props = defineProps<{
  manifest: WidgetManifest | undefined
  compact?: boolean
  /**
   * What the manifest asks for, when that can differ from what it may do — an installed widget
   * whose update wants more than was granted. Absent for a built-in, which is trusted with the
   * server it ships in.
   */
  asks?: WidgetPermissionSet
}>()
const { t } = useI18n()
const p = computed(() => widgetPermissions(props.manifest))
const missing = computed(() => notGranted(props.manifest, props.asks))

/** The three groups, in the order they matter: reading, then acting, then leaving the machine. */
const groups = computed(() => [
  { key: 'reads', icon: 'eye', items: p.value.reads },
  { key: 'controls', icon: 'zap', items: p.value.controls },
  { key: 'network', icon: 'globe', items: p.value.network },
].filter((g) => g.items.length))

const missingGroups = computed(() => [
  { key: 'reads', icon: 'eye', items: missing.value.reads },
  { key: 'controls', icon: 'zap', items: missing.value.controls },
  { key: 'network', icon: 'globe', items: missing.value.network },
].filter((g) => g.items.length))
</script>

<template>
  <p v-if="compact" class="line">
    <template v-if="p.none && missing.none">{{ t('admin.permissions.none') }}</template>
    <template v-else>
      <span v-for="g in groups" :key="g.key" class="bit">
        {{ t(`admin.permissions.${g.key}.short`, { n: g.items.length }) }}
      </span>
      <span v-if="!missing.none" class="bit denied">
        {{ t('admin.permissions.notGranted.short', { n: missing.count }) }}
      </span>
    </template>
  </p>

  <template v-else>
    <h3>{{ t('admin.permissions.title') }}</h3>
    <p v-if="p.none" class="none">{{ t('admin.permissions.none') }}</p>
    <template v-else>
      <div v-for="g in groups" :key="g.key" class="group">
        <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
        <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
      </div>
    </template>
    <template v-if="!missing.none">
      <h3 class="denied">{{ t('admin.permissions.notGranted') }}</h3>
      <div v-for="g in missingGroups" :key="'no-' + g.key" class="group denied">
        <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
        <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
      </div>
      <p class="note">{{ t('admin.permissions.notGrantedNote') }}</p>
    </template>
    <p class="note">{{ t('admin.permissions.note') }}</p>
  </template>
</template>

<style scoped>
.line { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-dim); display: flex; gap: var(--space-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.group { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-2); }
.lbl { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .06em; }
.items { display: flex; flex-wrap: wrap; gap: var(--space-1); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: 1px 5px; word-break: break-all; }
.none, .note { margin: 0 0 var(--space-2); font-size: var(--fs-xs); color: var(--text-dim); }
/* Asked for and not granted: legible, and plainly not part of the list above it. */
.denied { color: var(--text-dim); }
.group.denied code { border-style: dashed; text-decoration: line-through; }
</style>
