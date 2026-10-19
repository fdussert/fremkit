/**
 * Alignment guides for the editor's canvas: pure geometry, in grid cells, no DOM.
 *
 * While a tile is dragged or resized, a guide is a line drawn where one of its edges lines up with
 * an edge of another tile of the page or of the board, or where its centre lines up with theirs.
 * Edges match edges (left or right alike, so two tiles side by side show the line they share) and
 * centres match centres; an edge against a centre is noise on a grid this coarse and is left out.
 *
 * There is no snapping here. Tiles sit on whole cells, so every edge alignment the grid can show is
 * one the grid already lands on; and a centre falls on a half cell, so two centres of different
 * parity can never line up whatever the snap does. A magnet within a cell would only make a
 * one-cell gutter — the commonest gap on the Edge — impossible to reach with the mouse.
 */
import type { Grid, Handle, Rect } from './layout'

/**
 * One line. `axis` is the coordinate the line sits on: `x` is a vertical line at `x = at`, `y`
 * a horizontal one at `y = at`. It spans `from`–`to` on the other axis, covering the moved tile
 * and every tile it lines up with there. `at` may fall on a half cell (a centre).
 */
export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number; kind: 'edge' | 'center' }

type Feature = 'start' | 'center' | 'end'
const ALL: Feature[] = ['start', 'center', 'end']

/** The features of a rect on one axis that a resize from `handle` moves; all of them for a move. */
function moving(axis: 'x' | 'y', handle?: Handle): Feature[] {
  if (!handle) return ALL
  const [lo, hi] = axis === 'x' ? ['w', 'e'] : ['n', 's']
  const out: Feature[] = []
  if (handle.includes(lo)) out.push('start')
  if (handle.includes(hi)) out.push('end')
  if (out.length) out.push('center')
  return out
}

function featureAt(r: Rect, axis: 'x' | 'y', f: Feature): number {
  const start = axis === 'x' ? r.x : r.y
  const size = axis === 'x' ? r.w : r.h
  return f === 'start' ? start : f === 'end' ? start + size : start + size / 2
}

/** The span of a rect on the axis the line runs along. */
function span(r: Rect, axis: 'x' | 'y'): [number, number] {
  return axis === 'x' ? [r.y, r.y + r.h] : [r.x, r.x + r.w]
}

/**
 * The guides for `rect` — the tile, or the box around a group, being moved or resized — against
 * the page's other tiles (`others`, the moved ones left out) and the board. Given a `handle`, only
 * the edges that handle moves (and the centre on that axis) are compared: the edge a resize leaves
 * where it was says nothing new. One guide per line, spanning everything that meets on it.
 */
export function alignmentGuides(rect: Rect, others: Rect[], grid: Grid, handle?: Handle): Guide[] {
  const board: Rect = { x: 0, y: 0, w: grid.cols, h: grid.rows }
  const lines = new Map<string, Guide>()
  for (const axis of ['x', 'y'] as const) {
    for (const f of moving(axis, handle)) {
      const at = featureAt(rect, axis, f)
      const kind = f === 'center' ? 'center' : 'edge'
      // Edges against edges, centres against centres.
      const against: Feature[] = kind === 'center' ? ['center'] : ['start', 'end']
      for (const o of [...others, board]) {
        if (!against.some((g) => featureAt(o, axis, g) === at)) continue
        const key = `${axis}:${at}`
        // The board's line runs its whole length; a tile's covers both tiles.
        const [a0, a1] = span(rect, axis)
        const [b0, b1] = span(o, axis)
        const from = Math.min(a0, b0)
        const to = Math.max(a1, b1)
        const prev = lines.get(key)
        lines.set(key, prev
          ? { ...prev, from: Math.min(prev.from, from), to: Math.max(prev.to, to), kind: prev.kind === 'center' || kind === 'center' ? 'center' : 'edge' }
          : { axis, at, from, to, kind })
      }
    }
  }
  return [...lines.values()].sort((a, b) => (a.axis === b.axis ? a.at - b.at : a.axis < b.axis ? -1 : 1))
}

/** The smallest rect holding all of `rects`: what a group is aligned by. Null for none. */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const x2 = Math.max(...rects.map((r) => r.x + r.w))
  const y2 = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: x2 - x, h: y2 - y }
}
