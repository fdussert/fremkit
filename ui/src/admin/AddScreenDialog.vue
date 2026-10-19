<script setup lang="ts">
/**
 * Adds a screen; optionally pre-filled from an existing one. A pre-fill goes through a preview —
 * page count, the widgets left out by name, a small drawing of each page — and nothing is saved
 * before Accept.
 *
 * Without `device` it adds an Edge screen. A device screen is born from a paired device: its size
 * is the one the device reported, shown and not edited, so the screen fits the device exactly.
 */
import { computed, ref } from 'vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import PageView from '../dashboard/PageView.vue'
import { pick, useI18n } from '../shared/i18n'
import { DEVICE_CELL, DEVICE_NAV_HEIGHT, deviceGrid } from '../shared/screens'
import { DEFAULT_NAV_HEIGHT, ROWS_BY_NAV_HEIGHT, type Display, type Screen } from '../shared/types'
import { arrangeInto, type Arrangement } from './arrange'
import { useAdminStore } from './store'

const props = defineProps<{
  /** The paired device the screen is made for; absent, the screen is an Edge screen. */
  device?: { id: string; name: string; viewport: { width: number; height: number } }
}>()
const emit = defineEmits<{ close: []; created: [screenId: string] }>()
const s = useAdminStore()
const { t } = useI18n()

/** The Edge's grid, as `addScreen` builds it. */
const EDGE_GRID = { cols: 64, rows: ROWS_BY_NAV_HEIGHT[DEFAULT_NAV_HEIGHT] }
/** Width of one page drawing in the preview, in CSS px. */
const THUMB_WIDTH = 240

const kind = computed<'edge' | 'device'>(() => (props.device ? 'device' : 'edge'))
const name = ref(props.device?.name ?? '')
const from = ref('')
const step = ref<'form' | 'preview'>('form')

const screens = computed<Screen[]>(() => s.state.config?.screens ?? [])
const source = computed(() => screens.value.find((x) => x.id === from.value) ?? null)

const viewport = computed(() => props.device?.viewport ?? { width: 0, height: 0 })
const grid = computed(() => {
  if (kind.value === 'edge') return EDGE_GRID
  const { width: w, height: h } = viewport.value
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { cols: 0, rows: 0 }
  // The rows `addScreen` will give it, under the slim bar a device screen starts with.
  return deviceGrid(w, h, DEVICE_NAV_HEIGHT)
})
const sizeOk = computed(() => grid.value.cols >= 1 && grid.value.rows >= 1)
const defaultName = computed(() => props.device?.name ?? t('admin.screens.kind.edge'))

const arrangement = computed<Arrangement | null>(() => {
  const cfg = s.state.config
  if (!cfg || !source.value || !sizeOk.value) return null
  return arrangeInto(source.value, {
    ...grid.value, navCols: grid.value.cols,
    ...(kind.value === 'device' ? { navHeight: DEVICE_NAV_HEIGHT } : {}),
  }, cfg.widgets, s.state.manifests)
})

/** How a widget is named to the user: its title, else its manifest's name, else its widget id. */
function nameOf(instanceId: string): string {
  const w = s.state.config?.widgets[instanceId]
  if (!w) return instanceId
  return w.title?.trim() || pick(s.state.manifests[w.widgetId]?.name) || w.widgetId
}
const names = (ids: string[]): string => ids.map(nameOf).join(', ')

/** The pages drawn the way the new screen will show them: its grid, the look it takes from the source. */
const previewDisplay = computed<Display>(() => ({
  ...grid.value, cell: DEVICE_CELL, autoCycleSeconds: 0,
  ...(kind.value === 'device' ? { navHeight: DEVICE_NAV_HEIGHT } : {}),
  ...(source.value?.display.background ? { background: source.value.display.background } : {}),
}))
const thumbScale = computed(() => THUMB_WIDTH / (Math.max(1, grid.value.cols) * DEVICE_CELL))

function orientation(): 'landscape' | 'portrait' {
  return viewport.value.width >= viewport.value.height ? 'landscape' : 'portrait'
}

function submit(): void {
  if (!sizeOk.value) return
  if (source.value) { step.value = 'preview'; return }
  create()
}

