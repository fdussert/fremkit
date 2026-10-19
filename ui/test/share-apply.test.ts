import { describe, it, expect } from 'vitest'
import { mergeLayout, skippedDeviceScreens, type ImportChoices } from '../src/admin/shareApply'
import type { Config, LayoutFile, SharedScreen, WidgetManifest } from '../src/shared/types'

function manifest(id: string, minSize: [number, number], defaultSize: [number, number], compact?: number): WidgetManifest {
  return {
    id, name: { fr: id, en: id }, version: '1.0.0', sdk: 1, description: '', icon: 'clock',
    minSize, defaultSize, subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
    ...(compact ? { compact: { width: compact } } : {}),
  }
}
const MANIFESTS: Record<string, WidgetManifest> = {
  clock: manifest('clock', [4, 2], [8, 4], 3),
  calendar: manifest('calendar', [4, 2], [8, 4]),
}

function mine(): Config {
  return {
    version: 4, theme: 'fremkit', locale: 'en', connections: [],
    // This Mac already has an iPad screen, which is what turns the experimental feature on.
    labs: { devices: true },
    widgets: { old: { widgetId: 'clock', showTitle: true, settings: {} }, shared: { widgetId: 'clock', showTitle: true, settings: {} } },
    screens: [
      { id: 'edge', name: 'Xeneon Edge', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, nav: [],
        pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'old', x: 0, y: 0, w: 8, h: 4 }, { instanceId: 'shared', x: 8, y: 0, w: 8, h: 4 }] }] },
      { id: 'ipad', name: 'Tablet', kind: 'device', display: { cols: 20, rows: 18, cell: 40, autoCycleSeconds: 0, navHeight: 40 }, nav: [],
        pages: [{ id: 'p', name: 'P', items: [{ instanceId: 'shared', x: 0, y: 0, w: 8, h: 4 }] }] },
    ],
  } as unknown as Config
}

const edgeScreen = (over: Partial<SharedScreen> = {}): SharedScreen => ({
  name: 'Desk', kind: 'edge', display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, navOpacity: 0.5, background: { image: 'image-1.png', fit: 'cover' } },
  nav: [{ widget: 'w3', slot: 'right' }],
  pages: [{ name: 'Work', items: [{ widget: 'w1', x: 0, y: 0, w: 8, h: 4 }, { widget: 'w2', x: 50, y: 10, w: 10, h: 4 }] }],
  ...over,
})

function file(scope: LayoutFile['scope'], screens: SharedScreen[] = [edgeScreen()]): LayoutFile {
  return {
    format: 'fremkit-layout', version: 1, scope, theme: { day: 'edge' },
    widgets: {
      w1: { widgetId: 'clock', showTitle: false, bgColor: '#112233', settings: { format: '24h' }, background: { image: 'image-1.png', dim: 0.3 } },
      w2: { widgetId: 'calendar', showTitle: true, settings: { days: 3 } },
      w3: { widgetId: 'clock', showTitle: true, settings: {} },
    },
    catalog: {}, screens, images: {},
  }
}

const choices = (over: Partial<ImportChoices> = {}): ImportChoices => ({
  mode: 'add', images: { 'image-1.png': '123-image-1.png' }, connections: { 'w2:source': 'my-cal' }, theme: false, ...over,
})

const pageFile = (): LayoutFile => {
  const f = file('page', [edgeScreen({ nav: [] })])
  delete (f.widgets as Record<string, unknown>).w3
  return f
}

