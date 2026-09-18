import {
  SynologyClient,
  SynologyError,
  createSynologyProvider,
  parseHost,
  toSnapshot,
  type SynologyTransport,
} from '../../providers/synology.js'
import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'

export interface SynologyTestDeps { transport?: SynologyTransport }

/**
 * A Synology NAS, through a DSM account.
 *
 * Advise a dedicated account: DSM lets you create a user with no shared-folder rights at all,
 * and the two APIs this reads — system utilisation and storage information — need nothing more.
 * A password that also opens the file shares is a password on a dashboard, which is a strictly
 * worse trade than five minutes in Control Panel → User.
 *
 * `otp` is asked for once. DSM refuses a one-time code it has already seen, so a two-factor
 * account would need a fresh six digits at every restart; `enable_device_token=yes` makes the
 * first login hand back a `device_id` that stands in for the code from then on. The server
 * writes that token back into the connection's own secrets, which is why `deviceId` is a secret
 * field the form never asks a human to fill.
 *
 * `secretBindings: ['host']`: the password, the code and the device token are issued for *this*
 * NAS. Point the connection at another address and the API asks for them again rather than
 * sending them there — the same rule the GitHub token lives under.
 */
export const synologyType: ConnectionType = {
  id: 'synology',
  name: 'Synology',
  description: {
    fr: 'Volumes, disques et charge d’un NAS DSM',
    en: 'Volumes, disks and load of a DSM NAS',
  },
  icon: 'hard-drive',
  secretBindings: ['host'],
  fields: [
    {
      key: 'host',
      label: { fr: 'Adresse du NAS', en: 'NAS address' },
      required: true,
      placeholder: '192.0.2.10:5001',
      help: {
        fr: 'Nom ou adresse, avec le port DSM en HTTPS si ce n’est pas 5001. Fremkit ne parle au NAS qu’en HTTPS.',
        en: 'A name or an address, with the DSM HTTPS port if it is not 5001. Fremkit only ever talks HTTPS to the NAS.',
      },
    },
    {
      key: 'account',
      label: { fr: 'Compte DSM', en: 'DSM account' },
      required: true,
      placeholder: 'fremkit',
      help: {
        fr: 'Créez un compte dédié en lecture seule, sans accès aux dossiers partagés : les deux API lues n’en ont pas besoin.',
        en: 'Create a dedicated read-only account with no access to the shared folders: the two APIs read here do not need it.',
      },
    },
    {
      key: 'password',
      label: { fr: 'Mot de passe', en: 'Password' },
      secret: true,
      required: true,
    },
    {
      key: 'otp',
      label: { fr: 'Code de vérification', en: 'Verification code' },
      secret: true,
      help: {
        fr: 'Seulement si le compte utilise la double authentification, et seulement à la première connexion : le NAS renvoie ensuite un jeton d’appareil que Fremkit conserve à la place du code.',
        en: 'Only if the account uses two-factor authentication, and only for the first login: the NAS then hands back a device token, which Fremkit keeps instead of the code.',
      },
    },
    {
      key: 'deviceId',
      label: { fr: 'Jeton d’appareil', en: 'Device token' },
      secret: true,
      help: {
        fr: 'Écrit par Fremkit après une connexion à double authentification. Laissez vide.',
        en: 'Written by Fremkit after a two-factor login. Leave it empty.',
      },
    },
    {
      key: 'allowSelfSigned',
      label: { fr: 'Accepter un certificat auto-signé', en: 'Accept a self-signed certificate' },
      options: ['false', 'true'],
      help: {
        fr: 'Un NAS sur le réseau local présente presque toujours un certificat qu’aucune autorité ne signe. N’activez ceci que pour une adresse locale que vous connaissez.',
        en: 'A NAS on the local network almost always serves a certificate no authority signed. Turn this on only for a local address you know.',
      },
    },
  ],

  channelPrefix: 'synology',

  async test(fields, secrets, deps: SynologyTestDeps = {}): Promise<TestResult> {
    const parsed = parseHost(fields.host ?? '')
    if (!parsed) return { ok: false, error: tr(undefined, 'synology.invalidHost') }
    if (!(fields.account ?? '').trim()) return { ok: false, error: tr(undefined, 'synology.noAccount') }

    const client = new SynologyClient({
      host: parsed.host,
      port: parsed.port,
      account: fields.account.trim(),
      password: secrets.password ?? '',
      ...(secrets.otp ? { otp: secrets.otp } : {}),
      ...(secrets.deviceId ? { deviceId: secrets.deviceId } : {}),
      allowSelfSigned: fields.allowSelfSigned === 'true',
      ...(deps.transport ? { transport: deps.transport } : {}),
    })

    try {
      const snapshot = toSnapshot(await client.utilization(), await client.storage(), 0)
      return {
        ok: true,
        detail: tr(undefined, 'synology.connected', {
          volumes: String(snapshot.volumes.length),
          disks: String(snapshot.disks.length),
        }),
      }
    } catch (err) {
      if (err instanceof SynologyError && err.kind === 'auth') return { ok: false, error: tr(undefined, 'synology.unauthorized') }
      if (err instanceof SynologyError && err.kind === 'answer') return { ok: false, error: tr(undefined, 'synology.notADsm') }
      // Never the exception's own message: a TLS or DNS failure carries the address, and on a LAN
      // the address is the user's own.
      return { ok: false, error: tr(undefined, 'synology.unreachable') }
    } finally {
      // A test that left a session behind would open one on the NAS every time the button is
      // pressed, and DSM keeps them until they expire.
      await client.logout()
    }
  },

  createProvider: (ctx) => createSynologyProvider(ctx),
}
