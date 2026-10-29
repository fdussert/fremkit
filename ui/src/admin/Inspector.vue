<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import WidgetInspector from './WidgetInspector.vue'
import PageInspector from './PageInspector.vue'
import SelectionInspector from './SelectionInspector.vue'
import { useAdminStore } from './store'
import { useI18n } from '../shared/i18n'
import {
  INSPECTOR_MIN, INSPECTOR_STEP, clampInspectorWidth, loadInspectorWidth, saveInspectorWidth,
} from './inspectorWidth'

const s = useAdminStore()
const { t } = useI18n()

const width = ref(clampInspectorWidth(loadInspectorWidth(), window.innerWidth))
function setWidth(next: number, save = true): void {
  width.value = clampInspectorWidth(next, window.innerWidth)
  if (save) saveInspectorWidth(width.value)
}

// Dragged by its left edge: the panel grows as the pointer goes left.
let drag: { x: number; width: number } | null = null
function onDown(e: PointerEvent): void {
  if (e.button !== 0) return
  drag = { x: e.clientX, width: width.value }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onMove(e: PointerEvent): void {
  if (drag) setWidth(drag.width + drag.x - e.clientX, false)
}
function onUp(): void {
  if (!drag) return
  drag = null
  saveInspectorWidth(width.value)
}
function onKey(e: KeyboardEvent): void {
  const step = e.shiftKey ? INSPECTOR_STEP * 5 : INSPECTOR_STEP
  if (e.key === 'ArrowLeft') setWidth(width.value + step)
  else if (e.key === 'ArrowRight') setWidth(width.value - step)
  else if (e.key === 'Home') setWidth(INSPECTOR_MIN)
  else return
  e.preventDefault()
}

// A smaller window takes the room back for the canvas; the saved width waits for a larger one.
function onResize(): void { setWidth(loadInspectorWidth(), false) }
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <aside class="inspector" :style="{ width: `${width}px` }">
    <div class="grip" role="separator" aria-orientation="vertical" tabindex="0"
      :aria-label="t('admin.inspector.resize')" :title="t('admin.inspector.resize.hint')"
      :aria-valuenow="width" :aria-valuemin="INSPECTOR_MIN"
      @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
      @lostpointercapture="onUp" @dblclick="setWidth(INSPECTOR_MIN)" @keydown="onKey" />
    <!-- Several selected: what they share. -->
    <div v-if="s.state.selection.length > 1" class="body">
      <SelectionInspector />
    </div>
    <!-- A widget's inspector keeps its header fixed and scrolls its own sections. -->
    <WidgetInspector v-else-if="s.selected.value" />
    <!-- With no widget selected, the inspector edits the page being shown. -->
    <div v-else class="body">
      <WidgetInspector />
      <PageInspector />
    </div>
  </aside>
</template>

<style scoped>
.inspector { position: relative; flex: 0 0 auto; display: flex; flex-direction: column;
  background: var(--surface); border-left: 1px solid var(--border); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-3); }
/* Wider than the border it sits on, so it is easy to catch; it shows only when reached. */
.grip { position: absolute; z-index: 2; top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize;
  touch-action: none; }
.grip::after { content: ''; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px;
  background: var(--accent); opacity: 0; transition: opacity 0.12s; }
.grip:hover::after, .grip:focus-visible::after, .grip:active::after { opacity: 1; }
.grip:focus-visible { outline: none; }
</style>
