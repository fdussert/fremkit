import type { CommandContext, Provider, Publish } from './types.js'

const MAX_BACKOFF_MS = 60_000

/**
 * Channels whose last value is dropped as soon as nobody is watching, not only when the provider
 * goes away.
 *
 * The clipboard is the one: its provider empties its history in `stop()`, so the hub holding the
 * last snapshot would keep showing what was on the pasteboard to the next subscriber, after the
 * widget that was allowed to see it had been removed.
 */
const FORGET_WHEN_IDLE = new Set(['clipboard'])

interface State {
  provider: Provider
  subscribers: number
  /** Whether `start()` ran and its matching `stop()` has not: keeps the two strictly paired. */
  started: boolean
  timer: NodeJS.Timeout | null
  backoffMs: number
  lastJson: string | undefined
  inFlight: boolean
  /** Poll again as soon as the one in flight returns: it may have read a setting since changed. */
  pollAgain: boolean
  /** A `refresh()` arrived while a poll was in flight: poll once more, and publish that one. */
  refreshAgain: boolean
  /**
   * What the last poll said about itself, for the diagnostics report: `null` for a snapshot
   * without an error, an error code otherwise, `undefined` before the first poll.
   */
  lastError: string | null | undefined
}

/** One channel as the diagnostics report sees it. */
export interface ChannelStatus {
  channel: string
  /** Widgets watching it right now. */
  watched: boolean
  /** `null` when the last poll was clean, a code when it was not, absent before any poll. */
  lastError?: string | null
}

/**
 * An error a snapshot carries, as a code fit for a public report. A provider's `error` is meant
 * to be a code (`offline`, `unauthorized`…); anything that does not look like one — a thrown
 * error's message, which may quote a host or a path — is reported as `error` and nothing more.
 */
export function errorCode(data: unknown, threw: boolean): string | null {
  if (threw) return 'exception'
  if (typeof data !== 'object' || data === null || !('error' in data)) return null
  const error = (data as { error: unknown }).error
  if (error === undefined || error === null || error === false) return null
  return typeof error === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(error) ? error : 'error'
}

export class ProviderRegistry {
  private states = new Map<string, State>()
  /** Told whenever `status()` would answer differently: see `onStatus`. */
  private statusListeners = new Set<() => void>()

  /**
   * `forget` is told when a channel stops having anything to say: its provider was torn down,
   * replaced or unregistered. The hub keeps the last value of every channel so a new subscriber
   * sees something at once, and without this that cache held the snapshot of a connection the
   * user had deleted — replayed to every widget that subscribed afterwards.
   */
  constructor(
    private readonly publish: Publish,
    private readonly forget: (channel: string) => void = () => {},
  ) {}

  register(provider: Provider): void {
    // A poll is the only way anything reaches a channel, so a provider without one publishes no
    // address and could never take one back: the flag there is a mistake, not a no-op.
    if (provider.publishesAccountEmail && !provider.poll) {
      throw new Error(`provider ${provider.channel}: publishesAccountEmail needs a poll()`)
    }
    const previous = this.states.get(provider.channel)
    // Read before the teardown, which zeroes it: the widgets watching this channel did not go
    // away because the connection behind it was edited, so the replacement inherits them.
    const subscribers = previous?.subscribers ?? 0
    if (previous) this.teardown(previous, 'gone')
    const state: State = { provider, subscribers, started: false, timer: null, backoffMs: 0, lastJson: undefined, inFlight: false, pollAgain: false, refreshAgain: false, lastError: undefined }
    this.states.set(provider.channel, state)
    if (state.subscribers > 0) this.activate(state)
    this.statusChanged()
  }

  /** Removes a channel entirely: used when a connection disappears from the config. */
  unregister(channel: string): void {
    const s = this.states.get(channel)
    if (!s) return
    this.teardown(s, 'gone')
    this.states.delete(channel)
    this.statusChanged()
  }

  channels(): string[] { return [...this.states.keys()] }

  /** Every channel, whether anybody watches it and how its last poll went. */
  status(): ChannelStatus[] {
    return [...this.states.values()].map((s) => ({
      channel: s.provider.channel,
      watched: s.subscribers > 0,
      ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
    }))
  }

  /**
   * Calls `cb` whenever a channel appears, goes away, or its last poll ends differently from the
   * one before (clean → `offline`, `unauthorized` → clean…). Not on every poll: a channel that
   * keeps failing the same way says so once. Returns the function that stops listening.
   */
  onStatus(cb: () => void): () => void {
    this.statusListeners.add(cb)
    return () => { this.statusListeners.delete(cb) }
  }

  private statusChanged(): void {
    for (const cb of this.statusListeners) {
      try { cb() } catch { /* a listener's failure is not the registry's */ }
    }
  }

  /**
   * `privacy.showAccountEmail` changed: every provider that can publish the address answers again
   * now, rather than at its next tick — five minutes for an account endpoint, during which an
   * address the user has just hidden would stay on screen.
   *
   * The cached value goes first, watched or not, so the hub hands nothing stale to a widget that
   * subscribes before the new answer arrives. A watched channel is then polled at once. A poll
   * already in flight may have read the old setting, so its answer is thrown away when it returns
   * — whether anyone is still watching or not — and the channel is polled again if someone is.
   */
  reconsiderAccountEmail(): void {
    for (const s of this.states.values()) {
      if (!s.provider.publishesAccountEmail) continue
      s.lastJson = undefined
      this.forget(s.provider.channel)
      if (s.inFlight) s.pollAgain = true
      else if (s.subscribers > 0) this.schedule(s, 0)
    }
  }

