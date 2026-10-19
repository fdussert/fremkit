import { z } from 'zod'
import { clamp, round1, wander } from './world.js'

/**
 * The LAN devices the declared connections of the Sietch's widgets talk to, as demo mode plays
 * them: a Homey Pro (devices, zones, flows) and an Elgato Key Light.
 *
 * Handed to the proxy as the `fetch` of `POST /api/proxy/:widgetId/conn`, and to the declared
 * types' Test button, so every check the proxy makes — grant, instance, connection, allow-list,
 * host — still runs and only the request itself ends here. Answered by path whatever the host the
 * connection names: nothing is ever dialled. A path nobody taught the demo about throws, which the
 * proxy reports as an unreachable upstream, exactly as before this file existed.
 *
 * The state lives as long as the server: a light switched off stays off, a flow can be run.
 */

const DeviceWrite = z.object({ value: z.union([z.boolean(), z.number().finite()]) })
const LightsWrite = z.object({
  lights: z.array(z.object({
    on: z.union([z.literal(0), z.literal(1)]).optional(),
    brightness: z.number().finite().optional(),
    temperature: z.number().finite().optional(),
  })).min(1).max(1),
}).loose()

type Cap = { value: boolean | number; units?: string }

const ZONES: Record<string, string> = { living: 'Living room', kitchen: 'Kitchen', office: 'Office', hall: 'Hallway' }

function initialDevices(): Record<string, { name: string; zone: string; caps: Record<string, Cap> }> {
  return {
    'demo-light-ceiling': { name: 'Ceiling light', zone: 'living', caps: { onoff: { value: true }, dim: { value: 0.7 } } },
    'demo-light-floor': { name: 'Floor lamp', zone: 'living', caps: { onoff: { value: false }, dim: { value: 0.4 } } },
    'demo-thermostat': { name: 'Thermostat', zone: 'living', caps: { target_temperature: { value: 21, units: '°C' }, measure_temperature: { value: 20.6, units: '°C' } } },
    'demo-plug-coffee': { name: 'Coffee machine', zone: 'kitchen', caps: { onoff: { value: false }, measure_power: { value: 0, units: 'W' } } },
    'demo-sensor-kitchen': { name: 'Kitchen sensor', zone: 'kitchen', caps: { measure_temperature: { value: 22.1, units: '°C' }, measure_humidity: { value: 48, units: '%' } } },
    'demo-light-desk': { name: 'Desk lamp', zone: 'office', caps: { onoff: { value: true }, dim: { value: 0.85 } } },
    'demo-plug-office': { name: 'Office plug', zone: 'office', caps: { onoff: { value: true }, measure_power: { value: 64, units: 'W' } } },
    'demo-door': { name: 'Front door', zone: 'hall', caps: { alarm_contact: { value: false }, measure_battery: { value: 82, units: '%' } } },
    'demo-motion': { name: 'Hall motion', zone: 'hall', caps: { alarm_motion: { value: false }, measure_luminance: { value: 140, units: 'lx' } } },
  }
}

const FLOWS = [
  { id: 'demo-flow-morning', name: 'Good morning', folderName: 'Routines', enabled: true },
  { id: 'demo-flow-leaving', name: 'Leaving home', folderName: 'Routines', enabled: true },
  { id: 'demo-flow-movie', name: 'Movie time', folderName: 'Scenes', enabled: true },
  { id: 'demo-flow-night', name: 'Good night', folderName: 'Routines', enabled: true },
  { id: 'demo-flow-coffee', name: 'Coffee on', folderName: 'Kitchen', enabled: true },
  { id: 'demo-flow-holiday', name: 'Holiday mode', folderName: 'Scenes', enabled: false },
]
const ADVANCED_FLOWS = [
  { id: 'demo-aflow-wakeup', name: 'Wake-up light', folderName: 'Routines', enabled: true },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  return Object.fromEntries(list.map((item) => [item.id, item]))
}

