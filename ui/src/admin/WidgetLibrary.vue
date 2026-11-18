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
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import ScrollPanel from '../shared/ui/ScrollPanel.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import WidgetPreviewPopover from './WidgetPreviewPopover.vue'
import { pick, useI18n } from '../shared/i18n'
import { DND_EXISTING_TYPE, DND_TYPE, useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'
import { groupByCategory, matchesQuery, otherScreenWidgets, widgetKindsOnScreen } from './library'
import { openContextMenu } from '../shared/ui/contextMenu'
import { libraryMenu } from './menus'

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

/** What the search box holds. Kept for the visit only: a filter left on would hide widgets next time. */
const query = ref('')
const searching = computed(() => query.value.trim() !== '')

/**
 * Hide the widgets this screen already shows. A habit of the person editing, so it is kept per
 * browser like the folded shelves, never in the config.
 */
const HIDE_PLACED_KEY = 'fremkit.library.hidePlaced'
function loadHidePlaced(): boolean {
  try { return localStorage.getItem(HIDE_PLACED_KEY) === '1' } catch { return false }
}
const hidePlaced = ref(loadHidePlaced())
function setHidePlaced(value: boolean): void {
  hidePlaced.value = value
  try { localStorage.setItem(HIDE_PLACED_KEY, value ? '1' : '0') } catch { /* private window: this visit only */ }
}
const placed = computed(() => {
  const config = s.state.config
  const screen = s.screen.value
  return hidePlaced.value && config && screen ? widgetKindsOnScreen(config, screen.id) : new Set<string>()
})
const filtering = computed(() => searching.value || hidePlaced.value)

/**
 * One group per category that has widgets the search matches, each sorted by name in the
 * language in force. The category's own name is searched too, so "dev" lists the whole shelf.
 */
const groups = computed(() => groupByCategory(
  Object.values(s.state.manifests),
  (a, b) => pick(a.name).localeCompare(pick(b.name)),
).map((g) => {
  const title = t(`admin.library.category.${g.id}`)
  const widgets = g.widgets.filter((m) => !placed.value.has(m.id) && matchesQuery([m.id, pick(m.name), pick(m.description), title], query.value))
  return { ...g, title, widgets }
}).filter((g) => g.widgets.length > 0))

/** Widgets other screens show and this one does not: placed here, they stay the same widget. */
const elsewhere = computed(() => {
  const config = s.state.config
  const screen = s.screen.value
  if (!config || !screen) return []
  return otherScreenWidgets(config, screen.id).map((id) => {
    const w = config.widgets[id]
    const m = s.state.manifests[w.widgetId]
    return { id, title: w.title?.trim() || pick(m?.name) || w.widgetId, icon: m?.icon ?? 'layout-grid', widgetId: w.widgetId, name: pick(m?.name) }
  }).filter((w) => matchesQuery([w.title, w.name, w.widgetId], query.value))
})

const nothingFound = computed(() => filtering.value && !groups.value.length && !elsewhere.value.length)

/** Every shelf this list can show, found or not, so "fold all" also folds the ones a search hid. */
const sectionIds = computed(() => [
  'library.elsewhere',
  ...groupByCategory(Object.values(s.state.manifests), () => 0).map((g) => `library.${g.id}`),
])

/** Enter places the first card the search left, the same as clicking it. */
function placeFirst(): void {
  const existing = elsewhere.value[0]
  if (existing) { s.placeExisting(existing.id); return }
  const first = groups.value[0]?.widgets[0]
  if (first) s.addWidget(first.id)
}

function onDragExisting(e: DragEvent, id: string): void {
  s.setDragWidget(id)
  e.dataTransfer?.setData(DND_EXISTING_TYPE, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

/**
 * The card whose preview is showing, and where it is. Hover waits a moment, so sweeping the
 * pointer down the list does not flash a popover per card; focus shows it at once, since a
 * keyboard user is already pointing at that card on purpose.
 */
const previewed = ref<{ id: string; anchor: DOMRect } | null>(null)
let previewTimer: number | undefined
function showPreview(e: Event, id: string, delay: number): void {
  window.clearTimeout(previewTimer)
  const card = e.currentTarget as HTMLElement
  previewTimer = window.setTimeout(() => { previewed.value = { id, anchor: card.getBoundingClientRect() } }, delay)
}
function hidePreview(): void {
  window.clearTimeout(previewTimer)
  previewed.value = null
}
const previewManifest = computed(() => (previewed.value ? s.state.manifests[previewed.value.id] : undefined))

function onDragStart(e: DragEvent, id: string): void {
  hidePreview()
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
onBeforeUnmount(() => window.clearTimeout(previewTimer))
</script>

<template>
  <ScrollPanel class="library" :section-ids="sectionIds" :fold-disabled="searching">
    <template #title><h2>{{ t('admin.library.title') }}</h2></template>
    <template #tools>
      <BaseButton variant="icon" :title="t('admin.library.rescan')" @click="s.rescan()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </template>
    <template #header>
    <div class="search" data-library-search>
      <BaseInput v-model="query" :placeholder="t('admin.market.search')"
        @keydown.enter="placeFirst()" @keydown.esc="query = ''" />
      <BaseButton v-if="searching" variant="icon" class="clear" :title="t('admin.library.clearSearch')" @click="query = ''">
        <BaseIcon name="x" :size="14" />
      </BaseButton>
    </div>
    <label class="hide-placed">
      <input type="checkbox" :checked="hidePlaced" @change="setHidePlaced(($event.target as HTMLInputElement).checked)" />
      {{ t('admin.library.hidePlaced') }}
    </label>
    <WidgetPreviewPopover v-if="previewed && previewManifest" :manifest="previewManifest"
      :asks="s.state.asks[previewed.id]" :anchor="previewed.anchor" />
    </template>

    <p v-if="nothingFound" class="none">{{ t('admin.market.noMatch') }}</p>

    <BaseSection v-if="elsewhere.length" id="library.elsewhere" :title="t('admin.library.elsewhere')"
      :badge="String(elsewhere.length)" default-open :force-open="searching">
      <div class="list">
        <BaseCard v-for="w in elsewhere" :key="w.id" class="existing" grab :draggable="true"
          @dragstart="onDragExisting($event, w.id)" @dragend="s.setDragWidget(null)" @click="s.placeExisting(w.id)">
          <BaseIcon :name="w.icon" :size="20" />
          <div class="txt"><strong>{{ w.title }}</strong></div>
        </BaseCard>
      </div>
    </BaseSection>

    <BaseSection v-for="g in groups" :key="g.id" :id="`library.${g.id}`" :title="g.title"
      :badge="String(g.widgets.length)" default-open :force-open="searching">
      <div class="list">
        <BaseCard v-for="m in g.widgets" :key="m.id" grab :draggable="true" @dragstart="onDragStart($event, m.id)" @dragend="s.setDragWidget(null)"
          :data-library-widget="m.id" tabindex="0"
          @click="hidePreview(); s.addWidget(m.id)" @keydown.enter.self="s.addWidget(m.id)"
          @mouseenter="showPreview($event, m.id, 350)" @mouseleave="hidePreview()"
          @focus="showPreview($event, m.id, 0)" @blur="hidePreview()"
          @contextmenu="hidePreview(); openContextMenu($event, libraryMenu(s, market, m.id))">
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
  </ScrollPanel>
</template>

<style scoped>
/* Title and search fixed at the top of what is left of the sidebar; the shelves scroll below. */
.library { margin-top: var(--space-4); }
.search { position: relative; margin-bottom: var(--space-2); }
.search :deep(input) { padding-right: 32px; }
.clear { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); }
.hide-placed { display: flex; align-items: center; gap: var(--space-2); min-height: 32px;
  font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; margin-bottom: var(--space-2); }
.none { font-size: var(--fs-sm); color: var(--text-muted); margin: var(--space-2) 0; }
h2 { font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0; }
.existing { min-height: 44px; }
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
