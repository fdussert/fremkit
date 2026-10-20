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
    // Nothing new at install: an added permission with a warning disables the extension on a store
    // update until the user accepts it again. Fremdev's webRequest is asked for when it is turned on.
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture'])
    // Fremkit's port only (worker.js PORT): not every local server on the Mac.
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:4242/*'])
    expect([...manifest.optional_host_permissions].sort()).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.optional_permissions).toEqual(['webRequest'])
    // webNavigation reports every site's navigations whatever the host grants: not asked for at all.
    expect(JSON.stringify(manifest)).not.toContain('webNavigation')
    // Fremdev's hooks are registered at run time on the dev origins the user granted, never declared.
    expect(manifest.content_scripts).toBeUndefined()
    expect(manifest.web_accessible_resources).toBeUndefined()
    expect(manifest.externally_connectable).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>')
    expect(manifest.background).toEqual({ service_worker: 'worker.js', type: 'module' })
    expect(manifest.action.default_popup).toBe('popup.html')
    expect(manifest.options_page).toBe('options.html')
    expect(manifest.default_locale).toBe('fr')
    expect(manifest.commands['fremplay-toggle'].suggested_key.default).toBe('Ctrl+Shift+F')
    // Not ⌥: on a Mac, Option+Shift+letter types a character, and the browser let the page have it.
    expect(manifest.commands['fremplay-toggle'].suggested_key.mac).toBe('MacCtrl+Shift+F')
    // Fremdev's shot: ⌃⇧S, the same family; the key press is the activeTab grant captureVisibleTab needs.
    expect(manifest.commands['fremdev-shot'].suggested_key).toEqual({ default: 'Ctrl+Shift+S', mac: 'MacCtrl+Shift+S' })
    expect(manifest.commands['fremdev-shot'].description).toBe('__MSG_commandShot__')
    expect(Object.keys(manifest.commands).sort()).toEqual(['fremdev-shot', 'fremplay-toggle'])
  })

  it('is version 0.2.0, the first with Fremdev', () => {
    expect(manifest.version).toBe('0.2.0')
  })

  it('hook and relay share the hot-reload prefixes', () => {
    // hook.js runs in the page as a classic script and cannot import lib/devlog.js: it keeps a copy.
    const lists = (text: string) => {
      const out: Record<string, string[]> = {}
      for (const m of text.matchAll(/const (DOWN|UP|HOT) = \[([\s\S]*?)\]$/gm)) {
        out[m[1]] = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((s) => s[1])
      }
      return out
    }
    const hook = lists(read('fremdev/hook.js'))
    const devlog = lists(read('lib/devlog.js'))
    expect(Object.keys(devlog).sort()).toEqual(['DOWN', 'HOT', 'UP'])
    for (const name of ['DOWN', 'UP', 'HOT']) {
      expect(devlog[name].length, name).toBeGreaterThan(0)
      expect(hook[name], name).toEqual(devlog[name])
    }
  })

  it("the manifest's key is present and gives the store's extension id", () => {
    expect(typeof manifest.key).toBe('string')
    expect(extensionId(manifest.key)).toBe('lnckeodobpbbmfbdlpnegjpchgkehdlk')
  })

  it('names the shot command in both languages, and the options page shows both shortcuts', () => {
    expect(messages('fr').commandShot.message).toBe('Fremdev : copier une capture de l’onglet de développement')
    expect(messages('en').commandShot.message).toBe('Fremdev: copy a screenshot of the development tab')
    expect(messages('fr').optShotShortcut.message).toBe('Capture Fremdev')
    expect(messages('en').optShotShortcut.message).toBe('Fremdev screenshot')
    const page = read('options.html')
    expect(page).toContain('__MSG_optShortcut__')
    expect(page).toContain('__MSG_optShotShortcut__')
    const script = read('options.js')
    expect(script).toContain("'fremplay-toggle'")
    expect(script).toContain("'fremdev-shot'")
    expect(script).toContain("chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })")
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
