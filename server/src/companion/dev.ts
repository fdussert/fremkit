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
import { FREMDEV_FEATURES, FREMDEV_MODULE, FREMDEV_OPEN_MODULE, FREMDEV_RELOAD_MODULE, FREMDEV_REPORT_MODULE, FREMDEV_SHOT_MODULE, FREMDEV_SHOTVIEW_MODULE, type DevTab, type ExtensionMessage, type ServerMessage } from './protocol.js'
import { silentShotSound, type ShotSound } from './shotSound.js'

export const COMPANION_DEV_CHANNEL = 'companion:dev'

/**
 * An install's rows are published at most once per this many ms (4 per second): the latest ones
 * are kept and published on the trailing edge. The extension sends at most one `dev.tabs` per
 * 500 ms, so this only bites a sender that floods.
 */
export const DEV_PUBLISH_MS = 250

/** How long a report is waited for before the command gives up. */
export const REPORT_TIMEOUT_MS = 5_000

/** How long the extension's word on an open-in-editor request is waited for. */
export const OPEN_TIMEOUT_MS = 5_000

/** At most this many asks (reports and the like) waited for per install: one more is refused rather than queued. */
export const MAX_PENDING_ASKS = 8

/** How long the Edge shows a shot on its tab's row (the thumbnail and "Copied"). */
export const SHOT_VIEW_MS = 3_000

/** The capture sound plays at most once per this many ms per install. */
export const SHOT_SOUND_MIN_MS = 1_000

/**
 * The most an install's rows may weigh, as JSON, with a shot's thumbnail on one of them: what the
 * extension holds its own `dev.tabs` to. The rows are never trimmed for a thumbnail; the thumbnail is
 * left out instead, and the row still says the shot was copied.
 */
export const DEV_INSTALL_MAX_BYTES = 60_000

/** A safety net only: every change is pushed through a refresh. */
export const COMPANION_DEV_INTERVAL_MS = 30_000

/** Fremdev runs only while the companion and its own switch are both on. */
export function fremdevEnabled(config: Pick<Config, 'labs'>): boolean {
  return config.labs?.companion === true && config.labs?.fremdev === true
}

/** A shot on its row, while the Edge shows it: the thumbnail (null when none came or it did not fit) and until when. */
export type DevShotView = { thumb: string | null; until: number }

/** A dev tab as the snapshot lists it: the extension's row, plus a shot while one shows. */
export type DevRow = DevTab & { shot?: DevShotView }

export type DevSnapshot = {
  /** `fremdevEnabled`: `labs.companion` and `labs.fremdev` both on; otherwise nothing is listed. */
  enabled: boolean
  /** Extension records, connected or not. */
  paired: number
  /**
   * `report`: the install can answer a report command (`fremdev.report` in its modules).
   * `features`: the modules of `FREMDEV_FEATURES` it listed, sorted: the Edge shows a control only
   * for an install that has its feature.
   *
   * Every install that announced Fremdev since this server started, whether or not the user
   * switched it on. `connected` false: its socket is closed (the extension closes it while no dev
   * tab is open, the normal idle state), it has no rows, and its `on` is the last it said.
   */
  installs: Array<{ deviceId: string; name: string; on: boolean; connected: boolean; report: boolean; features: string[]; tabs: DevRow[] }>
}

export interface CompanionDevOptions {
  now?: () => number
  send: (deviceId: string, msg: ServerMessage) => void
  changed: () => void
  enabled: () => boolean
  pairedCount: () => number
  /** The modules a control on the Edge depends on: `FREMDEV_FEATURES`, which a test may widen. */
  features?: readonly string[]
  /** The capture sound a `dev.shot` may ask for; silent unless given (index.ts gives afplay's). */
  sound?: ShotSound
}

export type DevMessage = Extract<ExtensionMessage, { type: 'modules' | 'dev.tabs' | 'ping' | 'dev.report' | 'dev.open.done' | 'dev.shot' }>

/** The messages that answer an ask, matched to it by their `id` and `tabId`. */
export type DevAnswerType = 'dev.report' | 'dev.open.done'
export type DevAnswer = Extract<DevMessage, { type: DevAnswerType }>

interface PendingAsk {
  tabId: number
  /** The module the ask needs: withdrawn by `modules`, the ask gives up. */
  feature: string
  /** The type of the message that answers it; another type with the same id is not its answer. */
  answer: DevAnswerType
  resolve: (msg: DevAnswer | null) => void
  timer: ReturnType<typeof setTimeout>
}

