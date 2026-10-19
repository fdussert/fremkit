<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { api } from '../shared/api'
import { setLocale, useI18n } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { Config, NavItem, WidgetManifest } from '../shared/types'
import { navHeightOf, navItemsOf } from '../shared/types'
import { pickScreen } from '../shared/screens'
import { visibleScreen } from '../shared/companionGate'
import { pageBackground, rootBackgroundStyle } from '../shared/background'
import { followThemeSchedule, useConfigTheme } from '../shared/theme'
import PageView from './PageView.vue'
import NavBar from './NavBar.vue'
import NavPopover from './NavPopover.vue'
import { useSwipe } from './useSwipe'
import CompanionPrompt from './CompanionPrompt.vue'
import { createRevealTracker, LANDING_WINDOW_MS, landingPage, type CompanionReveal } from './companionReveal'
import { useNavPopover } from './useNavPopover'
import { isRemotePage, useDeviceScreen, type DeviceInfo } from './remote'
import { useNativeBridge } from './native'
import { SCREEN_ID } from '../shared/useWidgetBridge'
import { onWidgetReload } from '../shared/widgetDev'
import { onScreenReload } from '../shared/screenReload'
import { useThumper, type Side } from './thumper/useThumper'

const socket = useSocket()
const { t } = useI18n()
const config = ref<Config | null>(null)
const manifests = ref<Record<string, WidgetManifest>>({})
/**
 * A paired device loads this page over HTTPS from the Mac's TLS listener. It shows the screen the
 * server assigned to it and nothing else: `?screen=` is ignored, and an unassigned device gets a
 * message rather than the Edge's screen.
 */
const remote = isRemotePage()
const { device, unauthorized } = remote
  ? useDeviceScreen()
  : { device: ref<DeviceInfo | null>(null), unauthorized: ref(false) }
// Inside the iPad app, tell it about revocation, the screen and the brightness target.
if (remote) useNativeBridge(device, unauthorized)
/**
 * The screen this dashboard shows, named by `?screen=<id>`. The kiosk opens `/` with no id and
 * gets the first Edge screen; an id that no longer exists gets it too, never a blank page.
 */
const screenId = new URLSearchParams(location.search).get('screen')
const screen = computed(() => {
  if (!config.value) return null
  if (!remote) return pickScreen(config.value, screenId) ?? null
  // The server can name a just-deleted screen once before it sends null: an id that names no
  // screen of this config is no screen, never the fallback `pickScreen` would give it.
  const id = device.value?.screenId ?? null
  return id && config.value.screens.some((s) => s.id === id) ? pickScreen(config.value, id) : null
})
// Every frame below is told which screen it is on (`Fremkit.screen`).
provide(SCREEN_ID, () => screen.value?.id)
/**
 * The screen as drawn: with `labs.companion` off, without its Fremplay tiles and bar items, nor
 * the pages that held only those (`companionGate.ts`). Page indexes below count these pages.
 */
const shown = computed(() => (config.value && screen.value ? visibleScreen(config.value, screen.value) : null))
const display = computed(() => screen.value?.display ?? null)
const pageIndex = ref(0)
const page = computed(() => shown.value?.pages[pageIndex.value] ?? null)
/**
 * The pages drawn changed (the switch turned, a page went): stay on the page shown, wherever it now
 * sits, or on the same index while there is one.
 */
watch(() => shown.value?.pages.map((p) => p.id) ?? [], (ids, before) => {
  const id = before?.[pageIndex.value]
  const at = id === undefined ? -1 : ids.indexOf(id)
  if (at !== -1) pageIndex.value = at
  else if (pageIndex.value >= ids.length) pageIndex.value = 0
})
// The theme the config names — its night theme at night — repainted whenever the admin saves
// another one or the server says day has turned to night.
useConfigTheme(config)
onUnmounted(followThemeSchedule(socket))
const direction = ref<1 | -1>(1)
/**
 * The background of the page shown — its own, else the screen's — painted behind the stage and
 * the bar alike, on a layer as large as the root. The layer keeps the bar's height as bottom
 * padding; `rootBackgroundStyle` sizes the image against the area above the bar and paints a
 * full-root `cover` under it, which a translucent bar shows.
 *
 * The layer is keyed on what it paints, so a swipe onto a page with another background swaps
 * layers and the two crossfade; pages sharing one keep the same layer and nothing moves.
 */
