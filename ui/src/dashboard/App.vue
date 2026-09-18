<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { api } from '../shared/api'
import { setLocale, useI18n } from '../shared/i18n'
import { useSocket } from '../shared/socket'
import type { Config, WidgetManifest } from '../shared/types'
import { navHeightOf, navWidgetsOf } from '../shared/types'
import { backgroundStyle } from '../shared/background'
import PageView from './PageView.vue'
import NavBar from './NavBar.vue'
import NavPopover from './NavPopover.vue'
import { useSwipe } from './useSwipe'
import { useNavPopover } from './useNavPopover'

const socket = useSocket()
const { t } = useI18n()
const config = ref<Config | null>(null)
const manifests = ref<Record<string, WidgetManifest>>({})
const pageIndex = ref(0)
const page = computed(() => config.value?.pages[pageIndex.value] ?? null)
const direction = ref<1 | -1>(1)
// PageView paints the same background over the widget area; repeating it on the root covers
// the nav bar strip and any letterboxing, so the screen reads as one surface.
const rootStyle = computed(() => backgroundStyle(config.value?.display.background))
let cycleTimer: number | undefined
let unsub: (() => void) | undefined

function go(delta: number) {
  if (!config.value) return
  const n = config.value.pages.length
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
  const s = config.value?.display.autoCycleSeconds ?? 0
  if (s > 0) cycleTimer = window.setInterval(() => go(1), s * 1000)
}

onMounted(async () => {
  manifests.value = (await api.getWidgets()).widgets
  config.value = await api.getConfig()
  unsub = socket.subscribe('config', async (c) => {
    manifests.value = (await api.getWidgets()).widgets
    config.value = c as Config
    if (pageIndex.value >= (c as Config).pages.length) pageIndex.value = 0
  })
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => { unsub?.(); window.removeEventListener('keydown', onKey); window.clearInterval(cycleTimer) })
watch(() => config.value?.display.autoCycleSeconds, setupCycle)
// The screen follows the language the admin saved, pushed over the same config channel.
watch(() => config.value?.locale, (l) => setLocale(l))
</script>

<template>
  <div class="root" :class="{ kiosk }" :style="rootStyle" v-if="config && page">
    <div v-if="socket.status.value !== 'open'" class="banner">{{ t('dashboard.reconnecting') }}</div>
    <div
      class="stage"
      :style="{ height: config.display.rows * config.display.cell + 'px' }"
      @pointerdown="stageSwipe.down"
      @pointerup="stageSwipe.up"
      @pointercancel="stageSwipe.cancel"
      @wheel="stageSwipe.wheel"
    >
      <Transition :name="direction === 1 ? 'slide-left' : 'slide-right'">
        <PageView :key="page.id" :page="page" :display="config.display" :manifests="manifests" />
      </Transition>
      <div class="edge left" @pointerdown.stop="stageSwipe.down" @pointerup.stop="stageSwipe.up" @pointercancel.stop="stageSwipe.cancel" @wheel.stop="stageSwipe.wheel" />
      <div class="edge right" @pointerdown.stop="stageSwipe.down" @pointerup.stop="stageSwipe.up" @pointercancel.stop="stageSwipe.cancel" @wheel.stop="stageSwipe.wheel" />
    </div>
    <NavBar :pages="config.pages" :active="pageIndex" :height="navHeightOf(config.display)"
      :opacity="config.display.navOpacity" :nav-widgets="navWidgetsOf(config.display)"
      :manifests="manifests" :cell="config.display.cell" :admin-gesture="config.display.adminGesture"
      @select="select" @swipe="go"
      @tap="popover.toggle" @admin="openAdmin" />
    <!-- Drawn by the root, above the stage and the bar, so it is never clipped by either. -->
    <NavPopover v-if="popover.open.value" fixed
      :key="popover.open.value.widget.instanceId"
      :nav-widget="popover.open.value.widget"
      :manifest="manifests[popover.open.value.widget.widgetId]"
      :cell="config.display.cell"
      :anchor="popover.open.value.anchor"
      :screen="popover.open.value.screen"
      @root="popover.setPopoverEl" />
  </div>
</template>

<style scoped>
.root { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
/* Widget iframes carry their own document and keep their own cursor rules; this covers the
   dashboard document only, which is where the pointer actually sits. */
.root.kiosk, .root.kiosk :deep(*) { cursor: none !important; }
/* touch-action: none propagates into widget iframes in Chromium; moot here since the touch driver emits wheel events. */
.stage { position: relative; width: 100%; overflow: hidden; touch-action: none; user-select: none; }
.edge { position: absolute; top: 0; bottom: 0; width: 24px; z-index: 5; touch-action: none; user-select: none; }
.edge.left { left: 0; } .edge.right { right: 0; }
.banner { position: absolute; top: 0; left: 50%; transform: translateX(-50%); padding: 4px 12px; background: #a33; color: #fff; font-size: 14px; border-radius: 0 0 8px 8px; z-index: 10; }
/* Scoped under .stage so these rules outrank `.page { position: relative }` from
   PageView whatever order the two scoped stylesheets are injected in. */
.stage .slide-left-enter-active, .stage .slide-left-leave-active, .stage .slide-right-enter-active, .stage .slide-right-leave-active { transition: transform .2s ease; position: absolute; top: 0; left: 0; width: 100%; }
.stage .slide-left-enter-from { transform: translateX(100%); } .stage .slide-left-leave-to { transform: translateX(-100%); }
.stage .slide-right-enter-from { transform: translateX(-100%); } .stage .slide-right-leave-to { transform: translateX(100%); }
</style>
