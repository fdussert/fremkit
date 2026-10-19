/**
 * @vitest-environment jsdom
 *
 * The worm may knock the tiles about as it likes; what matters is that the screen is exactly
 * what it was once it has gone. So a page of frames is laid out, the scene is run on a clock the
 * test drives, and the markup is compared before and after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playScene } from '../src/dashboard/thumper/scene'
import { T, TIP, buildPath, dimensions, radiusAt, rearing, sampleAt, sandLine } from '../src/dashboard/thumper/timeline'
import type { Frame, Renderer } from '../src/dashboard/thumper/renderer'

let clock = 0
let queued: Array<() => void> = []

/** Runs the scene's frame loop for `seconds` of its clock, one 60 Hz frame at a time. */
function run(seconds: number) {
  const until = clock + seconds * 1000
  while (clock < until && queued.length) {
    clock += 1000 / 60
    const due = queued
    queued = []
    due.forEach((f) => f())
  }
}

/** A page of tiles in a 2560 × 720 screen, each with the inline style a frame really carries. */
function page(rects: Array<[number, number, number, number]>): HTMLElement[] {
  const stage = document.createElement('div')
  stage.className = 'stage'
  document.body.appendChild(stage)
  return rects.map(([x, y, w, h]) => {
    const el = document.createElement('div')
    el.className = 'frame'
    el.setAttribute('style', `left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px; --accent: #d9b36a;`)
    el.innerHTML = '<div class="box"><iframe src="/widgets/clock/index.html"></iframe></div>'
    el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect
    stage.appendChild(el)
    return el
  })
}

function fakeRenderer() {
  const frames: Frame[] = []
  const r: Renderer & { disposed: boolean } = {
    disposed: false,
    draw: (f) => { frames.push({ ...f, spine: { ...f.spine } }) },
    dispose: () => { r.disposed = true },
  }
  return { r, frames }
}

function options(tiles: HTMLElement[], renderer: Renderer, over: Partial<Parameters<typeof playScene>[0]> = {}) {
  return {
    side: 'left' as const, calm: false, tiles,
    now: () => clock,
    frame: (cb: () => void) => { queued.push(cb); return queued.length },
    cancelFrame: () => { queued = [] },
    renderer: () => renderer,
    ...over,
  }
}

