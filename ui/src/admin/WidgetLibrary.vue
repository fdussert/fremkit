<script lang="ts">
/**
 * The card's own dragend does not always fire — a drag released outside the window, or onto
 * another application, can skip it — and a stale dragWidgetId would make the canvas show a
 * ghost for the next unrelated drag. Clear it from the document too.
 *
 * Module scope, reference counted, so however many libraries are mounted the document carries
 * exactly one pair of listeners — and keeps them until the last library goes away.
 */
import { useAdminStore as useStore } from './store'

let mounted = 0
function clearDrag(): void { useStore().setDragWidget(null) }

function bindDragFallback(): void {
  if (mounted++ > 0) return
  document.addEventListener('dragend', clearDrag)
  document.addEventListener('drop', clearDrag)
}
function unbindDragFallback(): void {
  if (--mounted > 0) return
  document.removeEventListener('dragend', clearDrag)
  document.removeEventListener('drop', clearDrag)
}
</script>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import BrowseLibrary from './BrowseLibrary.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import { DND_TYPE, useAdminStore } from './store'
import { createMarketplaceStore } from './marketplace'

const s = useAdminStore()
const { t } = useI18n()

/**
 * The two halves of the same column: what is here, and what could be. `local` stays the default
 * because that is the one used on every visit; Browse is a trip somebody makes on purpose.
 */
const tab = ref<'local' | 'browse'>('local')

/** Opening Browse is the moment to try again after a registry that could not be reached. */
watch(tab, (next) => { if (next === 'browse' && market.state.offline) void market.load(true) })

/**
 * Installing writes files on the server; the library is what reads them, so a rescan is how the
 * new widget appears in the local tab without a reload.
 */
const market = createMarketplaceStore({ onChanged: () => s.rescan() })

/**
 * The index is read when the column mounts, not when Browse is opened.
 *
 * The badge on the Browse tab counts the updates waiting, and Browse is the tab nobody is on —
 * so a badge that only appeared once you had looked was a badge that never told you anything.
 * `load()` is idempotent and quiet about failing.
 */
onMounted(() => { void market.load() })

function onDragStart(e: DragEvent, id: string): void {
  s.setDragWidget(id)
  e.dataTransfer?.setData(DND_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

/** The version of an installed widget, for the chip on its card in the local tab. */
function installedVersion(id: string): string | null {
  return s.state.sources[id] === 'installed' ? s.state.manifests[id]?.version ?? null : null
}
/** True when the registry has something newer for a widget that is already here. */
function hasUpdate(id: string): boolean {
  return market.state.widgets.some((w) => w.id === id && w.updateAvailable)
}

onMounted(bindDragFallback)
onBeforeUnmount(unbindDragFallback)
</script>

<template>
  <section>
    <h2>
      {{ t('admin.library.title') }}
      <BaseButton v-if="tab === 'local'" variant="icon" :title="t('admin.library.rescan')" @click="s.rescan()">
        <BaseIcon name="redo-2" :size="16" />
      </BaseButton>
    </h2>

    <BaseSegmented v-model="tab" class="tabs" :options="[
      { value: 'local', label: t('admin.library.tabLocal') },
      { value: 'browse', label: market.updates.value ? t('admin.library.tabBrowseN', { n: market.updates.value }) : t('admin.library.tabBrowse') },
    ]" />

    <div v-if="tab === 'local'" class="list">
      <BaseCard v-for="m in Object.values(s.state.manifests)" :key="m.id" grab :draggable="true" @dragstart="onDragStart($event, m.id)" @dragend="s.setDragWidget(null)"
        @click="s.addWidget(m.id)">
        <BaseIcon :name="m.icon" :size="20" />
        <div class="txt">
          <strong>
            {{ pick(m.name) }}
            <span v-if="installedVersion(m.id)" class="chip">{{ t('admin.market.installedAt', { version: installedVersion(m.id) ?? '' }) }}</span>
            <span v-if="hasUpdate(m.id)" class="chip up">{{ t('admin.market.updateChip') }}</span>
          </strong>
          <small>{{ m.defaultSize[0] }}×{{ m.defaultSize[1] }} · {{ pick(m.description) }}</small>
          <WidgetPermissions :manifest="m" :asks="s.state.asks[m.id]" compact />
        </div>
      </BaseCard>
      <BaseCard v-for="e in s.state.catalogErrors" :key="'err-' + e.id" class="err">
        <BaseIcon name="alert-triangle" :size="20" />
        <div class="txt"><strong>{{ e.id }}</strong><small>{{ e.error }}</small></div>
      </BaseCard>
    </div>

    <BrowseLibrary v-else :store="market" />
  </section>
</template>

<style scoped>
section { margin-top: var(--space-4); }
h2 { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0 0 var(--space-2); }
.tabs { margin-bottom: var(--space-2); }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.txt { display: flex; flex-direction: column; min-width: 0; }
.txt strong { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 0 5px; }
.chip.up { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.err { border-color: var(--danger); color: var(--danger); }
</style>