interface Install {
  name: string
  on: boolean
  /** `fremdev.report` in its modules: it answers `dev.report.ask`. */
  report: boolean
  /** Its modules that are in `FREMDEV_FEATURES`. */
  features: Set<string>
  connected: boolean
  tabs: DevTab[]
  /** The asks made of this install and not answered yet, by id. */
  pending: Map<string, PendingAsk>
  /** When this install's rows were last published. */
  publishedAt?: number
  /** The trailing publish of rows that came too soon after the last one. */
  timer: ReturnType<typeof setTimeout> | null
  /** The shot the Edge shows, until `SHOT_VIEW_MS` after it came; `timer` clears it. */
  shot: { tabId: number; thumb: string | null; until: number; timer: ReturnType<typeof setTimeout> } | null
  /** When the capture sound last played for this install. */
  soundAt: number
}

export class CompanionDev {
  private readonly now: () => number
  private readonly send: (deviceId: string, msg: ServerMessage) => void
  private readonly changed: () => void
  private readonly enabled: () => boolean
  private readonly pairedCount: () => number
  private readonly knownFeatures: readonly string[]
  private readonly sound: ShotSound
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
    this.knownFeatures = opts.features ?? FREMDEV_FEATURES
    this.sound = opts.sound ?? silentShotSound
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
      dropShot(known)
      // A new socket: the old one's answers will never come.
      abandon(known)
    }
    // A known install keeps its place in the list.
    this.installs.set(deviceId, {
      name,
      on: modules.includes(FREMDEV_MODULE),
      report: modules.includes(FREMDEV_REPORT_MODULE),
      features: featuresOf(modules, this.knownFeatures),
      connected: true,
      tabs: [],
      pending: new Map(),
      timer: null,
      shot: null,
      // The rate limit outlives the socket: a reconnect is no reason to play twice in a second.
      soundAt: known?.soundAt ?? -Infinity,
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
    dropShot(install)
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
      case 'dev.report':
      case 'dev.open.done':
        return answered(install, msg)
      case 'dev.shot':
        return this.shot(install, msg)
      case 'modules': {
        const on = msg.modules.includes(FREMDEV_MODULE)
        const report = msg.modules.includes(FREMDEV_REPORT_MODULE)
        const features = featuresOf(msg.modules, this.knownFeatures)
        if (on === install.on && report === install.report && sameSet(features, install.features)) return
        install.report = report
        install.features = features
        // Off: nothing asked will be answered. On: what needs a feature withdrawn will not either.
        if (!on) abandon(install)
        else abandonWhere(install, (p) => !holds(install, p.feature))
        if (!on || !holds(install, FREMDEV_SHOTVIEW_MODULE)) dropShot(install)
        if (on === install.on) return this.publish(install)
        install.on = on
        // Switched off, its rows are stale at once.
        if (!on) install.tabs = []
        return this.publish(install)
      }
      case 'dev.tabs':
        if (!install.on) return
        install.tabs = msg.tabs
        // A tab that left the list is closed or no longer a dev tab: its answers will not come.
        abandonWhere(install, (p) => !install.tabs.some((t) => t.tabId === p.tabId))
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
   * Reloads the tab. False, sending nothing, for an unknown install or tab (the rule of `focus`) or an
   * install that did not list `fremdev.reload`.
   */
  reload(deviceId: string, tabId: number, bypassCache: boolean): boolean {
    if (!this.reachableWith(deviceId, tabId, FREMDEV_RELOAD_MODULE)) return false
    this.send(deviceId, { type: 'dev.reload', tabId, bypassCache })
    return true
  }

  /**
   * Asks the install for the tab's bug report. Null for an unknown install or tab (the rule of
   * `focus`), an install that cannot report, too many asks already waiting, no answer within
   * `REPORT_TIMEOUT_MS`, or a socket that goes away first.
   */
  report(deviceId: string, tabId: number, stack: boolean): Promise<string | null> {
    return this.ask(deviceId, tabId, FREMDEV_REPORT_MODULE, 'dev.report', (id) => ({ type: 'dev.report.ask', id, tabId, stack }), REPORT_TIMEOUT_MS)
      .then((msg) => (msg?.type === 'dev.report' ? msg.text : null))
  }

  /**
   * Asks the install to open the entry's file in the editor, through the tab's dev server. False,
   * sending nothing, unless the install is reachable with `fremdev.open` and the tab's last reported
   * history holds an entry with that id (one that left the ring is not asked for); false too on no
   * answer within `OPEN_TIMEOUT_MS`. True means the dev server answered, not that an editor opened.
   */
  open(deviceId: string, tabId: number, entryId: number): Promise<boolean> {
    const tab = this.reachableWith(deviceId, tabId, FREMDEV_OPEN_MODULE)?.tabs.find((t) => t.tabId === tabId)
    if (!tab?.history.some((e) => e.id === entryId)) return Promise.resolve(false)
    return this.ask(deviceId, tabId, FREMDEV_OPEN_MODULE, 'dev.open.done', (id) => ({ type: 'dev.open.ask', id, tabId, entryId }), OPEN_TIMEOUT_MS)
      .then((msg) => msg?.type === 'dev.open.done' && msg.ok)
  }

  /**
   * Whether the install may put a screenshot on the clipboard (`POST /companion/dev/shot`): Fremdev
   * enabled, and the install connected, on, and listing `fremdev.shot`. No tab is named: the
   * extension captures the tab it has a row for, and the socket being open is what it checked.
   */
  canShot(deviceId: string): boolean {
    if (!this.enabled()) return false
    const install = this.installs.get(deviceId)
    return install !== undefined && install.on && install.connected && holds(install, FREMDEV_SHOT_MODULE)
  }

  /** `labs.companion` or `labs.fremdev` may have changed: the snapshot says so. */
  switched(): void {
    this.changed()
  }

  snapshot(): DevSnapshot {
    const enabled = this.enabled()
    return {
      enabled,
      paired: this.pairedCount(),
      installs: enabled
        ? [...this.installs].map(([deviceId, i]) => ({
            deviceId,
            name: i.name,
            on: i.on,
            connected: i.connected,
            report: i.report,
            features: [...i.features].sort(),
            tabs: rowsWithShot(i, this.now()),
          }))
        : [],
    }
  }

  /**
   * A shot of the tab reached the clipboard: shown on its row for `SHOT_VIEW_MS`, then cleared and
   * published again. Dropped, as if never sent, unless Fremdev is enabled and the install is on,
   * lists `fremdev.shotview` and reported that tab. A newer shot replaces the one showing. The sound
   * plays only when the message asks for it (the option is off by default in the extension), at
   * most once per `SHOT_SOUND_MIN_MS` per install.
   */
  private shot(install: Install, msg: Extract<DevMessage, { type: 'dev.shot' }>): void {
    if (!this.enabled() || !install.on || !holds(install, FREMDEV_SHOTVIEW_MODULE)) return
    if (!install.tabs.some((t) => t.tabId === msg.tabId)) return
    dropShot(install)
    const timer = setTimeout(() => {
      if (install.shot?.timer !== timer) return
      install.shot = null
      this.publish(install)
    }, SHOT_VIEW_MS)
    timer.unref?.()
    install.shot = { tabId: msg.tabId, thumb: msg.thumb, until: this.now() + SHOT_VIEW_MS, timer }
    if (msg.sound && this.now() - install.soundAt >= SHOT_SOUND_MIN_MS) {
      install.soundAt = this.now()
      this.sound.play()
    }
    this.publish(install)
  }

  /**
   * Sends the install the message `build` makes with a fresh id, and resolves with the `answer`
   * that comes back with that id for that tab. Null, at once, when the install is not reachable
   * (`reachableWith`: connected, Fremdev on, the tab reported, the feature listed) or already owes
   * `MAX_PENDING_ASKS`; null later when `timeoutMs` passes, the socket goes, the tab leaves its rows
   * or `modules` withdraws the feature. An answer with another id, tab or type is not this one's.
   */
  private ask(
    deviceId: string,
    tabId: number,
    feature: string,
    answer: DevAnswerType,
    build: (id: string) => ServerMessage,
    timeoutMs: number,
  ): Promise<DevAnswer | null> {
    const install = this.reachableWith(deviceId, tabId, feature)
    if (!install || install.pending.size >= MAX_PENDING_ASKS) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        install.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      install.pending.set(id, { tabId, feature, answer, resolve, timer })
      this.send(deviceId, build(id))
    })
  }

  private relay(deviceId: string, msg: Extract<ServerMessage, { type: 'dev.focus' | 'dev.clear' }>): boolean {
    if (!this.reachable(deviceId, msg.tabId)) return false
    this.send(deviceId, msg)
    return true
  }

  /** The install, when it is connected, has Fremdev on and reported that tab; `fremdevEnabled` true. */
  private reachable(deviceId: string, tabId: number): Install | null {
    if (!this.enabled()) return null
    const install = this.installs.get(deviceId)
    if (!install?.on || !install.connected || !install.tabs.some((t) => t.tabId === tabId)) return null
    return install
  }

  /** `reachable`, and the install listed `feature` (`fremdev.report` counts as the report's). */
  private reachableWith(deviceId: string, tabId: number, feature: string): Install | null {
    const install = this.reachable(deviceId, tabId)
    return install && holds(install, feature) ? install : null
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
    dropShot(install)
    abandon(install)
    this.installs.delete(deviceId)
    return true
  }
}

