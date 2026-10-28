import { describe, it, expect } from 'vitest'
import {
  ConfigSchema, DEFAULT_CONFIG, MAX_NAV_WIDGETS, defaultLocale, validateConnections, validateLayout, validateNavWidgets,
  ScreenDisplaySchema, WidgetSchema, NavItemSchema, PlacementSchema, ScreenSchema, DEFAULT_ADMIN_GESTURE, isSafeTileIconName,
  type Config, type LayoutManifest, type Placement, type Widget,
} from '../src/config/schema.js'
import {
  NAV_CENTRE_RESERVE_CELLS, NAV_NAMES_MAX_WIDTH, WIDE_COMPACT_SETTINGS, WIDE_COMPACT_WIDTH, compactWidth, navCellsUsed,
  navCentreWidth, navHasRoom, navWiderClusterWidth,
} from '../src/config/nav.js'
import { migrateConfig } from '../src/config/migrate.js'
import { defaultSecretsBackend } from '../src/secrets/index.js'
import { ManifestSchema } from '../src/widgets/manifest.js'
import { readFileSync } from 'node:fs'

const manifests = new Map([['clock', { minSize: [8, 4] as [number, number] }]])

/** The smallest valid v4 file: one screen, one empty page, plus whatever the case adds. */
const v4 = (extra: object = {}, screen: object = {}) => ({
  version: 4,
  screens: [{ id: 'edge', name: 'Xeneon Edge', kind: 'edge', pages: [{ id: 'p', name: 'P' }], ...screen }],
  ...extra,
})

describe('ConfigSchema', () => {
  it('parses DEFAULT_CONFIG as v4', () => {
    const parsed = ConfigSchema.parse(DEFAULT_CONFIG)
    expect(parsed.version).toBe(4)
    expect(parsed.screens[0].id).toBe('edge')
    expect(parsed.theme).toBe('fremkit')
    expect(parsed.widgets['clock-1'].widgetId).toBe('clock')
    expect(parsed.screens[0].pages[0].items).toEqual([{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }])
  })
  it('DEFAULT_CONFIG is valid and round-trips unchanged', () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
  })
  it('fills the defaults of a minimal file', () => {
    const parsed = ConfigSchema.parse(v4())
    expect(parsed.theme).toBe('fremkit')
    expect(parsed.widgets).toEqual({})
    expect(parsed.screens[0].display).toEqual({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 })
    expect(parsed.screens[0].nav).toEqual([])
    expect(parsed.screens[0].pages[0].items).toEqual([])
  })
  it('refuses a v3 file', () => {
    expect(() => ConfigSchema.parse({ ...v4(), version: 3 })).toThrow()
  })
  it('refuses a config with no screen', () => {
    expect(() => ConfigSchema.parse({ version: 4, screens: [] })).toThrow()
  })
  it('refuses a screen with no page', () => {
    expect(() => ConfigSchema.parse(v4({}, { pages: [] }))).toThrow()
  })
  it('refuses a screen id that is not a slug', () => {
    expect(() => ConfigSchema.parse(v4({}, { id: 'Edge 1' }))).toThrow()
    for (const id of ['', '-edge', 'a'.repeat(65)]) expect(() => ConfigSchema.parse(v4({}, { id }))).toThrow()
    expect(ConfigSchema.parse(v4({}, { id: 'ipad-2' })).screens[0].id).toBe('ipad-2')
  })
  it('refuses an unknown screen kind and an empty or over-long name', () => {
    expect(() => ConfigSchema.parse(v4({}, { kind: 'tv' }))).toThrow()
    expect(() => ConfigSchema.parse(v4({}, { name: '' }))).toThrow()
    expect(() => ConfigSchema.parse(v4({}, { name: 'x'.repeat(61) }))).toThrow()
  })
  it('refuses a theme id that is not a slug', () => {
    expect(() => ConfigSchema.parse(v4({ theme: 'Bad Theme' }))).toThrow()
  })
  it('refuses a widget key that is empty or longer than 64', () => {
    const clock = { widgetId: 'clock' }
    expect(() => ConfigSchema.parse(v4({ widgets: { '': clock } }))).toThrow()
    expect(() => ConfigSchema.parse(v4({ widgets: { ['a'.repeat(65)]: clock } }))).toThrow()
  })
})

describe('ScreenSchema', () => {
  it('drops theme and navWidgets from a screen display', () => {
    const s = ScreenSchema.parse({ id: 'edge', name: 'E', kind: 'edge', display: { theme: 'edge', navWidgets: [] }, pages: [{ id: 'p', name: 'P' }] })
    expect(s.display).not.toHaveProperty('theme')
    expect(s.display).not.toHaveProperty('navWidgets')
  })
  it('keeps a device orientation and viewport, and refuses bad ones', () => {
    expect(ScreenDisplaySchema.parse({ orientation: 'portrait', viewport: { width: 1032, height: 1376 } }))
      .toMatchObject({ orientation: 'portrait', viewport: { width: 1032, height: 1376 } })
    expect(() => ScreenDisplaySchema.parse({ orientation: 'sideways' })).toThrow()
    expect(() => ScreenDisplaySchema.parse({ viewport: { width: 0, height: 10 } })).toThrow()
    expect(() => ScreenDisplaySchema.parse({ viewport: { width: 10.5, height: 10 } })).toThrow()
  })
  it('leaves orientation and viewport absent by default', () => {
    const d = ScreenDisplaySchema.parse({})
    expect(d.orientation).toBeUndefined()
    expect(d.viewport).toBeUndefined()
  })
})

