<script setup lang="ts">
/**
 * The selected screen's own settings: its name, its layout and bar, the widgets in its bar, its
 * background, its brightness and its kiosk address. Moved out of the former ScreenInspector.vue.
 */
import { computed } from 'vue'
import BaseButton from '../../shared/ui/BaseButton.vue'
import BaseIcon from '../../shared/ui/BaseIcon.vue'
import BaseColor from '../../shared/ui/BaseColor.vue'
import BaseField from '../../shared/ui/BaseField.vue'
import BaseInput from '../../shared/ui/BaseInput.vue'
import BaseRange from '../../shared/ui/BaseRange.vue'
import BaseSection from '../../shared/ui/BaseSection.vue'
import BaseSegmented from '../../shared/ui/BaseSegmented.vue'
import BackgroundPicker from '../BackgroundPicker.vue'
import NavWidgetsEditor from '../NavWidgetsEditor.vue'
import { useDevices } from '../devices'
import ScreenBrightness from '../ScreenBrightness.vue'
import SettingsBlock from './SettingsBlock.vue'
import { surfaceOpacity } from '../../shared/background'
import { useI18n } from '../../shared/i18n'
import { useConfirm } from '../../shared/useConfirm'
import { ADMIN_GESTURES, DEFAULT_ADMIN_GESTURE, DEFAULT_NAV_STYLE, NAV_HEIGHTS, navHasRoom, navHeightOf,
  type AdminGesture, type Background, type Config, type NavHeight, type NavStyle, type Screen } from '../../shared/types'
import { pickScreen, screensShowing } from '../../shared/screens'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t } = useI18n()
const confirm = useConfirm()

const scr = computed(() => s.screen.value!)
/** An emptied name is not a name: the field snaps back to the current one instead. */
function rename(value: string | number): void {
  s.renameScreen(scr.value.id, String(value))
}
/** The widgets that would go with this screen: those no other screen shows. */
const onlyHere = computed(() => {
  const cfg = s.state.config!
  const ids = new Set([...scr.value.nav.map((x) => x.instanceId), ...scr.value.pages.flatMap((p) => p.items.map((x) => x.instanceId))])
  return [...ids].filter((id) => screensShowing(cfg, id).every((x) => x.id === scr.value.id)).length
})
const lastScreen = computed(() => s.state.config!.screens.length <= 1)
const removeKey = computed(() => `screen:${scr.value.id}`)
/** The paired devices this screen is on: removing it leaves them with nothing to show. */
const devices = useDevices()
const showingHere = computed(() => devices.showing(scr.value.id).map((d) => d.name).join(', '))
function confirmRemoveScreen(): void {
  const id = scr.value.id
  // Arming re-reads the list, so the warning names the devices as they are now.
  if (!confirm.armed(removeKey.value) && scr.value.kind === 'device') void devices.refresh()
  confirm.ask(removeKey.value, () => s.removeScreen(id))
}

/** The selected screen's display: every setting below is that screen's, not the others'. */
const d = computed(() => s.screen.value!.display)
/** The selected screen inside the config a mutation is handed. */
const onScreen = (c: Config): Screen => c.screens.find((x) => x.id === s.screen.value!.id)!
const bg = computed<Background>(() => d.value.background ?? {})
/** This screen's pages that show a background of their own instead of the one edited here. */
const overriding = computed(() => s.screen.value!.pages.filter((p) => p.background).map((p) => p.name).join(', '))
const navHeight = computed(() => navHeightOf(d.value))
/** "80 px" and "40 px" read the same in both languages, so the labels need no dictionary entry. */
const NAV_OPTIONS = NAV_HEIGHTS.map((h) => ({ value: String(h), label: `${h} px` }))
/**
 * The selected screen's own dashboard address. `/?kiosk=1` alone shows the first Edge screen,
 * which is what the helper opens; naming the screen is what opens any other one.
 */
const kioskUrl = computed(() => `${location.origin}/?screen=${encodeURIComponent(scr.value.id)}&kiosk=1`)
/** An Edge screen other than the one the helper shows is drawn nowhere yet. */
const unshownEdge = computed(() => scr.value.kind === 'edge' && pickScreen(s.state.config!, null).id !== scr.value.id)
const NAV_STYLE_OPTIONS = computed(() => (['dots', 'names'] as const).map((value) => ({
  value, label: t(`admin.inspector.screen.navStyle.${value}`),
})))
/**
 * Dots or names in this screen's bar. Names take more of the centre, so the switch is refused
 * when this screen's clusters would not leave them their room.
 */
