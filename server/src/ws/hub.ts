import type { ProviderRegistry } from '../providers/registry.js'
import type { CommandContext } from '../providers/types.js'
import { tr } from '../i18n.js'
import { channelAllowed, DEVICE_CHANNEL, HOST_CHANNELS, type ScreenChannels } from '../devices/channels.js'

/**
 * Largest message a socket may send.
 *
 * A widget's messages are a channel name or a small command payload. 64 kB is an order of
 * magnitude more than any of them need, and a cap is what stops one socket making the server
 * hold arbitrary memory before anything validates the content.
 */
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024

/**
 * Most channels one socket may subscribe to.
 *
 * The dashboard opens one socket and every widget on the page shares it, so the real number is
 * the number of widgets — a few dozen at the very most. Each subscription makes the registry
 * activate a provider, so an unbounded list is an unbounded number of pollers.
 */
export const MAX_CHANNELS_PER_SOCKET = 64

export interface SocketLike {
  send(data: string): void
  on(event: 'message' | 'close', cb: (...args: any[]) => void): void
  close(code?: number): void
  /** Drops the connection without a closing handshake. `ws` has it; only paired sockets use it. */
  terminate?(): void
}

/** Close code sent to a paired socket whose device was revoked, or when remote access is turned off. */
export const DEVICE_CLOSE_CODE = 4401

/**
 * How long a closed paired socket gets to finish the closing handshake before it is dropped.
 * The hub has already stopped listening to it; this only frees the connection sooner than `ws`'s
 * own 30 s close timeout.
 */
export const DEVICE_TERMINATE_MS = 2000

/**
 * Channels a paired device never reaches, whatever its screen holds. `companion` carries the
 * pairing code shown on the Edge, what a browser tab here is playing and the WebRTC offers to
 * watch it: this Mac's dashboard only, in this first version. Matched by family, so a
 * `companion:<suffix>` is refused too.
 */
export const LOCAL_ONLY_CHANNELS: ReadonlySet<string> = new Set(['companion'])

function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel.split(':')[0])
}

/**
 * What a paired device's screen lets it touch, or null when the device has no screen: then only
 * the host channels and its own `device` channel are open to it.
 */
export type DevicePolicy = (deviceId: string) => ScreenChannels | null

/**
 * What a paired device is sent on a viewed channel instead of what everyone else hears: the host
 * channels (the config, narrowed to its own screen, `devices/scope.ts`) and any channel named when
 * the view is set (`brightness`, narrowed to its screen's entry). Null sends nothing.
 */
export type HostView = (deviceId: string, channel: string, data: unknown) => unknown

type Incoming =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'command'; id: string; channel: string; name: string; payload?: unknown }

export class Hub {
  private clients = new Map<SocketLike, Set<string>>()
  /** Where each socket came from, so a command can be refused on the provider's terms. */
  private contexts = new Map<SocketLike, CommandContext>()
  private lastValues = new Map<string, unknown>()
  /** The open sockets of each paired device, so one device can be refreshed or closed. */
  private deviceSockets = new Map<string, Set<SocketLike>>()
  /**
   * Supplied from outside (Task 6 builds it from the config and the granted catalogue), so the
   * hub knows nothing about either. Until one is set, a paired device gets what a device with no
   * screen gets: deny by default.
   */
  private policy: DevicePolicy = () => null
  private devicePayload: (deviceId: string) => unknown = () => null
  /**
   * Until one is set, a paired device hears nothing on a host channel: the full config is the
   * Mac's, and a view that does not exist yet must not fall back to it.
   */
  private hostView: HostView = () => null
  /** The channels a paired socket hears through `hostView`: the host ones, and those named with it. */
  private viewChannels = new Set<string>(HOST_CHANNELS)
  /** The last host-channel message each paired socket was sent, so a refresh repeats nothing. */
  private hostSent = new Map<SocketLike, Map<string, string>>()

  constructor(private readonly registry: ProviderRegistry) {}

