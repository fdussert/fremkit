<script setup lang="ts">
/**
 * The one host every context menu is drawn by. Mount it once, at the root of a page; open menus
 * with `openContextMenu` (`./contextMenu`).
 *
 * It looks and behaves like a macOS menu rather than a web dropdown: a translucent blurred panel,
 * check marks and shortcut hints in their own columns, submenus on hover and on →, the whole
 * thing driven from the keyboard (↑ ↓ → ← Enter Esc, and type-ahead), kept inside the window, and
 * gone at the first click elsewhere, scroll, resize or loss of focus.
 *
 * Every level is a panel in `levels`: the root, then one per open submenu. A panel is drawn
 * hidden first, measured, then placed — its size depends on its labels and the theme's font.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import BaseIcon from './BaseIcon.vue'
import './menu.css'
import {
  closeContextMenu, findByPrefix, isActionable, isSeparator, placeMenu, placeSubmenu, step, useContextMenu,
  type MenuEntry, type MenuItem, type Point,
} from './contextMenu'

interface Level {
  items: MenuEntry[]
  /** The highlighted row, or -1. */
  active: number
  /** Null until the panel has been measured and placed. */
  pos: Point | null
  /** For a submenu: the parent's panel and row, which it is placed against. */
  anchor?: { panel: DOMRect; item: DOMRect }
}

const menu = useContextMenu()
const levels = ref<Level[]>([])
const panels = ref<HTMLElement[]>([])
/** Who had the focus before the menu took it, to hand it back. */
let previousFocus: HTMLElement | null = null
/** The pending open or close of a submenu on hover. */
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let typed = ''
let typedTimer: ReturnType<typeof setTimeout> | undefined

/** How long the pointer rests on a row before its submenu opens, or a sibling's closes. */
const HOVER_DELAY_MS = 120
const TYPEAHEAD_MS = 700

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

async function measure(depth: number): Promise<void> {
  await nextTick()
  const level = levels.value[depth]
  const el = panels.value[depth]
  if (!level || !el || !menu.value) return
  const size = { width: el.offsetWidth, height: el.offsetHeight }
  level.pos = depth === 0
    ? placeMenu(menu.value!.at, size, viewport())
    : placeSubmenu(boxOf(level.anchor!.panel), boxOf(level.anchor!.item), size, viewport())
  if (depth === 0) el.focus({ preventScroll: true })
}
const boxOf = (r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height })

watch(menu, (open) => {
  clearTimeout(hoverTimer)
  if (!open) { teardown(); return }
  if (!levels.value.length) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    listen()
  }
  levels.value = [{ items: open.items, active: -1, pos: null }]
  void measure(0)
})

function close(): void { closeContextMenu() }


function teardown(): void {
  // Let go of the focus before the panels go, rather than leave it on a removed element.
  const active = document.activeElement
  if (active instanceof HTMLElement && panels.value.some((p) => p?.contains(active))) active.blur()
  levels.value = []
  panels.value = []
  unlisten()
  const back = previousFocus
  previousFocus = null
  if (back && document.contains(back)) back.focus({ preventScroll: true })
}

/** Opens the submenu of row `index` on panel `depth`, closing deeper ones first. */
function openSub(depth: number, index: number, highlightFirst: boolean): void {
  const item = levels.value[depth]?.items[index]
  if (!isActionable(item) || !item.children?.length) return
  const panel = panels.value[depth]
  const row = panel?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  if (!panel || !row) return
  if (levels.value[depth + 1] && levels.value.length === depth + 2 && levels.value[depth + 1].items === item.children) {
    // Already open: only the highlight may change.
    if (highlightFirst) levels.value[depth + 1].active = step(item.children, -1, 1)
    return
  }
  levels.value.splice(depth + 1)
  levels.value.push({
    items: item.children,
    active: highlightFirst ? step(item.children, -1, 1) : -1,
    pos: null,
    anchor: { panel: panel.getBoundingClientRect(), item: row.getBoundingClientRect() },
  })
  void measure(depth + 1)
}

function activate(depth: number, index: number): void {
  const item = levels.value[depth]?.items[index]
  if (!isActionable(item)) return
  if (item.children?.length) { openSub(depth, index, true); return }
  close()
  item.run?.()
}

// --- pointer ---
function onEnter(depth: number, index: number): void {
  const level = levels.value[depth]
  if (!level) return
  const item = level.items[index]
  level.active = isActionable(item) ? index : -1
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    if (isActionable(item) && item.children?.length) openSub(depth, index, false)
    else levels.value.splice(depth + 1)
  }, HOVER_DELAY_MS)
}
/** Reaching a submenu keeps it: the move there may have crossed a sibling row on the way. */
function onPanelEnter(depth: number): void {
  if (depth > 0) clearTimeout(hoverTimer)
  // The row that opened this panel stays highlighted while the pointer is inside it.
  const parent = levels.value[depth - 1]
  const next = levels.value[depth]
  if (parent && next) {
    const i = parent.items.findIndex((e) => !isSeparator(e) && e.children === next.items)
    if (i >= 0) parent.active = i
  }
}
function onPanelLeave(depth: number): void {
  // Leaving a panel for nowhere clears its highlight unless a submenu hangs off it.
  const level = levels.value[depth]
  if (level && !levels.value[depth + 1]) level.active = -1
}