function setNavStyle(value: string): void {
  const next = value as NavStyle
  const candidate: Screen = { ...scr.value, display: { ...d.value, navStyle: next } }
  if (!navHasRoom(candidate, s.state.config!.widgets, s.state.manifests, 0)) {
    s.state.toast = t('admin.inspector.screen.navStyle.noRoom')
    return
  }
  s.apply((c) => { onScreen(c).display.navStyle = next === DEFAULT_NAV_STYLE ? undefined : next })
}

/** The slider works in whole percents; the config stores the 0–1 opacity itself. */
const ADMIN_GESTURE_OPTIONS = computed(() => ADMIN_GESTURES.map((value) => ({
  value, label: t(`admin.inspector.screen.adminGesture.${value}`),
})))
/**
 * How the admin is reached from the screen. `both` is the default and is stored as an absent key,
 * like every other default here.
 */
function setAdminGesture(value: string): void {
  const next = value as AdminGesture
  s.apply((c) => { onScreen(c).display.adminGesture = next === DEFAULT_ADMIN_GESTURE ? undefined : next })
}

const navOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.navOpacity) * 100))
/** A solid bar is the default, so it is stored as an absent key rather than an explicit 1. */
function setNavOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { onScreen(c).display.navOpacity = clamped === 100 ? undefined : clamped / 100 })
}

const tileOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.tileOpacity) * 100))
/** Solid is the default, so it is stored as an absent key rather than an explicit 1. */
function setTileOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { onScreen(c).display.tileOpacity = clamped === 100 ? undefined : clamped / 100 })
}

/** An emptied field is NaN, which the schema would reject: ignore it instead of writing it. */
function setAutoCycle(value: string | number): void {
  const n = Number(value)
  if (Number.isFinite(n)) s.apply((c) => { onScreen(c).display.autoCycleSeconds = Math.max(0, Math.round(n)) })
}

/**
 * One mutation path for the whole background object: keys set to `undefined` are dropped, and
 * an object left with nothing in it goes away entirely, so clearing everything restores the
 * default exactly as it was — which is what makes undo round-trip cleanly.
 */
function setBackground(patch: Partial<Background>): void {
  s.apply((c) => {
    const next = { ...bg.value, ...patch } as Record<string, unknown>
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
    onScreen(c).display.background = Object.keys(next).length ? (next as Background) : undefined
  })
}
</script>

