import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ManifestSchema, PREVIEW_MAX_BYTES, expectedPreviewSize, previewImageInfo, previewProblems,
} from '../src/widgets/manifest.js'
import { encodePng } from '../src/demo/icons.js'
import { checkWidgetFolder } from '../src/widgets/check.js'
import { scaffoldWidget } from '../src/widgets/scaffold.js'
import { InstallError, readPackage, sha256 } from '../src/marketplace/install.js'
import { writeZip } from '../src/backup/zip.js'
import { previewSettings } from '../src/cli/preview.js'

const png = (w: number, h: number): Buffer => encodePng(w, h, new Uint8Array(w * h * 4))

/** The smallest lossless WebP header: `RIFF…WEBPVP8L`, then the 14-bit width and height minus one. */
function webpLossless(w: number, h: number): Buffer {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  const data = Buffer.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0])
  const chunk = Buffer.concat([Buffer.from('VP8L'), Buffer.from([data.length, 0, 0, 0]), data])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(4 + chunk.length)
  return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), chunk])
}

describe('the preview field', () => {
  const base = { id: 'w', name: 'W', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }
  it('accepts a relative .webp or .png of the folder', () => {
    for (const preview of ['preview.webp', 'preview.png', 'assets/shot-2x.webp']) {
      expect(ManifestSchema.safeParse({ ...base, preview }).success, preview).toBe(true)
    }
  })
  it('refuses a path out of the folder, a dotfile, another format', () => {
    for (const preview of ['../x.webp', '/abs.png', 'a/../b.png', '.hidden.png', 'preview.jpg', 'preview.svg', 'preview.webp?x', 'a\\b.png', '']) {
      expect(ManifestSchema.safeParse({ ...base, preview }).success, preview).toBe(false)
    }
  })
})

