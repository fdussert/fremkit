<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWidgetBridge } from '../shared/useWidgetBridge'
import { fade, surfaceOpacity, widgetBackgroundStyle, widgetDim } from '../shared/background'
import { isHexColor, onAccent, tileAccent, tileText } from '../shared/color'
import { pick } from '../shared/i18n'
import type { AccentMode, WidgetInstance, WidgetManifest } from '../shared/types'

const props = defineProps<{ instance: WidgetInstance; manifest?: WidgetManifest; cell: number; edit?: boolean }>()
const iframe = ref<HTMLIFrameElement>()
const { state } = useWidgetBridge(iframe, () => props.instance, () => props.manifest, () => props.cell)

const mode = computed<AccentMode>(() => props.instance.accentMode ?? 'none')
/**
 * How opaque the tile's own background is. Everything the tile paints under the widget fades
 * with it — surface, border, title bar and the instance's image — so 0 really is a widget with
 * no background at all, which is what the editor's checkbox promises.
 */
const alpha = computed(() => surfaceOpacity(props.instance.opacity))

const style = computed<Record<string, string>>(() => {
  const inst = props.instance
  const s: Record<string, string> = {
    left: inst.x * props.cell + 'px', top: inst.y * props.cell + 'px',
    width: inst.w * props.cell + 'px', height: inst.h * props.cell + 'px',
  }
  // The accent is what the tile paints with *and* what the widget inherits as --accent, so an
  // instance colour is published even when the accent paints none of the tile itself.
  if (isHexColor(inst.accentColor)) {
    s['--accent'] = inst.accentColor
    s['--on-accent'] = onAccent(inst.accentColor)
  }
  // A custom accent is a literal hex; the theme accent is only a variable to the browser, so it
  // stays written as one and `fade()` mixes it with color-mix instead of rgba().
  const accentCss = isHexColor(inst.accentColor) ? inst.accentColor : 'var(--accent)'
  const a = alpha.value
  const body = mode.value === 'fill' ? accentCss : (isHexColor(inst.bgColor) ? inst.bgColor : 'var(--tile-surface)')
  s['--tile-bg'] = fade(body, a)
  s['--tile-border'] = fade(mode.value === 'none' ? 'var(--tile-outline)' : accentCss, a)
  s['--tile-title-bg'] = fade(accentCss, a)
  // Both text colours are literals: they come from the luminance of a real colour, never a var.
  s['--tile-text'] = isHexColor(inst.bgColor) || mode.value === 'fill'
    ? tileText(mode.value, inst.accentColor, inst.bgColor)
    : 'var(--text)'
  s['--tile-title-text'] = onAccent(tileAccent(inst.accentColor))
  return s
})
/** The instance title wins, else the manifest name, else the raw widget id. */
const title = computed(() => props.instance.title?.trim() || pick(props.manifest?.name) || props.instance.widgetId)

/**
 * The instance's own image, painted in the body only: the title bar keeps the colour the accent
 * mode gives it, so a framed tile still reads as one. Null when no image is configured.
 */
const imageStyle = computed<Record<string, string> | null>(() => {
  const style = widgetBackgroundStyle(props.instance.background)
  return Object.keys(style).length ? { ...style, opacity: String(alpha.value) } : null
})
const dimStyle = computed(() => ({ opacity: String(widgetDim(props.instance.background)) }))
</script>

<template>
  <div class="frame" :style="style">
    <div class="box" :class="[`accent-${mode}`, { edit }]">
      <div v-if="instance.showTitle" class="title">{{ title }}</div>
      <div class="body">
        <div v-if="imageStyle" class="image" :style="imageStyle"><div class="dim" :style="dimStyle" /></div>
        <iframe v-if="manifest" ref="iframe" :src="`/widgets/${instance.widgetId}/index.html`" sandbox="allow-scripts" :title="title" />
        <div v-if="!manifest || state === 'error'" class="missing">{{ title }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame { position: absolute; box-sizing: border-box; padding: 4px; }
/* The --tile-* variables are always set by the frame above, opacity already mixed in. */
.box { width: 100%; height: 100%; box-sizing: border-box; display: flex; flex-direction: column;
  border-radius: var(--radius-md); overflow: hidden;
  background: var(--tile-bg); border: 1px solid var(--tile-border); color: var(--tile-text); }
/* Its own colour is the body's, dimmed, so it reads as a caption on any background. */
.title { flex: 0 0 auto; padding: 12px 18px 2px; font-size: var(--fs-xs); text-transform: uppercase;
  letter-spacing: .08em; color: var(--tile-text); opacity: .7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Framed accent: the title bar is the accent, so its text is the on-accent colour, not the body's. */
.box.accent-frame .title { background: var(--tile-title-bg); color: var(--tile-title-text); opacity: 1; padding: 8px 18px; }
.body { position: relative; flex: 1; min-height: 0; }
/* Behind the (transparent) iframe, so it replaces whatever surface the appearance painted. */
.image { position: absolute; inset: 0; }
.dim { position: absolute; inset: 0; background: #000; }
/* Positioned, so the widget and the fallback keep painting above the absolute image layer. */
iframe { position: relative; z-index: 1; width: 100%; height: 100%; border: 0; background: transparent; display: block; }
.box.edit iframe { pointer-events: none; }
.missing { position: absolute; z-index: 1; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: var(--fs-lg); }
</style>