export function demoConnectionFetch(now: () => number = Date.now): typeof fetch {
  const devices = initialDevices()
  const light = { on: 1 as 0 | 1, brightness: 40, temperature: 213 }

  const homeyDevices = (): unknown => {
    const t = now()
    // The sensors drift; the hall sees somebody pass every few minutes.
    devices['demo-thermostat'].caps.measure_temperature.value = round1(wander(t, 20.6, 0.3, 30 * 60_000))
    devices['demo-sensor-kitchen'].caps.measure_temperature.value = round1(wander(t, 22.1, 0.4, 25 * 60_000, 0.3))
    devices['demo-sensor-kitchen'].caps.measure_humidity.value = Math.round(wander(t, 48, 3, 40 * 60_000))
    devices['demo-motion'].caps.alarm_motion.value = Math.floor(t / 20_000) % 9 === 0
    const office = devices['demo-plug-office'].caps
    office.measure_power.value = office.onoff.value ? Math.round(clamp(wander(t, 64, 12, 50_000), 5, 400)) : 0
    const coffee = devices['demo-plug-coffee'].caps
    coffee.measure_power.value = coffee.onoff.value ? 1_150 : 0
    return Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, {
      id, name: d.name, zone: d.zone, available: true,
      capabilitiesObj: Object.fromEntries(Object.entries(d.caps).map(([k, c]) => [k, { id: k, value: c.value, ...(c.units ? { units: c.units } : {}) }])),
    }]))
  }

  const writeDevice = (id: string, cap: string, body: unknown): Response => {
    const device = devices[id]
    const parsed = DeviceWrite.safeParse(body)
    if (!device || !(cap in device.caps)) return json({ error: 'not found' }, 404)
    if (!parsed.success) return json({ error: 'invalid value' }, 400)
    const current = device.caps[cap]
    if (typeof current.value === 'boolean' && typeof parsed.data.value !== 'boolean') return json({ error: 'invalid value' }, 400)
    current.value = typeof parsed.data.value === 'number'
      ? (cap === 'dim' ? clamp(parsed.data.value, 0, 1) : cap === 'target_temperature' ? clamp(parsed.data.value, 5, 30) : parsed.data.value)
      : parsed.data.value
    // Dimming a light that is off turns it on, as a Homey does.
    if (cap === 'dim' && 'onoff' in device.caps) device.caps.onoff.value = (current.value as number) > 0
    return json({})
  }

  return async (input, init) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = undefined }
    }

    if (method === 'GET' && path === '/api/manager/zones/zone') return json(Object.fromEntries(Object.entries(ZONES).map(([id, name]) => [id, { id, name }])))
    if (method === 'GET' && path === '/api/manager/devices/device') return json(homeyDevices())
    const cap = /^\/api\/manager\/devices\/device\/([^/]+)\/capability\/([^/]+)$/.exec(path)
    if (method === 'PUT' && cap) return writeDevice(decodeURIComponent(cap[1]), decodeURIComponent(cap[2]), body)
    if (method === 'GET' && path === '/api/manager/flow/flow') return json(byId(FLOWS))
    if (method === 'GET' && path === '/api/manager/flow/advancedflow') return json(byId(ADVANCED_FLOWS))
    const trigger = /^\/api\/manager\/flow\/(flow|advancedflow)\/([^/]+)\/trigger$/.exec(path)
    if (method === 'POST' && trigger) {
      const flow = (trigger[1] === 'flow' ? FLOWS : ADVANCED_FLOWS).find((f) => f.id === decodeURIComponent(trigger[2]))
      return flow && flow.enabled ? json({}) : json({ error: 'not found' }, 404)
    }

    if (method === 'GET' && path === '/elgato/accessory-info') return json({ productName: 'Elgato Key Light', displayName: 'Key Light', firmwareVersion: '1.0.3' })
    if (method === 'GET' && path === '/elgato/lights') return json({ numberOfLights: 1, lights: [{ ...light }] })
    if (method === 'PUT' && path === '/elgato/lights') {
      const parsed = LightsWrite.safeParse(body)
      if (!parsed.success) return json({ error: 'invalid' }, 400)
      const next = parsed.data.lights[0]
      if (next.on !== undefined) light.on = next.on
      if (next.brightness !== undefined) light.brightness = Math.round(clamp(next.brightness, 3, 100))
      if (next.temperature !== undefined) light.temperature = Math.round(clamp(next.temperature, 143, 344))
      return json({ numberOfLights: 1, lights: [{ ...light }] })
    }

    throw new Error('demo mode: no network')
  }
}
