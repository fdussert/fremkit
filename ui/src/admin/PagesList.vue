<script setup lang="ts">
/**
 * The screen's pages, in order. A row is a name and nothing else until it is hovered, when one
 * "…" appears; the commands are in the row's menu (right click, the "…", or the context-menu key
 * on a focused row). Rows reorder by dragging — pointer events, not HTML drag and drop, which a
 * WKWebView does not deliver reliably — and from the keyboard with the menu's Move up and down.
 */
import { nextTick, onUnmounted, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { openContextMenu } from '../shared/ui/contextMenu'
import { editorFocus, renameRequest } from './editorFocus'
import { pageMenu, type PageMenuUi } from './menus'
import { dropIndex } from './pageDrag'
import { useAdminStore } from './store'
import HealthDot from './HealthDot.vue'
import { pageLevel } from './health'
import { useHealth } from './useHealth'

const s = useAdminStore()
const { t } = useI18n()
const health = useHealth()
const editing = ref<string | null>(null)
// Escape unmounts the input, and that unmount fires a native blur — so the blur handler has to
// be told the edit was abandoned, or it would commit the very text Escape just rejected.
let cancelling = false

function startEdit(id: string): void {
  cancelling = false
  editing.value = id
}
function cancelEdit(): void {
  cancelling = true
  editing.value = null
}
function commitName(i: number, e: Event): void {
  if (cancelling) { cancelling = false; return }
  const value = (e.target as HTMLInputElement).value.trim()
  if (value) s.renamePage(i, value)
  editing.value = null
}

const ui: PageMenuUi = {
  ...editorFocus,
  rename: (i) => { const p = s.screen.value?.pages[i]; if (p) startEdit(p.id) },
}

function onMenu(e: MouseEvent, i: number): void {
  openContextMenu(e, pageMenu(s, i, ui))
}
/** The "…" opens the same menu under itself, as a Mac pop-up button does. */
function onMore(e: MouseEvent, i: number): void {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openContextMenu({ x: box.left, y: box.bottom + 2 }, pageMenu(s, i, ui))
}
/** Shift+F10 or the context-menu key on a focused row: the menu opens below the row. */
function onRowKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault()
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    openContextMenu({ x: box.left + 8, y: box.bottom }, pageMenu(s, i, ui))
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    s.selectPage(i)
  } else if (e.key === 'F2') {
    e.preventDefault()
    ui.rename(i)
  }
}

/**
 * The drag. A press on a row arms it; past a few pixels it starts, the row follows the pointer's
 * place in the list and a line shows where it will land; the release drops it there. The click
 * that follows a drag is swallowed, so dropping a page does not also select it.
 */
const DRAG_THRESHOLD = 4
const list = ref<HTMLElement>()
const drag = ref<{ from: number; to: number } | null>(null)
let pressed: { from: number; y: number; id: number; el: HTMLElement } | null = null
let swallowClick = false

function rowBoxes(): { top: number; height: number }[] {
  return [...(list.value?.querySelectorAll<HTMLElement>(':scope > li') ?? [])].map((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, height: r.height }
  })
}

function onDown(e: PointerEvent, i: number): void {
  if (e.button !== 0 || editing.value) return
  // The "…" and the rename field keep their own presses.
  if ((e.target as HTMLElement).closest('button, input')) return
  pressed = { from: i, y: e.clientY, id: e.pointerId, el: e.currentTarget as HTMLElement }
}
function onMove(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.id) return
  if (!drag.value) {
    if (Math.abs(e.clientY - pressed.y) < DRAG_THRESHOLD) return
    drag.value = { from: pressed.from, to: pressed.from }
    // Captured so the release lands here even off the list, the way the canvas's drags do.
    try { pressed.el.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    window.addEventListener('keydown', onDragKey, true)
  }
  drag.value = { ...drag.value, to: dropIndex(rowBoxes(), e.clientY, drag.value.from) }
}
function onUp(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.id) return
  const d = drag.value
  endDrag()
  if (!d) return
  swallowClick = true
  if (d.to !== d.from) s.reorderPage(d.from, d.to)
}
function endDrag(): void {
  pressed = null
  drag.value = null
  window.removeEventListener('keydown', onDragKey, true)
}
/** Escape drops the drag where it started. */
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  endDrag()
  swallowClick = true
}
function onClick(i: number): void {
  if (swallowClick) { swallowClick = false; return }
  s.selectPage(i)
}
onUnmounted(endDrag)

