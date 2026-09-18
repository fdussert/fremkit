<script setup lang="ts">
/**
 * The full rendering of a compact navigation-bar widget, shown above the bar when its tile is
 * touched. It is the same widget with the same settings, in a second iframe, laid out like a
 * tile: an opaque surface, a border and the widget's name as a caption. It is always opaque —
 * it covers whatever is behind it, so it must be readable however translucent the bar is.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useWidgetBridge } from '../shared/useWidgetBridge'
import { pick, useI18n } from '../shared/i18n'
import { popoverRect, type Anchor } from '../shared/popover'
import type { NavWidget, WidgetInstance, WidgetManifest } from '../shared/types'

const props = defineProps<{
  navWidget: NavWidget
  manifest?: WidgetManifest
  cell: number
  anchor: Anchor
  /** The box the popover must stay inside, in the same space as the anchor. */
  screen: { width: number; height: number }
  /**
   * The dashboard draws the popover against the viewport; the admin's preview draws it inside its
   * own scaled board, where `fixed` would escape the scaling.
   */
  fixed?: boolean
}>()
const emit = defineEmits<{ root: [el: Element | null] }>()

/** The caption's height, so the widget is told the size of the body and not of the whole box. */
const TITLE_H = 26

const root = ref<HTMLElement>()
const iframe = ref<HTMLIFrameElement>()

/**
 * A popover is looked at up close and for a moment, so it gets half again the height the widget
 * asks for as a tile: the default tile size is drawn for a wall of tiles, and a four-cell-high
 * strip plus a caption came out cramped.
 */
const POPUP_HEIGHT_SCALE = 1.5

/** The size the widget asks for as a tile, in cells, stretched for the popover, plus the caption. */
const size = computed(() => {
  const [w, h] = props.manifest?.defaultSize ?? [8, 4]
  return { width: w * props.cell, height: Math.round(h * props.cell * POPUP_HEIGHT_SCALE) + TITLE_H }
})
const box = computed(() => popoverRect(props.anchor, size.value, props.screen))
const style = computed<Record<string, string>>(() => ({
  position: props.fixed ? 'fixed' : 'absolute',
  left: box.value.left + 'px', top: box.value.top + 'px',
  width: box.value.width + 'px', height: box.value.height + 'px',
}))

/**
 * The same widget as the bar draws, as a tile: full size, with its title, and no appearance of
 * its own.
 *
 * The instanceId is the bar entry's, unchanged. It used to carry a `:popup` suffix so the two
 * iframes of one bar widget stayed distinguishable — but nothing ever keyed on that, and it
 * became a real bug once commands started resolving their target from the saved dashboard: the
 * server looks the id up in the config, the suffixed one is in no config, and every
 * `service-status.probe` from the popover was refused as an unknown widget.
 */
const instance = computed<WidgetInstance>(() => ({
  instanceId: props.navWidget.instanceId,
  widgetId: props.navWidget.widgetId,
  x: 0, y: 0,
  w: Math.max(1, Math.round(box.value.width / props.cell)),
  h: Math.max(1, Math.round((box.value.height - TITLE_H) / props.cell)),
  showTitle: true,
  settings: props.navWidget.settings,
}))

const { state } = useWidgetBridge(iframe, () => instance.value, () => props.manifest, () => props.cell, {
  // The box is clamped to the screen, so the widget is told the pixels it really has.
  pixelSize: () => ({ width: box.value.width, height: box.value.height - TITLE_H }),
})
const { t } = useI18n()
const title = computed(() => pick(props.manifest?.name) || props.navWidget.widgetId)

onMounted(() => emit('root', root.value ?? null))
onUnmounted(() => emit('root', null))
</script>

<template>
  <div ref="root" class="popover" :style="style">
    <div class="title">{{ title }}</div>
    <div class="body">
      <iframe v-if="manifest" ref="iframe" :src="`/widgets/${navWidget.widgetId}/index.html`" sandbox="allow-scripts" :title="title" />
      <!-- One line of room here, so the words take the place of the id rather than joining it. -->
      <div v-if="!manifest || state === 'error'" class="missing">{{ manifest ? title : t('dashboard.widget.notInstalled') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Above every tile, every edge strip and the bar itself: it is the one thing being looked at. */
.popover { z-index: 50; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); opacity: 1; border: 1px solid var(--border); border-radius: var(--radius-md);
  color: var(--text); box-shadow: 0 8px 32px rgba(0, 0, 0, .55); }
.title { flex: 0 0 auto; padding: 8px 14px 2px; font-size: var(--fs-xs); text-transform: uppercase;
  letter-spacing: .08em; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.body { position: relative; flex: 1; min-height: 0; }
iframe { width: 100%; height: 100%; border: 0; background: transparent; display: block; }
.missing { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: var(--fs-lg); }
</style>
