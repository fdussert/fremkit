<script setup lang="ts">
/**
 * The inspector while several tiles are selected: how many, the look they can share (title,
 * opacity), their lock, and the commands for all of them. Everything else — settings, colours,
 * connections — belongs to one widget and waits for one to be selected.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import { useI18n } from '../shared/i18n'
import { surfaceOpacity } from '../shared/background'
import { useAdminStore } from './store'
import { tilesDeleteKey, widgetDelete } from './widgetDelete'

const s = useAdminStore()
const { t } = useI18n()

const tiles = computed(() => s.selectedTiles.value)
const ids = computed(() => tiles.value.map((w) => w.instanceId))
const allShown = computed(() => tiles.value.every((w) => w.showTitle))
const allLocked = computed(() => tiles.value.every((w) => w.locked))
const someLocked = computed(() => tiles.value.some((w) => w.locked) && !allLocked.value)
const opacities = computed(() => [...new Set(tiles.value.map((w) => Math.round(surfaceOpacity(w.opacity) * 100)))])
function setOpacity(percent: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  s.updateWidgets(ids.value, { opacity: clamped === 100 ? undefined : clamped / 100 })
}

/** Removing deletes the widgets this screen alone shows: that takes a second press, as for one. */
const deletes = computed(() => ids.value.some((id) => s.isLastPlace(id)))
const armed = computed(() => widgetDelete.armed(tilesDeleteKey(ids.value)))
function remove(): void {
  const list = [...ids.value]
  if (!deletes.value) { s.removeTiles(list); return }
  widgetDelete.ask(tilesDeleteKey(list), () => s.removeTiles(list))
}
</script>

<template>
  <section class="selection" data-test="selection-inspector">
    <h2><BaseIcon name="layout-grid" :size="18" />{{ t('admin.inspector.selection.title', { n: tiles.length }) }}</h2>
    <p class="hint">{{ t('admin.inspector.selection.hint') }}</p>
    <BaseCheckbox :model-value="allShown" :label="t('admin.inspector.widget.showTitle')"
      @update:model-value="s.updateWidgets(ids, { showTitle: $event })" />
    <BaseField :label="t(opacities.length === 1 ? 'admin.inspector.widget.opacity' : 'admin.inspector.selection.mixed')">
      <BaseRange :model-value="opacities.length === 1 ? opacities[0] : 100" :step="5"
        :aria-label="t('admin.inspector.widget.opacity.aria')" @change="setOpacity" />
    </BaseField>
    <BaseCheckbox :model-value="allLocked" :label="t('admin.inspector.widget.lock')"
      @update:model-value="s.setLockedTiles(ids, $event)" />
    <p v-if="someLocked" class="hint">{{ t('admin.inspector.selection.lockedNote') }}</p>
    <div class="actions">
      <BaseButton @click="s.duplicateTiles(ids)"><BaseIcon name="copy" :size="16" />{{ t('common.duplicate') }}</BaseButton>
      <BaseButton :variant="deletes || armed ? 'danger' : undefined" @click="remove">
        <BaseIcon :name="deletes ? 'trash-2' : 'x'" :size="16" />{{ armed ? t('common.confirm') : t(deletes ? 'admin.inspector.selection.delete' : 'admin.inspector.selection.remove', { n: tiles.length }) }}
      </BaseButton>
    </div>
  </section>
</template>

<style scoped>
h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-2); font-size: var(--fs-md); }
.hint { margin: 0 0 var(--space-3); font-size: var(--fs-sm); color: var(--text-muted); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); }
</style>
