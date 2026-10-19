/**
 * Fremdev, the extension's second module: each connected browser reports its dev tabs (errors,
 * failed requests, whether the dev server answers), and the dashboard shows them on the
 * `companion:dev` channel.
 *
 * Its own channel, not part of `companion`: Fremplay's widget replans at every snapshot of that
 * one, and dev rows change far more often than a share does. Same family, so what keeps
 * `companion` from paired devices and registry widgets keeps this too.
 *
 * Pure like the session: it speaks through `send` and `changed`, and the session hands it the
 * messages of the sockets it already authenticated.
 */

import { z } from 'zod'
import { INSTANCE_ID_MAX, type Config } from '../config/schema.js'
import { tr, type MessageKey } from '../i18n.js'
import type { CommandContext, Provider } from '../providers/types.js'
import { FREMDEV_MODULE, type DevTab, type ExtensionMessage, type ServerMessage } from './protocol.js'

export const COMPANION_DEV_CHANNEL = 'companion:dev'

/**
 * An install's rows are published at most once per this many ms (4 per second): the latest ones
 * are kept and published on the trailing edge. The extension sends at most one `dev.tabs` per
 * 500 ms, so this only bites a sender that floods.
 */
export const DEV_PUBLISH_MS = 250

/** A safety net only: every change is pushed through a refresh. */
export const COMPANION_DEV_INTERVAL_MS = 30_000

export type DevSnapshot = {
  /** `labs.companion`: off, nothing is listed. */
  enabled: boolean
  /** Extension records, connected or not. */
  paired: number
  /**
   * Every install that announced Fremdev since this server started, whether or not the user
   * switched it on. `connected` false: its socket is closed (the extension closes it while no dev
   * tab is open, the normal idle state), it has no rows, and its `on` is the last it said.
   */
  installs: Array<{ deviceId: string; name: string; on: boolean; connected: boolean; tabs: DevTab[] }>
}

export interface CompanionDevOptions {
  now?: () => number
  send: (deviceId: string, msg: ServerMessage) => void
  changed: () => void
  enabled: () => boolean
  pairedCount: () => number
}

export type DevMessage = Extract<ExtensionMessage, { type: 'modules' | 'dev.tabs' | 'ping' }>

interface Install {
  name: string
  on: boolean
  connected: boolean
  tabs: DevTab[]
  /** When this install's rows were last published. */
  publishedAt?: number
  /** The trailing publish of rows that came too soon after the last one. */
  timer: ReturnType<typeof setTimeout> | null
}

export class CompanionDev {
  private readonly now: () => number
  private readonly send: (deviceId: string, msg: ServerMessage) => void
  private readonly changed: () => void
  private readonly enabled: () => boolean
  private readonly pairedCount: () => number
  /**
   * The Fremdev-capable installs heard since this server started, connected or not, in the order
   * they first said hello. Forgotten only when their device is removed (`forget`, `prune`).
   */
  private readonly installs = new Map<string, Install>()

  constructor(opts: CompanionDevOptions) {
    this.now = opts.now ?? Date.now
    this.send = opts.send
    this.changed = opts.changed
    this.enabled = opts.enabled
    this.pairedCount = opts.pairedCount
  }

  /**
   * An install said hello. `modules` undefined is an extension older than Fremdev (or one whose
   * list this server cannot read): it is not listed, and whatever dev message it sends is ignored.
   */
  connect(deviceId: string, name: string, modules: string[] | undefined): void {
    if (modules === undefined) {
      if (this.drop(deviceId)) this.changed()
      return
    }
    const known = this.installs.get(deviceId)
    if (known?.timer) clearTimeout(known.timer)
    // A known install keeps its place in the list.
    this.installs.set(deviceId, { name, on: modules.includes(FREMDEV_MODULE), connected: true, tabs: [], timer: null })
    this.changed()
  }

  /**
   * The socket went away: the install stays listed, disconnected and with no rows. The extension
   * closes its socket while no dev tab is open, so this is its ordinary idle state, not an outage.
   */
  disconnect(deviceId: string): void {
    const install = this.installs.get(deviceId)
    if (!install?.connected) return
    if (install.timer !== null) clearTimeout(install.timer)
    install.timer = null
    install.connected = false
    install.tabs = []
    this.changed()
  }

  /** The device was removed (or replaced by a socket that cannot speak Fremdev): no longer listed. */
  forget(deviceId: string): void {
    if (this.drop(deviceId)) this.changed()
  }

  /** Forgets every install whose device is no longer paired. */
  prune(isPaired: (deviceId: string) => boolean): void {
    let dropped = false
    for (const id of [...this.installs.keys()]) if (!isPaired(id) && this.drop(id)) dropped = true
    if (dropped) this.changed()
  }

