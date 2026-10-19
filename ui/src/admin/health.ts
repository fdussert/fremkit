/**
 * Widget health: what is wrong with each widget of the dashboard, and where it is fixed.
 *
 * Without it a widget whose data source fails is only ever seen on the Edge, as a tile that says
 * "Loading…" or an error, and the editor gives no hint of which tile, why, or which panel to
 * open. Everything here is computed from what the editor already holds — the config, the
 * catalogue, the connections, the registry's index — plus one thing it does not: how each
 * provider's last poll went, which the server publishes on `config:health`
 * (`server/src/providers/health.ts`) as error *codes*, never messages.
 *
 * `computeHealth` is a pure function of those inputs so it can be tested without a server; the
 * wording is `describeProblem` and `actionLabel`, read at render time in the editor's language.
 */
import { pick, t } from '../shared/i18n'
import type { Config, ConnectionSummary, ConnectionTypeInfo, Page, Screen, SettingField, Widget, WidgetManifest } from '../shared/types'
import { channelAllowed, navItemsOf } from '../shared/types'

/**
 * `update` is news, not a problem: a newer version waits in the registry and the widget works.
 * It sits below `warning`, and nothing that means "something is wrong" counts it — the top bar's
 * count, the page and screen dots, the menus' fix. The Sietch button counts updates.
 */
export type HealthLevel = 'ok' | 'update' | 'warning' | 'error'

/** The one button a problem offers. The editor runs it (`runHealthAction`); this only names it. */
export type HealthAction =
  /** Open the Connections dialog on this connection. */
  | { kind: 'connection'; id: string }
  /** Open the Connections dialog on a new connection of this type: none exists yet. */
  | { kind: 'newConnection'; type: string }
  /** Select the widget and open its settings on this field. */
  | { kind: 'settings'; field: string }
  /** Install the widget from the registry. */
  | { kind: 'install'; widgetId: string }
  /** Update the widget from the registry. */
  | { kind: 'update'; widgetId: string }
  /** Read the widget folders again: the files may be back. */
  | { kind: 'rescan' }
  /** Reload the widget's frame. */
  | { kind: 'reload' }
  /** Open the Screen panel, where what Fremkit may read on this Mac is turned on. */
  | { kind: 'screen' }

/**
 * Why a widget is not well. `code` picks the sentence; `detail` is what the sentence names — a
 * connection's or a field's label, never a value read from a setting, a secret or an account.
 */
export interface HealthProblem {
  level: 'warning' | 'error'
  code: ProblemCode
  /** The provider's own error code, for `failing`: what the server said, already reduced. */
  error?: string
  /** A connection's name or a setting's label, when the sentence names one. */
  detail?: string
  action: HealthAction | null
}

export type ProblemCode =
  | 'missing'
  | 'connectionGone'
  | 'connectionIncomplete'
  | 'connectionUnset'
  | 'offline'
  | 'unauthorized'
  | 'unconfigured'
  | 'rateLimited'
  | 'unavailable'
  | 'invalid'
  | 'failing'

/** A newer version of the widget in the registry. */
export interface HealthUpdate {
  widgetId: string
  /** The registry's version, when the index says it. */
  version: string | null
}

export interface InstanceHealth {
  /** The worst problem's level; `update` when an update is all there is to say. */
  level: HealthLevel
  /** Worst first; the first one is the badge's reason and the banner's. Never an update. */
  problems: HealthProblem[]
  update: HealthUpdate | null
}

/** A registry entry, as far as health needs one. */
export interface MarketEntry {
  id: string
  updateAvailable: boolean
  /** The registry's version of it. */
  version?: string
  /** It could be installed here: not installed, not too new, not a built-in's id. */
  installable: boolean
}

export interface HealthInput {
  config: Config
  manifests: Record<string, WidgetManifest>
  /** `null` until the connections are loaded: nothing is said about them before that. */
  connections: ConnectionSummary[] | null
  connectionTypes: ConnectionTypeInfo[]
  /** `config:health`: each polled channel's last outcome, `null` when it was clean. */
  channels: Record<string, string | null>
  market: MarketEntry[]
}

export const HEALTHY: InstanceHealth = Object.freeze({ level: 'ok', problems: [], update: null }) as InstanceHealth

/** What a provider's error code means to somebody looking at the editor. */
const ERROR_CODES: Record<string, { code: ProblemCode; level: 'warning' | 'error' }> = {
  offline: { code: 'offline', level: 'warning' },
  'rate-limited': { code: 'rateLimited', level: 'warning' },
  unavailable: { code: 'unavailable', level: 'warning' },
  // Claude Code is not signed in on this Mac (`claude-account`): nothing the editor can fix.
  'no-token': { code: 'unavailable', level: 'warning' },
  unauthorized: { code: 'unauthorized', level: 'error' },
  unconfigured: { code: 'unconfigured', level: 'error' },
  invalid: { code: 'invalid', level: 'error' },
}