describe('theme schedule', () => {
  it('leaves a file written before it existed untouched: no key, one theme', () => {
    expect(ConfigSchema.parse(v4())).not.toHaveProperty('themeSchedule')
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).not.toHaveProperty('themeSchedule')
  })
  it('fills the defaults once a night theme is named', () => {
    expect(ConfigSchema.parse(v4({ themeSchedule: { night: 'edge' } })).themeSchedule)
      .toEqual({ night: 'edge', schedule: 'sun', dayAt: '07:00', nightAt: '21:00' })
  })
  it('round-trips a filled-in schedule', () => {
    const themeSchedule = { night: 'edge', schedule: 'fixed', latitude: 48.85, longitude: 2.35, dayAt: '06:30', nightAt: '22:15' }
    const once = ConfigSchema.parse(v4({ theme: 'fremkit', themeSchedule }))
    expect(ConfigSchema.parse(once)).toEqual(once)
    expect(once.themeSchedule).toEqual(themeSchedule)
  })
  it('refuses a night theme that is not a slug, and times and coordinates out of range', () => {
    const bad = [
      {}, { night: 'Not A Slug' }, { night: 'edge', schedule: 'moon' }, { night: 'edge', dayAt: '24:00' },
      { night: 'edge', nightAt: '7:00' }, { night: 'edge', latitude: 91 }, { night: 'edge', longitude: -181 },
    ]
    for (const themeSchedule of bad) expect(() => ConfigSchema.parse(v4({ themeSchedule })), JSON.stringify(themeSchedule)).toThrow()
  })
})

describe('page background', () => {
  const page = (background?: unknown) =>
    ScreenSchema.parse({ id: 'edge', name: 'E', kind: 'edge', pages: [{ id: 'p', name: 'P', ...(background === undefined ? {} : { background }) }] }).pages[0]
  it('is absent on a page written before it existed, which then shows the screen\'s', () => {
    expect(page()).not.toHaveProperty('background')
    expect(ConfigSchema.parse(v4()).screens[0].pages[0].background).toBeUndefined()
  })
  it('accepts a full or a partial background', () => {
    expect(page({ color: '#101820', image: 'dunes.webp', fit: 'contain' }).background)
      .toEqual({ color: '#101820', image: 'dunes.webp', fit: 'contain' })
    expect(page({ color: '#101820' }).background).toEqual({ color: '#101820' })
  })
  it('puts the image name through the same gate as the screen background', () => {
    for (const image of ['../secret.txt', 'a/b.png', '..', '.hidden.png', 'nom accentué.png']) {
      expect(() => page({ image }), image).toThrow()
    }
    expect(() => page({ color: 'blue' })).toThrow()
    expect(() => page({ fit: 'stretch' })).toThrow()
  })
})

describe('screen brightness settings', () => {
  it('leaves a file written before brightness existed untouched: no key, both modes off', () => {
    // The whole migration story: an absent key means "nothing automatic", so no version bump.
    const parsed = ConfigSchema.parse(v4())
    expect(parsed.screens[0]).not.toHaveProperty('brightness')
    expect(ConfigSchema.parse(DEFAULT_CONFIG).screens[0]).not.toHaveProperty('brightness')
  })
  it('fills every default once the key is there, with both modes off', () => {
    const parsed = ConfigSchema.parse(v4({}, { brightness: {} }))
    expect(parsed.screens[0].brightness).toEqual({
      dayNight: { enabled: false, day: 80, night: 30, schedule: 'sun', dayAt: '07:00', nightAt: '21:00', rampMinutes: 20 },
      followMac: { enabled: false, scale: 1, offset: 0 },
    })
  })
  it('round-trips a filled-in setting', () => {
    const brightness = {
      dayNight: { enabled: true, day: 90, night: 10, schedule: 'fixed', latitude: 48.85, longitude: 2.35, dayAt: '06:30', nightAt: '22:15', rampMinutes: 45 },
      followMac: { enabled: true, scale: 1.5, offset: -10 },
    }
    const once = ConfigSchema.parse(v4({}, { brightness }))
    expect(ConfigSchema.parse(once)).toEqual(once)
    expect(once.screens[0].brightness).toEqual(brightness)
  })
  it('refuses levels, times and coordinates out of range', () => {
    const bad = [
      { dayNight: { day: 101 } }, { dayNight: { night: -1 } }, { dayNight: { day: 50.5 } },
      { dayNight: { dayAt: '24:00' } }, { dayNight: { nightAt: '7:00' } }, { dayNight: { schedule: 'moon' } },
      { dayNight: { latitude: 91 } }, { dayNight: { longitude: -181 } }, { dayNight: { rampMinutes: 121 } },
      { followMac: { scale: 0 } }, { followMac: { offset: 200 } },
    ]
    for (const brightness of bad) expect(() => ConfigSchema.parse(v4({}, { brightness })), JSON.stringify(brightness)).toThrow()
  })
})

describe('PlacementSchema', () => {
  it('keeps the geometry and nothing else', () => {
    expect(PlacementSchema.parse({ instanceId: 'a', x: 0, y: 1, w: 2, h: 3, widgetId: 'clock' }))
      .toEqual({ instanceId: 'a', x: 0, y: 1, w: 2, h: 3 })
  })
  it('keeps an optional lock, absent when the file has none', () => {
    expect(PlacementSchema.parse({ instanceId: 'a', x: 0, y: 0, w: 1, h: 1 })).not.toHaveProperty('locked')
    expect(PlacementSchema.parse({ instanceId: 'a', x: 0, y: 0, w: 1, h: 1, locked: true }).locked).toBe(true)
    expect(PlacementSchema.parse({ instanceId: 'a', x: 0, y: 0, w: 1, h: 1, locked: false }).locked).toBe(false)
    expect(() => PlacementSchema.parse({ instanceId: 'a', x: 0, y: 0, w: 1, h: 1, locked: 'yes' })).toThrow()
  })
  it('round-trips a config whose placement is locked', () => {
    const cfg = v4({ widgets: { a: { widgetId: 'clock', showTitle: true, settings: {} } } },
      { pages: [{ id: 'p', name: 'P', items: [{ instanceId: 'a', x: 0, y: 0, w: 8, h: 4, locked: true }] }] })
    const parsed = ConfigSchema.parse(cfg)
    expect(parsed.screens[0].pages[0].items[0]).toEqual({ instanceId: 'a', x: 0, y: 0, w: 8, h: 4, locked: true })
    expect(ConfigSchema.parse(parsed)).toEqual(parsed)
  })
  it('refuses a negative position, an empty size and an over-long instanceId', () => {
    expect(() => PlacementSchema.parse({ instanceId: 'a', x: -1, y: 0, w: 1, h: 1 })).toThrow()
    expect(() => PlacementSchema.parse({ instanceId: 'a', x: 0, y: 0, w: 0, h: 1 })).toThrow()
    expect(() => PlacementSchema.parse({ instanceId: 'a'.repeat(65), x: 0, y: 0, w: 1, h: 1 })).toThrow()
    expect(() => PlacementSchema.parse({ instanceId: '', x: 0, y: 0, w: 1, h: 1 })).toThrow()
  })
})

