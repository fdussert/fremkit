import { deflateSync } from 'node:zlib'
import type { DemoGlyph } from './world.js'

/**
 * Application icons for the demo Dock, drawn here as PNGs.
 *
 * The real icons come from the helper, which reads them off the Mac; demo mode reads nothing off
 * the Mac, and an empty square per app makes the notifications widget look broken in a capture.
 * A rounded square in the app's hue with a simple white glyph, rasterised pixel by pixel from
 * distance functions — no image library, which the server does not depend on.
 */

const SIZE = 128

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** An RGBA image as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // no filter
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

/** Signed distance to a rounded box centred at the origin. */
function roundedBox(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r
  const qy = Math.abs(y) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Distance to a segment, for strokes. */
function segment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - dx * h, py - dy * h)
}

/** Negative inside the glyph, in a coordinate space centred on the icon, one unit per pixel. */
function glyph(kind: DemoGlyph, x: number, y: number): number {
  switch (kind) {
    case 'envelope': {
      const box = Math.abs(roundedBox(x, y, 34, 24, 6)) - 3.5
      const v = Math.min(segment(x, y, -32, -20, 0, 6), segment(x, y, 32, -20, 0, 6)) - 3.5
      return Math.min(box, v)
    }
    case 'bubble': {
      const body = roundedBox(x, y + 4, 34, 24, 14)
      const tail = segment(x, y, -18, 22, -26, 34) - 6
      return Math.min(body, tail)
    }
    case 'grid': {
      let d = Infinity
      for (const cx of [-20, 0, 20]) for (const cy of [-2, 18]) d = Math.min(d, roundedBox(x - cx, y - cy, 7, 7, 2))
      return Math.min(d, roundedBox(x, y + 24, 30, 6, 3))
    }
    case 'check':
      return Math.min(segment(x, y, -26, 2, -8, 20), segment(x, y, -8, 20, 28, -20)) - 7
    case 'ring':
      return Math.abs(Math.hypot(x, y) - 26) - 7
    case 'bars': {
      let d = Infinity
      for (const [cy, hw] of [[-20, 30], [0, 30], [20, 18]] as const) d = Math.min(d, roundedBox(x + (30 - hw), y - cy, hw, 4, 4))
      return d
    }
  }
}

/** One demo app's icon. Antialiased by coverage over a one-pixel ramp of each distance. */
export function demoIcon(hue: number, kind: DemoGlyph): Buffer {
  const rgba = new Uint8Array(SIZE * SIZE * 4)
  const top = hsl(hue, 0.7, 0.6)
  const bottom = hsl((hue + 25) % 360, 0.75, 0.42)
  const c = SIZE / 2
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const x = px + 0.5 - c, y = py + 0.5 - c
      const shape = Math.max(0, Math.min(1, 0.5 - roundedBox(x, y, 58, 58, 26)))
      const mark = Math.max(0, Math.min(1, 0.5 - glyph(kind, x, y)))
      const t = py / SIZE
      const i = (py * SIZE + px) * 4
      for (let k = 0; k < 3; k++) {
        const base = top[k] * (1 - t) + bottom[k] * t
        rgba[i + k] = Math.round(base * (1 - mark) + 255 * mark)
      }
      rgba[i + 3] = Math.round(255 * shape)
    }
  }
  return encodePng(SIZE, SIZE, rgba)
}