  /** A socket with no known origin is treated as remote: only the route can vouch for one. */
  attach(socket: SocketLike, ctx: CommandContext = { loopback: false, paired: false }): void {
    const channels = new Set<string>()
    this.clients.set(socket, channels)
    this.contexts.set(socket, ctx)
    const deviceId = ctx.paired ? ctx.deviceId : undefined
    if (deviceId !== undefined) {
      let sockets = this.deviceSockets.get(deviceId)
      if (!sockets) this.deviceSockets.set(deviceId, (sockets = new Set()))
      sockets.add(socket)
    }
    socket.on('message', (raw: Buffer | string) => this.onMessage(socket, channels, raw))
    socket.on('close', () => this.detach(socket))
  }

  /**
   * Forgets a socket: its subscriptions are released and nothing it sends is read any more.
   * Idempotent, because `closeDevice` detaches before `close` fires, and with `ws` that event
   * only comes once the peer finished the handshake — up to 30 s later.
   */
  private detach(socket: SocketLike): void {
    const channels = this.clients.get(socket)
    if (!channels) return
    const ctx = this.contexts.get(socket)
    this.clients.delete(socket)
    this.contexts.delete(socket)
    this.hostSent.delete(socket)
    const deviceId = ctx?.paired ? ctx.deviceId : undefined
    if (deviceId !== undefined) {
      const sockets = this.deviceSockets.get(deviceId)
      sockets?.delete(socket)
      if (sockets?.size === 0) this.deviceSockets.delete(deviceId)
    }
    for (const ch of channels) this.registry.removeSubscriber(ch)
  }

  setPolicy(policy: DevicePolicy): void {
    this.policy = policy
  }

  setDevicePayload(fn: (deviceId: string) => unknown): void {
    this.devicePayload = fn
  }

  /** `channels`: widget channels besides the host ones whose payload a device gets its own view of. */
  setHostView(fn: HostView, channels: readonly string[] = []): void {
    this.hostView = fn
    this.viewChannels = new Set([...HOST_CHANNELS, ...channels])
  }

  /**
   * Re-reads a device's policy after its screen, or that screen's widgets, changed: drops every
   * subscription the policy no longer allows, re-sends its view of the host channels when that
   * view changed, then tells the device's sockets what changed on the `device` channel so the
   * page can reload what it shows.
   */
  refreshDevice(deviceId: string): void {
    const sockets = this.deviceSockets.get(deviceId)
    if (!sockets) return
    // Revocation first, and on its own: nothing the payload does can leave a subscription alive.
    const allowed = this.policyFor(deviceId)
    for (const socket of sockets) {
      const channels = this.clients.get(socket)
      if (!channels) continue
      for (const ch of [...channels]) {
        if (this.subscriptionAllowed(allowed, ch)) continue
        channels.delete(ch)
        this.registry.removeSubscriber(ch)
      }
    }
    // The host channels next: the config a device sees is its screen's, and the screen may have
    // just changed. Before the `device` message, so the page has its new screen when told of it.
    for (const socket of sockets) {
      const channels = this.clients.get(socket)
      if (!channels) continue
      for (const ch of this.viewChannels) {
        if (!channels.has(ch) || !this.lastValues.has(ch)) continue
        const view = this.messageFor(socket, ch, this.lastValues.get(ch), '')
        if (view !== null) this.safeSend(socket, view)
      }
    }
    const msg = this.deviceMessage(deviceId)
    if (msg === null) return
    for (const socket of sockets) this.safeSend(socket, msg)
  }

  /** Closes every socket of one device, for a device that was unpaired. */
  closeDevice(deviceId: string): void {
    for (const socket of [...(this.deviceSockets.get(deviceId) ?? [])]) this.safeClose(socket)
  }

  /** Closes every paired socket, for remote access being turned off. Local sockets stay. */
  closeRemote(): void {
    for (const sockets of [...this.deviceSockets.values()]) {
      for (const socket of [...sockets]) this.safeClose(socket)
    }
  }

