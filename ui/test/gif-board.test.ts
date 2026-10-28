import { describe, expect, it, vi } from 'vitest'
import { gifGroupMenu, gifItemMenu } from '../src/admin/gifMenus'
import { createAdminStore } from '../src/admin/store'
import { setLocale } from '../src/shared/i18n'
import { isSeparator, type MenuEntry, type MenuItem } from '../src/shared/ui/contextMenu'
import {
  MAX_GROUPS, MAX_ITEMS, addGroup, addItem, findGiphy, giphyThumbUrl, linkThumbUrl, moveGroup, moveItem, newId,
  removeGroup, removeItem, renameGroup, setLabel,
} from '../src/admin/gifBoard'
import type { Config, GifBoard } from '../src/shared/types'

function board(): GifBoard {
  return {
    groups: [
      { id: 'groupaaaa1', name: 'Yes', items: [
        { id: 'itemaaaaa1', kind: 'giphy', giphyId: 'A1' },
        { id: 'itemaaaaa2', kind: 'giphy', giphyId: 'A2', label: 'two' },
        { id: 'itemaaaaa3', kind: 'link', url: 'https://example.com/a.gif' },
      ] },
      { id: 'groupbbbb1', name: 'No', items: [{ id: 'itembbbbb1', kind: 'giphy', giphyId: 'B1' }] },
    ],
  }
}
const ids = (b: GifBoard, g: number) => b.groups[g].items.map((x) => x.id)

describe('gif board edits', () => {
  it('makes ids the schema accepts', () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[a-z0-9]{10}$/)
  })

  it('adds, renames and removes a group', () => {
    const b: GifBoard = { groups: [] }
    const id = addGroup(b, '  Reactions  ')
    expect(b.groups).toEqual([{ id, name: 'Reactions', items: [] }])
    renameGroup(b, id, 'Mood')
    expect(b.groups[0].name).toBe('Mood')
    renameGroup(b, id, '   ')
    expect(b.groups[0].name).toBe('Mood')
    renameGroup(b, id, 'x'.repeat(60))
    expect(b.groups[0].name).toHaveLength(40)
    removeGroup(b, id)
    expect(b.groups).toEqual([])
  })

  it('adds no group past the limit', () => {
    const b: GifBoard = { groups: [] }
    for (let i = 0; i < MAX_GROUPS; i++) addGroup(b, `g${i}`)
    expect(addGroup(b, 'one more')).toBe('')
    expect(b.groups).toHaveLength(MAX_GROUPS)
  })

  it('adds and removes an item', () => {
    const b = board()
    const id = addItem(b, 'groupbbbb1', { kind: 'link', url: 'https://example.com/b.gif' })
    expect(b.groups[1].items[1]).toEqual({ id, kind: 'link', url: 'https://example.com/b.gif' })
    removeItem(b, id)
    expect(ids(b, 1)).toEqual(['itembbbbb1'])
    expect(addItem(b, 'nowhere', { kind: 'giphy', giphyId: 'X' })).toBe('')
  })

  it('adds no item past the limit', () => {
    const b: GifBoard = { groups: [{ id: 'groupaaaa1', name: 'G', items: [] }] }
    for (let i = 0; i < MAX_ITEMS; i++) addItem(b, 'groupaaaa1', { kind: 'giphy', giphyId: `G${i}` })
    expect(addItem(b, 'groupaaaa1', { kind: 'giphy', giphyId: 'Z' })).toBe('')
  })

  it('moves a group to an index, past the end landing last', () => {
    const b = board()
    b.groups.push({ id: 'groupcccc1', name: 'C', items: [] })
    const order = () => b.groups.map((g) => g.id)
    moveGroup(b, 'groupaaaa1', 2)
    expect(order()).toEqual(['groupbbbb1', 'groupcccc1', 'groupaaaa1'])
    moveGroup(b, 'groupaaaa1', 0)
    expect(order()).toEqual(['groupaaaa1', 'groupbbbb1', 'groupcccc1'])
    moveGroup(b, 'groupbbbb1', 99)
    expect(order()).toEqual(['groupaaaa1', 'groupcccc1', 'groupbbbb1'])
    moveGroup(b, 'gone', 0)
    expect(order()).toEqual(['groupaaaa1', 'groupcccc1', 'groupbbbb1'])
    expect(b.groups[2].items.length).toBeGreaterThan(0)
  })

  it('moves an item within its group and to another, at an index', () => {
    const b = board()
    moveItem(b, 'itemaaaaa1', 'groupaaaa1', 2)
    expect(ids(b, 0)).toEqual(['itemaaaaa2', 'itemaaaaa3', 'itemaaaaa1'])
    moveItem(b, 'itemaaaaa1', 'groupaaaa1', 0)
    expect(ids(b, 0)).toEqual(['itemaaaaa1', 'itemaaaaa2', 'itemaaaaa3'])
    moveItem(b, 'itemaaaaa2', 'groupbbbb1', 0)
    expect(ids(b, 0)).toEqual(['itemaaaaa1', 'itemaaaaa3'])
    expect(ids(b, 1)).toEqual(['itemaaaaa2', 'itembbbbb1'])
    // An index past the end lands last.
    moveItem(b, 'itemaaaaa1', 'groupbbbb1', 99)
    expect(ids(b, 1)).toEqual(['itemaaaaa2', 'itembbbbb1', 'itemaaaaa1'])
    expect(b.groups[1].items[0]).toMatchObject({ label: 'two' })
  })

  it('moves nothing into a full group', () => {
    const b = board()
    for (let i = b.groups[1].items.length; i < MAX_ITEMS; i++) addItem(b, 'groupbbbb1', { kind: 'giphy', giphyId: `F${i}` })
    moveItem(b, 'itemaaaaa1', 'groupbbbb1', 0)
    expect(ids(b, 0)).toContain('itemaaaaa1')
    expect(b.groups[1].items).toHaveLength(MAX_ITEMS)
  })

  it('sets a label, and an empty one removes the key', () => {
    const b = board()
    setLabel(b, 'itemaaaaa1', '  Bravo ')
    expect(b.groups[0].items[0].label).toBe('Bravo')
    setLabel(b, 'itemaaaaa2', '')
    expect('label' in b.groups[0].items[1]).toBe(false)
  })

  it('finds a Giphy GIF in one group only', () => {
    const b = board()
    expect(findGiphy(b, 'groupaaaa1', 'A2')?.id).toBe('itemaaaaa2')
    expect(findGiphy(b, 'groupbbbb1', 'A2')).toBeUndefined()
  })

  it('builds thumbnail addresses', () => {
    expect(giphyThumbUrl('A1')).toBe('https://media.giphy.com/media/A1/200w.gif')
    expect(linkThumbUrl('https://example.com/a b.gif')).toBe('/api/gifs/cached?url=https%3A%2F%2Fexample.com%2Fa%20b.gif')
  })
})

