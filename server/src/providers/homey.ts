import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'

/**
 * Homey Pro (2023) over its **local** Web API.
 *
 * Everything here is plain http on the LAN: the Homey answers on `http://<ip>/api/...` with an
 * `Authorization: Bearer <apiKey>` header, the key being one created in the Homey app under
 * Settings → General → API Keys. Nothing goes through Athom's cloud.
 *
 * Endpoint provenance, so the next reader knows what is solid and what is not:
 *  - `GET  /api/manager/system`                                  — documented (ManagerSystem.getInfo).
 *  - `GET  /api/manager/devices/device`                          — documented and widely used.
 *  - `PUT  /api/manager/devices/device/:id/capability/:capability` with `{ value }` — documented in
 *    community references; NOT confirmed against an official page, and untested here because no
 *    Homey was reachable from the machine this was written on.
 *  - `GET  /api/manager/flow/flow`, `POST /api/manager/flow/flow/:id/trigger`,
 *    `GET  /api/manager/flow/advancedflow`, `POST /api/manager/flow/advancedflow/:id/trigger`
 *    — from the generated `node-homey-api` reference (ManagerFlow).
 *  - `GET  /api/manager/zones/zone` and `GET /api/manager/flow/flowfolder` — used only to put a
 *    human name on a device's zone and a flow's folder. Both are best-effort: a failure or a 404
 *    leaves the label empty instead of failing the poll, because neither is confirmed for every
 *    firmware and neither is worth an offline dashboard.
 */

/** One request may take this long. Short on purpose: the Homey is on the same LAN. */
export const HOMEY_TIMEOUT_MS = 5_000
/** Device values move while someone watches them, so the snapshot is refreshed often. */
const POLL_EVERY_MS = 10_000
/** After a failed poll the next try comes sooner, the way the calendar provider does it. */
export const RETRY_AFTER_FAILURE_MS = 5_000

/**
 * A hostname or an IPv4 literal: letters, digits, dots and dashes, nothing else. An IPv6 literal
 * is accepted bracketed, the way a URL writes it. Same rule as the Bambu type — the value becomes
 * the host of a URL, so a whole URL, a port, a path or a `user:pass@` is refused here rather than
 * quietly reinterpreted further down.
 */
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/

/** True for a host the provider can dial. Exported for the type's own tests. */
export function isValidHomeyHost(host: string): boolean {
  return host.length <= 253 && HOST_RE.test(host)
}

/** `http://<host>`, with no trailing slash. The caller has already validated the host. */
export function homeyBaseUrl(host: string): string {
  return `http://${host}`
}

export type HomeyValue = boolean | number | string | null

export interface HomeyCapability {
  id: string
  value: HomeyValue
  /** `°C`, `W`, `%`… as the Homey reports it, or absent for a capability that has no unit. */
  unit?: string
  title?: string
  /** False for a read-only capability: the widget draws a value rather than a control. */
  settable?: boolean
  min?: number
  max?: number
  step?: number
}

export interface HomeyDevice {
  id: string
  name: string
  zoneName: string
  class: string
  available: boolean
  /** Path of the device's icon on the Homey, when it exposes one. Informational. */
  iconUrl?: string
  capabilities: HomeyCapability[]
}

export interface HomeyFlow {
  id: string
  name: string
  folder: string
  enabled: boolean
  /** True for an Advanced Flow, which triggers through a different path. */
  advanced: boolean
}

/**
 * What the `homey:<id>` channel publishes.
 *
 * No timestamp, like the other connection snapshots: a fresh `updatedAt` every ten seconds would
 * defeat the registry's dedup and wake every subscriber for a house that did not change.
 */
export interface HomeySnapshot { devices: HomeyDevice[]; flows: HomeyFlow[]; error?: string }

/**
 * Which capabilities reach the widget.
 *
 * The full set of a busy Homey is long and most of it is meaningless in a tile, so the snapshot
 * carries the ones a device tile can actually draw: the two controls, the target temperature, and
 * every `measure_*` / `alarm_*` reading.
 */
const KEEP_CAPABILITIES = new Set(['onoff', 'dim', 'target_temperature'])
export function keepsCapability(id: string): boolean {
  return KEEP_CAPABILITIES.has(id) || id.startsWith('measure_') || id.startsWith('alarm_')
}

