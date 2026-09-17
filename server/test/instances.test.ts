import { describe, expect, it } from 'vitest'
import { findInstance, noInstances } from '../src/config/instances.js'
import { ConfigSchema, type Config } from '../src/config/schema.js'

const config = (): Config => ConfigSchema.parse({
  version: 2,
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
    expect(findInstance(config(), 'nav-1')).toMatchObject({ widgetId: 'service-status' })
  })
  it('answers null for an id nothing carries', () => {
    for (const id of ['ghost', '', 'SC-1']) expect(findInstance(config(), id), id).toBeNull()
  })
})

describe('noInstances', () => {
  it('knows nothing, which is the safe default for a provider nobody wired up', () => {
    expect(noInstances('sc-1')).toBeNull()
  })
})
