/**
 * The companion extension, put together: pairing, the extension's socket, the share it carries,
 * and the `companion` provider that shows it all to the dashboard.
 */

import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../config/store.js'
import type { DeviceStore } from '../devices/store.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { CompanionPairing } from './pairing.js'
import { PairingLock } from './lock.js'
import { companionOrigins, EXTENSION_IDS_ENV } from './protocol.js'
import { placeFremplay } from './placement.js'
import { COMPANION_CHANNEL, createCompanionProvider, type CompanionProvider } from './provider.js'
import { companionRoutes } from './routes.js'
import { CompanionSession } from './session.js'
import { CompanionSockets, companionSocket } from './socket.js'

export interface CompanionOptions {
  app: FastifyInstance
  store: DeviceStore
  /** Where the pairing lock is kept (lock.ts); in memory only without one. */
  lockPath?: string
  config: Pick<ConfigStore, 'get'>
  registry: Pick<ProviderRegistry, 'register' | 'refresh'>
}

export interface Companion {
  provider: CompanionProvider
  pairing: CompanionPairing
  session: CompanionSession
  sockets: CompanionSockets
  close(): void
}

export async function createCompanion(opts: CompanionOptions): Promise<Companion> {
  const { app, store, config, registry } = opts
  let closed = false
  const refresh = (): void => {
    if (!closed) registry.refresh(COMPANION_CHANNEL)
  }

  // Companion's id, plus a developer's own in FREMKIT_COMPANION_EXTENSION_IDS: no other extension.
  const { origins, ignored } = companionOrigins()
  if (ignored.length > 0) app.log.warn({ count: ignored.length }, `${EXTENSION_IDS_ENV}: entries that are not extension ids were ignored`)
  const lock = new PairingLock(opts.lockPath ?? null)
  await lock.load()
  const pairing = new CompanionPairing(store, undefined, lock)
  const sockets = new CompanionSockets()
  // Assigned right below: the session only calls `changed` once something happens to it.
  let provider!: CompanionProvider
  const session = new CompanionSession({
    send: (deviceId, msg) => sockets.send(deviceId, msg),
    changed: () => {
      provider.noteChange()
      refresh()
    },
    // A share starts only when the Edge's screen has somewhere to show it.
    canShare: () => placeFremplay(config.get()) !== null,
    pairedCount: () => store.list().filter((d) => d.kind === 'extension').length,
  })
  provider = createCompanionProvider({ session, pairing, config: () => config.get() })
  registry.register(provider)

  const unsubscribePairing = pairing.onChange(refresh)
  // An extension paired or removed in Appareils changes `extensions.paired`, connected or not.
  const unsubscribeStore = store.onChange(refresh)

  const pairedExtensions = (): number => store.list().filter((d) => d.kind === 'extension').length
  await app.register(companionRoutes, { pairing, config, origins, pairedExtensions })
  await app.register(companionSocket, { store, session, sockets, origins })

  const close = (): void => {
    if (closed) return
    closed = true
    unsubscribePairing()
    unsubscribeStore()
    pairing.dispose()
  }
  app.addHook('onClose', async () => { close() })

  return { provider, pairing, session, sockets, close }
}
