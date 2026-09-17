<script setup lang="ts">
/**
 * The image half of a background: upload, removal, fit and (optionally) the dim overlay.
 * Shared by the screen background and the per-widget one, which differ only in what else
 * sits around them — the screen also carries a colour, the widget also carries a veil.
 *
 * It emits a *patch*, not a whole value: a key set to `undefined` means "drop this one", which
 * is what lets each parent merge it into its own object and keep undo round-tripping cleanly.
 */
import { computed, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseRange from '../shared/ui/BaseRange.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import { api } from '../shared/api'
import { useI18n } from '../shared/i18n'
import { DEFAULT_WIDGET_DIM, MAX_WIDGET_DIM } from '../shared/background'
import type { BackgroundFit } from '../shared/types'

/** Matches MAX_BACKGROUND_BYTES on the server; checked here only to fail fast, with a message. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const { t } = useI18n()
const FITS = computed(() => (['cover', 'contain'] as const).map((value) => ({
  value, label: t(`admin.background.fit.${value}`),
})))

/** Not exported: `<script setup>` allows no exports, and both callers pass a wider object. */
interface BackgroundPickerValue { image?: string; fit?: BackgroundFit; dim?: number }

const props = defineProps<{ modelValue: BackgroundPickerValue; showDim?: boolean }>()
const emit = defineEmits<{ update: [patch: BackgroundPickerValue] }>()

const fileInput = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')

/** The slider works in whole percents; the config stores the 0–0.9 opacity itself. */
const dimPercent = computed(() => Math.round((props.modelValue.dim ?? DEFAULT_WIDGET_DIM) * 100))

/** The base64 payload of a file, without the `data:…;base64,` prefix FileReader adds. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('admin.background.unreadable')))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset the control straight away, so picking the same file twice still fires a change.
  input.value = ''
  if (!file) return
  error.value = ''
  if (file.size > MAX_IMAGE_BYTES) { error.value = t('admin.background.tooLarge'); return }
  busy.value = true
  try {
    const { name } = await api.uploadBackground(file.name, await readBase64(file))
    // A replaced image is deliberately left on disk: undo has to be able to bring it back.
    emit('update', { image: name, fit: props.modelValue.fit ?? 'cover' })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function removeImage(): Promise<void> {
  const name = props.modelValue.image
  if (!name) return
  error.value = ''
  emit('update', { image: undefined, fit: undefined, dim: undefined })
  // Best effort: the config no longer points at it either way, and it may already be gone.
  try { await api.deleteBackground(name) } catch { /* nothing left to do about it */ }
}

function setDim(percent: number): void {
  emit('update', { dim: Math.min(MAX_WIDGET_DIM, Math.max(0, percent / 100)) })
}
</script>

<template>
  <div class="block">
    <span class="lbl">{{ t('admin.background.image') }}</span>
    <p v-if="modelValue.image" class="ro mono">{{ modelValue.image }}</p>
    <p v-else class="ro">{{ t('admin.background.none') }}</p>
    <input ref="fileInput" class="file" type="file" accept="image/png,image/jpeg,image/webp" @change="onFile" />
    <div class="row">
      <BaseButton :disabled="busy" @click="fileInput?.click()">
        <BaseIcon name="plus" :size="16" />{{ t(busy ? 'admin.background.uploading' : 'admin.background.choose') }}
      </BaseButton>
      <BaseButton v-if="modelValue.image" variant="danger" :disabled="busy" @click="removeImage">
        <BaseIcon name="trash-2" :size="16" />{{ t('admin.background.remove') }}
      </BaseButton>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
  </div>

  <BaseField v-if="modelValue.image" :label="t('admin.background.fit')">
    <BaseSegmented :model-value="modelValue.fit ?? 'cover'" :options="FITS"
      @update:model-value="emit('update', { fit: $event as BackgroundFit })" />
  </BaseField>

  <BaseField v-if="showDim && modelValue.image" :label="t('admin.background.dim', { percent: dimPercent })"
    :hint="t('admin.background.dim.hint')">
    <BaseRange :model-value="dimPercent" :max="MAX_WIDGET_DIM * 100" :step="5"
      :aria-label="t('admin.background.dim.aria')" @change="setDim" />
  </BaseField>
</template>

<style scoped>
.ro { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.block { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
/* The styled buttons above drive it; keeping it in the DOM is what lets them open the picker. */
.file { display: none; }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.err { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
