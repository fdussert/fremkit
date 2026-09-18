<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from '../shared/i18n'
import { useAdminStore } from './store'
import Sidebar from './Sidebar.vue'
import Canvas from './Canvas.vue'
import Inspector from './Inspector.vue'
import TopBar from './TopBar.vue'
import BaseToast from '../shared/ui/BaseToast.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import ScreenInspector from './ScreenInspector.vue'
import ConnectionsInspector from './ConnectionsInspector.vue'
import MarketplacePanel from './MarketplacePanel.vue'
import { fits, moveRect, resizeRect } from './layout'

const s = useAdminStore()
const { t } = useI18n()

/** True while the user is typing: shortcuts must not steal those keys. */
function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) s.redo()
    else s.undo()
    return
  }
  if (inField(e.target)) return
  const inst = s.selected.value
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    if (inst) s.duplicateWidget(inst.instanceId)
    return
  }
  if (!inst || s.state.mode !== 'edit') return
  if (e.key === 'Escape') { s.select(null); return }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    s.removeWidget(inst.instanceId)
    return
  }
  const delta = ARROWS[e.key]
  if (!delta) return
  e.preventDefault()
  const start = { x: inst.x, y: inst.y, w: inst.w, h: inst.h }
  const min = s.state.manifests[inst.widgetId]?.minSize ?? [1, 1]
  // Shift resizes from the south-east corner, a bare arrow moves the whole widget.
  const next = e.shiftKey
    ? resizeRect(start, 'se', delta[0], delta[1], min, s.grid.value)
    : moveRect(start, delta[0], delta[1], s.grid.value)
  if (fits(next, s.grid.value, s.others(inst.instanceId))) s.updateInstance(inst.instanceId, next)
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

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pointerdown', onPointerDown, true)
  void s.load()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pointerdown', onPointerDown, true)
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
    <BaseModal v-if="s.state.modal === 'screen'" :title="t('admin.tabs.screen')"
      :close-label="t('common.close')" @close="s.closeModal()">
      <ScreenInspector />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'connections'" :title="t('admin.tabs.connections')"
      :close-label="t('common.close')" @close="s.closeModal()">
      <ConnectionsInspector />
    </BaseModal>
    <BaseModal v-else-if="s.state.modal === 'marketplace'" :title="t('admin.tabs.marketplace')"
      :width="720" :close-label="t('common.close')" @close="s.closeModal()">
      <MarketplacePanel />
    </BaseModal>
    <BaseToast v-if="s.state.toast" :message="s.state.toast" @close="s.dismissToast()" />
  </div>
  <p v-else class="loading">{{ t('common.loading') }}</p>
</template>

<style scoped>
.admin { height: 100vh; display: flex; flex-direction: column; background: var(--bg); }
main { flex: 1; min-height: 0; display: flex; }
.loading { padding: var(--space-4); color: var(--text-muted); }
</style>
