<script setup lang="ts">
/**
 * Which screen the editor works on, above the canvas: a segmented control up to three screens, a
 * menu beyond, and "+ Add a screen". Each screen shows its name and an icon for its kind, and a
 * right click on one opens its menu: rename (in place, as a page is), its settings, delete.
 *
 * Hidden altogether for a single screen while adding screens is an experimental feature that is
 * off (`labs.ts`): there is nothing to choose between, and nothing to add yet.
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import type { Screen } from '../shared/types'
import AddScreenDialog from './AddScreenDialog.vue'
import { useAdminStore } from './store'
import { openContextMenu } from '../shared/ui/contextMenu'
import { screenMenu } from './menus'
import { renameRequest } from './editorFocus'
import { useDevices } from './devices'
import HealthDot from './HealthDot.vue'
import { showsScreens } from './labs'
import { screenLevel } from './health'
import { useHealth } from './useHealth'

/** Beyond this many screens the row would crowd the canvas header, so it becomes a menu. */
const SEGMENTED_MAX = 3

const s = useAdminStore()
const { t } = useI18n()

const screens = computed<Screen[]>(() => s.state.config?.screens ?? [])
const shown = computed(() => showsScreens(s.state.config))
const current = computed(() => s.screen.value)
const adding = ref(false)
const menuOpen = ref(false)
const menu = ref<HTMLElement>()

const health = useHealth()
/** Red or orange when a widget of that screen, on a page or in its bar, is not well. */
const levelOf = (x: Screen) => screenLevel(health.all.value, x)

const iconOf = (x: Screen): string => (x.kind === 'edge' ? 'monitor' : 'tablet')

function choose(id: string): void {
  s.selectScreen(id)
  menuOpen.value = false
}

/** The screen being renamed in place, or ''. */
const renaming = ref('')
const nav = ref<HTMLElement>()
// Escape unmounts the field, which fires a blur: it must not commit what Escape rejected.
let cancelling = false
function startRename(id: string): void {
  cancelling = false
  // The long list is a pop-up: the rename happens on the trigger, which shows the current screen.
  if (screens.value.length > SEGMENTED_MAX) s.selectScreen(id)
  menuOpen.value = false
  renaming.value = id
  void nextTick(() => {
    const input = nav.value?.querySelector<HTMLInputElement>('input.rename')
    input?.focus()
    input?.select()
  })
}
function commitRename(e: Event): void {
  if (cancelling) { cancelling = false; return }
  const id = renaming.value
  renaming.value = ''
  if (id) s.renameScreen(id, (e.target as HTMLInputElement).value)
}
function cancelRename(): void {
  cancelling = true
  renaming.value = ''
}

/** A rename asked for by the command palette. */
watch(renameRequest, (req) => {
  if (req?.kind !== 'screen') return
  renameRequest.value = null
  startRename(req.id)
}, { immediate: true })

/** The paired devices, so deleting a screen can name those it would leave with nothing. */
const devices = useDevices()
async function onMenu(e: MouseEvent, id: string): Promise<void> {
  const build = () => screenMenu(s, id, { rename: startRename }, devices.showing(id).map((d) => d.name))
  if (screens.value.find((v) => v.id === id)?.kind !== 'device') { openContextMenu(e, build()); return }
  // A device screen asks the server which devices show it first — a local call — so deleting it
  // names them, as the Screen panel does. The menu opens where the click was all the same.
  e.preventDefault()
  e.stopPropagation()
  const at = { x: e.clientX + 1, y: e.clientY + 1 }
  try { await devices.refresh() } catch { /* the menu says what is known */ }
  openContextMenu(at, build())
}

