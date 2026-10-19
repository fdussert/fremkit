<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import DayNightSchedule from './DayNightSchedule.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import { useI18n } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { BrightnessSettings, Config, Screen } from '../shared/types'
import { useAdminStore } from './store'

/**
 * The Screen panel's brightness section: the live level of the selected screen, and how it is
 * driven when nobody touches it (day/night, follow the Mac). The live level goes to the
 * `brightness` provider as a command; the settings are saved with the screen like any other
 * setting, undoable. See `server/src/brightness/` for the rules the hints describe.
 */

/** Mirrors `ScreenBrightness` in `server/src/brightness/service.ts`, as far as this panel reads it. */
interface Live {
  available: boolean
  reason?: string
  value: number | null
  target: number | null
  mode: 'manual' | 'day-night' | 'follow-mac' | 'both'
  overridden: boolean
  dayNightProblem?: string
  followProblem?: string
  phase?: { state: string; next?: { at: string; to: 'day' | 'night' } }
  builtin: boolean
  display?: string
}

const s = useAdminStore()
const { t, locale } = useI18n()
const socket = useSocket()

const scr = computed(() => s.screen.value!)
const live = ref<Record<string, Live>>({})
const kiosk = ref<string | null>(null)
const unsubscribe = socket.subscribe('brightness', (data) => {
  const d = data as { kiosk?: string | null; screens?: Record<string, Live> } | null
  live.value = d?.screens ?? {}
  kiosk.value = d?.kiosk ?? null
})
onUnmounted(unsubscribe)

const here = computed<Live | undefined>(() => live.value[scr.value.id])
const level = computed(() => here.value?.value ?? here.value?.target ?? 50)

/** The defaults of `BrightnessSettingsSchema`, for a screen that has never had the key. */
const DEFAULTS: BrightnessSettings = {
  dayNight: { enabled: false, day: 80, night: 30, schedule: 'sun', dayAt: '07:00', nightAt: '21:00', rampMinutes: 20 },
  followMac: { enabled: false, scale: 1, offset: 0 },
}
const b = computed<BrightnessSettings>(() => {
  const own = scr.value.brightness
  return { dayNight: { ...DEFAULTS.dayNight, ...own?.dayNight }, followMac: { ...DEFAULTS.followMac, ...own?.followMac } }
})
const onScreen = (c: Config): Screen => c.screens.find((x) => x.id === scr.value.id)!

function setDayNight(patch: Partial<BrightnessSettings['dayNight']>): void {
  s.apply((c) => {
    const screen = onScreen(c)
    const current = { ...b.value }
    screen.brightness = { ...current, dayNight: { ...current.dayNight, ...patch } }
  })
}
function setFollow(patch: Partial<BrightnessSettings['followMac']>): void {
  s.apply((c) => {
    const screen = onScreen(c)
    const current = { ...b.value }
    screen.brightness = { ...current, followMac: { ...current.followMac, ...patch } }
  })
}

function setRamp(raw: string | number): void {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 120) {
    s.state.toast = t('brightness.admin.badRamp')
    return
  }
  setDayNight({ rampMinutes: value })
}

// The live slider drives the screen as it moves, at most every 100 ms, the last move winning.
let lastSent = 0
let pending: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
function send(value: number, force = false): void {
  const now = Date.now()
  if (!force && now - lastSent < 100) {
    pending = value
    timer ??= setTimeout(() => { timer = null; if (pending !== null) { const p = pending; pending = null; send(p, true) } }, 100 - (now - lastSent))
    return
  }
  lastSent = now
  pending = null
  socket.command('brightness', 'set', { screen: scr.value.id, value }).catch((err: Error) => { s.state.toast = err.message })
}
function resume(): void {
  socket.command('brightness', 'resume', { screen: scr.value.id }).catch((err: Error) => { s.state.toast = err.message })
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString(locale.value === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })

