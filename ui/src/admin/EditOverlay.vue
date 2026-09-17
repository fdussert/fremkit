<script setup lang="ts">
/**
 * Mouse capture layer over the widget area in edit mode: grid guides, selection,
 * eight resize handles, and a snapped ghost that turns red when the drop is refused.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BaseChip from '../shared/ui/BaseChip.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { pick } from '../shared/i18n'
import { DND_TYPE, useAdminStore } from './store'
import { fitAround, fits, moveRect, resizeRect, snapPoint, type Handle, type Rect } from './layout'

const props = defineProps<{ scale: number }>()
const s = useAdminStore()
const root = ref<HTMLElement>()

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const cell = computed(() => s.state.config!.display.cell)
const widgets = computed(() => s.page.value?.widgets ?? [])
const boardH = computed(() => s.grid.value.rows * cell.value)

interface Drag { kind: 'move' | 'resize' | 'create'; instanceId: string; widgetId: string; start: Rect; handle: Handle; min: [number, number]; ox: number; oy: number }
const drag = ref<Drag | null>(null)
const ghost = ref<Rect | null>(null)
const ghostOk = ref(true)
/** The element holding the pointer capture, so an aborted drag can hand it back. */
let captured: { el: HTMLElement; pointerId: number } | null = null

const boxStyle = (r: Rect) => ({
  left: r.x * cell.value + 'px', top: r.y * cell.value + 'px',
  width: r.w * cell.value + 'px', height: r.h * cell.value + 'px',
})
const gridStyle = computed(() => ({
  backgroundSize: `${cell.value}px ${cell.value}px, ${cell.value}px ${cell.value}px, ${cell.value * 4}px ${cell.value * 4}px, ${cell.value * 4}px ${cell.value * 4}px`,
}))

function minOf(widgetId: string): [number, number] {
  return s.state.manifests[widgetId]?.minSize ?? [1, 1]
}
function labelOf(instanceId: string): string {
  const w = widgets.value.find((x) => x.instanceId === instanceId)
  if (!w) return ''
  return `${w.title?.trim() || pick(s.state.manifests[w.widgetId]?.name) || w.widgetId} · ${w.w}×${w.h}`
}
function iconOf(instanceId: string): string {
  const w = widgets.value.find((x) => x.instanceId === instanceId)
  return s.state.manifests[w?.widgetId ?? '']?.icon ?? 'layout-grid'
}

/** Pointer position in grid cells; the board is CSS-scaled, so divide the offset by the scale. */
function cellAt(e: PointerEvent | DragEvent): { x: number; y: number } {
  const box = root.value!.getBoundingClientRect()
  return snapPoint(e.clientX - box.left, e.clientY - box.top, cell.value, props.scale)
}

function begin(e: PointerEvent, instanceId: string, kind: 'move' | 'resize', handle: Handle): void {
  const inst = widgets.value.find((w) => w.instanceId === instanceId)
  if (!inst) return
  s.select(instanceId)
  const p = cellAt(e)
  drag.value = {
    kind, instanceId, widgetId: inst.widgetId, handle,
    start: { x: inst.x, y: inst.y, w: inst.w, h: inst.h },
    min: minOf(inst.widgetId), ox: p.x, oy: p.y,
  }
  ghost.value = { ...drag.value.start }
  ghostOk.value = true
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  captured = { el, pointerId: e.pointerId }
  e.preventDefault()
  e.stopPropagation()
}

function onPointerMove(e: PointerEvent): void {
  const d = drag.value
  if (!d) return
  const p = cellAt(e)
  const next = d.kind === 'move'
    ? moveRect(d.start, p.x - d.ox, p.y - d.oy, s.grid.value)
    : resizeRect(d.start, d.handle, p.x - d.ox, p.y - d.oy, d.min, s.grid.value)
  ghost.value = next
  ghostOk.value = fits(next, s.grid.value, s.others(d.instanceId))
}

function onPointerUp(): void {
  const d = drag.value
  const g = ghost.value
  drag.value = null
  ghost.value = null
  captured = null
  if (!d || !g || !ghostOk.value) return
  if (g.x === d.start.x && g.y === d.start.y && g.w === d.start.w && g.h === d.start.h) return
  s.updateInstance(d.instanceId, { x: g.x, y: g.y, w: g.w, h: g.h })
}

function onBackgroundDown(): void {
  s.select(null)
}

