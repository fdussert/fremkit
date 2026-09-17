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
    if (previous) this.teardown(previous)
    const state: State = { provider, subscribers: previous?.subscribers ?? 0, started: false, timer: null, backoffMs: 0, lastJson: undefined, inFlight: false }
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
    const cmd = s.provider.commands?.[name]
    if (!cmd) throw new Error(`commande inconnue: ${channel}.${name}`)
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
   * No more subscribers (or the channel is going away): stop the clock and the provider. `stop()`
   * only runs after a matching `start()`, and only once — a provider should still make both
   * idempotent, since nothing stops a second registry from holding the same object.
   */
  private teardown(s: State): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (!s.started) return
    s.started = false
    s.provider.stop?.()
  }

  private schedule(s: State, delayMs: number): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => { s.timer = null; void this.tick(s) }, delayMs)
  }

  private async tick(s: State): Promise<void> {
    if (s.subscribers === 0 || !s.provider.poll) return
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
    const json = JSON.stringify(data)
    if (json !== s.lastJson) {
      s.lastJson = json
      this.publish(s.provider.channel, data)
    }
    if (s.subscribers > 0) this.schedule(s, s.backoffMs || s.provider.intervalMs || MAX_BACKOFF_MS)
  }
}
