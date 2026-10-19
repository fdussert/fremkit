/**
 * Device pairing, put together: the remote switch and its TLS listener, the pairing code, the
 * paired devices and the screen each one shows, and what the hub lets each of them hear.
 *
 * The parts are built and tested on their own (`store.ts`, `codes.ts`, `certificate.ts`,
 * `listener.ts`, `gate.ts`, `channels.ts`); this is the one place that knows how they meet.
 */

import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/schema.js'
import { parseScreenReload, SCREEN_RELOAD_CHANNEL } from '../config/screen-reload.js'
import type { ConfigStore } from '../config/store.js'
import { grantedCatalog } from '../marketplace/consent.js'
import { execFileAsync, type Exec } from '../secrets/keychain.js'
import type { SecretStore } from '../secrets/types.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { Hub } from '../ws/hub.js'
import { codeProof } from './codeProof.js'
import { fingerprintWords } from './fingerprint.js'
import { advertise as bonjourAdvertise, type Advertisement, type Advertiser } from './bonjour.js'
import { ensureKey, issueCertificate, readKey, resetKey, spkiHash } from './certificate.js'
import { channelAllowed, screenChannels, type ChannelConnection, type ChannelManifest, type ScreenChannels } from './channels.js'
import { deviceConfigView } from './scope.js'
import type { PairingCodes } from './codes.js'
import { lanAddresses as readLanAddresses, cachedPick, computerName, isPrivate, lanAppAddresses, localHostName, preferredAddress } from './host.js'
import { REMOTE_PORT, RemoteListener } from './listener.js'
import { deviceThemeView } from '../themes/schedule.js'
import type { DeviceStore, PublicDevice, PublicExtensionDevice, PublicIpadDevice, Viewport } from './store.js'

/** How often the LAN addresses are re-read while listening, to follow a DHCP change. */
const ADDRESS_CHECK_MS = 30_000

/** What the admin lists: an extension row also says whether its socket is open right now. */
export type StatusDevice = PublicIpadDevice | (PublicExtensionDevice & { connected: boolean })

/** A browser extension asking to pair, as the admin shows it: never a token. */
export type CompanionRequest = { requestId: string; code: string; name: string; extension: string; expiresAt: number }

export type DeviceStatus = {
  enabled: boolean
  listening: boolean
  error: 'portInUse' | null
  guessing: boolean
  /** `<LocalHostName>.local`, or null when the Mac has none. */
  host: string | null
  addresses: string[]
  port: number
  /** Base64url SHA-256 of the key's SPKI: what a device pins. Never the key itself. */
  keyHash: string | null
  /** Four words from the key's hash, for a person to compare with the device's screen. */
  fingerprint: string[] | null
  devices: StatusDevice[]
  /** The extension waiting for the user's answer, or null. */
  companionRequest: CompanionRequest | null
  /** Extension pairing locked after too many wrong codes, until unlocked here. */
  companionLocked: boolean
}

export type PairingOffer = { code: string; expiresAt: number; url: string }

/** What the page of a device needs to apply its screen's brightness; null when the screen has none. */
export type DeviceBrightness = { target: number | null; seq: number }

export type DeviceInfo = { id: string; name: string; screenId: string | null; brightness: DeviceBrightness | null }

/** How many addresses `meForApp` lists at most. */
export const MAX_APP_ADDRESSES = 8

/** What `GET /api/devices/me` answers the device app: `DeviceInfo` and where else it may find the Mac. */
export type DeviceAppInfo = DeviceInfo & { addresses: string[] }

export type PairCredential = { proof: string } | { secret: string }

export type PairResult =
  | { token: string; device: PublicDevice }
  | { error: 'wrong' | 'expired' | 'limited' }

