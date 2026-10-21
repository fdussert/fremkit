<script setup lang="ts">
import { ADMIN_REPEAT_MS, DOUBLE_TAP_MS, cancelsHold, isDoubleTap, startsHold, type Tap } from './longPress'
import { DEFAULT_ADMIN_GESTURE, DEFAULT_NAV_STYLE, DEFAULT_NAV_HEIGHT, NAV_CENTRE_RESERVE_CELLS,
  type AdminGesture, type Config, type NavItem, type NavStyle, type NavSlot, type Page, type WidgetManifest } from '../shared/types'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fade, surfaceOpacity } from '../shared/background'
import { useSwipe } from './useSwipe'
import { useI18n } from '../shared/i18n'
import CompactWidgetFrame from './CompactWidgetFrame.vue'

/** The bar's own two colours, from the theme; `fade` mixes an opacity into either form. */
const NAV_BG = 'var(--nav-surface)'
const NAV_BORDER = 'var(--nav-outline)'

const props = withDefaults(defineProps<{
  pages: Page[]; active: number; height: number; opacity?: number
  /** The bar items of the screen shown; `slot` splits them between the two clusters. */
  navItems?: NavItem[]
  /** The config's shared widgets, where each item's widget and settings are read. */
  widgets?: Config['widgets']
  manifests?: Record<string, WidgetManifest>
  cell?: number
  /** Admin Edit mode: the bar's widgets stay live but inert, since the Screen tab configures them. */
  edit?: boolean
  /** Which gesture on the page buttons opens the admin. Absent means `both`. */
  adminGesture?: AdminGesture
  /** The default preserves the existing compact page dots. */
  navStyle?: NavStyle
  /** Bar items whose experimental feature is off, drawn greyed (the admin's canvas). */
  off?: ReadonlySet<string>
}>(), { navItems: () => [], widgets: () => ({}), manifests: () => ({}), cell: 40, off: () => new Set<string>() })
const emit = defineEmits<{
  select: [index: number]; swipe: [delta: 1 | -1]
  /** A compact widget with `popup` on was tapped; the element is where its popover hangs from. */
  tap: [item: NavItem, el: Element]
  /** The page buttons asked for the admin — a long press, or a double tap. */
  admin: []
  /** The editor's preview only: a right click on a bar widget, for its menu. */
  itemMenu: [item: NavItem, event: MouseEvent]
  /** The editor's preview only: a right click on a page button (its index) or on the bar itself (null). */
  barMenu: [page: number | null, event: MouseEvent]
}>()

