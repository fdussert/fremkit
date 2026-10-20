<script setup lang="ts">
/**
 * The page's menu inside the Android app, opened by the bar's admin gesture (a long press or a
 * double tap on the page dots), which a paired device has no other use for: the admin is reached
 * on the Mac only. Its one entry asks the app for its own settings sheet (pin the app, forget the
 * Mac), which the app otherwise shows only while it has no dashboard.
 *
 * It hangs above the bar, centred, and closes on a tap anywhere outside it, after
 * `POPOVER_TIMEOUT_MS` untouched, or once its entry is chosen.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '../shared/i18n'
import { POPOVER_TIMEOUT_MS } from './useNavPopover'

const props = defineProps<{
  /** The bar's height: the menu sits just above it. */
  barHeight: number
}>()
const emit = defineEmits<{ settings: []; close: [] }>()
const { t } = useI18n()
const root = ref<HTMLElement>()
let timer: number | undefined

function onWindowPointerDown(e: PointerEvent): void {
  const target = e.target as Node | null
  if (target && root.value?.contains(target)) return
  emit('close')
}
function choose(): void {
  emit('settings')
  emit('close')
}

onMounted(() => {
  timer = window.setTimeout(() => emit('close'), POPOVER_TIMEOUT_MS)
  // Capture phase, as the bar's popover: it runs before the page's own gestures see the tap.
  window.addEventListener('pointerdown', onWindowPointerDown, true)
})
onUnmounted(() => {
  window.clearTimeout(timer)
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
})
</script>

<template>
  <div ref="root" class="app-menu" role="menu" :style="{ bottom: props.barHeight + 12 + 'px' }">
    <button type="button" role="menuitem" class="entry" @click="choose">{{ t('dashboard.remote.appSettings') }}</button>
  </div>
</template>

<style scoped>
/* Above the stage, the bar and its popover; opaque whatever the bar's opacity. */
.app-menu { position: fixed; left: 50%; transform: translateX(-50%); z-index: 60; padding: 6px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .55); }
/* Meant to be hit while glancing: 56 px high at least. */
.entry { display: block; min-height: 56px; min-width: 220px; padding: 0 24px; border: 0;
  border-radius: var(--radius-sm); background: transparent; color: var(--text); font: inherit;
  font-family: var(--font); font-size: calc(var(--fs-lg) * 1.25); cursor: pointer; }
.entry:active { background: var(--surface-2, rgba(255, 255, 255, .08)); }
.entry:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
</style>
