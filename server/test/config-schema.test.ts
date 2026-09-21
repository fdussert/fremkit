import { describe, it, expect } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG, MAX_NAV_WIDGETS, defaultLocale, validateConnections, validateLayout, validateNavWidgets, DisplaySchema, DEFAULT_ADMIN_GESTURE } from '../src/config/schema.js'
import { ManifestSchema } from '../src/widgets/manifest.js'

const manifests = new Map([['clock', { minSize: [8, 4] as [number, number] }]])

describe('ConfigSchema', () => {
  it('accepts the default config and fills display defaults', () => {
    const parsed = ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P' }] })
    expect(parsed.display).toEqual({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, theme: 'fremkit' })
    expect(parsed.pages[0].widgets).toEqual([])
  })
  it('rejects a config without pages', () => {
    expect(() => ConfigSchema.parse({ version: 3, pages: [] })).toThrow()
  })
  it('rejects a bad widgetId', () => {
    expect(() => ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'Bad Id', x: 0, y: 0, w: 1, h: 1 }] }] })).toThrow()
  })
  const withAccent = (accentColor: unknown) =>
    ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1, accentColor }] }] })
  it('leaves accentColor absent by default', () => {
    const parsed = ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(parsed.pages[0].widgets[0].accentColor).toBeUndefined()
  })
  it('accepts an #rrggbb accentColor in either case', () => {
    for (const color of ['#2f6feb', '#2F6FEB']) expect(withAccent(color).pages[0].widgets[0].accentColor).toBe(color)
  })
  it('rejects a malformed accentColor', () => {
    for (const color of ['#fff', '2f6feb', '#2f6feb80', 'red', '', 0x2f6feb]) expect(() => withAccent(color)).toThrow()
  })
  const withAccentStyle = (accentStyle: unknown) =>
    ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1, accentStyle }] }] })
  it('leaves accentStyle absent by default, so an old instance keeps the filled look', () => {
    const parsed = ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(parsed.pages[0].widgets[0].accentStyle).toBeUndefined()
  })
  it('accepts both accent styles', () => {
    for (const style of ['fill', 'outline']) expect(withAccentStyle(style).pages[0].widgets[0].accentStyle).toBe(style)
  })
  it('rejects an unknown accentStyle', () => {
    for (const style of ['Fill', 'border', '', 1]) expect(() => withAccentStyle(style)).toThrow()
  })
  const withWidgetBackground = (background: unknown) =>
    ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1, background }] }] })
  it('leaves the instance background absent by default', () => {
    const parsed = ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(parsed.pages[0].widgets[0].background).toBeUndefined()
  })
  it('accepts a full instance background', () => {
    expect(withWidgetBackground({ image: 'dunes.webp', fit: 'contain', dim: 0.6 }).pages[0].widgets[0].background)
      .toEqual({ image: 'dunes.webp', fit: 'contain', dim: 0.6 })
  })
  it('accepts an image alone, leaving fit and dim to their defaults', () => {
    expect(withWidgetBackground({ image: 'dunes.webp' }).pages[0].widgets[0].background).toEqual({ image: 'dunes.webp' })
  })
  it('requires the image: fit or dim alone mean nothing to draw', () => {
    expect(() => withWidgetBackground({ fit: 'cover' })).toThrow()
    expect(() => withWidgetBackground({})).toThrow()
  })
  it('validates the instance image name exactly like the screen background', () => {
    for (const image of ['../secret.txt', 'a/b.png', '..', '.hidden.png', 'nom accentué.png']) {
      expect(() => withWidgetBackground({ image })).toThrow()
    }
  })
  it('keeps dim inside 0 and 0.9, so the image never disappears behind the overlay', () => {
    for (const dim of [0, 0.9]) expect(withWidgetBackground({ image: 'a.png', dim }).pages[0].widgets[0].background?.dim).toBe(dim)
    for (const dim of [-0.1, 0.91, 1, '0.5']) expect(() => withWidgetBackground({ image: 'a.png', dim })).toThrow()
  })
  const withOpacity = (opacity: unknown) =>
    ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1, opacity }] }] })
  it('leaves the instance opacity absent by default, so an old tile stays solid', () => {
    const parsed = ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 1, h: 1 }] }] })
    expect(parsed.pages[0].widgets[0].opacity).toBeUndefined()
  })
  it('accepts an opacity across the whole 0–1 range', () => {
    for (const opacity of [0, 0.4, 0.55, 1]) expect(withOpacity(opacity).pages[0].widgets[0].opacity).toBe(opacity)
  })
  it('rejects an opacity outside 0–1, or one that is not a number', () => {
    for (const opacity of [1.5, -0.1, '0.5', null]) expect(() => withOpacity(opacity)).toThrow()
  })
  const withNavOpacity = (navOpacity: unknown) =>
    ConfigSchema.parse({ version: 3, display: { navOpacity }, pages: [{ id: 'p', name: 'P' }] })
  it('leaves display.navOpacity absent by default, so an old file keeps a solid bar', () => {
    expect(ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P' }] }).display.navOpacity).toBeUndefined()
  })
  it('accepts a nav bar opacity across the whole 0–1 range', () => {
    for (const navOpacity of [0, 0.3, 1]) expect(withNavOpacity(navOpacity).display.navOpacity).toBe(navOpacity)
  })
  it('rejects a nav bar opacity outside 0–1, or one that is not a number', () => {
    for (const navOpacity of [1.5, -0.1, '0.3', null]) expect(() => withNavOpacity(navOpacity)).toThrow()
  })
  const withNavHeight = (navHeight: unknown) =>
    ConfigSchema.parse({ version: 3, display: { navHeight }, pages: [{ id: 'p', name: 'P' }] })
  it('leaves display.navHeight absent by default, so an old file keeps the 80 px bar untouched', () => {
    expect(ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P' }] }).display.navHeight).toBeUndefined()
  })
  it('accepts both nav bar heights', () => {
    for (const height of [80, 40]) expect(withNavHeight(height).display.navHeight).toBe(height)
  })
  it('rejects any other nav bar height', () => {
    for (const height of [0, 60, 100, '40', null]) expect(() => withNavHeight(height)).toThrow()
  })
  const withBackground = (background: unknown) =>
    ConfigSchema.parse({ version: 3, display: { background }, pages: [{ id: 'p', name: 'P' }] })
  it('leaves display.background absent by default', () => {
    expect(ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P' }] }).display.background).toBeUndefined()
  })
  it('accepts a full background', () => {
    expect(withBackground({ color: '#101820', image: 'dunes.webp', fit: 'contain' }).display.background)
      .toEqual({ color: '#101820', image: 'dunes.webp', fit: 'contain' })
  })
  it('accepts a partial background', () => {
    expect(withBackground({ color: '#101820' }).display.background).toEqual({ color: '#101820' })
    expect(withBackground({}).display.background).toEqual({})
  })
  it('rejects a bad colour, image name or fit', () => {
    expect(() => withBackground({ color: 'blue' })).toThrow()
    expect(() => withBackground({ fit: 'stretch' })).toThrow()
    for (const image of ['../secret.txt', 'a/b.png', '..', '.hidden.png', 'nom accentué.png']) {
      expect(() => withBackground({ image })).toThrow()
    }
  })
  it('DEFAULT_CONFIG is valid', () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
  })
})

