import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ThemeSchema, cssVariables, BUILTIN_THEME, TOKENS } from '../src/themes/theme.js'
import { ThemeCatalog } from '../src/themes/catalog.js'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const body = (tokens: Record<string, unknown>) => ({ name: 'X', version: '1.0.0', tokens })
const theme = (tokens: Record<string, unknown>) => ({ id: 'x', ...body(tokens) })

async function folder(themes: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-themes-'))
  for (const [id, body] of Object.entries(themes)) {
    await mkdir(join(dir, id), { recursive: true })
    if (body === null) continue
    const json = typeof body === 'string' ? body : JSON.stringify({ id, ...(body as object) })
    await writeFile(join(dir, id, 'theme.json'), json)
  }
  return dir
}

describe('ThemeSchema', () => {
  it('accepts the tokens it declares, and only those', () => {
    expect(ThemeSchema.safeParse(theme({ bg: '#0b0d10', 'text-scale': 1.4 })).success).toBe(true)
    // An unknown key is a typo, not a token: keeping it would paint nothing and say nothing.
    const extra = ThemeSchema.safeParse(theme({ 'backgroun': '#000000' }))
    expect(extra.success).toBe(false)
  })

  it('refuses a value that could close the declaration it lands in', () => {
    for (const bad of ['red; background: url(http://x)', 'var(--bg)', '#00ff0', 'rgb(0,0,0)']) {
      expect(ThemeSchema.safeParse(theme({ bg: bad })).success, bad).toBe(false)
    }
    // Eight digits carry the alpha, which is how a theme asks for no tile card at all.
    expect(ThemeSchema.safeParse(theme({ 'tile-surface': '#00000000' })).success).toBe(true)
    expect(ThemeSchema.safeParse(theme({ font: 'Inter, sans-serif' })).success).toBe(true)
    expect(ThemeSchema.safeParse(theme({ font: 'url(evil.woff)' })).success).toBe(false)
    expect(ThemeSchema.safeParse(theme({ shadow: '0 8px 24px rgba(0, 0, 0, .35)' })).success).toBe(true)
  })

  it('keeps the text scale in a range a tile can still hold', () => {
    expect(ThemeSchema.safeParse(theme({ 'text-scale': 2 })).success).toBe(true)
    expect(ThemeSchema.safeParse(theme({ 'text-scale': 4 })).success).toBe(false)
    expect(ThemeSchema.safeParse(theme({ 'text-scale': 0.2 })).success).toBe(false)
  })
})

describe('cssVariables', () => {
  it('layers a theme on the built-in one and names the properties', () => {
    const builtin = ThemeSchema.parse(theme({ bg: '#0b0d10', accent: '#d9b36a' }))
    const custom = ThemeSchema.parse({ ...theme({ accent: '#ffae42' }), id: 'edge' })
    expect(cssVariables(custom, builtin)).toEqual({ '--bg': '#0b0d10', '--accent': '#ffae42' })
  })

  it('falls back to the built-in theme alone when the id is unknown', () => {
    const builtin = ThemeSchema.parse(theme({ bg: '#0b0d10' }))
    expect(cssVariables(undefined, builtin)).toEqual({ '--bg': '#0b0d10' })
  })
})

describe('ThemeCatalog', () => {
  it('reads the folders that parse and says why the others did not', async () => {
    const dir = await folder({
      good: body({ bg: '#111111' }),
      wrongid: { ...body({}), id: 'other' }, // l'id ne suit pas le dossier
      broken: '{ not json',
      empty: null,
    })
    const catalog = new ThemeCatalog(dir)
    await catalog.scan()
    expect([...catalog.themes.keys()]).toEqual(['good'])
    expect(catalog.errors.map((e) => e.id).sort()).toEqual(['broken', 'empty', 'wrongid'])
  })

  it('serves the built-in theme alone for an id it does not have', async () => {
    const dir = await folder({ [BUILTIN_THEME]: body({ bg: '#0b0d10' }) })
    const catalog = new ThemeCatalog(dir)
    await catalog.scan()
    expect(catalog.variables('nope')).toEqual({ '--bg': '#0b0d10' })
  })

  it('has nothing, rather than throwing, when the folder is missing', async () => {
    const catalog = new ThemeCatalog(join(tmpdir(), 'fremkit-themes-absent'))
    await catalog.scan()
    expect(catalog.themes.size).toBe(0)
    expect(catalog.errors).toEqual([])
  })
})

