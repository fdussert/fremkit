<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import TileIcon from '../shared/TileIcon.vue'
import LibraryIconPicker from './LibraryIconPicker.vue'
import { LIBRARY_ICON_PREFIX } from '../shared/widgetMessages'
import { pick, useI18n } from '../shared/i18n'
import { fieldShown, optionLabel, optionValue, suggestApplies, type ListItemField, type SuggestSource } from '../shared/types'

/**
 * The fields of one open item of a `list` setting, laid inline. Only the plain ones: the list an
 * item may hold is drawn by the form, under these. A field whose `showWhen` this item does not
 * meet is left out, its value kept. Each change is one `set`, so one undo step.
 */
const props = defineProps<{
  schema: Record<string, ListItemField>
  item: Record<string, unknown>
  /** The form's datalists: the installed applications and the time zones. */
  /** The <datalist> id of each suggestion source, rendered once by the form. */
  suggestLists: Partial<Record<SuggestSource, string>>
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
  itf.suggest && suggestApplies(itf, props.item) ? props.suggestLists[itf.suggest] : undefined

/** The `icon` field whose library is open under the fields, or null. */
const library = ref<string | null>(null)
/** The library file an `icon` field names, for its preview. */
function libraryFile(key: string): string | null {
  const value = String(props.item[key] ?? '').trim()
  return value.startsWith(LIBRARY_ICON_PREFIX) ? value.slice(LIBRARY_ICON_PREFIX.length) : null
}
function pickIcon(key: string, value: string): void {
  emit('set', key, value)
  library.value = null
}
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
      <span v-else-if="itf.type === 'icon'" class="iconRow">
        <BaseInput lazy :model-value="text(ik, itf)" @update:model-value="emit('set', ik, $event)" />
        <TileIcon v-if="libraryFile(ik)" class="thumb" :icon="{ kind: 'file', name: libraryFile(ik)!, tint: false }" />
        <BaseButton variant="icon" :title="t('admin.settings.icon.library')" :aria-expanded="library === ik"
          @click.prevent="library = library === ik ? null : ik">
          <BaseIcon name="folder" :size="16" />
        </BaseButton>
      </span>
      <BaseInput v-else lazy :list="suggestList(itf)" :model-value="text(ik, itf)"
        @update:model-value="emit('set', ik, $event)" />
    </label>
    <LibraryIconPicker v-if="library && shown.some(([k]) => k === library)" class="wide"
      :value="String(item[library] ?? '')" @pick="pickIcon(library!, $event)" />
  </div>
</template>

<style scoped>
.cells { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); }
.cell { flex: 1 1 110px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* A checkbox needs no column of its own: label beside the box, sized to its content. */
.cell.flag { flex: 0 0 auto; flex-direction: row-reverse; align-items: center; gap: var(--space-1); }
.cell.flag input { accent-color: var(--accent); width: 16px; height: 16px; }
.iconRow { display: flex; align-items: center; gap: var(--space-1); }
.iconRow > :first-child { flex: 1; min-width: 0; }
.thumb { flex: 0 0 auto; width: 22px; height: 22px; }
.wide { flex: 1 1 100%; }
.cap { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