function onOutside(e: Event): void {
  const target = e.target as Node | null
  if (target && panels.value.some((p) => p?.contains(target))) return
  close()
}
function onScroll(e: Event): void {
  const target = e.target as Node | null
  if (target && panels.value.some((p) => p?.contains(target))) return
  close()
}

// --- keyboard ---
function onKey(e: KeyboardEvent): void {
  if (!levels.value.length) return
  // The menu owns the keyboard while it is open: nothing behind it — the editor's shortcuts, a
  // dialog — sees these keys.
  e.stopPropagation()
  const depth = deepestWithHighlight()
  const level = levels.value[depth]
  switch (e.key) {
    case 'Escape':
      e.preventDefault(); close(); return
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault()
      levels.value.splice(depth + 1)
      level.active = step(level.items, level.active, e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    case 'ArrowRight':
      e.preventDefault()
      if (level.active >= 0) openSub(depth, level.active, true)
      return
    case 'ArrowLeft':
      e.preventDefault()
      if (depth > 0) { levels.value.splice(depth); return }
      if (levels.value.length > 1) levels.value.splice(1)
      return
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (level.active >= 0) activate(depth, level.active)
      return
    case 'Tab':
      e.preventDefault(); return
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    clearTimeout(typedTimer)
    typed += e.key
    typedTimer = setTimeout(() => { typed = '' }, TYPEAHEAD_MS)
    const i = findByPrefix(level.items, level.active, typed)
    if (i >= 0) { level.active = i; levels.value.splice(depth + 1) }
    return
  }
  // Any other key with a modifier (⌘C behind the menu…) is swallowed rather than acted on twice.
  if (e.metaKey || e.ctrlKey) e.preventDefault()
}
/** The panel the keyboard works on: the deepest one with a highlighted row, else the deepest. */
function deepestWithHighlight(): number {
  for (let d = levels.value.length - 1; d >= 0; d--) if (levels.value[d].active >= 0) return d
  return 0
}

function listen(): void {
  window.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('contextmenu', onOutside, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('wheel', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', close)
  window.addEventListener('blur', close)
  window.addEventListener('keydown', onKey, true)
}
function unlisten(): void {
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('contextmenu', onOutside, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('wheel', onScroll, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('blur', close)
  window.removeEventListener('keydown', onKey, true)
}
onBeforeUnmount(() => { clearTimeout(hoverTimer); clearTimeout(typedTimer); unlisten() })

const role = (item: MenuItem): string => (item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem')
/** A column for check marks only when some row in the panel is a toggle, as macOS does. */
const hasChecks = (items: MenuEntry[]): boolean => items.some((e) => !isSeparator(e) && (e.checked !== undefined || !!e.swatch))
const setPanel = (depth: number) => (el: unknown) => { if (el) panels.value[depth] = el as HTMLElement }
</script>

<template>
  <Teleport to="body">
    <template v-for="(level, depth) in levels" :key="depth">
      <div
        :ref="setPanel(depth)"
        class="ctx-menu fk-menu" role="menu" tabindex="-1" data-overlay
        :class="{ checks: hasChecks(level.items) }"
        :style="level.pos ? { left: level.pos.x + 'px', top: level.pos.y + 'px' } : { left: '0px', top: '0px', visibility: 'hidden' }"
        @contextmenu.prevent
        @pointerenter="onPanelEnter(depth)" @pointerleave="onPanelLeave(depth)"
      >
        <template v-for="(entry, i) in level.items" :key="i">
          <div v-if="isSeparator(entry)" class="sep fk-menu-sep" role="separator" />
          <div
            v-else
            class="item fk-menu-item" :data-index="i" :role="role(entry)"
            :aria-checked="entry.checked"
            :aria-disabled="entry.disabled ? 'true' : undefined"
            :aria-haspopup="entry.children ? 'menu' : undefined"
            :aria-expanded="entry.children ? levels[depth + 1]?.items === entry.children : undefined"
            :class="{ active: level.active === i, disabled: entry.disabled, danger: entry.danger }"
            @pointerenter="onEnter(depth, i)"
            @click="activate(depth, i)"
          >
            <span class="mark">
              <span v-if="entry.swatch" class="swatch" :style="{ background: entry.swatch }" />
              <BaseIcon v-else-if="entry.checked" name="check" :size="13" />
            </span>
            <span class="label">{{ entry.label }}</span>
            <span v-if="entry.children" class="fk-menu-tail"><BaseIcon name="chevron-right" :size="13" /></span>
            <span v-else-if="entry.shortcut" class="fk-menu-tail fk-menu-key">{{ entry.shortcut }}</span>
          </div>
        </template>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
/* The panel's and the rows' look is shared with the command palette: `./menu.css`. */
.ctx-menu {
  position: fixed; z-index: 1000;
  min-width: 200px; max-width: min(360px, calc(100vw - 8px)); max-height: calc(100vh - 8px); overflow-y: auto;
  padding: 5px;
  user-select: none; -webkit-user-select: none; cursor: default;
}
.mark { display: none; width: 14px; flex: 0 0 14px; align-items: center; justify-content: center; }
.checks .mark { display: inline-flex; }
.swatch { width: 11px; height: 11px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(127, 127, 127, .45); }
.label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
