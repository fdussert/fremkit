/**
 * Pure layout engine for the admin editor: no DOM, no Vue, no config types.
 * Everything is expressed in grid cells; the preview scale only enters snapPoint.
 */

export type Rect = { x: number; y: number; w: number; h: number }
export type Grid = { cols: number; rows: number }
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Two rectangles share at least one cell. Touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** The rectangle is non-empty, fully inside the grid, and clear of every other rectangle. */
export function fits(rect: Rect, grid: Grid, others: Rect[]): boolean {
  if (rect.w < 1 || rect.h < 1) return false
  if (rect.x < 0 || rect.y < 0) return false
  if (rect.x + rect.w > grid.cols || rect.y + rect.h > grid.rows) return false
  return !others.some((o) => overlaps(rect, o))
}

/** Pixels measured on the scaled preview to the nearest grid cell. */
export function snapPoint(px: number, py: number, cell: number, scale: number): { x: number; y: number } {
  const size = cell * scale
  return { x: Math.round(px / size), y: Math.round(py / size) }
}

/** Translate by whole cells, clamped so the rectangle stays fully on screen. Size never changes. */
export function moveRect(rect: Rect, dx: number, dy: number, grid: Grid): Rect {
  return {
    x: clamp(rect.x + dx, 0, grid.cols - rect.w),
    y: clamp(rect.y + dy, 0, grid.rows - rect.h),
    w: rect.w,
    h: rect.h,
  }
}

/**
 * Resize from one of the eight handles. The opposite edge stays put, the result never
 * goes below `min` and never leaves the grid.
 */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number, min: [number, number], grid: Grid): Rect {
  const [minW, minH] = min
  let { x, y, w, h } = rect
  if (handle.includes('w')) {
    const nx = clamp(x + dx, 0, x + w - minW)
    w += x - nx
    x = nx
  }
  if (handle.includes('e')) w = clamp(w + dx, minW, grid.cols - x)
  if (handle.includes('n')) {
    const ny = clamp(y + dy, 0, y + h - minH)
    h += y - ny
    y = ny
  }
  if (handle.includes('s')) h = clamp(h + dy, minH, grid.rows - y)
  return { x, y, w, h }
}

/** Row-by-row scan for the first free rectangle of that size, or null when the page is full. */
export function firstFreeSpot(size: [number, number], grid: Grid, others: Rect[]): Rect | null {
  const [w, h] = size
  for (let y = 0; y + h <= grid.rows; y++) {
    for (let x = 0; x + w <= grid.cols; x++) {
      const rect = { x, y, w, h }
      if (fits(rect, grid, others)) return rect
    }
  }
  return null
}

/**
 * Every size between `min` and `size`, largest area first; among equal areas the one closest
 * to the requested shape wins. A 16×10 tile with a 8×4 floor thus tries 16×10, 16×9, 15×10 …
 * and lands in a 16×6 strip as 16×6, not as some thinner leftover.
 */
export function shrinkSizes(size: [number, number], min: [number, number]): [number, number][] {
  const [minW, minH] = min
  const [maxW, maxH] = [Math.max(size[0], minW), Math.max(size[1], minH)]
  const aspect = maxW / maxH
  const out: [number, number][] = []
  for (let w = maxW; w >= minW; w--) for (let h = maxH; h >= minH; h--) out.push([w, h])
  return out.sort((a, b) => (b[0] * b[1]) - (a[0] * a[1]) || Math.abs(a[0] / a[1] - aspect) - Math.abs(b[0] / b[1] - aspect))
}

/**
 * The first free rectangle at the requested size, or the largest smaller one down to `min`:
 * a full page still answers null, a crowded one answers a smaller tile the user can then resize.
 */
export function largestFreeSpot(size: [number, number], min: [number, number], grid: Grid, others: Rect[]): Rect | null {
  for (const candidate of shrinkSizes(size, min)) {
    const spot = firstFreeSpot(candidate, grid, others)
    if (spot) return spot
  }
  return null
}

/**
 * A rectangle centred on the cursor cell, shrunk from `size` down to `min` until it fits.
 * Used while dragging a card from the library: the ghost follows the finger at the size that fits.
 */
export function fitAround(cell: { x: number; y: number }, size: [number, number], min: [number, number], grid: Grid, others: Rect[]): Rect {
  const place = ([w, h]: [number, number]): Rect => ({
    x: clamp(cell.x - Math.floor(w / 2), 0, Math.max(0, grid.cols - w)),
    y: clamp(cell.y - Math.floor(h / 2), 0, Math.max(0, grid.rows - h)),
    w, h,
  })
  const sizes = shrinkSizes(size, min)
  for (const candidate of sizes) {
    const rect = place(candidate)
    if (fits(rect, grid, others)) return rect
  }
  return place(sizes[0])
}

/**
 * The step (`dx`, `dy`) a group of rectangles can take as one block: cut short so the block stays
 * fully on screen, like `moveRect` does for one. Their sizes and their places relative to each
 * other never change.
 */
export function groupDelta(rects: Rect[], dx: number, dy: number, grid: Grid): { dx: number; dy: number } {
  if (!rects.length) return { dx: 0, dy: 0 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { dx: clamp(dx, -x0, grid.cols - x1), dy: clamp(dy, -y0, grid.rows - y1) }
}

/** Every rectangle shifted by (`dx`, `dy`). */
export const shiftAll = (rects: Rect[], dx: number, dy: number): Rect[] => rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))

/**
 * Row-by-row scan for the first place a whole group fits as one block, its rectangles kept where
 * they are relative to each other: the shift that takes them there, or null when there is none.
 * Rectangles of the group never collide with each other, only with `others`.
 */
export function firstFreeBlock(rects: Rect[], grid: Grid, others: Rect[]): { dx: number; dy: number } | null {
  if (!rects.length) return null
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x0
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y0
  for (let y = 0; y + h <= grid.rows; y++) {
    for (let x = 0; x + w <= grid.cols; x++) {
      const moved = shiftAll(rects, x - x0, y - y0)
      if (moved.every((r) => fits(r, grid, others))) return { dx: x - x0, dy: y - y0 }
    }
  }
  return null
}
