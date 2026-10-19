<script lang="ts">
/** The part of a day / night setting this edits: where, or at what times. */
export interface DayNightValue {
  schedule: 'sun' | 'fixed'
  latitude?: number
  longitude?: number
  dayAt: string
  nightAt: string
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import { useI18n } from '../shared/i18n'
import { api } from '../shared/api'
import { useAdminStore } from './store'

/**
 * When day turns to night: at sunrise and sunset at a place (a city search, or coordinates typed)
 * or at two fixed times. Shared by a screen's brightness and the night theme, which read it with
 * the same server code (`server/src/brightness/schedule.ts`). It edits nothing itself: every
 * change is emitted as a patch, and the parent applies it where its setting lives.
 */

const props = defineProps<{
  value: DayNightValue
  /** The server says the sun schedule has no place to compute from. */
  noLocation?: boolean
}>()
const emit = defineEmits<{ update: [patch: Partial<DayNightValue>] }>()

const s = useAdminStore()
const { t, locale } = useI18n()

/** A coordinate typed in the field: kept when it is a number in range, refused (toast) otherwise. */
function setCoordinate(key: 'latitude' | 'longitude', raw: string | number): void {
  const limit = key === 'latitude' ? 90 : 180
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
  if (String(raw).trim() === '') return emit('update', { [key]: undefined })
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    s.state.toast = t('brightness.admin.badCoordinate')
    return
  }
  emit('update', { [key]: Math.round(value * 10000) / 10000 })
}
// The city search: one request when the user presses Search, never as they type.
const placeQuery = ref('')
const places = ref<{ name: string; detail: string; latitude: number; longitude: number }[] | null>(null)
const searching = ref(false)
async function searchPlaces(): Promise<void> {
  const q = placeQuery.value.trim()
  if (q.length < 2 || searching.value) return
  searching.value = true
  try {
    places.value = (await api.searchPlaces(q, locale.value === 'fr' ? 'fr' : 'en')).places
  } catch (err) {
    places.value = null
    s.state.toast = (err as Error).message
  } finally {
    searching.value = false
  }
}
function usePlace(p: { latitude: number; longitude: number }): void {
  emit('update', { latitude: p.latitude, longitude: p.longitude })
  places.value = null
  placeQuery.value = ''
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
function setClock(key: 'dayAt' | 'nightAt', raw: string | number): void {
  const value = String(raw).trim().replace(/^(\d):/, '0$1:').replace('h', ':')
  if (!CLOCK.test(value)) {
    s.state.toast = t('brightness.admin.badTime')
    return
  }
  emit('update', { [key]: value })
}

const SCHEDULES = computed(() => (['sun', 'fixed'] as const).map((value) => ({ value, label: t(`brightness.admin.schedule.${value}`) })))
</script>

<template>
  <BaseField :label="t('brightness.admin.schedule')">
    <BaseSegmented :model-value="props.value.schedule" :options="SCHEDULES"
      @update:model-value="emit('update', { schedule: $event as 'sun' | 'fixed' })" />
  </BaseField>
  <template v-if="props.value.schedule === 'sun'">
    <BaseField :label="t('brightness.admin.city')" :hint="t('brightness.admin.cityHint')">
      <form class="search" @submit.prevent="searchPlaces()">
        <BaseInput v-model="placeQuery" :placeholder="t('brightness.admin.cityPlaceholder')" />
        <BaseButton :disabled="searching || placeQuery.trim().length < 2" @click="searchPlaces()">{{ t('brightness.admin.search') }}</BaseButton>
      </form>
    </BaseField>
    <ul v-if="places" class="places">
      <li v-if="places.length === 0" class="ro">{{ t('brightness.admin.noPlace') }}</li>
      <li v-for="p in places" :key="`${p.latitude},${p.longitude}`">
        <button type="button" class="place" @click="usePlace(p)">
          <strong>{{ p.name }}</strong><span v-if="p.detail"> — {{ p.detail }}</span>
          <span class="coords">{{ p.latitude }}, {{ p.longitude }}</span>
        </button>
      </li>
    </ul>
    <slot name="place" />
    <div class="pair">
      <BaseField :label="t('brightness.admin.latitude')">
        <BaseInput lazy :model-value="props.value.latitude ?? ''" placeholder="48.8566"
          @update:model-value="setCoordinate('latitude', $event)" />
      </BaseField>
      <BaseField :label="t('brightness.admin.longitude')">
        <BaseInput lazy :model-value="props.value.longitude ?? ''" placeholder="2.3522"
          @update:model-value="setCoordinate('longitude', $event)" />
      </BaseField>
    </div>
    <p class="ro note">{{ t('brightness.admin.locationHint') }}</p>
    <p v-if="noLocation" class="err">{{ t('brightness.admin.noLocation') }}</p>
  </template>
  <div v-else class="pair">
    <BaseField :label="t('brightness.admin.dayAt')">
      <BaseInput lazy :model-value="props.value.dayAt" placeholder="07:00" @update:model-value="setClock('dayAt', $event)" />
    </BaseField>
    <BaseField :label="t('brightness.admin.nightAt')">
      <BaseInput lazy :model-value="props.value.nightAt" placeholder="21:00" @update:model-value="setClock('nightAt', $event)" />
    </BaseField>
  </div>
</template>

<style scoped>
.search { display: flex; gap: var(--space-2); align-items: center; margin: 0; }
.search > :first-child { flex: 1; min-width: 0; }
.places { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.place { width: 100%; text-align: left; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--surface-2, transparent);
  border: 1px solid var(--border, rgba(128,128,128,.3)); border-radius: 8px; padding: var(--space-2) var(--space-3); cursor: pointer; }
.place:hover { border-color: var(--accent); }
.coords { float: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.ro { margin: var(--space-1) 0; color: var(--text-muted); font-size: var(--fs-sm); }
.note { line-height: 1.4; }
.err { margin: var(--space-1) 0; color: var(--danger, #e5534b); font-size: var(--fs-sm); }
</style>
