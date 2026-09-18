/**
 * Recognising a long press on the Edge, where it does not arrive as a held button.
 *
 * The touch driver turns a press held past its threshold into a **right click**:
 * `rightMouseDown` and `rightMouseUp` back to back (`GestureEngine.endPress`). So the page sees
 * a `pointerdown` and, milliseconds later, a `pointerup` — and then a `contextmenu` event. A
 * timer started on the down and cancelled on the up can never complete.
 *
 * It used to complete by accident: WebKit opened its context menu on the right mouse down and
 * swallowed the matching up while the menu tracked the mouse, so the timer ran on behind it.
 * That is why the menu and the admin window used to appear together, and why removing the menu
 * removed the long press with it.
 *
 * Hence two paths, and this module is the rule for both:
 *
 * - `contextmenu` **is** the long press on the panel; it fires immediately.
 * - the timer is kept for a real mouse and for a held left button, which is what the
 *   plain-Chrome kiosk path produces.
 *
 * DOM-free on purpose, so the decisions can be exercised without a browser.
 */

/** Movement past this many pixels means the finger is swiping, not pressing. */
export const HOLD_SLOP = 10

/**
 * Whether a `pointerdown` should start a hold.
 *
 * Only the primary button. The driver's long press arrives as the *right* button, and letting it
 * start a hold would only have that hold cancelled by its own release a moment later — while
 * also clearing the state the `contextmenu` handler is about to act on.
 */
export function startsHold(button: number): boolean {
  return button === 0
}

/** Whether a move from the press origin has gone far enough to be a swipe. */
export function cancelsHold(origin: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - origin.x, to.y - origin.y) > HOLD_SLOP
}
