import { describe, it, expect } from 'vitest'
import { overlaps, fits, snapPoint, moveRect, resizeRect, firstFreeSpot, shrinkSizes, largestFreeSpot, fitAround, type Grid, type Rect } from '../src/admin/layout'

const grid: Grid = { cols: 64, rows: 16 }
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

describe('overlaps', () => {
  it('is false for rectangles that only touch', () => {
    expect(overlaps(r(0, 0, 4, 4), r(4, 0, 4, 4))).toBe(false)
    expect(overlaps(r(0, 0, 4, 4), r(0, 4, 4, 4))).toBe(false)
  })
  it('is true for a shared corner cell', () => {
    expect(overlaps(r(0, 0, 4, 4), r(3, 3, 4, 4))).toBe(true)
  })
  it('is true when one contains the other, either way round', () => {
    expect(overlaps(r(0, 0, 10, 10), r(2, 2, 2, 2))).toBe(true)
    expect(overlaps(r(2, 2, 2, 2), r(0, 0, 10, 10))).toBe(true)
  })
})

describe('fits', () => {
  it('accepts a rectangle inside an empty grid', () => {
    expect(fits(r(0, 0, 64, 16), grid, [])).toBe(true)
  })
  it('rejects a rectangle past the right or bottom edge', () => {
    expect(fits(r(60, 0, 8, 4), grid, [])).toBe(false)
    expect(fits(r(0, 14, 8, 4), grid, [])).toBe(false)
  })
  it('rejects negative coordinates and empty sizes', () => {
    expect(fits(r(-1, 0, 4, 4), grid, [])).toBe(false)
    expect(fits(r(0, -1, 4, 4), grid, [])).toBe(false)
    expect(fits(r(0, 0, 0, 4), grid, [])).toBe(false)
    expect(fits(r(0, 0, 4, 0), grid, [])).toBe(false)
  })
  it('rejects a rectangle overlapping any other', () => {
    const others = [r(0, 0, 8, 4), r(20, 8, 8, 4)]
    expect(fits(r(8, 0, 8, 4), grid, others)).toBe(true)
    expect(fits(r(7, 0, 8, 4), grid, others)).toBe(false)
    expect(fits(r(24, 10, 8, 4), grid, others)).toBe(false)
  })
})

describe('snapPoint', () => {
  it('rounds pixels to the nearest cell at scale 1', () => {
    expect(snapPoint(0, 0, 40, 1)).toEqual({ x: 0, y: 0 })
    expect(snapPoint(59, 81, 40, 1)).toEqual({ x: 1, y: 2 })
    expect(snapPoint(61, 79, 40, 1)).toEqual({ x: 2, y: 2 })
  })
  it('divides by the preview scale', () => {
    expect(snapPoint(100, 40, 40, 0.5)).toEqual({ x: 5, y: 2 })
    expect(snapPoint(30, 30, 40, 0.25)).toEqual({ x: 3, y: 3 })
  })
})

describe('moveRect', () => {
  it('moves by the given cell delta', () => {
    expect(moveRect(r(4, 4, 8, 4), 3, -2, grid)).toEqual(r(7, 2, 8, 4))
  })
  it('clamps at the left and top edges', () => {
    expect(moveRect(r(2, 1, 8, 4), -10, -10, grid)).toEqual(r(0, 0, 8, 4))
  })
  it('clamps at the right and bottom edges', () => {
    expect(moveRect(r(50, 10, 8, 4), 100, 100, grid)).toEqual(r(56, 12, 8, 4))
  })
  it('never changes the size', () => {
    expect(moveRect(r(0, 0, 64, 16), 5, 5, grid)).toEqual(r(0, 0, 64, 16))
  })
})

describe('resizeRect', () => {
  const start = r(10, 4, 8, 4)
  const min: [number, number] = [4, 2]

  it('grows east and south without moving the opposite edge', () => {
    expect(resizeRect(start, 'e', 3, 0, min, grid)).toEqual(r(10, 4, 11, 4))
    expect(resizeRect(start, 's', 0, 2, min, grid)).toEqual(r(10, 4, 8, 6))
  })
  it('grows west and north by moving the near edge only', () => {
    expect(resizeRect(start, 'w', -4, 0, min, grid)).toEqual(r(6, 4, 12, 4))
    expect(resizeRect(start, 'n', 0, -2, min, grid)).toEqual(r(10, 2, 8, 6))
  })
  it('handles the four corners', () => {
    expect(resizeRect(start, 'se', 2, 2, min, grid)).toEqual(r(10, 4, 10, 6))
    expect(resizeRect(start, 'sw', -2, 2, min, grid)).toEqual(r(8, 4, 10, 6))
    expect(resizeRect(start, 'ne', 2, -2, min, grid)).toEqual(r(10, 2, 10, 6))
    expect(resizeRect(start, 'nw', -2, -2, min, grid)).toEqual(r(8, 2, 10, 6))
  })
  it('never goes below the minimum size', () => {
    expect(resizeRect(start, 'e', -100, 0, min, grid)).toEqual(r(10, 4, 4, 4))
    expect(resizeRect(start, 's', 0, -100, min, grid)).toEqual(r(10, 4, 8, 2))
    expect(resizeRect(start, 'w', 100, 0, min, grid)).toEqual(r(14, 4, 4, 4))
    expect(resizeRect(start, 'n', 0, 100, min, grid)).toEqual(r(10, 6, 8, 2))
  })
  it('stops at the grid edges', () => {
    expect(resizeRect(start, 'e', 100, 0, min, grid)).toEqual(r(10, 4, 54, 4))
    expect(resizeRect(start, 's', 0, 100, min, grid)).toEqual(r(10, 4, 8, 12))
    expect(resizeRect(start, 'w', -100, 0, min, grid)).toEqual(r(0, 4, 18, 4))
    expect(resizeRect(start, 'n', 0, -100, min, grid)).toEqual(r(10, 0, 8, 8))
  })
})

