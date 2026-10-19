/**
 * Sand in the air: grains thrown up and falling back under gravity, and slow puffs of dust.
 * Fixed-size typed arrays, so a busy frame allocates nothing.
 */

export const GRAIN = 0
export const PUFF = 1
/** Floats per particle in the buffer the renderer uploads: x, y, size, alpha, shade, kind. */
export const STRIDE = 6

export class Particles {
  readonly capacity: number
  count = 0
  private x: Float32Array; private y: Float32Array
  private vx: Float32Array; private vy: Float32Array
  private life: Float32Array; private span: Float32Array
  private size: Float32Array; private shade: Float32Array; private kind: Uint8Array
  /** What the renderer draws, rebuilt by `pack`. */
  readonly out: Float32Array

  constructor(capacity: number, private rand: () => number) {
    this.capacity = capacity
    this.x = new Float32Array(capacity); this.y = new Float32Array(capacity)
    this.vx = new Float32Array(capacity); this.vy = new Float32Array(capacity)
    this.life = new Float32Array(capacity); this.span = new Float32Array(capacity)
    this.size = new Float32Array(capacity); this.shade = new Float32Array(capacity)
    this.kind = new Uint8Array(capacity)
    this.out = new Float32Array(capacity * STRIDE)
  }

  private add(kind: number, x: number, y: number, vx: number, vy: number, span: number, size: number): void {
    if (this.count >= this.capacity) return
    const i = this.count++
    this.kind[i] = kind
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy
    this.life[i] = 0; this.span[i] = span; this.size[i] = size
    this.shade[i] = this.rand()
  }

  /**
   * Throws `n` grains from around (x, y): `spread` pixels wide, aimed at `angle` (radians, 0 is
   * +x, -π/2 straight up) within `cone`, at `speed` ± half.
   */
  spray(n: number, x: number, y: number, spread: number, angle: number, cone: number, speed: number): void {
    const r = this.rand
    for (let k = 0; k < n; k++) {
      const a = angle + (r() - 0.5) * cone
      const v = speed * (0.5 + r())
      this.add(GRAIN, x + (r() - 0.5) * spread, y + (r() - 0.5) * 6, Math.cos(a) * v, Math.sin(a) * v,
        0.9 + r() * 1.4, 1.2 + r() * r() * 4.2)
    }
  }

  /** Grains slipping off a surface at (x, y): almost no speed, gravity does the rest. */
  pour(n: number, x: number, y: number, spread: number, drift: number): void {
    const r = this.rand
    for (let k = 0; k < n; k++) {
      this.add(GRAIN, x + (r() - 0.5) * spread, y, drift * (0.4 + r() * 0.6) + (r() - 0.5) * 40, -r() * 60,
        0.7 + r() * 0.9, 1 + r() * 2.2)
    }
  }

  /** Dust clouds: big, soft, slow, rising a little and spreading. */
  puff(n: number, x: number, y: number, spread: number, drift: number, size: number): void {
    const r = this.rand
    for (let k = 0; k < n; k++) {
      this.add(PUFF, x + (r() - 0.5) * spread, y + (r() - 0.5) * spread * 0.3, drift * (0.3 + r() * 0.7) + (r() - 0.5) * 80,
        -15 - r() * 35, 1.6 + r() * 1.6, size * (1.8 + r() * 1.2))
    }
  }

  /** Advances `dt` seconds; grains that sink back under the sand line (`ground(x)`) are gone. */
  step(dt: number, ground: (x: number) => number): void {
    let w = 0
    for (let i = 0; i < this.count; i++) {
      const puff = this.kind[i] === PUFF
      this.life[i] += dt
      if (puff) {
        this.vx[i] *= 1 - 0.9 * dt; this.vy[i] *= 1 - 0.7 * dt
        this.size[i] *= 1 + 0.35 * dt
      } else {
        this.vy[i] += 1900 * dt
        this.vx[i] *= 1 - 0.35 * dt
      }
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt
      const dead = this.life[i] >= this.span[i] || (!puff && this.vy[i] > 0 && this.y[i] > ground(this.x[i]) + 6)
      if (dead) continue
      if (w !== i) {
        this.x[w] = this.x[i]; this.y[w] = this.y[i]; this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i]
        this.life[w] = this.life[i]; this.span[w] = this.span[i]; this.size[w] = this.size[i]
        this.shade[w] = this.shade[i]; this.kind[w] = this.kind[i]
      }
      w++
    }
    this.count = w
  }

  /** Fills `out` for the renderer; returns how many particles it holds. `fade` dims them all. */
  pack(fade: number): number {
    const o = this.out
    for (let i = 0; i < this.count; i++) {
      const k = i * STRIDE
      const u = this.life[i] / this.span[i]
      const puff = this.kind[i] === PUFF
      // Grains are solid until the end of their life; dust swells in and thins out.
      const alpha = puff ? Math.sin(Math.PI * Math.min(1, u)) * 0.06 : Math.min(1, (1 - u) * 4)
      o[k] = this.x[i]; o[k + 1] = this.y[i]; o[k + 2] = this.size[i]
      o[k + 3] = alpha * fade; o[k + 4] = this.shade[i]; o[k + 5] = this.kind[i]
    }
    return this.count
  }

  clear(): void { this.count = 0 }
}
