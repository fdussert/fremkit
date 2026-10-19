<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useI18n } from '../shared/i18n'
import { useAdminStore } from './store'
import { tilesDeleteKey, widgetDelete, widgetDeleteKey } from './widgetDelete'
import Sidebar from './Sidebar.vue'
import Canvas from './Canvas.vue'
import Inspector from './Inspector.vue'
import TopBar from './TopBar.vue'
import BaseToast from '../shared/ui/BaseToast.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import SettingsWindow from './settings/SettingsWindow.vue'
import ConnectionsInspector from './ConnectionsInspector.vue'
import MarketplacePanel from './MarketplacePanel.vue'
import WidgetAbout from './WidgetAbout.vue'
import KeyboardShortcuts from './KeyboardShortcuts.vue'
import ShareExportDialog from './ShareExportDialog.vue'
import ShareImportDialog from './ShareImportDialog.vue'
import { carriesFiles, openImportFile, share } from './share'
import ContextMenu from '../shared/ui/ContextMenu.vue'
import CommandPalette, { paletteOpen } from './CommandPalette.vue'
import { ARROW_DELTAS, matchShortcut } from './shortcuts'
import { followThemeSchedule, useConfigTheme } from '../shared/theme'
import { useSocket } from '../shared/socket'
import { SCREEN_ID } from '../shared/useWidgetBridge'
import { onWidgetReload } from '../shared/widgetDev'

const s = useAdminStore()
const { t } = useI18n()

/** Where a widget taken off this screen still shows; it goes by itself after a while. */
const noticeText = computed(() => {
  const n = s.state.notice
  if (!n) return ''
  if (n.count > 1) return t('admin.notice.stillShownMany', { count: n.count })
  return n.pageName === null
    ? t('admin.notice.stillShownBar', { name: n.name, screen: n.screenName })
    : t('admin.notice.stillShown', { name: n.name, screen: n.screenName, page: n.pageName })
})
const NOTICE_MS = 10_000
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => s.state.notice, (n) => {
  clearTimeout(noticeTimer)
  if (n) noticeTimer = setTimeout(() => { if (s.state.notice === n) s.dismissNotice() }, NOTICE_MS)
})
/** A confirmation with nothing to do about it goes sooner. */
const INFO_MS = 4_000
let infoTimer: ReturnType<typeof setTimeout> | undefined
watch(() => s.state.info, (text) => {
  clearTimeout(infoTimer)
  if (text) infoTimer = setTimeout(() => { if (s.state.info === text) s.dismissInfo() }, INFO_MS)
})
// Previews are told the screen being edited, as the dashboard tells its tiles (`Fremkit.screen`).
provide(SCREEN_ID, () => s.screen.value?.id)
// The editor wears the theme it edits, so a tile looks here like it does on the screen.
// At night that is the night theme, when the config has one: the server says which it is.
useConfigTheme(computed(() => s.state.config))
onUnmounted(followThemeSchedule(useSocket()))

/** True while the user is typing: shortcuts must not steal those keys. */
function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/**
 * Tab moves the selection through the page's tiles only while the editor, not a control, has the
 * keyboard: a widget is selected, or nothing has the focus. Otherwise it walks the buttons, as it
 * should for anybody driving the editor from the keyboard.
 */
function tabCyclesWidgets(): boolean {
  if (s.state.selection.length) return true
  const active = document.activeElement
  return !active || active === document.body
}

function onKeyDown(e: KeyboardEvent): void {
  const typing = inField(e.target)
  const shortcut = matchShortcut(e, typing)
  if (!shortcut) return
  switch (shortcut.id) {
    case 'undo': e.preventDefault(); s.undo(); return
    case 'redo': e.preventDefault(); s.redo(); return
    case 'palette': e.preventDefault(); paletteOpen.value = !paletteOpen.value; return
    case 'shortcuts':
      // A second "?" closes the sheet; over another dialog it does nothing rather than replace it.
      if (s.state.modal === 'shortcuts') { e.preventDefault(); s.closeModal() } else if (!s.state.modal) { e.preventDefault(); s.openModal('shortcuts') }
      return
  }
  const inst = s.selected.value
  // Several tiles selected: the keys act on all of them; one, on it as they always have.
  const ids = [...s.state.selection]
  const group = ids.length > 1
  const editing = s.state.mode === 'edit'
  switch (shortcut.id) {
    case 'duplicate':
      e.preventDefault()
      if (group) s.duplicateTiles(ids)
      else if (inst) s.duplicateWidget(inst.instanceId)
      return
    case 'selectAll':
      // Over a dialog, or in Test mode, ⌘A is the page's own.
      if (!editing || s.state.modal) return
      e.preventDefault()
      s.selectAll()
      return
    // ⌘C and ⌘V work on the editor's own widget clipboard, but never over text the user has
    // selected on the page: that copy is the browser's.
    case 'copy':
      if (!editing || hasTextSelection() || !ids.length) return
      e.preventDefault()
      s.copyTiles(ids)
      return
    case 'paste':
      if (!editing || hasTextSelection() || !s.state.clipboard) return
      e.preventDefault()
      s.pasteWidget()
      return
    case 'nextWidget':
    case 'previousWidget':
      if (!editing || s.state.modal || !tabCyclesWidgets()) return
      if (s.cycleSelection(shortcut.id === 'nextWidget' ? 1 : -1)) e.preventDefault()
      return
  }
  // A dialog (this sheet, the settings window) is over the canvas: the keys are not the tiles'.
  if (!ids.length || !editing || s.state.modal) return
  switch (shortcut.id) {
    case 'deselect': s.select(null); return
    case 'remove': {
      e.preventDefault()
      if (group) {
        // The same rule for a group: at once when every widget stays on another screen, else
        // armed first — the inspector's button shows it — and a second press confirms.
        if (!ids.some((id) => s.isLastPlace(id))) s.removeTiles(ids)
        else widgetDelete.ask(tilesDeleteKey(ids), () => s.removeTiles(ids))
        return
      }
      if (!inst) return
      // Off this screen only: done at once, undo covers it. On its last screen the widget itself
      // goes, so the key arms the inspector's confirmation and a second press confirms it.
      const id = inst.instanceId
      if (!s.isLastPlace(id)) s.removeFromScreen(id)
      else widgetDelete.ask(widgetDeleteKey(id), () => s.removeFromScreen(id))
      return
    }
    case 'move':
    case 'resize': {
      const delta = ARROW_DELTAS[e.key]
      if (!delta) return
      e.preventDefault()
      // A held key repeats: its steps join the first press's undo step. A group moves, never resizes.
      if (group) { if (shortcut.id === 'move') s.moveTiles(ids, delta[0], delta[1], { repeat: e.repeat }); return }
      if (!inst) return
      s.nudgeWidget(inst.instanceId, delta[0], delta[1], { resize: shortcut.id === 'resize', repeat: e.repeat })
    }
  }
}

