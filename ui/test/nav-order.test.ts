import { describe, expect, it } from 'vitest'
import { navStep, placeNav } from '../src/admin/navOrder'
import type { NavItem, NavSlot } from '../src/shared/types'

const item = (instanceId: string, slot: NavSlot, extra: Partial<NavItem> = {}): NavItem => ({ instanceId, slot, ...extra })
/** The bar as it reads: each side's ids in order. */
const sides = (nav: NavItem[] | null) => ({
  left: (nav ?? []).filter((x) => x.slot === 'left').map((x) => x.instanceId),
  right: (nav ?? []).filter((x) => x.slot === 'right').map((x) => x.instanceId),
})

// Stored mixed, as a bar edited over time is: left a, c; right b, d.
const bar = [item('a', 'left'), item('b', 'right'), item('c', 'left'), item('d', 'right')]

describe('placeNav', () => {
  it('reorders within a side, whatever sits between in the stored list', () => {
    expect(sides(placeNav(bar, 'c', 'left', 0))).toEqual({ left: ['c', 'a'], right: ['b', 'd'] })
    expect(sides(placeNav(bar, 'b', 'right', 1))).toEqual({ left: ['a', 'c'], right: ['d', 'b'] })
  })
  it('moves across the dots at the index asked, counted among the other side', () => {
    expect(sides(placeNav(bar, 'a', 'right', 0))).toEqual({ left: ['c'], right: ['a', 'b', 'd'] })
    expect(sides(placeNav(bar, 'a', 'right', 1))).toEqual({ left: ['c'], right: ['b', 'a', 'd'] })
    expect(sides(placeNav(bar, 'd', 'left', 2))).toEqual({ left: ['a', 'c', 'd'], right: ['b'] })
  })
  it('lands on a side that holds nothing yet', () => {
    const allLeft = [item('a', 'left'), item('b', 'left')]
    expect(sides(placeNav(allLeft, 'a', 'right', 0))).toEqual({ left: ['b'], right: ['a'] })
  })
  it('clamps an index past the end to the last place', () => {
    expect(sides(placeNav(bar, 'a', 'right', 99))).toEqual({ left: ['c'], right: ['b', 'd', 'a'] })
  })
  it('keeps the entry\'s other keys and leaves the list it was given alone', () => {
    const nav = [item('a', 'left', { popup: true, popupSize: 'wide' }), item('b', 'left')]
    const placed = placeNav(nav, 'a', 'right', 0)!
    expect(placed.find((x) => x.instanceId === 'a')).toEqual({ instanceId: 'a', slot: 'right', popup: true, popupSize: 'wide' })
    expect(nav[0].slot).toBe('left')
  })
  it('answers null for an entry the bar does not hold', () => {
    expect(placeNav(bar, 'zz', 'left', 0)).toBeNull()
  })
})

describe('navStep', () => {
  it('steps past the neighbour on the same side', () => {
    expect(navStep(bar, 'c', -1)).toEqual({ slot: 'left', index: 0 })
    expect(navStep(bar, 'b', 1)).toEqual({ slot: 'right', index: 1 })
  })
  it('crosses the dots at the end of a side', () => {
    expect(navStep(bar, 'c', 1)).toEqual({ slot: 'right', index: 0 })
    expect(navStep(bar, 'b', -1)).toEqual({ slot: 'left', index: 2 })
  })
  it('stops at either end of the bar', () => {
    expect(navStep(bar, 'a', -1)).toBeNull()
    expect(navStep(bar, 'd', 1)).toBeNull()
    expect(navStep(bar, 'zz', 1)).toBeNull()
  })
})
