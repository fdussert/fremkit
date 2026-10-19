<script setup lang="ts">
/**
 * The settings window, laid out like macOS's: a sidebar that never scrolls away — the search,
 * every screen, then the app's panes — and on the right the pane, its title and its "expand
 * all" fixed, its sections scrolling under them.
 *
 * Every screen is listed rather than only the selected one: there are a few of them, picking one
 * is a click, and it selects that screen in the editor too (`selectScreen`), as the screen tabs
 * do — the screen pane always edits the screen the canvas shows.
 *
 * A search runs across every pane at once and shows what it found, pane by pane, opened; the
 * screen pane searched is the selected screen's. Escape clears it.
 */
import { computed, type Component } from 'vue'
import BaseIcon from '../../shared/ui/BaseIcon.vue'
import BaseInput from '../../shared/ui/BaseInput.vue'
import ScrollPanel from '../../shared/ui/ScrollPanel.vue'
import { useI18n } from '../../shared/i18n'
import { useAdminStore } from '../store'
import { APP_PANES, foldableSections, paneLabel, searchSettings, settingsPane, settingsQuery, SETTINGS_INDEX,
  type SettingsPane } from '../settingsWindow'
import SettingsScope from './SettingsScope.vue'
import ScreenPane from './ScreenPane.vue'
import GeneralPane from './GeneralPane.vue'
import AppearancePane from './AppearancePane.vue'
import SharePane from './SharePane.vue'
import HistoryPane from './HistoryPane.vue'
import PrivacyPane from './PrivacyPane.vue'
import DevicesPane from './DevicesPane.vue'
import AboutPane from './AboutPane.vue'

const s = useAdminStore()
const { t } = useI18n()

const PANES: Record<SettingsPane, Component> = {
  screen: ScreenPane, general: GeneralPane, appearance: AppearancePane, share: SharePane,
  history: HistoryPane, privacy: PrivacyPane, devices: DevicesPane, about: AboutPane,
}
/** A pane of one block shows it bare: a fold with nothing beside it only hides the setting. */
const bare = (pane: SettingsPane): boolean => SETTINGS_INDEX.filter((e) => e.pane === pane).length <= 1

const found = computed(() => searchSettings(settingsQuery.value, t))
const screens = computed(() => s.state.config?.screens ?? [])

const titleOf = (pane: SettingsPane): string => (pane === 'screen' ? s.screen.value?.name ?? '' : t(paneLabel(pane)))
const title = computed(() => (found.value ? t('admin.settings.results') : titleOf(settingsPane.value)))

function showScreen(id: string): void {
  if (id !== s.screen.value?.id) s.selectScreen(id)
  showPane('screen')
}
function showPane(pane: SettingsPane): void {
  settingsPane.value = pane
  settingsQuery.value = ''
}
const isCurrent = (pane: SettingsPane, screenId?: string): boolean =>
  !found.value && settingsPane.value === pane && (pane !== 'screen' || screenId === s.screen.value?.id)
</script>

<template>
  <div class="settings">
    <nav class="side" :aria-label="t('admin.settings.title')">
      <div class="search">
        <BaseIcon name="search" :size="14" class="glass" />
        <BaseInput v-model="settingsQuery" :placeholder="t('admin.settings.search')" :aria-label="t('admin.settings.search')"
          data-escape-clears @keydown.esc="settingsQuery = ''" />
      </div>
      <div class="entries">
        <p class="group">{{ t('admin.settings.screens') }}</p>
        <button v-for="x in screens" :key="x.id" type="button" class="entry" :class="{ on: isCurrent('screen', x.id) }"
          :aria-current="isCurrent('screen', x.id) ? 'page' : undefined" @click="showScreen(x.id)">
          <BaseIcon :name="x.kind === 'device' ? 'tablet' : 'monitor'" :size="16" /><span class="label">{{ x.name }}</span>
        </button>
        <p class="group">{{ t('admin.settings.app') }}</p>
        <button v-for="p in APP_PANES" :key="p.id" type="button" class="entry" :class="{ on: isCurrent(p.id) }"
          :aria-current="isCurrent(p.id) ? 'page' : undefined" @click="showPane(p.id)">
          <BaseIcon :name="p.icon" :size="16" /><span class="label">{{ t(paneLabel(p.id)) }}</span>
        </button>
      </div>
    </nav>

    <ScrollPanel class="pane" :section-ids="found ? [] : foldableSections(settingsPane)">
      <template #title><h3>{{ title }}</h3></template>
      <SettingsScope v-if="!found" :key="settingsPane" :matches="null" :bare="bare(settingsPane)">
        <component :is="PANES[settingsPane]" />
      </SettingsScope>
      <template v-else>
        <p v-if="!found.size" class="none">{{ t('admin.settings.noMatch') }}</p>
        <section v-for="[pane, ids] in found" :key="pane" class="result">
          <button type="button" class="where" @click="showPane(pane)">{{ titleOf(pane) }}<BaseIcon name="chevron-right" :size="14" /></button>
          <SettingsScope :matches="ids" :bare="bare(pane)">
            <component :is="PANES[pane]" />
          </SettingsScope>
        </section>
      </template>
    </ScrollPanel>
  </div>
</template>

<style scoped>
.settings { flex: 1; min-height: 0; display: flex; }
.side { flex: 0 0 230px; display: flex; flex-direction: column; min-height: 0; background: var(--surface-2);
  border-right: 1px solid var(--border); }
.search { position: relative; padding: var(--space-3); }
.search :deep(input) { padding-left: 28px; }
.glass { position: absolute; left: calc(var(--space-3) + 8px); top: 50%; transform: translateY(-50%); color: var(--text-dim); pointer-events: none; }
.entries { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-2) var(--space-3); }
.group { margin: var(--space-3) var(--space-2) var(--space-1); font-size: var(--fs-xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-dim); }
.group:first-child { margin-top: 0; }
.entry { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 32px; padding: 4px var(--space-2);
  font: inherit; font-size: var(--fs-sm); text-align: left; color: var(--text); background: transparent; border: 0;
  border-radius: var(--radius-sm); cursor: pointer; }
.entry .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry:hover { background: var(--surface-3); }
.entry.on { background: var(--accent); color: var(--on-accent); }
.pane { --scroll-panel-pad: var(--space-4); min-width: 0; padding-top: var(--space-3); }
h3 { margin: 0; font-size: var(--fs-lg); font-weight: 600; min-height: 32px; display: flex; align-items: center; }
.none { font-size: var(--fs-sm); color: var(--text-muted); }
.result { margin-bottom: var(--space-4); }
.where { display: inline-flex; align-items: center; gap: var(--space-1); margin: 0 0 var(--space-2); padding: 0;
  font: inherit; font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .08em;
  color: var(--text-muted); background: none; border: 0; cursor: pointer; }
.where:hover { color: var(--accent); }

/* A narrow window: the sidebar becomes a row of tabs above the pane. */
@media (max-width: 760px) {
  .settings { flex-direction: column; }
  .side { flex: 0 0 auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .search { padding-bottom: var(--space-2); }
  .entries { display: flex; gap: var(--space-1); overflow-x: auto; overflow-y: hidden; padding-bottom: var(--space-2); }
  .group { display: none; }
  .entry { width: auto; flex: 0 0 auto; }
  .entry .label { overflow: visible; }
}
</style>
