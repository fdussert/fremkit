<script setup lang="ts">
/**
 * The Icon field of a tile: what the frame draws before its title. Only `instance.icon` is
 * written here; drawing is `TileIcon`'s, inside the frame, never the widget's.
 *
 * Imported icons are a small library shared by every tile, managed in place: import one and it is
 * applied at once; delete one and it is first taken off every tile that wears it. Deleting asks
 * twice (`useConfirm`), since a native confirm never shows in the kiosk's web view.
 *
 * The field is a `<div>` styled like `BaseField`, not a `BaseField`: that one is a `<label>`, and
 * a label hands any tap on its caption or hint to its first button — here Add, which writes.
 */
import { computed, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import TileIcon from '../shared/TileIcon.vue'
import { api } from '../shared/api'
import { readBase64 } from '../shared/files'
import { useI18n } from '../shared/i18n'
import { TILE_ICONS } from '../shared/icons'
import { isChoosablePictogram } from '../shared/tileIcon'
import { useConfirm } from '../shared/useConfirm'
import type { TileIcon as Icon, WidgetInstance, WidgetManifest } from '../shared/types'
import { useAdminStore } from './store'

/** Matches MAX_TILE_ICON_BYTES on the server; checked here only to fail fast, with a message. */
const MAX_ICON_BYTES = 256 * 1024

const props = defineProps<{ instance: WidgetInstance; manifest?: WidgetManifest }>()
const s = useAdminStore()
const { t } = useI18n()
const confirm = useConfirm()

type Tab = 'pictograms' | 'files'
const open = ref(false)
const tab = ref<Tab>('pictograms')
const files = ref<string[]>([])
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()

const TABS = computed(() => (['pictograms', 'files'] as const).map((value) => ({ value, label: t(`admin.tileIcon.tab.${value}`) })))
const current = computed(() => props.instance.icon)
/** The manifest's own icon, when it is one a tile may wear. */
const suggested = computed(() => (isChoosablePictogram(props.manifest?.icon) ? props.manifest!.icon : undefined))
/** A file the tile names that the library no longer holds: deleted elsewhere, or undone back to. */
const missing = computed(() => (loaded.value && current.value?.kind === 'file' && !files.value.includes(current.value.name) ? current.value.name : undefined))

// Another tile selected: start closed, with nothing half-confirmed.
watch(() => props.instance.instanceId, close)
// Title hidden: the picker goes with it, and does not come back open with the title.
watch(() => props.instance.showTitle, close)

function close(): void {
  open.value = false
  error.value = ''
  confirm.reset()
}

function set(icon: Icon | undefined): void {
  s.updateInstance(props.instance.instanceId, { icon })
}
const isPicked = (icon: Icon): boolean => current.value?.kind === icon.kind && current.value.name === icon.name

async function openPicker(): Promise<void> {
  tab.value = current.value?.kind === 'file' ? 'files' : 'pictograms'
  open.value = true
  error.value = ''
  try {
    files.value = (await api.listTileIcons()).names
    loaded.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
/** The common case in one tap: the widget's own pictogram, then the picker to change it. */
async function add(): Promise<void> {
  if (suggested.value) set({ kind: 'lucide', name: suggested.value })
  await openPicker()
}
/** A newly picked file starts tinted, which is what follows the theme. */
function pickFile(name: string): void {
  set({ kind: 'file', name })
}
function setTint(on: boolean): void {
  const icon = current.value
  if (icon?.kind !== 'file') return
  set(on ? { kind: 'file', name: icon.name } : { kind: 'file', name: icon.name, tint: false })
}

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
    pickFile(name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function remove(name: string): void {
  confirm.ask(`delete:${name}`, async () => {
    // References first, file second: a failed delete leaves an orphan file, which harms nothing.
    s.removeTileIconEverywhere(name)
    error.value = ''
    try {
      await api.deleteTileIcon(name)
    } catch (err) {
      // Still on disk, so still listed: the user can try again, and knows why it failed.
      error.value = err instanceof Error ? err.message : String(err)
      return
    }
    files.value = files.value.filter((n) => n !== name)
  })
}
</script>

<template>
  <div class="field">
    <span class="lbl">{{ t('admin.tileIcon.label') }}</span>
    <div class="row">
      <TileIcon v-if="current" class="preview" :icon="current" />
      <span v-else class="none">{{ t('admin.tileIcon.none') }}</span>
      <template v-if="instance.showTitle">
        <BaseButton v-if="!current && !open" class="tap" data-action="add" @click="add"><BaseIcon name="plus" :size="16" />{{ t('admin.tileIcon.add') }}</BaseButton>
        <!-- Shown whenever the picker is open, so it can always be closed, with or without an icon. -->
        <BaseButton v-else class="tap" data-action="change" @click="open ? close() : openPicker()">{{ t(open ? 'admin.tileIcon.close' : 'admin.tileIcon.change') }}</BaseButton>
        <BaseButton v-if="current" class="tap" data-action="remove" @click="set(undefined)">{{ t('admin.tileIcon.remove') }}</BaseButton>
      </template>
    </div>
    <span class="field-hint">{{ t(instance.showTitle ? 'admin.tileIcon.hint' : 'admin.tileIcon.needsTitle') }}</span>
  </div>

  <div v-if="open && instance.showTitle" class="picker">
    <BaseSegmented class="tabs" :model-value="tab" :options="TABS" @update:model-value="tab = $event as Tab" />

    <div v-if="tab === 'pictograms'" class="grid">
      <button type="button" class="cell" :class="{ on: !current }" :title="t('admin.tileIcon.none')" @click="set(undefined)">
        <BaseIcon name="x" :size="20" />
      </button>
      <button v-for="name in TILE_ICONS" :key="name" type="button" class="cell"
        :class="{ on: isPicked({ kind: 'lucide', name }), suggested: name === suggested }"
        :title="name === suggested ? `${name} · ${t('admin.tileIcon.suggested')}` : name" @click="set({ kind: 'lucide', name })">
        <BaseIcon :name="name" :size="22" />
      </button>
    </div>

    <template v-else>
      <div class="grid files">
        <div v-for="name in files" :key="name" class="file">
          <!-- Shown in its own colours, so the user sees the file they imported. -->
          <button type="button" class="cell" :class="{ on: isPicked({ kind: 'file', name }) }" :title="name" @click="pickFile(name)">
            <TileIcon class="thumb" :icon="{ kind: 'file', name, tint: false }" />
          </button>
          <BaseButton class="del" :variant="confirm.armed(`delete:${name}`) ? 'danger' : 'icon'" :data-delete="name"
            :title="t('admin.tileIcon.delete')" @click="remove(name)">
            <template v-if="confirm.armed(`delete:${name}`)">{{ t('admin.tileIcon.deleteConfirm', { count: s.tileIconUsage(name) }) }}</template>
            <BaseIcon v-else name="trash-2" :size="16" />
          </BaseButton>
        </div>
        <div v-if="missing" class="cell missing on" :title="missing">{{ t('admin.tileIcon.missing') }}</div>
      </div>
      <input ref="fileInput" class="input" type="file" accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml" @change="onFile" />
      <BaseButton class="tap import" :disabled="busy" @click="fileInput?.click()">
        <BaseIcon name="upload" :size="16" />{{ t(busy ? 'admin.tileIcon.importing' : 'admin.tileIcon.import') }}
      </BaseButton>
      <p class="hint">{{ t('admin.tileIcon.importHint') }}</p>
      <BaseCheckbox v-if="current?.kind === 'file'" class="tint" :model-value="current.tint !== false"
        :label="t('admin.tileIcon.tint')" @update:model-value="setTint" />
      <p v-if="current?.kind === 'file'" class="hint tint-hint">{{ t('admin.tileIcon.tintHint') }}</p>
    </template>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
/* BaseField's look, on a <div> (see the comment at the top). */
.field { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-3); }
.lbl { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.field-hint { font-size: var(--fs-xs); color: var(--text-dim); }
/* Touch targets: everything tappable here is at least 44 px tall, on the strip as with a mouse. */
.tap { min-height: 44px; }
.import { align-self: flex-start; }
.tabs :deep(button) { min-height: 44px; }
/* `.picker` raises it above BaseCheckbox's own margin, whatever order the sheets load in. */
.picker .tint { min-height: 44px; margin-bottom: 0; }
.row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.preview { width: 28px; height: 28px; color: var(--accent); }
.none { font-size: var(--fs-sm); color: var(--text-muted); }
.picker { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: var(--space-1, 4px); }
.cell { min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; }
.cell.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.cell.suggested { border-style: dashed; }
.cell.missing { font-size: var(--fs-xs); color: var(--danger); }
/* Wider columns for files: the armed delete button has to say "Confirm?" and a count. */
.grid.files { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); }
.file { display: flex; flex-direction: column; gap: 2px; }
/* A file is shown in its own colours, and a black mark vanishes on a dark surface, a white one on
   a light one: a fixed light/mid grey checkerboard, the same under every theme, lets any colour read. */
.file .cell {
  background-color: #d4d4d4;
  background-image:
    linear-gradient(45deg, #9e9e9e 25%, transparent 25%, transparent 75%, #9e9e9e 75%),
    linear-gradient(45deg, #9e9e9e 25%, transparent 25%, transparent 75%, #9e9e9e 75%);
  background-size: 12px 12px;
  background-position: 0 0, 6px 6px;
}
.del { min-height: 44px; justify-content: center; font-size: var(--fs-xs); white-space: normal; text-align: center; }
.thumb { width: 26px; height: 26px; }
.input { display: none; }
.hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.err { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