/**
 * Safety net: losing the window mid-drag means no pointerup ever arrives, which would leave
 * a ghost stuck on the board and the next click applying a stale move. Drop the drag instead.
 */
function abortDrag(): void {
  if (captured) {
    // The element may already be gone or the capture implicitly released; either is fine.
    try { captured.el.releasePointerCapture(captured.pointerId) } catch { /* nothing to release */ }
    captured = null
  }
  drag.value = null
  ghost.value = null
}
function onVisibilityChange(): void { if (document.hidden) abortDrag() }

onMounted(() => {
  window.addEventListener('blur', abortDrag)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', abortDrag)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// --- dropping a card from the library ---
function onDragOver(e: DragEvent): void {
  // Only our own library cards may drop here: a native drag of text, a link or an image
  // carries no DND_TYPE and must pass straight through.
  if (!e.dataTransfer?.types.includes(DND_TYPE)) return
  const id = s.state.dragWidgetId
  const manifest = id ? s.state.manifests[id] : undefined
  if (!manifest) return
  e.preventDefault()
  // The ghost shrinks towards the widget's minimum when the default size does not fit here.
  const next = fitAround(cellAt(e), manifest.defaultSize, manifest.minSize, s.grid.value, s.others())
  ghost.value = next
  ghostOk.value = fits(next, s.grid.value, s.others())
}

function onDrop(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes(DND_TYPE)) return
  e.preventDefault()
  const id = s.state.dragWidgetId
  const g = ghost.value
  ghost.value = null
  s.setDragWidget(null)
  if (id && g && ghostOk.value) s.placeWidget(id, g)
}

function onDragLeave(): void { ghost.value = null }
</script>

<template>
  <div
    class="overlay" ref="root" :style="[{ height: boardH + 'px' }, gridStyle]"
    @pointerdown="onBackgroundDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    @dragover="onDragOver" @drop="onDrop" @dragleave="onDragLeave"
  >
    <div
      v-for="w in widgets" :key="w.instanceId" class="hit"
      :class="{ selected: w.instanceId === s.state.selectedId }" :style="boxStyle(w)"
      @pointerdown="begin($event, w.instanceId, 'move', 'se')"
    >
      <BaseChip v-if="w.instanceId === s.state.selectedId" tone="accent" class="tag">
        <BaseIcon :name="iconOf(w.instanceId)" :size="14" />{{ labelOf(w.instanceId) }}
      </BaseChip>
      <span
        v-for="hnd in HANDLES" v-show="w.instanceId === s.state.selectedId" :key="hnd"
        class="handle" :class="hnd" @pointerdown="begin($event, w.instanceId, 'resize', hnd)"
      />
    </div>
    <div v-if="ghost" class="ghost" :class="{ bad: !ghostOk }" :style="boxStyle(ghost)" />
  </div>
</template>

<style scoped>
.overlay { position: absolute; left: 0; top: 0; right: 0; touch-action: none; user-select: none; z-index: 4;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, .05) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, .05) 1px, transparent 1px),
    linear-gradient(to right, rgba(255, 255, 255, .12) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, .12) 1px, transparent 1px);
}
.hit { position: absolute; box-sizing: border-box; cursor: move; border: 2px solid transparent; border-radius: var(--radius-md); }
.hit.selected { border-color: var(--accent); }
.tag { position: absolute; left: 6px; top: 6px; pointer-events: none; }
.handle { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 3px;
  background: var(--accent); border: 2px solid var(--on-accent); box-sizing: border-box; }
.handle.nw { left: 0; top: 0; cursor: nwse-resize; }
.handle.n { left: 50%; top: 0; cursor: ns-resize; }
.handle.ne { left: 100%; top: 0; cursor: nesw-resize; }
.handle.e { left: 100%; top: 50%; cursor: ew-resize; }
.handle.se { left: 100%; top: 100%; cursor: nwse-resize; }
.handle.s { left: 50%; top: 100%; cursor: ns-resize; }
.handle.sw { left: 0; top: 100%; cursor: nesw-resize; }
.handle.w { left: 0; top: 50%; cursor: ew-resize; }
.ghost { position: absolute; box-sizing: border-box; pointer-events: none; border-radius: var(--radius-md);
  border: 2px dashed var(--ok); background: rgba(47, 179, 107, .18); }
.ghost.bad { border-color: var(--danger); background: rgba(217, 70, 63, .18); }
</style>
