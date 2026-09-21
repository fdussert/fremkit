import { describe, expect, it } from 'vitest'
import { findInstance, findInstances, noInstances } from '../src/config/instances.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'

const config = (): Config => ConfigSchema.parse({
  version: 3,
  display: {
    cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0,
    navWidgets: [{ instanceId: 'nav-1', widgetId: 'service-status', settings: { services: [{ kind: 'ping', name: 'GW', url: '127.0.0.1' }] } }],
  },
  pages: [
    { id: 'home', name: 'Accueil', widgets: [
      { instanceId: 'sc-1', widgetId: 'shortcuts', x: 0, y: 0, w: 16, h: 8, settings: { buttons: [{ kind: 'app', target: 'Calculator' }] } },
    ] },
    { id: 'second', name: 'Deux', widgets: [
      { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, settings: {} },
      { instanceId: 'sc-2', widgetId: 'shortcuts', x: 0, y: 8, w: 16, h: 8, settings: { buttons: [] } },
    ] },
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
  it('finds one in the navigation bar', () => {
    // The bar holds instances too, and a command from one must resolve just the same.
    const found = findInstance(config(), 'nav-1')
    expect(found).toMatchObject({ widgetId: 'service-status' })
    expect(found?.settings.services).toEqual([{ kind: 'ping', name: 'GW', url: '127.0.0.1' }])
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
})

describe('findInstances', () => {
  it('lists every placed tile of one widget, pages first then the bar', () => {
    // The other question a provider asks: not "what did *this* tile save" but "does any tile of
    // mine want something" — a setting the core acts on has nowhere else to live.
    expect(findInstances(config(), 'shortcuts').map((i) => i.settings.buttons)).toEqual([
      [{ kind: 'app', target: 'Calculator' }], [],
    ])
    expect(findInstances(config(), 'service-status')).toHaveLength(1)
  })
  it('answers an empty list for a widget no page places', () => {
    expect(findInstances(config(), 'claude-sessions')).toEqual([])
  })
})

describe('noInstances', () => {
  it('knows nothing, which is the safe default for a provider nobody wired up', () => {
    expect(noInstances('sc-1')).toBeNull()
  })
})
