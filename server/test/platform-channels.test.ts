import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { channelAvailable, widgetAvailable, CHANNEL_PLATFORMS } from '../src/platform/channels.js'
import type { Provider } from '../src/providers/types.js'

const WIDGETS = resolve(import.meta.dirname, '..', '..', 'widgets')
let dir: string
let app: FastifyInstance | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** Builds an app and returns the channels that reached the registry. */
async function registered(platform: NodeJS.Platform, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-platform-'))
  const channels: string[] = []
  const real = ProviderRegistry.prototype.register
  vi.spyOn(ProviderRegistry.prototype, 'register').mockImplementation(function (this: ProviderRegistry, p: Provider) {
    channels.push(p.channel)
    return real.call(this, p)
  })
  const fakes: Provider[] = ['spotify', 'mutedeck', 'cleanshot', 'github:x', 'volume'].map((channel) => ({ channel }))
  app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: WIDGETS, devicesPort: 0, providers: fakes, platform, ...extra })
  return channels
}

describe('the channel platform table', () => {
  it('judges a channel by its family', () => {
    expect(channelAvailable('spotify', 'win32')).toBe(false)
    expect(channelAvailable('spotify', 'darwin')).toBe(true)
    expect(channelAvailable('github:abc', 'win32')).toBe(true)
    expect(channelAvailable('dock', 'win32')).toBe(false)
    expect(channelAvailable('toString', 'win32')).toBe(true)
    expect(Object.keys(CHANNEL_PLATFORMS).sort()).toEqual(['cleanshot', 'dock', 'disk-map', 'mutedeck', 'shortcuts', 'spotify', 'brightness'].sort())
  })

  it('makes a widget unavailable when any channel it reads is', () => {
    expect(widgetAvailable({ subscriptions: ['dock'], commands: ['shortcuts'] }, 'win32')).toBe(false)
    expect(widgetAvailable({ subscriptions: ['companion', 'volume'], commands: [] }, 'win32')).toBe(true)
    expect(widgetAvailable({ subscriptions: [], commands: ['spotify'] }, 'win32')).toBe(false)
    expect(widgetAvailable({ subscriptions: ['dock'], commands: ['shortcuts'] }, 'darwin')).toBe(true)
  })
})

describe('buildApp on a platform', () => {
  it('registers no provider the platform lacks, and lists the widgets that need one', async () => {
    const channels = await registered('win32')
    for (const gone of ['spotify', 'mutedeck', 'cleanshot', 'dock', 'shortcuts', 'disk-map', 'brightness']) expect(channels, gone).not.toContain(gone)
    expect(channels).toContain('github:x')
    expect(channels).toContain('volume')
    const body = (await app!.inject({ url: '/api/widgets' })).json()
    expect(body.platform).toBe('win32')
    expect(body.unavailable).toEqual(expect.arrayContaining(['brightness', 'notifications', 'shortcuts', 'spotify', 'disk-map']))
    expect(body.unavailable).toEqual([...body.unavailable].sort())
    expect(body.unavailable).not.toContain('fremplay')
    expect(body.unavailable).not.toContain('volume')
  })

  it('keeps every provider and lists nothing on darwin', async () => {
    const channels = await registered('darwin')
    for (const here of ['spotify', 'mutedeck', 'cleanshot', 'dock', 'shortcuts', 'disk-map', 'brightness', 'github:x']) expect(channels, here).toContain(here)
    const body = (await app!.inject({ url: '/api/widgets' })).json()
    expect(body.platform).toBe('darwin')
    expect(body.unavailable).toEqual([])
  })

  it('treats any other platform as darwin', async () => {
    await registered('linux')
    expect((await app!.inject({ url: '/api/widgets' })).json().platform).toBe('darwin')
  })

  it('lists no installed application where there is no Dock', async () => {
    await registered('win32')
    const res = (await app!.inject({ url: '/api/apps/installed' })).json()
    expect(JSON.stringify(res)).not.toMatch(/Safari|\.app/)
    expect(res.apps ?? res).toEqual(expect.any(Array))
    expect(res.apps ?? res).toHaveLength(0)
  })

  it('does not register the demo fakes of a channel the platform lacks', async () => {
    const channels = await registered('win32', { demo: true })
    for (const gone of ['spotify', 'mutedeck', 'cleanshot', 'dock', 'shortcuts', 'disk-map', 'brightness']) expect(channels, gone).not.toContain(gone)
    expect(channels).toContain('volume')
  })
})