/** The menu closes on a press anywhere outside it, and on Escape. */
function onOutside(e: PointerEvent): void {
  if (menu.value && !menu.value.contains(e.target as Node)) menuOpen.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuOpen.value = false
}
watch(menuOpen, (open) => {
  if (open) {
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onKey)
  } else {
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onKey)
  }
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <nav v-if="shown" ref="nav" class="screens" :aria-label="t('admin.screens.aria')">
    <div v-if="screens.length <= SEGMENTED_MAX" class="seg" role="tablist">
      <template v-for="x in screens" :key="x.id">
        <span v-if="renaming === x.id" class="renaming" :class="{ on: x.id === current?.id }">
          <BaseIcon :name="iconOf(x)" :size="16" />
          <input class="rename" :value="x.name" maxlength="60" :aria-label="t('admin.screens.renameAria')"
            @blur="commitRename" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelRename()" />
        </span>
        <button v-else type="button" role="tab" :aria-selected="x.id === current?.id"
          :class="{ on: x.id === current?.id }" :title="t(`admin.screens.kind.${x.kind}`)" @click="choose(x.id)"
          @dblclick="startRename(x.id)" @contextmenu="onMenu($event, x.id)">
          <BaseIcon :name="iconOf(x)" :size="16" /><span class="name">{{ x.name }}</span>
          <HealthDot :level="levelOf(x)" :title="t('admin.health.screenDot')" />
        </button>
      </template>
    </div>
    <div v-else ref="menu" class="menu">
      <span v-if="current && renaming === current.id" class="renaming trigger">
        <BaseIcon :name="iconOf(current)" :size="16" />
        <input class="rename" :value="current.name" maxlength="60" :aria-label="t('admin.screens.renameAria')"
          @blur="commitRename" @keydown.enter="($event.target as HTMLInputElement).blur()" @keydown.esc.stop="cancelRename()" />
      </span>
      <button v-else type="button" class="trigger" aria-haspopup="listbox" :aria-expanded="menuOpen"
        :title="t('admin.screens.menu')" @click="menuOpen = !menuOpen" @contextmenu="current && onMenu($event, current.id)">
        <BaseIcon v-if="current" :name="iconOf(current)" :size="16" /><span class="name">{{ current?.name }}</span>
        <HealthDot v-if="current" :level="levelOf(current)" :title="t('admin.health.screenDot')" />
        <BaseIcon name="chevron-down" :size="16" />
      </button>
      <ul v-if="menuOpen" class="list" role="listbox">
        <li v-for="x in screens" :key="x.id" role="option" :aria-selected="x.id === current?.id">
          <button type="button" :class="{ on: x.id === current?.id }" @click="choose(x.id)" @contextmenu="onMenu($event, x.id)">
            <BaseIcon :name="iconOf(x)" :size="16" /><span class="name">{{ x.name }}</span>
            <HealthDot :level="levelOf(x)" :title="t('admin.health.screenDot')" />
          </button>
        </li>
      </ul>
    </div>
    <button type="button" class="add" @click="adding = true">{{ t('admin.screens.add') }}</button>
    <AddScreenDialog v-if="adding" @close="adding = false" />
  </nav>
</template>

<style scoped>
.screens { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4) 0; }
.seg { display: flex; gap: 2px; padding: 2px; min-width: 0; background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
button { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; min-width: 44px;
  font: inherit; font-size: var(--fs-sm); cursor: pointer; padding: 0 var(--space-3); color: var(--text-muted);
  background: transparent; border: 0; border-radius: 6px; }
button:hover { color: var(--text); }
.seg button.on, .list button.on { background: var(--accent); color: var(--on-accent); }
.name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu { position: relative; }
.trigger { background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
.list { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 100%; margin: 0; padding: 4px;
  list-style: none; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  box-shadow: var(--shadow); }
.list button { width: 100%; }
.renaming { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; padding: 0 var(--space-2);
  border-radius: 6px; color: var(--text); }
.rename { width: 180px; font: inherit; font-size: var(--fs-sm); color: var(--text); background: var(--bg);
  border: 1px solid var(--accent); border-radius: 6px; padding: 4px 6px; }
.add { border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); }
.add:hover { background: var(--surface-2); }
</style>
