/**
 * Where a page dragged in the pages list lands: the index it would have once dropped, given the
 * rows' boxes as they stand (the dragged one included, at `from`) and the pointer's height.
 *
 * Each other row whose middle is above the pointer comes before the dropped page, so their count
 * is its new index. Pure, so the list's geometry is tested without a browser.
 */
export function dropIndex(rows: { top: number; height: number }[], y: number, from: number): number {
  let before = 0
  rows.forEach((r, i) => { if (i !== from && r.top + r.height / 2 < y) before++ })
  return before
}
