<script setup lang="ts">
import { computed } from 'vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import { pick, useI18n } from '../shared/i18n'
import { fieldShown, optionLabel, optionValue, suggestApplies, type ListItemField } from '../shared/types'

/**
 * The fields of one open item of a `list` setting, laid inline. Only the plain ones: the list an
 * item may hold is drawn by the form, under these. A field whose `showWhen` this item does not
 * meet is left out, its value kept. Each change is one `set`, so one undo step.
 */
const props = defineProps<{
  schema: Record<string, ListItemField>
  item: Record<string, unknown>
  /** The form's datalists: the installed applications and the time zones. */
  appsListId: string
  timezoneListId: string
  timeZones: string[]
}>()
const emit = defineEmits<{ set: [key: string, value: unknown] }>()
const { t } = useI18n()

const shown = computed(() => Object.entries(props.schema)
  .filter(([, itf]) => itf.type !== 'list' && fieldShown(itf, props.item)))

const text = (key: string, field: ListItemField): string => String(props.item[key] ?? field.default ?? '')
/** An emptied number cell is not a zero: leave the item as it stands. */
function onNumber(key: string, value: string | number): void {
  if (Number.isFinite(Number(value))) emit('set', key, Number(value))
}
/** An empty zone is merely unfinished; one this browser does not know is wrong and shows red. */
function badTimezone(value: unknown): boolean {
  const zone = String(value ?? '')
  return zone !== '' && props.timeZones.length > 0 && !props.timeZones.includes(zone)
}
/**
 * `suggestWhen` lets a manifest offer the applications only on the items where they mean
 * something — a shortcut button whose kind is "app" — so a link keeps a plain text box.
 */
const suggestList = (itf: ListItemField): string | undefined =>
  itf.suggest === 'apps' && suggestApplies(itf, props.item) ? props.appsListId : undefined
</script>

<template>
  <div class="cells">
    <label v-for="[ik, itf] in shown" :key="ik" class="cell" :class="{ flag: itf.type === 'boolean' }">
      <span class="cap">{{ pick(itf.label) }}</span>
      <input v-if="itf.type === 'boolean'" type="checkbox" :checked="Boolean(item[ik])"
        @change="emit('set', ik, ($event.target as HTMLInputElement).checked)" />
      <select v-else-if="itf.type === 'enum'" :value="text(ik, itf)"
        @change="emit('set', ik, ($event.target as HTMLSelectElement).value)">
        <option v-for="o in itf.options" :key="optionValue(o)" :value="optionValue(o)">{{ pick(optionLabel(o)) }}</option>
      </select>
      <BaseInput v-else-if="itf.type === 'number'" type="number" lazy :model-value="Number(item[ik] ?? 0)"
        @update:model-value="onNumber(ik, $event)" />
      <BaseInput v-else-if="itf.type === 'timezone'" lazy :list="timezoneListId"
        :invalid="badTimezone(item[ik])" :title="badTimezone(item[ik]) ? t('admin.settings.timezone.unknown') : undefined"
        :model-value="text(ik, itf)" @update:model-value="emit('set', ik, String($event).trim())" />
      <BaseInput v-else lazy :list="suggestList(itf)" :model-value="text(ik, itf)"
        @update:model-value="emit('set', ik, $event)" />
    </label>
  </div>
</template>

<style scoped>
.cells { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
.cell { flex: 1 1 110px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* A checkbox needs no column of its own: label beside the box, sized to its content. */
.cell.flag { flex: 0 0 auto; flex-direction: row-reverse; align-items: center; gap: var(--space-1); }
.cell.flag input { accent-color: var(--accent); width: 16px; height: 16px; }
.cap { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
