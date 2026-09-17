import type { CommandContext, Provider, Publish } from './types.js'

const MAX_BACKOFF_MS = 60_000

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

  constructor(private readonly publish: Publish) {}

  register(provider: Provider): void {
    const previous = this.states.get(provider.channel)
    // Read before the teardown, which zeroes it: the widgets watching this channel did not go
    // away because the connection behind it was edited, so the replacement inherits them.
    const subscribers = previous?.subscribers ?? 0
    if (previous) this.teardown(previous)
    const state: State = { provider, subscribers, started: false, timer: null, backoffMs: 0, lastJson: undefined, inFlight: false }
    this.states.set(provider.channel, state)
    if (state.subscribers > 0) this.activate(state)
  }

  /** Removes a channel entirely: used when a connection disappears from the config. */
  unregister(channel: string): void {
    const s = this.states.get(channel)
    if (!s) return
    this.teardown(s)
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
    if (s.subscribers === 0) this.teardown(s)
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
      this.teardown(s)
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
  private teardown(s: State): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    // An in-flight poll is not a timer: zeroing this stops the orphan rescheduling itself even
    // before `isCurrent` gets a say, and keeps a torn-down state from being woken by a later
    // subscriber count.
    s.subscribers = 0
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
