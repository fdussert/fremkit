<script setup lang="ts">
/**
 * The Screen tab's "Navigation bar widgets" section: the bar's compact widgets in order, each
 * with its own settings folded away, plus a drop-down of every widget whose manifest declares a
 * compact rendering. Everything goes through the store's `apply`, so it is undoable.
 */
import { computed, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import CopySettingsFrom from './CopySettingsFrom.vue'
import SettingsForm from './SettingsForm.vue'
import { pick, useI18n } from '../shared/i18n'
import { NAV_SLOTS, navWidgetsOf, type NavSlot } from '../shared/types'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t } = useI18n()

const navWidgets = computed(() => navWidgetsOf(s.state.config!.display))
/** The two clusters, named in the language in force. */
const SLOT_OPTIONS = computed(() => NAV_SLOTS.map((value) => ({
  value, label: t(`admin.inspector.screen.navWidgets.slot.${value}`),
})))
/** Reordering happens within a side, so the arrows disable at the ends of that side only. */
const sameSide = (slot: NavSlot) => navWidgets.value.filter((w) => w.slot === slot)
const sidePosition = (id: string, slot: NavSlot): number => sameSide(slot).findIndex((w) => w.instanceId === id)
/** Only widgets with a compact rendering may go in the bar; the server refuses the others. */
const addable = computed(() => Object.values(s.state.manifests).filter((m) => m.compact))
/** Instance ids whose settings are unfolded. One at a time is the usual case, but not enforced. */
const open = ref<string[]>([])

const manifestOf = (widgetId: string) => s.state.manifests[widgetId]
const label = (widgetId: string): string => pick(manifestOf(widgetId)?.name) || widgetId
const isOpen = (id: string): boolean => open.value.includes(id)
function toggle(id: string): void {
  open.value = isOpen(id) ? open.value.filter((x) => x !== id) : [...open.value, id]
}

function onAdd(event: Event): void {
  const select = event.target as HTMLSelectElement
  const widgetId = select.value
  // The drop-down is an action, not a value: it snaps back to its placeholder either way.
  select.value = ''
  if (widgetId) s.addNavWidget(widgetId)
}

/**
 * Off is the absence of the key, never `false`: a bar nobody has asked a popover from keeps the
 * config file it already had.
 */
function onPopup(instanceId: string, value: boolean): void {
  s.updateNavWidget(instanceId, { popup: value || undefined })
}

/** One emit per edited key, exactly as the widget inspector does, so each is one undo step. */
function onSetting(instanceId: string, key: string, value: unknown): void {
  const current = navWidgets.value.find((w) => w.instanceId === instanceId)
  if (current) s.updateNavWidget(instanceId, { settings: { ...current.settings, [key]: value } })
}
</script>

<template>
  <p class="hint">{{ t('admin.inspector.screen.navWidgets.hint') }}</p>
  <p v-if="!navWidgets.length" class="hint">{{ t('admin.inspector.screen.navWidgets.empty') }}</p>
  <ul v-else class="list">
    <li v-for="w in navWidgets" :key="w.instanceId">
      <div class="head">
        <BaseIcon :name="manifestOf(w.widgetId)?.icon ?? 'layout-grid'" :size="16" />
        <button type="button" class="name" :aria-expanded="isOpen(w.instanceId)"
          :title="t(isOpen(w.instanceId) ? 'admin.inspector.screen.navWidgets.collapse' : 'admin.inspector.screen.navWidgets.expand')"
          @click="toggle(w.instanceId)">
          {{ label(w.widgetId) }}
          <BaseIcon :name="isOpen(w.instanceId) ? 'chevron-up' : 'chevron-down'" :size="14" />
        </button>
        <BaseButton variant="icon" :title="t('common.moveUp')" :disabled="sidePosition(w.instanceId, w.slot) === 0"
          @click="s.moveNavWidget(w.instanceId, -1)">
          <BaseIcon name="chevron-up" :size="14" />
        </BaseButton>
        <BaseButton variant="icon" :title="t('common.moveDown')"
          :disabled="sidePosition(w.instanceId, w.slot) === sameSide(w.slot).length - 1"
          @click="s.moveNavWidget(w.instanceId, 1)">
          <BaseIcon name="chevron-down" :size="14" />
        </BaseButton>
        <BaseButton variant="icon" :title="t('common.remove')" @click="s.removeNavWidget(w.instanceId)">
          <BaseIcon name="trash-2" :size="14" />
        </BaseButton>
      </div>
      <!-- Which side of the dots this widget sits on; the arrows above order it within that side. -->
      <BaseSegmented class="slot" :model-value="w.slot" :options="SLOT_OPTIONS"
        @update:model-value="s.updateNavWidget(w.instanceId, { slot: $event as NavSlot })" />
      <!-- Touching the compact widget then opens the full one above the bar instead of reaching it. -->
      <BaseCheckbox class="popup" :model-value="w.popup === true"
        :label="t('admin.inspector.screen.navWidgets.popup')"
        @update:model-value="onPopup(w.instanceId, $event)" />
      <div v-if="isOpen(w.instanceId) && manifestOf(w.widgetId)" class="settings">
        <!-- Usually a full tile of the same widget, already configured: copying it is quicker
             than repeating the same choices in the bar. -->
        <CopySettingsFrom :widget-id="w.widgetId" :instance-id="w.instanceId"
          @copy="s.updateNavWidget(w.instanceId, { settings: $event })" />
        <!-- The bar draws the compact rendering, so a setting scoped to the tile is not shown here. -->
        <SettingsForm :schema="manifestOf(w.widgetId)!.settingsSchema" scope="compact" :values="w.settings"
          :widget-id="w.widgetId"
          @change="(key, value) => onSetting(w.instanceId, key, value)" />
      </div>
    </li>
  </ul>
  <p v-if="!addable.length" class="hint">{{ t('admin.inspector.screen.navWidgets.none') }}</p>
  <select v-else class="add" value="" @change="onAdd">
    <option value="">{{ t('admin.inspector.screen.navWidgets.add') }}</option>
    <option v-for="m in addable" :key="m.id" :value="m.id">{{ pick(m.name) }}</option>
  </select>
</template>

<style scoped>
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.hint { font-size: var(--fs-xs); color: var(--text-dim); margin: 0 0 var(--space-2); }
.list { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.list li { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2); }
.head { display: flex; align-items: center; gap: var(--space-1); }
.slot { margin-top: var(--space-1); }
/* The checkbox brings its own bottom margin, which is too much inside a compact row. */
.popup { margin: var(--space-1) 0 0; }
.slot :deep(button) { padding: 3px 6px; }
.name { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-1);
  font: inherit; font-size: var(--fs-sm); color: var(--text); text-align: left; cursor: pointer;
  background: none; border: 0; padding: 0; }
.settings { margin-top: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--border); }
.add { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
</style>
