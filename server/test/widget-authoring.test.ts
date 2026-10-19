import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestSchema } from '../src/widgets/manifest.js'
import { SDK_GENERATIONS, SDK_VERSION } from '../src/bridge/sdk.js'
import { TEMPLATE_SDK, channelProblem, idProblem, nameFromId, parseSize, scaffoldWidget, type ScaffoldOptions } from '../src/widgets/scaffold.js'
import { checkWidgetFolder } from '../src/widgets/check.js'

const base: ScaffoldOptions = {
  id: 'my-widget',
  name: { fr: 'Mon widget', en: 'My widget' },
  description: { fr: 'Une ligne', en: 'One line' },
  category: 'info',
  size: [8, 4],
  author: 'someone',
  compact: 4,
}

async function write(files: Record<string, string>, id = 'my-widget'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'authoring-'))
  const folder = join(root, id)
  await mkdir(folder)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(folder, name, '..'), { recursive: true })
    await writeFile(join(folder, name), content)
  }
  return folder
}

describe('the scaffold', () => {
  for (const [label, options] of [['a counter', base], ['a channel reader', { ...base, channel: 'system' }]] as const) {
    it(`writes ${label} that validates and passes widget:check`, async () => {
      const files = scaffoldWidget(options)
      const manifest = ManifestSchema.parse(JSON.parse(files['manifest.json']))
      expect(manifest.sdk).toBe(TEMPLATE_SDK)
      // Declaring a generation means using nothing newer: every member the page calls must be in it.
      const allowed = new Set(Object.entries(SDK_GENERATIONS).filter(([g]) => Number(g) <= TEMPLATE_SDK).flatMap(([, m]) => m))
      const used = [...files['index.html'].matchAll(/Fremkit\.([a-zA-Z]+)/g)].map((m) => m[1])
      expect(used.filter((m) => !allowed.has(m))).toEqual([])
      expect(manifest.compact).toEqual({ width: 4 })
      const result = await checkWidgetFolder(await write(files))
      expect(result.errors).toEqual([])
      // A preview is made once the widget draws something: `pnpm widget:preview`.
      expect(result.warnings).toEqual([expect.stringMatching(/^no preview/)])
      // CHANGELOG.md is documented, never packed.
      expect(result.files).toBe(2)
    })

    it(`follows the widget rules in ${label}`, () => {
      const html = scaffoldWidget(options)['index.html']
      expect(html).toMatch(/background:transparent/)
      expect(html).toMatch(/var\(--accent,#d9b36a\)/)
      expect(html).toMatch(/var\(--on-surface/)
      for (const cls of ['html.on-light', 'html.accent-fill', 'html.compact', 'html.compact.slot-right']) expect(html).toContain(cls)
      expect(html).toMatch(/Fremkit\.t\(/)
      expect(html).toMatch(/fr: '.+', en: '.+'/)
      expect(html).toMatch(/var\(--text-scale,1\)/)
      expect(html).toMatch(/Fremkit\.onLocale\(render\)/)
    })
  }

  it('gives a counter a 56 px button', () => {
    expect(scaffoldWidget(base)['index.html']).toMatch(/min-width:56px;min-height:56px/)
  })

  it('subscribes to the channel it was given, and declares it', () => {
    const files = scaffoldWidget({ ...base, channel: 'cpu' })
    expect(JSON.parse(files['manifest.json']).subscriptions).toEqual(['cpu'])
    expect(files['index.html']).toContain('var CHANNEL = "cpu"')
  })

  it('leaves out what was not given', () => {
    const { author: _author, compact: _compact, ...bare } = base
    const manifest = JSON.parse(scaffoldWidget(bare)['manifest.json'])
    expect(manifest.author).toBeUndefined()
    expect(manifest.compact).toBeUndefined()
  })

  it('escapes the name where it lands in the page', () => {
    const html = scaffoldWidget({ ...base, channel: 'system', name: { fr: "L'<b>", en: '</script><x>' } })['index.html']
    expect(html).not.toContain('</script><x>')
    expect(html).toContain("fr: 'L\\'\\u003cb>'")
  })

  it('reads ids, sizes and channels', () => {
    expect(idProblem('my-widget_2')).toBeNull()
    expect(idProblem('My.Widget')).toMatch(/not a widget id/)
    expect(idProblem('')).toMatch(/empty/)
    expect(parseSize('8x4')).toEqual([8, 4])
    expect(parseSize(' 12 × 6 ')).toEqual([12, 6])
    expect(parseSize('0x4')).toBeNull()
    expect(parseSize('big')).toBeNull()
    expect(channelProblem('system')).toBeNull()
    expect(channelProblem('calendar:ics-1')).toBeNull()
    expect(channelProblem('calendar:*')).toMatch(/family/)
    expect(channelProblem('a b')).not.toBeNull()
    expect(nameFromId('my-new_widget')).toBe('My new widget')
  })
})

describe('widget:check', () => {
  const good = () => scaffoldWidget(base)

  it('reports what the registry and the installer would refuse', async () => {
    const manifest = JSON.parse(good()['manifest.json'])
    delete manifest.author
    manifest.name = 'Only one language'
    manifest.permissions.network = ['printer.local']
    manifest.version = '0.2.0'
    const folder = await write({
      ...good(),
      'manifest.json': JSON.stringify(manifest),
      'index.html': '<script src="https://cdn.example.com/x.js"></script>',
      '.env': 'SECRET=1',
      'nested.zip': 'x',
    })
    const { errors } = await checkWidgetFolder(folder)
    const text = errors.join('\n')
    expect(text).toMatch(/author is required/)
    expect(text).toMatch(/name must be a \{ "fr": …, "en": … \} pair/)
    expect(text).toMatch(/private or local host printer\.local/)
    expect(text).toMatch(/no "## 0\.2\.0" entry/)
    expect(text).toMatch(/loads a script from outside the package/)
    expect(text).toMatch(/dotfile: \.env/)
    expect(text).toMatch(/nested\.zip/)
  })

  it('refuses a folder that does not match its id, a built-in id and a too-new sdk', async () => {
    const manifest = JSON.parse(good()['manifest.json'])
    manifest.sdk = SDK_VERSION + 1
    const folder = await write({ ...good(), 'manifest.json': JSON.stringify(manifest) }, 'clock')
    const { errors } = await checkWidgetFolder(folder, { builtinIds: new Set(['clock']) })
    const text = errors.join('\n')
    expect(text).toMatch(/does not match the folder "clock"/)
    expect(text).toMatch(/sdk .* newer/)
  })

  it('refuses the id of a built-in', async () => {
    const files = scaffoldWidget({ ...base, id: 'clock' })
    const { errors } = await checkWidgetFolder(await write(files, 'clock'), { builtinIds: new Set(['clock']) })
    expect(errors.join('\n')).toMatch(/widget Fremkit ships/)
  })

  it('refuses a symlink, and only warns about Finder\'s .DS_Store', async () => {
    const folder = await write(good())
    await symlink('/etc/hosts', join(folder, 'hosts.txt'))
    await writeFile(join(folder, '.DS_Store'), '')
    const result = await checkWidgetFolder(folder)
    expect(result.errors).toEqual(['symlink: hosts.txt'])
    expect(result.warnings.join('\n')).toMatch(/\.DS_Store is ignored/)
  })

  it('says so when the manifest is missing, unreadable or invalid', async () => {
    expect((await checkWidgetFolder(await write({ 'index.html': '' }))).errors).toContain('manifest.json is missing')
    expect((await checkWidgetFolder(await write({ 'index.html': '', 'manifest.json': '{' }))).errors.join()).toMatch(/not valid JSON/)
    expect((await checkWidgetFolder(await write({ 'index.html': '', 'manifest.json': '{"id":"my-widget"}' }))).errors.join()).toMatch(/manifest\.json name/)
    expect((await checkWidgetFolder('/nonexistent/fremkit/widget')).errors.join()).toMatch(/cannot read/)
  })
})