describe('WidgetSchema', () => {
  it('drops geometry from a widget', () => {
    const w = WidgetSchema.parse({ widgetId: 'clock', x: 1, settings: {} })
    expect(w).not.toHaveProperty('x')
    expect(w).toEqual({ widgetId: 'clock', showTitle: true, settings: {} })
  })
  it('drops the instance id and the legacy appearance keys', () => {
    const w = WidgetSchema.parse({ widgetId: 'clock', instanceId: 'a', appearance: 'accent', accentStyle: 'outline' })
    expect(w).not.toHaveProperty('instanceId')
    expect(w).not.toHaveProperty('appearance')
    expect(w).not.toHaveProperty('accentStyle')
  })
  it('rejects a bad widgetId', () => {
    expect(() => WidgetSchema.parse({ widgetId: 'Bad Id' })).toThrow()
  })
  const withAccent = (accentColor: unknown) => WidgetSchema.parse({ widgetId: 'clock', accentColor })
  it('leaves accentColor absent by default', () => {
    expect(WidgetSchema.parse({ widgetId: 'clock' }).accentColor).toBeUndefined()
  })
  it('accepts an #rrggbb accentColor in either case', () => {
    for (const color of ['#2f6feb', '#2F6FEB']) expect(withAccent(color).accentColor).toBe(color)
  })
  it('rejects a malformed accentColor', () => {
    for (const color of ['#fff', '2f6feb', '#2f6feb80', 'red', '', 0x2f6feb]) expect(() => withAccent(color)).toThrow()
  })
  const withWidgetBackground = (background: unknown) => WidgetSchema.parse({ widgetId: 'clock', background })
  it('leaves the widget background absent by default', () => {
    expect(WidgetSchema.parse({ widgetId: 'clock' }).background).toBeUndefined()
  })
  it('accepts a full widget background', () => {
    expect(withWidgetBackground({ image: 'dunes.webp', fit: 'contain', dim: 0.6 }).background)
      .toEqual({ image: 'dunes.webp', fit: 'contain', dim: 0.6 })
  })
  it('accepts an image alone, leaving fit and dim to their defaults', () => {
    expect(withWidgetBackground({ image: 'dunes.webp' }).background).toEqual({ image: 'dunes.webp' })
  })
  it('requires the image: fit or dim alone mean nothing to draw', () => {
    expect(() => withWidgetBackground({ fit: 'cover' })).toThrow()
    expect(() => withWidgetBackground({})).toThrow()
  })
  it('validates the widget image name exactly like the screen background', () => {
    for (const image of ['../secret.txt', 'a/b.png', '..', '.hidden.png', 'nom accentué.png']) {
      expect(() => withWidgetBackground({ image })).toThrow()
    }
  })
  it('keeps dim inside 0 and 0.9, so the image never disappears behind the overlay', () => {
    for (const dim of [0, 0.9]) expect(withWidgetBackground({ image: 'a.png', dim }).background?.dim).toBe(dim)
    for (const dim of [-0.1, 0.91, 1, '0.5']) expect(() => withWidgetBackground({ image: 'a.png', dim })).toThrow()
  })
  const withOpacity = (opacity: unknown) => WidgetSchema.parse({ widgetId: 'clock', opacity })
  it('leaves the widget opacity absent by default, so an old tile stays solid', () => {
    expect(WidgetSchema.parse({ widgetId: 'clock' }).opacity).toBeUndefined()
  })
  it('accepts an opacity across the whole 0–1 range', () => {
    for (const opacity of [0, 0.4, 0.55, 1]) expect(withOpacity(opacity).opacity).toBe(opacity)
  })
  it('rejects an opacity outside 0–1, or one that is not a number', () => {
    for (const opacity of [1.5, -0.1, '0.5', null]) expect(() => withOpacity(opacity)).toThrow()
  })
})

describe('ScreenDisplaySchema', () => {
  const withNavOpacity = (navOpacity: unknown) => ScreenDisplaySchema.parse({ navOpacity })
  it('leaves navOpacity absent by default, so an old file keeps a solid bar', () => {
    expect(ScreenDisplaySchema.parse({}).navOpacity).toBeUndefined()
  })
  it('accepts a nav bar opacity across the whole 0–1 range', () => {
    for (const navOpacity of [0, 0.3, 1]) expect(withNavOpacity(navOpacity).navOpacity).toBe(navOpacity)
  })
  it('rejects a nav bar opacity outside 0–1, or one that is not a number', () => {
    for (const navOpacity of [1.5, -0.1, '0.3', null]) expect(() => withNavOpacity(navOpacity)).toThrow()
  })
  const withNavHeight = (navHeight: unknown) => ScreenDisplaySchema.parse({ navHeight })
  it('leaves navHeight absent by default, so an old file keeps the 80 px bar untouched', () => {
    expect(ScreenDisplaySchema.parse({}).navHeight).toBeUndefined()
  })
  it('accepts both nav bar heights', () => {
    for (const height of [80, 40]) expect(withNavHeight(height).navHeight).toBe(height)
  })
  it('rejects any other nav bar height', () => {
    for (const height of [0, 60, 100, '40', null]) expect(() => withNavHeight(height)).toThrow()
  })
  it('keeps the page dots by default and accepts an explicit named style', () => {
    expect(ScreenDisplaySchema.parse({}).navStyle).toBeUndefined()
    expect(ScreenDisplaySchema.parse({ navStyle: 'names' }).navStyle).toBe('names')
    expect(() => ScreenDisplaySchema.parse({ navStyle: 'tabs' })).toThrow()
  })
  const withBackground = (background: unknown) => ScreenDisplaySchema.parse({ background })
  it('leaves background absent by default', () => {
    expect(ScreenDisplaySchema.parse({}).background).toBeUndefined()
  })
  it('accepts a full background', () => {
    expect(withBackground({ color: '#101820', image: 'dunes.webp', fit: 'contain' }).background)
      .toEqual({ color: '#101820', image: 'dunes.webp', fit: 'contain' })
  })
  it('accepts a partial background', () => {
    expect(withBackground({ color: '#101820' }).background).toEqual({ color: '#101820' })
    expect(withBackground({}).background).toEqual({})
  })
  it('rejects a bad colour, image name or fit', () => {
    expect(() => withBackground({ color: 'blue' })).toThrow()
    expect(() => withBackground({ fit: 'stretch' })).toThrow()
    for (const image of ['../secret.txt', 'a/b.png', '..', '.hidden.png', 'nom accentué.png']) {
      expect(() => withBackground({ image })).toThrow()
    }
  })
})

