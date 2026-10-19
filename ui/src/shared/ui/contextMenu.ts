/**
 * The admin's context menus, as data.
 *
 * A menu is a list built by a function at the moment it opens — so it always reflects the state
 * it was opened on — and drawn by the one `<ContextMenu>` host mounted at the root of the page.
 * Anything that wants a menu calls `openContextMenu(event, items)` from its `contextmenu`
 * handler; the browser's own menu is only suppressed there, never page-wide.
 *
 * The geometry and the keyboard walk are plain functions below, so they are tested on their own.
 */
import { shallowRef, type ShallowRef } from 'vue'

export interface MenuItem {
  label: string
  /** A hint drawn on the right, in the macOS spelling: ⌘D, ⌘C, ⌫. Purely informative. */
  shortcut?: string
  /** A toggle: true draws a check mark, false leaves the room for one. Absent for a plain command. */
  checked?: boolean
  disabled?: boolean
  /** Destructive: drawn in the danger colour. */
  danger?: boolean
  /** A colour chip before the label, for an item that applies a colour. */
  swatch?: string
  /** A submenu. An item with children opens it rather than running anything. */
  children?: MenuEntry[]
  run?: () => void
}

/** A thin rule between groups of items. */
export interface MenuSeparator { separator: true }
export type MenuEntry = MenuItem | MenuSeparator

export const SEPARATOR: MenuSeparator = { separator: true }

export const isSeparator = (entry: MenuEntry): entry is MenuSeparator => 'separator' in entry

/** True for an item the keyboard or the pointer can land on: not a rule, not greyed. */
export const isActionable = (entry: MenuEntry | undefined): entry is MenuItem =>
  !!entry && !isSeparator(entry) && !entry.disabled

/**
 * Drops leading, trailing and doubled separators, so a builder can put rules between groups
 * without caring which groups turned out empty.
 */
export function tidy(entries: (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const e of entries) {
    if (!e) continue
    if (isSeparator(e) && (!out.length || isSeparator(out[out.length - 1]))) continue
    out.push(e)
  }
  while (out.length && isSeparator(out[out.length - 1])) out.pop()
  return out
}

/** Where a menu opens, in viewport pixels. */
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Box { left: number; top: number; width: number; height: number }

/** The gap kept between a menu and the window's edges. */
export const MENU_MARGIN = 4

/**
 * Where a root menu goes: its top-left corner at the pointer, flipped to end at the pointer when
 * it would cross the right or bottom edge — the way macOS does it — and clamped inside the
 * window when even the flip does not fit. A menu taller than the window is pinned to the top and
 * scrolls (the host caps its height).
 */
export function placeMenu(at: Point, size: Size, viewport: Size, margin: number = MENU_MARGIN): Point {
  return {
    x: along(at.x, size.width, viewport.width, margin),
    y: along(at.y, size.height, viewport.height, margin),
  }
}

/** One axis of `placeMenu`: after the pointer, else before it, else as near it as fits. */
function along(at: number, length: number, room: number, margin: number): number {
  if (at + length <= room - margin) return at
  if (at - length >= margin) return at - length
  return Math.max(margin, Math.min(at, room - margin - length))
}

/**
 * Where a submenu goes: beside its parent menu, level with the item that opened it. It opens to
 * the right, and to the left of the parent when the right has no room; vertically it slides up
 * as much as needed to stay inside the window. `padding` lines its first item up with the
 * parent item rather than its top edge.
 */
export function placeSubmenu(parent: Box, item: Box, size: Size, viewport: Size, margin: number = MENU_MARGIN, padding = 5): Point {
  const overlap = 2
  let x = parent.left + parent.width - overlap
  if (x + size.width > viewport.width - margin) {
    const left = parent.left - size.width + overlap
    // Neither side fits: take the one with more room, clamped.
    x = left >= margin || parent.left > viewport.width - parent.left - parent.width ? left : x
  }
  x = Math.min(Math.max(x, margin), Math.max(margin, viewport.width - margin - size.width))
  let y = item.top - padding
  y = Math.min(Math.max(y, margin), Math.max(margin, viewport.height - margin - size.height))
  return { x, y }
}

/**
 * The next item the keyboard lands on from `from`, `delta` steps of ±1, skipping rules and greyed
 * items and wrapping at both ends. From -1 (nothing highlighted) ↓ lands on the first, ↑ on the
 * last. -1 when nothing in the list can be chosen.
 */
export function step(entries: MenuEntry[], from: number, delta: 1 | -1): number {
  const n = entries.length
  if (!n) return -1
  let i = from < 0 ? (delta > 0 ? -1 : n) : from
  for (let k = 0; k < n; k++) {
    i = (i + delta + n) % n
    if (isActionable(entries[i])) return i
  }
  return -1
}

/**
 * Type-ahead: the first choosable item after `from` (wrapping) whose label starts with `prefix`,
 * ignoring case and accents; `from` itself only when nothing else matches. -1 when none does.
 */
export function findByPrefix(entries: MenuEntry[], from: number, prefix: string): number {
  const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const want = fold(prefix)
  if (!want) return -1
  const n = entries.length
  // A repeated single letter cycles through the items starting with it; a longer prefix keeps
  // the current item while it still matches, the way Finder's type-select does.
  const start = want.length > 1 && from >= 0 ? from - 1 : from
  for (let k = 1; k <= n; k++) {
    const i = (((start + k) % n) + n) % n
    const e = entries[i]
    if (isActionable(e) && fold(e.label).startsWith(want)) return i
  }
  return -1
}

/** The menu showing now, if any: where it was asked for and what it holds. */
export interface OpenMenu { at: Point; items: MenuEntry[] }

const current = shallowRef<OpenMenu | null>(null)

/** The open menu, for the host to draw. */
export function useContextMenu(): ShallowRef<OpenMenu | null> { return current }

/**
 * Opens a menu at the pointer of `e` — a `contextmenu` event — and stops the browser's own. An
 * empty list opens nothing and leaves the browser's menu alone.
 */
export function openContextMenu(e: MouseEvent | Point, items: MenuEntry[]): void {
  const entries = tidy(items)
  if (!entries.length) return
  if ('preventDefault' in e) {
    e.preventDefault()
    e.stopPropagation()
    // One pixel in, as macOS does, so the release of the button that opened it lands on no item.
    current.value = { at: { x: e.clientX + 1, y: e.clientY + 1 }, items: entries }
  } else {
    current.value = { at: { x: e.x, y: e.y }, items: entries }
  }
}

export function closeContextMenu(): void { current.value = null }
