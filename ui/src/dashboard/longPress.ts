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

/**
 * Two taps close enough in time and place to be one gesture.
 *
 * Counted here rather than left to the browser's own `dblclick`. The driver does post the pair
 * with `clickState: 2`, but it also restores the cursor 0.25 s after a tap while its own
 * double-tap window is 0.3 s — so the pointer can warp away and back *between* the two taps, and
 * that movement resets WebKit's click counting. `dblclick` then never fires, which is exactly
 * what happened on the panel.
 *
 * The window is wider than the driver's 0.3 s because the page sees the taps after the driver
 * has finished with them, and the slop a little wider than its 20 px for the same reason.
 */
export const DOUBLE_TAP_MS = 500
export const DOUBLE_TAP_SLOP = 24

export interface Tap { at: number; x: number; y: number }

export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  if (!previous) return false
  if (tap.at - previous.at > DOUBLE_TAP_MS) return false
  return Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_SLOP
}

/**
 * How long one gesture's echoes go on arriving.
 *
 * Four paths open the admin, because each is the only real one somewhere: the right button for the
 * helper's web view, `contextmenu` for a mouse, the counted taps for the panel, `dblclick` for a
 * browser that does synthesise one. Where two of them *are* real, they both fire for the same
 * gesture — a right click raises the button event and then `contextmenu`, a double tap is counted
 * and then reported — and the dashboard opened two admin windows for one press.
 *
 * So the gesture is what is answered, not the event: the first path through wins and the rest of
 * that gesture is silence. Comfortably longer than the gap between an event and its echo, and
 * comfortably shorter than a person pressing twice on purpose.
 */
export const ADMIN_REPEAT_MS = 700