describe('the built-in theme', () => {
  /**
   * `tokens.css` is what the page shows before any theme is applied, so the built-in theme must
   * say exactly the same thing: a value changed in one and not the other would move the moment
   * the dashboard paints the theme it is already on.
   */
  it('repeats the values of tokens.css', async () => {
    const css = readFileSync(join(repo, 'ui/src/shared/tokens.css'), 'utf8')
    const declared = new Map<string, string>()
    for (const [, name, value] of css.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)) declared.set(name, value.trim())

    const catalog = new ThemeCatalog(join(repo, 'themes'))
    await catalog.scan()
    expect(catalog.errors).toEqual([])
    const builtin = catalog.get(BUILTIN_THEME)
    expect(builtin, 'themes/fremkit/theme.json').toBeDefined()

    const tokens = builtin!.tokens as Record<string, string | number | undefined>
    for (const name of Object.keys(TOKENS)) {
      expect(String(tokens[name] ?? ''), name).toBe(declared.get(name) ?? '')
    }
  })
})

/**
 * The shadow tokens are the only ones whose value may carry a function, and they end up in a
 * `style` attribute on `<html>` — in the dashboard and inside every widget frame. A theme will
 * arrive from a registry rather than from the user's own disk, so what a function may be is
 * spelled out rather than left to a character class.
 */
describe('the shadow tokens', () => {
  const shadow = (value: string) => ThemeSchema.safeParse(theme({ shadow: value })).success

  it('takes the shadows the themes in this repository actually declare', () => {
    for (const value of ['0 8px 24px rgba(0, 0, 0, .35)', '0 0 0 2px rgba(217, 179, 106, .55)',
      '0 0 18px rgba(57, 255, 136, .10)', 'inset 0 1px 0 #ffffff22', '0 2px 4px #000, 0 8px 16px #0008',
      'none']) {
      expect(shadow(value), value).toBe(true)
    }
  })

  it('refuses every function that is not a colour', () => {
    for (const value of ['url(https://evil.example/x)', 'image-set(a)', 'element(a)',
      '0 0 4px url(x)', 'var(--anything)', 'attr(href)']) {
      expect(shadow(value), value).toBe(false)
    }
  })

  it('refuses a value that would close its own declaration', () => {
    expect(shadow('0 0 0 2px red; background: url(x)')).toBe(false)
    expect(shadow('0 0 0 2px #000 } body {')).toBe(false)
  })
})

describe('what a theme carries for the registry', () => {
  it('asks for a semver version, since a registry compares one release to the next', () => {
    expect(ThemeSchema.safeParse({ ...theme({}), version: '1.0.0' }).success).toBe(true)
    expect(ThemeSchema.safeParse({ ...theme({}), version: '1.2.3-beta.1' }).success).toBe(true)
    for (const bad of ['1', '1.0', 'v1.0.0', 'latest', '']) {
      expect(ThemeSchema.safeParse({ ...theme({}), version: bad }).success, bad).toBe(false)
    }
  })

  it('keeps the credit and the licence when they are given, and does not ask for them', () => {
    const parsed = ThemeSchema.parse({
      ...theme({}), author: 'Someone', homepage: 'https://example.com/theme', license: 'MIT',
    })
    expect(parsed.author).toBe('Someone')
    expect(parsed.homepage).toBe('https://example.com/theme')
    expect(parsed.license).toBe('MIT')
    expect(ThemeSchema.parse(theme({})).author).toBeUndefined()
  })

  // The registry index holds a theme's homepage to https, so the theme itself is held to it too.
  it('refuses a homepage that is not an https address', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'http://example.com']) {
      expect(ThemeSchema.safeParse({ ...theme({}), homepage: bad }).success, bad).toBe(false)
    }
  })
})
