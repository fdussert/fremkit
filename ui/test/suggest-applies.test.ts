import { describe, it, expect } from 'vitest'
import { suggestApplies, type ListItemField } from '../src/shared/types'

const field = (extra: Partial<ListItemField> = {}): ListItemField =>
  ({ type: 'string', label: 'Cible', ...extra })

describe('suggestApplies', () => {
  it('says no for a field that declares no source', () => {
    expect(suggestApplies(field(), { kind: 'app' })).toBe(false)
  })
  it('says yes on every row when there is no condition', () => {
    expect(suggestApplies(field({ suggest: 'apps' }), { kind: 'url' })).toBe(true)
    expect(suggestApplies(field({ suggest: 'apps' }), {})).toBe(true)
  })
  it('honours a condition on a sibling field', () => {
    const target = field({ suggest: 'apps', suggestWhen: { kind: 'app' } })
    expect(suggestApplies(target, { kind: 'app' })).toBe(true)
    expect(suggestApplies(target, { kind: 'url' })).toBe(false)
    // A row saved before the sibling existed holds nothing under that key.
    expect(suggestApplies(target, {})).toBe(false)
  })
  it('requires every clause of a condition', () => {
    const target = field({ suggest: 'apps', suggestWhen: { kind: 'app', mode: 'open' } })
    expect(suggestApplies(target, { kind: 'app', mode: 'open' })).toBe(true)
    expect(suggestApplies(target, { kind: 'app', mode: 'quit' })).toBe(false)
  })
})