  onMessage(deviceId: string, msg: DevMessage): void {
    const install = this.installs.get(deviceId)
    if (!install?.connected) return
    switch (msg.type) {
      case 'ping':
        // Only proves the socket alive; nothing to answer.
        return
      case 'modules': {
        const on = msg.modules.includes(FREMDEV_MODULE)
        if (on === install.on) return
        install.on = on
        // Switched off, its rows are stale at once.
        if (!on) install.tabs = []
        return this.publish(install)
      }
      case 'dev.tabs':
        if (!install.on) return
        install.tabs = msg.tabs
        return this.publish(install)
    }
  }

  /** Brings the tab forward in its browser. False unless the install is connected and reported that tab. */
  focus(deviceId: string, tabId: number): boolean {
    return this.relay(deviceId, { type: 'dev.focus', tabId })
  }

  /** Dismisses the tab's open errors and requests. Same rule as `focus`. */
  clear(deviceId: string, tabId: number): boolean {
    return this.relay(deviceId, { type: 'dev.clear', tabId })
  }

  /** `labs.companion` may have changed: the snapshot says so. */
  switched(): void {
    this.changed()
  }

  snapshot(): DevSnapshot {
    const enabled = this.enabled()
    return {
      enabled,
      paired: this.pairedCount(),
      installs: enabled
        ? [...this.installs].map(([deviceId, i]) => ({ deviceId, name: i.name, on: i.on, connected: i.connected, tabs: i.tabs }))
        : [],
    }
  }

  private relay(deviceId: string, msg: Extract<ServerMessage, { type: 'dev.focus' | 'dev.clear' }>): boolean {
    if (!this.enabled()) return false
    const install = this.installs.get(deviceId)
    if (!install?.on || !install.connected || !install.tabs.some((t) => t.tabId === msg.tabId)) return false
    this.send(deviceId, msg)
    return true
  }

  /** Publishes now, or on the trailing edge of `DEV_PUBLISH_MS` for this install. */
  private publish(install: Install): void {
    // Already due: that publish reads the install's rows when it fires, so it carries these.
    if (install.timer !== null) return
    const wait = (install.publishedAt ?? -Infinity) + DEV_PUBLISH_MS - this.now()
    if (wait <= 0) {
      install.publishedAt = this.now()
      return this.changed()
    }
    install.timer = setTimeout(() => {
      install.timer = null
      install.publishedAt = this.now()
      this.changed()
    }, wait)
    install.timer.unref?.()
  }

  private drop(deviceId: string): boolean {
    const install = this.installs.get(deviceId)
    if (!install) return false
    if (install.timer !== null) clearTimeout(install.timer)
    this.installs.delete(deviceId)
    return true
  }
}

const DevCommandSchema = z.strictObject({
  deviceId: z.uuid(),
  tabId: z.number().int().min(0).max(2_147_483_647),
  // The host stamps it on every widget command; required here like on `companion`.
  instanceId: z.string().min(1).max(INSTANCE_ID_MAX),
})

type Result = { ok: true } | { ok: false; error: string }

export interface DevProviderOptions {
  dev: CompanionDev
  config: () => Config
}

/**
 * The `companion:dev` channel. Its commands act in a browser on this Mac and are this Mac's only,
 * like Fremplay's: a paired iPad neither sees nor drives the dev tabs.
 */
export function createDevProvider(opts: DevProviderOptions): Provider<DevSnapshot> {
  const { dev } = opts
  const locale = () => opts.config().locale

  function parse(payload: unknown): z.infer<typeof DevCommandSchema> {
    const parsed = DevCommandSchema.safeParse(payload)
    if (!parsed.success) throw new Error(tr(locale(), 'provider.invalidPayload'))
    return parsed.data
  }

  /** Fails closed: no context, or a paired device, is not this Mac. */
  function guard(ctx: CommandContext | undefined): void {
    if (ctx?.loopback !== true) throw new Error(tr(locale(), 'provider.localOnly'))
  }

  function run(act: (deviceId: string, tabId: number) => boolean) {
    return async (payload: unknown, ctx?: CommandContext): Promise<Result> => {
      guard(ctx)
      const { deviceId, tabId } = parse(payload)
      if (!dev.snapshot().enabled) return failed('companion.disabled')
      return act(deviceId, tabId) ? { ok: true } : failed('companion.devUnknownTab')
    }
  }

  const failed = (key: MessageKey): Result => ({ ok: false, error: tr(locale(), key) })

  return {
    channel: COMPANION_DEV_CHANNEL,
    intervalMs: COMPANION_DEV_INTERVAL_MS,
    async poll() {
      return dev.snapshot()
    },
    commands: {
      focus: run((deviceId, tabId) => dev.focus(deviceId, tabId)),
      clear: run((deviceId, tabId) => dev.clear(deviceId, tabId)),
    },
  }
}