/** Forgets the shot showing, and its timer. */
function dropShot(install: Install): void {
  if (install.shot === null) return
  clearTimeout(install.shot.timer)
  install.shot = null
}

/**
 * The install's rows, the shot's on its tab while it shows. Its thumbnail is left out when the rows
 * as they would be published, the shot included, weigh more than `DEV_INSTALL_MAX_BYTES`: the rows
 * are never what gives way.
 */
function rowsWithShot(install: Install, now: number): DevRow[] {
  const shot = install.shot
  if (shot === null || shot.until <= now || !install.tabs.some((t) => t.tabId === shot.tabId)) return install.tabs
  const withView = (thumb: string | null): DevRow[] =>
    install.tabs.map((t) => (t.tabId === shot.tabId ? { ...t, shot: { thumb, until: shot.until } } : t))
  if (shot.thumb !== null) {
    const rows = withView(shot.thumb)
    if (Buffer.byteLength(JSON.stringify(rows), 'utf8') <= DEV_INSTALL_MAX_BYTES) return rows
  }
  return withView(null)
}

/** The modules of `known` (`FREMDEV_FEATURES`) in a list: an unknown `fremdev.*` name is not one. */
function featuresOf(modules: readonly string[], known: readonly string[]): Set<string> {
  return new Set(modules.filter((m) => known.includes(m)))
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))

