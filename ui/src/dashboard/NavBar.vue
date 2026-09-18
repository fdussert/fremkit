<script setup lang="ts">
import { ADMIN_REPEAT_MS, cancelsHold, isDoubleTap, startsHold, type Tap } from './longPress'
import { DEFAULT_ADMIN_GESTURE, type AdminGesture } from '../shared/types'
import { computed, onBeforeUnmount, ref } from 'vue'
import { DEFAULT_NAV_HEIGHT, type NavSlot, type NavWidget, type Page, type WidgetManifest } from '../shared/types'
import { fade, surfaceOpacity } from '../shared/background'
import { rgba } from '../shared/color'
import { useSwipe } from './useSwipe'
import CompactWidgetFrame from './CompactWidgetFrame.vue'

/** The bar's own two colours, from the theme; `fade` mixes an opacity into either form. */
const NAV_BG = 'var(--nav-surface)'
const NAV_BORDER = 'var(--nav-outline)'

const props = withDefaults(defineProps<{
  pages: Page[]; active: number; height: number; opacity?: number
  /** Every compact widget of the bar; `slot` splits them between the two clusters. */
  navWidgets?: NavWidget[]
  manifests?: Record<string, WidgetManifest>
  cell?: number
  /** Admin Edit mode: the bar's widgets stay live but inert, since the Screen tab configures them. */
  edit?: boolean
  /** Which gesture on the dots opens the admin. Absent means `both`. */
  adminGesture?: AdminGesture
}>(), { navWidgets: () => [], manifests: () => ({}), cell: 40 })
const emit = defineEmits<{
  select: [index: number]; swipe: [delta: 1 | -1]
  /** A compact widget with `popup` on was tapped; the element is where its popover hangs from. */
  tap: [widget: NavWidget, el: Element]
  /** The dots asked for the admin — a long press, or a double tap. */
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
 * Opening the admin from the bar, on whichever gesture the panel actually delivers.
 *
 * The touch driver never sends a held button. A press held past its threshold becomes a **right
 * click** — `rightMouseDown` and `rightMouseUp` back to back — and a double tap becomes a
 * **double click** with `clickState: 2` (`GestureEngine.endPress`). Neither is a held button, so
 * a timer started on `pointerdown` and cancelled on `pointerup` never completes on the Edge.
 *
 * The timer used to complete by accident: WebKit opened its context menu on the right mouse down
 * and swallowed the matching up while the menu tracked, so it ran on behind the menu. That is
 * why the menu and the admin appeared together — and why removing the menu took the long press
 * with it.
 *
 * `contextmenu` looked like the replacement, and it is the right signal in a browser. In the
 * helper's web view it never arrives: with the native menu emptied and text interaction off,
 * WebKit does not run that pipeline at all. So the *right button itself* is what this listens
 * for — a plain mouse event, dispatched whatever the menu does. The other three paths are kept
 * because each is real somewhere: `contextmenu` for a mouse and for Chrome, the timer for a held
 * left button, `dblclick` for the double tap.
 */
function wantsGesture(kind: 'longPress' | 'doubleTap'): boolean {
  const setting = props.adminGesture ?? DEFAULT_ADMIN_GESTURE
  return setting === 'both' || setting === kind
}

/**
 * Fires the admin once, cancelling anything the same gesture had started.
 *
 * Once *per gesture*, not per event: where two of the four paths are real at the same time they
 * both fire for one press — a right click raises the button event and then `contextmenu`, a
 * double tap is counted here and then reported as `dblclick` — and two admin windows opened for
 * one press. See `ADMIN_REPEAT_MS`.
 */
// Not 0: `performance.now()` counts from the page's own start, so zero would make every gesture
// in the first 700 ms of the dashboard's life look like an echo of one that never happened.
let lastAdminAt = Number.NEGATIVE_INFINITY

function openAdmin(): void {
  endHold()
  suppressClick = true
  const at = performance.now()
  if (at - lastAdminAt < ADMIN_REPEAT_MS) return
  lastAdminAt = at
  emit('admin')
}

/** The driver's long press, as the page really receives it: a right button down. */
function holdRightButton(e: PointerEvent): void {
  if (!wantsGesture('longPress')) return
  e.preventDefault()
  e.stopPropagation()
  openAdmin()
}

/** The same gesture in a browser, where WebKit does raise the event. */
function holdContextMenu(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
  if (!wantsGesture('longPress')) return
  openAdmin()
}

/** The driver's double tap when the browser does synthesise one; see `isDoubleTap`. */
function adminDoubleClick(e: Event): void {
  if (!wantsGesture('doubleTap')) return
  e.preventDefault()
  e.stopPropagation()
  openAdmin()
}

/**
 * The double tap counted here, from the taps themselves.
 *
 * `dblclick` does not arrive on the panel: the driver restores the cursor 0.25 s after a tap
 * while its own double-tap window is 0.3 s, so the pointer warps away and back between the two
 * and WebKit's click counting resets. The taps themselves always arrive.
 */
let lastTap: Tap | null = null

function isSecondTap(e: PointerEvent): boolean {
  const tap: Tap = { at: e.timeStamp, x: e.clientX, y: e.clientY }
  if (isDoubleTap(lastTap, tap)) { lastTap = null; return true }
  lastTap = tap
  return false
}

function holdDown(e: PointerEvent): void {
  // A non-primary button is the driver's long press, handled above — never a hold to start.
  if (e.button === 2) { holdRightButton(e); return }
  if (!startsHold(e.button)) return
  // Before the long-press timer, and whatever the long-press setting says: the two gestures are
  // independent, and a second tap is a decision already made.
  if (wantsGesture('doubleTap') && isSecondTap(e)) { openAdmin(); return }
  if (!wantsGesture('longPress')) return
  holdStart = { x: e.clientX, y: e.clientY }
  holding.value = true
  suppressClick = false
  holdTimer = window.setTimeout(() => {
    holdTimer = undefined
    openAdmin()
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
    s['--nav-bg'] = fade(NAV_BG, alpha)
    s['--nav-border'] = fade(NAV_BORDER, alpha)
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
      @dblclick="adminDoubleClick" @click.capture="dotsClick">
      <button v-for="(p, i) in pages" :key="p.id" class="dot" :class="{ active: i === active }" :aria-label="p.name" @click="$emit('select', i)" />
    </div>
  </nav>
</template>

<style scoped>
nav { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; grid-template-areas: "left dots right";
  align-items: center; box-sizing: border-box; background: var(--nav-bg, var(--nav-surface, #0b0d10)); border-top: 1px solid var(--nav-border, var(--nav-outline, #1f2329));
  touch-action: none; user-select: none; }
/* Each dot's hit area spans the whole bar height and a wide column: a finger on the touch
   strip is far less precise than a pointer, and the visible dot stays small. */
.dots { grid-area: dots; display: flex; gap: 0; align-items: stretch; height: 100%; justify-self: center; }
.dot { width: calc(64px * var(--nav-scale, 1)); height: 100%; padding: 0; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.dot::after { content: ''; width: calc(14px * var(--nav-scale, 1)); height: calc(14px * var(--nav-scale, 1)); border-radius: calc(7px * var(--nav-scale, 1)); background: var(--border-strong, #3a404a); transition: width .2s, background .2s; }
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
