<script setup lang="ts">
/**
 * The icon the frame draws before a tile's title. Three renderings, none of which runs anything
 * from the file: a pictogram from the constant table, inline; an imported file *tinted*, used as
 * a CSS mask over `currentColor` so it follows the theme and the accent; or an imported file in
 * its own colours, as a plain `<img>`. An imported SVG is never put in the DOM as markup.
 *
 * What cannot be drawn draws nothing: an unknown pictogram, or a file that failed to load (the
 * mask of a missing image paints nothing by itself; the image is removed on `error`).
 */
import { computed, ref, watch } from 'vue'
import { iconSvg } from './icons'
import { isChoosablePictogram, tileIconUrl } from './tileIcon'
import type { TileIcon } from './types'

const props = defineProps<{ icon: TileIcon }>()

const broken = ref(false)
watch(() => props.icon, () => { broken.value = false })

// The markup comes from the frozen ICONS table, and only for names in TILE_ICONS.
const pictogram = computed(() => (props.icon.kind === 'lucide' && isChoosablePictogram(props.icon.name) ? iconSvg(props.icon.name, 24) : null))
const url = computed(() => (props.icon.kind === 'file' ? tileIconUrl(props.icon.name) : ''))
const tinted = computed(() => props.icon.kind === 'file' && props.icon.tint !== false)
/** A custom property, so the stylesheet writes the prefixed and unprefixed mask from one value. */
const maskStyle = computed(() => ({ '--tile-icon-url': `url("${url.value}")` }))
</script>

<template>
  <span v-if="pictogram" class="tile-icon pictogram" aria-hidden="true" v-html="pictogram" />
  <span v-else-if="tinted" class="tile-icon mask" aria-hidden="true" :style="maskStyle" />
  <img v-else-if="icon.kind === 'file' && !broken" class="tile-icon" :src="url" alt="" aria-hidden="true" @error="broken = true" />
</template>

<style scoped>
.tile-icon { display: inline-block; flex: 0 0 auto; width: 1.3em; height: 1.3em; }
.pictogram :deep(svg) { display: block; width: 100%; height: 100%; }
/* WebKit, which the kiosk runs on, still wants the prefixed properties. */
.mask { background: currentColor;
  -webkit-mask-image: var(--tile-icon-url); mask-image: var(--tile-icon-url);
  -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center; }
img.tile-icon { object-fit: contain; }
</style>