/** A v4 config holding `items` on the single page of the single screen, each a `clock` unless named. */
const withItems = (locale: 'fr' | 'en', items: Placement[], widgets: Record<string, Partial<Widget>> = {}): Config => {
  const all: Record<string, unknown> = {}
  for (const p of items) all[p.instanceId] = { widgetId: 'clock', ...widgets[p.instanceId] }
  return ConfigSchema.parse(v4({ locale, widgets: all }, { pages: [{ id: 'p', name: 'P', items }] }))
}

describe('validateLayout', () => {
  // Pinned to French: these assertions are about the wording, so they must not follow the
  // machine's own language. The English side is covered by its own test below.
  it('returns no error for a valid layout', () => {
    expect(validateLayout(withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }]), manifests)).toEqual([])
  })
  it('flags overlap', () => {
    const c = withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }, { instanceId: 'b', x: 8, y: 2, w: 16, h: 4 }])
    expect(validateLayout(c, manifests).join()).toMatch(/chevauche/)
  })
  it('flags out of grid', () => {
    expect(validateLayout(withItems('fr', [{ instanceId: 'a', x: 56, y: 0, w: 16, h: 4 }]), manifests).join()).toMatch(/hors grille/)
  })
  it('checks the grid against the screen’s own display', () => {
    const c = withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }])
    c.screens[0].display.cols = 10
    expect(validateLayout(c, manifests).join()).toMatch(/hors grille/)
  })
  it('flags a size smaller than the manifest minimum', () => {
    expect(validateLayout(withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 4, h: 4 }]), manifests).join()).toMatch(/plus petite que le minimum/)
  })
  it('accepts an unknown widget (grey tile later)', () => {
    const c = withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 3, h: 3 }], { a: { widgetId: 'ghost' } })
    expect(validateLayout(c, manifests)).toEqual([])
  })
  it('flags an instance placed twice on one page', () => {
    const c = withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 8, h: 4 }, { instanceId: 'a', x: 16, y: 0, w: 8, h: 4 }])
    expect(validateLayout(c, manifests)).toEqual(['écran Xeneon Edge : a y figure plus d’une fois'])
  })
  it('answers in English when the config asks for it', () => {
    const c = withItems('en', [{ instanceId: 'a', x: 0, y: 0, w: 8, h: 4 }, { instanceId: 'a', x: 16, y: 0, w: 8, h: 4 }])
    expect(validateLayout(c, manifests)).toEqual(['screen Xeneon Edge: a appears more than once'])
  })
  it('names the screen and the page in the grid messages', () => {
    const c = withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }, { instanceId: 'b', x: 8, y: 2, w: 16, h: 4 }])
    expect(validateLayout(c, manifests)).toEqual(['écran Xeneon Edge, page p : a chevauche b'])
    expect(validateLayout(withItems('en', [{ instanceId: 'a', x: 62, y: 0, w: 4, h: 4 }]), manifests)).toEqual([
      'screen Xeneon Edge, page p: a outside the grid',
      'screen Xeneon Edge, page p: a size 4×4 is smaller than the 8×4 minimum of clock',
    ])
  })
})