  /**
   * Drops a channel's cached last value.
   *
   * Called by the registry when a provider is torn down, replaced or unregistered: whatever that
   * channel last said belonged to a connection or a provider that is gone, and replaying it to
   * the next subscriber would show data from credentials that no longer exist. A widget that
   * subscribes after this waits for the first fresh poll instead, which the registry runs at once.
   * Current socket clients also discard their replay cache; already open widgets keep their rendered value until the next publish.
   */
  forget(channel: string): void {
    this.lastValues.delete(channel)
    const msg = JSON.stringify({ type: 'invalidate', channel })
    for (const [socket, channels] of this.clients) {
      if (channels.has(channel)) this.safeSend(socket, msg)
    }
  }

  broadcast(channel: string, data: unknown): void {
    this.lastValues.set(channel, data)
    const msg = JSON.stringify({ type: 'data', channel, data })
    for (const [socket, channels] of this.clients) {
      if (!channels.has(channel)) continue
      const out = this.messageFor(socket, channel, data, msg)
      if (out !== null) this.safeSend(socket, out)
    }
  }

  /**
   * The message one socket is sent for `channel`: `shared` for everyone but a paired socket on a
   * host channel, which gets its device's view instead — or nothing, when there is no view, when
   * it cannot be built, or when it is exactly what that socket was last sent.
   */
  private messageFor(socket: SocketLike, channel: string, data: unknown, shared: string): string | null {
    const ctx = this.contextOf(socket)
    if (!ctx.paired || !this.viewChannels.has(channel)) return shared
    const msg = this.viewMessage(ctx, channel, data)
    if (msg === null) return null
    let sent = this.hostSent.get(socket)
    if (!sent) this.hostSent.set(socket, (sent = new Map()))
    if (sent.get(channel) === msg) return null
    sent.set(channel, msg)
    return msg
  }

  /** A paired context's view of a host channel as a message, or null for nothing. */
  private viewMessage(ctx: CommandContext, channel: string, data: unknown): string | null {
    if (ctx.deviceId === undefined) return null
    try {
      const view = this.hostView(ctx.deviceId, channel, data)
      if (view === null || view === undefined) return null
      return JSON.stringify({ type: 'data', channel, data: view })
    } catch {
      // Nothing logged: the error may quote the config.
      return null
    }
  }

  /**
   * Sends to a channel's subscribers without keeping the value.
   *
   * For an event rather than a state: `broadcast` replays the last value to every new
   * subscriber, which is right for "the CPU is at 40 %" and wrong for "this widget's files just
   * changed" — a page opened a minute later would reload its widgets for a save it never saw.
   *
   * A paired socket on a host channel gets its device's view, as with `broadcast`, but never
   * deduplicated against the last one: two events alike are still two events.
   */
  notify(channel: string, data: unknown): void {
    const msg = JSON.stringify({ type: 'data', channel, data })
    for (const [socket, channels] of this.clients) {
      if (!channels.has(channel)) continue
      const ctx = this.contextOf(socket)
      const out = ctx.paired && this.viewChannels.has(channel) ? this.viewMessage(ctx, channel, data) : msg
      if (out !== null) this.safeSend(socket, out)
    }
  }

