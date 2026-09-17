import type { ProviderRegistry } from '../providers/registry.js'
import type { CommandContext } from '../providers/types.js'

export interface SocketLike {
  send(data: string): void
  on(event: 'message' | 'close', cb: (...args: any[]) => void): void
}

type Incoming =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'command'; id: string; channel: string; name: string; payload?: unknown }

export class Hub {
  private clients = new Map<SocketLike, Set<string>>()
  /** Where each socket came from, so a command can be refused on the provider's terms. */
  private contexts = new Map<SocketLike, CommandContext>()
  private lastValues = new Map<string, unknown>()

  constructor(private readonly registry: ProviderRegistry) {}

  /** A socket with no known origin is treated as remote: only the route can vouch for one. */
  attach(socket: SocketLike, ctx: CommandContext = { loopback: false }): void {
    const channels = new Set<string>()
    this.clients.set(socket, channels)
    this.contexts.set(socket, ctx)
    socket.on('message', (raw: Buffer | string) => this.onMessage(socket, channels, raw))
    socket.on('close', () => {
      for (const ch of channels) this.registry.removeSubscriber(ch)
      this.clients.delete(socket)
      this.contexts.delete(socket)
    })
  }

  /**
   * Drops a channel's cached last value.
   *
   * Called by the registry when a provider is torn down, replaced or unregistered: whatever that
   * channel last said belonged to a connection or a provider that is gone, and replaying it to
   * the next subscriber would show data from credentials that no longer exist. A widget that
   * subscribes after this waits for the first fresh poll instead, which the registry runs at once.
   */
  forget(channel: string): void {
    this.lastValues.delete(channel)
  }

  broadcast(channel: string, data: unknown): void {
    this.lastValues.set(channel, data)
    const msg = JSON.stringify({ type: 'data', channel, data })
    for (const [socket, channels] of this.clients) {
      if (channels.has(channel)) this.safeSend(socket, msg)
    }
  }

  private onMessage(socket: SocketLike, channels: Set<string>, raw: Buffer | string): void {
    let msg: Incoming
    try { msg = JSON.parse(raw.toString()) } catch {
      return this.safeSend(socket, JSON.stringify({ type: 'error', error: 'JSON invalide' }))
    }
    switch (msg?.type) {
      case 'subscribe': {
        if (typeof msg.channel !== 'string') break
        if (!channels.has(msg.channel)) {
          channels.add(msg.channel)
          this.registry.addSubscriber(msg.channel)
        }
        if (this.lastValues.has(msg.channel)) {
          this.safeSend(socket, JSON.stringify({ type: 'data', channel: msg.channel, data: this.lastValues.get(msg.channel) }))
        }
        return
      }
      case 'unsubscribe': {
        if (channels.delete(msg.channel)) this.registry.removeSubscriber(msg.channel)
        return
      }
      case 'command': {
        const { id, channel, name, payload } = msg
        const ctx = this.contexts.get(socket) ?? { loopback: false }
        this.registry.runCommand(channel, name, payload, ctx).then(
          (result) => this.safeSend(socket, JSON.stringify({ type: 'result', id, result: result ?? null })),
          (err: Error) => this.safeSend(socket, JSON.stringify({ type: 'error', id, error: err.message })),
        )
        return
      }
    }
    this.safeSend(socket, JSON.stringify({ type: 'error', error: 'message inconnu' }))
  }

  private safeSend(socket: SocketLike, data: string): void {
    try { socket.send(data) } catch { /* socket closed */ }
  }
}
