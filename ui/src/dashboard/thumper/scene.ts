/**
 * One passage of the worm, from the call to the last tile back in place.
 *
 * Owns two canvases laid over the whole screen for its duration — a 2D one for the cracks on
 * the knocked tiles, a WebGL one above it for everything else — and the transforms on the
 * frames it was handed. When it ends, or is stopped, both canvases are gone, the GL context is
 * released and every frame's inline style is what it was.
 */
import { MAX_BULGES, SPINE_STRIDE, createRenderer, type Frame, type Renderer } from './renderer'
import { Particles } from './particles'
import { T, PLATE_FLOOR, buildPath, dimensions, facing, mawOpen, radiusAt, rearing, rumble, sampleAt, sandLine, smooth } from './timeline'
import { captureTiles, distanceToTile, knock, prng, restoreTiles, stepTiles, type Tile } from './tiles'

export interface SceneOptions {
  /** The edge that was tapped: the worm comes out of that side. */
  side: 'left' | 'right'
  /** The reduced-motion version: far away, nothing shakes, nothing breaks. */
  calm: boolean
  /** The frames the worm may knock about: whatever the tapped screen shows. */
  tiles: HTMLElement[]
  /** Where the canvases go; the document body by default. */
  host?: HTMLElement
  /** Injected for tests and captures; the page's own clock and frame loop otherwise. */
  now?: () => number
  frame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  renderer?: (canvas: HTMLCanvasElement, scale: number) => Renderer | null
  seed?: number
}

export interface Scene {
  /** Settles when everything is back as it was. */
  done: Promise<void>
  /** Ends it at once, cleanly. */
  stop(): void
}

const SAMPLES = 170
/** Each crack is drawn twice: a pale lip offset by a pixel, then the dark split itself. */
const CRACK_STROKES = [['rgba(255, 238, 214, 0.5)', 1.2, 1, 1], ['rgba(18, 10, 4, 0.9)', 2, 0, 0]] as const
/** Samples of the rounded snout drawn ahead of the head. */
const CAP = 14