/**
 * Long press on a page button — the way into the admin from the Edge, which is single-touch and
 * has no multi-finger gesture to spare.
 *
 * The bar's swipe handler captures the pointer on pointerdown, so the release is retargeted to
 * the bar and never reaches the page button (nor does a click, which WebKit only fires when down and up
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
  cancelPagePress()
  s.cancel()
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
  // In the editor a right click is a menu, handled by the bar (`onItemMenu`), not the admin gesture.
  if (props.edit) return
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
  if (wantsGesture('doubleTap') && isSecondTap(e)) {
    e.preventDefault()
    e.stopPropagation()
    openAdmin()
    return
  }
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
/** Page releases follow pointer capture to window, rather than relying on a browser click. */
let pagePress: { id: string; x: number; y: number } | null = null
let selectionTimer: number | undefined
function clearSelection(): void {
  window.clearTimeout(selectionTimer)
  selectionTimer = undefined
}
function pageDown(e: PointerEvent, index: number): void {
  if (!startsHold(e.button)) return
  clearSelection()
  suppressClick = false
  const page = props.pages[index]
  if (!page) return
  pagePress = { id: page.id, x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', pageMove, true)
  window.addEventListener('pointerup', pageUp, true)
  window.addEventListener('pointercancel', cancelPagePress, true)
}
function pageMove(e: PointerEvent): void {
  if (pagePress && cancelsHold(pagePress, { x: e.clientX, y: e.clientY })) cancelPagePress()
}
function pageUp(e: PointerEvent): void {
  const press = pagePress
  cancelPagePress(false)
  if (!press || suppressClick || cancelsHold(press, { x: e.clientX, y: e.clientY })) return
  if (wantsGesture('doubleTap')) {
    clearSelection()
    selectionTimer = window.setTimeout(() => {
      selectionTimer = undefined
      const index = props.pages.findIndex(page => page.id === press.id)
      if (index >= 0) emit('select', index)
    }, DOUBLE_TAP_MS)
  } else {
    const index = props.pages.findIndex(page => page.id === press.id)
    if (index >= 0) emit('select', index)
  }
}
function cancelPagePress(clearPending: boolean | Event = true): void {
  pagePress = null
  window.removeEventListener('pointermove', pageMove, true)
  window.removeEventListener('pointerup', pageUp, true)
  window.removeEventListener('pointercancel', cancelPagePress, true)
  if (clearPending !== false) { clearSelection(); lastTap = null }
}
/** Pointer selection is handled above. Keyboard and assistive activation stay immediate. */
function pageClick(e: MouseEvent, index: number): void {
  if (e.detail !== 0) { e.preventDefault(); return }
  clearSelection()
  emit('select', index)
}
onBeforeUnmount(() => {
  cancelPagePress()
  window.removeEventListener('pointerup', holdUp, true)
  window.removeEventListener('pointercancel', holdCancel, true)
  endHold()
})

const s = useSwipe((delta) => {
  cancelPagePress()
  emit('swipe', delta)
})
function cancelNavigation(): void {
  cancelPagePress()
  s.cancel()
}
const { t } = useI18n()
const names = ref<HTMLElement>()
const namesOverflow = ref(false)
const canShowPrevious = ref(false)
const canShowNext = ref(false)
const targetHeight = computed(() => Math.min(56, props.height - 1) + 'px')
let namesObserver: ResizeObserver | undefined
function measureNames(): void {
  const el = names.value
  if (!el) return
  if (props.pages.length <= 1) {
    namesOverflow.value = false
    canShowPrevious.value = false
    canShowNext.value = false
    return
  }
  namesOverflow.value = el.scrollWidth > el.clientWidth + 1
  canShowPrevious.value = el.scrollLeft > 1
  canShowNext.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}
function scrollNames(direction: -1 | 1): void {
  const el = names.value
  if (!el) return
  cancelNavigation()
  const edge = direction === 1 ? el.scrollLeft + el.clientWidth : Math.max(0, el.scrollLeft - el.clientWidth)
  const buttons = [...el.children] as HTMLElement[]
  const target = direction === 1
    ? buttons.find(button => button.offsetLeft - el.offsetLeft + button.offsetWidth > edge + 1)
    : buttons.find(button => button.offsetLeft - el.offsetLeft >= edge - 1)
  if (target) {
    const left = target.offsetLeft - el.offsetLeft
    el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, left))
  }
  measureNames()
}
function revealActivePage(): void {
  const el = names.value
  const button = el?.children[props.active] as HTMLElement | undefined
  if (!el || !button) return
  const left = button.offsetLeft - el.offsetLeft
  const right = left + button.offsetWidth
  if (left < el.scrollLeft) el.scrollLeft = left
  else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  measureNames()
}
onMounted(() => {
  measureNames()
  revealActivePage()
  if (typeof ResizeObserver !== 'undefined') {
    namesObserver = new ResizeObserver(measureNames)
    if (names.value) namesObserver.observe(names.value)
  }
  window.addEventListener('resize', measureNames)
})
watch(() => [props.pages.length, props.height, props.navStyle, props.active], async () => { await nextTick(); revealActivePage() })
onBeforeUnmount(() => {
  namesObserver?.disconnect()
  window.removeEventListener('resize', measureNames)
})
/** The items of one cluster, in their configured order. */
/**
 * The editor's right click on a bar widget. Listened for on the bar itself and found by position:
 * the swipe handler has captured the pointer by then, so the event is aimed at the bar, not at the
 * widget under the pointer. Only in the editor's Edit mode; the screen keeps its own gestures.
 */
function onItemMenu(e: MouseEvent): void {
  if (!props.edit) return
  // The editor's own menu, never the browser's, wherever on the bar the click lands.
  e.preventDefault()
  const under = document.elementFromPoint(e.clientX, e.clientY)
  const el = under?.closest('[data-nav-instance]')
  const item = props.navItems.find((x) => x.instanceId === el?.getAttribute('data-nav-instance'))
  if (item) return emit('itemMenu', item, e)
  const page = under?.closest('[data-nav-page]')?.getAttribute('data-nav-page')
  emit('barMenu', page == null ? null : Number(page), e)
}

