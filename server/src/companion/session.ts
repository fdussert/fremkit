/**
 * The browser extension's share, as state: which extensions are connected, the one tab shared
 * at a time, the widget frames watching it (receivers) and the offer each one is waiting on.
 *
 * Pure: it speaks through `send` and `changed` and knows nothing of sockets or Fastify, so the
 * socket module (`socket.ts`) and the provider each drive it from their side.
 */

import { isLocalSdp, PROTOCOL, type Control, type ExtensionMessage, type ServerMessage, type TabMeta } from './protocol.js'

/** Widget frames that may watch the share at once. */
export const MAX_RECEIVERS = 4

/** Refused receiver ids remembered for one share, at most. */
const MAX_REFUSED = MAX_RECEIVERS * 4

/** A share whose extension said nothing (`tab.started`, `tab.meta`) for this long is over. */
export const STALE_MS = 10_000

/**
 * A share's `tab.meta` refreshes are published at most once per this many ms (4 per second): the
 * latest one is kept and published on the trailing edge. The extension sends one a second and one
 * per control, so this only bites a sender that floods.
 */
export const META_PUBLISH_MS = 250

export interface CompanionState {
  protocol: typeof PROTOCOL
  extensions: { connected: number; paired: number }
  tab: {
    state: 'idle' | 'sharing'
    sessionId: string | null
    /** The sharing extension's name, as the user sees it in Appareils. */
    device: string | null
    meta: TabMeta | null
    /** receiverId → the extension's offer for it. */
    offers: Record<string, string>
    /**
     * Every receiver this server knows, offer or not. A widget frame whose id is missing — the
     * server restarted under a live peer — announces itself again with the same id.
     */
    receivers: string[]
    /**
     * Receivers whose offer was refused in this share (it named more than this Mac). Their frame
     * stops asking and says so until the share changes: asking again gets the same offer.
     */
    refused: string[]
  }
}

export interface CompanionSessionOptions {
  now?: () => number
  send: (deviceId: string, msg: ServerMessage) => void
  changed: () => void
  /** Whether anything on a local dashboard could show a share; false refuses one with `noWidget`. */
  canShare?: () => boolean
  /** How many extensions are paired, connected or not. */
  pairedCount?: () => number
  /**
   * Whether Fremplay is on (`labs.companion`); off refuses a share with `disabled`. A product
   * switch, not a security boundary: the socket, the routes and the channel keep their own guards
   * whatever it says. On when left out.
   */
  enabled?: () => boolean
}

interface Share {
  deviceId: string
  sessionId: string
  meta: TabMeta
  lastSeen: number
  /** Taken back through a `hello` (the server restarted under it), not started by a `tab.started`. */
  resumed: boolean
  /** When a `tab.meta` of this share was last published. */
  metaPublishedAt?: number
}

interface Receiver {
  instanceId: string
  offer: string | null
}

export class CompanionSession {
  private readonly now: () => number
  private readonly send: (deviceId: string, msg: ServerMessage) => void
  private readonly changed: () => void
  private readonly canShare: () => boolean
  private readonly pairedCount: () => number
  private readonly enabled: () => boolean
  /** Connected extensions: device id → name. */
  private readonly connected = new Map<string, string>()
  /** Extensions that said hello with a protocol this server does not speak. */
  private readonly foreign = new Set<string>()
  /** The name of every extension that ever connected, so a share outliving its socket keeps one. */
  private readonly names = new Map<string, string>()
  private share: Share | null = null
  /** The trailing publish of a `tab.meta` that came too soon after the last one. */
  private metaTimer: ReturnType<typeof setTimeout> | null = null
  /** In registration order, so the first entry of an instance is its oldest. */
  private readonly receivers = new Map<string, Receiver>()
  /** Receivers whose offer was refused in the current share; cleared when the share changes or ends. */
  private readonly refused = new Set<string>()

