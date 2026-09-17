import { describe, it, expect } from 'vitest'
import { fieldsInScope, type SettingField } from '../src/shared/types'

const field = (scope?: 'tile' | 'compact'): SettingField => ({ type: 'boolean', label: 'x', ...(scope ? { scope } : {}) })
const schema: Record<string, SettingField> = {
  hour12: field(),
  showDate: field('tile'),
  compactDate: field('compact'),
  locale: field(),
}

describe('fieldsInScope', () => {
  it('keeps the unscoped fields and the ones of that scope, in the manifest order', () => {
    expect(Object.keys(fieldsInScope(schema, 'tile'))).toEqual(['hour12', 'showDate', 'locale'])
    expect(Object.keys(fieldsInScope(schema, 'compact'))).toEqual(['hour12', 'compactDate', 'locale'])
  })
  it('shows the whole schema when no scope is asked for', () => {
    expect(Object.keys(fieldsInScope(schema, undefined))).toEqual(Object.keys(schema))
  })
  it('reads a missing schema as an empty one', () => {
    expect(fieldsInScope(undefined, 'tile')).toEqual({})
  })
  it('never hands back the manifest\'s own object, so a caller cannot edit the schema', () => {
    expect(fieldsInScope(schema, undefined)).not.toBe(schema)
  })
})