export interface DeviceServiceOptions {
  /**
   * The channel a connection publishes on (`ConnectionManager.channelFor`), so a device's policy
   * names its screen's connections and no others. Defaults to `<type>:<id>`.
   */
  channelOf?: (connection: ChannelConnection) => string
  /** The brightness decided for a screen, injected so this module does not import brightness. */
  brightnessOf?: (screenId: string) => DeviceBrightness | null
  app: FastifyInstance
  store: DeviceStore
  codes: PairingCodes
  secrets: SecretStore
  config: ConfigStore
  hub: Hub
  catalog: WidgetCatalog
  listenerPort?: number
  /**
   * How often, and how far apart, a bind that finds the port taken is tried again before the port
   * is reported in use: a server that has just been replaced may hold it for a moment longer.
   */
  bindRetry?: { attempts: number; delayMs: number }
  /** Runs `scutil` and `openssl`; tests swap the first for a fixed name. */
  exec?: Exec
  /** Bonjour; tests pass `noAdvertise` so `dns-sd` never runs there. */
  advertise?: Advertiser
  lanAddresses?: () => string[]
  /** Which of the addresses the QR code carries; the default asks the Mac's default route. */
  preferredAddress?: (addresses: string[]) => Promise<string | null>
  /**
   * The companion's waiting pairing request and its connected extensions, as closures: the
   * companion is built after this service and this one must not know its code.
   */
  companionRequest?: () => CompanionRequest | null
  companionLocked?: () => boolean
  companionConnected?: () => ReadonlySet<string>
  /** Which of the addresses the device app is told, in order; the default is `lanAppAddresses`. */
  appAddresses?: (addresses: string[]) => Promise<string[]>
}

/**
 * The `brightness` snapshot as a device hears it: its own screen's entry and no other screen's id,
 * level or mode, the Edge's (`kiosk`) included. Shaped like the snapshot, so the brightness widget,
 * which reads `screens[Fremkit.screen]`, works unchanged.
 */
export function deviceBrightnessView(data: unknown, screenId: string | null): unknown {
  if (screenId === null || !data || typeof data !== 'object') return null
  const screens = (data as { screens?: Record<string, unknown> }).screens ?? {}
  return { kiosk: null, screens: Object.hasOwn(screens, screenId) ? { [screenId]: screens[screenId] } : {} }
}

/**
 * What a paired socket on `screenId` hears on a host channel (`HOST_CHANNELS`, plus `brightness`):
 * its own view, or null for nothing at all. A channel with no case here is never sent to a device.
 */
export function deviceHostView(channel: string, data: unknown, screenId: string | null): unknown {
  if (channel === 'config') return deviceConfigView(data as Config, screenId)
  if (channel === 'brightness') return deviceBrightnessView(data, screenId)
  if (channel === 'theme') return deviceThemeView(data)
  if (channel === SCREEN_RELOAD_CHANNEL) return deviceScreenReloadView(data, screenId)
  return null
}

/** A reload reaches a device only when it names the device's own screen; any other is not its business. */
export function deviceScreenReloadView(data: unknown, screenId: string | null): unknown {
  const reload = parseScreenReload(data)
  return screenId !== null && reload?.screenId === screenId ? reload : null
}

/** Whether a device screen was made for this viewport, in either orientation. */
function fits(screen: Config['screens'][number], viewport: Viewport): boolean {
  const v = screen.display.viewport
  if (!v) return false
  return (v.width === viewport.width && v.height === viewport.height)
    || (v.width === viewport.height && v.height === viewport.width)
}

function isDeviceScreen(config: Config, screenId: string): boolean {
  return config.screens.some((s) => s.id === screenId && s.kind === 'device')
}

/** A port the server this one replaces may still hold: tried every second for ten seconds. */
export const BIND_RETRY = { attempts: 10, delayMs: 1_000 }

export class DeviceService {
  private readonly app: FastifyInstance
  private readonly store: DeviceStore
  private readonly codes: PairingCodes
  private readonly secrets: SecretStore
  private readonly config: ConfigStore
  private readonly hub: Hub
  private readonly catalog: WidgetCatalog
  private readonly exec: Exec
  private readonly advertiser: Advertiser
  private readonly readAddresses: () => string[]
  private readonly pickAddress: (addresses: string[]) => Promise<string | null>
  /** `appAddresses` for `meForApp`, kept 30 s per address list: each iPad asks every 30 s or so. */
  private readonly listAppAddresses: (addresses: string[]) => Promise<string[]>
  private readonly listener: RemoteListener
  private readonly bindRetry: { attempts: number; delayMs: number }
  private closing = false
  /** The background bind retry running now (`retryBind`), if any. */
  private retrying: object | null = null
  private readonly companionRequest: () => CompanionRequest | null
  private readonly companionLocked: () => boolean
  private readonly companionConnected: () => ReadonlySet<string>

