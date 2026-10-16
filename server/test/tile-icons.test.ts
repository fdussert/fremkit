import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { MAX_TILE_ICON_BYTES, checkTileIcon, svgHasActiveContent, tileIconContentType } from '../src/tile-icons/routes.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([1, 2])])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'

let dir: string
let app: FastifyInstance
const iconsDir = () => join(dir, 'data', 'tile-icons')
const upload = (name: unknown, data: Buffer | string) =>
  app.inject({ method: 'POST', url: '/api/tile-icons', payload: { name, data: Buffer.from(data).toString('base64') } })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-tile-icons-'))
  await mkdir(join(dir, 'widgets'), { recursive: true })
  await mkdir(join(dir, 'data'), { recursive: true })
  app = await buildApp({ dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
})
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }) })

describe('checkTileIcon', () => {
  it('takes PNG, WebP and SVG', () => {
    expect(checkTileIcon(PNG)).toEqual({ ok: true, type: { ext: 'png', contentType: 'image/png' } })
    expect(checkTileIcon(WEBP)).toEqual({ ok: true, type: { ext: 'webp', contentType: 'image/webp' } })
    expect(checkTileIcon(Buffer.from(SVG))).toEqual({ ok: true, type: { ext: 'svg', contentType: 'image/svg+xml' } })
  })
  it('takes an SVG the way real tools export it', () => {
    const exported = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: an editor -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
      + '<defs><linearGradient id="g"/></defs><rect fill="url(#g)" clip-path="url( \'#c\' )"/><use xlink:href="#g"/><use href = "#g"/></svg>'
    expect(checkTileIcon(Buffer.from(exported)).ok).toBe(true)
  })
  it('refuses JPEG (no alpha, never a usable mask), and what is not an image', () => {
    expect(checkTileIcon(JPEG)).toEqual({ ok: false, reason: 'unsupportedFormat' })
    expect(checkTileIcon(Buffer.from('<html><svg></svg></html>'))).toEqual({ ok: false, reason: 'unsupportedFormat' })
    expect(checkTileIcon(Buffer.from('GIF89a'))).toEqual({ ok: false, reason: 'unsupportedFormat' })
  })
  it('refuses an SVG with active content', () => {
    expect(checkTileIcon(Buffer.from('<svg><script>alert(1)</script></svg>'))).toEqual({ ok: false, reason: 'activeSvg' })
  })
})

describe('svgHasActiveContent', () => {
  it('finds every form of script, handler, external reference and entity', () => {
    for (const bad of [
      '<svg><script>x</script></svg>',
      '<svg><SCRIPT>x</SCRIPT></svg>',
      '<svg>< script>x</script></svg>',
      '<svg/onload=alert(1)>',
      '<svg><rect onclick ="x"/></svg>',
      '<svg><rect\nonmouseover=x/></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>',
      '<svg><iframe/></svg>', '<svg><embed/></svg>', '<svg><object/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
      '<svg><a href="javascript:alert(1)"/></svg>',
      '<svg><a xlink:href = \'https://example.com/x\'/></svg>',
      '<svg><image href=https://example.com/x.png /></svg>',
      '<svg><rect fill="url(https://example.com/x)"/></svg>',
      '<svg><style>@import "https://example.com/x.css";</style></svg>',
    ]) expect(svgHasActiveContent(bad), bad).toBe(true)
  })
  it('lets internal references through', () => {
    for (const ok of [SVG, '<svg><use href="#a"/></svg>', '<svg><use xlink:href = " #a"/></svg>', '<svg><rect fill="url(#g)"/></svg>', '<svg><text>one onion</text></svg>'])
      expect(svgHasActiveContent(ok), ok).toBe(false)
  })
})

describe('tileIconContentType', () => {
  it('maps the stored extension', () => {
    expect(tileIconContentType('1-a.svg')).toBe('image/svg+xml')
    expect(tileIconContentType('1-a.png')).toBe('image/png')
    expect(tileIconContentType('1-a.webp')).toBe('image/webp')
  })
})

describe('POST /api/tile-icons', () => {
  it('stores an icon under data/tile-icons, named from its real type', async () => {
    const res = await upload('nas logo.png', Buffer.from(SVG))
    expect(res.statusCode).toBe(201)
    const { name } = res.json()
    expect(name).toMatch(/^\d+-nas-logo\.svg$/)
    expect(await readdir(iconsDir())).toEqual([name])
    expect(await readFile(join(iconsDir(), name), 'utf8')).toBe(SVG)
  })
  it('refuses a missing or empty payload', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tile-icons', payload: { name: 'x.svg' } })).statusCode).toBe(400)
    expect((await upload('x.svg', '')).statusCode).toBe(400)
  })
  it('refuses JPEG and an active SVG, writing nothing', async () => {
    const jpeg = await upload('x.jpg', JPEG)
    expect(jpeg.statusCode).toBe(400)
    expect(jpeg.json().error).toMatch(/SVG/)
    const active = await upload('x.svg', '<svg onload="x"/>')
    expect(active.statusCode).toBe(400)
    expect(await readdir(iconsDir()).catch(() => [])).toEqual([])
  })
  it('refuses an icon over 256 KiB', async () => {
    const res = await upload('big.png', Buffer.concat([PNG, Buffer.alloc(MAX_TILE_ICON_BYTES)]))
    expect(res.statusCode).toBe(413)
    expect(await readdir(iconsDir()).catch(() => [])).toEqual([])
  })
})

describe('GET /api/tile-icons', () => {
  it('lists the stored icons, sorted, ignoring stray files', async () => {
    await mkdir(iconsDir(), { recursive: true })
    await writeFile(join(iconsDir(), '2-b.svg'), SVG)
    await writeFile(join(iconsDir(), '1-a.png'), PNG)
    await writeFile(join(iconsDir(), '.DS_Store'), 'x')
    await writeFile(join(iconsDir(), 'notes.txt'), 'x')
    const res = await app.inject({ url: '/api/tile-icons' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ names: ['1-a.png', '2-b.svg'] })
  })
  it('answers an empty list before the first import', async () => {
    expect((await app.inject({ url: '/api/tile-icons' })).json()).toEqual({ names: [] })
  })
})

describe('GET /api/tile-icons/:name', () => {
  it('serves the bytes inert: sandbox CSP, nosniff, declared type', async () => {
    const { name } = (await upload('nas.svg', SVG)).json()
    const res = await app.inject({ url: `/api/tile-icons/${name}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.payload).toBe(SVG)
  })
  it('404s on an unknown name and on traversal', async () => {
    await writeFile(join(dir, 'data', 'secret.svg'), 'top secret')
    for (const p of ['1-nope.svg', '..%2Fsecret.svg', '%2e%2e%2fsecret.svg', '.hidden.svg']) {
      const res = await app.inject({ url: `/api/tile-icons/${p}` })
      expect(res.statusCode, p).toBe(404)
      expect(res.payload).not.toContain('top secret')
    }
  })
})

describe('DELETE /api/tile-icons/:name', () => {
  it('removes the file, then 404s', async () => {
    const { name } = (await upload('nas.svg', SVG)).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/tile-icons/${name}` })).statusCode).toBe(200)
    expect(await readdir(iconsDir())).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: `/api/tile-icons/${name}` })).statusCode).toBe(404)
  })
})