const cluster = (slot: NavSlot): NavItem[] => props.navItems.filter((item) => item.slot === slot)
/** The manifest of the widget an item names; none for a widget gone from the config or the disk. */
const manifestOf = (item: NavItem): WidgetManifest | undefined => {
  const widgetId = props.widgets[item.instanceId]?.widgetId
  return widgetId ? props.manifests[widgetId] : undefined
}
/**
 * Everything drawn in the bar is sized against the 80 px design, so a shorter bar shrinks the
 * labels with it. The hit areas keep spanning the whole height either way.
 */
const scale = computed(() => props.height / DEFAULT_NAV_HEIGHT)
/** A dot's hit column at the 80 px design, scaled with the bar. */
const DOT_MAX = 64
/** The touch minimum, in real CSS px: the column never goes under it, whatever the bar's scale. */
const DOT_MIN = 44
/**
 * Each dot's hit column, in CSS px, already scaled. The dots share the cells the bar-room rule
 * keeps free for them, so many pages narrow their columns instead of running over the clusters.
 * The 44 px touch minimum wins over both the scale and the share: on a slim bar the columns stay
 * 44 px, and past about nine pages on a 40 px cell they spill beyond the reserve.
 */
const dotWidth = computed(() => {
  const reserve = NAV_CENTRE_RESERVE_CELLS * props.cell
  return Math.max(DOT_MIN, Math.min(DOT_MAX * scale.value, reserve / Math.max(1, props.pages.length)))
})
/**
 * Only the bar's own background and top border take the opacity: the page indicators and the compact
 * widgets are drawn on top of it and stay fully legible whatever shows through behind them.
 */
const style = computed<Record<string, string | number>>(() => {
  const alpha = surfaceOpacity(props.opacity)
  const s: Record<string, string | number> = {
    height: props.height + 'px', '--nav-scale': scale.value, '--dot-width': dotWidth.value + 'px',
    '--nav-cell': props.cell + 'px', '--page-count': props.pages.length,
  }
  if (alpha < 1) {
    s['--nav-bg'] = fade(NAV_BG, alpha)
    s['--nav-border'] = fade(NAV_BORDER, alpha)
  }
  return s
})
</script>

<template>
  <nav :style="style" :class="{ named: (navStyle ?? DEFAULT_NAV_STYLE) === 'names' }" @contextmenu="onItemMenu"
    @pointerdown="s.down" @pointerup="s.up" @pointercancel="cancelNavigation" @wheel="s.wheel">
    <!--
      Equal outside columns keep page navigation centred. Named pages also reserve each cluster's
      natural width before the centre takes the remaining space. Each
      cluster sits above the bar's own swipe listeners; a gesture on the rest of the bar still
      reaches them, and one inside a widget is the widget's own.
    -->
    <div v-for="slot in (['left', 'right'] as const)" :key="slot" class="cluster" :class="slot"
      :style="{ gridArea: slot }">
      <CompactWidgetFrame
        v-for="item in cluster(slot)"
        :key="item.instanceId"
        :item="item"
        :widgets="widgets"
        :manifest="manifestOf(item)"
        :cell="cell"
        :height="height"
        :edit="edit"
        :off="off.has(item.instanceId)"
        :data-nav-instance="item.instanceId"
        @tap="emit('tap', item, $event)"
      />
    </div>
    <div class="page-navigation">
      <button v-if="namesOverflow" type="button" class="names-scroll previous-names"
        :style="{ minHeight: targetHeight }" :disabled="!canShowPrevious"
        :aria-label="t('dashboard.navigation.previousNames')" :title="t('dashboard.navigation.previousNames')"
        @pointerdown.stop="cancelNavigation" @pointerup.stop @pointercancel.stop="cancelNavigation"
        @wheel.stop @dblclick.stop @contextmenu.prevent.stop @click.stop="scrollNames(-1)">‹</button>
      <div ref="names" class="page-list" :class="{ holding }" @scroll="measureNames"
        @pointerdown="holdDown" @contextmenu="holdContextMenu" @dblclick="adminDoubleClick">
        <button v-for="(p, i) in pages" :key="p.id" type="button" class="page-button" :class="{ active: i === active }" :data-nav-page="i"
          :style="{ minHeight: targetHeight }" :aria-label="p.name"
          :aria-current="i === active ? 'page' : undefined" :title="p.name"
          @pointerdown="pageDown($event, i)" @click="pageClick($event, i)">
          <span class="page-name">{{ (navStyle ?? DEFAULT_NAV_STYLE) === 'names' ? p.name : '' }}</span>
        </button>
      </div>
      <button v-if="namesOverflow" type="button" class="names-scroll next-names"
        :style="{ minHeight: targetHeight }" :disabled="!canShowNext"
        :aria-label="t('dashboard.navigation.nextNames')" :title="t('dashboard.navigation.nextNames')"
        @pointerdown.stop="cancelNavigation" @pointerup.stop @pointercancel.stop="cancelNavigation"
        @wheel.stop @dblclick.stop @contextmenu.prevent.stop @click.stop="scrollNames(1)">›</button>
    </div>
  </nav>
