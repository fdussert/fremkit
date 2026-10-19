/**
 * What the hub knows about the client that sent a command.
 *
 * Handed to every command so a provider can refuse one that would act on the Mac itself; a
 * command invoked from inside the server (no socket) gets no context at all.
 */
export interface CommandContext {
  /** True when the socket that sent the command is on this machine. */
  loopback: boolean
  /** True when the socket belongs to a device paired with this Mac, reaching it over the LAN. */
  paired: boolean
  /** The paired device's id, when `paired` is true. */
  deviceId?: string
}

/**
 * Whether a command may act on the Mac: a local caller, or a paired device. A command that must
 * stay with whoever sits at the Mac (`claude.preview` plays a sound here) checks `loopback`
 * itself instead.
 */
export function isTrusted(ctx?: CommandContext): boolean {
  return ctx?.loopback === true || ctx?.paired === true
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
  /**
   * Set by a provider whose snapshot can carry the account's e-mail address (see `privacy.ts`).
   * Toggling `privacy.showAccountEmail` then polls it again at once, instead of leaving the old
   * answer on screen until its next tick. Requires `poll`: the registry refuses the flag on a
   * provider without one.
   */
  publishesAccountEmail?: boolean
}
export type Publish = (channel: string, data: unknown) => void
