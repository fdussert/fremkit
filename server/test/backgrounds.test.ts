import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  MAX_BACKGROUND_BYTES,
  contentTypeFor,
  detectImageType,
  safeBackgroundName,
} from '../src/backgrounds/routes.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([1, 2])])
const GIF = Buffer.from('GIF89a and then some bytes')

let dir: string
let app: FastifyInstance

const upload = (name: unknown, data: Buffer | string) =>
  app.inject({ method: 'POST', url: '/api/backgrounds', payload: { name, data: typeof data === 'string' ? data : data.toString('base64') } })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-bg-'))
  await mkdir(join(dir, 'widgets'), { recursive: true })
  await mkdir(join(dir, 'data'), { recursive: true })
  app = await buildApp({ dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
})
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })

describe('detectImageType', () => {
  it('recognises PNG, JPEG and WebP', () => {
    expect(detectImageType(PNG)).toEqual({ ext: 'png', contentType: 'image/png' })
    expect(detectImageType(JPEG)).toEqual({ ext: 'jpg', contentType: 'image/jpeg' })
    expect(detectImageType(WEBP)).toEqual({ ext: 'webp', contentType: 'image/webp' })
  })
  it('refuses anything else', () => {
    expect(detectImageType(GIF)).toBeNull()
    expect(detectImageType(Buffer.from('<svg/>'))).toBeNull()
    expect(detectImageType(Buffer.alloc(0))).toBeNull()
    // RIFF without the WEBP form (a .wav, say).
    expect(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull()
  })
})

describe('safeBackgroundName', () => {
  const png = { ext: 'png', contentType: 'image/png' }
  it('keeps a plain name, timestamped and re-extended from the real type', () => {
    expect(safeBackgroundName('photo.jpg', png, 42)).toBe('42-photo.png')
  })
  it('strips directories and unsafe characters', () => {
    expect(safeBackgroundName('../../etc/pa ss;wd.png', png, 42)).toBe('42-pa-ss-wd.png')
    expect(safeBackgroundName('a/b/c.png', png, 42)).toBe('42-c.png')
    expect(safeBackgroundName('C:\\temp\\evil.png', png, 42)).toBe('42-evil.png')
  })
  it('never produces .. or a leading dot', () => {
    for (const raw of ['..', '...png', '.hidden.png', '..\\..\\x.png']) {
      const name = safeBackgroundName(raw, png, 42)
      expect(name.includes('..')).toBe(false)
      expect(name.startsWith('.')).toBe(false)
    }
  })
  it('falls back to a placeholder stem', () => {
    expect(safeBackgroundName('', png, 42)).toBe('42-image.png')
    expect(safeBackgroundName(undefined, png, 42)).toBe('42-image.png')
  })
})

describe('contentTypeFor', () => {
  it('maps the stored extension', () => {
    expect(contentTypeFor('1-a.png')).toBe('image/png')
    expect(contentTypeFor('1-a.jpg')).toBe('image/jpeg')
    expect(contentTypeFor('1-a.webp')).toBe('image/webp')
    expect(contentTypeFor('1-a.txt')).toBe('application/octet-stream')
  })
})

describe('POST /api/backgrounds', () => {
  it('stores an image under data/backgrounds and returns its name', async () => {
    const res = await upload('photo.png', PNG)
    expect(res.statusCode).toBe(201)
    const { name } = res.json()
    expect(name).toMatch(/^\d+-photo\.png$/)
    expect(await readdir(join(dir, 'data', 'backgrounds'))).toEqual([name])
    expect(await readFile(join(dir, 'data', 'backgrounds', name))).toEqual(PNG)
  })
  it('names the file from the magic bytes, not from what the client claimed', async () => {
    expect((await upload('lies.png', JPEG)).json().name).toMatch(/\.jpg$/)
  })
  it('refuses a format that is not PNG, JPEG or WebP', async () => {
    const res = await upload('anim.gif', GIF)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/format/)
  })
  it('refuses an empty or missing payload', async () => {
    expect((await upload('x.png', '')).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/backgrounds', payload: { name: 'x.png' } })).statusCode).toBe(400)
  })
  it('refuses an image over 10 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_BACKGROUND_BYTES)])
    const res = await upload('big.png', big)
    expect(res.statusCode).toBe(413)
    expect(await readdir(join(dir, 'data', 'backgrounds')).catch(() => [])).toEqual([])
  })
  it('does not let a crafted name escape the directory', async () => {
    const { name } = (await upload('../../../escaped.png', PNG)).json()
    expect(name.includes('/')).toBe(false)
    expect(await readdir(join(dir, 'data', 'backgrounds'))).toEqual([name])
  })
})

describe('GET /api/backgrounds/:name', () => {
  it('serves the stored bytes with the right content type', async () => {
    const { name } = (await upload('photo.png', PNG)).json()
    const res = await app.inject({ url: `/api/backgrounds/${name}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload).toEqual(PNG)
  })
  it('404s on an unknown name', async () => {
    expect((await app.inject({ url: '/api/backgrounds/1-nope.png' })).statusCode).toBe(404)
  })
  it('refuses traversal, encoded or not', async () => {
    await writeFile(join(dir, 'data', 'secret.txt'), 'top secret')
    for (const p of ['../secret.txt', '%2e%2e%2fsecret.txt', '..%2Fsecret.txt', '..', '.hidden']) {
      const res = await app.inject({ url: `/api/backgrounds/${p}` })
      expect(res.statusCode, p).toBe(404)
      expect(res.payload).not.toContain('top secret')
    }
  })
})

describe('DELETE /api/backgrounds/:name', () => {
  it('removes the file', async () => {
    const { name } = (await upload('photo.png', PNG)).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/backgrounds/${name}` })).statusCode).toBe(200)
    expect(await readdir(join(dir, 'data', 'backgrounds'))).toEqual([])
  })
  it('404s on an unknown name and on traversal', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/backgrounds/1-nope.png' })).statusCode).toBe(404)
    await writeFile(join(dir, 'data', 'secret.txt'), 'top secret')
    expect((await app.inject({ method: 'DELETE', url: '/api/backgrounds/..%2Fsecret.txt' })).statusCode).toBe(404)
    expect(await readFile(join(dir, 'data', 'secret.txt'), 'utf8')).toBe('top secret')
  })
})
