<script setup lang="ts">
/**
 * One widget drawn inside the navigation bar: an iframe as many cells wide as `compactWidth()`
 * allots and as tall as the bar, on the same bridge as a tile. The bar is the surface, so this
 * frame paints nothing of its own and draws no title.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useWidgetBridge } from '../shared/useWidgetBridge'
import { pick } from '../shared/i18n'
import { compactWidth, mergeSettings, type NavWidget, type WidgetInstance, type WidgetManifest } from '../shared/types'

const props = defineProps<{ navWidget: NavWidget; manifest?: WidgetManifest; cell: number; height: number; edit?: boolean }>()
const emit = defineEmits<{ tap: [el: Element] }>()
const iframe = ref<HTMLIFrameElement>()
const root = ref<HTMLElement>()

/**
 * A bar widget whose popover is on is covered by a transparent overlay: the compact rendering
 * lives in a sandboxed iframe, which would swallow the touch, so the tap has to be caught above
 * it. Without a popover there is no overlay at all and the touch reaches the widget, as before.
 * The admin's Edit mode configures the bar in the Screen tab, so nothing there is tappable.
 */
const tappable = computed(() => props.navWidget.popup === true && !props.edit)
const pressed = ref(false)
/** How far a finger may travel and still count as a tap rather than a swipe across the bar. */
const TAP_SLOP = 10
let start: { x: number; y: number } | null = null

/**
 * The bar's swipe handler captures the pointer on pointerdown, so the matching pointerup is
 * retargeted to the bar and never reaches this overlay — and the browser's click, which needs
 * down and up on the same element, never fires either (WebKit, which the kiosk runs on, is
 * strict about it). The overlay therefore only notes where the finger landed and waits for the
 * release on the window, where a captured pointerup still bubbles.
 */
function down(e: PointerEvent): void {
  start = { x: e.clientX, y: e.clientY }
  pressed.value = true
  window.addEventListener('pointerup', release, { capture: true, once: true })
  window.addEventListener('pointercancel', cancel, { capture: true, once: true })
}
function release(e: PointerEvent): void {
  window.removeEventListener('pointercancel', cancel, true)
  const moved = !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP
  start = null
  pressed.value = false
  if (!moved && root.value) emit('tap', root.value)
}
function cancel(): void {
  // A cancelled gesture is a scroll or a swipe the browser took over: never a tap.
  window.removeEventListener('pointerup', release, true)
  start = null
  pressed.value = false
}
onBeforeUnmount(cancel)

/** The settings decide the width, so they are read through the manifest's defaults, as the widget sees them. */
const cells = computed(() => compactWidth(props.manifest, mergeSettings(props.manifest, props.navWidget.settings)))
const width = computed(() => cells.value * props.cell)

/**
 * The bridge speaks in tiles, so the bar entry is presented as one: no title, no surface and no
 * accent of its own (the bar paints the surface, and a bar widget carries neither a background
 * colour nor an accent mode), and a size the bridge takes from `pixelSize` rather than from the
 * grid, since the bar's height is not a whole number of cells.
 */
const instance = computed<WidgetInstance>(() => ({
  instanceId: props.navWidget.instanceId,
  widgetId: props.navWidget.widgetId,
  x: 0, y: 0, w: cells.value, h: 1,
  showTitle: false,
  settings: props.navWidget.settings,
}))

const { state } = useWidgetBridge(iframe, () => instance.value, () => props.manifest, () => props.cell, {
  compact: () => true,
  pixelSize: () => ({ width: width.value, height: props.height }),
  slot: () => props.navWidget.slot,
})
const title = computed(() => pick(props.manifest?.name) || props.navWidget.widgetId)
</script>

<template>
  <div ref="root" class="compact" :class="{ edit }" :style="{ width: width + 'px' }">
    <iframe v-if="manifest" ref="iframe" :src="`/widgets/${navWidget.widgetId}/index.html`" sandbox="allow-scripts" :title="title" />
    <div v-if="!manifest || state === 'error'" class="missing">{{ title }}</div>
    <!-- Pointer events still bubble to the bar, so a swipe starting here keeps changing page. -->
    <div v-if="tappable" class="tap" :class="{ pressed }" @pointerdown="down" />
  </div>
</template>

<style scoped>
.compact { position: relative; flex: 0 0 auto; height: 100%; }
/* Touch inside a compact widget must reach it, so pointer events stay on — except in the
   admin's Edit mode, where the bar's widgets are configured in the Screen tab, not here. */
iframe { width: 100%; height: 100%; border: 0; background: transparent; display: block; }
.compact.edit iframe { pointer-events: none; }
/* Transparent until it is held: the bar keeps its look, and a finger still gets an answer. */
.tap { position: absolute; inset: 0; z-index: 2; pointer-events: auto; cursor: pointer;
  border-radius: var(--radius-sm, 6px); background: transparent; transition: background .1s; }
.tap.pressed { background: rgba(255, 255, 255, .1); }
.missing { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #5f6771; font-size: calc(13px * var(--nav-scale, 1)); white-space: nowrap; overflow: hidden; }
</style>