  constructor(opts: CompanionSessionOptions) {
    this.now = opts.now ?? Date.now
    this.send = opts.send
    this.changed = opts.changed
    this.canShare = opts.canShare ?? (() => false)
    this.pairedCount = opts.pairedCount ?? (() => 0)
    this.enabled = opts.enabled ?? (() => true)
  }

  /**
   * `labs.companion` may have changed. Every connected extension hears the new state in a fresh
   * `ready` (its popup says Fremplay is off before anyone clicks Send), and a share running when
   * it went off ends, its extension told why.
   */
  switched(): void {
    const on = this.enabled()
    for (const deviceId of this.connected.keys()) {
      if (!this.foreign.has(deviceId)) this.send(deviceId, this.ready())
    }
    if (on || !this.share) return
    const { deviceId, sessionId } = this.share
    this.send(deviceId, { type: 'tab.refused', sessionId, reason: 'disabled' })
    this.endShare()
  }

  /** The greeting, with the state of the modules this server can switch off. */
  private ready(): ServerMessage {
    return { type: 'ready', protocol: PROTOCOL, modules: { fremplay: this.enabled() } }
  }

  connect(deviceId: string, name: string): void {
    this.connected.set(deviceId, name)
    this.names.set(deviceId, name)
    this.foreign.delete(deviceId)
    this.changed()
  }

  /** The ids of the extensions whose socket is open now. */
  connectedIds(): ReadonlySet<string> {
    return new Set(this.connected.keys())
  }

  /**
   * A socket went away. The share stays: a server restart or a dropped socket comes back with a
   * `hello` that carries it, and a share nobody comes back for goes stale in `tick`.
   */
  disconnect(deviceId: string): void {
    if (!this.connected.delete(deviceId)) return
    this.foreign.delete(deviceId)
    this.changed()
  }

  /** The device was unpaired: unlike a disconnect, whatever it was sharing ends now. */
  revoke(deviceId: string): void {
    const wasConnected = this.connected.delete(deviceId)
    this.foreign.delete(deviceId)
    this.names.delete(deviceId)
    if (this.share?.deviceId === deviceId) this.endShare()
    else if (wasConnected) this.changed()
  }

  /** Revokes every device the session knows of, connected or sharing, that is no longer paired. */
  prune(isPaired: (deviceId: string) => boolean): void {
    const known = new Set([...this.connected.keys(), ...(this.share ? [this.share.deviceId] : [])])
    for (const id of known) if (!isPaired(id)) this.revoke(id)
  }