const background = computed(() => (display.value ? pageBackground(display.value, page.value) : undefined))
const backgroundKey = computed(() => JSON.stringify(background.value ?? null))
const backgroundLayerStyle = computed(() => display.value && {
  ...rootBackgroundStyle(background.value),
  'padding-bottom': navHeightOf(display.value) + 'px',
})
const rootStyle = computed(() => display.value && { 'padding-bottom': navHeightOf(display.value) + 'px' })
/** The grid's own size: the stage's, and the bar's width. */
const gridWidth = computed(() => display.value ? display.value.cols * display.value.cell + 'px' : '0')
let cycleTimer: number | undefined
let unsub: (() => void) | undefined
let unsubCompanion: (() => void) | undefined
/** The browser extension's pairing request, while one is pending (local dashboard only). */
const companionPairing = ref<{ requestId: string; code: string; name: string; extension?: string; expiresAt: number; turnedAway?: number } | null>(null)
const reveal = createRevealTracker()
/**
 * When this page loaded, and whether it has landed on a live share's page yet (`landingPage`):
 * once, within `LANDING_WINDOW_MS` of the load. A reconnect resets neither.
 */
const loadedAt = Date.now()
let landed = false
let offReload: (() => void) | undefined
let offScreenReload: (() => void) | undefined

function go(delta: number) {
  if (!shown.value) return
  const n = shown.value.pages.length
  direction.value = delta >= 0 ? 1 : -1
  pageIndex.value = (pageIndex.value + delta + n) % n
}
function select(i: number) { direction.value = i >= pageIndex.value ? 1 : -1; pageIndex.value = i }

// Swipe (drag or wheel-translated) anywhere on the stage changes the page,
// so it works on empty page areas too, not just the two edge strips guarding
// a zone above widget iframes. One shared gesture instance for stage + edges;
// the edge listeners stop propagation so a gesture starting/ending over an
// edge isn't also processed by the bubbled stage listener.
const stageSwipe = useSwipe(go)
const stageEl = ref<HTMLElement>()
// Whatever this screen shows when the call comes: the tiles of the page and the bar's widgets.
const thumper = useThumper({
  targets: () => [...(stageEl.value?.closest('.root')?.querySelectorAll<HTMLElement>('.stage .frame, nav .compact') ?? [])],
})
function edgeDown(e: PointerEvent, side: Side) { stageSwipe.down(e); thumper.down(e, side) }
function edgeUp(e: PointerEvent) { stageSwipe.up(e); thumper.up(e) }
function edgeCancel() { stageSwipe.cancel(); thumper.cancel() }
function edgeWheel(e: WheelEvent) { stageSwipe.wheel(e); thumper.wheel(e) }
/** The popover a bar widget opens when it is tapped; one at a time, against the viewport. */
const popover = useNavPopover()
// Changing page takes the popover with it: it belongs to the screen being left.
watch(pageIndex, () => popover.close())
// The native helper opens the dashboard with ?kiosk=1; there is no pointer on the Edge panel,
// so the cursor (which the touch driver still moves around) must not be drawn.
const kiosk = new URLSearchParams(location.search).has('kiosk')
/**
 * The way into the admin from the screen: a long press on the page dots. Under the helper the
 * dashboard is a kiosk web view with no tabs and no address bar, so the server asks the helper to
 * open its own admin window; in an ordinary browser a new tab is what the user expects.
 */
