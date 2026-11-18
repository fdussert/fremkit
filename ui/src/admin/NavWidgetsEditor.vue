<script setup lang="ts">
/**
 * The Screen tab's "Navigation bar widgets" section: the selected screen's bar entries in bar
 * order, under two headings — left of the page dots, then right of them — each with its widget's
 * settings folded away, plus a drop-down of every widget whose manifest declares a compact
 * rendering. An entry is dragged by its row, within a side or to the other one, or stepped with
 * its arrows, which cross the dots at the end of a side. Everything goes through the store's
 * `apply`, so it is undoable. The settings are the shared widget's: a tile of the same widget on
 * another screen follows them.
 */
import { computed, onUnmounted, ref } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import CopySettingsFrom from './CopySettingsFrom.vue'
import SettingsForm from './SettingsForm.vue'
import { pick, useI18n } from '../shared/i18n'
import { NAV_SLOTS, POPUP_SIZES, navItemsOf, type NavSlot, type PopupSize } from '../shared/types'
import { useAdminStore } from './store'
import { offeredManifests } from './labs'
import { dropIndex } from './pageDrag'
import { dropMarker } from './gifDrag'
import { navStep } from './navOrder'
import { widgetDelete, widgetDeleteKey } from './widgetDelete'
import { openContextMenu } from '../shared/ui/contextMenu'
import { editorFocus } from './editorFocus'
import { navSettingsOpen, navWidgetMenu, toggleNavSettings } from './menus'

const s = useAdminStore()
const { t } = useI18n()

/** The bar entries, each with the widget it names; an entry naming no widget shows as unknown. */
const navWidgets = computed(() => navItemsOf(s.screen.value!).map((item) => {
  const widget = s.state.config!.widgets[item.instanceId]
  return { ...item, widgetId: widget?.widgetId ?? '', settings: widget?.settings ?? {} }
}))
/** One side's entries, in the order the bar draws them. */
const sideItems = (slot: NavSlot) => navWidgets.value.filter((w) => w.slot === slot)
/** The standard shape is the absence of the key, like `popup` off. */
const POPUP_SIZE_OPTIONS = computed(() => [
  { value: '', label: t('admin.inspector.screen.navWidgets.popupSize.standard') },
  ...POPUP_SIZES.map((value) => ({ value, label: t(`admin.inspector.screen.navWidgets.popupSize.${value}`) })),
])
/** The arrows step along the bar and cross the dots, so they disable at the bar's two ends only. */
const canStep = (id: string, delta: -1 | 1): boolean => navStep(navItemsOf(s.screen.value!), id, delta) !== null
/** Only widgets with a compact rendering may go in the bar; the server refuses the others. */
const addable = computed(() => offeredManifests(s.state.config, s.state.manifests).filter((m) => m.compact))

const manifestOf = (widgetId: string) => s.state.manifests[widgetId]
const label = (widgetId: string): string => pick(manifestOf(widgetId)?.name) || widgetId
/**
 * Whose settings are unfolded. One at a time is the usual case, but not enforced; shared with the
 * menus, so "Settings…" on a bar widget unfolds its row here.
 */
const isOpen = (id: string): boolean => navSettingsOpen.includes(id)
const toggle = (id: string): void => toggleNavSettings(id)

function onAdd(event: Event): void {
  const select = event.target as HTMLSelectElement
  const widgetId = select.value
  // The drop-down is an action, not a value: it snaps back to its placeholder either way.
  select.value = ''
  if (widgetId) s.addNavWidget(widgetId)
}

/**
 * The trash button takes the widget out of this screen's bar. When no other screen shows it, that
 * deletes the widget, so the button asks first — the same two-tap confirmation as a tile.
 */
function remove(instanceId: string): void {
  if (!s.isLastPlace(instanceId)) { s.removeNavWidget(instanceId); return }
  widgetDelete.ask(widgetDeleteKey(instanceId), () => s.removeNavWidget(instanceId))
}

