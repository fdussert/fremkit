/**
 * @vitest-environment jsdom
 *
 * The context menu: its geometry and keyboard walk as plain functions, then the host itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ContextMenu from '../src/shared/ui/ContextMenu.vue'
import {
  SEPARATOR, closeContextMenu, findByPrefix, openContextMenu, placeMenu, placeSubmenu, step, tidy, useContextMenu,
  type MenuEntry,
} from '../src/shared/ui/contextMenu'

const vp = { width: 1000, height: 800 }
const size = { width: 200, height: 300 }

describe('placeMenu', () => {
  it('opens at the pointer when there is room', () => {
    expect(placeMenu({ x: 100, y: 100 }, size, vp)).toEqual({ x: 100, y: 100 })
  })
  it('flips left near the right edge and up near the bottom', () => {
    expect(placeMenu({ x: 900, y: 700 }, size, vp)).toEqual({ x: 700, y: 400 })
  })
  it('clamps inside the window when even the flip does not fit', () => {
    expect(placeMenu({ x: 150, y: 250 }, { width: 200, height: 600 }, vp)).toEqual({ x: 150, y: 196 })
    expect(placeMenu({ x: 10, y: 10 }, { width: 2000, height: 2000 }, vp)).toEqual({ x: 4, y: 4 })
  })
})

describe('placeSubmenu', () => {
  const parent = { left: 100, top: 100, width: 220, height: 300 }
  const item = { left: 105, top: 160, width: 210, height: 24 }
  it('opens to the right, level with its item', () => {
    expect(placeSubmenu(parent, item, size, vp)).toEqual({ x: 318, y: 155 })
  })
  it('flips to the left of its parent near the right edge', () => {
    const p = { ...parent, left: 700 }
    expect(placeSubmenu(p, { ...item, left: 705 }, size, vp).x).toBe(502)
  })
  it('slides up to stay above the bottom edge', () => {
    expect(placeSubmenu(parent, { ...item, top: 700 }, size, vp).y).toBe(800 - 4 - 300)
  })
})

describe('step and findByPrefix', () => {
  const items: MenuEntry[] = [
    { label: 'Alpha' }, SEPARATOR, { label: 'Beta', disabled: true }, { label: 'Bravo' }, { label: 'Écran' },
  ]
  it('skips separators and greyed items, wrapping at both ends', () => {
    expect(step(items, -1, 1)).toBe(0)
    expect(step(items, 0, 1)).toBe(3)
    expect(step(items, 4, 1)).toBe(0)
    expect(step(items, -1, -1)).toBe(4)
    expect(step(items, 0, -1)).toBe(4)
    expect(step([SEPARATOR, { label: 'x', disabled: true }], -1, 1)).toBe(-1)
  })
  it('finds by prefix, ignoring case, accents and greyed items', () => {
    expect(findByPrefix(items, -1, 'b')).toBe(3)
    expect(findByPrefix(items, -1, 'e')).toBe(4)
    expect(findByPrefix(items, 3, 'br')).toBe(3)
    expect(findByPrefix(items, -1, 'z')).toBe(-1)
  })
})

describe('tidy', () => {
  it('drops empty groups and stray separators', () => {
    const a = { label: 'a' }
    const b = { label: 'b' }
    expect(tidy([SEPARATOR, a, null, SEPARATOR, false, SEPARATOR, b, SEPARATOR])).toEqual([a, SEPARATOR, b])
  })
})

describe('ContextMenu', () => {
  let wrapper: ReturnType<typeof mount> | null = null
  afterEach(async () => { closeContextMenu(); await nextTick(); wrapper?.unmount(); wrapper = null })

  function open(items: MenuEntry[]) {
    wrapper = mount(ContextMenu, { attachTo: document.body })
    const e = new MouseEvent('contextmenu', { clientX: 20, clientY: 30, cancelable: true })
    openContextMenu(e, items)
    return { wrapper, event: e }
  }
  const panels = () => document.querySelectorAll<HTMLElement>('.ctx-menu')
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

  it('suppresses the browser menu where it opens, and draws the items', async () => {
    const { event } = open([{ label: 'One', shortcut: '⌘D' }, SEPARATOR, { label: 'Two', checked: true }])
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(panels()).toHaveLength(1)
    const rows = panels()[0].querySelectorAll('.item')
    expect(rows[0].textContent).toContain('⌘D')
    expect(rows[1].getAttribute('role')).toBe('menuitemcheckbox')
    expect(rows[1].getAttribute('aria-checked')).toBe('true')
    expect(panels()[0].querySelectorAll('.sep')).toHaveLength(1)
  })

  it('does not open, nor suppress anything, for an empty list', () => {
    const { event } = open([SEPARATOR])
    expect(event.defaultPrevented).toBe(false)
    expect(useContextMenu().value).toBeNull()
  })

  it('runs an item on click and closes', async () => {
    const run = vi.fn()
    open([{ label: 'Go', run }])
    await nextTick()
    panels()[0].querySelector<HTMLElement>('.item')!.click()
    expect(run).toHaveBeenCalledOnce()
    expect(useContextMenu().value).toBeNull()
  })

  it('ignores a click on a greyed item', async () => {
    const run = vi.fn()
    open([{ label: 'No', disabled: true, run }])
    await nextTick()
    panels()[0].querySelector<HTMLElement>('.item')!.click()
    expect(run).not.toHaveBeenCalled()
    expect(useContextMenu().value).not.toBeNull()
  })

  it('walks with the arrows, opens a submenu on → and runs on Enter', async () => {
    const run = vi.fn()
    open([{ label: 'First' }, { label: 'Sub', children: [{ label: 'Inner', run }] }])
    await nextTick()
    key('ArrowDown'); key('ArrowDown'); await nextTick()
    expect(panels()[0].querySelectorAll('.item')[1].classList.contains('active')).toBe(true)
    key('ArrowRight'); await nextTick(); await nextTick()
    expect(panels()).toHaveLength(2)
    expect(panels()[1].querySelector('.item')!.classList.contains('active')).toBe(true)
    key('ArrowLeft'); await nextTick()
    expect(panels()).toHaveLength(1)
    key('ArrowRight'); await nextTick(); await nextTick()
    key('Enter')
    expect(run).toHaveBeenCalledOnce()
    expect(useContextMenu().value).toBeNull()
  })

  it('opens a submenu on hover', async () => {
    vi.useFakeTimers()
    open([{ label: 'Sub', children: [{ label: 'Inner' }] }])
    await nextTick()
    panels()[0].querySelector('.item')!.dispatchEvent(new Event('pointerenter'))
    vi.advanceTimersByTime(200)
    await nextTick(); await nextTick()
    expect(panels()).toHaveLength(2)
    vi.useRealTimers()
  })

  it('keeps the editor from seeing keys while open, and closes on Escape', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    open([{ label: 'A' }])
    await nextTick()
    key('Escape')
    expect(behind).not.toHaveBeenCalled()
    expect(useContextMenu().value).toBeNull()
    window.removeEventListener('keydown', behind)
  })

  it('closes on a press outside, but not on one inside', async () => {
    open([{ label: 'A' }])
    await nextTick()
    panels()[0].dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(useContextMenu().value).not.toBeNull()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(useContextMenu().value).toBeNull()
  })

  it('closes when the window loses focus', async () => {
    open([{ label: 'A' }])
    await nextTick()
    window.dispatchEvent(new Event('blur'))
    expect(useContextMenu().value).toBeNull()
  })

  it('type-ahead highlights the matching item', async () => {
    open([{ label: 'Copy' }, { label: 'Paste' }, { label: 'Duplicate' }])
    await nextTick()
    key('p'); await nextTick()
    expect(panels()[0].querySelectorAll('.item')[1].classList.contains('active')).toBe(true)
  })
})
