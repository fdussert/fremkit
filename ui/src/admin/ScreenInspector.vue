<script setup lang="ts">
import { computed } from 'vue'
import { ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { api } from '../shared/api'
import type { RestoreResult } from '../shared/api'
import BaseColor from '../shared/ui/BaseColor.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import BackgroundPicker from './BackgroundPicker.vue'
import NavWidgetsEditor from './NavWidgetsEditor.vue'
import { surfaceOpacity } from '../shared/background'
import { pick, useI18n, type Locale } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import { BUILTIN_THEME, useThemes } from '../shared/theme'
import { ADMIN_GESTURES, DEFAULT_ADMIN_GESTURE, NAV_HEIGHTS, navHeightOf,
  type AdminGesture, type Background, type NavHeight } from '../shared/types'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t, locale } = useI18n()
const LANGUAGES = computed(() => (['fr', 'en'] as const).map((value) => ({
  value, label: t(`admin.inspector.screen.language.${value}`),
})))

/**
 * The language goes through `apply` like every other setting, so it is undoable and saved with
 * the rest of the config. The store watches `config.locale`, which is what repaints the admin.
 */
function setLocale(value: string): void {
  const next = (value === 'en' ? 'en' : 'fr') as Locale
  if (next !== s.state.config!.locale) s.apply((c) => { c.locale = next })
}
const { themes, errors: themeErrors, rescan: rescanThemes } = useThemes()
/** The built-in theme first, then the others by name: the list reads as "the default, and yours". */
const themeOptions = computed(() => {
  const list = Object.values(themes.value)
    .sort((a, b) => (a.id === BUILTIN_THEME ? -1 : b.id === BUILTIN_THEME ? 1 : pick(a.name).localeCompare(pick(b.name))))
    .map((theme) => ({ id: theme.id, label: pick(theme.name), description: pick(theme.description ?? '') }))
  // A config naming a theme whose folder is gone still shows it, rather than an empty select.
  const current = s.state.config!.display.theme ?? BUILTIN_THEME
  if (!list.some((o) => o.id === current)) list.push({ id: current, label: current, description: t('admin.inspector.screen.theme.missing') })
  return list
})
const currentTheme = computed(() => s.state.config!.display.theme ?? BUILTIN_THEME)
const themeNote = computed(() => themeOptions.value.find((o) => o.id === currentTheme.value)?.description ?? '')
function setTheme(id: string): void {
  if (id !== currentTheme.value) s.apply((c) => { c.display.theme = id })
}

const privacy = computed(() => s.state.config!.privacy)
/**
 * Turning the Claude usage on is the whole consent step: until it is ticked the server does not
 * read the keychain item and sends nothing. The hint below spells out what is read and where it
 * goes, so the box is never the only thing the user has to go on.
 */
function setClaudeAccountUsage(on: boolean): void {
  s.apply((c) => { c.privacy.claudeAccountUsage = on })
}
/**
 * Backup and restore.
 *
 * The archive holds the config and the background library and never a secret: those live in the
 * macOS keychain. A restore therefore replaces the dashboard and leaves every connection needing
 * its secret typed in again — which is what the confirmation says and what the result lists.
 */
const restoreInput = ref<HTMLInputElement>()
const restoring = ref(false)
const restored = ref<RestoreResult | null>(null)
const restoreError = ref('')

const confirm = useConfirm()
function confirmRestore(): void {
  confirm.ask('restore', () => restoreInput.value?.click())
}

async function onRestoreFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Cleared either way, so picking the same file twice still fires a change event.
  input.value = ''
  if (!file) return
  restoring.value = true
  restored.value = null
  restoreError.value = ''
  try {
    restored.value = await api.restoreBackup(file)
    // The whole dashboard changed underneath the admin: reload it rather than reconcile it.
    await s.load()
  } catch (err) {
    restoreError.value = (err as Error).message
  } finally {
    restoring.value = false
  }
}

const d = computed(() => s.state.config!.display)
const bg = computed<Background>(() => d.value.background ?? {})
const navHeight = computed(() => navHeightOf(d.value))
/** "80 px" and "40 px" read the same in both languages, so the labels need no dictionary entry. */
const NAV_OPTIONS = NAV_HEIGHTS.map((h) => ({ value: String(h), label: `${h} px` }))
const kioskUrl = `${location.origin}/?kiosk=1`

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
  s.apply((c) => { c.display.adminGesture = next === DEFAULT_ADMIN_GESTURE ? undefined : next })
}

const navOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.navOpacity) * 100))
/** A solid bar is the default, so it is stored as an absent key rather than an explicit 1. */
function setNavOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { c.display.navOpacity = clamped === 100 ? undefined : clamped / 100 })
}

const tileOpacityPercent = computed(() => Math.round(surfaceOpacity(d.value.tileOpacity) * 100))
/** Solid is the default, so it is stored as an absent key rather than an explicit 1. */
function setTileOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent))
  s.apply((c) => { c.display.tileOpacity = clamped === 100 ? undefined : clamped / 100 })
}