/**
 * Off is the absence of the key, never `false`: a bar nobody has asked a popover from keeps the
 * config file it already had.
 */
function onPopup(instanceId: string, value: boolean): void {
  s.updateNavWidget(instanceId, value ? { popup: true } : { popup: undefined, popupSize: undefined })
}
function onPopupSize(instanceId: string, value: string): void {
  s.updateNavWidget(instanceId, { popupSize: (value || undefined) as PopupSize | undefined })
}

/**
 * The drag, with pointer events as the pages list and the GIF panel do it (a WKWebView does not
 * deliver HTML drag and drop reliably). A row lifts once the pointer has travelled a few pixels;
 * the side under the pointer and the index among its rows decide where it lands, shown as a line.
 * The click a drag's release produces does not also fold or unfold the row's settings.
 */
const DRAG_THRESHOLD = 4
const drag = ref<{ id: string; slot: NavSlot; from: number } | null>(null)
const over = ref<{ slot: NavSlot; to: number } | null>(null)
let pressed: { id: string; slot: NavSlot; from: number; x: number; y: number; pointer: number; el: HTMLElement } | null = null
let swallowClick = false

function onDown(e: PointerEvent, slot: NavSlot, from: number, id: string): void {
  if (e.button !== 0) return
  // The row's own buttons (arrows, delete) are pressed, never dragged; the name is both.
  if ((e.target as HTMLElement).closest('.actions')) return
  pressed = { id, slot, from, x: e.clientX, y: e.clientY, pointer: e.pointerId, el: e.currentTarget as HTMLElement }
}
function onMove(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  if (!drag.value) {
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < DRAG_THRESHOLD) return
    drag.value = { id: pressed.id, slot: pressed.slot, from: pressed.from }
    // Captured so the release lands here even off the row.
    try { pressed.el.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    pressed.el.focus({ preventScroll: true })
    window.addEventListener('keydown', onDragKey, true)
  }
  over.value = landing(e.clientX, e.clientY)
}
/** The side under the pointer and the index the entry would have there, or null off both. */
function landing(x: number, y: number): { slot: NavSlot; to: number } | null {
  const d = drag.value
  const section = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-nav-side]')
  const slot = section?.dataset.navSide as NavSlot | undefined
  if (!d || !section || !slot) return null
  const boxes = [...section.querySelectorAll<HTMLElement>('li[data-nav-item]')].map((el) => el.getBoundingClientRect())
  return { slot, to: dropIndex(boxes, y, slot === d.slot ? d.from : -1) }
}
function onUp(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.pointer) return
  const d = drag.value
  const o = over.value
  endDrag()
  if (!d) return
  // The click that follows this release comes before any timer.
  swallowClick = true
  setTimeout(() => { swallowClick = false })
  if (!o || (o.slot === d.slot && o.to === d.from)) return
  s.placeNavWidget(d.id, o.slot, o.to)
}
function endDrag(): void {
  pressed = null
  drag.value = null
  over.value = null
  window.removeEventListener('keydown', onDragKey, true)
}
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // Escape drops the drag where it started, and must not also close the settings window.
  e.preventDefault()
  e.stopPropagation()
  endDrag()
}
onUnmounted(endDrag)
function onNameClick(id: string): void {
  if (!swallowClick) toggle(id)
}
/** Where the drop line goes on a side: before one entry's id, `null` after its last. */
function markerOf(slot: NavSlot): string | null | undefined {
  const d = drag.value
  const o = over.value
  if (!d || !o || o.slot !== slot) return undefined
  return dropMarker(sideItems(slot).map((w) => w.instanceId), d.id, o.to)
}

/** One emit per edited key, exactly as the widget inspector does, so each is one undo step. */
function onSetting(instanceId: string, key: string, value: unknown): void {
  const current = navWidgets.value.find((w) => w.instanceId === instanceId)
  if (current) s.updateNavWidget(instanceId, { settings: { ...current.settings, [key]: value } })
}
</script>