describe('validateLayout', () => {
  // Pinned to French: these assertions are about the wording, so they must not follow the
  // machine's own language. The English side is covered by its own test below.
  const base = () => ConfigSchema.parse({ version: 3, locale: 'fr', pages: [{ id: 'p', name: 'P', widgets: [] }] })
  it('returns no error for a valid layout', () => {
    const c = base(); c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests)).toEqual([])
  })
  it('flags overlap', () => {
    const c = base()
    c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, showTitle: true, settings: {} })
    c.pages[0].widgets.push({ instanceId: 'b', widgetId: 'clock', x: 8, y: 2, w: 16, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests).join()).toMatch(/chevauche/)
  })
  it('flags out of grid', () => {
    const c = base(); c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 56, y: 0, w: 16, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests).join()).toMatch(/hors grille/)
  })
  it('flags a size smaller than the manifest minimum', () => {
    const c = base(); c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 4, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests).join()).toMatch(/plus petite que le minimum/)
  })
  it('accepts an unknown widget (grey tile later)', () => {
    const c = base(); c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'ghost', x: 0, y: 0, w: 3, h: 3, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests)).toEqual([])
  })
  it('flags duplicate instanceId', () => {
    const c = base()
    c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} })
    c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 16, y: 0, w: 8, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests)).toEqual(['page p: instanceId a dupliqué'])
  })
  it('answers in English when the config asks for it', () => {
    const c = ConfigSchema.parse({ version: 3, locale: 'en', pages: [{ id: 'p', name: 'P', widgets: [] }] })
    c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 8, h: 4, showTitle: true, settings: {} })
    c.pages[0].widgets.push({ instanceId: 'a', widgetId: 'clock', x: 16, y: 0, w: 8, h: 4, showTitle: true, settings: {} })
    expect(validateLayout(c, manifests)).toEqual(['page p: duplicate instanceId a'])
  })
})

