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
/**
 * The palette: what can be dragged onto the canvas, and nothing else, on shelves by category.
 *
 * Browsing the registry used to be a tab in here, which put a shop inside a 300 px column that
 * is opened on every visit. It is a modal now (`MarketplacePanel`), and what stays behind is the
 * part that belongs to a widget already on this machine: a dot saying it came from the registry,
 * and a chip saying a newer version is waiting — which opens the modal on the Updates view.
 */
import { computed, onMounted, onBeforeUnmount } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import { DND_TYPE, useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'
import { groupByCategory } from './library'

const s = useAdminStore()
const market = useMarketplaceStore()
const { t } = useI18n()

/**
 * The index is read here, when the column mounts, and nowhere else.
 *
 * The top bar's badge counts the updates waiting, and nobody opens a panel to be told there is
 * something in it — so the count has to be right on the first paint. `load()` is idempotent and
 * quiet about failing.
 */
onMounted(() => { void market.load() })

/** One group per category that has widgets, each sorted by name in the language in force. */
const groups = computed(() => groupByCategory(
  Object.values(s.state.manifests),
  (a, b) => pick(a.name).localeCompare(pick(b.name)),
).map((g) => ({ ...g, title: t(`admin.library.category.${g.id}`) })))

function onDragStart(e: DragEvent, id: string): void {
  s.setDragWidget(id)
  e.dataTransfer?.setData(DND_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

/** The version of an installed widget, for the chip on its card. */
function installedVersion(id: string): string | null {
  return s.state.sources[id] === 'installed' ? s.state.manifests[id]?.version ?? null : null
}
/** The version the registry has for a widget that is already here, when it is newer. */
function updateTo(id: string): string | null {
  return market.state.widgets.find((w) => w.id === id && w.updateAvailable)?.version ?? null
}
/** The chip is a way in: the modal opens on the list the chip is about. */
function openUpdates(): void {
  market.setView('updates')
  s.openModal('marketplace')
}

onMounted(bindDragFallback)
onBeforeUnmount(unbindDragFallback)
</script>

<template>
  <section>
    <h2>
      {{ t('admin.library.title') }}
      <BaseButton variant="icon" :title="t('admin.library.rescan')" @click="s.rescan()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </h2>

    <BaseSection v-for="g in groups" :key="g.id" :id="`library.${g.id}`" :title="g.title"
      :badge="String(g.widgets.length)" default-open>
      <div class="list">
        <BaseCard v-for="m in g.widgets" :key="m.id" grab :draggable="true" @dragstart="onDragStart($event, m.id)" @dragend="s.setDragWidget(null)"
          @click="s.addWidget(m.id)">
          <BaseIcon :name="m.icon" :size="20" />
          <div class="txt">
            <strong>
              {{ pick(m.name) }}
              <!-- A dot in the "ok" colour: "this came from the registry, and it is here". -->
              <span v-if="installedVersion(m.id)" class="state">
                <i class="dot ok"></i>{{ t('admin.market.installedAt', { version: installedVersion(m.id) ?? '' }) }}
              </span>
              <button v-if="updateTo(m.id)" type="button" class="chip up"
                :title="t('admin.market.openUpdates')" @click.stop="openUpdates()">
                ↑ {{ updateTo(m.id) }}
              </button>
            </strong>
            <small>{{ m.defaultSize[0] }}×{{ m.defaultSize[1] }} · {{ pick(m.description) }}</small>
            <WidgetPermissions :manifest="m" :asks="s.state.asks[m.id]" compact />
          </div>
        </BaseCard>
      </div>
    </BaseSection>
    <div v-if="s.state.catalogErrors.length" class="list errors">
      <BaseCard v-for="e in s.state.catalogErrors" :key="'err-' + e.id" class="err">
        <BaseIcon name="alert-triangle" :size="20" />
        <div class="txt"><strong>{{ e.id }}</strong><small>{{ e.error }}</small></div>
      </BaseCard>
    </div>
  </section>
</template>

<style scoped>
section { margin-top: var(--space-4); }
h2 { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0 0 var(--space-2); }
.errors { margin-top: var(--space-3); }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.txt { display: flex; flex-direction: column; min-width: 0; }
.txt strong { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); flex: 0 0 auto; }
.dot.ok { background: var(--ok); }
.chip { font: inherit; font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 0 5px; background: transparent; }
.chip.up { color: var(--on-accent); background: var(--accent); border-color: var(--accent); cursor: pointer; }
.err { border-color: var(--danger); color: var(--danger); }
</style>
