<script setup lang="ts">
/**
 * The registry, as a panel of its own.
 *
 * It used to be a tab in the 300 px left column, which is the palette used on every visit —
 * what can be dragged onto the canvas. Browsing is a trip made on purpose, and it will carry
 * themes and wallpapers before long, so it lives where Screen and Connections live: a modal
 * opened from the top bar.
 *
 * Three views of one index rather than three requests. **Available** is the shop, **Installed**
 * is what this machine has, **Updates** is the short list somebody came here to act on — and
 * the one the top bar's badge sends you to.
 */
import { computed, onMounted, onUnmounted } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import ConsentDialog from './ConsentDialog.vue'
import MarketplaceRow from './MarketplaceRow.vue'
import MarketplaceThemeRow from './MarketplaceThemeRow.vue'
import UpdateAllDialog from './UpdateAllDialog.vue'
import { pick, useI18n } from '../shared/i18n'
import { groupByCategory } from './library'
import { useMarketplaceStore, type MarketKind, type MarketView } from './marketplace'

const store = useMarketplaceStore()
const { t } = useI18n()

/** Opening the panel is the moment to try again after a registry that could not be reached. */
onMounted(() => { void store.load(store.state.offline) })
/** The results belong to the run that produced them, and closing the panel ends it. */
onUnmounted(() => { store.clearResults() })

const VIEWS = computed(() => [
  { value: 'available', label: t('admin.market.view.available') },
  { value: 'installed', label: t('admin.market.view.installed') },
  {
    value: 'updates',
    label: store.updates.value
      ? t('admin.market.view.updatesN', { n: store.updates.value })
      : t('admin.market.view.updates'),
  },
])

/**
 * Widgets or themes. The switch the panel was built around from the start, now with both.
 *
 * One panel rather than two, because it is one index and one install path: a theme is a package
 * that happens to be safer. What changes with the switch is the card — a widget's permissions
 * against a theme's swatches — and nothing else.
 */
const KINDS = computed(() => [
  { value: 'widget', label: t('admin.market.kind.widgets') },
  { value: 'theme', label: t('admin.market.kind.themes') },
])
const showingThemes = computed(() => store.state.kind === 'theme')

/** Every button is disabled while anything is in flight; only the working row says so. */
const locked = computed(() => store.state.busy !== null || store.state.updatingAll)

/**
 * The rows, on shelves in Available and flat elsewhere. A shelf with no title renders bare.
 *
 * Same `groupByCategory` the palette uses, so a widget sits on the same shelf before and after
 * it is installed — which is the only way the two lists can be read as one library.
 */
const shelves = computed(() => {
  const rows = store.shown.value
  if (store.state.view !== 'available') return [{ id: 'flat', title: '', widgets: rows }]
  return groupByCategory(rows, (a, b) => pick(a.name).localeCompare(pick(b.name)))
    .map((g) => ({ id: g.id, title: t(`admin.library.category.${g.id}`), widgets: g.widgets }))
})

/** How many rows the panel is about to draw, whichever kind is showing. */
const rowCount = computed(() => (showingThemes.value ? store.shownThemes.value.length : store.shown.value.length))

const empty = computed(() => {
  if (store.state.search) return t('admin.market.noMatch')
  if (showingThemes.value) return t('admin.market.noTheme')
  if (store.state.view === 'installed') return t('admin.market.noneInstalled')
  if (store.state.view === 'updates') return t('admin.market.noneWaiting')
  return t('admin.market.empty')
})
</script>