function create(): void {
  const a = arrangement.value
  const id = s.addScreen({
    name: name.value.trim() || defaultName.value,
    kind: kind.value,
    ...(kind.value === 'device' ? { viewport: { ...viewport.value }, orientation: orientation() } : {}),
    prefill: source.value && a ? { from: source.value.id, pages: a.pages, nav: a.nav } : null,
  })
  if (!id) return
  emit('created', id)
  emit('close')
}
</script>

<template>
  <BaseModal :title="t('admin.screens.dialog.title')" :width="step === 'preview' ? 640 : 480"
    :close-label="t('common.close')" @close="emit('close')">
    <form v-if="step === 'form'" class="form" @submit.prevent="submit">
      <BaseField :label="t('admin.screens.dialog.name')">
        <BaseInput v-model="name" :placeholder="defaultName" />
      </BaseField>

      <p v-if="kind === 'edge'" class="note"><BaseIcon name="alert-triangle" :size="16" />{{ t('admin.screens.edgeNote') }}</p>

      <template v-else>
        <BaseField :label="t('admin.screens.dialog.size')">
          <p class="ro" data-test="device-size">{{ t('admin.inspector.screen.viewport.value', viewport) }}</p>
        </BaseField>
        <p v-if="sizeOk" class="hint">{{ t('admin.screens.dialog.grid', { ...grid, bar: DEVICE_NAV_HEIGHT }) }}</p>
        <p v-else class="hint bad" role="alert">{{ t('admin.screens.dialog.badSize') }}</p>
      </template>

      <BaseField :label="t('admin.screens.dialog.prefill')">
        <select v-model="from" class="select">
          <option value="">{{ t('admin.screens.dialog.empty') }}</option>
          <option v-for="x in screens" :key="x.id" :value="x.id">{{ x.name }}</option>
        </select>
      </BaseField>

      <div class="actions">
        <BaseButton @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
        <BaseButton variant="primary" :disabled="!sizeOk" @click="submit">
          {{ source ? t('admin.screens.dialog.preview') : t('admin.screens.dialog.add') }}
        </BaseButton>
      </div>
    </form>

    <div v-else-if="arrangement && source" class="preview">
      <p class="summary">{{ t('admin.screens.preview.pages', { count: arrangement.pages.length, ...grid }) }}</p>
      <p class="line">{{ t('admin.screens.preview.look', { name: source.name }) }}</p>
      <p v-if="arrangement.leftOut.length" class="line warn" data-test="left-out">
        <BaseIcon name="alert-triangle" :size="16" />{{ t('admin.screens.preview.leftOut', { names: names(arrangement.leftOut) }) }}
      </p>
      <p v-if="arrangement.navToTiles.length" class="line">
        {{ t('admin.screens.preview.navToTiles', { names: names(arrangement.navToTiles) }) }}
      </p>
      <p v-if="!arrangement.leftOut.length" class="line">{{ t('admin.screens.preview.nothingLeftOut') }}</p>

      <ul class="thumbs">
        <li v-for="p in arrangement.pages" :key="p.id">
          <div class="thumb" :style="{ width: grid.cols * DEVICE_CELL * thumbScale + 'px', height: grid.rows * DEVICE_CELL * thumbScale + 'px' }">
            <div class="scaled" :style="{ width: grid.cols * DEVICE_CELL + 'px', transform: `scale(${thumbScale})` }">
              <PageView :page="p" :config="s.state.config!" :display="previewDisplay" :manifests="s.state.manifests" edit />
            </div>
          </div>
          <span class="caption">{{ p.name }}</span>
        </li>
      </ul>

      <div class="actions">
        <BaseButton @click="step = 'form'">{{ t('admin.screens.preview.back') }}</BaseButton>
        <BaseButton variant="primary" @click="create">{{ t('admin.screens.preview.accept') }}</BaseButton>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
.form, .preview { display: flex; flex-direction: column; }
.select { width: 100%; min-height: 44px; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.ro { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
.note { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-3);
  font-size: var(--fs-sm); color: var(--text-muted); }
.hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text-dim); }
.hint.bad { color: var(--danger); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
.actions :deep(button) { min-height: 44px; }
.summary { margin: 0 0 var(--space-2); font-weight: 600; }
.line { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.line.warn { color: var(--text); }
.thumbs { list-style: none; margin: var(--space-2) 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-3); }
.thumbs li { display: flex; flex-direction: column; gap: var(--space-1); }
.thumb { position: relative; overflow: hidden; pointer-events: none; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-sm); }
.scaled { transform-origin: top left; }
.caption { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