  has(channel: string): boolean { return this.states.has(channel) }

  /**
   * Polls a watched channel now rather than at its next tick: for a provider whose state changes
   * by push (a command, a report from the helper) and that wants the change on screen at once.
   * Does nothing when nobody is watching; the first subscriber polls anyway.
   */
  refresh(channel: string): void {
    const s = this.states.get(channel)
    if (!s || s.subscribers === 0 || !s.provider.poll) return
    if (s.inFlight) s.refreshAgain = true
    else this.schedule(s, 0)
  }

  addSubscriber(channel: string): void {
    const s = this.states.get(channel)
    if (!s) return
    s.subscribers++
    if (s.subscribers === 1) this.activate(s)
  }

  removeSubscriber(channel: string): void {
    const s = this.states.get(channel)
    if (!s) return
    s.subscribers = Math.max(0, s.subscribers - 1)
    if (s.subscribers === 0) this.teardown(s, 'idle')
  }

  async runCommand(channel: string, name: string, payload: unknown, ctx?: CommandContext): Promise<unknown> {
    const s = this.states.get(channel)
    if (!s) throw new Error(`canal inconnu: ${channel}`)
    // Through `Object.hasOwn`: a command name comes from a widget's message, and a plain property
    // read would answer `constructor` or `toString` with something off Function.prototype.
    const commands = s.provider.commands
    const cmd = commands && Object.hasOwn(commands, name) ? commands[name] : undefined
    if (typeof cmd !== 'function') throw new Error(`commande inconnue: ${channel}.${name}`)
    return cmd(payload, ctx)
  }

  stop(): void {
    for (const s of this.states.values()) {
      this.teardown(s, 'gone')
      s.subscribers = 0
    }
  }

  /** First subscriber: let the provider open whatever it needs, then poll at once. */
  private activate(s: State): void {
    if (!s.started) { s.started = true; s.provider.start?.() }
    // A command-only provider has nothing to poll: it is registered, reachable, and never ticks.
    if (!s.provider.poll) return
    if (!s.inFlight) this.schedule(s, 0)
  }

  /**
   * True while this state is still the one the channel is served by.
   *
   * A `tick` holds its state object across an `await`, and a connection edited in the meantime
   * makes the manager register a replacement on the same channel. The old state is then an
   * orphan: nothing points at it any more, but its own poll is about to come back. Without this
   * check it published the old answer and re-armed its own timer, so the device went on being
   * polled for ever with the credentials the user had just changed.
   */
  private isCurrent(s: State): boolean {
    return this.states.get(s.provider.channel) === s
  }

  /**
   * No more subscribers (or the channel is going away): stop the clock and the provider. `stop()`
   * only runs after a matching `start()`, and only once — a provider should still make both
   * idempotent, since nothing stops a second registry from holding the same object.
   */
  private teardown(s: State, reason: 'idle' | 'gone'): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    // An in-flight poll is not a timer: zeroing this stops the orphan rescheduling itself even
    // before `isCurrent` gets a say, and keeps a torn-down state from being woken by a later
    // subscriber count.
    s.subscribers = 0
    s.lastJson = undefined
    // `gone` is the provider being replaced or unregistered: whatever it last said belonged to
    // credentials that no longer exist, so the hub must not replay it.
    //
    // `idle` is simply the last widget going away, which happens on every dashboard reload. The
    // provider is still the same one and its last answer is still true, so the cache is kept and
    // the reloaded page paints at once instead of showing github, the calendar and the printer
    // blank for a network round trip.
    //
    // Except the clipboard, whose provider clears its history in `stop()`: keeping the last
    // snapshot would leave what was on the pasteboard on screen after the widget that was
    // allowed to show it has gone.
    if (reason === 'gone' || FORGET_WHEN_IDLE.has(s.provider.channel)) this.forget(s.provider.channel)
    if (!s.started) return
    s.started = false
    s.provider.stop?.()
  }

  private schedule(s: State, delayMs: number): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => { s.timer = null; void this.tick(s) }, delayMs)
  }

  private async tick(s: State): Promise<void> {
    if (!this.isCurrent(s) || s.subscribers === 0 || !s.provider.poll) return
    s.inFlight = true
    let data: unknown
    let threw = false
    try {
      data = await s.provider.poll()
      s.backoffMs = 0
    } catch (err) {
      threw = true
      data = { error: (err as Error).message ?? String(err) }
      s.backoffMs = Math.min(s.backoffMs === 0 ? (s.provider.intervalMs ?? MAX_BACKOFF_MS) : s.backoffMs * 2, MAX_BACKOFF_MS)
    } finally {
      s.inFlight = false
    }
    // Checked again after the await, not only before it: this is where the replacement happens.
    if (!this.isCurrent(s)) return
    const lastError = errorCode(data, threw)
    const changed = lastError !== s.lastError
    s.lastError = lastError
    if (changed) this.statusChanged()
    if (s.pollAgain) {
      // Computed under a privacy setting the user has changed since: never published. Forgotten
      // again in case the channel went idle meanwhile, so nothing is cached for the next widget.
      s.pollAgain = false
      s.lastJson = undefined
      this.forget(s.provider.channel)
      if (s.subscribers > 0) this.schedule(s, 0)
      return
    }
    const json = JSON.stringify(data)
    if (json !== s.lastJson) {
      s.lastJson = json
      this.publish(s.provider.channel, data)
    }
    const again = s.refreshAgain
    s.refreshAgain = false
    if (s.subscribers > 0) this.schedule(s, again ? 0 : s.backoffMs || s.provider.intervalMs || MAX_BACKOFF_MS)
  }
}
