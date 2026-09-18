import { describe, expect, it } from 'vitest'
import { channelFamilies, channelFamily, notGranted, widgetPermissions } from '../src/admin/permissions'
import { iconSvg } from '../src/shared/icons'
import type { WidgetManifest } from '../src/shared/types'

const manifest = (over: Partial<WidgetManifest> = {}): WidgetManifest => ({
  id: 'w', name: 'W', version: '1.0.0', sdk: 1, description: '', icon: 'layout-grid',
  minSize: [4, 2], defaultSize: [4, 2],
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
  ...over,
})

describe('channelFamily', () => {
  it('reads a wildcard as its family', () => {
    expect(channelFamily('azure-devops:*')).toBe('azure-devops')
    expect(channelFamily('homey:*')).toBe('homey')
  })
  it('reads a per-connection channel as its family too', () => {
    expect(channelFamily('github:gh-x1z9')).toBe('github')
    expect(channelFamily('calendar:ics-abc')).toBe('calendar')
  })
  it('leaves a plain channel alone', () => {
    expect(channelFamily('volume')).toBe('volume')
    expect(channelFamily('claude-account')).toBe('claude-account')
  })
})

describe('channelFamilies', () => {
  it('deduplicates and sorts', () => {
    // Asking for the family and one of its members is asking for one thing.
    expect(channelFamilies(['homey:*', 'homey:abc', 'volume'])).toEqual(['homey', 'volume'])
    expect(channelFamilies(['volume', 'battery', 'system'])).toEqual(['battery', 'system', 'volume'])
  })
  it('answers empty for nothing', () => {
    expect(channelFamilies([])).toEqual([])
  })
})

describe('widgetPermissions', () => {
  it('separates what a widget reads, controls and reaches', () => {
    const p = widgetPermissions(manifest({
      subscriptions: ['homey:*', 'volume'],
      commands: ['homey:*'],
      permissions: { network: ['api.open-meteo.com', 'geocoding-api.open-meteo.com'] },
    }))
    expect(p.reads).toEqual(['homey', 'volume'])
    expect(p.controls).toEqual(['homey'])
    expect(p.network).toEqual(['api.open-meteo.com', 'geocoding-api.open-meteo.com'])
    expect(p.none).toBe(false)
    expect(p.count).toBe(5)
  })
  it('says so when a widget asks for nothing', () => {
    const p = widgetPermissions(manifest())
    expect(p).toMatchObject({ reads: [], controls: [], network: [], none: true, count: 0 })
  })
  it('survives an unknown manifest', () => {
    expect(widgetPermissions(undefined).none).toBe(true)
  })
  it('deduplicates the hosts as well', () => {
    const p = widgetPermissions(manifest({ permissions: { network: ['b.example', 'a.example', 'b.example'] } }))
    expect(p.network).toEqual(['a.example', 'b.example'])
  })
})

describe('iconSvg', () => {
  it('renders a known icon', () => {
    expect(iconSvg('eye', 14)).toContain('width="14"')
    for (const name of ['eye', 'zap', 'globe']) {
      expect(iconSvg(name), name).not.toBe(iconSvg('layout-grid'))
    }
  })
  it('falls back for an unknown name, and for one that names a prototype member', () => {
    const fallback = iconSvg('layout-grid')
    for (const name of [undefined, '', 'nope', 'constructor', '__proto__', 'toString', 'valueOf']) {
      expect(iconSvg(name), String(name)).toBe(fallback)
    }
    // A manifest naming `constructor` used to put `function Object() { … }` into the markup.
    expect(iconSvg('constructor')).not.toContain('native code')
  })
})

describe('notGranted', () => {
  const granted = manifest({
    subscriptions: ['synology:*'], commands: ['synology'],
    permissions: { network: ['api.example.com'] },
  })

  it('is empty when the ask and the grant agree', () => {
    const asks = { subscriptions: ['synology:*'], commands: ['synology'], network: ['api.example.com'] }
    expect(notGranted(granted, asks).none).toBe(true)
  })

  it('names what the manifest asks for and the record does not cover', () => {
    // The manifest is the ask and the consent record is the grant; an update can widen the
    // first without touching the second, and the widget then just looks broken.
    const asks = {
      subscriptions: ['synology:*', 'system'],
      commands: ['synology', 'shortcuts'],
      network: ['api.example.com', 'evil.example'],
    }
    const missing = notGranted(granted, asks)
    expect(missing.reads).toEqual(['system'])
    expect(missing.controls).toEqual(['shortcuts'])
    expect(missing.network).toEqual(['evil.example'])
    expect(missing.count).toBe(3)
  })

  it('is empty for a built-in, which has no ask to compare against', () => {
    expect(notGranted(granted, undefined).none).toBe(true)
    expect(notGranted(undefined, { subscriptions: ['x'], commands: [], network: [] }).none).toBe(true)
  })
})