export function playScene(o: SceneOptions): Scene {
  const host = o.host ?? document.body
  const now = o.now ?? (() => performance.now())
  const frame = o.frame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = o.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  const w = window.innerWidth, h = window.innerHeight
  const dir = o.side === 'left' ? 1 : -1
  const mirror = (x: number) => (dir > 0 ? x : w - x)
  const scale = Math.min(window.devicePixelRatio || 1, 1.5)
  const rand = prng(o.seed ?? 0.4242)

  const layer = (z: number) => {
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale); c.height = Math.round(h * scale)
    c.setAttribute('aria-hidden', 'true')
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: w + 'px', height: h + 'px', pointerEvents: 'none', zIndex: String(z) })
    host.appendChild(c)
    return c
  }
  const crackCanvas = layer(9998)
  const glCanvas = layer(9999)
  const ctx = crackCanvas.getContext('2d')
  let renderer: Renderer | null = null
  try {
    renderer = (o.renderer ?? createRenderer)(glCanvas, scale)
  } catch (e) {
    // The tiles still play their part; say why the worm itself is missing.
    console.warn('thumper: no renderer', e)
    renderer = null
  }
  // The system can take the GPU back mid-scene (sleep, a driver reset): the worm goes, the tiles
  // keep playing and are put back as usual.
  const onContextLost = () => { renderer = null }
  glCanvas.addEventListener('webglcontextlost', onContextLost)

  const tiles = captureTiles(o.tiles)
  const path = buildPath(w, h, o.calm)
  const dims = dimensions(w, h, o.calm)
  const particles = new Particles(o.calm ? 600 : 7000, rand)
  const spine = new Float32Array(SAMPLES * SPINE_STRIDE)
  const withCap = new Float32Array((SAMPLES + CAP) * SPINE_STRIDE)
  const bulges = new Float32Array(MAX_BULGES * 3)
  const pts = new Float32Array(SAMPLES * 2)
  const point = { x: 0, y: 0 }

  const start = now()
  let last = 0
  let raf = 0
  let finished = false
  let prevHeadY = Infinity
  let resolve!: () => void
  const done = new Promise<void>((r) => { resolve = r })

  function finish() {
    if (finished) return
    finished = true
    cancelFrame(raf)
    restoreTiles(tiles)
    glCanvas.removeEventListener('webglcontextlost', onContextLost)
    renderer?.dispose()
    renderer = null
    crackCanvas.remove(); glCanvas.remove()
    resolve()
  }

  /** The spine at time t, in screen pixels, into `spine`. Returns the head speed in px/s. */
  function buildSpine(t: number): number {
    const tau = t - T.pathStart
    const S = path.headAt(tau)
    const speed = (S - path.headAt(tau - 1 / 60)) * 60
    const L = dims.length
    for (let i = 0; i < SAMPLES; i++) {
      const s = sampleAt(i, SAMPLES, L)
      const p = path.at(S - s, point)
      pts[i * 2] = mirror(p.x); pts[i * 2 + 1] = p.y
    }
    let tx = dir < 0 ? 1 : -1, ty = 0
    for (let i = 0; i < SAMPLES; i++) {
      const a = Math.max(0, i - 1), b = Math.min(SAMPLES - 1, i + 1)
      const dx = pts[b * 2] - pts[a * 2], dy = pts[b * 2 + 1] - pts[a * 2 + 1]
      const len = Math.hypot(dx, dy)
      // Where the body is still bunched at the path's start, keep the last good direction.
      if (len > 0.01) { tx = dx / len; ty = dy / len }
      const s = sampleAt(i, SAMPLES, L)
      // A slow wave running down the body, and the rings breathing with it.
      const env = smooth(0, dims.radius, s)
      const wave = Math.sin(s * 0.011 - t * 6.5) * dims.radius * 0.06 * env
      const r = radiusAt(s, L, dims.radius) * (1 + 0.035 * Math.sin(s * 0.024 - t * 8))
      const k = i * SPINE_STRIDE
      spine[k] = pts[i * 2] - ty * wave; spine[k + 1] = pts[i * 2 + 1] + tx * wave
      spine[k + 2] = tx; spine[k + 3] = ty; spine[k + 4] = r; spine[k + 5] = s
    }
    return speed
  }

  /** The sand line's height at x, mounds included, for the particles to land on. */
  function groundAt(base: number) {
    return (x: number) => {
      let y = base
      for (let i = 0; i < MAX_BULGES; i++) {
        const z = bulges[i * 3 + 2]
        if (z > 0) { const q = (x - bulges[i * 3]) / z; y -= bulges[i * 3 + 1] * Math.exp(-q * q) }
      }
      return y
    }
  }

  function tick() {
    if (finished) return
    const t = (now() - start) / 1000
    if (t >= T.end) { finish(); return }
    const dt = Math.min(1 / 20, Math.max(0, t - last))
    last = t
    const tau = t - T.pathStart
    const base = sandLine(t, h, o.calm)
    const speed = buildSpine(t)
    const hx = spine[0], hy = spine[1]
    const R = dims.radius
    const calm = o.calm

    // Mounds and trenches: a swell ahead of the head while it ploughs just under the surface with
    // a trough behind it, and wherever the body goes through the sand, a heap with a hollow on the
    // side it comes from.
    bulges.fill(0)
    let nb = 0
    const under = hy - base
    if (under > -R * 0.2 && under < h * 0.8) {
      const near = 1 - Math.min(1, Math.max(0, under) / (h * 0.75))
      bulges[0] = hx - spine[2] * R * 0.7; bulges[1] = near * near * h * (calm ? 0.04 : 0.11); bulges[2] = R * 2.4
      bulges[3] = hx + spine[2] * R * 1.8; bulges[4] = -near * near * h * (calm ? 0.015 : 0.04); bulges[5] = R * 1.5
      nb = 2
    }
    for (let i = 0; i < SAMPLES - 1 && nb < MAX_BULGES - 1; i++) {
      const y0 = spine[i * SPINE_STRIDE + 1], y1 = spine[(i + 1) * SPINE_STRIDE + 1]
      if ((y0 < base) !== (y1 < base)) {
        const r = spine[i * SPINE_STRIDE + 4]
        bulges[nb * 3] = spine[i * SPINE_STRIDE]; bulges[nb * 3 + 1] = r * 0.32; bulges[nb * 3 + 2] = r * 1.7
        bulges[nb * 3 + 3] = spine[i * SPINE_STRIDE] - dir * r * 1.5; bulges[nb * 3 + 4] = -r * 0.14; bulges[nb * 3 + 5] = r * 1.1
        nb += 2
        if (!calm) {
          // Sand thrown where the body leaves it, splashed where it goes back in.
          const leaving = y0 < base
          const x = spine[i * SPINE_STRIDE]
          const amount = Math.round(1100 * dt * (r / R))
          particles.spray(amount, x, base - 4, r * 1.8, -Math.PI / 2 + (leaving ? dir * 0.35 : -dir * 0.25), 1.2, leaving ? 720 : 420)
          if (rand() < dt * 3) particles.puff(1, x, base - 20, r * 1.6, dir * 60, 150)
        }
      }
    }

    if (!calm) {
      // The breach and the dive: a burst each.
      if (prevHeadY > base && hy <= base && t > 0.5) {
        particles.spray(1600, hx, base - 6, R * 2.4, -Math.PI / 2, 1.5, 980)
        particles.puff(26, hx, base - 30, R * 3, dir * 80, 220)
      }
      if (prevHeadY <= base && hy > base) {
        particles.spray(700, hx, base - 4, R * 2, -Math.PI / 2 + dir * 0.4, 1.3, 760)
        particles.puff(16, hx, base - 30, R * 2.5, dir * 120, 200)
      }
      // Sand trickling out of the plate seams on whatever is out of the ground: thin streams from
      // the top of each seam, found with the same running plate phase the renderer draws.
      let ph = 0
      for (let i = 1; i < SAMPLES; i++) {
        const k = i * SPINE_STRIDE
        const r = spine[k + 4]
        const prev = ph
        ph += (spine[k + 5] - spine[k + 5 - SPINE_STRIDE]) / (0.42 * Math.max(r, R * PLATE_FLOOR))
        if (Math.floor(ph) === Math.floor(prev)) continue
        const x = spine[k], y = spine[k + 1]
        if (y + r * 0.2 > base) continue
        const nx = -spine[k + 3], ny = spine[k + 2]
        const up = ny < 0 ? 1 : -1
        const n = Math.round(dt * 160 * (r / R) + rand() * 0.7)
        particles.pour(n, x + nx * r * up * 0.9, y + ny * r * up * 0.9, 6, -spine[k + 2] * speed * 0.12)
      }
      // While the ground shakes, dust lifts off it.
      if (t < T.pathStart + 1 && rand() < dt * 14 * rumble(t)) particles.puff(1, rand() * w, base - 10, 200, 0, 170)
    }
    prevHeadY = hy

    // Tiles: knocked where the body, out of the sand, sweeps through them.
    if (!calm && t < T.settle) {
      for (const tile of tiles) {
        if (tile.hitAt !== null) continue
        for (let i = 0; i < SAMPLES; i += 2) {
          const k = i * SPINE_STRIDE
          const x = spine[k], y = spine[k + 1], r = spine[k + 4]
          if (y > base - r * 0.3) continue
          const hit = distanceToTile(tile, x, y)
          if (hit.d < r * 0.9) {
            knock(tile, t, hit.x, hit.y, -spine[k + 2], -spine[k + 3], speed, rand)
            particles.spray(70, hit.x, hit.y, 30, -spine[k + 2] < 0 ? Math.PI : 0, 1.6, 420)
            particles.puff(2, hit.x, hit.y, 40, -spine[k + 2] * 80, 80)
            break
          }
        }
      }
    }
    const shake = (tile: Tile) => {
      if (calm) return 0
      const cx = tile.x + tile.w / 2, cy = tile.y + tile.h / 2
      const near = tau > 0 ? Math.exp(-Math.hypot(cx - hx, cy - hy) / 420) * 0.8 : 0
      return Math.min(1, rumble(t) + near * (1 - smooth(T.settle - 0.4, T.settle, t)))
    }
    if (!calm) stepTiles(tiles, t, dt, shake, h)

    particles.step(dt, groundAt(base))
    drawCracks(t)

    const rear = rearing(hy, base, h)
    const facingNow = facing(rear) * (calm ? 0.4 : 1)
    const r0 = spine[4]
    const fx = -spine[2], fy = -spine[3]
    const openNow = mawOpen(rear) * (calm ? 0.5 : 1)
    const squash = 0.16 + 0.84 * facingNow
    // Shut, the body ends in a blunt rounded snout, its rings running on into it; the maw only
    // takes its place as it opens.
    const capLen = r0 * (0.12 + 0.6 * (1 - openNow))
    for (let j = 0; j < CAP; j++) {
      const d = ((CAP - j) / CAP) * capLen
      const k = j * SPINE_STRIDE
      withCap[k] = hx + fx * d; withCap[k + 1] = hy + fy * d
      withCap[k + 2] = spine[2]; withCap[k + 3] = spine[3]
      withCap[k + 4] = Math.max(1, r0 * Math.sqrt(Math.max(0, 1 - (d / capLen) ** 2)))
      withCap[k + 5] = -d
    }
    withCap.set(spine, CAP * SPINE_STRIDE)
    const fr: Frame = {
      t, w, h, dir, sand: base, bulges,
      sandFade: 1 - smooth(T.sandFall[0] + 0.2, T.sandFall[1], t),
      // Under the sand by now; drawn no longer, so the draining sand cannot uncover it.
      spine: { data: withCap, count: t < T.settle ? SAMPLES + CAP : 0 },
      maw: {
        x: hx + fx * r0 * 0.05, y: hy + fy * r0 * 0.05,
        ax: -fy * r0, ay: fx * r0, bx: fx * r0 * squash, by: fy * r0 * squash,
        r: r0, open: openNow,
      },
      particles: particles.out,
      particleCount: particles.pack(1 - smooth(T.sandFall[0], T.end - 0.2, t)),
      haze: smooth(0.1, 1.4, t) * (1 - smooth(T.sandFall[0], T.end, t)) * (calm ? 0.45 : 1),
      hx, hy,
    }
    renderer?.draw(fr)
    raf = frame(tick)
  }

  function drawCracks(t: number) {
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, crackCanvas.width, crackCanvas.height)
    const fade = 1 - smooth(T.settle, T.settle + 0.7, t)
    if (fade <= 0) return
    for (const tile of tiles) {
      if (!tile.crack) continue
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.translate(tile.x + tile.w / 2 + tile.dx, tile.y + tile.h / 2 + tile.dy)
      ctx.rotate(tile.a)
      ctx.save()
      ctx.beginPath()
      // The frame's box sits 4 px inside it, with rounded corners.
      roundRect(ctx, -tile.w / 2 + 4, -tile.h / 2 + 4, tile.w - 8, tile.h - 8, 10)
      ctx.clip()
      ctx.globalAlpha = fade
      ctx.fillStyle = 'rgba(40, 22, 10, 0.16)'
      ctx.fillRect(-tile.w / 2, -tile.h / 2, tile.w, tile.h)
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      for (const [style, width, ox, oy] of CRACK_STROKES) {
        ctx.strokeStyle = style; ctx.lineWidth = width
        ctx.beginPath()
        for (const line of tile.crack.lines) {
          ctx.moveTo(line[0][0] + ox, line[0][1] + oy)
          for (let k = 1; k < line.length; k++) ctx.lineTo(line[k][0] + ox, line[k][1] + oy)
        }
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  raf = frame(tick)
  return { done, stop: finish }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
