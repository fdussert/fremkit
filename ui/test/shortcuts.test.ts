import { describe, expect, it } from 'vitest'
import { matchShortcut, shortcutHint, shortcutsByGroup, SHORTCUTS, SHORTCUT_GROUPS, type KeyPress } from '../src/admin/shortcuts'
import { KEYS } from '../src/admin/canvasMenu'
import { en } from '../src/shared/locales/en'
import { fr } from '../src/shared/locales/fr'

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

describe('the shortcut table', () => {
  it('gives every shortcut a unique id and a section', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(s.group)
    expect(shortcutsByGroup().flatMap((g) => g.shortcuts)).toHaveLength(SHORTCUTS.length)
  })

  it('names every shortcut and every section in both languages', () => {
    for (const dict of [en, fr]) {
      for (const s of SHORTCUTS) expect(dict[`admin.shortcuts.${s.id}`], s.id).toBeTruthy()
      for (const g of SHORTCUT_GROUPS) expect(dict[`admin.shortcuts.group.${g}`], g).toBeTruthy()
    }
  })

  it('never lets two shortcuts claim the same key press', () => {
    const presses: KeyPress[] = []
    for (const s of SHORTCUTS) {
      for (const key of s.keys) {
        for (const shiftKey of [false, true]) presses.push(press(key, { metaKey: s.mod, shiftKey }))
      }
    }
    for (const p of presses) {
      const hits = SHORTCUTS.filter((s) => s.mod === (p.metaKey || p.ctrlKey)
        && (s.shift === undefined || s.shift === p.shiftKey)
        && s.keys.some((k) => k.toLowerCase() === p.key.toLowerCase()))
      expect(hits.length, `${p.key} shift=${p.shiftKey}`).toBeLessThanOrEqual(1)
    }
  })

  it('is where the menus read their hints', () => {
    expect(KEYS).toEqual({ duplicate: '⌘D', copy: '⌘C', paste: '⌘V', remove: '⌫' })
    expect(shortcutHint('palette')).toBe('⌘K')
  })
})

describe('matchShortcut', () => {
  it('reads ⌘ and Ctrl alike, and Shift where it matters', () => {
    expect(matchShortcut(press('k', { metaKey: true }))?.id).toBe('palette')
    expect(matchShortcut(press('K', { ctrlKey: true }))?.id).toBe('palette')
    expect(matchShortcut(press('z', { metaKey: true }))?.id).toBe('undo')
    expect(matchShortcut(press('Z', { metaKey: true, shiftKey: true }))?.id).toBe('redo')
    expect(matchShortcut(press('ArrowLeft'))?.id).toBe('move')
    expect(matchShortcut(press('ArrowLeft', { shiftKey: true }))?.id).toBe('resize')
    expect(matchShortcut(press('Tab', { shiftKey: true }))?.id).toBe('previousWidget')
    expect(matchShortcut(press('a', { metaKey: true }))?.id).toBe('selectAll')
    // ⌘A in a text field selects its text, as it always has.
    expect(matchShortcut(press('a', { metaKey: true }), true)).toBeNull()
    // "?" is Shift+/ on one keyboard and Shift+, on another: Shift is not part of it.
    expect(matchShortcut(press('?', { shiftKey: true }))?.id).toBe('shortcuts')
  })

  it('leaves a plain letter, an Option chord and typing in a field alone', () => {
    expect(matchShortcut(press('k'))).toBeNull()
    expect(matchShortcut(press('d', { metaKey: true, altKey: true }))).toBeNull()
    expect(matchShortcut(press('Backspace'), true)).toBeNull()
    expect(matchShortcut(press('ArrowUp'), true)).toBeNull()
    expect(matchShortcut(press('?'), true)).toBeNull()
    expect(matchShortcut(press('d', { metaKey: true }), true)).toBeNull()
  })

  it('keeps undo, redo and the palette working in a field', () => {
    expect(matchShortcut(press('z', { metaKey: true }), true)?.id).toBe('undo')
    expect(matchShortcut(press('k', { metaKey: true }), true)?.id).toBe('palette')
  })
})