const status = computed(() => {
  const l = here.value
  if (!l) return t('brightness.admin.waiting')
  if (!l.available) return t(`brightness.admin.reason.${l.reason ?? 'no-ddc'}`)
  const parts = [t(`brightness.admin.mode.${l.mode}`)]
  if (l.overridden) parts.push(t('brightness.admin.overridden'))
  if (l.phase?.next) parts.push(t(`brightness.admin.next.${l.phase.next.to}`, { time: clock(l.phase.next.at) }))
  return parts.join(' · ')
})
const scalePercent = computed(() => Math.round(b.value.followMac.scale * 100))
</script>

<template>
  <BaseSection id="screen.brightness" :title="t('brightness.admin.title')">
    <BaseField :label="t('brightness.admin.level')" :hint="here?.display ? t('brightness.admin.display', { name: here.display }) : undefined">
      <BaseRange v-if="here?.available" :model-value="level" :aria-label="t('brightness.admin.level')"
        @input="send($event)" @change="send($event, true)" />
      <p class="ro">{{ status }}</p>
      <BaseButton v-if="here?.available && here.overridden" @click="resume()">{{ t('brightness.admin.resume') }}</BaseButton>
    </BaseField>
    <p v-if="scr.kind === 'device'" class="ro note">{{ t('brightness.admin.deviceLater') }}</p>

    <BaseCheckbox :model-value="b.dayNight.enabled" :label="t('brightness.admin.dayNight')"
      @update:model-value="setDayNight({ enabled: $event })" />
    <template v-if="b.dayNight.enabled">
      <BaseField :label="t('brightness.admin.dayLevel', { percent: b.dayNight.day })">
        <BaseRange :model-value="b.dayNight.day" :step="5" :aria-label="t('brightness.admin.dayLevel', { percent: b.dayNight.day })"
          @change="setDayNight({ day: $event })" />
      </BaseField>
      <BaseField :label="t('brightness.admin.nightLevel', { percent: b.dayNight.night })">
        <BaseRange :model-value="b.dayNight.night" :step="5" :aria-label="t('brightness.admin.nightLevel', { percent: b.dayNight.night })"
          @change="setDayNight({ night: $event })" />
      </BaseField>
      <DayNightSchedule :value="b.dayNight" :no-location="!!here?.dayNightProblem" @update="setDayNight($event)" />
      <BaseField :label="t('brightness.admin.ramp')" :hint="t('brightness.admin.rampHint')">
        <BaseInput type="number" lazy :min="0" :max="120" :model-value="b.dayNight.rampMinutes" @update:model-value="setRamp($event)" />
      </BaseField>
    </template>

    <BaseCheckbox :model-value="b.followMac.enabled" :label="t('brightness.admin.followMac')"
      @update:model-value="setFollow({ enabled: $event })" />
    <p v-if="scr.id === kiosk && here && !here.builtin" class="ro note">{{ t('brightness.admin.noBuiltin') }}</p>
    <template v-if="b.followMac.enabled">
      <BaseField :label="t('brightness.admin.scale')" :hint="t('brightness.admin.scaleHint')">
        <BaseRange :model-value="scalePercent" :min="20" :max="300" :step="5" :aria-label="t('brightness.admin.scale')"
          @change="setFollow({ scale: $event / 100 })" />
      </BaseField>
      <BaseField :label="t('brightness.admin.offset')">
        <BaseRange :model-value="b.followMac.offset" :min="-50" :max="50" :step="1" unit="" :aria-label="t('brightness.admin.offset')"
          @change="setFollow({ offset: $event })" />
      </BaseField>
    </template>
    <p v-if="b.dayNight.enabled && b.followMac.enabled" class="ro note">{{ t('brightness.admin.both') }}</p>
    <p v-if="b.dayNight.enabled || b.followMac.enabled" class="ro note">{{ t('brightness.admin.manualRule') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: var(--space-1) 0; color: var(--text-muted); font-size: var(--fs-sm); }
.note { line-height: 1.4; }
</style>