  /**
   * Every start, stop, certificate swap and address check goes through this one chain, so they
   * never overlap: a stop asked for during a start waits for the start and then stops.
   */
  private chain: Promise<unknown> = Promise.resolve()
  private error: 'portInUse' | null = null
  private hostName: string | null = null
  /** The addresses the current certificate was issued for. */
  private certAddresses: string[] = []
  private hosts = new Set<string>()
  private keyHash: string | null = null
  private keyHashKnown = false
  private bonjour: Advertisement | null = null
  /** The name and TXT address `bonjour` was started with, to restart it when the address moves. */
  private bonjourName = 'Fremkit'
  private bonjourAddress: string | null = null
  private timer: NodeJS.Timeout | null = null
  /** The granted catalogue, as the policy reads it; dropped when the config or catalogue moves. */
  private manifests: Map<string, ChannelManifest> | null = null
  private readonly brightnessOf: (screenId: string) => DeviceBrightness | null
  private readonly channelOf: ((connection: ChannelConnection) => string) | undefined

  constructor(opts: DeviceServiceOptions) {
    this.app = opts.app
    this.store = opts.store
    this.codes = opts.codes
    this.secrets = opts.secrets
    this.config = opts.config
    this.hub = opts.hub
    this.brightnessOf = opts.brightnessOf ?? (() => null)
    this.channelOf = opts.channelOf
    this.catalog = opts.catalog
    this.exec = opts.exec ?? execFileAsync
    this.advertiser = opts.advertise ?? bonjourAdvertise
    this.readAddresses = opts.lanAddresses ?? readLanAddresses
    this.pickAddress = opts.preferredAddress ?? ((addresses) => preferredAddress(addresses, this.exec))
    this.companionRequest = opts.companionRequest ?? (() => null)
    this.companionLocked = opts.companionLocked ?? (() => false)
    this.companionConnected = opts.companionConnected ?? (() => new Set())
    this.listAppAddresses = cachedPick(opts.appAddresses ?? ((addresses) => lanAppAddresses(addresses, this.exec)))
    this.listener = new RemoteListener(opts.app, opts.listenerPort ?? REMOTE_PORT)
    this.bindRetry = opts.bindRetry ?? BIND_RETRY
  }

  /** Wires the hub and the change listeners, then starts the listener if the switch was left on. */
  async init(): Promise<void> {
    this.hub.setPolicy((deviceId) => this.policyFor(deviceId))
    this.hub.setDevicePayload((deviceId) => this.me(deviceId))
    // The config a device hears is its own screen's (devices/scope.ts), never the Mac's whole one.
    // So is the brightness it hears: its own screen's entry, not every screen's id and level.
    this.hub.setHostView((deviceId, channel, data) => deviceHostView(channel, data, this.deviceScreenOf(deviceId)), ['brightness'])
    this.config.onChange((cfg) => this.onConfigChange(cfg))
    this.catalog.onScan(() => {
      this.manifests = null
      this.refreshAll()
    })
    if (!this.store.enabled) return
    // A port still held by the server this one replaces is tried again in the background
    // (`bindRetry`): the dashboard does not wait for it.
    try {
      await this.serialize(() => this.start({ boot: true }))
    } catch (err) {
      // A failed start must not keep the dashboard from booting; the switch stays on, so the
      // next start tries again, and the admin shows it is not listening.
      this.app.log.warn({ err: (err as Error).message }, 'could not start the remote listener')
    }
  }

  get listening(): boolean {
    return this.listener.running
  }

  setEnabled(on: boolean): Promise<{ enabled: boolean; error?: 'portInUse' }> {
    return this.serialize(() => (on ? this.start() : this.stop()))
  }

  /** Stops everything for good: the app is closing. */
  close(): Promise<void> {
    // A bind waiting to try again gives up now rather than hold the close for its retries.
    this.closing = true
    this.retrying = null
    return this.serialize(async () => { await this.halt() })
  }