<template>
  <p class="hint">{{ t('admin.inspector.screen.navWidgets.hint') }}</p>
  <p v-if="!navWidgets.length" class="hint">{{ t('admin.inspector.screen.navWidgets.empty') }}</p>
  <template v-else>
  <!-- The bar from left to right: the left cluster, the page dots, the right cluster. -->
  <section v-for="slot in NAV_SLOTS" :key="slot" class="side" :data-nav-side="slot">
  <h4>{{ t(`admin.inspector.screen.navWidgets.side.${slot}`) }}</h4>
  <ul class="list" :class="{ dragging: !!drag }">
    <li v-for="(w, i) in sideItems(slot)" :key="w.instanceId" data-nav-item
      :class="{ lifted: drag?.id === w.instanceId, 'drop-before': markerOf(slot) === w.instanceId,
        'drop-after': markerOf(slot) === null && i === sideItems(slot).length - 1 }">
      <!-- The head row only: a right click in a setting's field keeps the browser's text menu.
           data-overlay while lifted: the Escape that drops the drag must not also close the window. -->
      <div class="head" tabindex="-1" :title="t('admin.inspector.screen.navWidgets.drag')"
        :data-overlay="drag?.id === w.instanceId ? '' : undefined"
        @contextmenu="openContextMenu($event, navWidgetMenu(s, w.instanceId, editorFocus))"
        @pointerdown="onDown($event, slot, i, w.instanceId)" @pointermove="onMove" @pointerup="onUp" @pointercancel="endDrag">
        <BaseIcon class="grip" name="grip-vertical" :size="14" />
        <BaseIcon :name="manifestOf(w.widgetId)?.icon ?? 'layout-grid'" :size="16" />
        <button type="button" class="name" :aria-expanded="isOpen(w.instanceId)"
          :title="t(isOpen(w.instanceId) ? 'admin.inspector.screen.navWidgets.collapse' : 'admin.inspector.screen.navWidgets.expand')"
          @click="onNameClick(w.instanceId)">
          {{ label(w.widgetId) }}
          <BaseIcon :name="isOpen(w.instanceId) ? 'chevron-up' : 'chevron-down'" :size="14" />
        </button>
        <span class="actions">
        <BaseButton variant="icon" :title="t('common.moveUp')" :disabled="!canStep(w.instanceId, -1)"
          @click="s.moveNavWidget(w.instanceId, -1)">
          <BaseIcon name="chevron-up" :size="14" />
        </BaseButton>
        <BaseButton variant="icon" :title="t('common.moveDown')" :disabled="!canStep(w.instanceId, 1)"
          @click="s.moveNavWidget(w.instanceId, 1)">
          <BaseIcon name="chevron-down" :size="14" />
        </BaseButton>
        <BaseButton v-if="widgetDelete.armed(widgetDeleteKey(w.instanceId))" variant="danger" @click="remove(w.instanceId)">
          {{ t('common.confirm') }}
        </BaseButton>
        <BaseButton v-else variant="icon"
          :title="t(s.isLastPlace(w.instanceId) ? 'admin.inspector.widget.delete' : 'admin.inspector.widget.removeFromScreen')"
          @click="remove(w.instanceId)">
          <BaseIcon :name="s.isLastPlace(w.instanceId) ? 'trash-2' : 'x'" :size="14" />
        </BaseButton>
        </span>
      </div>
      <!-- The row is too narrow for the name on the button, and a tooltip never shows on touch:
           the question naming the widget goes under the row while it is armed. -->
      <p v-if="widgetDelete.armed(widgetDeleteKey(w.instanceId))" class="hint bad">
        {{ t('admin.inspector.widget.deleteConfirm', { name: label(w.widgetId) }) }}
      </p>
      <!-- Touching the compact widget then opens the full one above the bar instead of reaching it. -->
      <BaseCheckbox class="popup" :model-value="w.popup === true"
        :label="t('admin.inspector.screen.navWidgets.popup')"
        @update:model-value="onPopup(w.instanceId, $event)" />
      <!-- The popover's shape: the tile's, lower and wider, or larger. -->
      <BaseSegmented v-if="w.popup" class="popup-size" :model-value="w.popupSize ?? ''" :options="POPUP_SIZE_OPTIONS"
        :aria-label="t('admin.inspector.screen.navWidgets.popupSize.label')"
        @update:model-value="onPopupSize(w.instanceId, $event as string)" />
      <!-- The GIF board's collection is edited in its own panel; a board kept only in the bar
           still needs the way in a tile's inspector gives. -->
      <BaseButton v-if="w.widgetId === 'gif-board'" class="gifs-open" @click="s.openModal('gifs')">{{ t('admin.gifs.open') }}</BaseButton>
      <div v-if="isOpen(w.instanceId) && manifestOf(w.widgetId)" class="settings">
        <!-- Usually a full tile of the same widget, already configured: copying it is quicker
             than repeating the same choices in the bar. -->
        <CopySettingsFrom :widget-id="w.widgetId" :instance-id="w.instanceId"
          @copy="s.updateNavWidget(w.instanceId, { settings: $event })" />
        <!-- The bar draws the compact rendering, so a setting scoped to the tile is not shown here. -->
        <SettingsForm :schema="manifestOf(w.widgetId)!.settingsSchema" scope="compact" :values="w.settings"
          :widget-id="w.widgetId" :commands="manifestOf(w.widgetId)!.commands"
          @change="(key, value) => onSetting(w.instanceId, key, value)" />
      </div>
    </li>
    <!-- An empty side still takes a drop. -->
    <li v-if="!sideItems(slot).length" class="drop-zone" :class="{ over: over?.slot === slot }">
      {{ t('admin.inspector.screen.navWidgets.dropHere') }}
    </li>
  </ul>
  </section>
  </template>
  <p v-if="!addable.length" class="hint">{{ t('admin.inspector.screen.navWidgets.none') }}</p>
  <select v-else class="add" value="" @change="onAdd">
    <option value="">{{ t('admin.inspector.screen.navWidgets.add') }}</option>
    <option v-for="m in addable" :key="m.id" :value="m.id">{{ pick(m.name) }}</option>
  </select>
