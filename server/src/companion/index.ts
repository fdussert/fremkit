/**
 * The companion extension, put together: pairing, the extension's socket, the share it carries,
 * the dev tabs it reports, and the `companion` and `companion:dev` providers that show them to the
 * dashboard.
 */

import type { FastifyInstance } from 'fastify'
import type { ConfigStore } from '../config/store.js'
import type { DeviceStore } from '../devices/store.js'
import type { Pasteboard } from '../providers/clipboard.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { COMPANION_DEV_CHANNEL, CompanionDev, createDevProvider, fremdevEnabled } from './dev.js'
import { CompanionPairing } from './pairing.js'
import { PairingLock } from './lock.js'
import { companionOrigins, EXTENSION_IDS_ENV } from './protocol.js'
import { placeFremplay } from './placement.js'
import { COMPANION_CHANNEL, createCompanionProvider, type CompanionProvider } from './provider.js'
import { companionRoutes } from './routes.js'
import { companionShotRoute, osascriptImageClipboard, type ImageClipboard } from './shot.js'
import { afplayShotSound, type ShotSound } from './shotSound.js'
import { CompanionSession } from './session.js'
import { CompanionSockets, companionSocket } from './socket.js'

export interface CompanionOptions {
  app: FastifyInstance
  store: DeviceStore
  /** Where the pairing lock is kept (lock.ts); in memory only without one. */
  lockPath?: string
  /** `onChange` tells the session when `labs.companion` or `labs.fremdev` turns; without it, only new shares see it. */
  config: Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'onChange'>>
  registry: Pick<ProviderRegistry, 'register' | 'refresh'>
  /** Where Fremdev's report command copies a report: this Mac's pasteboard unless a test says. */
  pasteboard?: Pasteboard
  /** Where Fremdev's shot puts its image: this Mac's clipboard, through a file in `dataDir`, unless a test says. */
  imageClipboard?: ImageClipboard
  /** The data folder, where the shot's temporary file is written (0600, removed at once). */
  dataDir?: string
  /** The capture sound a `dev.shot` may ask for: macOS's, through afplay, unless a test or a demo says. */
  shotSound?: ShotSound
}

export interface Companion {
  provider: CompanionProvider
  pairing: CompanionPairing
  session: CompanionSession
  dev: CompanionDev
  sockets: CompanionSockets
  close(): void
}

/** Without a data folder there is nowhere to write the shot's file: every shot answers 500. */
const noClipboard: ImageClipboard = { writeJpeg: async () => { throw new Error('no data folder') } }

export async function createCompanion(opts: CompanionOptions): Promise<Companion> {
  const { app, store, config, registry } = opts
  let closed = false
  const refresh = (): void => {
    if (!closed) registry.refresh(COMPANION_CHANNEL)
  }
  const refreshDev = (): void => {
    if (!closed) registry.refresh(COMPANION_DEV_CHANNEL)
  }

  // Companion's id, plus a developer's own in FREMKIT_COMPANION_EXTENSION_IDS: no other extension.
  const { origins, ignored } = companionOrigins()
  if (ignored.length > 0) app.log.warn({ count: ignored.length }, `${EXTENSION_IDS_ENV}: entries that are not extension ids were ignored`)
  const lock = new PairingLock(opts.lockPath ?? null)
  await lock.load()
  const pairing = new CompanionPairing(store, undefined, lock)
  const sockets = new CompanionSockets()
  const pairedExtensions = (): number => store.list().filter((d) => d.kind === 'extension').length
  // `labs.companion` off is Fremplay and Fremdev off, and Fremdev has its own `labs.fremdev` on top (docs/companion.md). A product switch: what
  // keeps a share or a dev tab to this Mac is the socket's handshake and the channels' guards.
  const enabled = (): boolean => config.get().labs?.companion === true
  const fremdevOn = (): boolean => fremdevEnabled(config.get())
  const dev = new CompanionDev({
    send: (deviceId, msg) => sockets.send(deviceId, msg),
    changed: refreshDev,
    enabled: fremdevOn,
    pairedCount: pairedExtensions,
    sound: opts.shotSound ?? afplayShotSound(),
  })
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
    pairedCount: pairedExtensions,
    enabled,
    fremdevEnabled: fremdevOn,
    dev,
  })
  provider = createCompanionProvider({ session, pairing, config: () => config.get() })
  registry.register(provider)
  registry.register(createDevProvider({ dev, config: () => config.get(), pasteboard: opts.pasteboard }))

  let companionOn = config.get().labs?.companion === true
  let fremdevOnBefore = fremdevOn()
  const unsubscribeConfig = config.onChange?.((next) => {
    const on = next.labs?.companion === true
    const fremdev = fremdevEnabled(next)
    if (on === companionOn && fremdev === fremdevOnBefore) return
    companionOn = on
    fremdevOnBefore = fremdev
    session.switched()
  }) ?? (() => undefined)

  const unsubscribePairing = pairing.onChange(refresh)
  // An extension paired or removed in Appareils changes `extensions.paired`, connected or not, on
  // both channels.
  const unsubscribeStore = store.onChange(() => {
    refresh()
    refreshDev()
  })

  await app.register(companionRoutes, { pairing, config, origins, pairedExtensions })
  await app.register(companionSocket, { store, session, sockets, origins })
  const clipboard = opts.imageClipboard ?? (opts.dataDir !== undefined ? osascriptImageClipboard(opts.dataDir) : noClipboard)
  await app.register(companionShotRoute, { store, dev, origins, clipboard })

  const close = (): void => {
    if (closed) return
    closed = true
    unsubscribePairing()
    unsubscribeStore()
    unsubscribeConfig()
    pairing.dispose()
  }
  app.addHook('onClose', async () => { close() })

  return { provider, pairing, session, dev, sockets, close }
}
