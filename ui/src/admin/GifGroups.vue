<script setup lang="ts">
/**
 * The GIF board panel's left column: the groups, each with its thumbnails.
 *
 * Thumbnails drag (HTML drag and drop, as the widget library's cards do) to reorder within a group
 * or move to another; a group's `+` asks the panel to point its paste field at that group. A
 * group's name and a GIF's label are edited inline, from the right-click menus (`gifMenus.ts`) or
 * a double click. Every edit is one `apply()`.
 */
import { nextTick, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { openContextMenu } from '../shared/ui/contextMenu'
import type { GifGroup } from '../shared/types'
import { MAX_GROUPS, MAX_LABEL, MAX_NAME, moveItem, renameGroup, setLabel, thumbOf } from './gifBoard'
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
function commit(e: Event): void {
  const edit = editing.value
  editing.value = null
  if (cancelling || !edit) { cancelling = false; return }
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

/** The drag: which GIF is lifted, and where it would land. */
const MIME = 'application/x-fremkit-gif'
const dragging = ref<{ id: string; group: string; index: number } | null>(null)
const over = ref<{ group: string; index: number } | null>(null)

function onDragStart(e: DragEvent, groupId: string, index: number, id: string): void {
  if (editing.value) { e.preventDefault(); return }
  dragging.value = { id, group: groupId, index }
  e.dataTransfer?.setData(MIME, id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDragEnd(): void {
  dragging.value = null
  over.value = null
}
/** `index` is where the GIF lands once moved: the place of the thumbnail it is dropped on. */
function onDragOver(e: DragEvent, groupId: string, index: number): void {
  if (!dragging.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  over.value = { group: groupId, index }
}
function onDrop(e: DragEvent, groupId: string, index: number): void {
  const d = dragging.value
  onDragEnd()
  if (!d) return
  e.preventDefault()
  if (d.group === groupId && Math.min(index, props.groups.find((g) => g.id === groupId)!.items.length - 1) === d.index) return
  s.apply((c) => { if (c.gifs) moveItem(c.gifs, d.id, groupId, index) })
}
/** The line the lifted GIF lands on: after the thumbnail when it moves right in its group, else before. */
function dropClass(groupId: string, index: number): Record<string, boolean> {
  const d = dragging.value
  const o = over.value
  if (!d || !o || o.group !== groupId || o.index !== index || (d.group === groupId && d.index === index)) return {}
  const after = d.group === groupId && d.index < index
  return { 'drop-before': !after, 'drop-after': after }
}

defineExpose({ rename: (groupId: string) => void startEdit('name', groupId) })
</script>

<template>
  <div ref="root" class="groups">
    <p v-if="!groups.length" class="empty">{{ t('admin.gifs.empty') }}</p>
    <section v-for="g in groups" :key="g.id" class="group" :class="{ on: g.id === target }">
      <header @click="emit('target', g.id)" @contextmenu="openContextMenu($event, gifGroupMenu(s, g.id, ui))">
        <!-- data-overlay: Escape here cancels the edit and must not also close the dialog. -->
        <input v-if="editing?.kind === 'name' && editing.id === g.id" class="inline" :value="g.name" :maxlength="MAX_NAME"
          :aria-label="t('admin.gifs.groupName')" data-overlay
          @click.stop @blur="commit" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelEdit()" />
        <span v-else class="name" @dblclick.stop="startEdit('name', g.id)">{{ g.name }}</span>
        <span class="count">{{ g.items.length }}</span>
      </header>
      <ul class="thumbs" :class="{ 'drop-end': over?.group === g.id && over.index === g.items.length && dragging?.group !== g.id }"
        @dragover="onDragOver($event, g.id, g.items.length)" @drop="onDrop($event, g.id, g.items.length)">
        <li v-for="(item, i) in g.items" :key="item.id" class="thumb"
          :class="{ lifted: dragging?.id === item.id, ...dropClass(g.id, i) }"
          :draggable="!editing" :title="item.label || t('admin.gifs.drag')"
          @dragstart="onDragStart($event, g.id, i, item.id)" @dragend="onDragEnd"
          @dragover.stop="onDragOver($event, g.id, i)" @drop.stop="onDrop($event, g.id, i)"
          @contextmenu="openContextMenu($event, gifItemMenu(s, item.id, ui))">
          <img :src="thumbOf(item)" alt="" loading="lazy" draggable="false" />
          <input v-if="editing?.kind === 'label' && editing.id === item.id" class="inline caption" :value="item.label ?? ''"
            :maxlength="MAX_LABEL" :placeholder="t('admin.gifs.labelPlaceholder')" data-overlay
            @blur="commit" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelEdit()" />
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
.thumbs.drop-end { outline: 2px dashed var(--accent); outline-offset: 2px; }
.thumb { position: relative; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); cursor: grab; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.thumb.lifted { opacity: .4; }
.thumb.drop-before { box-shadow: inset 3px 0 0 var(--accent); }
.thumb.drop-after { box-shadow: inset -3px 0 0 var(--accent); }
.caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 2px 4px; font-size: var(--fs-xs); color: #fff;
  background: rgba(0, 0, 0, .6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input.caption { width: 100%; border-radius: 0; color: var(--text); background: var(--surface); }
.plus { aspect-ratio: 1; }
.plus button { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); }
.plus button:hover { color: var(--text); border-color: var(--accent); }
.new { align-self: flex-start; }
</style>
