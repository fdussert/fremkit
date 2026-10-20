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

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { INSTANCE_ID_MAX, type Config } from '../config/schema.js'
import { tr, type MessageKey } from '../i18n.js'
import { pbPasteboard, type Pasteboard } from '../providers/clipboard.js'
import type { CommandContext, Provider } from '../providers/types.js'
import { FREMDEV_MODULE, FREMDEV_REPORT_MODULE, type DevTab, type ExtensionMessage, type ServerMessage } from './protocol.js'

export const COMPANION_DEV_CHANNEL = 'companion:dev'

/**
 * An install's rows are published at most once per this many ms (4 per second): the latest ones
 * are kept and published on the trailing edge. The extension sends at most one `dev.tabs` per
 * 500 ms, so this only bites a sender that floods.
 */
export const DEV_PUBLISH_MS = 250

/** How long a report is waited for before the command gives up. */
export const REPORT_TIMEOUT_MS = 5_000

/** At most this many reports waited for per install: one more is refused rather than queued. */
export const MAX_PENDING_REPORTS = 8

/** A safety net only: every change is pushed through a refresh. */
export const COMPANION_DEV_INTERVAL_MS = 30_000

export type DevSnapshot = {
  /** `labs.companion`: off, nothing is listed. */
  enabled: boolean
  /** Extension records, connected or not. */
  paired: number
  /**
   * `report`: the install can answer a report command (`fremdev.report` in its modules).
   *
   * Every install that announced Fremdev since this server started, whether or not the user
   * switched it on. `connected` false: its socket is closed (the extension closes it while no dev
   * tab is open, the normal idle state), it has no rows, and its `on` is the last it said.
   */
  installs: Array<{ deviceId: string; name: string; on: boolean; connected: boolean; report: boolean; tabs: DevTab[] }>
}

export interface CompanionDevOptions {
  now?: () => number
  send: (deviceId: string, msg: ServerMessage) => void
  changed: () => void
  enabled: () => boolean
  pairedCount: () => number
}

export type DevMessage = Extract<ExtensionMessage, { type: 'modules' | 'dev.tabs' | 'ping' | 'dev.report' }>

interface PendingReport {
  tabId: number
  resolve: (text: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

interface Install {
  name: string
  on: boolean
  /** `fremdev.report` in its modules: it answers `dev.report.ask`. */
  report: boolean
  connected: boolean
  tabs: DevTab[]
  /** The reports asked of this install and not answered yet, by id. */
  pending: Map<string, PendingReport>
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
    if (known) {
      if (known.timer) clearTimeout(known.timer)
      // A new socket: the old one's reports will never come.
      abandon(known)
    }
    // A known install keeps its place in the list.
    this.installs.set(deviceId, {
      name,
      on: modules.includes(FREMDEV_MODULE),
      report: modules.includes(FREMDEV_REPORT_MODULE),
      connected: true,
      tabs: [],
      pending: new Map(),
      timer: null,
    })
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
    // Nobody is left to answer: the commands waiting give up now rather than at their timeout.
    abandon(install)
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
      case 'dev.report': {
        const pending = install.pending.get(msg.id)
        // Only the install asked, for the tab asked: another browser's tab 7 is not this one.
        if (!pending || pending.tabId !== msg.tabId) return
        install.pending.delete(msg.id)
        clearTimeout(pending.timer)
        return pending.resolve(msg.text)
      }
      case 'modules': {
        const on = msg.modules.includes(FREMDEV_MODULE)
        const report = msg.modules.includes(FREMDEV_REPORT_MODULE)
        if (on === install.on && report === install.report) return
        install.report = report
        if (!report) abandon(install)
        if (on === install.on) return this.publish(install)
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

  /** Marks the tab's open errors and requests seen (they stay open). Same rule as `focus`. */
  clear(deviceId: string, tabId: number): boolean {
    return this.relay(deviceId, { type: 'dev.clear', tabId })
  }

  /**
   * Asks the install for the tab's bug report. Null for an unknown install or tab (the rule of
   * `focus`), an install that cannot report, too many asks already waiting, no answer within
   * `REPORT_TIMEOUT_MS`, or a socket that goes away first.
   */
  report(deviceId: string, tabId: number, stack: boolean): Promise<string | null> {
    const install = this.reachable(deviceId, tabId)
    if (!install?.report || install.pending.size >= MAX_PENDING_REPORTS) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        install.pending.delete(id)
        resolve(null)
      }, REPORT_TIMEOUT_MS)
      timer.unref?.()
      install.pending.set(id, { tabId, resolve, timer })
      this.send(deviceId, { type: 'dev.report.ask', id, tabId, stack })
    })
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
        ? [...this.installs].map(([deviceId, i]) => ({ deviceId, name: i.name, on: i.on, connected: i.connected, report: i.report, tabs: i.tabs }))
        : [],
    }
  }

  private relay(deviceId: string, msg: Extract<ServerMessage, { type: 'dev.focus' | 'dev.clear' }>): boolean {
    if (!this.reachable(deviceId, msg.tabId)) return false
    this.send(deviceId, msg)
    return true
  }

  /** The install, when it is connected, has Fremdev on and reported that tab; `labs.companion` on. */
  private reachable(deviceId: string, tabId: number): Install | null {
    if (!this.enabled()) return null
    const install = this.installs.get(deviceId)
    if (!install?.on || !install.connected || !install.tabs.some((t) => t.tabId === tabId)) return null
    return install
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
    abandon(install)
    this.installs.delete(deviceId)
    return true
  }
}

