<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseField from '../shared/ui/BaseField.vue'
import DayNightSchedule, { type DayNightValue } from './DayNightSchedule.vue'
import { pick, useI18n } from '../shared/i18n'
import { BUILTIN_THEME, useThemeInForce, useThemes } from '../shared/theme'
import type { ThemeSchedule } from '../shared/types'
import { useAdminStore } from './store'

/**
 * Under the theme picker: another theme for the night, and when the night starts — the same
 * day / night as a screen's brightness, without its ramp. Saved at the top of the config
 * (`themeSchedule`), so it is the same on every screen. Which theme is in force is the server's
 * call (`server/src/themes/schedule.ts`); this panel only edits the setting and shows the answer.
 */

const s = useAdminStore()
const { t, locale } = useI18n()
const { themes } = useThemes()
const inForce = useThemeInForce()

const config = computed(() => s.state.config!)
const dayTheme = computed(() => config.value.theme ?? BUILTIN_THEME)
const sched = computed(() => config.value.themeSchedule)

/** Every theme, the built-in one first, plus the night id itself when its folder is gone. */
const options = computed(() => {
  const list = Object.values(themes.value)
    .sort((a, b) => (a.id === BUILTIN_THEME ? -1 : b.id === BUILTIN_THEME ? 1 : pick(a.name).localeCompare(pick(b.name))))
    .map((theme) => ({ id: theme.id, label: pick(theme.name) }))
  const night = sched.value?.night
  if (night && !list.some((o) => o.id === night)) list.push({ id: night, label: `${night} — ${t('admin.inspector.screen.theme.nightMissing')}` })
  return list
})

/** A screen whose brightness already knows where it is, to offer its place rather than a second search. */
const brightnessPlace = computed(() => {
  for (const screen of config.value.screens) {
    const dn = screen.brightness?.dayNight
    if (dn?.latitude !== undefined && dn.longitude !== undefined) return { screen: screen.name, latitude: dn.latitude, longitude: dn.longitude }
  }
  return null
})
const offerPlace = computed(() => {
  const p = brightnessPlace.value
  const v = sched.value
  return !!p && !!v && v.schedule === 'sun' && (v.latitude !== p.latitude || v.longitude !== p.longitude)
})

function enable(on: boolean): void {
  s.apply((c) => {
    if (!on) { delete c.themeSchedule; return }
    // Another theme than the day's, when there is one; the place of a screen's brightness, when one has it.
    const night = options.value.find((o) => o.id !== dayTheme.value)?.id ?? dayTheme.value
    const place = brightnessPlace.value
    c.themeSchedule = {
      night, schedule: 'sun', dayAt: '07:00', nightAt: '21:00',
      ...(place ? { latitude: place.latitude, longitude: place.longitude } : {}),
    }
  })
}
function update(patch: Partial<ThemeSchedule>): void {
  s.apply((c) => {
    if (!c.themeSchedule) return
    const next: ThemeSchedule = { ...c.themeSchedule, ...patch }
    // A coordinate cleared in the field is an absent key, not an `undefined` one.
    for (const key of ['latitude', 'longitude'] as const) if (next[key] === undefined) delete next[key]
    c.themeSchedule = next
  })
}
function usePlace(): void {
  const p = brightnessPlace.value
  if (p) update({ latitude: p.latitude, longitude: p.longitude })
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(locale.value === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })

/** "Night theme now · day at 07:12", from what the server last published; nothing until it has. */
const status = computed(() => {
  const now = inForce.value
  if (!sched.value || !now?.scheduled || now.problem) return ''
  const parts = [t(`admin.inspector.screen.theme.now.${now.phase}`)]
  if (now.next) parts.push(t(`brightness.admin.next.${now.next.to}`, { time: clock(now.next.at) }))
  return parts.join(' · ')
})
</script>

<template>
  <BaseCheckbox :model-value="!!sched" :label="t('admin.inspector.screen.theme.night')"
    @update:model-value="enable($event)" />
  <template v-if="sched">
    <BaseField :label="t('admin.inspector.screen.theme.nightTheme')" :hint="t('admin.inspector.screen.theme.nightHint')">
      <select class="night" :value="sched.night" :aria-label="t('admin.inspector.screen.theme.nightTheme')"
        @change="update({ night: ($event.target as HTMLSelectElement).value })">
        <option v-for="o in options" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
    </BaseField>
    <DayNightSchedule :value="sched as DayNightValue" :no-location="sched.schedule === 'sun' && (sched.latitude === undefined || sched.longitude === undefined)"
      @update="update($event)">
      <template #place>
        <BaseButton v-if="offerPlace" class="reuse" data-test="theme-reuse-place" @click="usePlace()">
          {{ t('admin.inspector.screen.theme.reusePlace', { screen: brightnessPlace!.screen }) }}
        </BaseButton>
      </template>
    </DayNightSchedule>
    <p v-if="status" class="ro" data-test="theme-status">{{ status }}</p>
  </template>
</template>

<style scoped>
.night { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.reuse { margin: 0 0 var(--space-2); }
.ro { margin: var(--space-1) 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