async function openAdmin() {
  // A paired device has no admin: it is reached on the Mac only.
  if (remote) return
  if (!kiosk) { window.open('/admin', '_blank'); return }
  try {
    await fetch('/api/helper/admin', { method: 'POST' })
  } catch {
    // The helper is not there or does not know the URL scheme yet; nothing useful to show on a
    // screen with no keyboard, and the status menu still opens the admin.
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') go(1)
  if (e.key === 'ArrowLeft') go(-1)
}
function setupCycle() {
  window.clearInterval(cycleTimer)
  const s = display.value?.autoCycleSeconds ?? 0
  if (s > 0) cycleTimer = window.setInterval(() => go(1), s * 1000)
}

onMounted(async () => {
  try {
    manifests.value = (await api.getWidgets()).widgets
    config.value = await api.getConfig()
  } catch (e) {
    // A revoked device is refused here too; `/api/devices/me` says so, and the socket below still
    // brings the config if the server was only unreachable.
    if (!remote) throw e
  }
  unsub = socket.subscribe('config', async (c) => {
    manifests.value = (await api.getWidgets()).widgets
    config.value = c as Config
  })
  if (!remote) {
    unsubCompanion = socket.subscribe('companion', (data) => {
      const snap = data as { pairing?: typeof companionPairing.value; reveal?: CompanionReveal | null; tab?: { state?: string } }
      companionPairing.value = snap.pairing ?? null
      const revealed = reveal.observe(snap, screen.value?.id)
      // Once per page load, within its first seconds, never on a reconnect: the first snapshot
      // that shows a live share lands on its page. After a server restart the kiosk is back before
      // the extension has resumed its share, so that snapshot is rarely the first one.
      const looking = !landed && Date.now() - loadedAt <= LANDING_WINDOW_MS && config.value && shown.value
      const landing = looking ? landingPage(snap, config.value!, shown.value!) : null
      if (landing !== null) landed = true
      const target = revealed ?? landing
      if (target !== null && target !== pageIndex.value && target < (shown.value?.pages.length ?? 0)) select(target)
    })
    // A reconnect replays a snapshot that must not move the page on its own. And the code on show
    // goes with the socket: a server that restarted no longer has that request, and a program
    // that took the port meanwhile must not get the user to type a code still on the screen.
    watch(socket.status, (s) => {
      if (s === 'open') return
      reveal.reset()
      companionPairing.value = null
    })
  }
  // The admin's "Reload the dashboard", for the screen shown here: the whole page, as the helper's
  // status menu reloads the kiosk, so a page that went wrong comes back without a hand on it.
  offScreenReload = onScreenReload(socket, () => screen.value?.id, () => location.reload())
  window.addEventListener('keydown', onKey)
  // A widget's manifest was saved while it is being written: the frames wait for this catalogue.
  offReload = onWidgetReload(async (reload) => {
    if (reload.manifest) manifests.value = (await api.getWidgets()).widgets
  })
})
// Another screen for the device: start it on its first page, which every screen has.
if (remote) watch(() => screen.value?.id, () => { pageIndex.value = 0; popover.close() })
onUnmounted(() => { unsub?.(); unsubCompanion?.(); offReload?.(); offScreenReload?.(); window.removeEventListener('keydown', onKey); window.clearInterval(cycleTimer) })
watch(() => display.value?.autoCycleSeconds, setupCycle)
/** The manifest of the widget a bar item names, for the popover it opens. */
function manifestOf(item: NavItem): WidgetManifest | undefined {
  const widgetId = config.value?.widgets[item.instanceId]?.widgetId
  return widgetId ? manifests.value[widgetId] : undefined
}
// The screen follows the language the admin saved, pushed over the same config channel.
watch(() => config.value?.locale, (l) => setLocale(l))
</script>

<template>
  <div v-if="remote && unauthorized" class="remote-message" role="status">
    <p class="remote-title">{{ t('dashboard.remote.unauthorized') }}</p>
  </div>
  <div v-else-if="remote && config && !screen && device" class="remote-message" role="status">
    <p class="remote-name">{{ device.name }}</p>
    <p class="remote-title">{{ t('dashboard.remote.noScreen') }}</p>
  </div>
  <div class="root" :class="{ kiosk }" :style="rootStyle" v-else-if="config && screen && shown && display && page">
    <Transition name="bg-fade">
      <div :key="backgroundKey" class="background" :style="backgroundLayerStyle" aria-hidden="true" />
    </Transition>
    <div v-if="socket.status.value !== 'open'" class="banner">{{ t('dashboard.reconnecting') }}</div>
    <div
      ref="stageEl"
      class="stage"
      :style="{ width: gridWidth, height: display.rows * display.cell + 'px' }"
      @pointerdown="stageSwipe.down"
      @pointerup="stageSwipe.up"
      @pointercancel="stageSwipe.cancel"
      @wheel="stageSwipe.wheel"
    >
      <Transition :name="direction === 1 ? 'slide-left' : 'slide-right'">
        <PageView :key="page.id" :page="page" :config="config" :display="display" :manifests="manifests"
          :paint-background="false" />
      </Transition>
      <div class="edge left" @pointerdown.stop="edgeDown($event, 'left')" @pointerup.stop="edgeUp" @pointercancel.stop="edgeCancel" @wheel.stop="edgeWheel" />
      <div class="edge right" @pointerdown.stop="edgeDown($event, 'right')" @pointerup.stop="edgeUp" @pointercancel.stop="edgeCancel" @wheel.stop="edgeWheel" />
    </div>
    <NavBar class="bar" :style="{ width: gridWidth }" :pages="shown.pages" :active="pageIndex" :height="navHeightOf(display)"
      :opacity="display.navOpacity" :nav-items="navItemsOf(shown)" :widgets="config.widgets"
      :manifests="manifests" :cell="display.cell" :admin-gesture="display.adminGesture"
      :nav-style="display.navStyle"
      @select="select" @swipe="go"
      @tap="popover.toggle" @admin="openAdmin" />
    <!-- Drawn by the root, above the stage and the bar, so it is never clipped by either. -->
    <NavPopover v-if="popover.open.value" fixed
      :key="popover.open.value.item.instanceId"
      :item="popover.open.value.item"
      :widgets="config.widgets"
      :manifest="manifestOf(popover.open.value.item)"
      :cell="display.cell"
      :anchor="popover.open.value.anchor"
      :screen="popover.open.value.screen"
      @root="popover.setPopoverEl" />
    <!-- Experimental: only while `labs.companion` is on. The server answers the extension the same
         either way; with the prompt hidden (and the admin's card too) no request can be allowed. -->
    <CompanionPrompt v-if="companionPairing && socket.status.value === 'open' && config?.labs?.companion === true" :pairing="companionPairing" />
  </div>
</template>

<style scoped>
/* The bar's height is bottom padding (see rootStyle), the bar sits in it. */
/* The visible height, not the largest one: an iOS web view that keeps its safe-area insets makes
   100vh taller than what it shows, which would cut the bar pinned to the bottom. 100vh stays as
   the fallback for an engine without dvh. */
.root { position: relative; width: 100vw; height: 100vh; height: 100dvh; overflow: hidden; box-sizing: border-box; isolation: isolate; }
/* Widget iframes carry their own document and keep their own cursor rules; this covers the
   dashboard document only, which is where the pointer actually sits. */
.root.kiosk, .root.kiosk :deep(*) { cursor: none !important; }
/* touch-action: none propagates into widget iframes in Chromium; moot here since the touch driver emits wheel events. */
/* Sized from the screen's grid (cols × cell), drawn 1:1 from the top: on the Edge that is the
   panel's 2560 px, on a device the whole cells its viewport holds, centred in the leftover width.
   Auto margins resolve to 0 when the viewport is narrower, so it then stays on the left. */
.stage { position: relative; overflow: hidden; touch-action: none; user-select: none; margin: 0 auto; }
/* Pinned to the bottom of the viewport, as wide as the stage and centred under it, so its widgets
   and dots line up with the grid the bar's room is counted against. */
.bar { position: absolute; bottom: 0; left: 0; right: 0; margin: 0 auto; }
/* Under everything the root draws (the root isolates, so a negative z-index stays inside it). A
   layer is always opaque — the theme's --bg unless a colour is set — so during a change the new
   one fades in above the old, which stays as it is until it is gone: a real crossfade, never a
   dip to whatever is under both halfway. */
.background { position: absolute; inset: 0; box-sizing: border-box; pointer-events: none; z-index: -2; background-color: var(--bg); }
.bg-fade-enter-active { transition: opacity .3s ease; z-index: -1; }
.bg-fade-leave-active { transition: opacity .3s step-end; }
.bg-fade-enter-from { opacity: 0; }
.bg-fade-leave-to { opacity: 0; }
.edge { position: absolute; top: 0; bottom: 0; width: 24px; z-index: 5; touch-action: none; user-select: none; }
.edge.left { left: 0; } .edge.right { right: 0; }
/* The two messages a paired device can show instead of a screen, in the theme's colours. */
.remote-message {
  width: 100vw; height: 100vh; height: 100dvh; box-sizing: border-box; padding: var(--space-5);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3);
  background: var(--bg); color: var(--text); font-family: var(--font); text-align: center;
}
.remote-message p { margin: 0; max-width: 32em; }
.remote-name { color: var(--accent); font-size: var(--fs-lg); font-weight: 600; }
.remote-title { font-size: calc(var(--fs-lg) * 1.5); line-height: 1.3; }
.banner { position: absolute; top: 0; left: 50%; transform: translateX(-50%); padding: 4px 12px; background: #a33; color: #fff; font-size: 14px; border-radius: 0 0 8px 8px; z-index: 10; }
/* Scoped under .stage so these rules outrank `.page { position: relative }` from
   PageView whatever order the two scoped stylesheets are injected in. */
.stage .slide-left-enter-active, .stage .slide-left-leave-active, .stage .slide-right-enter-active, .stage .slide-right-leave-active { transition: transform .2s ease; position: absolute; top: 0; left: 0; width: 100%; }
.stage .slide-left-enter-from { transform: translateX(100%); } .stage .slide-left-leave-to { transform: translateX(-100%); }
.stage .slide-right-enter-from { transform: translateX(-100%); } .stage .slide-right-leave-to { transform: translateX(100%); }
</style>