describe('navWidgets', () => {
  // Same pin as validateLayout above: these assertions are about the French wording.
  const navManifests = new Map([
    ['clock', { minSize: [8, 4] as [number, number], compact: { width: 5 } }],
    ['plain', { minSize: [8, 4] as [number, number] }],
  ])
  const withNav = (navWidgets: unknown[]) =>
    ConfigSchema.parse({ version: 3, locale: 'fr', display: { navWidgets }, pages: [{ id: 'p', name: 'P', widgets: [] }] })

  it('is absent when the bar carries none', () => {
    expect(ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [] }] }).display.navWidgets).toBeUndefined()
    expect(validateNavWidgets(ConfigSchema.parse({ version: 3, pages: [{ id: 'p', name: 'P', widgets: [] }] }), navManifests)).toEqual([])
  })
  it('accepts a widget that declares a compact rendering, on the left by default', () => {
    const c = withNav([{ instanceId: 'clock-1', widgetId: 'clock' }])
    expect(c.display.navWidgets![0]).toEqual({ instanceId: 'clock-1', widgetId: 'clock', slot: 'left', settings: {} })
    expect(validateNavWidgets(c, navManifests)).toEqual([])
  })
  it('keeps an explicit slot and refuses any other value', () => {
    expect(withNav([{ instanceId: 'a', widgetId: 'clock', slot: 'right' }]).display.navWidgets![0].slot).toBe('right')
    expect(() => withNav([{ instanceId: 'a', widgetId: 'clock', slot: 'middle' }])).toThrow()
  })
  it('keeps popup when it is set, leaves it absent otherwise, and refuses a non-boolean', () => {
    expect(withNav([{ instanceId: 'a', widgetId: 'clock' }]).display.navWidgets![0].popup).toBeUndefined()
    expect(withNav([{ instanceId: 'a', widgetId: 'clock', popup: true }]).display.navWidgets![0].popup).toBe(true)
    expect(withNav([{ instanceId: 'a', widgetId: 'clock', popup: false }]).display.navWidgets![0].popup).toBe(false)
    expect(() => withNav([{ instanceId: 'a', widgetId: 'clock', popup: 'yes' }])).toThrow()
  })
  it('flags a widget the catalog does not know', () => {
    const c = withNav([{ instanceId: 'a', widgetId: 'ghost' }])
    expect(validateNavWidgets(c, navManifests)).toEqual(['barre de navigation : widget inconnu ghost'])
  })
  it('flags a widget without a compact rendering', () => {
    const c = withNav([{ instanceId: 'a', widgetId: 'plain' }])
    expect(validateNavWidgets(c, navManifests).join()).toMatch(/n’a pas de rendu compact/)
  })
  it('flags a duplicate instanceId', () => {
    const c = withNav([{ instanceId: 'a', widgetId: 'clock' }, { instanceId: 'a', widgetId: 'clock' }])
    expect(validateNavWidgets(c, navManifests)).toEqual(['barre de navigation : instanceId a dupliqué'])
  })
  it('answers in English when the config asks for it', () => {
    const c = ConfigSchema.parse({
      version: 3, locale: 'en',
      display: { navWidgets: [{ instanceId: 'a', widgetId: 'plain' }] },
      pages: [{ id: 'p', name: 'P', widgets: [] }],
    })
    expect(validateNavWidgets(c, navManifests)).toEqual(['navigation bar: widget plain has no compact rendering'])
  })
  it('refuses more than six entries', () => {
    const many = Array.from({ length: MAX_NAV_WIDGETS + 1 }, (_, i) => ({ instanceId: 'n' + i, widgetId: 'clock' }))
    expect(() => withNav(many)).toThrow()
    expect(withNav(many.slice(0, MAX_NAV_WIDGETS)).display.navWidgets).toHaveLength(MAX_NAV_WIDGETS)
  })
})