  status(): DeviceStatus {
    const connected = this.companionConnected()
    const request = this.companionRequest()
    return {
      enabled: this.store.enabled,
      listening: this.listener.running,
      error: this.error,
      guessing: this.codes.guessing(),
      host: this.hostName === null ? null : `${this.hostName}.local`,
      addresses: this.readAddresses(),
      port: this.listener.port,
      keyHash: this.keyHash,
      fingerprint: this.keyHash === null ? null : fingerprintWords(this.keyHash),
      devices: this.store.list().map((d): StatusDevice => (d.kind === 'extension' ? { ...d, connected: connected.has(d.id) } : d)),
      // Picked field by field, so nothing the pairing object grows later reaches the admin.
      companionRequest: request ? { requestId: request.requestId, code: request.code, name: request.name, extension: request.extension, expiresAt: request.expiresAt } : null,
      companionLocked: this.companionLocked(),
    }
  }

  /**
   * Reads the key's hash for `status()` without creating a key. Separate and lazy so that building
   * the app never touches the keychain: only the admin asking for the status does.
   */
  async loadKeyHash(): Promise<void> {
    if (this.keyHashKnown) return
    const pem = await readKey(this.secrets)
    this.keyHash = pem ? spkiHash(pem) : null
    this.keyHashKnown = true
  }

  /**
   * A fresh code and the QR payload carrying it and its secret (`s=`), or `notListening`. The
   * secret is in the link and nowhere else: not a field of its own, not in the status, not in a log.
   *
   * On the chain with the switch and the certificate reset, so that a code asked for while either
   * runs is issued before it (and dropped by it) or after it (and refused while off): never a code
   * left live by a switch-off, nor one carrying the pin a reset has just replaced.
   */
  pairingCode(): Promise<PairingOffer | 'notListening'> {
    return this.serialize(() => this.issueCode())
  }

  private async issueCode(): Promise<PairingOffer | 'notListening'> {
    if (!this.listener.running) return 'notListening'
    const key = await ensureKey(this.secrets, { exec: this.exec })
    const keyHash = spkiHash(key)
    this.keyHash = keyHash
    this.keyHashKnown = true
    const { code, secret, expiresAt } = this.codes.issue((c) => codeProof(c, keyHash))
    const params: string[] = []
    if (this.hostName !== null) params.push(`h=${encodeURIComponent(`${this.hostName}.local`)}`)
    const address = await this.pickAddress(this.readAddresses())
    if (address !== null) params.push(`a=${encodeURIComponent(address)}`)
    params.push(`p=${this.listener.port}`, `c=${code}`, `s=${secret}`, `k=${this.keyHash}`)
    return { code, expiresAt, url: `fremkit://pair?${params.join('&')}` }
  }

  /**
   * Pairs a device with the live code, typed and sent as a proof bound to this Mac's key
   * (`codeProof`), or with its secret, read off the QR code. It is
   * attached to the one device screen made for its viewport; none, or more than one, leaves it
   * unattached for the user to choose.
   */
  async pair(credential: PairCredential, name: string, viewport: Viewport, peer = ''): Promise<PairResult> {
    const result = 'secret' in credential
      ? this.codes.consumeSecret(credential.secret, peer)
      : this.codes.consume(credential.proof, peer)
    if (result !== 'ok') return { error: result }
    const matches = this.config.get().screens.filter((s) => s.kind === 'device' && fits(s, viewport))
    const screenId = matches.length === 1 ? matches[0].id : null
    const { device, token } = await this.store.create(name, viewport, screenId)
    return { token, device }
  }

  /** Whether a pairing code is live: outside of one, there is nothing to pair with. */
  get pairingOpen(): boolean {
    return this.codes.hasLive()
  }

  /** Puts a device on a device screen, or on none. Refuses any other screen. */
  async attach(id: string, screenId: string | null): Promise<PublicDevice | null | 'screenNotDevice'> {
    if (screenId !== null && !isDeviceScreen(this.config.get(), screenId)) return 'screenNotDevice'
    // Only an iPad shows a screen: an extension record is not attachable.
    if (!this.me(id)) return null
    const device = await this.store.update(id, { screenId })
    if (device) this.hub.refreshDevice(id)
    return device
  }

  async rename(id: string, name: string): Promise<PublicDevice | null> {
    const device = await this.store.update(id, { name })
    if (device) this.hub.refreshDevice(id)
    return device
  }