describe('the navigation bar', () => {
  // Same pin as validateLayout above: these assertions are about the French wording.
  const navManifests = new Map([
    ['clock', { minSize: [8, 4] as [number, number], compact: { width: 5 } }],
    ['plain', { minSize: [8, 4] as [number, number] }],
  ])
  const withNav = (nav: { instanceId: string, widgetId: string, [k: string]: unknown }[], locale: 'fr' | 'en' = 'fr') => {
    const widgets: Record<string, unknown> = {}
    for (const { instanceId, widgetId } of nav) widgets[instanceId] = { widgetId }
    return ConfigSchema.parse(v4({ locale, widgets }, { nav: nav.map(({ widgetId: _, ...item }) => item) }))
  }

  it('is empty when the bar carries none', () => {
    const c = ConfigSchema.parse(v4())
    expect(c.screens[0].nav).toEqual([])
    expect(validateNavWidgets(c, navManifests)).toEqual([])
  })
  it('accepts a widget that declares a compact rendering, on the left by default', () => {
    const c = withNav([{ instanceId: 'clock-1', widgetId: 'clock' }])
    expect(c.screens[0].nav[0]).toEqual({ instanceId: 'clock-1', slot: 'left' })
    expect(validateNavWidgets(c, navManifests)).toEqual([])
  })
  it('keeps an explicit slot and refuses any other value', () => {
    expect(NavItemSchema.parse({ instanceId: 'a', slot: 'right' }).slot).toBe('right')
    expect(() => NavItemSchema.parse({ instanceId: 'a', slot: 'middle' })).toThrow()
  })
  it('keeps popup when it is set, leaves it absent otherwise, and refuses a non-boolean', () => {
    expect(NavItemSchema.parse({ instanceId: 'a' }).popup).toBeUndefined()
    expect(NavItemSchema.parse({ instanceId: 'a', popup: true }).popup).toBe(true)
    expect(NavItemSchema.parse({ instanceId: 'a', popup: false }).popup).toBe(false)
    expect(() => NavItemSchema.parse({ instanceId: 'a', popup: 'yes' })).toThrow()
  })
  it('carries no widget settings: those live in `widgets`', () => {
    expect(NavItemSchema.parse({ instanceId: 'a', widgetId: 'clock', settings: { x: 1 } })).toEqual({ instanceId: 'a', slot: 'left' })
  })
  it('refuses an empty or over-long instanceId', () => {
    expect(() => NavItemSchema.parse({ instanceId: '' })).toThrow()
    expect(() => NavItemSchema.parse({ instanceId: 'a'.repeat(65) })).toThrow()
  })
  it('flags a widget the catalog does not know', () => {
    expect(validateNavWidgets(withNav([{ instanceId: 'a', widgetId: 'ghost' }]), navManifests))
      .toEqual(['écran Xeneon Edge, barre de navigation : widget inconnu ghost'])
  })
  it('flags a widget without a compact rendering', () => {
    expect(validateNavWidgets(withNav([{ instanceId: 'a', widgetId: 'plain' }]), navManifests).join())
      .toMatch(/^écran Xeneon Edge, barre de navigation : .*n’a pas de rendu compact/)
  })
  it('flags an instance twice in one bar, through validateLayout', () => {
    const c = withNav([{ instanceId: 'a', widgetId: 'clock' }, { instanceId: 'a', widgetId: 'clock' }])
    expect(validateLayout(c, navManifests)).toEqual(['écran Xeneon Edge : a y figure plus d’une fois'])
    expect(validateNavWidgets(c, navManifests)).toEqual([])
  })
  it('answers in English when the config asks for it', () => {
    expect(validateNavWidgets(withNav([{ instanceId: 'a', widgetId: 'plain' }], 'en'), navManifests))
      .toEqual(['screen Xeneon Edge, navigation bar: widget plain has no compact rendering'])
  })
  it(`refuses more than ${MAX_NAV_WIDGETS} entries`, () => {
    const many = Array.from({ length: MAX_NAV_WIDGETS + 1 }, (_, i) => ({ instanceId: 'n' + i, widgetId: 'clock' }))
    expect(() => withNav(many)).toThrow()
    expect(withNav(many.slice(0, MAX_NAV_WIDGETS)).screens[0].nav).toHaveLength(MAX_NAV_WIDGETS)
  })
})