/** An emptied field is NaN, which the schema would reject: ignore it instead of writing it. */
function setAutoCycle(value: string | number): void {
  const n = Number(value)
  if (Number.isFinite(n)) s.apply((c) => { c.display.autoCycleSeconds = Math.max(0, Math.round(n)) })
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
    c.display.background = Object.keys(next).length ? (next as Background) : undefined
  })
}

</script>

<template>
  <BaseField :label="t('admin.inspector.screen.language')">
    <BaseSegmented :model-value="locale" :options="LANGUAGES" @update:model-value="setLocale($event)" />
  </BaseField>

  <BaseField :label="t('admin.inspector.screen.theme')" :hint="t('admin.inspector.screen.theme.hint')">
    <div class="theme">
      <select :value="currentTheme" :aria-label="t('admin.inspector.screen.theme')"
        @change="setTheme(($event.target as HTMLSelectElement).value)">
        <option v-for="o in themeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <BaseButton variant="icon" :title="t('admin.inspector.screen.theme.rescan')" @click="rescanThemes()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </div>
  </BaseField>
  <p v-if="themeNote" class="ro note">{{ themeNote }}</p>
  <p v-for="e in themeErrors" :key="e.id" class="err">{{ e.id }} — {{ e.error }}</p>

  <BaseSection id="screen.layout" :title="t('admin.inspector.screen.layout')">
  <BaseField :label="t('admin.inspector.screen.grid')" :hint="t('admin.inspector.screen.grid.hint')">
    <p class="ro">{{ t('admin.inspector.screen.grid.value', { cols: d.cols, rows: d.rows, cell: d.cell }) }}</p>
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.area')">
    <p class="ro">{{ t('admin.inspector.screen.area.value', { width: d.cols * d.cell, height: d.rows * d.cell, nav: navHeight }) }}</p>
  </BaseField>
  <BaseField :label="t('admin.inspector.screen.navHeight')" :hint="t('admin.inspector.screen.navHeight.hint')">
    <BaseSegmented :model-value="String(navHeight)" :options="NAV_OPTIONS"
      @update:model-value="s.setNavHeight(Number($event) as NavHeight)" />
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
  </BaseSection>

  <BaseSection id="screen.kiosk" :title="t('admin.inspector.screen.kiosk')">
  <BaseField :label="t('admin.inspector.screen.kioskUrl')">
    <p class="ro mono">{{ kioskUrl }}</p>
  </BaseField>

  </BaseSection>

  <BaseSection id="screen.backup" :title="t('admin.inspector.screen.backup')">
  <div class="row">
    <BaseButton @click="api.downloadBackup()">
      <BaseIcon name="download" :size="16" />{{ t('admin.inspector.screen.backup.download') }}
    </BaseButton>
    <!-- Two taps: the first says what a restore does, the second opens the file picker. -->
    <BaseButton v-if="confirm.armed('restore')" variant="danger" :disabled="restoring" @click="confirmRestore()">
      {{ t('admin.inspector.screen.restore.confirmButton') }}
    </BaseButton>
    <BaseButton v-else :disabled="restoring" @click="confirmRestore()">
      <BaseIcon name="upload" :size="16" />{{ t('admin.inspector.screen.backup.restore') }}
    </BaseButton>
  </div>
  <input ref="restoreInput" type="file" accept=".zip,application/zip" class="hidden" @change="onRestoreFile" />
  <p v-if="confirm.armed('restore')" class="ro warn">{{ t('admin.inspector.screen.restore.confirm') }}</p>
  <p v-else class="ro">{{ t('admin.inspector.screen.backup.hint') }}</p>
  <p v-if="restoreError" class="bad">{{ restoreError }}</p>
  <template v-if="restored">
    <p class="ok">{{ t('admin.inspector.screen.restore.done', { pages: restored.pages, backgrounds: restored.backgrounds }) }}</p>
    <p v-if="restored.reenterSecrets.length" class="ro">
      {{ t('admin.inspector.screen.restore.reenter') }}
      <strong>{{ restored.reenterSecrets.map((c) => c.name).join(', ') }}</strong>
    </p>
    <!-- The common case, and worth saying: restoring onto the same Mac finds the keychain items,
         because they are keyed by the connection ids the archive carries. -->
    <p v-else class="ro">{{ t('admin.inspector.screen.restore.nothingToReenter') }}</p>
  </template>

  </BaseSection>

  <BaseSection id="screen.privacy" :title="t('admin.inspector.screen.privacy')">
  <BaseCheckbox :model-value="privacy.claudeAccountUsage"
    :label="t('admin.inspector.screen.claudeUsage')"
    @update:model-value="setClaudeAccountUsage($event)" />
  <p class="ro">{{ t('admin.inspector.screen.claudeUsage.hint') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.warn { color: var(--danger); }
.row { display: flex; gap: var(--space-2); margin-bottom: var(--space-2); }
.hidden { display: none; }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.ok { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--ok); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.theme { display: flex; gap: var(--space-2); align-items: center; }
.theme select { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.note { margin: calc(var(--space-2) * -1) 0 var(--space-3); }
.err { color: var(--danger); font-size: var(--fs-xs); margin: 0 0 var(--space-2); }
</style>
