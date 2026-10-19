import { describe, it, expect } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { WIDGET_DEV_CHANNEL } from '../src/widgets/dev.js'
import { SCREEN_RELOAD_CHANNEL } from '../src/config/screen-reload.js'
import { channelAllowed, HOST_CHANNELS, screenChannels, type ChannelManifest } from '../src/devices/channels.js'

const manifests = new Map<string, ChannelManifest>([
  ['spotify', { subscriptions: ['spotify'], commands: ['spotify'] }],
  ['clock', {
    subscriptions: ['calendar:*'],
    commands: [],
    settingsSchema: { city: { preview: { channel: 'weather' } }, label: {} },
  }],
  ['system', { subscriptions: ['system'], commands: ['system-cmd'] }],
])

function config(): Config {
  return ConfigSchema.parse({
    ...structuredClone(DEFAULT_CONFIG),
    widgets: {
      'spotify-1': { widgetId: 'spotify', settings: {} },
      'clock-1': { widgetId: 'clock', settings: {} },
      'system-1': { widgetId: 'system', settings: {} },
      'ghost-1': { widgetId: 'not-installed', settings: {} },
    },
    screens: [
      {
        id: 'edge', name: 'Edge', kind: 'edge', nav: [],
        pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'spotify-1', x: 0, y: 0, w: 8, h: 4 }] }],
      },
      {
        id: 'tablet', name: 'Tablet', kind: 'device',
        nav: [{ instanceId: 'system-1', slot: 'left' }],
        pages: [
          { id: 'one', name: 'One', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 4, h: 2 }] },
          { id: 'two', name: 'Two', items: [{ instanceId: 'ghost-1', x: 0, y: 0, w: 4, h: 2 }] },
        ],
      },
    ],
  })
}

describe('screenChannels', () => {
  it('collects the channels of the widgets on the screen\'s pages and in its bar, and no other', () => {
    const channels = screenChannels(config(), 'tablet', manifests)
    // `calendar:*` with no connection bound on the screen grants no calendar at all.
    expect(channels.subscriptions.sort()).toEqual(['system'])
    // `clock` names `weather` in a preview but not in `commands`: a manifest the schema refuses
    // today, and one that must not widen a device's policy even if it got through.
    expect(channels.commands.sort()).toEqual(['system-cmd'])
    expect(channels.subscriptions).not.toContain('spotify')
    expect(channels.commands).not.toContain('spotify')
  })

  it('gives the other screen its own widgets', () => {
    expect(screenChannels(config(), 'edge', manifests)).toEqual({ subscriptions: ['spotify'], commands: ['spotify'] })
  })

  it('gives an unknown screen nothing', () => {
    expect(screenChannels(config(), 'nowhere', manifests)).toEqual({ subscriptions: [], commands: [] })
  })
})

describe('screenChannels and per-connection channels', () => {
  const cal: ChannelManifest = {
    subscriptions: ['calendar:*'], commands: [],
    settingsSchema: { source: { type: 'connection' }, extra: { type: 'connections' }, title: { type: 'string' } },
  }
  const gh: ChannelManifest = {
    subscriptions: ['github:*'], commands: ['github:*', 'github:gh-edge'],
    settingsSchema: { account: { type: 'connection' } },
  }
  const set = new Map([['cal', cal], ['gh', gh]])
  const channelOf = (c: { id: string; type: string }) => `${c.type === 'ics' ? 'calendar' : c.type}:${c.id}`
  const withConnections = (widgets: Record<string, unknown>, tablet: string[]): Config => ConfigSchema.parse({
    ...structuredClone(DEFAULT_CONFIG),
    connections: [
      { id: 'ics-a', type: 'ics', name: 'A', fields: {} },
      { id: 'ics-b', type: 'ics', name: 'B', fields: {} },
      { id: 'ics-c', type: 'ics', name: 'C', fields: {} },
      { id: 'gh-a', type: 'github', name: 'Mine', fields: {} },
      { id: 'gh-edge', type: 'github', name: 'Work', fields: {} },
    ],
    widgets,
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', nav: [], pages: [{ id: 'p', name: 'P', items: [] }] },
      { id: 'tablet', name: 'Tablet', kind: 'device', nav: [],
        pages: [{ id: 'p', name: 'P', items: tablet.map((instanceId, i) => ({ instanceId, x: i * 4, y: 0, w: 4, h: 2 })) }] },
    ],
  })

  it('turns a wildcard into the channels of the connections the screen names, and nothing broader', () => {
    const cfg = withConnections({
      'cal-1': { widgetId: 'cal', settings: { source: 'ics-a', extra: ['ics-b', 'gone', 7], title: 'ics-c' } },
    }, ['cal-1'])
    const channels = screenChannels(cfg, 'tablet', set, channelOf)
    expect(channels.subscriptions.sort()).toEqual(['calendar:ics-a', 'calendar:ics-b'])
    expect(channels.subscriptions.some((c) => c.endsWith('*'))).toBe(false)
  })

  it('keeps a literal connection channel only when an instance of the screen names it', () => {
    const own = withConnections({ 'gh-1': { widgetId: 'gh', settings: { account: 'gh-a' } } }, ['gh-1'])
    expect(screenChannels(own, 'tablet', set, channelOf)).toEqual({ subscriptions: ['github:gh-a'], commands: ['github:gh-a'] })
    const both = withConnections({ 'gh-1': { widgetId: 'gh', settings: { account: 'gh-edge' } } }, ['gh-1'])
    expect(screenChannels(both, 'tablet', set, channelOf).commands).toEqual(['github:gh-edge'])
  })

  it('follows a connection the manifest gives as a default, as the widget does', () => {
    const withDefault = new Map([['cal', { ...cal, settingsSchema: { source: { type: 'connection', default: 'ics-c' } } }]])
    const unset = withConnections({ 'cal-1': { widgetId: 'cal', settings: {} } }, ['cal-1'])
    expect(screenChannels(unset, 'tablet', withDefault, channelOf).subscriptions).toEqual(['calendar:ics-c'])
    // A saved value wins over the default.
    const saved = withConnections({ 'cal-1': { widgetId: 'cal', settings: { source: 'ics-a' } } }, ['cal-1'])
    expect(screenChannels(saved, 'tablet', withDefault, channelOf).subscriptions).toEqual(['calendar:ics-a'])
  })

  it('grants nothing for a connection used only on another screen', () => {
    const cfg = withConnections({
      'cal-1': { widgetId: 'cal', settings: { source: 'ics-a' } },
      'cal-edge': { widgetId: 'cal', settings: { source: 'ics-b' } },
    }, ['cal-1'])
    expect(screenChannels(cfg, 'tablet', set, channelOf).subscriptions).toEqual(['calendar:ics-a'])
  })
})

describe('channelAllowed', () => {
  it('matches a literal channel or a family wildcard, and nothing broader', () => {
    expect(channelAllowed(['system'], 'system')).toBe(true)
    expect(channelAllowed(['calendar:*'], 'calendar:ics-1')).toBe(true)
    expect(channelAllowed(['calendar:*'], 'calendar')).toBe(false)
    expect(channelAllowed(['calendar:*'], 'calendarx:1')).toBe(false)
    expect(channelAllowed(['system'], 'system:x')).toBe(false)
    expect(channelAllowed([], 'config')).toBe(false)
  })

  it('names config, the widget-reload channel, the theme in force and the screen reload as the only host channels', () => {
    expect(HOST_CHANNELS).toEqual(['config', WIDGET_DEV_CHANNEL, 'theme', SCREEN_RELOAD_CHANNEL])
  })
})