<template>
  <div class="market">
    <BaseSegmented :model-value="store.state.view" :options="VIEWS"
      @update:model-value="store.setView($event as MarketView)" />

    <div class="bar">
      <BaseInput v-model="store.state.search"
        :placeholder="showingThemes ? t('admin.market.searchTheme') : t('admin.market.search')" />
      <BaseSegmented class="kinds" :model-value="store.state.kind" :options="KINDS"
        @update:model-value="store.state.kind = $event as MarketKind" />
      <BaseButton v-if="!showingThemes && store.state.view === 'updates' && store.updates.value" class="bulk" :disabled="locked"
        @click="store.askUpdateAll()">
        {{ t('admin.market.updateAll') }}
      </BaseButton>
      <BaseButton variant="icon" :title="t('admin.market.refresh')" :disabled="store.state.loading"
        @click="store.refresh()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </div>

    <!-- A dashboard built before a widget moved to the registry has its tiles and not its
         folders. That is the one state worth interrupting the list for: it is the reason the
         panel was opened, and it is fixed in one press. -->
    <div v-if="!showingThemes && store.missing.value.length" class="placed">
      <span>{{ t('admin.market.placedMissing', { n: store.missing.value.length }) }}</span>
      <BaseButton variant="primary" :disabled="locked" @click="store.askInstallMissing()">
        {{ t('admin.market.installMissing') }}
      </BaseButton>
    </div>

    <p v-if="store.state.offline" class="note warn">{{ t('admin.market.offline') }}</p>
    <p v-else-if="store.state.error" class="note warn">{{ store.state.error }}</p>
    <p v-if="store.state.loading && !store.state.loaded" class="note">{{ t('admin.market.loading') }}</p>
    <p v-else-if="store.state.loaded && !store.state.offline && !rowCount" class="note">{{ empty }}</p>

    <div v-if="showingThemes" class="list">
      <MarketplaceThemeRow v-for="th in store.shownThemes.value" :key="th.id" :theme="th" />
    </div>

    <!-- Available is shelved, because it is a shop: ten widgets of four kinds read as a list
         of ten unless the shelves say what they are. Installed and Updates stay flat — they are
         short by definition, and a shelf around one row is noise. -->
    <template v-for="shelf in (showingThemes ? [] : shelves)" :key="shelf.id">
      <BaseSection v-if="shelf.title" :id="`market.${shelf.id}`" :title="shelf.title"
        :badge="String(shelf.widgets.length)" default-open>
        <div class="list">
          <MarketplaceRow v-for="w in shelf.widgets" :key="w.id" :widget="w" />
        </div>
      </BaseSection>
      <div v-else class="list">
        <MarketplaceRow v-for="w in shelf.widgets" :key="w.id" :widget="w" />
      </div>
    </template>

    <!-- Asked after the removal, not before it: the widget is gone either way, and a
         credential is not deleted by a decision about a widget. -->
    <BaseModal v-if="store.state.leftover" :title="t('admin.market.leftoverTitle')" :width="480"
      :close-label="t('admin.market.leftoverKeep')" @close="store.dismissLeftover()">
      <p class="lead">{{ t('admin.market.leftoverLead') }}</p>
      <label v-for="c in store.state.leftover.connections" :key="c.id" class="leftover">
        <input v-model="c.remove" type="checkbox" />
        <span>{{ t('admin.market.leftoverDelete', { name: c.name }) }}</span>
      </label>
      <div class="actions">
        <BaseButton variant="secondary" @click="store.dismissLeftover()">{{ t('admin.market.leftoverKeep') }}</BaseButton>
        <BaseButton variant="primary" @click="store.applyLeftover()">{{ t('common.apply') }}</BaseButton>
      </div>
    </BaseModal>

    <ConsentDialog v-if="store.state.consent" :prompt="store.state.consent"
      @accept="store.accept()" @cancel="store.cancel()" />
    <UpdateAllDialog v-else-if="store.state.updateAllOpen" :entries="store.updateAllPrompt.value"
      @accept="store.updateAll()" @cancel="store.cancelUpdateAll()" />
    <UpdateAllDialog v-else-if="store.state.installMissingOpen" :entries="store.installMissingPrompt.value"
      :title="t('admin.market.installMissingTitle', { n: store.missing.value.length })"
      :lead="t('admin.market.installMissingLead')"
      :confirm="t('admin.market.installMissing')"
      @accept="store.installMissing()" @cancel="store.cancelInstallMissing()" />
  </div>
</template>

<style scoped>
.market { display: flex; flex-direction: column; gap: var(--space-3); }
.bar { display: flex; align-items: center; gap: var(--space-2); }
.bar > :first-child { flex: 1; min-width: 0; }
.kinds { width: 160px; }
.placed { display: flex; align-items: center; gap: var(--space-3); font-size: var(--fs-sm);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
  border: 1px solid var(--accent); background: var(--surface-2); }
.placed span { flex: 1; min-width: 0; }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.lead { margin: 0 0 var(--space-3); font-size: var(--fs-sm); }
.leftover { display: flex; align-items: center; gap: var(--space-2); font-size: var(--fs-sm);
  padding: var(--space-1) 0; cursor: pointer; }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
/* The row's own look lives in MarketplaceRow; `note` stays because the panel prints its own. */
.note { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.note.warn { color: var(--danger); }
</style>
