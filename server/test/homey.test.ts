import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createHomeyProvider,
  isWritableCapability,
  homeyBaseUrl,
  isValidHomeyHost,
  keepsCapability,
  nameMap,
  normalizeDevices,
  normalizeFlows,
  type HomeySnapshot,
} from '../src/providers/homey.js'
import { homeyType } from '../src/connections/types/homey.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))

const DEVICES = fixture('homey-devices')
const ZONES = fixture('homey-zones')
const FLOWS = fixture('homey-flows')
const ADVANCED = fixture('homey-advancedflows')
const FOLDERS = fixture('homey-flowfolders')

const API_KEY = 'placeholder-api-key'
const ctx = { id: 'home', channel: 'homey:home', fields: { host: '192.0.2.10' }, secrets: { apiKey: API_KEY } }

/** A JSON response, the way `fetch` hands one back. */
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

/** Answers each path from a table; anything unlisted 404s, so a stray call is visible. */
function router(table: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: any) => {
    const path = new URL(String(input)).pathname
    const hit = table[path]
    return hit ? hit() : new Response('', { status: 404 })
  }) as unknown as typeof fetch
}

const HAPPY: Record<string, () => Response> = {
  '/api/manager/devices/device': () => json(DEVICES),
  '/api/manager/flow/flow': () => json(FLOWS),
  '/api/manager/flow/advancedflow': () => json(ADVANCED),
  '/api/manager/zones/zone': () => json(ZONES),
  '/api/manager/flow/flowfolder': () => json(FOLDERS),
}

describe('isValidHomeyHost / homeyBaseUrl', () => {
  it('accepts an IP and a .local name, refuses a URL or credentials', () => {
    expect(isValidHomeyHost('192.168.1.50')).toBe(true)
    expect(isValidHomeyHost('homey-abcd.local')).toBe(true)
    expect(isValidHomeyHost('[2001:db8::1]')).toBe(true)
    expect(isValidHomeyHost('http://192.168.1.50')).toBe(false)
    expect(isValidHomeyHost('192.168.1.50:80')).toBe(false)
    expect(isValidHomeyHost('user:pass@192.168.1.50')).toBe(false)
    expect(isValidHomeyHost('')).toBe(false)
  })
  it('builds a plain http base, as the Homey serves locally', () => {
    expect(homeyBaseUrl('192.168.1.50')).toBe('http://192.168.1.50')
  })
})

describe('keepsCapability', () => {
  it('keeps the controls, the readings and the alarms, drops the rest', () => {
    expect(['onoff', 'dim', 'target_temperature', 'measure_power', 'alarm_motion'].every(keepsCapability)).toBe(true)
    expect(keepsCapability('button')).toBe(false)
    expect(keepsCapability('windowcoverings_state')).toBe(false)
  })
})

describe('normalizeDevices', () => {
  const devices = normalizeDevices(DEVICES, nameMap(ZONES))

  it('drops an entry with no id and sorts by zone then name', () => {
    expect(devices.map((d) => d.id)).toEqual(['dev-legacy-1', 'dev-sensor-1', 'dev-lamp-1', 'dev-plug-1'])
  })

  it('names the zone from the zones map, and keeps an explicit zoneName', () => {
    const byId = Object.fromEntries(devices.map((d) => [d.id, d]))
    expect(byId['dev-lamp-1'].zoneName).toBe('Living room')
    expect(byId['dev-legacy-1'].zoneName).toBe('Attic')
  })

  it('maps a switchable light with its dim range and icon', () => {
    const lamp = devices.find((d) => d.id === 'dev-lamp-1')!
    expect(lamp).toMatchObject({ name: 'Ceiling light', class: 'light', available: true, iconUrl: '/api/manager/images/icon-bulb' })
    expect(lamp.capabilities).toEqual([
      { id: 'dim', value: 0.42, unit: '%', title: 'Dim level', settable: true, min: 0, max: 1, step: 0.01 },
      { id: 'onoff', value: true, title: 'Turned on', settable: true },
    ])
  })

  it('keeps sensor readings and drops a capability no tile can draw', () => {
    const sensor = devices.find((d) => d.id === 'dev-sensor-1')!
    expect(sensor.capabilities.map((c) => c.id)).toEqual(['alarm_motion', 'measure_battery', 'measure_humidity', 'measure_temperature'])
    expect(sensor.capabilities.find((c) => c.id === 'measure_temperature')).toMatchObject({ value: 21.4, unit: '°C', settable: false })
  })

  it('marks an unavailable device, and treats a missing flag as available', () => {
    expect(devices.find((d) => d.id === 'dev-plug-1')!.available).toBe(false)
    expect(devices.find((d) => d.id === 'dev-legacy-1')!.available).toBe(true)
  })

  it('accepts the singular spellings a differing firmware may use', () => {
    const legacy = devices.find((d) => d.id === 'dev-legacy-1')!
    expect(legacy.capabilities[0]).toMatchObject({ id: 'target_temperature', unit: '°C', settable: true, min: 5, max: 30 })
  })

  it('survives a shape it does not know', () => {
    expect(normalizeDevices(undefined)).toEqual([])
    expect(normalizeDevices([{ id: 'x', name: 'X' }])).toEqual([
      { id: 'x', name: 'X', zoneName: '', class: 'other', available: true, capabilities: [] },
    ])
  })
})

