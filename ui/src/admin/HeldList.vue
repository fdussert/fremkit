<script setup lang="ts">
/**
 * The list an open item holds (a shortcuts group's buttons), drawn under the item's own fields:
 * the same folded tiles, one held item open at a time, and, when the held items may hold a list
 * too (a subgroup), that list under the open one's fields, by this same component.
 *
 * Every change goes up as the whole new list (`change`), which the form saves as one emit, so
 * one undo step. Taking an item out of this list is the holder's business, one level up: it is
 * asked with `takeOut`, and the item lands right after its holder there.
 */
import { computed, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import ListItems from './ListItems.vue'
import ItemCells from './ItemCells.vue'
import { heldItems, moveTo, nestInto, nestedListKey, newItem, takeOut } from './listItems'
import { pick, useI18n } from '../shared/i18n'
import { fieldShown, type ListItemField, type SuggestSource } from '../shared/types'

type Item = Record<string, unknown>

const props = defineProps<{
  field: ListItemField
  /** The key the holder keeps this list under, for the `data-held` hook. */
  heldKey: string
  items: Item[]
  columns: number | null
  /** The holder's own list is full: an item taken out of here would not fit there. */
  outerFull: boolean
  suggestLists: Partial<Record<SuggestSource, string>>
  timezoneListId: string
  timeZones: string[]
}>()
const emit = defineEmits<{ change: [list: Item[]]; takeOut: [index: number] }>()
const { t } = useI18n()

const open = ref<number | null>(null)
const full = computed(() => props.field.max !== undefined && props.items.length >= props.field.max)

/** The list an item of this one holds, when its fields say it shows one. */
const innerKey = computed(() => nestedListKey(props.field))
function inner(item: Item | undefined): { key: string; field: ListItemField } | null {
  const key = innerKey.value
  const field = key ? props.field.itemSchema?.[key] : undefined
  return key && field && item && fieldShown(field, item) ? { key, field } : null
}
const holders = computed(() => (innerKey.value
  ? props.items.map((item) => (inner(item) ? { count: heldItems(item, innerKey.value!).length } : null))
  : undefined))
function canNest(from: number, into: number): boolean {
  const held = inner(props.items[into])
  return !!held && nestInto(props.items, from, into, held.key, held.field) !== null
}

function toggle(i: number): void {
  open.value = open.value === i ? null : i
}
function add(): void {
  if (full.value) return
  open.value = props.items.length
  emit('change', [...props.items, newItem(props.field)])
}
function remove(j: number): void {
  open.value = null
  emit('change', props.items.filter((_, n) => n !== j))
}
function move(from: number, to: number): void {
  if (to < 0 || to >= props.items.length || to === from) return
  if (open.value === from) open.value = to
  emit('change', moveTo(props.items, from, to))
}
function setField(j: number, key: string, value: unknown): void {
  emit('change', props.items.map((item, n) => (n === j ? { ...item, [key]: value } : item)))
}
function setInner(j: number, key: string, list: Item[]): void {
  setField(j, key, list)
}
/** An item dropped onto a holder of this list goes in at its end; the holder opens on it. */
function nest(from: number, into: number): void {
  const held = inner(props.items[into])
  const next = held ? nestInto(props.items, from, into, held.key, held.field) : null
  if (!next) return
  open.value = into > from ? into - 1 : into
  emit('change', next)
}
/** An item of the open one's list, put back in this list right after it. */
function takeOutOf(i: number, key: string, j: number): void {
  emit('change', takeOut(props.items, i, key, j, props.field, newItem(props.field)))
}
</script>

<template>
  <div class="held" :data-held="heldKey">
    <span class="cap">{{ pick(field.label) }}</span>
    <p v-if="!items.length" class="hint">{{ t('admin.settings.list.heldEmpty') }}</p>
    <ListItems v-else :field="{ ...field, type: 'list' }" :items="items" :columns="columns"
      :open="open !== null && open < items.length ? open : null" :holders="holders" :can-nest="canNest"
      @toggle="toggle" @move="move" @nest="nest">
      <template #editor="{ index: j }">
        <ItemCells :schema="field.itemSchema ?? {}" :item="items[j]" :suggest-lists="suggestLists"
          :timezone-list-id="timezoneListId" :time-zones="timeZones" @set="(key, value) => setField(j, key, value)" />
        <template v-for="h in [inner(items[j])]" :key="j">
          <HeldList v-if="h" :field="h.field" :held-key="h.key" :items="heldItems(items[j], h.key)" :columns="columns"
            :outer-full="full" :suggest-lists="suggestLists" :timezone-list-id="timezoneListId" :time-zones="timeZones"
            @change="setInner(j, h.key, $event)" @take-out="takeOutOf(j, h.key, $event)" />
        </template>
        <div class="rowActions">
          <BaseButton variant="icon" :title="t('admin.settings.list.earlier')" :disabled="j === 0" @click="move(j, j - 1)">
            <BaseIcon name="chevron-up" :size="14" />
          </BaseButton>
          <BaseButton variant="icon" :title="t('admin.settings.list.later')" :disabled="j === items.length - 1" @click="move(j, j + 1)">
            <BaseIcon name="chevron-down" :size="14" />
          </BaseButton>
          <BaseButton variant="icon" :title="t('admin.settings.list.takeOut')" :disabled="outerFull"
            @click="open = null; emit('takeOut', j)">
            <BaseIcon name="folder-output" :size="14" />
          </BaseButton>
          <BaseButton variant="icon" :title="t('common.remove')" @click="remove(j)">
            <BaseIcon name="trash-2" :size="14" />
          </BaseButton>
        </div>
      </template>
    </ListItems>
    <BaseButton class="add" :disabled="full" @click="add">
      <BaseIcon name="plus" :size="14" />{{ t('admin.settings.list.add') }}
    </BaseButton>
  </div>
</template>

<style scoped>
/* Under the open item's fields, set off by a dashed rule. */
.held { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-2);
  padding-top: var(--space-2); border-top: 1px dashed var(--border); }
.cap { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .06em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.rowActions { display: flex; justify-content: flex-end; margin-top: var(--space-1); }
.add { align-self: flex-start; }
</style>