  onMessage(deviceId: string, msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'hello':
        return this.hello(deviceId, msg.protocol, msg.session)
      case 'tab.started':
        return this.started(deviceId, msg.sessionId, msg.meta)
      case 'tab.meta': {
        const share = this.shareOf(deviceId, msg.sessionId)
        if (!share) return
        share.meta = msg.meta
        share.lastSeen = this.now()
        return this.publishMeta(share)
      }
      case 'tab.offer': {
        if (!this.shareOf(deviceId, msg.sessionId)) return
        const receiver = this.receivers.get(msg.receiverId)
        // An offer naming anything beyond this Mac is never relayed. Only that receiver goes
        // without: the share and the other receivers keep going, and the extension is told why.
        // The receiver stays known with no offer, so its frame waits rather than asking again.
        if (!isLocalSdp(msg.sdp)) {
          this.send(deviceId, { type: 'tab.refused', sessionId: msg.sessionId, reason: 'offer', receiverId: msg.receiverId })
          // Remembered for a receiver this server knows, so the set stays bounded by the receivers.
          if (receiver) {
            receiver.offer = null
            this.refused.add(msg.receiverId)
            // Frames that reload make new ids: the oldest refusals go first past a few rounds.
            if (this.refused.size > MAX_REFUSED) this.refused.delete(this.refused.values().next().value as string)
            this.changed()
          }
          return
        }
        if (!receiver) return
        receiver.offer = msg.sdp
        return this.changed()
      }
      case 'tab.stopped':
        if (this.shareOf(deviceId, msg.sessionId)) this.endShare()
        return
    }
  }

  /**
   * A widget frame wants to watch. A receiver is bound to the instance that registered it; a
   * known one coming back (after a restart) is kept and only asked for again without an offer.
   */
  view(receiverId: string, instanceId: string): boolean {
    const known = this.receivers.get(receiverId)
    if (known) {
      if (known.instanceId !== instanceId) return false
      if (known.offer === null && this.share && !this.refused.has(receiverId)) this.send(this.share.deviceId, { type: 'tab.view', receiverId })
      return true
    }
    if (this.receivers.size >= MAX_RECEIVERS) {
      // An instance that reloads its frame makes a new receiver: its own oldest one gives way,
      // never another instance's.
      const oldest = [...this.receivers].find(([, r]) => r.instanceId === instanceId)?.[0]
      if (oldest === undefined) return false
      this.drop(oldest)
    }
    this.receivers.set(receiverId, { instanceId, offer: null })
    // A refused receiver that left and came back is not asked of the extension again in this share.
    if (this.share && !this.refused.has(receiverId)) this.send(this.share.deviceId, { type: 'tab.view', receiverId })
    // The frame reads its id in `receivers` to know it is known, so a new one is news.
    this.changed()
    return true
  }

  answer(receiverId: string, instanceId: string, sdp: string): boolean {
    const receiver = this.receivers.get(receiverId)
    if (!this.share || !receiver || receiver.instanceId !== instanceId || receiver.offer === null) return false
    if (!isLocalSdp(sdp)) return false
    this.send(this.share.deviceId, { type: 'tab.answer', receiverId, sdp })
    return true
  }

  leave(receiverId: string, instanceId: string): void {
    if (this.receivers.get(receiverId)?.instanceId !== instanceId) return
    this.drop(receiverId)
  }

  control(c: Control): boolean {
    if (!this.share) return false
    this.send(this.share.deviceId, { type: 'tab.control', ...c })
    return true
  }

  snapshot(): CompanionState {
    const share = this.share
    const offers: Record<string, string> = {}
    if (share) {
      for (const [id, r] of this.receivers) if (r.offer !== null) offers[id] = r.offer
    }
    return {
      protocol: PROTOCOL,
      extensions: { connected: this.connected.size, paired: this.pairedCount() },
      tab: {
        state: share ? 'sharing' : 'idle',
        sessionId: share?.sessionId ?? null,
        device: share ? (this.names.get(share.deviceId) ?? null) : null,
        meta: share?.meta ?? null,
        offers,
        receivers: [...this.receivers.keys()],
        refused: share ? [...this.refused] : [],
      },
    }
  }

  /** True when the current share came back through a `hello` rather than a `tab.started`. */
  shareResumed(): boolean {
    return this.share?.resumed === true
  }

  /** Clears a share that went quiet. Driven by an interval in the socket module. */
  tick(): void {
    if (this.share && this.now() - this.share.lastSeen >= STALE_MS) {
      const { deviceId } = this.share
      this.endShare()
      // Still connected yet silent: whatever it believes it shares, the server no longer does.
      if (this.connected.has(deviceId)) this.send(deviceId, { type: 'tab.stop' })
    }
  }

  private hello(deviceId: string, protocol: number, session?: { sessionId: string; meta: TabMeta }): void {
    this.send(deviceId, this.ready())
    if (protocol !== PROTOCOL) {
      this.foreign.add(deviceId)
      if (session) this.send(deviceId, { type: 'tab.refused', sessionId: session.sessionId, reason: 'protocol' })
      return
    }
    if (!session) return
    const current = this.share
    if (current && (current.deviceId !== deviceId || current.sessionId !== session.sessionId)) {
      // One share overall, and the running one was here first.
      this.send(deviceId, { type: 'tab.stop' })
      return
    }
    // Fremplay off: no share, the one coming back included (a running one ended with the switch).
    if (!this.enabled()) {
      if (current) this.endShare()
      this.send(deviceId, { type: 'tab.refused', sessionId: session.sessionId, reason: 'disabled' })
      return
    }
    if (!current && !this.canShare()) {
      this.send(deviceId, { type: 'tab.refused', sessionId: session.sessionId, reason: 'noWidget' })
      return
    }
    this.clearMetaTimer()
    if (!current) this.refused.clear()
    this.share = { deviceId, sessionId: session.sessionId, meta: session.meta, lastSeen: this.now(), resumed: current?.resumed ?? true }
    this.send(deviceId, { type: 'tab.accepted', sessionId: session.sessionId })
    // Receivers that re-announced themselves first, or are still waiting on an offer, ask now.
    for (const [receiverId, r] of this.receivers) {
      if (r.offer === null && !this.refused.has(receiverId)) this.send(deviceId, { type: 'tab.view', receiverId })
    }
    this.changed()
  }

  private started(deviceId: string, sessionId: string, meta: TabMeta): void {
    if (this.foreign.has(deviceId)) {
      return this.send(deviceId, { type: 'tab.refused', sessionId, reason: 'protocol' })
    }
    if (!this.enabled()) {
      return this.send(deviceId, { type: 'tab.refused', sessionId, reason: 'disabled' })
    }
    if (!this.canShare()) {
      return this.send(deviceId, { type: 'tab.refused', sessionId, reason: 'noWidget' })
    }
    const current = this.share
    if (current?.deviceId === deviceId && current.sessionId === sessionId) {
      // The same share announced again: nothing to replace.
      current.meta = meta
      current.lastSeen = this.now()
    } else {
      if (current && current.deviceId !== deviceId) this.send(current.deviceId, { type: 'tab.stop' })
      // The widget frames keep their receiver ids: an offer from the previous tab is worthless,
      // so each one is asked again of the new sharer, after it heard it was accepted.
      for (const r of this.receivers.values()) r.offer = null
      this.refused.clear()
      this.clearMetaTimer()
      this.share = { deviceId, sessionId, meta, lastSeen: this.now(), resumed: false }
      this.send(deviceId, { type: 'tab.accepted', sessionId })
      for (const receiverId of this.receivers.keys()) this.send(deviceId, { type: 'tab.view', receiverId })
      return this.changed()
    }
    this.send(deviceId, { type: 'tab.accepted', sessionId })
    this.changed()
  }

  /** Publishes a share's new meta now, or on the trailing edge of `META_PUBLISH_MS`. */
  private publishMeta(share: Share): void {
    // Already due: that publish reads `share.meta` when it fires, so it carries this one.
    if (this.metaTimer !== null) return
    const wait = (share.metaPublishedAt ?? -Infinity) + META_PUBLISH_MS - this.now()
    if (wait <= 0) {
      share.metaPublishedAt = this.now()
      return this.changed()
    }
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null
      if (this.share !== share) return
      share.metaPublishedAt = this.now()
      this.changed()
    }, wait)
    this.metaTimer.unref?.()
  }

  private clearMetaTimer(): void {
    if (this.metaTimer !== null) clearTimeout(this.metaTimer)
    this.metaTimer = null
  }

  /** The current share, when this device's message is about it; null otherwise. */
  private shareOf(deviceId: string, sessionId: string): Share | null {
    const share = this.share
    return share && share.deviceId === deviceId && share.sessionId === sessionId ? share : null
  }

  private drop(receiverId: string): void {
    const receiver = this.receivers.get(receiverId)
    if (!receiver) return
    this.receivers.delete(receiverId)
    if (this.share) this.send(this.share.deviceId, { type: 'tab.detach', receiverId })
    this.changed()
  }

  private endShare(): void {
    this.clearMetaTimer()
    this.share = null
    this.receivers.clear()
    this.refused.clear()
    this.changed()
  }
}