describe('normalizeFlows', () => {
  const folders = nameMap(FOLDERS)

  it('names the folder, defaults enabled, and drops an entry with no id', () => {
    expect(normalizeFlows(FLOWS, false, folders)).toEqual([
      { id: 'flow-morning', name: 'Morning routine', folder: 'Daily', enabled: true, advanced: false },
      { id: 'flow-away', name: 'Leaving home', folder: '', enabled: false, advanced: false },
      { id: 'flow-root', name: 'Panic', folder: '', enabled: true, advanced: false },
    ])
  })

  it('marks advanced flows so the widget triggers them on the other path', () => {
    expect(normalizeFlows(ADVANCED, true, folders).map((f) => [f.id, f.advanced])).toEqual([
      ['adv-movie', true], ['adv-holiday', true],
    ])
  })
})

describe('homey provider', () => {
  it('publishes devices and both kinds of flow, folder then name', async () => {
    const provider = createHomeyProvider(ctx, { fetchFn: router(HAPPY) })
    const snap = await provider.poll!() as HomeySnapshot
    expect(snap.error).toBeUndefined()
    expect(snap.devices).toHaveLength(4)
    // Root flows first, then the ones inside a folder; alphabetical within each.
    expect(snap.flows.map((f) => f.name)).toEqual([
      'Holiday mode', 'Leaving home', 'Panic', 'Morning routine', 'Movie night',
    ])
  })

  it('sends the key as a bearer token and never in the URL', async () => {
    const fetchFn = router(HAPPY)
    await createHomeyProvider(ctx, { fetchFn }).poll!()
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [url, init] of calls) {
      expect(String(url)).not.toContain(API_KEY)
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    }
  })

  it('still publishes when the optional labels and advanced flows are missing', async () => {
    const provider = createHomeyProvider(ctx, {
      fetchFn: router({
        '/api/manager/devices/device': () => json(DEVICES),
        '/api/manager/flow/flow': () => json(FLOWS),
      }),
    })
    const snap = await provider.poll!() as HomeySnapshot
    expect(snap.error).toBeUndefined()
    expect(snap.flows.every((f) => !f.advanced)).toBe(true)
    // No zones endpoint: only the device that carries its own zoneName keeps one.
    expect(snap.devices.filter((d) => d.zoneName).map((d) => d.id)).toEqual(['dev-legacy-1'])
  })

  it('keeps the last snapshot and says offline when the Homey stops answering', async () => {
    let up = true
    const provider = createHomeyProvider(ctx, {
      fetchFn: vi.fn(async (input: any) => {
        if (!up) throw new Error('EHOSTUNREACH')
        const path = new URL(String(input)).pathname
        return HAPPY[path] ? HAPPY[path]() : new Response('', { status: 404 })
      }) as unknown as typeof fetch,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = await provider.poll!() as HomeySnapshot
    expect(provider.intervalMs).toBe(10_000)
    up = false
    const second = await provider.poll!() as HomeySnapshot
    expect(second.error).toBe('offline')
    expect(second.devices).toEqual(first.devices)
    expect(second.flows).toEqual(first.flows)
    // A failure shortens the next wait, the way the calendar provider does it.
    expect(provider.intervalMs).toBe(5_000)
    expect(warn.mock.calls.flat().join(' ')).not.toContain(API_KEY)
    warn.mockRestore()
  })

  it('reports an unconfigured host rather than dialling one', async () => {
    const fetchFn = router(HAPPY)
    const provider = createHomeyProvider({ ...ctx, fields: { host: 'http://nope/' } }, { fetchFn })
    expect(await provider.poll!()).toEqual({ devices: [], flows: [], error: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('homey commands', () => {
  // A real Homey hands out UUIDs, and these go straight into a request path, so the provider
  // insists on the shape. The readable ids elsewhere in this file are snapshot data, not paths.
  const LAMP = 'c5a00914-6cfe-4c0e-b2df-47f11f1f2ab5'
  const FLOW = '4d4d607f-7d3d-406a-920a-4e7b2cb752e7'
  const ADVANCED = '422d61bc-bf23-4bf3-86bc-e89af7a1642d'

  /** Commands act on a device on the LAN, so they are loopback-gated like every other one. */
  const LOCAL = { loopback: true }
  const run = async (name: string, payload: unknown, fetchFn: typeof fetch) =>
    createHomeyProvider(ctx, { fetchFn }).commands![name](payload, LOCAL)

  it('setCapability PUTs the value on the device capability path', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
    await run('setCapability', { deviceId: LAMP, capability: 'onoff', value: true }, fetchFn)
    const [url, init] = (fetchFn as any).mock.calls[0]
    expect(url).toBe(`http://192.0.2.10/api/manager/devices/device/${LAMP}/capability/onoff`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ value: true })
  })

  it('setCapability carries a dim level as a number', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
    await run('setCapability', { deviceId: LAMP, capability: 'dim', value: 0.25 }, fetchFn)
    expect(JSON.parse((fetchFn as any).mock.calls[0][1].body)).toEqual({ value: 0.25 })
  })

  it('setCapability refuses a bad payload before touching the network', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    await expect(run('setCapability', { deviceId: '', capability: 'onoff', value: true }, fetchFn)).rejects.toThrow()
    await expect(run('setCapability', { deviceId: LAMP, capability: '../../system', value: true }, fetchFn)).rejects.toThrow()
    await expect(run('setCapability', { deviceId: LAMP, capability: 'onoff' }, fetchFn)).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('setCapability surfaces a refusal as a status, without the key', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch
    await expect(run('setCapability', { deviceId: LAMP, capability: 'onoff', value: true }, fetchFn))
      .rejects.toThrow('homey HTTP 403')
  })

  it('triggerFlow POSTs on the flow path, and on the advanced one when asked', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
    await run('triggerFlow', { flowId: FLOW }, fetchFn)
    await run('triggerFlow', { flowId: ADVANCED, advanced: true }, fetchFn)
    const calls = (fetchFn as any).mock.calls
    expect(calls[0][0]).toBe(`http://192.0.2.10/api/manager/flow/flow/${FLOW}/trigger`)
    expect(calls[0][1].method).toBe('POST')
    expect(calls[1][0]).toBe(`http://192.0.2.10/api/manager/flow/advancedflow/${ADVANCED}/trigger`)
  })

  it('triggerFlow refuses a bad payload', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    await expect(run('triggerFlow', {}, fetchFn)).rejects.toThrow()
    await expect(run('triggerFlow', { flowId: 'f', advanced: 'yes' }, fetchFn)).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('homey connection test', () => {
  const test = (fetchFn: typeof fetch, host = '192.0.2.10') =>
    homeyType.test({ host }, { apiKey: API_KEY }, { fetchFn })

  it('reports the Homey name and version when the system scope is granted', async () => {
    const fetchFn = router({ '/api/manager/system': () => json({ hostname: 'Homey Pro', homeyVersion: '12.3.0' }) })
    await expect(test(fetchFn)).resolves.toEqual({ ok: true, detail: expect.stringContaining('Homey Pro') })
  })

  it('falls back to counting devices when the key has no system scope', async () => {
    const fetchFn = router({
      '/api/manager/system': () => new Response('', { status: 403 }),
      '/api/manager/devices/device': () => json(DEVICES),
    })
    const result = await test(fetchFn)
    expect(result).toEqual({ ok: true, detail: expect.stringContaining('5') })
  })

  it('refuses a key both endpoints reject', async () => {
    const fetchFn = router({
      '/api/manager/system': () => new Response('', { status: 401 }),
      '/api/manager/devices/device': () => new Response('', { status: 401 }),
    })
    await expect(test(fetchFn)).resolves.toEqual({ ok: false, error: expect.stringMatching(/API key refused|clé API refusée/) })
  })

  it('reports an unreachable Homey without quoting the key', async () => {
    const fetchFn = vi.fn(async () => { throw new Error(`connect EHOSTUNREACH ${API_KEY}`) }) as unknown as typeof fetch
    const result = await test(fetchFn)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('reports an unexpected status', async () => {
    const fetchFn = router({ '/api/manager/system': () => new Response('', { status: 500 }) })
    await expect(test(fetchFn)).resolves.toEqual({ ok: false, error: expect.stringContaining('500') })
  })

  it('refuses an address that is not a host, before any request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const result = await test(fetchFn, 'http://192.0.2.10/api')
    expect(result.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('homey connection options', () => {
  const options = (source: string, fetchFn: typeof fetch, host = '192.0.2.10') =>
    homeyType.options!(source, { host }, { apiKey: API_KEY }, { fetchFn })

  it('lists every device, zone as the group and class as the hint', async () => {
    const list = await options('devices', router(HAPPY))
    expect(list.map((o) => o.value)).toEqual(['dev-legacy-1', 'dev-sensor-1', 'dev-lamp-1', 'dev-plug-1'])
    expect(list.find((o) => o.value === 'dev-lamp-1')).toEqual({
      value: 'dev-lamp-1', label: 'Ceiling light', group: 'Living room', hint: 'light',
    })
  })

  it('lists plain and advanced flows, folder as the group and the advanced prefix on the value', async () => {
    const list = await options('flows', router(HAPPY))
    expect(list.map((o) => o.value)).toContain('advanced:adv-movie')
    expect(list.map((o) => o.value)).toContain('flow-morning')
    expect(list.find((o) => o.value === 'flow-morning')?.group).toBe('Daily')
  })

  it('still lists the flows of a firmware that serves no advanced flows or folders', async () => {
    const list = await options('flows', router({ '/api/manager/flow/flow': () => json(FLOWS) }))
    expect(list.map((o) => o.value)).toEqual(['flow-away', 'flow-morning', 'flow-root'])
    expect(list.every((o) => o.group === undefined)).toBe(true)
  })

  it('refuses a source it does not know, with a 400', async () => {
    await expect(options('zones', router(HAPPY))).rejects.toMatchObject({ status: 400 })
  })

  it('reports a refused key as a 502 without quoting the key', async () => {
    const fetchFn = router({ '/api/manager/devices/device': () => new Response('', { status: 401 }) })
    await expect(options('devices', fetchFn)).rejects.toMatchObject({ status: 502 })
    await options('devices', fetchFn).catch((err: Error) => expect(err.message).not.toContain(API_KEY))
  })

  it('reports an unreachable Homey without quoting the key', async () => {
    const fetchFn = vi.fn(async () => { throw new Error(`connect EHOSTUNREACH ${API_KEY}`) }) as unknown as typeof fetch
    await options('devices', fetchFn).catch((err: Error) => {
      expect(err.message).not.toContain(API_KEY)
      expect((err as { status?: number }).status).toBe(502)
    })
  })

  it('refuses an address that is not a host, before any request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    await expect(options('devices', fetchFn, 'http://192.0.2.10/api')).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('homey command bounds', () => {
  const LAMP = 'c5a00914-6cfe-4c0e-b2df-47f11f1f2ab5'
  /** Commands act on a device on the LAN, so they are loopback-gated like every other one. */
  const LOCAL = { loopback: true }
  const run = async (name: string, payload: unknown, fetchFn: typeof fetch) =>
    createHomeyProvider(ctx, { fetchFn }).commands![name](payload, LOCAL)

  it('refuses an id that is not a UUID, so nothing can walk the API path', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    // encodeURIComponent escapes a slash but not a dot: `..` used to survive as a path segment
    // and `/device/../capability/onoff` resolves to a different endpoint on the Homey.
    for (const deviceId of ['..', '../..', 'dev-lamp-1', 'not-a-uuid', `${LAMP}/..`, '']) {
      await expect(run('setCapability', { deviceId, capability: 'onoff', value: true }, fetchFn), deviceId).rejects.toThrow()
    }
    for (const flowId of ['..', 'flow-morning', 'x']) {
      await expect(run('triggerFlow', { flowId }, fetchFn), flowId).rejects.toThrow()
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a capability the device did not mark settable', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
    // measure_temperature is a reading, not a control.
    await expect(run('setCapability', { deviceId: LAMP, capability: 'measure_temperature', value: 21 }, fetchFn))
      .rejects.toThrow(/modifiable|written/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('allows the three the widgets drive before the first snapshot lands', async () => {
    for (const capability of ['onoff', 'dim', 'target_temperature']) {
      const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
      await run('setCapability', { deviceId: LAMP, capability, value: 1 }, fetchFn)
      expect(fetchFn, capability).toHaveBeenCalledTimes(1)
    }
  })

  it('lets the snapshot decide once it knows the device', () => {
    const snapshot = {
      devices: [{ id: LAMP, name: 'Lamp', capabilities: [
        { id: 'onoff', settable: true },
        { id: 'measure_power', settable: false },
        { id: 'volume_set', settable: true },
      ] }],
      flows: [],
    } as unknown as Parameters<typeof isWritableCapability>[0]
    expect(isWritableCapability(snapshot, LAMP, 'onoff')).toBe(true)
    // Settable by the device's own account, even though it is not on the short list.
    expect(isWritableCapability(snapshot, LAMP, 'volume_set')).toBe(true)
    expect(isWritableCapability(snapshot, LAMP, 'measure_power')).toBe(false)
    // A capability the device does not have at all.
    expect(isWritableCapability(snapshot, LAMP, 'onoff.2')).toBe(false)
    // An unknown device falls back to the short list.
    expect(isWritableCapability(snapshot, '00000000-0000-4000-8000-000000000000', 'onoff')).toBe(true)
    expect(isWritableCapability(snapshot, '00000000-0000-4000-8000-000000000000', 'volume_set')).toBe(false)
  })

  it('accepts no command at all when the address is not one it can dial', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const bad = createHomeyProvider({ ...ctx, fields: { host: 'http://nope/' } }, { fetchFn })
    await expect(bad.commands!.setCapability({ deviceId: LAMP, capability: 'onoff', value: true }, LOCAL)).rejects.toThrow()
    await expect(bad.commands!.triggerFlow({ flowId: LAMP }, LOCAL)).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('never echoes the payload back in a refusal', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    await expect(run('setCapability', { deviceId: 'secret-looking-value', capability: 'onoff', value: true }, fetchFn))
      .rejects.toThrow(/^(?:(?!secret-looking-value).)*$/)
  })
})

describe('homey commands are local-only', () => {
  const LAMP = 'c5a00914-6cfe-4c0e-b2df-47f11f1f2ab5'

  it('refuses a command that did not come from this machine', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const p = createHomeyProvider(ctx, { fetchFn })
    // They write to a device on the user's LAN, which a remote caller cannot see and has no
    // business driving. Fail closed on a missing context.
    for (const context of [{ loopback: false }, undefined]) {
      await expect(p.commands!.setCapability({ deviceId: LAMP, capability: 'onoff', value: true }, context))
        .rejects.toThrow()
      await expect(p.commands!.triggerFlow({ flowId: LAMP }, context)).rejects.toThrow()
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