beforeEach(() => {
  clock = 0
  queued = []
  document.body.innerHTML = ''
  Object.defineProperty(window, 'innerWidth', { value: 2560, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true })
  // jsdom has no canvas: the cracks simply are not drawn.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => vi.restoreAllMocks())

const BUSY: Array<[number, number, number, number]> = [
  [0, 0, 640, 200], [640, 0, 400, 200], [1040, 0, 560, 200], [1600, 0, 960, 200],
  [0, 200, 640, 440], [640, 200, 560, 240], [1200, 200, 560, 440], [1760, 200, 800, 440],
]

describe('the scene', () => {
  it('knocks the tiles about, then leaves the page exactly as it was', async () => {
    const tiles = page(BUSY)
    const before = document.body.innerHTML
    const { r, frames } = fakeRenderer()
    const scene = playScene(options(tiles, r))
    run(3)
    expect(tiles.some((t) => t.style.transform.includes('rotate'))).toBe(true)
    expect(document.querySelectorAll('canvas')).toHaveLength(2)
    run(T.end + 1)
    await scene.done
    expect(document.body.innerHTML).toBe(before)
    expect(r.disposed).toBe(true)
    expect(frames.length).toBeGreaterThan(300)
  })

  it('works on an empty page', async () => {
    const before = document.body.innerHTML
    const { r, frames } = fakeRenderer()
    const scene = playScene(options([], r, { side: 'right' }))
    run(T.end + 1)
    await scene.done
    expect(document.body.innerHTML).toBe(before)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('comes out of the side that was tapped', () => {
    for (const side of ['left', 'right'] as const) {
      const { r, frames } = fakeRenderer()
      const scene = playScene(options([], r, { side }))
      run(1.6)
      const head = frames.at(-1)!.hx
      expect(side === 'left' ? head < 1280 : head > 1280).toBe(true)
      scene.stop()
    }
  })

  it('stopped half way, still puts everything back', async () => {
    const tiles = page(BUSY)
    const before = document.body.innerHTML
    const { r } = fakeRenderer()
    const scene = playScene(options(tiles, r))
    run(2.5)
    scene.stop()
    await scene.done
    expect(document.body.innerHTML).toBe(before)
    expect(r.disposed).toBe(true)
  })

  it('drops the worm when the GL context is lost, and still puts everything back', async () => {
    const tiles = page(BUSY)
    const before = document.body.innerHTML
    const { r, frames } = fakeRenderer()
    const scene = playScene(options(tiles, r))
    run(1)
    const drawn = frames.length
    document.querySelectorAll('canvas')[1].dispatchEvent(new Event('webglcontextlost'))
    run(1)
    expect(frames.length).toBe(drawn)
    expect(tiles.some((t) => t.style.transform)).toBe(true)
    run(T.end)
    await scene.done
    expect(document.body.innerHTML).toBe(before)
  })

  it('keeps an inline transform a frame already had', async () => {
    const [tile] = page([[0, 0, 640, 300]])
    tile.style.setProperty('transform', 'scale(0.5)', 'important')
    const before = document.body.innerHTML
    const { r } = fakeRenderer()
    const scene = playScene(options([tile], r))
    run(T.end + 1)
    await scene.done
    expect(document.body.innerHTML).toBe(before)
  })

  it('moves nothing in the calm version', async () => {
    const tiles = page(BUSY)
    const before = document.body.innerHTML
    const { r } = fakeRenderer()
    const scene = playScene(options(tiles, r, { calm: true }))
    for (let k = 0; k * 0.5 < T.end + 0.5; k++) {
      run(0.5)
      expect(tiles.every((t) => !t.style.transform)).toBe(true)
    }
    await scene.done
    expect(document.body.innerHTML).toBe(before)
  })
})

describe('the timeline', () => {
  it('keeps the sand off screen before and after the scene', () => {
    expect(sandLine(0, 720)).toBeGreaterThan(720)
    expect(sandLine(T.end, 720)).toBeGreaterThan(720)
    expect(sandLine(3, 720)).toBeLessThan(600)
  })
  it('has the head rear only when it is well out of the sand', () => {
    expect(rearing(700, 576, 720)).toBe(0)
    expect(rearing(100, 576, 720)).toBe(1)
  })
  it('keeps its full girth to the end of the body and closes on a short bullet tip', () => {
    const R = 110, L = 1900, n = 170
    // Full girth along the whole body, up to the tip: no thinning at all.
    for (let s = R * 3; s <= L - TIP * R; s += 10) expect(radiusAt(s, L, R)).toBeCloseTo(R, 1)
    expect(L - TIP * R).toBeGreaterThan(L * 0.93)
    // The tip leaves the body with no kink...
    expect(R - radiusAt(L - TIP * R + 5, L, R)).toBeLessThan(0.5)
    // ...is still most of the girth half way along it and closes round, like a bullet rather
    // than a pencil point...
    expect(radiusAt(L - (TIP * R) / 2, L, R)).toBeGreaterThan(R * 0.78)
    expect(radiusAt(L - (TIP * R) * 0.05, L, R)).toBeGreaterThan(R * 0.2)
    // ...and is closed at the very end: no flat cut for the strip to stop on.
    const radii = Array.from({ length: n }, (_, i) => radiusAt(sampleAt(i, n, L), L, R))
    expect(radii[n - 1]).toBeLessThan(1)
    // Rounded over enough samples to stay smooth.
    expect(radii.filter((r) => r < R * 0.98).length).toBeGreaterThanOrEqual(10)
  })
  it('has the whole body back under the sand before the tiles come back', () => {
    for (const [w, h] of [[2560, 720], [1280, 720], [1440, 900]]) {
      const path = buildPath(w, h), { radius, length } = dimensions(w, h)
      const base = sandLine(3, h)
      const S = path.headAt(T.settle - T.pathStart)
      for (let s = 0; s <= length; s += 10) expect(path.at(S - s).y - radiusAt(s, length, radius)).toBeGreaterThan(base)
    }
  })
  it('crosses the whole screen', () => {
    const path = buildPath(2560, 720)
    expect(path.at(0).x).toBeLessThan(300)
    expect(path.at(path.length).x).toBeGreaterThan(2560)
    expect(path.headAt(10)).toBe(path.length)
  })
})
