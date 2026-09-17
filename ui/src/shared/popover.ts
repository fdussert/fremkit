/**
 * Geometry of the popover a compact navigation-bar widget opens: a box hanging above the bar,
 * horizontally centred on the widget that opened it and kept inside the screen. Pure, so the
 * dashboard and the admin's scaled preview share one rule and it can be tested on its own.
 */

/** A box in the coordinate space the popover is drawn in: the viewport, or the admin's board. */
export interface Box { left: number; top: number; width: number; height: number }

/**
 * What the popover hangs off: the horizontal span of the compact frame, and `top`, the top of the
 * navigation bar — the popover's bottom edge sits one margin above it.
 */
export interface Anchor { left: number; width: number; top: number }

/** The default breathing room between the popover and the screen edges, and the bar. */
export const POPOVER_MARGIN = 16

/**
 * `size` is what the widget asks for (its manifest's `defaultSize` in pixels); the box is clamped
 * to whatever the screen leaves once the margins are taken, then centred on the anchor and pushed
 * back inside the screen when the anchor sits near an edge.
 */
export function popoverRect(
  anchor: Anchor,
  size: { width: number; height: number },
  screen: { width: number; height: number },
  margin: number = POPOVER_MARGIN,
): Box {
  const width = Math.max(0, Math.min(size.width, screen.width - margin * 2))
  // Only the strip above the bar is available, and never more than the screen itself.
  const height = Math.max(0, Math.min(size.height, anchor.top - margin * 2, screen.height - margin * 2))
  const centred = anchor.left + anchor.width / 2 - width / 2
  // Math.max on the upper bound keeps a box wider than the screen pinned to the left margin
  // rather than pulled off the other side.
  const left = Math.min(Math.max(centred, margin), Math.max(margin, screen.width - margin - width))
  const top = Math.max(margin, anchor.top - margin - height)
  return { left, top, width, height }
}
