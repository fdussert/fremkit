import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..', 'companion')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const manifest = JSON.parse(read('manifest.json'))
const messages = (locale: string): Record<string, { message: string }> => JSON.parse(read(`_locales/${locale}/messages.json`))

/** The extension id Chrome derives from a manifest key: sha256 of the DER key, 32 hex digits mapped to a..p. */
function extensionId(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'))
const scripts = readdirSync(ROOT).filter((f) => f.endsWith('.js'))

describe('the companion extension', () => {
  it('every element a page script looks up by id exists in its page', () => {
    // popup.js once looked up `codeform` while the page called it `code`: the popup died on load.
    for (const [page, script] of [['popup.html', 'popup.js'], ['options.html', 'options.js']]) {
      const ids = new Set([...read(page).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
      const used = [...read(script).matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map((m) => m[1] ?? m[2])
      expect(used.length).toBeGreaterThan(0)
      expect(used.filter((id) => !ids.has(id)), `${script} → ${page}`).toEqual([])
    }
  })

  it('the manifest asks for exactly the permitted permissions and no <all_urls>', () => {
    expect(manifest.manifest_version).toBe(3)
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture'])
    // Fremkit's port only (worker.js PORT): not every local server on the Mac.
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:4242/*'])
    expect([...manifest.optional_host_permissions].sort()).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.optional_permissions).toBeUndefined()
    expect(manifest.content_scripts).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>')
    expect(manifest.background).toEqual({ service_worker: 'worker.js', type: 'module' })
    expect(manifest.action.default_popup).toBe('popup.html')
    expect(manifest.options_page).toBe('options.html')
    expect(manifest.default_locale).toBe('fr')
    expect(manifest.commands['fremplay-toggle'].suggested_key.default).toBe('Ctrl+Shift+F')
    // Not ⌥: on a Mac, Option+Shift+letter types a character, and the browser let the page have it.
    expect(manifest.commands['fremplay-toggle'].suggested_key.mac).toBe('MacCtrl+Shift+F')
  })

  it("the manifest's key is present and gives the store's extension id", () => {
    expect(typeof manifest.key).toBe('string')
    expect(extensionId(manifest.key)).toBe('lnckeodobpbbmfbdlpnegjpchgkehdlk')
  })

  it('fr and en messages have the same keys', () => {
    const fr = messages('fr')
    const en = messages('en')
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
    for (const m of [...Object.values(fr), ...Object.values(en)]) expect(m.message.trim()).not.toBe('')
  })

  it('every __MSG_ key used in html and manifest exists', () => {
    const keys = new Set(Object.keys(messages('fr')))
    const used = new Set<string>()
    for (const text of [read('manifest.json'), ...pages.map(read)]) {
      for (const m of text.matchAll(/__MSG_(\w+?)__/g)) used.add(m[1])
    }
    // Scripts look strings up through `t('key')`.
    for (const text of scripts.map(read)) for (const m of text.matchAll(/\bt\('(\w+)'/g)) used.add(m[1])
    expect(used.size).toBeGreaterThan(0)
    expect([...used].filter((k) => !keys.has(k))).toEqual([])
  })

  it('loads nothing from the network', () => {
    for (const text of [...pages, ...scripts, 'popup.css'].map(read)) {
      expect(text).not.toMatch(/(src|href)=["']https?:/)
      expect(text).not.toMatch(/@import|fonts\.googleapis/)
    }
  })

  it('ships every icon the manifest names', () => {
    const icons = { ...manifest.icons, ...manifest.action.default_icon }
    for (const path of Object.values(icons) as string[]) expect(() => readFileSync(join(ROOT, path))).not.toThrow()
  })
})