describe('screens', () => {
  // Pinned to French like the blocks above, except where a case says otherwise.
  const screenManifests = new Map<string, LayoutManifest>([
    ['clock', { minSize: [8, 4], compact: { width: 4 }, settingsSchema: { compactDate: { default: false } } }],
    ['pill', { minSize: [8, 4], compact: { width: 4 } }],
  ])
  const page = (id: string, items: Placement[] = []) => ({ id, name: id.toUpperCase(), items })
  const screen = (id: string, name: string, extra: object = {}) => ({ id, name, kind: 'edge', pages: [page('p')], ...extra })
  const config = (widgets: Record<string, unknown>, screens: object[], locale: 'fr' | 'en' = 'fr'): Config =>
    ConfigSchema.parse({ version: 4, locale, widgets, screens })

  it('flags two screens sharing an id, naming the second', () => {
    const c = config({}, [screen('edge', 'Xeneon Edge'), screen('edge', 'Tablet')])
    expect(validateLayout(c, screenManifests)).toEqual(['écran Tablet : identifiant edge déjà pris par un autre écran'])
  })
  it('flags two pages sharing an id on one screen, and allows it across screens', () => {
    const dup = config({}, [screen('edge', 'Xeneon Edge', { pages: [page('p'), page('p')] })], 'en')
    expect(validateLayout(dup, screenManifests)).toEqual(['screen Xeneon Edge: duplicate page p'])
    const across = config({}, [screen('edge', 'Xeneon Edge'), screen('tab', 'Tablet')])
    expect(validateLayout(across, screenManifests)).toEqual([])
  })
  it('flags a placement naming a widget that does not exist', () => {
    const c = config({}, [screen('tab', 'Tablet', { pages: [page('p', [{ instanceId: 'ghost-1', x: 0, y: 0, w: 8, h: 4 }])] })])
    expect(validateLayout(c, screenManifests)).toEqual(['écran Tablet : ghost-1 ne désigne aucun widget'])
  })
  it('flags a bar entry naming a widget that does not exist', () => {
    const c = config({}, [screen('tab', 'Tablet', { nav: [{ instanceId: 'ghost-1' }] })], 'en')
    expect(validateLayout(c, screenManifests)).toEqual(['screen Tablet: ghost-1 names no widget'])
    // validateLayout reports it; the bar's own checks have nothing to add about a missing widget.
    expect(validateNavWidgets(c, screenManifests)).toEqual([])
  })
  it('treats Object.prototype names as missing widgets, not as inherited ones', () => {
    for (const instanceId of ['constructor', 'toString', '__proto__']) {
      const placed = config({}, [screen('tab', 'Tablet', { pages: [page('p', [{ instanceId, x: 0, y: 0, w: 8, h: 4 }])] })], 'en')
      expect(validateLayout(placed, screenManifests)).toEqual([`screen Tablet: ${instanceId} names no widget`])
      const inBar = config({}, [screen('tab', 'Tablet', { nav: [{ instanceId }] })], 'en')
      expect(validateLayout(inBar, screenManifests)).toEqual([`screen Tablet: ${instanceId} names no widget`])
      expect(validateNavWidgets(inBar, screenManifests)).toEqual([])
      expect(navCellsUsed(inBar.screens[0], inBar.widgets, screenManifests)).toBe(0)
    }
  })
  it('flags an instance on two pages of one screen', () => {
    const c = config({ 'clock-1': { widgetId: 'clock' } }, [screen('tab', 'Tablet', { pages: [
      page('p', [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }]),
      page('q', [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }]),
    ] })])
    expect(validateLayout(c, screenManifests)).toEqual(['écran Tablet : clock-1 y figure plus d’une fois'])
  })
  it('flags an instance both in the bar and on a page of one screen', () => {
    const c = config({ 'clock-1': { widgetId: 'clock' } }, [screen('tab', 'Tablet', {
      nav: [{ instanceId: 'clock-1' }],
      pages: [page('p', [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }])],
    })])
    expect(validateLayout(c, screenManifests)).toEqual(['écran Tablet : clock-1 y figure plus d’une fois'])
  })
  it('a widget in the bar on one screen and as a tile on another is valid', () => {
    const c = config({ 'clock-1': { widgetId: 'clock' } }, [
      screen('edge', 'Xeneon Edge', { nav: [{ instanceId: 'clock-1' }] }),
      screen('tab', 'Tablet', { pages: [page('p', [{ instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 }])] }),
    ])
    expect(validateLayout(c, screenManifests)).toEqual([])
    expect(validateNavWidgets(c, screenManifests)).toEqual([])
  })
  it('checks each screen’s grid against its own display', () => {
    const c = config({ 'clock-1': { widgetId: 'clock' } }, [
      screen('edge', 'Xeneon Edge', { pages: [page('p', [{ instanceId: 'clock-1', x: 30, y: 0, w: 8, h: 4 }])] }),
      screen('tab', 'Tablet', { display: { cols: 34, rows: 23 }, pages: [page('p', [{ instanceId: 'clock-1', x: 30, y: 0, w: 8, h: 4 }])] }),
    ])
    expect(validateLayout(c, screenManifests)).toEqual(['écran Tablet, page p : clock-1 hors grille'])
  })
  // Room is measured in CSS px against the wider cluster (navHasRoom in nav.ts): a 34-column
  // Tablet is 1360 px, the dots keep 400, so each side may take 480. A 4-cell pill is 160 px,
  // plus 12 px between widgets and 24 px of padding: two pills on a side take 356, three 528.
  const pills = (widgets: Record<string, unknown>, ids: string[], slot: 'left' | 'right' = 'left') =>
    ids.map((instanceId) => { widgets[instanceId] ??= { widgetId: 'pill' }; return { instanceId, slot } })
  it('flags a bar whose wider cluster leaves the page dots no room', () => {
    const widgets: Record<string, unknown> = {}
    const nav = pills(widgets, ['p0', 'p1', 'p2'])
    const c = config(widgets, [screen('tab', 'Tablet', { display: { cols: 34 }, nav })])
    expect(validateNavWidgets(c, screenManifests)).toEqual(['écran Tablet, barre de navigation : son groupe de widgets le plus large prend 528 px sur les 480 px que les pages laissent de chaque côté'])
    c.screens[0].nav.pop()
    expect(validateNavWidgets(c, screenManifests)).toEqual([])
  })
  it('counts the wider side only: the same pills split between both sides fit', () => {
    const widgets: Record<string, unknown> = {}
    const nav = [...pills(widgets, ['p0', 'p1']), ...pills(widgets, ['p2', 'p3'], 'right')]
    const c = config(widgets, [screen('tab', 'Tablet', { display: { cols: 34 }, nav })])
    expect(validateNavWidgets(c, screenManifests)).toEqual([])
  })
  it('reserves the named pages\' width, up to the centre track\'s cap', () => {
    // The Edge is 2560 px. Twelve names take the 1200 px cap, leaving 680 a side: three pills
    // (528) fit, four (700) do not. Three names take 376, so four pills fit beside them.
    const edge = (pageCount: number, n: number) => {
      const widgets: Record<string, unknown> = {}
      const pages = Array.from({ length: pageCount }, (_, i) => page('p' + i))
      return config(widgets, [screen('edge', 'Xeneon Edge', {
        display: { navStyle: 'names' }, pages, nav: pills(widgets, Array.from({ length: n }, (_, i) => 'p' + i)),
      })], 'en')
    }
    expect(navCentreWidth(edge(12, 0).screens[0])).toBe(NAV_NAMES_MAX_WIDTH)
    expect(validateNavWidgets(edge(12, 3), screenManifests)).toEqual([])
    expect(validateNavWidgets(edge(12, 4), screenManifests))
      .toEqual(['screen Xeneon Edge, navigation bar: its wider widget cluster takes 700 px of the 680 px the pages leave on each side'])
    expect(navCentreWidth(edge(3, 0).screens[0])).toBe(376)
    expect(validateNavWidgets(edge(3, 4), screenManifests)).toEqual([])
  })
  it('scales the gaps and the names with a slim bar', () => {
    const widgets: Record<string, unknown> = {}
    const c = config(widgets, [screen('edge', 'Xeneon Edge', {
      display: { navHeight: 40, navStyle: 'names' }, pages: Array.from({ length: 12 }, (_, i) => page('p' + i)),
      nav: pills(widgets, ['p0', 'p1']),
    })])
    // Two pills at half the gaps and padding: 320 + 6 + 12.
    expect(navWiderClusterWidth(c.screens[0], c.widgets, screenManifests)).toBe(338)
    expect(navCentreWidth(c.screens[0])).toBe(600)
    expect(navHasRoom(c.screens[0], c.widgets, screenManifests)).toBe(true)
  })
  it('a setting that widens a shared bar widget overflows the narrow screen only', () => {
    const shared = (compactDate: boolean) => {
      const widgets: Record<string, unknown> = { 'clock-1': { widgetId: 'clock', settings: { compactDate } } }
      return config(widgets, [
        // 2560 px: the clock and two pills on one side never come near the 1080 px a side.
        screen('edge', 'Xeneon Edge', { nav: [{ instanceId: 'clock-1' }, ...pills(widgets, ['a1', 'a2'])] }),
        // 480 px a side: a pill and the clock take 356, and 516 once the clock shows its date.
        screen('tab', 'Tablet', { display: { cols: 34 }, nav: [...pills(widgets, ['b1', 'b2']), ...pills(widgets, ['b3'], 'right'), { instanceId: 'clock-1', slot: 'right' }] }),
      ], 'en')
    }
    expect(validateNavWidgets(shared(false), screenManifests)).toEqual([])
    expect(validateNavWidgets(shared(true), screenManifests))
      .toEqual(['screen Tablet, navigation bar: its wider widget cluster takes 516 px of the 480 px the pages leave on each side'])
  })

  describe('against the config being replaced', () => {
    // Tablet: 480 px a side. `n` pills on the left, plus a renamed page to stand for an edit that
    // has nothing to do with the bar.
    const tablet = (n: number, pageName = 'P', id = 'tab') => {
      const widgets: Record<string, unknown> = {}
      const nav = pills(widgets, Array.from({ length: n }, (_, i) => 'p' + i))
      return config(widgets, [screen(id, 'Tablet', { display: { cols: 34 }, nav, pages: [{ id: 'p', name: pageName, items: [] }] })], 'en')
    }
    const refusal = (used: number) => [`screen Tablet, navigation bar: its wider widget cluster takes ${used} px of the 480 px the pages leave on each side`]

    it('lets an unrelated save through when the stored bar is already over the limit', () => {
      expect(validateNavWidgets(tablet(3, 'Renamed'), screenManifests, tablet(3))).toEqual([])
    })
    it('lets a save that narrows an over-full bar through, even if still over', () => {
      expect(validateNavWidgets(tablet(3), screenManifests, tablet(4))).toEqual([])
    })
    it('refuses a save that widens a bar already over the limit', () => {
      expect(validateNavWidgets(tablet(4), screenManifests, tablet(3))).toEqual(refusal(700))
    })
    it('refuses a save that takes a bar over the limit', () => {
      expect(validateNavWidgets(tablet(3), screenManifests, tablet(2))).toEqual(refusal(528))
    })
    it('refuses a new screen over the limit', () => {
      expect(validateNavWidgets(tablet(3, 'P', 'tab-2'), screenManifests, tablet(3))).toEqual(refusal(528))
    })
    it('without the previous config, refuses any bar over the limit', () => {
      expect(validateNavWidgets(tablet(3, 'Renamed'), screenManifests)).toEqual(refusal(528))
    })
  })
})

