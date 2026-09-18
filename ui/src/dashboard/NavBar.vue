<script setup lang="ts">
import { cancelsHold, startsHold } from './longPress'
import { computed, onBeforeUnmount, ref } from 'vue'
import { DEFAULT_NAV_HEIGHT, type NavSlot, type NavWidget, type Page, type WidgetManifest } from '../shared/types'
import { surfaceOpacity } from '../shared/background'
import { rgba } from '../shared/color'
import { useSwipe } from './useSwipe'
import CompactWidgetFrame from './CompactWidgetFrame.vue'

/** The bar's own two colours, kept as hex so an opacity can be mixed into them. */
const NAV_BG = '#0b0d10'
const NAV_BORDER = '#1f2329'

const props = withDefaults(defineProps<{
  pages: Page[]; active: number; height: number; opacity?: number
  /** Every compact widget of the bar; `slot` splits them between the two clusters. */
  navWidgets?: NavWidget[]
  manifests?: Record<string, WidgetManifest>
  cell?: number
  /** Admin Edit mode: the bar's widgets stay live but inert, since the Screen tab configures them. */
  edit?: boolean
}>(), { navWidgets: () => [], manifests: () => ({}), cell: 40 })
const emit = defineEmits<{
  select: [index: number]; swipe: [delta: 1 | -1]
  /** A compact widget with `popup` on was tapped; the element is where its popover hangs from. */
  tap: [widget: NavWidget, el: Element]
  /** The page dots were held down long enough to ask for the admin. */
  admin: []
}>()

/**
 * Long press on the page dots — the way into the admin from the Edge, which is single-touch and
 * has no multi-finger gesture to spare.
 *
 * The bar's swipe handler captures the pointer on pointerdown, so the release is retargeted to
 * the bar and never reaches the dots (nor does a click, which WebKit only fires when down and up
 * land on the same element). The press therefore waits for the release on `window`, exactly as
 * CompactWidgetFrame does, and a finger that travels more than a few pixels is a swipe, not a
 * press.
 */
const HOLD_MS = 1500
const holding = ref(false)
let holdTimer: number | undefined
let holdStart: { x: number; y: number } | null = null
/** Set when a press completed, so the click the same gesture may still produce is not a tap. */
let suppressClick = false

/**
 * The long press as the Edge's touch driver actually delivers it.
 *
 * A press held past the driver's threshold is turned into a **right click** —
 * `rightMouseDown` and `rightMouseUp` back to back (see `GestureEngine.endPress`). The page
 * never sees a held button, so the timer below never completes on the panel: `pointerup` arrives
 * milliseconds after `pointerdown`.
 *
 * It used to work by accident. WebKit opened its context menu on the right mouse down and
 * swallowed the matching up while the menu tracked the mouse, so the timer ran to completion
 * behind it — which is also why the menu and the admin used to appear together. Removing that
 * menu removed the accident.
 *
 * So the `contextmenu` event *is* the signal. The timer stays for a real mouse and for a held
 * left button, which is what the plain-Chrome kiosk path produces.
 */
function holdContextMenu(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  endHold()
  suppressClick = true
  emit('admin')
}

function holdDown(e: PointerEvent): void {
  if (!startsHold(e.button)) return
  holdStart = { x: e.clientX, y: e.clientY }
  holding.value = true
  suppressClick = false
  holdTimer = window.setTimeout(() => {
    holdTimer = undefined
    holding.value = false
    holdStart = null
    suppressClick = true
    emit('admin')
  }, HOLD_MS)
  window.addEventListener('pointermove', holdMove, true)
  window.addEventListener('pointerup', holdUp, { capture: true, once: true })
  window.addEventListener('pointercancel', holdCancel, { capture: true, once: true })
}
function holdMove(e: PointerEvent): void {
  if (!holdStart) return
  if (cancelsHold(holdStart, { x: e.clientX, y: e.clientY })) endHold()
}
function holdUp(): void {
  window.removeEventListener('pointercancel', holdCancel, true)
  endHold()
}
function holdCancel(): void {
  window.removeEventListener('pointerup', holdUp, true)
  suppressClick = false
  endHold()
}
/** Stops the timer and the window listeners; a press that already fired leaves nothing to stop. */
function endHold(): void {
  window.clearTimeout(holdTimer)
  holdTimer = undefined
  holdStart = null
  holding.value = false
  window.removeEventListener('pointermove', holdMove, true)
}
/** A completed press must not also select the dot the finger happened to rest on. */
function dotsClick(e: MouseEvent): void {
  if (!suppressClick) return
  suppressClick = false
  e.stopPropagation()
  e.preventDefault()
}
onBeforeUnmount(() => {
  window.removeEventListener('pointerup', holdUp, true)
  window.removeEventListener('pointercancel', holdCancel, true)
  endHold()
})