/** A Homey collection comes back as an object keyed by id; older shapes used an array. */
function collection(json: unknown): Record<string, any>[] {
  if (Array.isArray(json)) return json.filter((e) => e && typeof e === 'object') as Record<string, any>[]
  if (json && typeof json === 'object') {
    return Object.values(json as Record<string, unknown>).filter((e) => e && typeof e === 'object') as Record<string, any>[]
  }
  return []
}

/** `{ id: { name } }` → `Map<id, name>`, for zones and for flow folders alike. */
export function nameMap(json: unknown): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of collection(json)) {
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id && typeof entry.name === 'string') out.set(id, entry.name)
  }
  return out
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function normalizeCapability(id: string, raw: unknown): HomeyCapability {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const value: HomeyValue =
    typeof o.value === 'boolean' || typeof o.value === 'number' || typeof o.value === 'string' ? o.value : null
  const cap: HomeyCapability = { id, value }
  // The Homey writes the unit as `units`; `unit` is accepted too, in case a firmware differs.
  const unit = o.units ?? o.unit
  if (typeof unit === 'string' && unit) cap.unit = unit
  if (typeof o.title === 'string' && o.title) cap.title = o.title
  // Likewise `setable` is the Homey's spelling.
  const settable = o.setable ?? o.settable
  if (typeof settable === 'boolean') cap.settable = settable
  const min = num(o.min), max = num(o.max), step = num(o.step)
  if (min !== undefined) cap.min = min
  if (max !== undefined) cap.max = max
  if (step !== undefined) cap.step = step
  return cap
}

/**
 * `GET /api/manager/devices/device` → the devices a tile can draw.
 *
 * `zones` puts a name on `device.zone`; a device that already carries `zoneName` (older
 * firmware writes it) keeps its own.
 */
export function normalizeDevices(json: unknown, zones: Map<string, string> = new Map()): HomeyDevice[] {
  const out: HomeyDevice[] = []
  for (const raw of collection(json)) {
    const id = typeof raw.id === 'string' ? raw.id : undefined
    if (!id) continue
    const zoneName = typeof raw.zoneName === 'string' && raw.zoneName
      ? raw.zoneName
      : (typeof raw.zone === 'string' ? zones.get(raw.zone) ?? '' : '')
    const capabilitiesObj = (raw.capabilitiesObj && typeof raw.capabilitiesObj === 'object' ? raw.capabilitiesObj : {}) as Record<string, unknown>
    const capabilities = Object.keys(capabilitiesObj)
      .filter(keepsCapability)
      .sort()
      .map((key) => normalizeCapability(key, capabilitiesObj[key]))
    const device: HomeyDevice = {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      zoneName,
      class: typeof raw.class === 'string' ? raw.class : 'other',
      // Absent means available: only an explicit `false` marks a device as unreachable.
      available: raw.available !== false,
      capabilities,
    }
    const icon = raw.iconObj?.url ?? raw.iconObj?.id ?? raw.icon
    if (typeof icon === 'string' && icon) device.iconUrl = icon
    out.push(device)
  }
  out.sort((a, b) => a.zoneName.localeCompare(b.zoneName) || a.name.localeCompare(b.name))
  return out
}

/**
 * `GET /api/manager/flow/flow` and `GET /api/manager/flow/advancedflow` → one flat list.
 *
 * `folders` puts a name on `flow.folder`; a flow at the root keeps an empty folder.
 */
export function normalizeFlows(json: unknown, advanced: boolean, folders: Map<string, string> = new Map()): HomeyFlow[] {
  const out: HomeyFlow[] = []
  for (const raw of collection(json)) {
    const id = typeof raw.id === 'string' ? raw.id : undefined
    if (!id) continue
    const folder = typeof raw.folder === 'string' ? folders.get(raw.folder) ?? '' : ''
    out.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      folder,
      // Absent means enabled, the way the Homey app shows a flow with no explicit switch.
      enabled: raw.enabled !== false,
      advanced,
    })
  }
  return out
}

/**
 * How a flow is named in a widget's `flows` setting, and in the options the picker offers.
 *
 * A plain flow and an Advanced Flow are two collections behind two different trigger paths, and
 * nothing promises their ids never meet, so the advanced side carries a prefix. The widget spells
 * the same key, which is how a tapped button knows which path to trigger.
 */
export const flowKey = (flow: { id: string; advanced?: boolean }): string =>
  (flow.advanced === true ? `advanced:${flow.id}` : flow.id)

