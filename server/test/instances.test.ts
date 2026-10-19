import { describe, expect, it } from 'vitest'
import { findInstance, findInstances, noInstances, placeLabel, whereShown } from '../src/config/instances.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'

/**
 * Two screens sharing widgets: the Edge with two pages and a bar, and a device with one page and
 * a bar of its own. `sc-2` is on both screens, `nav-1` only in a bar, `tab-1` only on the device.
 */
const config = (): Config => ConfigSchema.parse({
  version: 4,
  locale: 'fr',
  privacy: {},
  marketplace: {},
  widgets: {
    'nav-1': { widgetId: 'service-status', settings: { services: [{ kind: 'ping', name: 'GW', url: '127.0.0.1' }] } },
    'sc-1': { widgetId: 'shortcuts', settings: { buttons: [{ kind: 'app', target: 'Calculator' }] } },
    'clock-1': { widgetId: 'clock', settings: {} },
    'sc-2': { widgetId: 'shortcuts', settings: { buttons: [] } },
    'tab-1': { widgetId: 'service-status', settings: { services: [] } },
  },
  screens: [
    {
      id: 'edge', name: 'Edge', kind: 'edge',
      nav: [{ instanceId: 'nav-1', slot: 'left' }],
      pages: [
        { id: 'home', name: 'Accueil', items: [{ instanceId: 'sc-1', x: 0, y: 0, w: 16, h: 8 }] },
        { id: 'second', name: 'Deux', items: [
          { instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 },
          { instanceId: 'sc-2', x: 0, y: 8, w: 16, h: 8 },
        ] },
      ],
    },
    {
      id: 'ipad', name: 'iPad', kind: 'device',
      nav: [{ instanceId: 'sc-2', slot: 'right' }],
      pages: [
        { id: 'tab', name: 'Tablette', items: [
          { instanceId: 'tab-1', x: 0, y: 0, w: 8, h: 4 },
          { instanceId: 'sc-2', x: 0, y: 4, w: 8, h: 4 },
        ] },
      ],
    },
  ],
})

describe('findInstance', () => {
  it('finds an instance on the first page', () => {
    expect(findInstance(config(), 'sc-1')).toMatchObject({ widgetId: 'shortcuts' })
    expect(findInstance(config(), 'sc-1')?.settings.buttons).toEqual([{ kind: 'app', target: 'Calculator' }])
  })
  it('finds one on a later page', () => {
    expect(findInstance(config(), 'clock-1')).toMatchObject({ widgetId: 'clock', settings: {} })
  })
  it('resolves a widget shown only in a bar', () => {
    // The bar holds instances too, and a command from one must resolve just the same.
    const found = findInstance(config(), 'nav-1')
    expect(found).toMatchObject({ widgetId: 'service-status' })
    expect(found?.settings.services).toEqual([{ kind: 'ping', name: 'GW', url: '127.0.0.1' }])
  })
  it('finds one shown only on another screen', () => {
    expect(findInstance(config(), 'tab-1')).toMatchObject({ widgetId: 'service-status' })
  })

  it('finds a bar instance by its real id, which is the one the popover sends', () => {
    // The popover used to hand the widget `<instanceId>:popup`, which is in no config at all —
    // so every probe from the popover came back as an unknown widget.
    expect(findInstance(config(), 'nav-1:popup')).toBeNull()
    expect(findInstance(config(), 'nav-1')).not.toBeNull()
  })
  it('answers null for an id nothing carries', () => {
    for (const id of ['ghost', '', 'SC-1']) expect(findInstance(config(), id), id).toBeNull()
  })
  it('answers null for the names every object inherits', () => {
    // `widgets` is a plain record: `constructor` is on it whether or not anyone saved one.
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(findInstance(config(), id), id).toBeNull()
    }
  })
})

describe('findInstances', () => {
  it('keeps first-appearance order and reports a widget on two screens once', () => {
    // Screens in order, each its pages then its bar: `sc-1` (Edge, page 1), then `sc-2` (Edge,
    // page 2) — and `sc-2` again on the iPad, page and bar, is the same widget, not two more.
    expect(findInstances(config(), 'shortcuts').map((i) => i.settings.buttons)).toEqual([
      [{ kind: 'app', target: 'Calculator' }], [],
    ])
  })
  it('puts a screen\'s pages before its bar, and an earlier screen before a later one', () => {
    // `nav-1` is in the Edge's bar, `tab-1` on the iPad's page: the Edge comes first.
    expect(findInstances(config(), 'service-status').map((i) => i.settings.services)).toEqual([
      [{ kind: 'ping', name: 'GW', url: '127.0.0.1' }], [],
    ])
  })
  it('answers an empty list for a widget nothing shows', () => {
    expect(findInstances(config(), 'claude-sessions')).toEqual([])
  })
})

describe('whereShown', () => {
  it('lists screen and page/bar', () => {
    const places = whereShown(config(), 'sc-2').map((p) => [p.screen.id, p.page?.id ?? null])
    expect(places).toEqual([['edge', 'second'], ['ipad', 'tab'], ['ipad', null]])
  })
  it('answers an empty list for an instance nothing places', () => {
    expect(whereShown(config(), 'ghost')).toEqual([])
  })
})

describe('placeLabel', () => {
  it('names the screen when there are two', () => {
    const c = config()
    expect(whereShown(c, 'sc-2').map((p) => placeLabel(c, p))).toEqual([
      'Edge › Deux', 'iPad › Tablette', 'iPad › la barre de navigation',
    ])
  })
  it('names the page alone when there is one screen', () => {
    const c = config()
    c.screens = [c.screens[0]]
    expect(whereShown(c, 'nav-1').map((p) => placeLabel(c, p))).toEqual(['la barre de navigation'])
    expect(whereShown(c, 'sc-1').map((p) => placeLabel(c, p))).toEqual(['Accueil'])
  })
})

describe('noInstances', () => {
  it('knows nothing, which is the safe default for a provider nobody wired up', () => {
    expect(noInstances('sc-1')).toBeNull()
  })
})
