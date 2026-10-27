<script setup lang="ts">
/**
 * The GIF board panel's left column: the groups, each with its thumbnails.
 *
 * Thumbnails drag (pointer events, as the pages list's rows do) to reorder within a group or move
 * to another; a group's `+` asks the panel to point its paste field at that group. A
 * group's name and a GIF's label are edited inline, from the right-click menus (`gifMenus.ts`) or
 * a double click. Every edit is one `apply()`.
 */
import { nextTick, onUnmounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { openContextMenu } from '../shared/ui/contextMenu'
import type { GifGroup } from '../shared/types'
import { MAX_GROUPS, MAX_LABEL, MAX_NAME, moveItem, renameGroup, setLabel, thumbOf } from './gifBoard'
import { dropMarker, gridDropIndex } from './gifDrag'
import { gifGroupMenu, gifItemMenu, type GifMenuUi } from './gifMenus'
import { useAdminStore } from './store'

const props = defineProps<{ groups: GifGroup[]; target: string }>()
const emit = defineEmits<{ target: [groupId: string]; add: [groupId: string]; new: [] }>()
const s = useAdminStore()
const { t } = useI18n()
const root = ref<HTMLElement>()

/** What is being edited inline: a group's name or a GIF's label, by id. */
const editing = ref<{ kind: 'name' | 'label'; id: string } | null>(null)
// Escape unmounts the input, whose unmount fires a blur: the blur must know the edit was dropped.
let cancelling = false

async function startEdit(kind: 'name' | 'label', id: string): Promise<void> {
  cancelling = false
  editing.value = { kind, id }
  await nextTick()
  const input = root.value?.querySelector<HTMLInputElement>('input.inline')
  input?.focus()
  input?.select()
}
function cancelEdit(): void {
  cancelling = true
  editing.value = null
}
/** `kind` and `id` come from the input that blurred, not from `editing`, which may have moved on. */
function commit(e: Event, kind: 'name' | 'label', id: string): void {
  const edit = { kind, id }
  if (editing.value?.kind === kind && editing.value.id === id) editing.value = null
  if (cancelling) { cancelling = false; return }
  const value = (e.target as HTMLInputElement).value
  if (edit.kind === 'name') {
    const group = props.groups.find((g) => g.id === edit.id)
    if (!value.trim() || value.trim() === group?.name) return
    s.apply((c) => { if (c.gifs) renameGroup(c.gifs, edit.id, value) })
  } else {
    const item = props.groups.flatMap((g) => g.items).find((x) => x.id === edit.id)
    if (value.trim() === (item?.label ?? '')) return
    s.apply((c) => { if (c.gifs) setLabel(c.gifs, edit.id, value) })
  }
}

const ui: GifMenuUi = {
  label: (id) => void startEdit('label', id),
  rename: (id) => void startEdit('name', id),
}

/**
 * The drag, with pointer events as the pages list does it (a WKWebView does not deliver HTML drag
 * and drop reliably). A press on a thumbnail arms it; past a few pixels it starts, the thumbnail
 * dims and a line shows where it lands, in its group or another; the release drops it there in
 * one `apply()`. Escape, or a release outside every group, puts it back.
 */
const DRAG_THRESHOLD = 4
const drag = ref<{ id: string; group: string; from: number } | null>(null)
const over = ref<{ group: string; to: number } | null>(null)
let pressed: { id: string; group: string; from: number; x: number; y: number; pointer: number; el: HTMLElement } | null = null

function onDown(e: PointerEvent, groupId: string, from: number, id: string): void {
  if (e.button !== 0 || editing.value) return
  if ((e.target as HTMLElement).closest('input, button')) return
  pressed = { id, group: groupId, from, x: e.clientX, y: e.clientY, pointer: e.pointerId, el: e.currentTarget as HTMLElement }
}
function onMove(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  if (!drag.value) {
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < DRAG_THRESHOLD) return
    drag.value = { id: pressed.id, group: pressed.group, from: pressed.from }
    // Captured so the release lands here even off the thumbnail.
    try { pressed.el.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    // Focused, and marked an overlay while lifted (below), so the Escape that drops the drag is
    // not also the dialog's: BaseModal hears Escape on the window before this listener does.
    pressed.el.focus({ preventScroll: true })
    window.addEventListener('keydown', onDragKey, true)
  }
  over.value = landing(e.clientX, e.clientY)
}
/** The group under the pointer and the index the GIF would have there, or null off every group. */
function landing(x: number, y: number): { group: string; to: number } | null {
  const d = drag.value
  const section = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-gif-group]')
  const groupId = section?.dataset.gifGroup
  if (!d || !section || !groupId) return null
  const boxes = [...section.querySelectorAll<HTMLElement>('li.thumb')].map((el) => el.getBoundingClientRect())
  return { group: groupId, to: gridDropIndex(boxes, x, y, groupId === d.group ? d.from : -1) }
}
function onUp(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  const d = drag.value
  const o = over.value
  endDrag()
  if (!d || !o || (o.group === d.group && o.to === d.from)) return
  s.apply((c) => { if (c.gifs) moveItem(c.gifs, d.id, o.group, o.to) })
}
function endDrag(): void {
  pressed = null
  drag.value = null
  over.value = null
  window.removeEventListener('keydown', onDragKey, true)
}
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Escape drops the drag where it started, and must not also close the dialog.
  e.preventDefault()
  e.stopPropagation()
  endDrag()
}
onUnmounted(endDrag)