/**
 * Codes that are a choice, not a failure: `disabled` is a provider whose reading the user has not
 * turned on (the Claude account usage, off by default). A widget built to do without it is well.
 */
const NOT_A_PROBLEM = new Set(['disabled'])

/** Sort order within a level: what blocks the widget entirely comes before what degrades it. */
const ORDER: ProblemCode[] = [
  'missing', 'connectionGone', 'connectionIncomplete', 'unauthorized', 'unconfigured', 'invalid', 'failing',
  'connectionUnset', 'offline', 'rateLimited', 'unavailable',
]

const rank = (p: HealthProblem): number => (p.level === 'error' ? 0 : 100) + ORDER.indexOf(p.code)

const SEVERITY: Record<HealthLevel, number> = { ok: 0, update: 1, warning: 2, error: 3 }

/** The worst of some levels: error > warning > update > ok. */
export function worst(levels: Iterable<HealthLevel>): HealthLevel {
  let out: HealthLevel = 'ok'
  for (const l of levels) if (SEVERITY[l] > SEVERITY[out]) out = l
  return out
}

/** A level as far as "something is wrong" goes: an update is not. */
export const problemLevel = (l: HealthLevel): HealthLevel => (l === 'update' ? 'ok' : l)

/** A setting's value as the widget reads it: its own, else the manifest's default. */
function valueOf(widget: Widget, key: string, field: SettingField): unknown {
  return widget.settings[key] ?? field.default
}

function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v !== '')
  return typeof value === 'string' && value !== '' ? [value] : []
}


/** A connection a required field or secret of which is empty, by its type's form. */
function incomplete(conn: ConnectionSummary, type: ConnectionTypeInfo | undefined): boolean {
  if (!type) return false
  return type.fields.some((f) => f.required && (f.secret ? !conn.secrets[f.key] : !(conn.fields[f.key] ?? '').trim()))
}

/** The problem a channel's last poll is, or none for a clean one. */
function channelProblem(error: string | null | undefined, action: HealthAction, viaConnection: boolean): HealthProblem | null {
  if (error === null || error === undefined || NOT_A_PROBLEM.has(error)) return null
  const known = ERROR_CODES[error]
  if (!known) return { level: 'error', code: 'failing', error, action }
  // A provider of this Mac's own (Codex, say) is unconfigured while what it reads is not turned
  // on in the Screen panel: something to do, not something broken. A connection's is broken.
  if (known.code === 'unconfigured' && !viaConnection) return { level: 'warning', code: 'unconfigured', action }
  return { level: known.level, code: known.code, action }
}

/** One widget's health. */
export function widgetHealth(widget: Widget, input: HealthInput): InstanceHealth {
  const problems: HealthProblem[] = []
  const manifest = input.manifests[widget.widgetId]
  const market = input.market.find((m) => m.id === widget.widgetId)

  if (!manifest) {
    problems.push({
      level: 'error', code: 'missing',
      action: market?.installable ? { kind: 'install', widgetId: widget.widgetId } : { kind: 'rescan' },
    })
    return { level: 'error', problems, update: null }
  }

  // Connections the settings point at, and the channels they publish on.
  const referenced = new Set<string>()
  for (const [key, field] of Object.entries(manifest.settingsSchema ?? {}) as [string, SettingField][]) {
    if (field.type !== 'connection' && field.type !== 'connections') continue
    const chosen = ids(valueOf(widget, key, field))
    const label = pick(field.label)
    if (chosen.length === 0) {
      // A widget whose connection is empty can only say "nothing to show". When none of that
      // type exists the fix is to create one, not to open a drop-down that offers nothing.
      const exists = input.connections?.some((c) => c.type === field.connectionType) ?? true
      problems.push({
        level: 'warning', code: 'connectionUnset', detail: label,
        action: !exists && field.connectionType ? { kind: 'newConnection', type: field.connectionType } : { kind: 'settings', field: key },
      })
      continue
    }
    for (const id of chosen) {
      referenced.add(id)
      if (!input.connections) continue
      const conn = input.connections.find((c) => c.id === id)
      if (!conn) {
        problems.push({ level: 'error', code: 'connectionGone', detail: label, action: { kind: 'settings', field: key } })
        continue
      }
      if (incomplete(conn, input.connectionTypes.find((x) => x.id === conn.type))) {
        problems.push({ level: 'error', code: 'connectionIncomplete', detail: conn.name || conn.id, action: { kind: 'connection', id } })
      }
    }
  }

  // The channels the widget reads: its literal subscriptions, and the per-connection channels of
  // its `family:*` ones whose connection its settings name. A channel never polled says nothing.
  const seen = new Set<string>()
  for (const [channel, error] of Object.entries(input.channels)) {
    if (!channelAllowed(manifest.subscriptions ?? [], channel)) continue
    const literal = (manifest.subscriptions ?? []).includes(channel)
    const connectionId = channel.includes(':') ? channel.slice(channel.indexOf(':') + 1) : ''
    if (!literal && !referenced.has(connectionId)) continue
    if (seen.has(channel)) continue
    seen.add(channel)
    const viaConnection = !literal && referenced.has(connectionId)
    const action: HealthAction = viaConnection
      ? { kind: 'connection', id: connectionId }
      : error === 'unconfigured' ? { kind: 'screen' } : { kind: 'reload' }
    const p = channelProblem(error, action, viaConnection)
    // The same connection already reported as incomplete: its provider saying so again is noise.
    if (p && !(p.code === 'unconfigured' && problems.some((q) => q.code === 'connectionIncomplete'))) problems.push(p)
  }

  const update: HealthUpdate | null = market?.updateAvailable ? { widgetId: widget.widgetId, version: market.version ?? null } : null

  problems.sort((a, b) => rank(a) - rank(b))
  const level = worst(problems.map((p) => p.level))
  return { level: level === 'ok' && update ? 'update' : level, problems, update }
}

