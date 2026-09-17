<script setup lang="ts">
/** True-to-life preview: the real dashboard page plus nav bar, scaled to fit the column. */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import PageView from '../dashboard/PageView.vue'
import NavBar from '../dashboard/NavBar.vue'
import NavPopover from '../dashboard/NavPopover.vue'
import { useNavPopover } from '../dashboard/useNavPopover'
import { useSwipe } from '../dashboard/useSwipe'
import EditOverlay from './EditOverlay.vue'
import { navHeightOf, navWidgetsOf } from '../shared/types'
import { backgroundStyle } from '../shared/background'
import { useAdminStore } from './store'

const s = useAdminStore()
const host = ref<HTMLElement>()

/**
 * Test mode behaves like the screen: a swipe on the bar or on the board changes page, wrapping
 * at both ends the way the dashboard does. Edit mode keeps the pointer for the overlay.
 */
function go(delta: number): void {
  const n = s.state.config?.pages.length ?? 0
  if (n < 2) return
  s.selectPage((s.state.pageIndex + delta + n) % n)
}
const testing = computed(() => s.state.mode === 'test')
const boardSwipe = useSwipe(go)
const onBoardDown = (e: PointerEvent): void => { if (testing.value) boardSwipe.down(e) }
const onBoardUp = (e: PointerEvent): void => { if (testing.value) boardSwipe.up(e) }
const onBoardCancel = (): void => { if (testing.value) boardSwipe.cancel() }
const onBoardWheel = (e: WheelEvent): void => { if (testing.value) boardSwipe.wheel(e) }
const scale = ref(1)

const display = computed(() => s.state.config!.display)
const boardW = computed(() => display.value.cols * display.value.cell)
const boardH = computed(() => display.value.rows * display.value.cell)
const navH = computed(() => navHeightOf(display.value))
const totalH = computed(() => boardH.value + navH.value)
/**
 * The dashboard repeats its background on the root, behind the nav bar strip; the board does the
 * same, so a translucent bar shows the same thing here as it does on the screen.
 */
const boardStyle = computed(() => ({
  width: boardW.value + 'px', height: totalH.value + 'px',
  transform: `scale(${scale.value})`,
  ...backgroundStyle(display.value.background),
}))

const board = ref<HTMLElement>()
/**
 * The popover is drawn inside the board, so it scales and clips with the preview. The compact
 * frame's on-screen rect is therefore mapped back into the board's own unscaled pixels, where
 * the geometry is the dashboard's exactly.
 */
const popover = useNavPopover({
  project: (rect) => {
    const origin = board.value!.getBoundingClientRect()
    const k = scale.value || 1
    return {
      anchor: { left: (rect.left - origin.left) / k, width: rect.width / k, top: (rect.top - origin.top) / k },
      screen: { width: boardW.value, height: totalH.value },
    }
  },
})
// The preview's own page change, and leaving Test mode, both take the popover with them.
watch(() => s.state.pageIndex, () => popover.close())
watch(() => s.state.mode, () => popover.close())

function measure(): void {
  const el = host.value
  if (!el) return
  scale.value = Math.min(el.clientWidth / boardW.value, el.clientHeight / totalH.value)
}

let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(measure)
  observer.observe(host.value!)
  measure()
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div class="host" ref="host">
    <div class="board" ref="board" :style="boardStyle"
      @pointerdown="onBoardDown" @pointerup="onBoardUp" @pointercancel="onBoardCancel" @wheel="onBoardWheel">
      <PageView v-if="s.page.value" :page="s.page.value" :display="display" :manifests="s.state.manifests" :edit="s.state.mode === 'edit'" />
      <NavBar :pages="s.state.config!.pages" :active="s.state.pageIndex" :height="navH"
        :opacity="display.navOpacity" :nav-widgets="navWidgetsOf(display)" :manifests="s.state.manifests"
        :cell="display.cell" :edit="s.state.mode === 'edit'" @select="s.selectPage"
        @swipe="go" @tap="popover.toggle" />
      <!-- Test mode only: in Edit mode the overlay is inert, so no tap ever reaches here. -->
      <NavPopover v-if="popover.open.value"
        :key="popover.open.value.widget.instanceId"
        :nav-widget="popover.open.value.widget"
        :manifest="s.state.manifests[popover.open.value.widget.widgetId]"
        :cell="display.cell"
        :anchor="popover.open.value.anchor"
        :screen="popover.open.value.screen"
        @root="popover.setPopoverEl" />
      <EditOverlay v-if="s.state.mode === 'edit'" :scale="scale" />
    </div>
  </div>
</template>

<style scoped>
.host { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: var(--space-4); overflow: hidden; }
.board { position: relative; flex: 0 0 auto; transform-origin: center center; background: var(--bg);
  border-radius: var(--radius-md); box-shadow: var(--shadow); overflow: hidden; }
</style>