</template>

<style scoped>
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.hint { font-size: var(--fs-xs); color: var(--text-dim); margin: 0 0 var(--space-2); }
.list .hint.bad { color: var(--danger); margin: var(--space-1) 0 0; }
.list { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.list li { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2); }
.head { display: flex; align-items: center; gap: var(--space-1); }
h4 { font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-3) 0 var(--space-1); }
.side:first-of-type h4 { margin-top: var(--space-1); }
.head { cursor: grab; touch-action: none; }
.list.dragging .head { cursor: grabbing; }
.grip { color: var(--text-dim); flex: 0 0 auto; }
.actions { display: flex; align-items: center; gap: var(--space-1); }
.list li.lifted { opacity: .4; }
/* The line the lifted entry lands on: above an entry, or under a side's last one. */
.list li.drop-before { box-shadow: 0 -3px 0 var(--accent); }
.list li.drop-after { box-shadow: 0 3px 0 var(--accent); }
.list li.drop-zone { border-style: dashed; color: var(--text-dim); font-size: var(--fs-xs); text-align: center; }
.list li.drop-zone.over { border-color: var(--accent); color: var(--text); }
/* The checkbox brings its own bottom margin, which is too much inside a compact row. */
.popup { margin: var(--space-1) 0 0; }
.gifs-open { margin: var(--space-2) 0 0; }
.popup-size { margin: var(--space-1) 0 0; }
.name { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--space-1);
  font: inherit; font-size: var(--fs-sm); color: var(--text); text-align: left; cursor: pointer;
  background: none; border: 0; padding: 0; }
.settings { margin-top: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--border); }
.add { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
</style>
