<script setup lang="ts">
/**
 * Picks an icon from the user's library for an `icon` item field, or imports one into it: the
 * same library the tiles' title icons come from (`TileIconPicker`, which also deletes them).
 * A pick is `file:<name>`; "None" empties the field. The widget draws it with
 * `Fremkit.libraryIcon`, so an SVG here only ever reaches an `<img>`.
 */
import { onMounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import TileIcon from '../shared/TileIcon.vue'
import { api } from '../shared/api'
import { readBase64 } from '../shared/files'
import { useI18n } from '../shared/i18n'
import { LIBRARY_ICON_PREFIX } from '../shared/widgetMessages'

/** Matches MAX_TILE_ICON_BYTES on the server; checked here only to fail fast, with a message. */
const MAX_ICON_BYTES = 256 * 1024

const props = defineProps<{ value: string }>()
const emit = defineEmits<{ pick: [value: string] }>()
const { t } = useI18n()

const files = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()

const picked = (name: string): boolean => props.value.trim() === LIBRARY_ICON_PREFIX + name

onMounted(async () => {
  try {
    files.value = (await api.listTileIcons()).names
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset straight away, so picking the same file twice still fires a change.
  input.value = ''
  if (!file) return
  error.value = ''
  if (file.size > MAX_ICON_BYTES) { error.value = t('admin.tileIcon.tooLarge'); return }
  busy.value = true
  try {
    const { name } = await api.uploadTileIcon(file.name, await readBase64(file, t('admin.tileIcon.unreadable')))
    files.value = [...new Set([...files.value, name])].sort()
    emit('pick', LIBRARY_ICON_PREFIX + name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="library" data-icon-library>
    <div class="grid">
      <button type="button" class="cell" :class="{ on: !value.trim() }" :title="t('admin.tileIcon.none')" @click="emit('pick', '')">
        <BaseIcon name="x" :size="18" />
      </button>
      <!-- Shown in their own colours: the widget draws the file as it is. -->
      <button v-for="name in files" :key="name" type="button" class="cell" :class="{ on: picked(name) }" :title="name"
        @click="emit('pick', LIBRARY_ICON_PREFIX + name)">
        <TileIcon class="thumb" :icon="{ kind: 'file', name, tint: false }" />
      </button>
    </div>
    <input ref="fileInput" class="input" type="file" accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml" @change="onFile" />
    <BaseButton class="import" :disabled="busy" @click="fileInput?.click()">
      <BaseIcon name="upload" :size="14" />{{ t(busy ? 'admin.tileIcon.importing' : 'admin.tileIcon.import') }}
    </BaseButton>
    <p class="hint">{{ t('admin.tileIcon.importHint') }}</p>
    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.library { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: var(--space-1); }
.cell { min-width: 40px; min-height: 40px; display: flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; }
.cell.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.thumb { width: 24px; height: 24px; }
.import { align-self: flex-start; }
.input { display: none; }
.hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.err { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