  async revoke(id: string): Promise<boolean> {
    const removed = await this.store.remove(id)
    // Closed whatever the store said: a socket of a device already gone has no business open.
    this.hub.closeDevice(id)
    return removed
  }

  /** Every paired iPad; a browser extension is left, removed from its own row instead. */
  async revokeAll(): Promise<void> {
    for (const id of await this.store.removeIpads()) this.hub.closeDevice(id)
  }

  /**
   * A new key, so a new pin, and every iPad has to pair again: their records and tokens go, and
   * so do their sockets. A browser extension pins nothing and stays paired. A live code carried the old pin in its QR, so it goes too; a running
   * listener is switched to a certificate from the new key.
   */
  resetCertificate(): Promise<void> {
    return this.serialize(async () => {
      const key = await resetKey(this.secrets, { exec: this.exec })
      this.keyHash = spkiHash(key)
      this.keyHashKnown = true
      this.codes.clear()
      // `revokeAll`'s body, inline: it is not serialized itself, and this already is.
      for (const id of await this.store.removeIpads()) this.hub.closeDevice(id)
      this.hub.closeRemote()
      if (this.listener.running) {
        const cert = await issueCertificate(key, { host: this.dnsName(), addresses: this.certAddresses }, { exec: this.exec })
        this.listener.setCertificate(key, cert)
        // A keep-alive connection would otherwise go on over the old key, which nothing pins now.
        this.listener.dropConnections()
      }
    })
  }

  me(deviceId: string): DeviceInfo | null {
    const device = this.store.list().find((d) => d.id === deviceId)
    // An extension is no device screen: it has no `me`, as before main's brightness.
    if (device?.kind !== 'ipad') return null
    const brightness = device.screenId === null ? null : this.brightnessOf(device.screenId)
    return { id: device.id, name: device.name, screenId: device.screenId, brightness }
  }

  /**
   * `me()` with the Mac's LAN addresses, for the device app, which asks for them
   * (`GET /api/devices/me?addresses=1`) so it can follow the Mac when the one it uses goes away
   * (Ethernet unplugged) and Bonjour does not answer. The dashboard page's own request and the
   * `device` channel do not ask, and get `me()`. Only the RFC 1918 ones among those the remote
   * listener accepts as Host right now (the certificate's addresses, which `updateHosts` lets
   * through): never a public, CGNAT, link-local or IPv6 address, nor one the listener would answer
   * 421. Of those, only the ones on Wi-Fi or Ethernet (`appAddresses`): never a VPN's or a virtual
   * machine's, which the iPad cannot reach and should not hear about. The default route's comes
   * first, then the others in order, `MAX_APP_ADDRESSES` at most: each dead one costs the app a
   * probe. The list is kept 30 s per address list (`cachedPick`), so an iPad's periodic check does
   * not run `route` each time.
   */
  async meForApp(deviceId: string): Promise<DeviceAppInfo | null> {
    const me = this.me(deviceId)
    if (me === null) return null
    const usable = this.certAddresses.filter(isPrivate)
    const listed = usable.length > 0 ? await this.listAppAddresses(usable) : []
    return { ...me, addresses: listed.filter((a) => usable.includes(a)).slice(0, MAX_APP_ADDRESSES) }
  }

  /** The screen a device is bound to, only while it is a device screen: where its brightness goes. */
  deviceScreenOf(deviceId: string): string | null {
    const device = this.store.list().find((d) => d.id === deviceId)
    const screenId = device?.kind === 'ipad' ? device.screenId : null
    return screenId !== null && isDeviceScreen(this.config.get(), screenId) ? screenId : null
  }

  /** Whether the widgets of a device's screen may subscribe to `channel`: what its page may ask the host for. */
  maySubscribe(deviceId: string, channel: string): boolean {
    return channelAllowed(this.policyFor(deviceId)?.subscriptions ?? [], channel)
  }

  /** Re-sends the `device` payload to every device bound to one of these screens. */
  screensChanged(screenIds: string[]): void {
    for (const d of this.store.list()) {
      if (d.kind === 'ipad' && d.screenId !== null && screenIds.includes(d.screenId)) this.hub.refreshDevice(d.id)
    }
  }