  private onMessage(socket: SocketLike, channels: Set<string>, raw: Buffer | string): void {
    // A detached socket may still be finishing its closing handshake: it is heard no more.
    if (!this.clients.has(socket)) return
    let msg: Incoming
    try { msg = JSON.parse(raw.toString()) } catch {
      return this.safeSend(socket, JSON.stringify({ type: 'error', error: 'JSON invalide' }))
    }
    switch (msg?.type) {
      case 'subscribe': {
        if (typeof msg.channel !== 'string' || msg.channel === '') break
        const ctx = this.contextOf(socket)
        if (msg.channel === DEVICE_CHANNEL) {
          // Reserved, and never added to `channels`: it has no provider, `broadcast` cannot fan it
          // out, and only `refreshDevice` speaks on it. A local socket has no device and hears
          // nothing; a paired one gets its own payload replayed.
          if (ctx.paired && ctx.deviceId !== undefined) {
            const reply = this.deviceMessage(ctx.deviceId)
            if (reply !== null) this.safeSend(socket, reply)
          }
          return
        }
        if (ctx.paired && !this.subscriptionAllowed(this.policyOf(ctx), msg.channel)) {
          return this.refuse(socket)
        }
        if (!channels.has(msg.channel)) {
          // Each subscription starts a provider polling, so the list is bounded.
          if (channels.size >= MAX_CHANNELS_PER_SOCKET) {
            return this.safeSend(socket, JSON.stringify({ type: 'error', error: tr(undefined, 'ws.tooManyChannels') }))
          }
          channels.add(msg.channel)
          this.registry.addSubscriber(msg.channel)
        }
        if (this.lastValues.has(msg.channel)) {
          const data = this.lastValues.get(msg.channel)
          // A replay is sent even when it repeats the last one: the page asked again.
          this.hostSent.get(socket)?.delete(msg.channel)
          const out = this.messageFor(socket, msg.channel, data, JSON.stringify({ type: 'data', channel: msg.channel, data }))
          if (out !== null) this.safeSend(socket, out)
        }
        return
      }
      case 'unsubscribe': {
        if (msg.channel === DEVICE_CHANNEL) return
        if (channels.delete(msg.channel)) this.registry.removeSubscriber(msg.channel)
        return
      }
      case 'command': {
        const { id, channel, name, payload } = msg
        const ctx = this.contextOf(socket)
        // A paired device hears one answer for a channel it may not use and for one that does not
        // exist: the registry's own "unknown channel" would otherwise let it enumerate ids. A
        // local-only family (`companion`) is refused whatever the screen's manifests grant.
        if (ctx.paired && (typeof channel !== 'string' || isLocalOnly(channel)
          || !channelAllowed(this.policyOf(ctx)?.commands ?? [], channel)
          || !this.registry.has(channel))) {
          return this.refuse(socket, id)
        }
        this.registry.runCommand(channel, name, payload, ctx).then(
          (result) => this.safeSend(socket, JSON.stringify({ type: 'result', id, result: result ?? null })),
          (err: Error) => this.safeSend(socket, JSON.stringify({ type: 'error', id, error: err.message })),
        )
        return
      }
    }
    this.safeSend(socket, JSON.stringify({ type: 'error', error: 'message inconnu' }))
  }

  private contextOf(socket: SocketLike): CommandContext {
    return this.contexts.get(socket) ?? { loopback: false, paired: false }
  }

  /** A paired context with no device id cannot be checked against anything: nothing is allowed. */
  private policyOf(ctx: CommandContext): ScreenChannels | null {
    return ctx.deviceId === undefined ? null : this.policyFor(ctx.deviceId)
  }

  /** Fails closed: a policy that throws is a device with no screen. */
  private policyFor(deviceId: string): ScreenChannels | null {
    try { return this.policy(deviceId) } catch { return null }
  }

  /**
   * The `device` message for one device, or null when its payload could not be built. Nothing is
   * logged: the payload describes the device, and an error from building it may quote it.
   */
  private deviceMessage(deviceId: string): string | null {
    try {
      return JSON.stringify({ type: 'data', channel: DEVICE_CHANNEL, data: this.devicePayload(deviceId) })
    } catch {
      return null
    }
  }

  /** For a paired socket only: a local one subscribes to anything. */
  private subscriptionAllowed(allowed: ScreenChannels | null, channel: string): boolean {
    if (isLocalOnly(channel)) return false
    return HOST_CHANNELS.includes(channel) || channelAllowed(allowed?.subscriptions ?? [], channel)
  }

  private refuse(socket: SocketLike, id?: string): void {
    const error = tr(undefined, 'device.channelRefused')
    this.safeSend(socket, JSON.stringify(id === undefined ? { type: 'error', error } : { type: 'error', id, error }))
  }

  /** Detaches first, so nothing the peer sends while the close handshake runs is acted on. */
  private safeClose(socket: SocketLike): void {
    this.detach(socket)
    try { socket.close(DEVICE_CLOSE_CODE) } catch { /* already closed */ }
    if (socket.terminate) {
      const timer = setTimeout(() => { try { socket.terminate?.() } catch { /* gone */ } }, DEVICE_TERMINATE_MS)
      timer.unref?.()
    }
  }

  private safeSend(socket: SocketLike, data: string): void {
    try { socket.send(data) } catch { /* socket closed */ }
  }
}
