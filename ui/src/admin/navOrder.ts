/**
 * The order of a screen's navigation bar, as the editor moves its entries. The bar reads left to
 * right: the left cluster in stored order, the page dots, then the right cluster. The stored list
 * mixes both sides; only the order within each side means anything. Pure, so it is tested without
 * a store.
 */
import type { NavItem, NavSlot } from '../shared/types'

/**
 * The entries with `id` moved to side `slot`, at `index` among that side's other entries (the
 * moved one left out of the count). Null when the bar holds no such entry.
 */
export function placeNav(nav: NavItem[], id: string, slot: NavSlot, index: number): NavItem[] | null {
  const item = nav.find((x) => x.instanceId === id)
  if (!item) return null
  const rest = nav.filter((x) => x !== item)
  const side = rest.filter((x) => x.slot === slot)
  const moved = { ...item, slot }
  const at = Math.max(0, Math.min(index, side.length))
  if (at < side.length) rest.splice(rest.indexOf(side[at]), 0, moved)
  else if (side.length) rest.splice(rest.indexOf(side[side.length - 1]) + 1, 0, moved)
  else rest.push(moved)
  return rest
}

/**
 * Where one step left (-1) or right (+1) along the bar takes an entry: its neighbour's place on
 * its own side, or across the dots at the end of a side (the last on the left becomes the first on
 * the right, and back). Null at either end of the bar, or for an entry it does not hold.
 */
export function navStep(nav: NavItem[], id: string, delta: -1 | 1): { slot: NavSlot; index: number } | null {
  const item = nav.find((x) => x.instanceId === id)
  if (!item) return null
  const side = nav.filter((x) => x.slot === item.slot)
  const at = side.indexOf(item)
  if (delta < 0) {
    if (at > 0) return { slot: item.slot, index: at - 1 }
    return item.slot === 'right' ? { slot: 'left', index: nav.filter((x) => x.slot === 'left').length } : null
  }
  if (at < side.length - 1) return { slot: item.slot, index: at + 1 }
  return item.slot === 'left' ? { slot: 'right', index: 0 } : null
}