/** A capability id as the Homey writes them: `onoff`, `measure_temperature`, `alarm_motion`. */
const CapabilityId = z.string().min(1).max(64).regex(/^[a-z0-9_.]+$/)

export const SetCapabilityPayload = z.object({
  deviceId: z.string().min(1).max(128),
  capability: CapabilityId,
  value: z.union([z.boolean(), z.number(), z.string().max(256)]),
})

export const TriggerFlowPayload = z.object({
  flowId: z.string().min(1).max(128),
  advanced: z.boolean().default(false),
})

export interface HomeyProviderDeps { fetchFn?: typeof fetch }

/**
 * One provider per configured Homey connection, on the channel `homey:<id>`.
 *
 * A failed poll keeps the last snapshot and marks it `offline`, rather than emptying the tile
 * because the Wi-Fi blinked; the next try comes in five seconds instead of ten.
 */
export function createHomeyProvider(ctx: ConnectionProviderContext, deps: HomeyProviderDeps = {}): Provider {
  const fetchFn = deps.fetchFn ?? fetch
  const base = homeyBaseUrl(ctx.fields.host ?? '')
  // Built once. The key is never logged, never put in a URL and never quoted in an error.
  const headers = {
    Authorization: `Bearer ${ctx.secrets.apiKey ?? ''}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }

  let last: HomeySnapshot = { devices: [], flows: [] }
  let failed = false

  async function get(path: string): Promise<unknown> {
    const res = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(HOMEY_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => { /* already closed */ })
      throw new Error(`HTTP ${res.status}`)
    }
    return res.json()
  }

  /** A call whose failure must not cost the whole poll: a missing label is not an outage. */
  async function optional(path: string): Promise<unknown> {
    try { return await get(path) } catch { return undefined }
  }

  async function send(path: string, method: 'PUT' | 'POST', body: unknown): Promise<void> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOMEY_TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => { /* already closed */ })
    // The Homey's own error text can quote the request, so only the status comes out.
    if (!res.ok) throw new Error(`homey HTTP ${res.status}`)
  }

  return {
    channel: ctx.channel,
    // The registry reads this before every wait, so a failure shortens the next one.
    get intervalMs() { return failed ? RETRY_AFTER_FAILURE_MS : POLL_EVERY_MS },

    async poll(): Promise<HomeySnapshot> {
      if (!isValidHomeyHost(ctx.fields.host ?? '')) return { devices: [], flows: [], error: 'unconfigured' }
      try {
        const [devicesJson, flowsJson] = await Promise.all([
          get('/api/manager/devices/device'),
          get('/api/manager/flow/flow'),
        ])
        // Advanced Flows only exist on recent firmware, and the labels are decoration: none of
        // these three may turn a working Homey into an offline dashboard.
        const [advancedJson, zonesJson, foldersJson] = await Promise.all([
          optional('/api/manager/flow/advancedflow'),
          optional('/api/manager/zones/zone'),
          optional('/api/manager/flow/flowfolder'),
        ])
        const folders = nameMap(foldersJson)
        last = {
          devices: normalizeDevices(devicesJson, nameMap(zonesJson)),
          flows: [
            ...normalizeFlows(flowsJson, false, folders),
            ...normalizeFlows(advancedJson, true, folders),
          ].sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name)),
        }
        failed = false
        return last
      } catch (err) {
        failed = true
        // The message is a status or a network code; it never carries the key or the URL.
        console.warn(`[homey:${ctx.id}] poll failed (${(err as Error).message}); retrying in ${RETRY_AFTER_FAILURE_MS / 1000} s`)
        return { ...last, error: 'offline' }
      }
    },

    commands: {
      /** Sets one capability of one device: the toggle and the dimmer of the devices widget. */
      setCapability: async (payload) => {
        const { deviceId, capability, value } = SetCapabilityPayload.parse(payload)
        await send(
          `/api/manager/devices/device/${encodeURIComponent(deviceId)}/capability/${encodeURIComponent(capability)}`,
          'PUT',
          { value },
        )
        return { ok: true }
      },

      /** Runs a flow, or an Advanced Flow, which lives under its own path. */
      triggerFlow: async (payload) => {
        const { flowId, advanced } = TriggerFlowPayload.parse(payload)
        const kind = advanced ? 'advancedflow' : 'flow'
        await send(`/api/manager/flow/${kind}/${encodeURIComponent(flowId)}/trigger`, 'POST', {})
        return { ok: true }
      },
    },
  }
}