/** Where the drop line goes in group `g`: before one thumbnail's id, `null` after the last. */
function markerOf(g: GifGroup): string | null | undefined {
  const d = drag.value
  const o = over.value
  if (!d || !o || o.group !== g.id) return undefined
  return dropMarker(g.items.map((x) => x.id), d.id, o.to)
}

defineExpose({ rename: (groupId: string) => void startEdit('name', groupId) })
</script>

<template>
  <div ref="root" class="groups">
    <p v-if="!groups.length" class="empty">{{ t('admin.gifs.empty') }}</p>
    <section v-for="g in groups" :key="g.id" class="group" :data-gif-group="g.id" :class="{ on: g.id === target }">
      <header @click="emit('target', g.id)" @contextmenu="openContextMenu($event, gifGroupMenu(s, g.id, ui))">
        <!-- data-overlay: Escape here cancels the edit and must not also close the dialog. -->
        <input v-if="editing?.kind === 'name' && editing.id === g.id" class="inline" :value="g.name" :maxlength="MAX_NAME"
          :aria-label="t('admin.gifs.groupName')" data-overlay
          @click.stop @blur="commit($event, 'name', g.id)" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelEdit()" />
        <span v-else class="name" @dblclick.stop="startEdit('name', g.id)">{{ g.name }}</span>
        <span class="count">{{ g.items.length }}</span>
      </header>
      <ul class="thumbs" :class="{ 'drop-end': markerOf(g) === null, dragging: !!drag }">
        <li v-for="(item, i) in g.items" :key="item.id" class="thumb"
          :class="{ lifted: drag?.id === item.id, 'drop-before': markerOf(g) === item.id }"
          :title="item.label || t('admin.gifs.drag')" tabindex="-1" :data-overlay="drag?.id === item.id ? '' : undefined"
          @pointerdown="onDown($event, g.id, i, item.id)" @pointermove="onMove" @pointerup="onUp" @pointercancel="endDrag"
          @contextmenu="openContextMenu($event, gifItemMenu(s, item.id, ui))">
          <img :src="thumbOf(item)" alt="" loading="lazy" draggable="false" />
          <input v-if="editing?.kind === 'label' && editing.id === item.id" class="inline caption" :value="item.label ?? ''"
            :maxlength="MAX_LABEL" :placeholder="t('admin.gifs.labelPlaceholder')" data-overlay
            @blur="commit($event, 'label', item.id)" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelEdit()" />
          <span v-else-if="item.label" class="caption" @dblclick="startEdit('label', item.id)">{{ item.label }}</span>
        </li>
        <li class="plus">
          <button type="button" :title="t('admin.gifs.addTo', { name: g.name })" :aria-label="t('admin.gifs.addTo', { name: g.name })"
            @click="emit('add', g.id)"><BaseIcon name="plus" :size="20" /></button>
        </li>
      </ul>
    </section>
    <BaseButton class="new" :disabled="groups.length >= MAX_GROUPS" @click="emit('new')">
      <BaseIcon name="plus" :size="16" />{{ t('admin.gifs.newGroup') }}
    </BaseButton>
  </div>
</template>

<style scoped>
.groups { display: flex; flex-direction: column; gap: var(--space-3); }
.empty { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
.group { border: 1px solid var(--border); border-radius: var(--radius-md, 8px); padding: var(--space-2); }
.group.on { border-color: var(--accent); }
header { display: flex; align-items: center; gap: var(--space-2); min-height: 28px; cursor: pointer; margin-bottom: var(--space-2); }
.name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: var(--text-muted); font-size: var(--fs-xs); }
input.inline { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: 2px 6px; }
.thumbs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: var(--space-2);
  border-radius: var(--radius-sm); }
.thumb { position: relative; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.dragging .thumb { cursor: grabbing; }
.thumb:focus { outline: none; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.thumb.lifted { opacity: .4; }
/* The line the lifted GIF lands on: before a thumbnail, or before the + tile when it lands last. */
.thumb.drop-before, .drop-end .plus button { box-shadow: -3px 0 0 var(--accent); }
.caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 4px; font-size: var(--fs-xs); color: #fff;
  background: rgba(0, 0, 0, .6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input.caption { width: 100%; border-radius: 0; color: var(--text); background: var(--surface); }
.plus { aspect-ratio: 1; }
.plus button { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); }
.plus button:hover { color: var(--text); border-color: var(--accent); }
.new { align-self: flex-start; }
</style>