  // --- internals -------------------------------------------------------------------------------

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private dnsName(): string | null {
    return this.hostName === null ? null : `${this.hostName}.local`
  }

  /**
   * Starts the listener. A port found taken is tried again in the background, `bindRetry`
   * apart, outside the chain: this answers at once, with the switch as it was (the admin shows
   * that until the listener binds or the retries give up), and a stop or a close asked meanwhile
   * is not held behind the retries.
   *
   * `boot`: the switch was left on and the server is starting. A port still taken after every
   * retry then leaves the switch on, so the next start tries again; from the admin's switch, it
   * goes back off.
   */
  private async start(opts: { boot?: boolean } = {}): Promise<{ enabled: boolean; error?: 'portInUse' }> {
    if (this.listener.running) {
      await this.store.setEnabled(true)
      return { enabled: true }
    }
    // A retry already running for an earlier start gives way to this one.
    this.retrying = null
    // Nothing pairs with a code from before the switch went off; `stop()` drops it already, this is
    // in case anything ever issued one while off.
    this.codes.clear()
    const key = await ensureKey(this.secrets, { exec: this.exec })
    this.keyHash = spkiHash(key)
    this.keyHashKnown = true
    this.hostName = await localHostName(this.exec)
    this.certAddresses = this.readAddresses()
    const cert = await issueCertificate(key, { host: this.dnsName(), addresses: this.certAddresses }, { exec: this.exec })
    if (await this.tryBind(key, cert)) {
      await this.bound()
      return { enabled: true }
    }
    if (this.bindRetry.attempts <= 0 || this.closing) return this.gaveUp(opts.boot === true)
    this.app.log.info({ port: this.listener.port }, 'remote listener port taken; trying again')
    this.error = null
    this.retryBind(key, cert, opts.boot === true)
    return { enabled: this.store.enabled }
  }

  /** One bind: true once listening, false when the port is taken; any other error is thrown. */
  private async tryBind(key: string, cert: string): Promise<boolean> {
    try {
      await this.listener.start(key, cert)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      return false
    }
  }

  /** The listener is bound: let its names through, advertise it, follow the addresses. */
  private async bound(): Promise<void> {
    this.error = null
    this.updateHosts()
    this.bonjourName = await computerName(this.exec)
    this.bonjourAddress = await this.pickAddress(this.certAddresses)
    this.bonjour = this.advertiser(this.listener.port, this.bonjourName, this.bonjourAddress)
    this.timer = setInterval(() => { void this.checkAddresses() }, ADDRESS_CHECK_MS)
    this.timer.unref()
    await this.store.setEnabled(true)
  }

  /** The port stayed taken: say so, and turn the switch back off unless the server is booting. */
  private async gaveUp(boot: boolean): Promise<{ enabled: boolean; error: 'portInUse' }> {
    this.error = 'portInUse'
    this.app.log.warn({ port: this.listener.port }, 'remote listener port in use')
    if (boot) return { enabled: true, error: 'portInUse' }
    await this.store.setEnabled(false)
    return { enabled: false, error: 'portInUse' }
  }