describe('nav.ts', () => {
  const navManifests = new Map<string, LayoutManifest>([
    ['clock', { minSize: [8, 4], compact: { width: 4 }, settingsSchema: { compactDate: { default: false } } }],
    ['wide', { minSize: [8, 4], compact: { width: 4 }, settingsSchema: { compactCities: { default: true } } }],
    ['plain', { minSize: [8, 4] }],
  ])
  it('widens a compact widget when a wide setting is on, from the instance or the manifest default', () => {
    expect(compactWidth(navManifests.get('clock'), {})).toBe(4)
    expect(compactWidth(navManifests.get('clock'), { compactDate: true })).toBe(WIDE_COMPACT_WIDTH)
    expect(compactWidth(navManifests.get('wide'), {})).toBe(WIDE_COMPACT_WIDTH)
    expect(compactWidth(navManifests.get('wide'), { compactCities: false })).toBe(4)
  })
  it('gives 0 to a widget with no compact rendering or no manifest', () => {
    expect(compactWidth(navManifests.get('plain'), { compactDate: true })).toBe(0)
    expect(compactWidth(undefined, {})).toBe(0)
  })
  it('sums a screen’s bar, counting a missing or unknown widget as 0', () => {
    const c = ConfigSchema.parse(v4(
      { widgets: { c: { widgetId: 'clock' }, w: { widgetId: 'wide' }, g: { widgetId: 'ghost' } } },
      { nav: [{ instanceId: 'c' }, { instanceId: 'w' }, { instanceId: 'g' }, { instanceId: 'missing' }] },
    ))
    expect(navCellsUsed(c.screens[0], c.widgets, navManifests)).toBe(4 + WIDE_COMPACT_WIDTH)
    expect(NAV_CENTRE_RESERVE_CELLS).toBe(10)
    expect(WIDE_COMPACT_SETTINGS).toEqual(['compactDate', 'compactCities'])
  })
})

