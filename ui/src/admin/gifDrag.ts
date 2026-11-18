/**
 * Where a GIF dragged in the GIF board panel lands. The grid counterpart of `pageDrag.ts`, whose
 * list is one column: here thumbnails wrap into rows. Pure, so the geometry is tested without a
 * browser; the panel drags with pointer events, as the pages list does, because a WKWebView does
 * not deliver HTML drag and drop reliably.
 */
export interface Box { left: number; top: number; width: number; height: number }

/**
 * The index the dragged GIF has once dropped in a group, given the group's thumbnails as they
 * stand (the dragged one included at `from` when it comes from this group, else `from` = -1) and
 * the pointer. A thumbnail comes before the drop when its whole row is above the pointer, or when
 * it is on the pointer's row with its middle left of the pointer.
 */
export function gridDropIndex(boxes: Box[], x: number, y: number, from: number): number {
  let before = 0
  boxes.forEach((b, i) => {
    if (i === from) return
    const rowAbove = b.top + b.height <= y
    const sameRow = y >= b.top && y < b.top + b.height
    if (rowAbove || (sameRow && b.left + b.width / 2 < x)) before++
  })
  return before
}

/**
 * The thumbnail the drop line is drawn before: the one at `to` among the others once the dragged
 * GIF is taken out. Null when it lands last (the line goes after the last thumbnail), and
 * `undefined` when the drop would change nothing.
 */
export function dropMarker(ids: string[], draggedId: string, to: number): string | null | undefined {
  const from = ids.indexOf(draggedId)
  if (from >= 0 && from === to) return undefined
  const others = ids.filter((id) => id !== draggedId)
  return to < others.length ? others[to] : null
}