  /**
   * Tries the port again `bindRetry.attempts` times, each try in the chain, the waits outside it.
   * A stop, a close or another start since drops it (`retrying` no longer this one's).
   */
  private retryBind(key: string, cert: string, boot: boolean): void {
    const token = {}
    this.retrying = token
    const current = () => this.retrying === token && !this.closing
    void (async () => {
      for (let attempt = 0; attempt < this.bindRetry.attempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, this.bindRetry.delayMs).unref())
        const done = await this.serialize(async () => {
          if (!current()) return true
          if (!(await this.tryBind(key, cert))) return false
          this.retrying = null
          await this.bound()
          return true
        })
        if (done) return
      }
      await this.serialize(async () => {
        if (!current()) return
        this.retrying = null
        await this.gaveUp(boot)
      })
    })().catch((err: unknown) => {
      if (this.retrying === token) this.retrying = null
      this.app.log.warn({ err: (err as Error).message }, 'could not start the remote listener')
    })
  }

  private async stop(): Promise<{ enabled: boolean }> {
    this.retrying = null
    await this.halt()
    this.codes.clear()
    this.error = null
    await this.store.setEnabled(false)
    return { enabled: false }
  }

  /** Stops listening and advertising and drops every paired socket, without touching the switch. */
  private async halt(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.bonjour?.stop()
    this.bonjour = null
    this.hosts = new Set()
    this.app.pairing.setRemoteHosts(() => this.hosts)
    await this.listener.stop()
    this.hub.closeRemote()
  }

  /**
   * The `host:port` authorities the gate lets in, lowercased as it compares them: the `.local`
   * name and the IPv4 addresses, deliberately no IPv6 literal. A zoned one (`fe80::1%en0`) would
   * reach the cookie domain, the CSP host sources and the Origin check in forms none of them
   * accept, so the iPad app connects by name or IPv4 only (`isConnectableHost`). A peer can still
   * be IPv6 under the `.local` Host; `codes.ts` keys it by /64 for that.
   */
  private updateHosts(): void {
    const port = this.listener.port
    const names = [
      ...(this.hostName !== null ? [`${this.hostName}.local:${port}`] : []),
      ...this.certAddresses.map((a) => `${a}:${port}`),
    ]
    this.hosts = new Set(names.map((n) => n.toLowerCase()))
    this.app.pairing.setRemoteHosts(() => this.hosts)
  }

  /**
   * Follows the Mac to a new address: re-issues the certificate from the same key (so the pin
   * holds), lets the new authority through the gate, and advertises the new address in the
   * Bonjour TXT record. Nothing happens when nothing changed.
   */
  private checkAddresses(): Promise<void> {
    return this.serialize(async () => {
      if (!this.listener.running) return
      const addresses = this.readAddresses()
      const hostName = await localHostName(this.exec)
      if (addresses.join(',') === this.certAddresses.join(',') && hostName === this.hostName) return
      const key = await ensureKey(this.secrets, { exec: this.exec })
      const cert = await issueCertificate(key, { host: hostName === null ? null : `${hostName}.local`, addresses }, { exec: this.exec })
      if (!this.listener.running) return
      this.listener.setCertificate(key, cert)
      this.hostName = hostName
      this.certAddresses = addresses
      this.updateHosts()
      // The advertisement carries the address too (TXT `a=`): announce the new one.
      const address = await this.pickAddress(addresses)
      if (!this.listener.running || this.bonjour === null || address === this.bonjourAddress) return
      this.bonjour.stop()
      this.bonjourAddress = address
      this.bonjour = this.advertiser(this.listener.port, this.bonjourName, address)
    }).catch((err: unknown) => {
      this.app.log.warn({ err: (err as Error).message }, 'could not follow a change of address')
    })
  }

  private grantedManifests(): Map<string, ChannelManifest> {
    this.manifests ??= grantedCatalog(this.catalog, this.config.get())
    return this.manifests
  }

  /** What a device may hear: its screen's channels, or nothing beyond the host's own. */
  private policyFor(deviceId: string): ScreenChannels | null {
    const screenId = this.me(deviceId)?.screenId ?? null
    if (screenId === null) return null
    const config = this.config.get()
    // A screen that stopped being a device screen grants nothing, even before the store catches up.
    if (!isDeviceScreen(config, screenId)) return null
    return screenChannels(config, screenId, this.grantedManifests(), this.channelOf)
  }

  private refreshAll(): void {
    for (const device of this.store.list()) this.hub.refreshDevice(device.id)
  }

  /**
   * Runs inside the config store's queue: it must not save the config, and does not wait for the
   * devices file it writes. Policies are narrowed at once — a screen gone or turned into another
   * kind already grants nothing — and the orphans are refreshed again once their record says so.
   */
  private onConfigChange(cfg: Config): void {
    this.manifests = null
    for (const device of this.store.list()) {
      if (device.kind !== 'ipad' || device.screenId === null || isDeviceScreen(cfg, device.screenId)) continue
      // Conditional, inside the store's queue: an attach to another screen queued before this
      // write runs must not be undone by it.
      void this.store.detach(device.id, device.screenId)
        .then((changed) => { if (changed) this.hub.refreshDevice(device.id) })
        .catch((err: unknown) => {
          this.app.log.warn({ err: (err as Error).message }, 'could not detach a device from its screen')
        })
    }
    this.refreshAll()
  }
}
