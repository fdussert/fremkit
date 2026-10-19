<script setup lang="ts">
/**
 * What a library card shows on hover or focus: the widget's preview image, its name, what it
 * does, its default size and what it may read, control and reach.
 *
 * Teleported to the body and placed beside the card, in the viewport, so the sidebar's scrolling
 * column cannot clip it. Purely informative: it takes no pointer events, so it never sits between
 * the cursor and the canvas a card is being dragged to.
 */
import { computed, ref, watch } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import type { WidgetManifest, WidgetPermissionSet } from '../shared/types'

const props = defineProps<{
  manifest: WidgetManifest
  asks?: WidgetPermissionSet
  /** The card's box, in viewport coordinates. */
  anchor: DOMRect
}>()
const { t } = useI18n()

const WIDTH = 360
const MARGIN = 12

/** The image, or none when the manifest names none or it failed to load. */
const failed = ref(false)
watch(() => props.manifest.id, () => { failed.value = false })
const src = computed(() => (props.manifest.preview && !failed.value
  ? `/widgets/${encodeURIComponent(props.manifest.id)}/${props.manifest.preview.split('/').map(encodeURIComponent).join('/')}`
  : null))
/** The picture keeps the tile's proportions, so the box does not jump when the image lands. */
const ratio = computed(() => `${props.manifest.defaultSize[0]} / ${props.manifest.defaultSize[1]}`)

/** Right of the card when there is room, else left of it; vertically kept inside the window. */
const style = computed(() => {
  const a = props.anchor
  const right = a.right + MARGIN
  const left = right + WIDTH <= window.innerWidth - MARGIN ? right : Math.max(MARGIN, a.left - MARGIN - WIDTH)
  const top = Math.min(Math.max(MARGIN, a.top - 8), Math.max(MARGIN, window.innerHeight - MARGIN - 380))
  return { left: `${left}px`, top: `${top}px`, width: `${WIDTH}px` }
})
</script>

<template>
  <Teleport to="body">
    <div class="preview-popover" role="tooltip" :style="style" :data-widget-preview="manifest.id">
      <div class="shot" :style="{ aspectRatio: ratio }">
        <img v-if="src" :src="src" :alt="pick(manifest.name)" @error="failed = true" />
        <div v-else class="none">
          <BaseIcon :name="manifest.icon" :size="28" />
          <span>{{ t('admin.library.preview.none') }}</span>
        </div>
      </div>
      <div class="text">
        <strong>{{ pick(manifest.name) }}</strong>
        <p v-if="pick(manifest.description)">{{ pick(manifest.description) }}</p>
        <small>{{ t('admin.library.preview.size', { w: manifest.defaultSize[0], h: manifest.defaultSize[1] }) }}</small>
        <WidgetPermissions :manifest="manifest" :asks="asks" compact />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-popover { position: fixed; z-index: 1000; pointer-events: none; box-sizing: border-box;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .35); overflow: hidden; }
.shot { width: 100%; max-height: 260px; background: var(--bg); display: flex; align-items: center; justify-content: center; }
.shot img { width: 100%; height: 100%; object-fit: contain; display: block; }
.none { display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  color: var(--text-muted); font-size: var(--fs-xs); }
.text { padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-1); }
.text strong { font-size: var(--fs-sm); }
.text p { margin: 0; font-size: var(--fs-xs); color: var(--text); }
.text small { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