describe('previewImageInfo', () => {
  it('reads the size of a PNG and of a lossless WebP', () => {
    expect(previewImageInfo(png(640, 320))).toEqual({ format: 'png', width: 640, height: 320 })
    expect(previewImageInfo(webpLossless(1280, 800))).toEqual({ format: 'webp', width: 1280, height: 800 })
  })
  it('answers null for anything else', () => {
    expect(previewImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(previewImageInfo(Buffer.alloc(0))).toBeNull()
  })
})

describe('previewProblems', () => {
  const manifest = { preview: 'preview.webp', defaultSize: [8, 4] as [number, number] }
  it('is happy with a WebP of twice the default size', () => {
    const want = expectedPreviewSize(manifest.defaultSize)
    expect(want).toEqual({ width: 640, height: 320 })
    expect(previewProblems(manifest, webpLossless(640, 320), { checkSize: true })).toEqual([])
    // About: a few pixels off is fine.
    expect(previewProblems(manifest, webpLossless(630, 330), { checkSize: true })).toEqual([])
  })
  it('names a missing file, a wrong format, an oversized file, wrong dimensions', () => {
    expect(previewProblems(manifest, null).join()).toMatch(/not in the package/)
    expect(previewProblems(manifest, png(640, 320)).join()).toMatch(/not a WEBP image/)
    const big = Buffer.concat([webpLossless(640, 320), Buffer.alloc(PREVIEW_MAX_BYTES)])
    expect(previewProblems(manifest, big).join()).toMatch(/over the 204800 allowed/)
    expect(previewProblems(manifest, webpLossless(320, 160), { checkSize: true }).join()).toMatch(/should be about 640×320/)
    // The installer does not look at the dimensions.
    expect(previewProblems(manifest, webpLossless(320, 160))).toEqual([])
  })
  it('says nothing when there is no preview', () => {
    expect(previewProblems({ defaultSize: [8, 4] }, null)).toEqual([])
  })
})

describe('the installer', () => {
  const MANIFEST = { id: 'demo', name: 'Demo', version: '1.0.0', sdk: 1, minSize: [8, 4], defaultSize: [8, 4], preview: 'preview.png' }
  const pack = (extra: { name: string; data: Buffer }[]): Buffer => writeZip([
    { name: 'index.html', data: Buffer.from('<html></html>') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
    ...extra,
  ], new Date(Date.UTC(1980, 0, 1)))
  const expected = (zip: Buffer) => ({ id: 'demo', sha256: sha256(zip), size: zip.byteLength })

  it('installs a package carrying the preview it names', () => {
    const zip = pack([{ name: 'preview.png', data: png(64, 32) }])
    expect(readPackage(zip, expected(zip)).kind).toBe('widget')
  })
  it('refuses a package whose named preview is missing or is not the image it claims', () => {
    for (const extra of [[], [{ name: 'preview.png', data: Buffer.from('<svg/>') }]]) {
      const zip = pack(extra)
      expect(() => readPackage(zip, expected(zip))).toThrow(InstallError)
    }
  })
})

describe('widget:check', () => {
  async function folderWith(preview: Buffer | null): Promise<string> {
    const files = scaffoldWidget({ id: 'my-widget', name: { fr: 'W', en: 'W' }, description: { fr: 'Une ligne', en: 'One line' }, category: 'info', size: [8, 4], author: 'someone' })
    const manifest = JSON.parse(files['manifest.json'])
    if (preview) manifest.preview = 'preview.png'
    files['manifest.json'] = JSON.stringify(manifest)
    const folder = join(await mkdtemp(join(tmpdir(), 'preview-')), 'my-widget')
    await mkdir(folder)
    for (const [name, content] of Object.entries(files)) await writeFile(join(folder, name), content)
    if (preview) await writeFile(join(folder, 'preview.png'), preview)
    return folder
  }
  it('warns about a missing preview, without refusing the widget', async () => {
    const result = await checkWidgetFolder(await folderWith(null))
    expect(result.errors).toEqual([])
    expect(result.warnings.join()).toMatch(/no preview/)
  })
  it('refuses a preview of the wrong dimensions', async () => {
    const result = await checkWidgetFolder(await folderWith(png(100, 100)))
    expect(result.errors.join()).toMatch(/should be about 640×320/)
    const ok = await checkWidgetFolder(await folderWith(png(640, 320)))
    expect(ok.errors).toEqual([])
    expect(ok.warnings).toEqual([])
  })
})

describe('setPreviewField', async () => {
  const { setPreviewField } = await import('../src/cli/preview.js')
  it('adds the field after the version and keeps the rest of the text as it was', () => {
    const text = '{ "id": "cpu", "name": "CPU", "version": "1.1.0",\n  "icon": "cpu" }\n'
    expect(setPreviewField(text, 'preview.webp')).toBe('{ "id": "cpu", "name": "CPU", "version": "1.1.0", "preview": "preview.webp",\n  "icon": "cpu" }\n')
  })
  it('replaces an existing one', () => {
    expect(JSON.parse(setPreviewField('{"id":"a","version":"1.0.0","preview":"old.png"}', 'preview.webp')).preview).toBe('preview.webp')
  })
  it('falls back to a clean rewrite when there is no version to anchor on', () => {
    expect(JSON.parse(setPreviewField('{"id":"a"}', 'preview.webp'))).toEqual({ id: 'a', preview: 'preview.webp' })
  })
})

describe('the settings a preview is taken with', () => {
  const target = (id: string, settingsSchema: object): Parameters<typeof previewSettings>[0] => ({
    id, folder: '/nowhere',
    manifest: ManifestSchema.parse({ id, name: id, version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4], settingsSchema }),
  })
  const connection = { type: 'connection', connectionType: 'synology', label: 'NAS' }
  it('points an empty connection setting at a connection of its type', () => {
    expect(previewSettings(target('nas', { connection }), [{ id: 'cal', type: 'ics' }, { id: 'demo-nas', type: 'synology' }])).toEqual({ connection: 'demo-nas' })
  })
  it('leaves it empty when the demo has none, and keeps the demo settings', () => {
    expect(previewSettings(target('nas', { connection }), [{ id: 'cal', type: 'ics' }])).toEqual({})
    expect(previewSettings(target('homey-flows', {}), [])).toEqual({ all: true })
  })
})