<template>
  <SettingsBlock id="screen.name">
  <BaseField :label="t('admin.inspector.screen.name')">
    <!-- Keyed by screen: switching screens must not carry the other one's half-typed name over. -->
    <BaseInput :key="scr.id" lazy :model-value="scr.name" :aria-label="t('admin.inspector.screen.name')"
      @update:model-value="rename($event)" />
  </BaseField>
  <div class="row">
    <!-- Two taps, the first saying what goes with it; the last screen cannot go at all. -->
    <BaseButton v-if="confirm.armed(removeKey)" variant="danger" @click="confirmRemoveScreen()">
      {{ t('admin.inspector.screen.remove.confirmButton') }}
    </BaseButton>
    <BaseButton v-else variant="danger" :disabled="lastScreen" @click="confirmRemoveScreen()">
      <BaseIcon name="trash-2" :size="16" />{{ t('admin.inspector.screen.remove') }}
    </BaseButton>
  </div>
  <p v-if="confirm.armed(removeKey)" class="ro warn">{{ t('admin.inspector.screen.remove.confirm', { name: scr.name, count: onlyHere }) }}</p>
  <p v-if="confirm.armed(removeKey) && showingHere" class="ro warn" data-test="remove-devices">{{ t('admin.inspector.screen.remove.devices', { names: showingHere }) }}</p>
  <p v-else-if="lastScreen" class="ro">{{ t('admin.inspector.screen.remove.last') }}</p>
  </SettingsBlock>

  <BaseSection id="screen.layout" :title="t('admin.inspector.screen.layout')">
  <BaseField :label="t('admin.inspector.screen.grid')"
    :hint="t(scr.kind === 'device' ? 'admin.inspector.screen.grid.hint.device' : 'admin.inspector.screen.grid.hint')">
    <p class="ro">{{ t('admin.inspector.screen.grid.value', { cols: d.cols, rows: d.rows, cell: d.cell }) }}</p>
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.area')">
    <p class="ro">{{ t('admin.inspector.screen.area.value', { width: d.cols * d.cell, height: d.rows * d.cell, nav: navHeight }) }}</p>
  </BaseField>
  <!-- A device screen was made for one orientation and one viewport; changing either is adding
       a screen, so both are shown, not edited. -->
  <template v-if="scr.kind === 'device'">
    <BaseField v-if="d.orientation" :label="t('admin.inspector.screen.orientation')">
      <p class="ro">{{ t(`admin.inspector.screen.orientation.${d.orientation}`) }}</p>
    </BaseField>
    <BaseField v-if="d.viewport" :label="t('admin.inspector.screen.viewport')">
      <p class="ro">{{ t('admin.inspector.screen.viewport.value', { width: d.viewport.width, height: d.viewport.height }) }}</p>
    </BaseField>
  </template>
  <BaseField :label="t('admin.inspector.screen.navHeight')" :hint="t('admin.inspector.screen.navHeight.hint')">
    <BaseSegmented :model-value="String(navHeight)" :options="NAV_OPTIONS"
      @update:model-value="s.setNavHeight(Number($event) as NavHeight)" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.navStyle')" :hint="t('admin.inspector.screen.navStyle.hint')">
    <BaseSegmented :model-value="d.navStyle ?? DEFAULT_NAV_STYLE" :options="NAV_STYLE_OPTIONS"
      @update:model-value="setNavStyle($event)" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.adminGesture')"
    :hint="t('admin.inspector.screen.adminGesture.hint')">
    <BaseSegmented :model-value="d.adminGesture ?? DEFAULT_ADMIN_GESTURE" :options="ADMIN_GESTURE_OPTIONS"
      @update:model-value="setAdminGesture($event)" />
  </BaseField>

  <BaseField :label="t('admin.inspector.screen.navOpacity', { percent: navOpacityPercent })"
    :hint="t('admin.inspector.screen.navOpacity.hint')">
    <BaseRange :model-value="navOpacityPercent" :step="5"
      :aria-label="t('admin.inspector.screen.navOpacity.aria')" @change="setNavOpacity" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.tileOpacity', { percent: tileOpacityPercent })"
    :hint="t('admin.inspector.screen.tileOpacity.hint')">
    <BaseRange :model-value="tileOpacityPercent" :step="5"
      :aria-label="t('admin.inspector.screen.tileOpacity.aria')" @change="setTileOpacity" />
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.autoCycle')">
    <BaseInput type="number" lazy :min="0" :model-value="d.autoCycleSeconds"
      @update:model-value="setAutoCycle($event)" />
  </BaseField>

  </BaseSection>

  <BaseSection id="screen.navWidgets" :title="t('admin.inspector.screen.navWidgets')">
    <NavWidgetsEditor />
  </BaseSection>

  <BaseSection id="screen.background" :title="t('admin.inspector.screen.background')">
  <BaseField :label="t('admin.inspector.screen.color')" :hint="t('admin.inspector.screen.color.hint')">
    <BaseColor :model-value="bg.color ?? ''" fallback="#0b0d10" :reset-label="t('common.reset')"
      :aria-label="t('admin.inspector.screen.color.aria')"
      @update:model-value="setBackground({ color: $event })" @reset="setBackground({ color: undefined })" />
  </BaseField>

  <BackgroundPicker :model-value="bg" @update="setBackground($event)" />
  <p v-if="overriding" class="ro">{{ t('admin.inspector.screen.background.overridden', { pages: overriding }) }}</p>
  </BaseSection>

  <ScreenBrightness />

  <BaseSection id="screen.kiosk" :title="t('admin.inspector.screen.kiosk')">
  <BaseField :label="t('admin.inspector.screen.kioskUrl')">
    <p class="ro mono">{{ kioskUrl }}</p>
  </BaseField>
  <p v-if="unshownEdge" class="ro">{{ t('admin.screens.edgeNote') }}</p>

  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.warn { color: var(--danger); }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
</style>