describe('gif board menus', () => {
  async function make() {
    setLocale('en')
    const cfg = {
      version: 4, locale: 'en', connections: [], secrets: { backend: 'file' },
      privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
      widgets: {}, screens: [], gifs: board(),
    } as unknown as Config
    const store = createAdminStore({
      api: {
        getConfig: async () => structuredClone(cfg), getStatus: async () => ({ degraded: false }),
        getWidgets: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
        putConfig: async (c) => c, rescan: async () => ({ widgets: {}, errors: [], sources: {}, asks: {}, sdk: 1 }),
      },
      subscribeConfig: () => () => {},
      debounceMs: 0,
    })
    await store.load()
    return store
  }
  const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => !isSeparator(e))

  it('labels and removes a GIF, each one undoable step', async () => {
    const s = await make()
    const label = vi.fn()
    const menu = items(gifItemMenu(s, 'itemaaaaa1', { label, rename: vi.fn() }))
    expect(menu.map((e) => e.label)).toEqual(['Label…', 'Remove'])
    menu[0].run!()
    expect(label).toHaveBeenCalledWith('itemaaaaa1')
    menu[1].run!()
    expect(s.state.config!.gifs!.groups[0].items.map((x) => x.id)).toEqual(['itemaaaaa2', 'itemaaaaa3'])
    s.undo()
    expect(s.state.config!.gifs!.groups[0].items).toHaveLength(3)
  })

  it('renames a group, and deletes it after naming it in a submenu', async () => {
    const s = await make()
    const rename = vi.fn()
    const menu = items(gifGroupMenu(s, 'groupbbbb1', { label: vi.fn(), rename }))
    expect(menu.map((e) => e.label)).toEqual(['Rename…', 'Delete group'])
    menu[0].run!()
    expect(rename).toHaveBeenCalledWith('groupbbbb1')
    const confirm = items(menu[1].children!)[0]
    expect(confirm.label).toContain('No')
    confirm.run!()
    expect(s.state.config!.gifs!.groups.map((g) => g.id)).toEqual(['groupaaaa1'])
  })

  it('opens no menu on something gone', async () => {
    const s = await make()
    const ui = { label: vi.fn(), rename: vi.fn() }
    expect(gifItemMenu(s, 'nope', ui)).toEqual([])
    expect(gifGroupMenu(s, 'nope', ui)).toEqual([])
  })
})