/** Whether the install listed `feature`; the report's own module is its `report` flag. */
function holds(install: Install, feature: string): boolean {
  return feature === FREMDEV_REPORT_MODULE ? install.report : install.features.has(feature)
}

/**
 * Resolves the ask `msg` answers, and forgets it. Only the install asked, for the tab asked, with
 * the answer asked for: another browser's tab 7 is not this one, and an unknown id is nothing.
 */
function answered(install: Install, msg: DevAnswer): void {
  const pending = install.pending.get(msg.id)
  if (!pending || pending.tabId !== msg.tabId || pending.answer !== msg.type) return
  install.pending.delete(msg.id)
  clearTimeout(pending.timer)
  pending.resolve(msg)
}

/** Resolves to null, and forgets, the asks `gone` picks. */
function abandonWhere(install: Install, gone: (pending: PendingAsk) => boolean): void {
  for (const [id, pending] of install.pending) {
    if (!gone(pending)) continue
    clearTimeout(pending.timer)
    install.pending.delete(id)
    pending.resolve(null)
  }
}

/** Resolves every ask the install still owes with null, and forgets them. */
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

const ReloadCommandSchema = DevCommandSchema.extend({ bypassCache: z.boolean() })

const OpenCommandSchema = DevCommandSchema.extend({ entryId: z.number().int().min(1).max(2_147_483_647) })

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
      if (!dev.snapshot().enabled) return failed('companion.devDisabled')
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
        if (!dev.snapshot().enabled) return failed('companion.devDisabled')
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
      /** Reloads the tab, with or without the browser's cache. */
      async reload(payload: unknown, ctx?: CommandContext): Promise<Result> {
        guard(ctx)
        const { deviceId, tabId, bypassCache } = parse(payload, ReloadCommandSchema)
        if (!dev.snapshot().enabled) return failed('companion.devDisabled')
        return dev.reload(deviceId, tabId, bypassCache) ? { ok: true } : failed('companion.devUnknownTab')
      },
      /** Asks the browser to open the entry's file in the editor, through the tab's dev server. */
      async open(payload: unknown, ctx?: CommandContext): Promise<Result> {
        guard(ctx)
        const { deviceId, tabId, entryId } = parse(payload, OpenCommandSchema)
        if (!dev.snapshot().enabled) return failed('companion.devDisabled')
        return (await dev.open(deviceId, tabId, entryId)) ? { ok: true } : failed('companion.devOpenFailed')
      },
    },
  }
}
