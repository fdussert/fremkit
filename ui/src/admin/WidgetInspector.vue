<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseColor from '../shared/ui/BaseColor.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import BackgroundPicker from './BackgroundPicker.vue'
import CopySettingsFrom from './CopySettingsFrom.vue'
import MissingWidget from './MissingWidget.vue'
import SettingsForm from './SettingsForm.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import { surfaceOpacity } from '../shared/background'
import { useAdminStore } from './store'
import { fits, type Rect } from './layout'
import { THEME_ACCENT, THEME_SURFACE } from '../shared/color'
import { fieldsInScope, type AccentMode, type WidgetBackground } from '../shared/types'

const s = useAdminStore()
const { t } = useI18n()
const inst = computed(() => s.selected.value)
const manifest = computed(() => (inst.value ? s.state.manifests[inst.value.widgetId] : undefined))
/**
 * What the widget's manifest asks for, beside what it may do.
 *
 * `manifest` is the *granted* one — narrowed to the consent record for an installed widget — so
 * without this the inspector could not tell a widget that is quietly missing a permission from
 * one that never wanted it. Undefined for a built-in, which has no record to differ from.
 */
const asks = computed(() => (inst.value ? s.state.asks[inst.value.widgetId] : undefined))
/** Only the tile's own settings; the bar's are edited in the Screen tab. */
const schema = computed(() => fieldsInScope(manifest.value?.settingsSchema, 'tile'))

const ACCENT_MODES = computed(() => (['none', 'frame', 'fill'] as const).map((value) => ({
  value, label: t(`admin.inspector.widget.accentMode.${value}`),
})))

// Local copy of the geometry: an invalid value shows a red border and is simply not applied.
const geom = ref<Rect>({ x: 0, y: 0, w: 1, h: 1 })
watch(inst, (w) => { if (w) geom.value = { x: w.x, y: w.y, w: w.w, h: w.h } }, { immediate: true })
/** Unknown manifest: assume the loosest possible minimum rather than block the fields. */
const minSize = computed<[number, number]>(() => manifest.value?.minSize ?? [1, 1])
const tooSmall = computed(() => geom.value.w < minSize.value[0] || geom.value.h < minSize.value[1])
const geomOk = computed(() => {
  const g = geom.value
  // An empty or non-numeric field is NaN: invalid, and never committed as a 0.
  if (!inst.value || ![g.x, g.y, g.w, g.h].every((n) => Number.isFinite(n))) return false
  // The overlay enforces minSize on drag and on the keyboard; these four fields must too.
  if (tooSmall.value) return false
  return fits(g, s.grid.value, s.others(inst.value.instanceId))
})

function commitGeom(): void {
  if (!inst.value || !geomOk.value) return
  s.updateInstance(inst.value.instanceId, { ...geom.value })
}
/** Clearing writes `undefined`, which drops the key when the config is serialised. */
function setAccentColor(value: string | undefined): void {
  s.updateInstance(inst.value!.instanceId, { accentColor: value })
}
/** Same rule for the tile's own surface colour: no colour means the theme surface. */
function setBgColor(value: string | undefined): void {
  s.updateInstance(inst.value!.instanceId, { bgColor: value })
}
/** 'none' is the default, so it is stored as an absent key rather than an explicit value. */
function setAccentMode(value: string): void {
  s.updateInstance(inst.value!.instanceId, { accentMode: value === 'none' ? undefined : value as AccentMode })
}
/**
 * One mutation path for the whole background object, mirroring ScreenInspector's: keys set to
 * `undefined` are dropped, and an object left without an image goes away entirely — which is
 * what makes undo round-trip back to an instance that never carried the key at all.
 */
function setBackground(patch: Partial<WidgetBackground>): void {
  const next = { ...(inst.value!.background ?? {}), ...patch } as Record<string, unknown>
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
  s.updateInstance(inst.value!.instanceId, {
    background: next.image ? (next as unknown as WidgetBackground) : undefined,
  })
}
/** The slider works in whole percents; the config stores the 0–1 opacity itself. */
const opacityPercent = computed(() => Math.round(surfaceOpacity(inst.value?.opacity) * 100))
/**
 * Fully opaque is the default, so it is stored as an absent key rather than an explicit 1. The
 * slider goes all the way down to 0, which is a genuinely see-through tile, border included.
 */
function setOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.updateInstance(inst.value!.instanceId, { opacity: clamped === 100 ? undefined : clamped / 100 })
}
/**
 * The same opacity, as the yes/no question people actually ask of a tile. A tile with no
 * surface is one at 0; ticking the box brings back a solid one rather than the value it had,
 * which is the answer someone who just hid the surface is looking for.
 */
const showBg = computed(() => opacityPercent.value > 0)
function onSetting(key: string, value: unknown): void {
  s.updateInstance(inst.value!.instanceId, { settings: { ...inst.value!.settings, [key]: value } })
}

/** The pages the selected tile could go to: every one but the page it already sits on. */
const otherPages = computed(() => (s.state.config?.pages ?? [])
  .map((p, index) => ({ index, name: p.name }))
  .filter((p) => p.index !== s.state.pageIndex))
/** Nothing is moved until the button is pressed, so a mis-click on the list costs nothing. */
const moveTarget = ref('')
watch(inst, () => { moveTarget.value = '' })
function moveToPage(): void {
  if (!inst.value || moveTarget.value === '') return
  // The store switches the page and keeps the widget selected, which remounts this form anyway.
  s.moveWidget(inst.value.instanceId, Number(moveTarget.value))
  moveTarget.value = ''
}
</script>

<template>
  <p v-if="!inst" class="empty">{{ t('admin.inspector.widget.empty') }}</p>
  <template v-else>
    <div class="head">
      <BaseIcon :name="manifest?.icon ?? 'layout-grid'" :size="20" />
      <strong>{{ manifest ? pick(manifest.name) : inst.widgetId }}</strong>
    </div>
    <MissingWidget v-if="!manifest" :widget-id="inst.widgetId" />

    <BaseField :label="t('admin.inspector.widget.title')">
      <BaseInput lazy :model-value="inst.title ?? ''" :placeholder="manifest ? pick(manifest.name) : inst.widgetId"
        @update:model-value="s.updateInstance(inst!.instanceId, { title: String($event) })" />
    </BaseField>
    <BaseCheckbox :model-value="inst.showTitle" :label="t('admin.inspector.widget.showTitle')"
      @update:model-value="s.updateInstance(inst!.instanceId, { showTitle: $event })" />

    <BaseSection id="widget.background" :title="t('admin.inspector.widget.background')">
    <BaseCheckbox :model-value="showBg" :label="t('admin.inspector.widget.showBg')"
      @update:model-value="setOpacity($event ? 100 : 0)" />
    <BaseField :label="t('admin.inspector.widget.bgColor')" :hint="t('admin.inspector.widget.bgColor.hint')">
      <BaseColor :model-value="inst.bgColor ?? ''" :fallback="THEME_SURFACE" :reset-label="t('common.reset')"
        :aria-label="t('admin.inspector.widget.bgColor')"
        @update:model-value="setBgColor($event)" @reset="setBgColor(undefined)" />
    </BaseField>
    <BaseField :label="t('admin.inspector.widget.opacity', { percent: opacityPercent })"
      :hint="t('admin.inspector.widget.opacity.hint')">
      <BaseRange :model-value="opacityPercent" :step="5"
        :aria-label="t('admin.inspector.widget.opacity.aria')" @change="setOpacity" />
    </BaseField>
    <BackgroundPicker :model-value="inst.background ?? {}" show-dim @update="setBackground($event)" />
    </BaseSection>

    <BaseSection id="widget.accent" :title="t('admin.inspector.widget.accent')">
    <BaseField :label="t('admin.inspector.widget.accentColor')" :hint="t('admin.inspector.widget.accentColor.hint')">
      <BaseColor :model-value="inst.accentColor ?? ''" :fallback="THEME_ACCENT" :reset-label="t('common.reset')"
        :aria-label="t('admin.inspector.widget.accentColor')"
        @update:model-value="setAccentColor($event)" @reset="setAccentColor(undefined)" />
    </BaseField>
    <!-- Its own field rather than the colour row: a BaseSegmented dropped inside BaseColor's
         row would sit in the same <label> as the colour input and reopen the picker on click. -->
    <BaseField :label="t('admin.inspector.widget.accentMode')" :hint="t('admin.inspector.widget.accentMode.hint')">
      <BaseSegmented :model-value="inst.accentMode ?? 'none'" :options="ACCENT_MODES"
        @update:model-value="setAccentMode($event)" />
    </BaseField>
    </BaseSection>

    <!-- The one section that opens by itself: a widget is selected to be set up. -->
    <BaseSection v-if="manifest && Object.keys(schema).length" id="widget.settings"
      :title="t('admin.inspector.widget.settings')" default-open>
      <CopySettingsFrom :widget-id="inst.widgetId" :instance-id="inst.instanceId"
        @copy="s.updateInstance(inst!.instanceId, { settings: $event })" />
      <SettingsForm :schema="manifest.settingsSchema" scope="tile" :values="inst.settings" @change="onSetting" />
    </BaseSection>

    <WidgetPermissions :manifest="manifest" :asks="asks" />

    <BaseSection id="widget.geometry" :title="t('admin.inspector.widget.geometry')">
    <div class="grid4">
      <BaseField :label="t('admin.inspector.widget.x')"><BaseInput type="number" :min="0" :invalid="!geomOk" :model-value="geom.x" @update:model-value="geom.x = Number($event); commitGeom()" /></BaseField>
      <BaseField :label="t('admin.inspector.widget.y')"><BaseInput type="number" :min="0" :invalid="!geomOk" :model-value="geom.y" @update:model-value="geom.y = Number($event); commitGeom()" /></BaseField>
      <BaseField :label="t('admin.inspector.widget.width')"><BaseInput type="number" :min="1" :invalid="!geomOk" :model-value="geom.w" @update:model-value="geom.w = Number($event); commitGeom()" /></BaseField>
      <BaseField :label="t('admin.inspector.widget.height')"><BaseInput type="number" :min="1" :invalid="!geomOk" :model-value="geom.h" @update:model-value="geom.h = Number($event); commitGeom()" /></BaseField>
    </div>
    <p class="hint" v-if="manifest" :class="{ bad: tooSmall }">{{ t('admin.inspector.widget.minSize', { w: minSize[0], h: minSize[1] }) }}</p>

    <!-- A single page leaves nowhere to go, so the whole row is disabled rather than hidden. -->
    <BaseField :label="t('admin.inspector.widget.moveToPage')">
      <div class="move">
        <select v-model="moveTarget" :disabled="!otherPages.length" :aria-label="t('admin.inspector.widget.moveToPage')">
          <option value="">{{ t('admin.inspector.widget.moveToPage') }}</option>
          <option v-for="p in otherPages" :key="p.index" :value="String(p.index)">{{ p.name }}</option>
        </select>
        <BaseButton :disabled="!otherPages.length || moveTarget === ''" @click="moveToPage">
          {{ t('admin.inspector.widget.move') }}
        </BaseButton>
      </div>
    </BaseField>
    </BaseSection>

    <div class="actions">
      <BaseButton @click="s.duplicateWidget(inst!.instanceId)"><BaseIcon name="copy" :size="16" />{{ t('common.duplicate') }}</BaseButton>
      <BaseButton variant="danger" @click="s.removeWidget(inst!.instanceId)"><BaseIcon name="trash-2" :size="16" />{{ t('common.remove') }}</BaseButton>
    </div>
  </template>
</template>

<style scoped>
.empty { color: var(--text-muted); font-size: var(--fs-sm); }
.head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.grid4 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--space-2); }
.hint { font-size: var(--fs-xs); color: var(--text-dim); margin: 0 0 var(--space-3); }
.hint.bad { color: var(--danger); }
.actions { display: flex; gap: var(--space-2); margin-top: var(--space-4); }
.move { display: flex; gap: var(--space-2); align-items: center; }
.move select { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.err { color: var(--danger); font-size: var(--fs-sm); }
</style>
