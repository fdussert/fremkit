/**
 * What the hub knows about the client that sent a command.
 *
 * Handed to every command so a provider can refuse one that would act on the Mac itself; a
 * command invoked from inside the server (no socket) gets no context at all.
 */
export interface CommandContext {
  /** True when the socket that sent the command is on this machine. */
  loopback: boolean
}

export interface Provider<T = unknown> {
  channel: string
  /**
   * Polling period. A provider whose data arrives by push sets a slow period and a cheap poll;
   * a command-only provider declares neither `intervalMs` nor `poll` and is never put on a clock.
   */
  intervalMs?: number
  poll?(): Promise<T>
  /** Called when the channel gains its first subscriber: open sockets, start clocks, here. */
  start?(): void
  /** Called when the last subscriber leaves, and when the provider is unregistered. */
  stop?(): void
  commands?: Record<string, (payload: unknown, ctx?: CommandContext) => Promise<unknown>>
}
export type Publish = (channel: string, data: unknown) => void