describe('mergeLayout', () => {
  it('adds a page after the existing ones, with new widgets set up as in the file', () => {
    const cfg = mine()
    const out = mergeLayout(cfg, pageFile(), { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    const edge = cfg.screens[0]
    expect(edge.pages.map((p) => p.name)).toEqual(['Home', 'Work'])
    expect(out).toEqual({ screenId: 'edge', pageIndex: 1, leftOut: 0, skippedDevices: 0 })
    const [a, b] = edge.pages[1].items
    expect(a).toMatchObject({ x: 0, y: 0, w: 8, h: 4 })
    expect(cfg.widgets[a.instanceId]).toEqual({ widgetId: 'clock', showTitle: false, bgColor: '#112233', settings: { format: '24h' }, background: { image: '123-image-1.png', dim: 0.3 } })
    expect(cfg.widgets[b.instanceId].settings).toEqual({ days: 3, source: 'my-cal' })
    // Nothing of what was there moved.
    expect(edge.pages[0].items.map((i) => i.instanceId)).toEqual(['old', 'shared'])
    expect(cfg.theme).toBe('fremkit')
  })

  it('replaces only the current page when asked, dropping the widgets it alone showed', () => {
    const cfg = mine()
    mergeLayout(cfg, pageFile(), { screenId: 'edge', pageIndex: 0 }, choices({ mode: 'replace' }), MANIFESTS)
    expect(cfg.screens[0].pages.map((p) => [p.id, p.name])).toEqual([['home', 'Work']])
    expect(cfg.widgets.old).toBeUndefined()
    // Still shown on the tablet.
    expect(cfg.widgets.shared).toBeDefined()
  })

  it('re-arranges a page that does not fit the target grid', () => {
    const cfg = mine()
    const out = mergeLayout(cfg, pageFile(), { screenId: 'ipad', pageIndex: 0 }, choices(), MANIFESTS)
    const added = cfg.screens[1].pages[1]
    for (const i of added.items) {
      expect(i.x + i.w).toBeLessThanOrEqual(20)
      expect(i.y + i.h).toBeLessThanOrEqual(18)
    }
    expect(added.items).toHaveLength(2)
    expect(out.leftOut).toBe(0)
  })

  it('adds a screen with its own grid, bar and look', () => {
    const cfg = mine()
    const out = mergeLayout(cfg, file('screen'), { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    expect(cfg.screens.map((s) => s.id)).toEqual(['edge', 'ipad', 'desk'])
    const desk = cfg.screens[2]
    expect(out.screenId).toBe('desk')
    expect(desk.display.background).toEqual({ image: '123-image-1.png', fit: 'cover' })
    expect(desk.nav).toHaveLength(1)
    expect(desk.pages[0].items).toHaveLength(2)
  })

  it('replaces the current screen in place: same id, same grid, the file’s pages and bar', () => {
    const cfg = mine()
    mergeLayout(cfg, file('screen'), { screenId: 'edge', pageIndex: 0 }, choices({ mode: 'replace' }), MANIFESTS)
    const edge = cfg.screens[0]
    expect(edge.id).toBe('edge')
    expect(edge.name).toBe('Xeneon Edge')
    expect(edge.display.navOpacity).toBe(0.5)
    expect(edge.pages.map((p) => p.name)).toEqual(['Work'])
    expect(cfg.widgets.old).toBeUndefined()
    expect(cfg.widgets.shared).toBeDefined()
  })

  it('replaces the whole setup screen for screen, keeping ids by kind, and takes the theme', () => {
    const cfg = mine()
    const tablet: SharedScreen = { name: 'Tab', kind: 'device', display: { cols: 30, rows: 20, cell: 40, autoCycleSeconds: 0 }, nav: [],
      pages: [{ name: 'T', items: [{ widget: 'w1', x: 0, y: 0, w: 8, h: 4 }] }] }
    mergeLayout(cfg, file('setup', [edgeScreen(), tablet]), { screenId: 'edge', pageIndex: 0 }, choices({ mode: 'replace', theme: true }), MANIFESTS)
    expect(cfg.screens.map((s) => [s.id, s.name])).toEqual([['edge', 'Desk'], ['ipad', 'Tab']])
    // The tablet keeps its own grid.
    expect(cfg.screens[1].display.cols).toBe(20)
    expect(cfg.widgets.old).toBeUndefined()
    expect(cfg.widgets.shared).toBeUndefined()
    // One file widget on two screens is one widget here too.
    expect(cfg.screens[1].pages[0].items[0].instanceId).toBe(cfg.screens[0].pages[0].items[0].instanceId)
    expect(cfg.theme).toBe('edge')
  })

  it('adds a whole setup beside what is there, and skips widgets this Mac does not have', () => {
    const cfg = mine()
    const f = file('setup')
    f.widgets.w2.widgetId = 'not-here'
    mergeLayout(cfg, f, { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    expect(cfg.screens).toHaveLength(3)
    expect(cfg.screens[2].pages[0].items).toHaveLength(1)
    expect(Object.values(cfg.widgets).some((w) => w.widgetId === 'not-here')).toBe(false)
  })
  it('adds every screen of a setup file, not only the first', () => {
    const cfg = mine()
    const out = mergeLayout(cfg, file('setup', [edgeScreen(), edgeScreen({ name: 'Second' })]), { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    expect(cfg.screens.map((x) => x.name)).toEqual(['Xeneon Edge', 'Tablet', 'Desk', 'Second'])
    expect(out.screenId).toBe(cfg.screens[2].id)
  })
})

describe('importing device screens while iPad screens are an experimental feature that is off', () => {
  const tablet = (): SharedScreen => edgeScreen({ name: 'Tablet', kind: 'device', nav: [],
    display: { cols: 20, rows: 18, cell: 40, autoCycleSeconds: 0, navHeight: 40 },
    pages: [{ name: 'Wall', items: [{ widget: 'w2', x: 0, y: 0, w: 8, h: 4 }] }] })
  /** One Edge screen and the flag off: a fresh install. */
  const fresh = (): Config => {
    const c = mine()
    c.labs = { devices: false }
    c.screens = [c.screens[0]]
    return c
  }

  it('counts nothing to skip with the flag on, or for a page file', () => {
    expect(skippedDeviceScreens(mine(), file('setup', [edgeScreen(), tablet()]))).toBe(0)
    expect(skippedDeviceScreens(fresh(), file('page', [tablet()]))).toBe(0)
    expect(skippedDeviceScreens(fresh(), file('setup', [edgeScreen(), tablet()]))).toBe(1)
  })

  it('adds the Edge screens of a setup file and skips its device screens with their widgets', () => {
    const cfg = fresh()
    const out = mergeLayout(cfg, file('setup', [edgeScreen(), tablet()]), { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    expect(out.skippedDevices).toBe(1)
    expect(cfg.screens.map((x) => x.kind)).toEqual(['edge', 'edge'])
    // w2 was on both screens: it stays for the Edge. Nothing of the tablet's is left over.
    expect(Object.values(cfg.widgets).filter((w) => w.widgetId === 'calendar')).toHaveLength(1)
  })

  it('imports nothing from a device screen file and leaves the editor where it was', () => {
    const cfg = fresh()
    const before = JSON.stringify(cfg)
    const out = mergeLayout(cfg, file('screen', [tablet()]), { screenId: 'edge', pageIndex: 0 }, choices(), MANIFESTS)
    expect(out).toEqual({ screenId: 'edge', pageIndex: 0, leftOut: 0, skippedDevices: 1 })
    expect(JSON.stringify(cfg)).toBe(before)
  })

  it('keeps the device screens already here when a setup file replaces the rest', () => {
    const cfg = mine()
    cfg.labs = { devices: false }
    const out = mergeLayout(cfg, file('setup', [edgeScreen(), tablet()]), { screenId: 'edge', pageIndex: 0 }, choices({ mode: 'replace' }), MANIFESTS)
    expect(out.skippedDevices).toBe(1)
    expect(cfg.screens.map((x) => [x.id, x.kind])).toEqual([['edge', 'edge'], ['ipad', 'device']])
    expect(cfg.screens[1].pages[0].items.map((i) => i.instanceId)).toEqual(['shared'])
    expect(cfg.widgets.shared).toBeDefined()
  })
})