describe('validateLayout against a converted v1 manifest', () => {
  // A v1 manifest declares `sizes` on the old grid; ManifestSchema doubles the smallest one,
  // so [4, 2] becomes the [8, 4] minimum the layout is held to.
  const legacy = ManifestSchema.parse({ id: 'clock', name: 'Horloge', version: '1.0.0', sizes: [[8, 2], [4, 2], [8, 4]] })
  const converted = new Map([['clock', { minSize: legacy.minSize }]])
  const layout = (w: number, h: number) =>
    ConfigSchema.parse({ version: 3, locale: 'fr', pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w, h }] }] })

  it('converts sizes to a doubled minimum', () => {
    expect(legacy.minSize).toEqual([8, 4])
  })
  it('rejects an instance below the converted minimum', () => {
    expect(validateLayout(layout(4, 2), converted).join()).toMatch(/plus petite que le minimum 8×4/)
  })
  it('accepts an instance exactly at the converted minimum', () => {
    expect(validateLayout(layout(8, 4), converted)).toEqual([])
  })
})

describe('connections in the config', () => {
  const base = { version: 3 as const, locale: 'fr' as const, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, pages: [{ id: 'home', name: 'Accueil', widgets: [] }] }

  it('defaults connections to an empty list and picks a secrets backend', () => {
    const parsed = ConfigSchema.parse(base)
    expect(parsed.connections).toEqual([])
    expect(['keychain', 'file']).toContain(parsed.secrets.backend)
  })

  it('keeps a declared connection and its non-secret fields', () => {
    const parsed = ConfigSchema.parse({ ...base, connections: [{ id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' } }] })
    expect(parsed.connections[0].fields.organization).toBe('example-org')
  })

  it('rejects an id that is not a safe slug', () => {
    expect(ConfigSchema.safeParse({ ...base, connections: [{ id: 'Ado X/1', type: 'azure-devops', name: 'Travail', fields: {} }] }).success).toBe(false)
  })

  it('reports duplicate connection ids', () => {
    const cfg = ConfigSchema.parse({ ...base, connections: [
      { id: 'ado-x1z9', type: 'azure-devops', name: 'A', fields: {} },
      { id: 'ado-x1z9', type: 'azure-devops', name: 'B', fields: {} },
    ] })
    expect(validateConnections(cfg)).toEqual(['connexion ado-x1z9 déclarée deux fois'])
  })

  it('reports duplicate connection ids in English too', () => {
    const cfg = ConfigSchema.parse({ ...base, locale: 'en', connections: [
      { id: 'ado-x1z9', type: 'azure-devops', name: 'A', fields: {} },
      { id: 'ado-x1z9', type: 'azure-devops', name: 'B', fields: {} },
    ] })
    expect(validateConnections(cfg)).toEqual(['connection ado-x1z9 declared twice'])
  })

  it('ships a default config with no connection', () => {
    expect(DEFAULT_CONFIG.connections).toEqual([])
  })
})

describe('locale', () => {
  const base = { version: 3, pages: [{ id: 'p', name: 'P' }] }

  it('reads French from a French system locale and English from anything else', () => {
    for (const l of ['fr', 'fr-FR', 'FR-ca']) expect(defaultLocale(l)).toBe('fr')
    for (const l of ['en-US', 'de-DE', 'ja', '']) expect(defaultLocale(l)).toBe('en')
  })

  it('leaves a v2 file without a locale valid and fills the system default in', () => {
    const parsed = ConfigSchema.parse(base)
    expect(parsed.locale).toBe(defaultLocale())
  })

  it('keeps an explicit locale', () => {
    for (const locale of ['fr', 'en']) expect(ConfigSchema.parse({ ...base, locale }).locale).toBe(locale)
  })

  it('rejects an unknown locale', () => {
    expect(ConfigSchema.safeParse({ ...base, locale: 'de' }).success).toBe(false)
  })

  it('ships a locale in the default config', () => {
    expect(['fr', 'en']).toContain(DEFAULT_CONFIG.locale)
  })
})

describe('display.adminGesture', () => {
  const display = (extra: object) => DisplaySchema.safeParse({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, ...extra })

  it('accepts the three gestures', () => {
    for (const adminGesture of ['both', 'longPress', 'doubleTap']) {
      expect(display({ adminGesture }).success, adminGesture).toBe(true)
    }
  })
  it('refuses anything else', () => {
    for (const adminGesture of ['swipe', '', 'LongPress', 1, null]) {
      expect(display({ adminGesture }).success, String(adminGesture)).toBe(false)
    }
  })
  it('is absent by default, which reads as both', () => {
    const parsed = display({})
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.adminGesture).toBeUndefined()
    expect(DEFAULT_ADMIN_GESTURE).toBe('both')
  })
})
