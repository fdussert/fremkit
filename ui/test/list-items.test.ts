import { describe, expect, it } from 'vitest'
import { gridColumns, itemSummary, moveTo, nestInto, nestedListKey, takeOut, MAX_EDITOR_COLUMNS } from '../src/admin/listItems'
import { fieldShown, type ListItemField, type SettingField } from '../src/shared/types'

const pick = (t: unknown) => (typeof t === 'string' ? t : (t as Record<string, string> | undefined)?.en ?? '')
const buttons: SettingField = {
  type: 'list', label: 'Buttons',
  itemSchema: {
    label: { type: 'string', label: 'Label' },
    kind: { type: 'enum', label: 'Kind', options: [{ value: 'app', label: { fr: 'Application', en: 'Application' } }] },
    target: { type: 'string', label: 'Target' },
    seconds: { type: 'boolean', label: 'Seconds' },
  },
}

describe('itemSummary', () => {
  it('takes the first non-empty field the summary lists', () => {
    const f = { ...buttons, summary: ['label', 'target'] }
    expect(itemSummary({ label: 'Mail', target: 'Mail.app' }, f, pick)).toBe('Mail')
    expect(itemSummary({ label: '  ', target: 'Outline' }, f, pick)).toBe('Outline')
    expect(itemSummary({}, f, pick)).toBe('')
  })
  it('falls back to the first text or choice field with a value, a choice read as its label', () => {
    expect(itemSummary({ kind: 'app', target: 'x' }, buttons, pick)).toBe('Application')
    expect(itemSummary({ seconds: true }, buttons, pick)).toBe('')
  })
})

describe('gridColumns', () => {
  const schema: Record<string, SettingField> = { columns: { type: 'number', label: 'Columns', default: 4 } }
  it('is null without grid, else the count or the setting it names, capped for the editor', () => {
    expect(gridColumns(buttons, schema, {})).toBeNull()
    expect(gridColumns({ ...buttons, grid: 3 }, schema, {})).toBe(3)
    expect(gridColumns({ ...buttons, grid: 'columns' }, schema, {})).toBe(4)
    expect(gridColumns({ ...buttons, grid: 'columns' }, schema, { columns: 5 })).toBe(5)
    expect(gridColumns({ ...buttons, grid: 'columns' }, schema, { columns: 12 })).toBe(MAX_EDITOR_COLUMNS)
  })
  it('keeps a usable grid when the setting holds nonsense', () => {
    expect(gridColumns({ ...buttons, grid: 'columns' }, schema, { columns: 0 })).toBe(4)
    expect(gridColumns({ ...buttons, grid: 'columns' }, schema, { columns: 'x' })).toBe(4)
  })
})

describe('moveTo', () => {
  it('takes the item out and puts it back at the index among the others', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTo(['a', 'b'], 0, 9)).toEqual(['b', 'a'])
    expect(moveTo(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})

describe('a list item holding a list', () => {
  const held: ListItemField = { type: 'list', label: 'Items', max: 2, itemSchema: { label: { type: 'string', label: 'L' }, target: { type: 'string', label: 'T' } } }
  const field: SettingField = { type: 'list', label: 'Buttons', itemSchema: {
    label: { type: 'string', label: 'L' }, kind: { type: 'enum', label: 'K' }, target: { type: 'string', label: 'T' }, items: held,
  } }
  const list = [
    { label: 'Mail', kind: 'app', target: 'Mail', items: [] },
    { label: 'Prod', kind: 'group', target: '', items: [{ label: 'Deploy', target: 'https://example.com/d' }] },
    { label: 'Dev', kind: 'group', target: '', items: [{ label: 'A', target: 'a' }, { label: 'B', target: 'b' }] },
  ]

  it('finds the key of the list an item holds', () => {
    expect(nestedListKey(field)).toBe('items')
    expect(nestedListKey(buttons)).toBeNull()
  })
  it('moves an item into a holder, keeping only the fields held items declare', () => {
    const next = nestInto(list, 0, 1, 'items', held)!
    expect(next.map((i) => i.label)).toEqual(['Prod', 'Dev'])
    expect(next[0].items).toEqual([{ label: 'Deploy', target: 'https://example.com/d' }, { label: 'Mail', target: 'Mail' }])
  })
  it('refuses a full holder, a holder dropped into another, and the item onto itself', () => {
    expect(nestInto(list, 0, 2, 'items', held)).toBeNull()
    expect(nestInto(list, 1, 2, 'items', { ...held, max: 9 })).toBeNull()
    expect(nestInto(list, 1, 1, 'items', held)).toBeNull()
  })
  it('moves a holder into a holder whose items may hold a list, its own items along', () => {
    const deeper: ListItemField = { ...held, max: 9, itemSchema: { ...held.itemSchema, items: { type: 'list', label: 'Sub', itemSchema: held.itemSchema } } }
    const next = nestInto(list, 1, 2, 'items', deeper)!
    expect(next.map((i) => i.label)).toEqual(['Mail', 'Dev'])
    expect(next[1].items).toEqual([{ label: 'A', target: 'a' }, { label: 'B', target: 'b' },
      { label: 'Prod', target: '', items: [{ label: 'Deploy', target: 'https://example.com/d' }] }])
  })
  it('takes an item out, right after its holder, with the fields a new item starts with', () => {
    const next = takeOut(list, 2, 'items', 0, field, { label: '', kind: 'app', target: '', items: [] })
    expect(next.map((i) => i.label)).toEqual(['Mail', 'Prod', 'Dev', 'A'])
    expect(next[2].items).toEqual([{ label: 'B', target: 'b' }])
    expect(next[3]).toEqual({ label: 'A', kind: 'app', target: 'a', items: [] })
  })
})

describe('fieldShown', () => {
  it('shows a field on the items whose siblings hold one of the values it names', () => {
    const f: ListItemField = { type: 'string', label: 'T', showWhen: { kind: ['app', 'url'] } }
    expect(fieldShown(f, { kind: 'url' })).toBe(true)
    expect(fieldShown(f, { kind: 'group' })).toBe(false)
    expect(fieldShown({ type: 'list', label: 'I', showWhen: { kind: 'group' } }, { kind: 'group' })).toBe(true)
    expect(fieldShown({ type: 'string', label: 'X' }, {})).toBe(true)
  })
})
