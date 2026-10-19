<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseChip from '../shared/ui/BaseChip.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import { useI18n } from '../shared/i18n'
import { useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'
import HealthMenu from './HealthMenu.vue'
import { openHistory } from './history'
import { openSettings } from './settingsWindow'
import { paletteOpen } from './CommandPalette.vue'
import { shortcutHint } from './shortcuts'
import type { Mode } from './store'

const s = useAdminStore()
const market = useMarketplaceStore()
const { t } = useI18n()
const MODES = computed(() => [
  { value: 'edit', label: t('admin.topbar.mode.edit'), icon: 'pencil' },
  { value: 'test', label: t('admin.topbar.mode.test'), icon: 'play' },
])
const statusLabel = computed(() => t(`admin.topbar.status.${s.state.status}`))
const statusTone = computed(() => (s.state.status === 'error' ? 'danger' : s.state.status === 'saving' ? 'accent' : 'neutral'))
</script>

<template>
  <p v-if="s.state.degraded" class="degraded" role="alert">
    <BaseIcon name="alert-triangle" :size="16" />
    {{ t('admin.topbar.degraded.before') }} <code>data/fremkit.json</code>
    {{ t('admin.topbar.degraded.after') }}
  </p>
  <header>
    <!-- With several screens, the page name alone does not say which layout is being edited. -->
    <strong class="page"><span v-if="(s.state.config?.screens.length ?? 0) > 1" class="screen">{{ s.screen.value?.name }} · </span>{{ s.page.value?.name ?? '—' }}</strong>
    <BaseSegmented class="modes" :model-value="s.state.mode" :options="MODES"
      @update:model-value="s.setMode($event as Mode)" />
    <BaseButton variant="icon" :title="t('admin.topbar.undo')" :disabled="!s.canUndo.value" @click="s.undo()"><BaseIcon name="undo-2" /></BaseButton>
    <BaseButton variant="icon" :title="t('admin.topbar.redo')" :disabled="!s.canRedo.value" @click="s.redo()"><BaseIcon name="redo-2" /></BaseButton>
    <BaseButton variant="icon" :title="t('admin.topbar.history')" data-test="open-history" @click="openHistory(s)"><BaseIcon name="history" /></BaseButton>
    <span class="spacer" />
    <button type="button" class="panel commands" :title="t('admin.palette.title')" data-test="open-palette" @click="paletteOpen = true">
      <BaseIcon name="search" :size="16" />{{ t('admin.palette.button') }}<kbd>{{ shortcutHint('palette') }}</kbd>
    </button>
    <HealthMenu />
    <BaseChip :tone="statusTone">{{ statusLabel }}</BaseChip>
    <button type="button" class="panel" :title="t('admin.topbar.openSettings')" @click="openSettings(s)">
      <BaseIcon name="settings" :size="16" />{{ t('admin.tabs.settings') }}
    </button>
    <button type="button" class="panel" :title="t('admin.topbar.openConnections')" @click="s.openModal('connections')">
      <BaseIcon name="network" :size="16" />{{ t('admin.tabs.connections') }}
    </button>
    <!-- The badge is right on the first paint: the widget column reads the index when it mounts,
         so nobody has to open this to be told something is waiting. -->
    <button type="button" class="panel" :title="t('admin.topbar.openMarketplace')" @click="s.openModal('marketplace')">
      <BaseIcon name="package" :size="16" />{{ t('admin.tabs.marketplace') }}
      <BaseChip v-if="market.updates.value" tone="accent">{{ market.updates.value }}</BaseChip>
    </button>
  </header>
</template>

<style scoped>
.degraded { display: flex; align-items: center; gap: var(--space-2); margin: 0;
  padding: var(--space-2) var(--space-4); font-size: var(--fs-sm);
  color: #fff; background: var(--danger); }
.degraded code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
header { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4);
  background: var(--surface); border-bottom: 1px solid var(--border); }
.page { font-size: var(--fs-lg); }
.page .screen { color: var(--text-muted); font-weight: normal; }
.modes { width: 200px; }
.spacer { flex: 1; }
.panel { display: inline-flex; align-items: center; gap: var(--space-2); font: inherit; font-size: var(--fs-sm);
  color: var(--text-muted); text-decoration: none; padding: 6px 12px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong); background: transparent; cursor: pointer; }
.commands kbd { font-family: inherit; font-size: var(--fs-xs); color: var(--text-dim); }
.panel:hover { color: var(--text); background: var(--surface-2); }
</style>