/** Every widget of the config, by instance id. */
export function computeHealth(input: HealthInput): Record<string, InstanceHealth> {
  const out: Record<string, InstanceHealth> = {}
  for (const [instanceId, widget] of Object.entries(input.config.widgets)) out[instanceId] = widgetHealth(widget, input)
  return out
}

/** The instance ids a page shows. */
const onPage = (page: Page): string[] => page.items.map((p) => p.instanceId)

export function pageLevel(health: Record<string, InstanceHealth>, page: Page): HealthLevel {
  return problemLevel(worst(onPage(page).map((id) => health[id]?.level ?? 'ok')))
}

/** A screen's pages and its bar. */
export function screenLevel(health: Record<string, InstanceHealth>, screen: Screen): HealthLevel {
  const ids = [...screen.pages.flatMap(onPage), ...navItemsOf(screen).map((n) => n.instanceId)]
  return problemLevel(worst(ids.map((id) => health[id]?.level ?? 'ok')))
}

/** Where a widget can be found: a page of a screen, or a screen's bar. */
export interface HealthPlace { screenId: string; screenName: string; pageIndex: number | null; pageName: string | null }

/** One line of the top bar's list: a widget, where it is, and what is wrong with it. */
export interface HealthEntry { instanceId: string; widget: Widget; health: InstanceHealth; place: HealthPlace }

/**
 * Every widget with a problem that is placed somewhere, errors first; an update is not a problem.
 * Placed on the screen being edited, it is listed where it is there; otherwise where it first appears.
 */
export function healthEntries(config: Config, health: Record<string, InstanceHealth>, currentScreenId?: string): HealthEntry[] {
  const places = new Map<string, HealthPlace>()
  const screens = [...config.screens].sort((a, b) => Number(b.id === currentScreenId) - Number(a.id === currentScreenId))
  for (const screen of screens) {
    screen.pages.forEach((page, pageIndex) => {
      for (const id of onPage(page)) if (!places.has(id)) places.set(id, { screenId: screen.id, screenName: screen.name, pageIndex, pageName: page.name })
    })
    for (const item of navItemsOf(screen)) {
      if (!places.has(item.instanceId)) places.set(item.instanceId, { screenId: screen.id, screenName: screen.name, pageIndex: null, pageName: null })
    }
  }
  const out: HealthEntry[] = []
  for (const [instanceId, place] of places) {
    const h = health[instanceId]
    const widget = config.widgets[instanceId]
    if (!h || h.problems.length === 0 || !widget) continue
    out.push({ instanceId, widget, health: h, place })
  }
  return out.sort((a, b) => Number(b.health.level === 'error') - Number(a.health.level === 'error'))
}

/** The sentence for a problem, in the editor's language. */
export function describeProblem(p: HealthProblem): string {
  return t(`admin.health.reason.${p.code}`, { detail: p.detail ?? '', error: p.error ?? '' })
}

/** The label of a problem's button. */
export function actionLabel(a: HealthAction): string {
  return t(`admin.health.action.${a.kind}`)
}
