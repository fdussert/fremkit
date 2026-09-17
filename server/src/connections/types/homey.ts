import {
  createHomeyProvider,
  flowKey,
  homeyBaseUrl,
  HOMEY_TIMEOUT_MS,
  isValidHomeyHost,
  nameMap,
  normalizeDevices,
  normalizeFlows,
} from '../../providers/homey.js'
import { USER_AGENT } from '../../version.js'
import { tr } from '../../i18n.js'
import { OptionsError, type ConnectionType, type PickOption, type TestResult } from '../types.js'

export interface HomeyTestDeps { fetchFn?: typeof fetch }

/**
 * A Homey Pro (2023) on the LAN, through its local Web API.
 *
 * The API key is created in the Homey app and sent as a bearer token; the whole exchange is plain
 * http inside the LAN, which is what the Homey serves locally. The key is never logged and never
 * quoted in an error — not even the network error's own message, which can carry the URL.
 */
export const homeyType: ConnectionType = {
  id: 'homey',
  name: 'Homey Pro',
  description: { fr: 'Homey Pro (2023) sur le réseau local', en: 'Homey Pro (2023) on the local network' },
  icon: 'network',
  // The stored secret only ever travels to this destination; changing it means re-entering
  // the secret (see ConnectionType.secretBindings).
  secretBindings: ['host'],
  fields: [
    {
      key: 'host',
      label: { fr: 'Adresse', en: 'Address' },
      required: true,
      placeholder: '192.168.1.50',
      help: {
        fr: 'IP ou nom d’hôte du Homey (app Homey → Réglages → Général → Wi-Fi).',
        en: 'IP or host name of the Homey (Homey app → Settings → General → Wi-Fi).',
      },
    },
    {
      key: 'apiKey',
      label: { fr: 'Clé API', en: 'API key' },
      secret: true,
      required: true,
      help: {
        fr: 'App Homey → Réglages → Général → Clés API. Cochez au moins Appareils et Flows, en lecture et en contrôle.',
        en: 'Homey app → Settings → General → API Keys. Tick at least Devices and Flows, read and control.',
      },
    },
  ],

  async test(fields, secrets, deps: HomeyTestDeps = {}): Promise<TestResult> {
    const fetchFn = deps.fetchFn ?? fetch
    const host = fields.host ?? ''
    if (!isValidHomeyHost(host)) return { ok: false, error: tr(undefined, 'homey.invalidAddress') }

    const base = homeyBaseUrl(host)
    const headers = {
      Authorization: `Bearer ${secrets.apiKey ?? ''}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    }
    const call = async (path: string): Promise<Response | 'unreachable'> => {
      try {
        return await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(HOMEY_TIMEOUT_MS) })
      } catch {
        // Deliberately not the error message: it quotes the URL, and a log is not the place for it.
        return 'unreachable'
      }
    }

    // `/api/manager/system` needs the system scope, which a key created for devices and flows
    // alone does not carry. So a refusal there is not yet a verdict: the devices endpoint — the
    // one the provider actually depends on — decides.
    const system = await call('/api/manager/system')
    if (system === 'unreachable') return { ok: false, error: tr(undefined, 'homey.unreachable') }
    if (system.ok) {
      const info = (await system.json().catch(() => ({}))) as Record<string, unknown>
      const name = typeof info.hostname === 'string' ? info.hostname : 'Homey'
      const version = typeof info.homeyVersion === 'string' ? info.homeyVersion : '?'
      return { ok: true, detail: tr(undefined, 'homey.connected', { name, version }) }
    }
    await system.body?.cancel().catch(() => { /* already closed */ })
    if (system.status !== 401 && system.status !== 403) {
      return { ok: false, error: tr(undefined, 'homey.unexpected', { status: system.status }) }
    }

    const devices = await call('/api/manager/devices/device')
    if (devices === 'unreachable') return { ok: false, error: tr(undefined, 'homey.unreachable') }
    if (devices.ok) {
      const json = (await devices.json().catch(() => ({}))) as unknown
      const count = Array.isArray(json) ? json.length : json && typeof json === 'object' ? Object.keys(json).length : 0
      return { ok: true, detail: tr(undefined, 'homey.connectedDevices', { devices: count }) }
    }
    await devices.body?.cancel().catch(() => { /* already closed */ })
    if (devices.status === 401 || devices.status === 403) return { ok: false, error: tr(undefined, 'homey.unauthorized') }
    return { ok: false, error: tr(undefined, 'homey.unexpected', { status: devices.status }) }
  },

  /**
   * What a `pick` setting offers: every device, or every flow — the picker lists the house, and
   * the widget keeps ids, so a device renamed in the Homey app stays on the dashboard.
   *
   * The labels (zone, folder) are best-effort the same way the provider's poll treats them: a
   * firmware that does not serve them leaves the group empty rather than failing the whole list.
   */
  async options(source, fields, secrets, deps: HomeyTestDeps = {}): Promise<PickOption[]> {
    const fetchFn = deps.fetchFn ?? fetch
    const host = fields.host ?? ''
    if (!isValidHomeyHost(host)) throw new OptionsError(502, tr(undefined, 'homey.invalidAddress'))

    const base = homeyBaseUrl(host)
    const headers = {
      Authorization: `Bearer ${secrets.apiKey ?? ''}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    }

    /** A call that must succeed: its failure is the whole list's failure, as a 502. */
    const get = async (path: string): Promise<unknown> => {
      let res: Response
      try {
        res = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(HOMEY_TIMEOUT_MS) })
      } catch {
        // Never the error message: it quotes the URL.
        throw new OptionsError(502, tr(undefined, 'homey.unreachable'))
      }
      if (res.ok) return res.json().catch(() => undefined)
      await res.body?.cancel().catch(() => { /* already closed */ })
      if (res.status === 401 || res.status === 403) throw new OptionsError(502, tr(undefined, 'homey.unauthorized'))
      throw new OptionsError(502, tr(undefined, 'homey.unexpected', { status: res.status }))
    }
    /** A call whose failure only costs a label, exactly as the provider's poll treats it. */
    const optional = async (path: string): Promise<unknown> => {
      try { return await get(path) } catch { return undefined }
    }

    if (source === 'devices') {
      const [devicesJson, zonesJson] = await Promise.all([
        get('/api/manager/devices/device'),
        optional('/api/manager/zones/zone'),
      ])
      return normalizeDevices(devicesJson, nameMap(zonesJson))
        .map((d) => ({ value: d.id, label: d.name, group: d.zoneName || undefined, hint: d.class || undefined }))
    }

    if (source === 'flows') {
      const [flowsJson, advancedJson, foldersJson] = await Promise.all([
        get('/api/manager/flow/flow'),
        // Advanced Flows only exist on recent firmware: their absence is not an outage.
        optional('/api/manager/flow/advancedflow'),
        optional('/api/manager/flow/flowfolder'),
      ])
      const folders = nameMap(foldersJson)
      return [
        ...normalizeFlows(flowsJson, false, folders),
        ...normalizeFlows(advancedJson, true, folders),
      ]
        .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
        .map((f) => ({ value: flowKey(f), label: f.name, group: f.folder || undefined }))
    }

    throw new OptionsError(400, tr(undefined, 'connections.unknownSource', { source }))
  },

  createProvider: (ctx) => createHomeyProvider(ctx),
}