const s = useSwipe((delta) => emit('swipe', delta))
/** The widgets of one cluster, in their configured order. */
const cluster = (slot: NavSlot): NavWidget[] => props.navWidgets.filter((w) => w.slot === slot)
/**
 * Everything drawn in the bar is sized against the 80 px design, so a shorter bar shrinks the
 * dots with it. The hit areas keep spanning the whole height either way.
 */
const scale = computed(() => props.height / DEFAULT_NAV_HEIGHT)
/**
 * Only the bar's own background and top border take the opacity: the dots and the compact
 * widgets are drawn on top of it and stay fully legible whatever shows through behind them.
 */
const style = computed<Record<string, string | number>>(() => {
  const alpha = surfaceOpacity(props.opacity)
  const s: Record<string, string | number> = { height: props.height + 'px', '--nav-scale': scale.value }
  if (alpha < 1) {
    s['--nav-bg'] = rgba(NAV_BG, alpha)
    s['--nav-border'] = rgba(NAV_BORDER, alpha)
  }
  return s
})
</script>

<template>
  <nav :style="style" @pointerdown="s.down" @pointerup="s.up" @pointercancel="s.cancel" @wheel="s.wheel">
    <!--
      Three columns, `1fr auto 1fr`: the two clusters take equal share of whatever is left, so
      the dots in the middle stay centred on the bar however wide either cluster grows. Each
      cluster sits above the bar's own swipe listeners; a gesture on the rest of the bar still
      reaches them, and one inside a widget is the widget's own.
    -->
    <div v-for="slot in (['left', 'right'] as const)" :key="slot" class="cluster" :class="slot"
      :style="{ gridArea: slot }">
      <CompactWidgetFrame
        v-for="w in cluster(slot)"
        :key="w.instanceId"
        :nav-widget="w"
        :manifest="manifests[w.widgetId]"
        :cell="cell"
        :height="height"
        :edit="edit"
        @tap="emit('tap', w, $event)"
      />
    </div>
    <div class="dots" :class="{ holding }" @pointerdown="holdDown" @contextmenu="holdContextMenu"
      @click.capture="dotsClick">
      <button v-for="(p, i) in pages" :key="p.id" class="dot" :class="{ active: i === active }" :aria-label="p.name" @click="$emit('select', i)" />
    </div>
  </nav>
</template>

<style scoped>
nav { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; grid-template-areas: "left dots right";
  align-items: center; box-sizing: border-box; background: var(--nav-bg, #0b0d10); border-top: 1px solid var(--nav-border, #1f2329);
  touch-action: none; user-select: none; }
/* Each dot's hit area spans the whole bar height and a wide column: a finger on the touch
   strip is far less precise than a pointer, and the visible dot stays small. */
.dots { grid-area: dots; display: flex; gap: 0; align-items: stretch; height: 100%; justify-self: center; }
.dot { width: calc(64px * var(--nav-scale, 1)); height: 100%; padding: 0; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.dot::after { content: ''; width: calc(14px * var(--nav-scale, 1)); height: calc(14px * var(--nav-scale, 1)); border-radius: calc(7px * var(--nav-scale, 1)); background: #3a404a; transition: width .2s, background .2s; }
.dot.active::after { width: calc(36px * var(--nav-scale, 1)); background: var(--accent); }
/* Held for the admin: the accent swells and breathes, so the finger knows something is counting
   down. Subtle on purpose — this is a shortcut, not a button. */
.dots.holding .dot::after { background: var(--accent); opacity: .5; }
.dots.holding .dot.active::after { opacity: 1; width: calc(44px * var(--nav-scale, 1)); animation: dots-hold 1.2s ease-in-out infinite; }
@keyframes dots-hold { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
/* min-width: 0 keeps a cluster inside its column: it may never grow enough to shove the dots. */
.cluster { display: flex; align-items: stretch; height: 100%; min-width: 0; overflow: hidden;
  gap: calc(12px * var(--nav-scale, 1)); padding: 0 calc(12px * var(--nav-scale, 1)); }
.cluster.left { justify-content: flex-start; }
.cluster.right { justify-content: flex-end; }
</style>
