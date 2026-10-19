/**
 * Every keyboard shortcut of the editor, in one table.
 *
 * The editor's key handler (`App.vue`) finds the shortcut a key press means with `matchShortcut`,
 * the keyboard shortcuts sheet lists this table, and the menus take their hints from it
 * (`shortcutHint`): a shortcut added here is handled, listed and hinted, and one changed here
 * cannot leave the sheet saying the old keys.
 */

export type ShortcutId =
  | 'palette' | 'shortcuts' | 'undo' | 'redo'
  | 'duplicate' | 'copy' | 'paste' | 'remove' | 'deselect'
  | 'move' | 'resize' | 'nextWidget' | 'previousWidget'
  | 'selectAll' | 'addToSelection'

/** The sheet's sections, in reading order. */
export const SHORTCUT_GROUPS = ['general', 'widget', 'selection', 'layout'] as const
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]

export interface Shortcut {
  id: ShortcutId
  group: ShortcutGroup
  /**
   * The `KeyboardEvent.key` values that trigger it, compared without case. Empty for a gesture the
   * sheet lists beside the keys (Shift-click) but no key press can match.
   */
  keys: string[]
  /** ⌘ on a Mac, Ctrl elsewhere: either one counts. */
  mod: boolean
  /** Whether Shift must be held (true), must not be (false), or does not matter (absent). */
  shift?: boolean
  /** Works while the cursor is in a text field. Every other shortcut leaves typing alone. */
  inFields?: boolean
  /** What the sheet and the menus show, in the macOS spelling. */
  display: string
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', group: 'general', keys: ['k'], mod: true, shift: false, inFields: true, display: '⌘K' },
  { id: 'shortcuts', group: 'general', keys: ['?'], mod: false, display: '?' },
  { id: 'undo', group: 'general', keys: ['z'], mod: true, shift: false, inFields: true, display: '⌘Z' },
  { id: 'redo', group: 'general', keys: ['z'], mod: true, shift: true, inFields: true, display: '⇧⌘Z' },
  { id: 'duplicate', group: 'widget', keys: ['d'], mod: true, shift: false, display: '⌘D' },
  { id: 'copy', group: 'widget', keys: ['c'], mod: true, shift: false, display: '⌘C' },
  { id: 'paste', group: 'widget', keys: ['v'], mod: true, shift: false, display: '⌘V' },
  { id: 'remove', group: 'widget', keys: ['Delete', 'Backspace'], mod: false, display: '⌫' },
  { id: 'deselect', group: 'widget', keys: ['Escape'], mod: false, display: 'Esc' },
  { id: 'selectAll', group: 'selection', keys: ['a'], mod: true, shift: false, display: '⌘A' },
  { id: 'addToSelection', group: 'selection', keys: [], mod: false, display: '⇧ / ⌘ Click' },
  { id: 'move', group: 'layout', keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], mod: false, shift: false, display: '← → ↑ ↓' },
  { id: 'resize', group: 'layout', keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], mod: false, shift: true, display: '⇧ ← → ↑ ↓' },
  { id: 'nextWidget', group: 'layout', keys: ['Tab'], mod: false, shift: false, display: '⇥' },
  { id: 'previousWidget', group: 'layout', keys: ['Tab'], mod: false, shift: true, display: '⇧⇥' },
]

/** What of a key press `matchShortcut` reads: a `KeyboardEvent` fits. */
export interface KeyPress { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

/**
 * The shortcut a key press means, or null. Option is never part of a shortcut: a key pressed with
 * it is a character being typed (Option+Shift+/ is "¿"), so it matches nothing.
 */
export function matchShortcut(e: KeyPress, inField = false): Shortcut | null {
  if (e.altKey) return null
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  for (const s of SHORTCUTS) {
    if (s.mod !== mod) continue
    if (s.shift !== undefined && s.shift !== e.shiftKey) continue
    if (inField && !s.inFields) continue
    if (s.keys.some((k) => k.toLowerCase() === key)) return s
  }
  return null
}

/** The hint a menu draws beside a command that has a shortcut. */
export function shortcutHint(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)?.display ?? ''
}

/** The table by section, for the sheet. */
export function shortcutsByGroup(): { group: ShortcutGroup; shortcuts: Shortcut[] }[] {
  return SHORTCUT_GROUPS.map((group) => ({ group, shortcuts: SHORTCUTS.filter((s) => s.group === group) }))
}

/** One cell in the direction an arrow key points: what `move` and `resize` step by. */
export const ARROW_DELTAS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
}
