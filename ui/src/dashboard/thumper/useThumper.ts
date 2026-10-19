/**
 * Listens for the thumper on the stage's two edge strips and, when the rhythm is right, calls
 * the worm on this screen only. Nothing leaves the page: no config, no socket, no save.
 */
import { onUnmounted } from 'vue'
import { createRhythm } from './rhythm'
import { playScene, type Scene } from './scene'

export type Side = 'left' | 'right'

export interface ThumperOptions {
  /** The frames the worm may knock about, measured at the moment of the call. */
  targets: () => HTMLElement[]
}

export function useThumper(o: ThumperOptions) {
  const rhythm = createRhythm()
  let press: { x: number; y: number; at: number; button: number; side: Side } | null = null
  let lastSide: Side | null = null
  let scene: Scene | null = null

  // Never inside a frame: the dashboard embedded somewhere is not the screen that was tapped.
  const allowed = () => window.top === window

  function down(e: PointerEvent, side: Side) {
    press = { x: e.clientX, y: e.clientY, at: performance.now(), button: e.button, side }
  }

  function up(e: PointerEvent) {
    const p = press
    press = null
    if (!p || scene || !allowed()) return
    // A rhythm belongs to one edge: switching sides starts it over.
    if (p.side !== lastSide) rhythm.reset()
    lastSide = p.side
    const result = rhythm.press({ down: p.at, up: performance.now(), moved: Math.hypot(e.clientX - p.x, e.clientY - p.y), button: p.button })
    if (result.kind === 'thump') ripple(p.x, p.y, result.count)
    else if (result.kind === 'call') call(p.side)
  }

  function cancel() { press = null; rhythm.reset() }

  function wheel(e: WheelEvent) {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) rhythm.reset()
  }

  function call(side: Side) {
    scene = playScene({ side, calm: reducedMotion(), tiles: o.targets() })
    scene.done.then(() => { scene = null })
  }

  onUnmounted(() => scene?.stop())

  return { down, up, cancel, wheel }
}

/**
 * The sand answering a thump: a ring or two spreading from under the finger, faint enough on
 * the first tap to be missed, a little clearer with each one after. With reduced motion, one ring
 * that only fades where it is.
 */
function ripple(x: number, y: number, count: number) {
  if (typeof document === 'undefined' || !('animate' in HTMLElement.prototype)) return
  const strength = Math.min(1, 0.22 + 0.16 * (count - 1))
  const calm = reducedMotion()
  for (let k = 0; k < (calm ? 1 : 2); k++) {
    const ring = document.createElement('div')
    const size = calm ? 120 : 150 + count * 30
    ring.setAttribute('aria-hidden', 'true')
    Object.assign(ring.style, {
      position: 'fixed', left: x - size / 2 + 'px', top: y - size / 2 + 'px', width: size + 'px', height: size + 'px',
      borderRadius: '50%', pointerEvents: 'none', zIndex: '9997',
      border: `${2 - k * 0.5}px solid rgba(224, 178, 118, ${(strength * (1 - k * 0.4)).toFixed(2)})`,
      boxShadow: `0 0 18px rgba(224, 178, 118, ${(strength * 0.35).toFixed(2)})`,
    })
    document.body.appendChild(ring)
    const anim = ring.animate(
      calm
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ transform: 'scale(0.12)', opacity: 1 }, { transform: 'scale(1)', opacity: 0 }],
      { duration: 900 + k * 250, delay: k * 140, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    )
    anim.onfinish = () => ring.remove()
    anim.oncancel = () => ring.remove()
    // Animations pause where the page is not drawn (a hidden window): the ring goes regardless.
    window.setTimeout(() => ring.remove(), 2500)
  }
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