/** Resolves every report the install still owes with null, and forgets them. */
function abandon(install: Install): void {
  for (const pending of install.pending.values()) {
    clearTimeout(pending.timer)
    pending.resolve(null)
  }
  install.pending.clear()
}

const DevCommandSchema = z.strictObject({
  deviceId: z.uuid(),
  tabId: z.number().int().min(0).max(2_147_483_647),
  // The host stamps it on every widget command; required here like on `companion`.
  instanceId: z.string().min(1).max(INSTANCE_ID_MAX),
})

const ReportCommandSchema = DevCommandSchema.extend({ stack: z.boolean() })

type Result = { ok: true } | { ok: false; error: string }

export interface DevProviderOptions {
  dev: CompanionDev
  config: () => Config
  /** Where a report is copied; the Mac's own pasteboard (`pbcopy`, on stdin) by default. */
  pasteboard?: Pasteboard
}

/**
 * The `companion:dev` channel. Its commands act in a browser on this Mac and are this Mac's only,
 * like Fremplay's: a paired iPad neither sees nor drives the dev tabs.
 */
export function createDevProvider(opts: DevProviderOptions): Provider<DevSnapshot> {
  const { dev } = opts
  const pasteboard = opts.pasteboard ?? pbPasteboard
  const locale = () => opts.config().locale

  function parse<S extends z.ZodType>(payload: unknown, schema: S): z.infer<S> {
    const parsed = schema.safeParse(payload)
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
      const { deviceId, tabId } = parse(payload, DevCommandSchema)
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
      /** Asks the browser for the tab's bug report and copies it to this Mac's clipboard. */
      async report(payload: unknown, ctx?: CommandContext): Promise<Result> {
        guard(ctx)
        const { deviceId, tabId, stack } = parse(payload, ReportCommandSchema)
        if (!dev.snapshot().enabled) return failed('companion.disabled')
        const text = await dev.report(deviceId, tabId, stack)
        if (text === null) return failed('companion.devReportFailed')
        try {
          await pasteboard.write(text)
        } catch {
          // pbcopy's message says nothing the user can act on, and the report is not repeated.
          return failed('companion.devReportFailed')
        }
        return { ok: true }
      },
    },
  }
}
