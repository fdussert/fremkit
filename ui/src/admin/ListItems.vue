<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { pick, useI18n } from '../shared/i18n'
import type { SettingField } from '../shared/types'
import { gridDropIndex, dropMarker } from './gifDrag'
import { dropIndex } from './pageDrag'
import { itemSummary } from './listItems'

/**
 * The items of a `list` setting, folded: one row each, or a grid of tiles laid out the way the
 * widget lays them (`grid` in the manifest). Touching an item opens its fields — the `editor`
 * slot — under its row, or under the grid; one item is open at a time. An item is dragged into
 * place with pointer events, as the pages list and the bar's widgets are (a WKWebView does not
 * deliver HTML drag and drop reliably); each drop is one `move`, so one undo step.
 *
 * An item that holds a list of its own (a shortcuts group) takes an item dropped onto its middle:
 * that drop is one `nest` instead, and the edges of the holder still mean "before" and "after".
 */
const props = defineProps<{
  field: SettingField
  items: Record<string, unknown>[]
  /** Columns of the grid, or null for one row per item. */
  columns: number | null
  /** The open item's index, or null. */
  open: number | null
  /** Per item: how many items it holds, or null for an item that holds no list. Absent, none does. */
  holders?: ({ count: number } | null)[]
  /** Whether the item at `from` may be dropped into the one at `into`. Absent, nothing nests. */
  canNest?: (from: number, into: number) => boolean
}>()
const emit = defineEmits<{ toggle: [index: number]; move: [from: number, to: number]; nest: [from: number, into: number] }>()
const { t } = useI18n()

