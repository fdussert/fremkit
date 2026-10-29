import { describe, expect, it } from 'vitest'
import { gridColumns, itemSummary, moveTo, MAX_EDITOR_COLUMNS } from '../src/admin/listItems'
import type { SettingField } from '../src/shared/types'

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