/** True when the user has selected some text on the page, which ⌘C must copy as usual. */
function hasTextSelection(): boolean {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== ''
}

/**
 * A press outside a field takes the keyboard back. The edit overlay preventDefaults and stops
 * its own pointerdown to start a drag, so the browser never moves focus by itself and the last
 * edited input would otherwise keep swallowing every shortcut. Hence the capture phase: the
 * overlay's stopPropagation() would hide a bubbling listener from these presses.
 */
function onPointerDown(e: PointerEvent): void {
  if (inField(e.target)) return
  const active = document.activeElement
  if (active instanceof HTMLElement && inField(active)) active.blur()
}

/**
 * A layout file dropped anywhere on the admin opens the import dialog. Only a drag carrying files
 * is ours: the editor's own drags (a widget from the library, a page) carry their own types, and
 * anything that handles a drop itself first marks it handled (`defaultPrevented`).
 */
function onDragOver(e: DragEvent): void {
  if (!carriesFiles(e) || e.defaultPrevented) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDrop(e: DragEvent): void {
  if (!carriesFiles(e) || e.defaultPrevented) return
  // Never let the browser navigate to the dropped file, whatever it is.
  e.preventDefault()
  const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith('.json'))
  if (file) void openImportFile(s, file)
}

function closeShare(): void {
  share.exporting = null
  share.importing = null
  s.closeModal()
}

// A widget's manifest was saved while it is being written: the previews wait for this catalogue.
const offReload = onWidgetReload((reload) => { if (reload.manifest) void s.rescan() })

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('drop', onDrop)
  void s.load()
})
onUnmounted(() => {
  offReload()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('drop', onDrop)
  void s.flush()
})
</script>

<template>
  <div class="admin" v-if="s.state.config">
    <TopBar />
    <main>
      <Sidebar />
      <Canvas />
      <Inspector />
    </main>
    <BaseModal v-if="s.state.modal === 'settings'" :title="t('admin.settings.title')"
      :width="880" :height="920" flush :close-label="t('common.close')" @close="s.closeModal()">
      <SettingsWindow />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'connections'" :title="t('admin.tabs.connections')"
      :close-label="t('common.close')" @close="s.closeModal()">
      <ConnectionsInspector />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'marketplace'" :title="t('admin.tabs.marketplace')"
      :width="720" :height="840" flush :close-label="t('common.close')" @close="s.closeModal()">
      <MarketplacePanel />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'about'" :title="t('admin.about.title')"
      :width="480" :close-label="t('common.close')" @close="s.closeModal()">
      <WidgetAbout :instance-id="s.state.aboutId" />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'shortcuts'" :title="t('admin.shortcuts.title')"
      :width="480" :close-label="t('common.close')" @close="s.closeModal()">
      <KeyboardShortcuts />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'export' && share.exporting" :title="t('admin.share.export.title')"
      :width="560" :close-label="t('common.close')" @close="closeShare()">
      <ShareExportDialog />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'import' && share.importing" :title="t('admin.share.import.title')"
      :width="560" :close-label="t('common.close')" @close="closeShare()">
      <ShareImportDialog />
    </BaseModal>
    <ContextMenu />
    <CommandPalette />
    <BaseToast v-if="s.state.toast" :message="s.state.toast" @close="s.dismissToast()" />
    <BaseToast v-else-if="s.state.notice" tone="info" icon="info" :message="noticeText" :action="t('admin.notice.go')"
      @action="s.goToNotice()" @close="s.dismissNotice()" />
    <BaseToast v-else-if="s.state.info" tone="info" :message="s.state.info" @close="s.dismissInfo()" />
  </div>
  <p v-else class="loading">{{ t('common.loading') }}</p>
</template>

<style scoped>
.admin { height: 100vh; display: flex; flex-direction: column; background: var(--bg); }
main { flex: 1; min-height: 0; display: flex; }
.loading { padding: var(--space-4); color: var(--text-muted); }
</style>
