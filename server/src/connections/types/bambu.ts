import { createBambuProvider, mapState, type BambuSnapshot } from '../../providers/bambu.js'
import { BAMBU_PORT, bambuClientId, connectMqtt, type MqttConnect } from '../../providers/mqtt.js'
import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'

export interface BambuTestDeps { connect?: MqttConnect }

/** How long the test waits for the printer to answer the pushall. */
const TEST_TIMEOUT_MS = 10_000

export const BAMBU_MODELS = ['H2C', 'H2D', 'H2S', 'X1C', 'X1E', 'P1S', 'P1P', 'A1', 'A1 mini', 'autre']

/**
 * A hostname or an IPv4 literal: letters, digits, dots and dashes, nothing else. An IPv6 literal
 * is accepted bracketed, the way a URL writes it.
 *
 * The value ends up as the host of an MQTT connection, so a `user:pass@host`, a port, a path or a
 * whole URL is rejected here rather than being quietly reinterpreted further down.
 */
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/

/** True for a host the provider can dial. Exported for the type's own tests. */
export function isValidBambuHost(host: string): boolean {
  return host.length <= 253 && HOST_RE.test(host)
}

/**
 * A Bambu Lab printer in LAN mode.
 *
 * LAN mode has to be switched on from the printer's screen; it then exposes an MQTT broker whose
 * password is the access code shown next to the switch. Nothing goes through Bambu's cloud.
 */
export const bambuType: ConnectionType = {
  id: 'bambu',
  name: 'Bambu Lab',
  description: { fr: 'Imprimante Bambu Lab en mode LAN', en: 'Bambu Lab printer in LAN mode' },
  icon: 'hard-drive',
  // The stored secret only ever travels to this destination; changing it means re-entering
  // the secret (see ConnectionType.secretBindings).
  secretBindings: ['host', 'serial'],
  fields: [
    {
      key: 'host',
      label: { fr: 'Adresse IP', en: 'IP address' },
      required: true,
      placeholder: '192.168.1.42',
      help: { fr: 'Écran de l’imprimante → Réglages → Réseau.', en: 'Printer screen → Settings → Network.' },
    },
    {
      key: 'serial',
      label: { fr: 'Numéro de série', en: 'Serial number' },
      required: true,
      help: { fr: 'Écran de l’imprimante → Réglages → À propos.', en: 'Printer screen → Settings → About.' },
    },
    {
      key: 'accessCode',
      label: { fr: 'Code d’accès', en: 'Access code' },
      secret: true,
      required: true,
      help: {
        fr: 'Le code affiché à côté de l’interrupteur « Mode LAN ».',
        en: 'The code shown next to the “LAN mode” switch.',
      },
    },
    {
      key: 'model',
      label: { fr: 'Modèle', en: 'Model' },
      options: BAMBU_MODELS,
      help: { fr: 'Informatif : sert seulement à l’affichage.', en: 'Informational: for display only.' },
    },
  ],

  test(fields, secrets, deps: BambuTestDeps = {}): Promise<TestResult> {
    const connect = deps.connect ?? connectMqtt
    const host = fields.host ?? ''
    const serial = fields.serial ?? ''
    const reportTopic = `device/${serial}/report`

    if (!isValidBambuHost(host)) {
      return Promise.resolve({ ok: false, error: tr(undefined, 'bambu.invalidAddress') })
    }

    return new Promise<TestResult>((resolve) => {
      let settled = false
      const client = connect({
        host,
        port: BAMBU_PORT,
        username: 'bblp',
        password: secrets.accessCode ?? '',
        clientId: bambuClientId(),
      })
      const finish = (result: TestResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.end()
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, error: tr(undefined, 'bambu.noAnswer') }), TEST_TIMEOUT_MS)

      client.onConnect(() => {
        client.subscribe(reportTopic)
        client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }))
      })
      client.onMessage((message) => {
        if (message.topic !== reportTopic) return
        let body: unknown
        try { body = JSON.parse(message.payload) } catch { return }
        const report = (body as { print?: unknown })?.print
        if (!report || typeof report !== 'object') return
        const state: BambuSnapshot['state'] = mapState((report as { gcode_state?: unknown }).gcode_state)
        finish({ ok: true, detail: tr(undefined, 'bambu.reachable', { state }) })
      })
      // The broker's own error text can quote the credentials it refused, so it never comes out.
      client.onClose(() => finish({ ok: false, error: tr(undefined, 'bambu.refused') }))
    })
  },

  createProvider: (ctx) => createBambuProvider(ctx),
}