/** Where the drop line goes: above the row it lands on, or below the last when it lands last. */
function dropClass(i: number): Record<string, boolean> {
  const d = drag.value
  if (!d || d.to === d.from) return {}
  return { 'drop-before': i === d.to && d.to < d.from, 'drop-after': i === d.to && d.to > d.from }
}

/** A rename asked for by the command palette. */
watch(renameRequest, (req) => {
  if (req?.kind !== 'page') return
  renameRequest.value = null
  if (s.screen.value?.pages.some((p) => p.id === req.id)) startEdit(req.id)
}, { immediate: true })

/** A rename started from the menu or the keyboard puts the cursor in the field, text selected. */
watch(editing, async (id) => {
  if (!id) return
  await nextTick()
  const input = list.value?.querySelector<HTMLInputElement>('input')
  input?.focus()
  input?.select()
})
</script>

<template>
  <section>
    <h2>{{ t('admin.pages.title') }} <BaseButton variant="icon" :title="t('admin.pages.add')" @click="s.addPage()"><BaseIcon name="plus" :size="16" /></BaseButton></h2>
    <ul ref="list" :class="{ dragging: !!drag }">
      <li v-for="(p, i) in s.screen.value!.pages" :key="p.id" tabindex="0"
        :class="{ on: i === s.state.pageIndex, lifted: drag?.from === i, ...dropClass(i) }"
        :title="t('admin.pages.drag')"
        @click="onClick(i)" @contextmenu="onMenu($event, i)" @keydown.self="onRowKey($event, i)"
        @pointerdown="onDown($event, i)" @pointermove="onMove" @pointerup="onUp" @pointercancel="endDrag">
        <BaseIcon v-if="s.screen.value!.pages.length > 1" name="grip-vertical" :size="14" class="grip" aria-hidden="true" />
        <input v-if="editing === p.id" :value="p.name" 
          @click.stop @blur="commitName(i, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelEdit()" />
        <span v-else class="name" @dblclick.stop="startEdit(p.id)">{{ p.name }}</span>
        <HealthDot :level="pageLevel(health.all.value, p)" :title="t('admin.health.pageDot')" class="health" />
        <span v-if="p.background" class="own-bg" :title="t('admin.inspector.page.background.own')" />
        <BaseButton variant="icon" class="more" :title="t('admin.pages.more')" :aria-label="t('admin.pages.more')"
          @click.stop="onMore($event, i)">
          <BaseIcon name="ellipsis" :size="14" />
        </BaseButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h2 { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin: 0 0 var(--space-2); }
ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
li { position: relative; display: flex; align-items: center; gap: 2px; min-height: 32px; padding: 0 2px 0 2px;
  border-radius: var(--radius-sm); cursor: pointer; font-size: var(--fs-sm); touch-action: none;
  user-select: none; -webkit-user-select: none; }
li:hover { background: var(--surface-2); }
li.on { background: var(--surface-3); }
li:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dragging li { cursor: grabbing; }
li.lifted { opacity: .55; }
/* The line the dragged page lands on: above the row when it moves up, below it when it moves down. */
li.drop-before::before, li.drop-after::after { content: ''; position: absolute; left: 4px; right: 4px; height: 2px;
  border-radius: 1px; background: var(--accent); pointer-events: none; }
li.drop-before::before { top: -2px; }
li.drop-after::after { bottom: -2px; }
/* The usual sign that a row can be dragged: faint at rest, plain under the pointer. */
.grip { flex: 0 0 auto; color: var(--text-muted); opacity: .5; cursor: grab; }
li:hover .grip { opacity: 1; }
.dragging .grip { cursor: grabbing; }
.name { flex: 1; padding-left: 2px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A page with a background of its own says so with a small accent dot. */
.health { margin: 0 4px; }
.own-bg { width: 6px; height: 6px; flex: 0 0 auto; margin: 0 4px; border-radius: 50%; background: var(--accent); }
/* One control on a row, and only where the pointer is — or the keyboard, which a click's focus is not. */
.more { visibility: hidden; }
li:hover .more, li:focus-visible .more, li:has(:focus-visible) .more { visibility: visible; }
.dragging .more { visibility: hidden; }
input { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--bg); border: 1px solid var(--accent); border-radius: 6px; padding: 3px 6px; }
</style>