</template>

<style scoped>
nav { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); grid-template-areas: "left pages right";
  align-items: center; box-sizing: border-box; background: var(--nav-bg, var(--nav-surface, #0b0d10)); border-top: 1px solid var(--nav-border, var(--nav-outline, #1f2329));
  touch-action: none; user-select: none; }
nav.named { grid-template-columns: minmax(max-content, 1fr) fit-content(calc(1200px * var(--nav-scale, 1))) minmax(max-content, 1fr); }
/* Dots take their columns' width (see dotWidth); named pages use a larger, bounded centre. */
.page-navigation { grid-area: pages; display: flex; height: 100%; width: min(100%, calc(var(--page-count) * var(--dot-width, 64px)));
  min-width: 0; justify-self: center; }
.named .page-navigation { width: min(100%, calc(10 * 120px * var(--nav-scale, 1))); }
.page-list { display: flex; min-width: 0; gap: 0; align-items: stretch;
  height: 100%; overflow-x: hidden; scroll-snap-type: x mandatory; }
/* Each dot's hit area spans the whole bar height and a column as wide as the dots' share of the
   bar allows, never under the 44 px touch minimum (see dotWidth): a finger on the touch strip is
   far less precise than a pointer. Only the visible dot (::after) scales with the bar. */
.page-button { flex: 0 0 auto; width: var(--dot-width, 64px);
  height: 100%; padding: 0; border: 0; display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--text, #e8edf3); font: inherit;
  font-size: calc(var(--fs-lg, 16px) * 1.125 * var(--nav-scale, 1)); cursor: pointer; box-sizing: border-box;
  scroll-snap-align: start; }
.page-button::after { content: ''; display: block; width: calc(14px * var(--nav-scale, 1));
  height: calc(14px * var(--nav-scale, 1)); border-radius: calc(7px * var(--nav-scale, 1));
  background: var(--border-strong, #3a404a); transition: width .2s, background .2s; }
.page-button.active::after { width: calc(36px * var(--nav-scale, 1)); background: var(--accent); }
.named .page-list { gap: calc(8px * var(--nav-scale, 1)); }
.named .page-button { width: calc(120px * var(--nav-scale, 1)); min-width: 56px;
  padding: 0 12px; border-bottom: 4px solid transparent; }
.named .page-button::after { display: none; }
.page-name { display: block; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.named .page-button.active { border-bottom-color: var(--accent); font-weight: 700; background: var(--surface-2, transparent); }
.names-scroll { flex: 0 0 56px; width: 56px; height: 100%; padding: 0; border: 0; background: transparent;
  color: var(--text); font: inherit; font-size: calc(var(--fs-lg, 16px) * 1.5); cursor: pointer; }
.names-scroll:disabled { opacity: .35; cursor: default; }
.page-button:focus-visible, .names-scroll:focus-visible { outline: 3px solid var(--accent); outline-offset: -6px; }
.page-list.holding .page-button::after { background: var(--accent); opacity: .5; }
.page-list.holding .page-button.active::after { opacity: 1; width: calc(44px * var(--nav-scale, 1)); animation: dots-hold 1.2s ease-in-out infinite; }
.named .page-list.holding .page-button.active { animation: dots-hold 1.2s ease-in-out infinite; }
@keyframes dots-hold { 0%, 100% { opacity: 1; } 50% { opacity: .65; } }
/* Constrain the iframe's intrinsic height so it cannot make the 80px row taller. */
.cluster { display: flex; align-items: stretch; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
  gap: calc(12px * var(--nav-scale, 1)); padding: 0 calc(12px * var(--nav-scale, 1)); }
.named .cluster { min-width: max-content; }
.cluster.left { justify-content: flex-start; }
.cluster.right { justify-content: flex-end; }
</style>