const summaries = computed(() => props.items.map((item) => itemSummary(item, props.field, pick)))
const ids = computed(() => props.items.map((_, i) => String(i)))
const gridStyle = computed(() => (props.columns ? { gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` } : undefined))

const DRAG_THRESHOLD = 4
const list = ref<HTMLElement>()
const dragged = ref<number | null>(null)
const to = ref<number | null>(null)
/** The holder the dragged item would go into, instead of landing at `to`. */
const into = ref<number | null>(null)
/** The middle share of a holder's box that means "into" rather than "beside". */
const INTO_SHARE = 0.5
let pressed: { from: number; x: number; y: number; pointer: number; el: HTMLElement } | null = null
let swallowClick = false

function onDown(e: PointerEvent, from: number): void {
  if (e.button !== 0) return
  pressed = { from, x: e.clientX, y: e.clientY, pointer: e.pointerId, el: e.currentTarget as HTMLElement }
}
function onMove(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  if (dragged.value === null) {
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < DRAG_THRESHOLD) return
    dragged.value = pressed.from
    // Captured so the release lands here even off the item.
    try { pressed.el.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    pressed.el.focus({ preventScroll: true })
    window.addEventListener('keydown', onDragKey, true)
  }
  into.value = holderUnder(e.clientX, e.clientY)
  to.value = into.value === null ? landing(e.clientX, e.clientY) : null
}
/** The holder whose middle is under the pointer, if the dragged item may go into it. */
function holderUnder(x: number, y: number): number | null {
  const from = dragged.value
  if (!list.value || from === null || !props.holders || !props.canNest) return null
  const els = [...list.value.querySelectorAll<HTMLElement>(':scope > [data-list-item]')]
  for (const [i, el] of els.entries()) {
    if (i === from || !props.holders[i] || !props.canNest(from, i)) continue
    const r = el.getBoundingClientRect()
    // Across a tile in a grid, down a row in a list: the edges stay "before" and "after".
    const [pos, start, size] = props.columns ? [x, r.left, r.width] : [y, r.top, r.height]
    const margin = (size * (1 - INTO_SHARE)) / 2
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && pos >= start + margin && pos <= start + size - margin) return i
  }
  return null
}
/** The index the dragged item would have once dropped, from the items' boxes as they stand. */
function landing(x: number, y: number): number | null {
  if (!list.value || dragged.value === null) return null
  const boxes = [...list.value.querySelectorAll<HTMLElement>(':scope > [data-list-item]')].map((el) => el.getBoundingClientRect())
  return props.columns ? gridDropIndex(boxes, x, y, dragged.value) : dropIndex(boxes, y, dragged.value)
}
function onUp(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  const from = dragged.value
  const target = to.value
  const holder = into.value
  endDrag()
  if (from === null) return
  // The click that follows this release comes before any timer.
  swallowClick = true
  setTimeout(() => { swallowClick = false })
  if (holder !== null) emit('nest', from, holder)
  else if (target !== null && target !== from) emit('move', from, target)
}
function endDrag(): void {
  pressed = null
  dragged.value = null
  to.value = null
  into.value = null
  window.removeEventListener('keydown', onDragKey, true)
}
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Escape puts the item back, and must not also close the settings window.
  e.preventDefault()
  e.stopPropagation()
  endDrag()
}
onUnmounted(endDrag)
function onClick(i: number): void {
  if (!swallowClick) emit('toggle', i)
}
/** The item the drop line is drawn before: its index as a string, `null` after the last one. */
const marker = computed(() => (dragged.value === null || to.value === null ? undefined : dropMarker(ids.value, String(dragged.value), to.value)))
const dropBefore = (i: number) => marker.value === String(i)
const dropAfter = (i: number) => marker.value === null && i === props.items.length - 1
</script>

<template>
  <ul ref="list" :class="columns ? 'grid' : 'rows'" :style="gridStyle">
    <template v-for="(item, i) in items" :key="i">
      <li data-list-item :class="{ open: open === i, lifted: dragged === i, 'drop-before': dropBefore(i), 'drop-after': dropAfter(i), 'drop-into': into === i, holder: holders?.[i] }">
        <!-- data-overlay while lifted: the Escape that drops the drag must not also close the window. -->
        <button type="button" class="item" :aria-expanded="open === i" :title="t('admin.settings.list.drag')"
          :data-overlay="dragged === i ? '' : undefined"
          @pointerdown="onDown($event, i)" @pointermove="onMove" @pointerup="onUp" @pointercancel="endDrag"
          @click="onClick(i)">
          <BaseIcon v-if="!columns" name="grip-vertical" :size="14" class="grip" />
          <BaseIcon v-if="holders?.[i]" name="folder" :size="14" class="kind" />
          <span class="name" :class="{ unnamed: !summaries[i] }">{{ summaries[i] || t('admin.settings.list.unnamed', { n: i + 1 }) }}</span>
          <span v-if="holders?.[i]" class="count">{{ holders[i]!.count }}</span>
          <BaseIcon v-if="!columns" :name="open === i ? 'chevron-up' : 'chevron-down'" :size="14" class="fold" />
        </button>
      </li>
      <li v-if="!columns && open === i" class="editor"><slot name="editor" :index="i" /></li>
    </template>
  </ul>
  <div v-if="columns && open !== null && open < items.length" class="editor grid-editor"><slot name="editor" :index="open" /></div>
</template>

<style scoped>
ul { list-style: none; margin: 0 0 var(--space-1); padding: 0; }
.rows { display: flex; flex-direction: column; gap: var(--space-1); }
.grid { display: grid; gap: var(--space-1); }
.item { width: 100%; display: flex; align-items: center; gap: var(--space-1); min-height: 36px;
  padding: var(--space-1) var(--space-2); background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; text-align: left;
  cursor: grab; touch-action: none; user-select: none; }
.grid .item { justify-content: center; text-align: center; min-height: 44px; }
.item:hover { border-color: var(--border-strong); }
.open .item { border-color: var(--accent); }
.name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name.unnamed { color: var(--text-dim); font-style: italic; }
.grip, .fold { flex: 0 0 auto; color: var(--text-dim); }
li.lifted { opacity: .4; }
/* The line the lifted item lands on: above a row or left of a tile, or after the last one. */
.rows li.drop-before { box-shadow: 0 -3px 0 var(--accent); }
.rows li.drop-after { box-shadow: 0 3px 0 var(--accent); }
.grid li.drop-before { box-shadow: -3px 0 0 var(--accent); }
.grid li.drop-after { box-shadow: 3px 0 0 var(--accent); }
/* An item that holds others reads as a folder; dropped onto its middle, an item goes in. */
.holder .item { border-style: dashed; }
li.drop-into .item { border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
.kind { flex: 0 0 auto; color: var(--accent); }
.count { flex: 0 0 auto; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--surface-2, var(--border));
  color: var(--text-dim); font-size: var(--fs-xs); text-align: center; }
/* A tile has no room to spare for it: the count sits in its corner. */
.grid .item { position: relative; }
.grid .count { position: absolute; top: 2px; right: 2px; min-width: 14px; padding: 0 4px; line-height: 14px; }
.editor { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: var(--space-2); }
.grid-editor { margin-bottom: var(--space-1); }
</style>
