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
}

export class ProviderRegistry {
  private states = new Map<string, State>()

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
    const previous = this.states.get(provider.channel)
    // Read before the teardown, which zeroes it: the widgets watching this channel did not go
    // away because the connection behind it was edited, so the replacement inherits them.
    const subscribers = previous?.subscribers ?? 0
    if (previous) this.teardown(previous, 'gone')
    const state: State = { provider, subscribers, started: false, timer: null, backoffMs: 0, lastJson: undefined, inFlight: false }
    this.states.set(provider.channel, state)
    if (state.subscribers > 0) this.activate(state)
  }

  /** Removes a channel entirely: used when a connection disappears from the config. */
  unregister(channel: string): void {
    const s = this.states.get(channel)
    if (!s) return
    this.teardown(s, 'gone')
    this.states.delete(channel)
  }

  channels(): string[] { return [...this.states.keys()] }

  has(channel: string): boolean { return this.states.has(channel) }

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
    try {
      data = await s.provider.poll()
      s.backoffMs = 0
    } catch (err) {
      data = { error: (err as Error).message ?? String(err) }
      s.backoffMs = Math.min(s.backoffMs === 0 ? (s.provider.intervalMs ?? MAX_BACKOFF_MS) : s.backoffMs * 2, MAX_BACKOFF_MS)
    } finally {
      s.inFlight = false
    }
    // Checked again after the await, not only before it: this is where the replacement happens.
    if (!this.isCurrent(s)) return
    const json = JSON.stringify(data)
    if (json !== s.lastJson) {
      s.lastJson = json
      this.publish(s.provider.channel, data)
    }
    if (s.subscribers > 0) this.schedule(s, s.backoffMs || s.provider.intervalMs || MAX_BACKOFF_MS)
  }
}