describe('validateLayout against a converted v1 manifest', () => {
  // A v1 manifest declares `sizes` on the old grid; ManifestSchema doubles the smallest one,
  // so [4, 2] becomes the [8, 4] minimum the layout is held to.
  const legacy = ManifestSchema.parse({ id: 'clock', name: 'Horloge', version: '1.0.0', sizes: [[8, 2], [4, 2], [8, 4]] })
  const converted = new Map([['clock', { minSize: legacy.minSize }]])
  const layout = (w: number, h: number) => withItems('fr', [{ instanceId: 'a', x: 0, y: 0, w, h }])

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
  const base = v4({ locale: 'fr' })

  it('defaults connections to an empty list and picks a secrets backend', () => {
    const parsed = ConfigSchema.parse(base)
    expect(parsed.connections).toEqual([])
    expect(parsed.secrets.backend).toBe(defaultSecretsBackend())
  })

  it('accepts every secrets backend, DPAPI included, and nothing else', () => {
    for (const backend of ['keychain', 'file', 'dpapi'] as const) {
      expect(ConfigSchema.parse({ ...base, secrets: { backend } }).secrets.backend).toBe(backend)
    }
    expect(ConfigSchema.safeParse({ ...base, secrets: { backend: 'plaintext' } }).success).toBe(false)
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
  const base = v4()

  it('reads French from a French system locale and English from anything else', () => {
    for (const l of ['fr', 'fr-FR', 'FR-ca']) expect(defaultLocale(l)).toBe('fr')
    for (const l of ['en-US', 'de-DE', 'ja', '']) expect(defaultLocale(l)).toBe('en')
  })

  it('leaves a file without a locale valid and fills the system default in', () => {
    expect(ConfigSchema.parse(base).locale).toBe(defaultLocale())
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
  const display = (extra: object) => ScreenDisplaySchema.safeParse({ cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, ...extra })

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

describe('tile icons', () => {
  const withIcon = (icon: unknown) => ConfigSchema.parse(v4({ widgets: { a: { widgetId: 'clock', icon } } })).widgets.a

  it('leaves icon absent on an existing file', () => {
    const parsed = ConfigSchema.parse(v4({ widgets: { a: { widgetId: 'clock' } } }))
    expect(parsed.widgets.a).not.toHaveProperty('icon')
  })
  // The field is optional and absent means no icon, so it needs no version bump: a v4 file
  // written before it existed reads unchanged, and the migration carries one written after.
  it('keeps the icon through migrateConfig and adds none to a migrated v3 file', () => {
    const icon = { kind: 'lucide', name: 'server' }
    expect(migrateConfig(v4({ widgets: { a: { widgetId: 'clock', icon } } })).widgets.a.icon).toEqual(icon)
    const v3 = { version: 3, pages: [{ id: 'p', name: 'P', widgets: [{ instanceId: 'a', widgetId: 'clock', x: 0, y: 0, w: 8, h: 4 }] }] }
    const migrated = migrateConfig(v3)
    expect(migrated.version).toBe(4)
    expect(Object.values(migrated.widgets).every((w) => !('icon' in w))).toBe(true)
  })
  it('round-trips a pictogram and a file, tinted or not', () => {
    for (const icon of [
      { kind: 'lucide', name: 'server' },
      { kind: 'file', name: '1729000000000-nas.svg' },
      { kind: 'file', name: '1729000000000-logo.png', tint: false },
    ]) expect(withIcon(icon).icon).toEqual(icon)
  })
  it('accepts a well-formed pictogram name it does not know', () => {
    // The choosable list lives in the UI; a name a later version dropped renders as no icon.
    expect(withIcon({ kind: 'lucide', name: 'not-in-the-set' }).icon).toEqual({ kind: 'lucide', name: 'not-in-the-set' })
  })
  it('refuses an unknown kind, a bad pictogram name, an unsafe file name and an explicit tint', () => {
    for (const icon of [
      { kind: 'emoji', name: 'x' },
      { kind: 'lucide', name: 'Bad Name' },
      { kind: 'lucide', name: '' },
      { kind: 'lucide', name: 'a'.repeat(41) },
      { kind: 'file', name: '../secret.svg' },
      { kind: 'file', name: 'a/b.svg' },
      { kind: 'file', name: '.hidden.svg' },
      { kind: 'file', name: '1-photo.jpg' },
      // An upper-case extension: the server only ever stores the lower-case one, and serves by it.
      { kind: 'file', name: '1-nas.SVG' },
      { kind: 'file', name: '1-nas.svg', tint: true },
    ]) expect(() => withIcon(icon), JSON.stringify(icon)).toThrow()
  })
  it('drops a tint carried by a pictogram, which is always tinted', () => {
    // zod strips the key it does not know on that branch rather than refusing the tile.
    expect(withIcon({ kind: 'lucide', name: 'server', tint: false }).icon).toEqual({ kind: 'lucide', name: 'server' })
  })
})

describe('isSafeTileIconName', () => {
  it('takes a stored name with an icon extension', () => {
    expect(isSafeTileIconName('1729-nas.svg')).toBe(true)
    expect(isSafeTileIconName('1729-nas.webp')).toBe(true)
    expect(isSafeTileIconName('1729-nas.png')).toBe(true)
  })
  it('refuses anything else', () => {
    for (const n of ['1729-nas.jpg', '1729-nas', '../x.svg', '.x.svg', 'a..svg', 42, '']) expect(isSafeTileIconName(n), String(n)).toBe(false)
  })
})

describe('nav.ts mirrors the UI', () => {
  // The admin applies the bar's width rule while editing, the server again at save: if the two
  // drift, the admin offers what the server refuses. The UI file is read as text to keep the
  // server's tests free of the UI's imports.
  const ui = readFileSync(new URL('../../ui/src/shared/types.ts', import.meta.url), 'utf8')
  it('has the same constants as ui/src/shared/types.ts', () => {
    expect(ui).toMatch(new RegExp(`export const NAV_CENTRE_RESERVE_CELLS = ${NAV_CENTRE_RESERVE_CELLS}\\b`))
    expect(ui).toMatch(new RegExp(`export const NAV_NAMES_MAX_WIDTH = ${NAV_NAMES_MAX_WIDTH}\\b`))
    expect(ui).toMatch(new RegExp(`export const WIDE_COMPACT_WIDTH = ${WIDE_COMPACT_WIDTH}\\b`))
    const list = WIDE_COMPACT_SETTINGS.map((k) => `'${k}'`).join(', ')
    expect(ui).toContain(`export const WIDE_COMPACT_SETTINGS = [${list}] as const`)
  })
})

describe('privacy.wslDistros', () => {
  it('is empty by default, so no distribution is read until one is ticked', () => {
    expect(DEFAULT_CONFIG.privacy.wslDistros).toEqual([])
    expect(ConfigSchema.parse(v4()).privacy.wslDistros).toEqual([])
    expect(migrateConfig({ ...DEFAULT_CONFIG, privacy: { claudeAccountUsage: false } }).privacy.wslDistros).toEqual([])
    expect(migrateConfig({ version: 2, pages: [{ id: 'home', name: 'Home', widgets: [] }] }).privacy.wslDistros).toEqual([])
  })
  it('accepts a distribution name and refuses anything that could be a path or an option', () => {
    expect(ConfigSchema.parse(v4({ privacy: { wslDistros: ['Ubuntu-24.04', 'Debian'] } })).privacy.wslDistros).toEqual(['Ubuntu-24.04', 'Debian'])
    for (const bad of ['../x', 'a/b', 'a\\b', '', '-d x', 'x'.repeat(65), 'Ubuntu ']) {
      expect(ConfigSchema.safeParse(v4({ privacy: { wslDistros: [bad] } })).success, bad).toBe(false)
    }
    expect(ConfigSchema.safeParse(v4({ privacy: { wslDistros: Array.from({ length: 17 }, (_, i) => `d${i}`) } })).success).toBe(false)
  })
})