describe('firstFreeSpot', () => {
  it('puts the first widget at the origin', () => {
    expect(firstFreeSpot([8, 4], grid, [])).toEqual(r(0, 0, 8, 4))
  })
  it('scans row by row, left to right', () => {
    expect(firstFreeSpot([8, 4], grid, [r(0, 0, 8, 4)])).toEqual(r(8, 0, 8, 4))
  })
  it('finds an exact hole', () => {
    const small: Grid = { cols: 16, rows: 4 }
    const others = [r(0, 0, 8, 4), r(12, 0, 4, 4)]
    expect(firstFreeSpot([4, 4], small, others)).toEqual(r(8, 0, 4, 4))
  })
  it('returns null on a full page', () => {
    const small: Grid = { cols: 8, rows: 4 }
    expect(firstFreeSpot([8, 4], small, [r(0, 0, 8, 4)])).toBeNull()
  })
  it('returns null when the size is larger than the grid', () => {
    expect(firstFreeSpot([70, 4], grid, [])).toBeNull()
  })
})

describe('shrinkSizes', () => {
  it('starts at the requested size, ends at the minimum, covers every size between', () => {
    const sizes = shrinkSizes([16, 10], [8, 4])
    expect(sizes[0]).toEqual([16, 10])
    expect(sizes[sizes.length - 1]).toEqual([8, 4])
    expect(sizes).toHaveLength(9 * 7)
  })
  it('orders by area, then by closeness to the requested shape', () => {
    expect(shrinkSizes([16, 10], [8, 4]).slice(0, 3)).toEqual([[16, 10], [15, 10], [16, 9]])
    expect(shrinkSizes([8, 10], [8, 4]).slice(0, 2)).toEqual([[8, 10], [8, 9]])
  })
  it('never goes below the minimum, even when asked to', () => {
    expect(shrinkSizes([4, 2], [8, 4])).toEqual([[8, 4]])
  })
})

describe('largestFreeSpot', () => {
  it('keeps the requested size when it fits', () => {
    expect(largestFreeSpot([16, 10], [8, 4], grid, [])).toEqual(r(0, 0, 16, 10))
  })
  it('shrinks to the largest size that fits a crowded page', () => {
    // A 16×16 grid with a 16×10 tile on top leaves a 16×6 strip: 16×10 cannot fit, 16×6 can.
    const page: Grid = { cols: 16, rows: 16 }
    expect(largestFreeSpot([16, 10], [8, 4], page, [r(0, 0, 16, 10)])).toEqual(r(0, 10, 16, 6))
  })
  it('answers null when even the minimum does not fit', () => {
    const page: Grid = { cols: 16, rows: 12 }
    expect(largestFreeSpot([16, 10], [8, 4], page, [r(0, 0, 16, 10)])).toBeNull()
  })
})

describe('fitAround', () => {
  it('centres the default size on the cursor cell', () => {
    expect(fitAround({ x: 20, y: 8 }, [8, 4], [4, 2], grid, [])).toEqual(r(16, 6, 8, 4))
  })
  it('shrinks in place when the default size collides', () => {
    const page: Grid = { cols: 16, rows: 8 }
    const others = [r(0, 0, 16, 4)]
    const rect = fitAround({ x: 8, y: 6 }, [16, 8], [8, 4], page, others)
    expect(fits(rect, page, others)).toBe(true)
    expect(rect.h).toBe(4)
    expect(rect.w).toBe(16)
  })
  it('returns the clamped default size when nothing fits, so the ghost still shows', () => {
    const page: Grid = { cols: 8, rows: 4 }
    expect(fitAround({ x: 4, y: 2 }, [8, 4], [8, 4], page, [r(0, 0, 8, 4)])).toEqual(r(0, 0, 8, 4))
  })
})
