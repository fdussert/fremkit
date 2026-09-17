// Shared horizontal-swipe gesture handling for dashboard-owned areas (the
// nav bar, the stage, and the two screen-edge strips). Widget iframes are
// sandboxed, so swipes must start here rather than inside a widget.
//
// Two input paths feed the same `onSwipe` callback:
// - a real pointer drag (down/up, 50px threshold);
// - the touch driver's translation of a finger drag into horizontal wheel
//   events (with momentum), which we accumulate and debounce so a single
//   drag doesn't flip several pages.
//
// The touch driver can emit BOTH a pointer drag and wheel events for the
// same finger drag, and their thresholds can cross at slightly different
// times (and even disagree on direction from residual momentum). A shared
// gesture lock makes only the first trigger count: once either path fires
// a swipe, both paths ignore further triggers for LOCK_MS, so a drag never
// "swipes and immediately comes back".
const DRAG_THRESHOLD = 50
const WHEEL_THRESHOLD = 50
const LOCK_MS = 500
const WHEEL_IDLE_RESET_MS = 300

// Module-level, so every useSwipe instance shares one lock: the nav bar and the
// stage are separate instances, and a gesture that crosses from one to the other
// (or a drag on the nav bar followed by momentum wheel events reaching the stage)
// must still count as a single swipe.
let lockUntil = 0

export function useSwipe(onSwipe: (delta: 1 | -1) => void) {
  let startX: number | null = null
  let wheelAcc = 0
  let lastWheelTime = 0

  function trigger(delta: 1 | -1) {
    onSwipe(delta)
    lockUntil = performance.now() + LOCK_MS
  }

  function down(e: PointerEvent) {
    startX = e.clientX
    wheelAcc = 0
    // Best-effort: keep receiving events even if the pointer leaves the
    // element before it is released. Not critical if unsupported.
    try { (e.currentTarget as Element | null)?.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  function up(e: PointerEvent) {
    if (startX === null) return
    const dx = e.clientX - startX
    startX = null
    const now = performance.now()
    if (now >= lockUntil) {
      if (dx <= -DRAG_THRESHOLD) { trigger(1); return }
      if (dx >= DRAG_THRESHOLD) { trigger(-1); return }
    }
    // No trigger (below threshold, or already locked out): still hold the
    // wheel path off for a beat, so momentum wheel events from this same
    // drag don't fire on their own right after.
    lockUntil = now + LOCK_MS
  }
  function cancel() {
    if (startX !== null) lockUntil = performance.now() + LOCK_MS
    startX = null
  }

  function wheel(e: WheelEvent) {
    if (startX !== null) {
      // A pointer gesture owns this drag; swallow the scroll it produces
      // but let the pointer path decide the outcome.
      e.preventDefault()
      return
    }
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    e.preventDefault()
    const now = performance.now()
    if (now < lockUntil) return
    if (now - lastWheelTime > WHEEL_IDLE_RESET_MS) wheelAcc = 0
    lastWheelTime = now
    wheelAcc += e.deltaX
    if (wheelAcc >= WHEEL_THRESHOLD) { wheelAcc = 0; trigger(1) }
    else if (wheelAcc <= -WHEEL_THRESHOLD) { wheelAcc = 0; trigger(-1) }
  }

  return { down, up, cancel, wheel }
}
