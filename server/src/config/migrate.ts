import { BUILTIN_THEME } from '../themes/theme.js'
import { z } from 'zod'
import {
  CONFIG_VERSION, ConfigSchema, defaultLocale, INSTANCE_ID_MAX, WIDGET_ID_RE,
  type Config, type Connection, type NavItem, type Page, type Widget,
} from './schema.js'
import { V3ConfigSchema, type V3Config, type V3WidgetInstance } from './v3.js'
import { convertClockCities } from './normalize.js'
import { defaultSecretsBackend } from '../secrets/index.js'
import type { SecretStore } from '../secrets/types.js'
import { tr } from '../i18n.js'

/** v1 used a 32x8 grid of 80px cells; v2 halves the cell and doubles every coordinate. */
export const MIGRATION_SCALE = 2

const V1InstanceSchema = z.object({
  instanceId: z.string().min(1),
  widgetId: z.string().regex(WIDGET_ID_RE),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  settings: z.record(z.string(), z.unknown()).default({}),
})

const V1Schema = z.object({
  version: z.literal(1).optional(),
  display: z.object({
    cols: z.number().int().min(1).default(32),
    rows: z.number().int().min(1).default(8),
    cell: z.number().int().min(1).default(80),
    autoCycleSeconds: z.number().int().min(0).default(0),
  }).prefault({}),
  pages: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    widgets: z.array(V1InstanceSchema).default([]),
  })).min(1),
})

/**
 * Stored values that were renamed, by connection type and field.
 *
 * The Bambu model list held `autre` — a French word written into the user's file, where every
 * other stored value is English. `other` means exactly the same thing to `cameraTransport()`, so
 * the rename is invisible; this keeps a config that already holds the old spelling from losing
 * its selection the next time the form is opened.
 */
const RENAMED_FIELD_VALUES: Record<string, Record<string, Record<string, string>>> = {
  bambu: { model: { autre: 'other' } },
}

/** Applies those renames in place. Nothing else touches a connection's fields. */
function renameFieldValues<T extends { connections: Connection[] }>(config: T): T {
  return {
    ...config,
    connections: config.connections.map((connection) => {
      const byField = RENAMED_FIELD_VALUES[connection.type]
      if (!byField) return connection
      let fields = connection.fields
      for (const [key, values] of Object.entries(byField)) {
        const current = fields[key]
        if (current !== undefined && Object.hasOwn(values, current)) {
          fields = { ...fields, [key]: values[current] }
        }
      }
      return fields === connection.fields ? connection : { ...connection, fields }
    }),
  }
}

/**
 * The Homey connection, from a type written into Fremkit to one the widget declares.
 *
 * `homey` was a coded connection type here, with a provider polling a channel. It did nothing a
 * declaration cannot — one bearer header to a host on the LAN — and having it in the core cost
 * the user a second Homey connection, because `homey-flows` already declared its own and a Homey
 * invalidates the previous API key whenever a new one is issued. Both widgets now declare the
 * same shape, so one key serves both.
 *
 * The connection itself is kept: same id, same name, same address. Only its `type` moves, and
 * the id is what a widget instance stores in `settings.connection`, so nothing on a dashboard
 * has to be re-picked. The key moves too, but not here — see `migrateHomeySecret`, because the
 * secret store is somewhere this function has no business reaching.
 */
export const HOMEY_CODED_TYPE = 'homey'
export const HOMEY_DECLARED_TYPE = 'decl:homey-devices:homey-devices'
/** The coded type called it `apiKey`; the declaration calls it `token`. */
export const HOMEY_OLD_SECRET = 'apiKey'
export const HOMEY_NEW_SECRET = 'token'

function declareHomey<T extends { connections: Connection[] }>(config: T): T {
  if (!config.connections.some((c) => c.type === HOMEY_CODED_TYPE)) return config
  return {
    ...config,
    connections: config.connections.map((c) =>
      c.type === HOMEY_CODED_TYPE ? { ...c, type: HOMEY_DECLARED_TYPE } : c),
  }
}

/** The widget whose gauges come from the Claude account usage the `privacy` opt-in covers. */
const CLAUDE_USAGE_WIDGET = 'claude-usage'

/**
 * True when a config already shows that widget, on a page or in the navigation bar. Read on the
 * v3 shape: the inference only ever runs on a file written before v4, before it is converted.
 */
export function placesClaudeUsage(config: V3Config): boolean {
  if (config.pages.some((p) => p.widgets.some((w) => w.widgetId === CLAUDE_USAGE_WIDGET))) return true
  return (config.display.navWidgets ?? []).some((w) => w.widgetId === CLAUDE_USAGE_WIDGET)
}

/**
 * Decides `privacy` for a config written before the field existed.
 *
 * Reading Claude Code's keychain item is opt-in, and a fresh install starts with it off. But a
 * config that already places the claude-usage widget was written by someone who had those gauges
 * working, and an upgrade that silently blanked them would be a regression rather than a choice —
 * so that case starts enabled, and the admin's toggle is where it is turned back off. A config
 * that already carries the field is left exactly as written.
 *
 * `showAccountEmail` needs no such inference: no release ever published an account's e-mail, so
 * an older config is read as off by the schema's default, which is what it always meant.
 */
function adoptPrivacy(config: V3Config, raw: unknown): V3Config {
  const stated = (raw as { privacy?: unknown } | null)?.privacy
  if (stated && typeof stated === 'object' && 'claudeAccountUsage' in stated) return config
  return { ...config, privacy: { ...config.privacy, claudeAccountUsage: placesClaudeUsage(config) } }
}

/**
 * Normalise any accepted config file to v4.
 *
 * A v4 file is validated as-is. Anything older is first brought to v3 — the shape every older
 * release knew how to convert — then has the v3 normalisations run on it (`normalizeV3`), and
 * only then is converted (`toV4`). A v3 file is validated as-is. A v2 file is the same shape with
 * a Homey connection that still names a coded type, so it is read through the v3 schema,
 * rewritten, and stamped v3. A v1 file (or one without a version) is scaled up and goes through
 * the same rewrite. Any other version throws so the caller can recover.
 */
export function migrateConfig(raw: unknown): Config {
  const version = (raw as { version?: unknown } | null)?.version
  if (version === CONFIG_VERSION) return adoptLabs(renameFieldValues(ConfigSchema.parse(raw)), raw)
  // Anything older than v4 had one screen and no pairing: the default (off) is the right answer.
  return toV4(normalizeV3(readV3(raw, version)))
}

/**
 * Decides the `labs` switches a v4 config was written without, one by one.
 *
 * `devices`: a fresh install starts with iPad pairing and extra screens hidden. But a config that
 * already has more than one screen, or a screen made for a paired device, was written by someone
 * using them, and an upgrade that hid their screens' selector would be a regression — so that case
 * starts on. Pairing itself lives in `devices.json`, which this pure function does not read; a
 * paired device shows a device screen, which is what is checked here.
 *
 * `companion`: on when a Fremplay widget is already placed, since that config was written by
 * someone using the browser extension; off otherwise.
 *
 * A switch the file already carries is left exactly as written.
 */
export function adoptLabs(config: Config, raw: unknown): Config {
  const stated = (raw as { labs?: unknown } | null)?.labs
  const has = (key: string): boolean => !!stated && typeof stated === 'object' && key in stated
  const labs = { ...config.labs }
  if (!has('devices')) labs.devices = config.screens.length > 1 || config.screens.some((x) => x.kind === 'device')
  if (!has('companion')) labs.companion = Object.values(config.widgets).some((w) => w.widgetId === 'fremplay')
  return { ...config, labs }
}

/** Any file older than v4, as the v3 config it would have become under the previous release. */
function readV3(raw: unknown, version: unknown): V3Config {
  if (version === 3) return renameFieldValues(adoptPrivacy(V3ConfigSchema.parse(raw), raw))
  if (version === 2) {
    // The only difference between v2 and v3 is the Homey connection's type, so a v2 file is
    // parsed by stamping it and letting the v3 schema do the rest.
    const stamped = V3ConfigSchema.parse({ ...(raw as object), version: 3 })
    return declareHomey(renameFieldValues(adoptPrivacy(stamped, raw)))
  }
  if (version !== undefined && version !== 1) throw new Error(tr(undefined, 'config.unknownVersion', { version: String(version) }))
  const v1 = V1Schema.parse(raw)
  const s = MIGRATION_SCALE
  const migrated: V3Config = {
    version: 3,
    display: {
      cols: v1.display.cols * s,
      rows: v1.display.rows * s,
      cell: Math.max(1, Math.round(v1.display.cell / s)),
      autoCycleSeconds: v1.display.autoCycleSeconds,
      theme: BUILTIN_THEME,
    },
    connections: [],
    secrets: { backend: defaultSecretsBackend() },
    locale: defaultLocale(),
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false, messages2FA: false },
    // A v1 config predates the marketplace by a long way; nothing can have been installed.
    marketplace: { installed: {} },
    pages: v1.pages.map((p) => ({
      id: p.id,
      name: p.name,
      widgets: p.widgets.map((w) => ({
        instanceId: w.instanceId,
        widgetId: w.widgetId,
        x: w.x * s, y: w.y * s, w: w.w * s, h: w.h * s,
        showTitle: true,
        settings: w.settings,
      })),
    })),
  }
  return declareHomey(renameFieldValues(adoptPrivacy(migrated, raw)))
}

/**
 * A tile used to pick one of three `appearance` values, with `accentStyle` refining the accent
 * one. Those three are now the three independent keys `bgColor`, `opacity` and `accentMode`, so
 * an instance written against the old model is converted here, on the v3 shape, before the file
 * becomes v4 — which is what lets an old file open without the user doing anything.
 *
 * - `transparent` painted no surface at all: that is an opacity of 0 and no colour of its own.
 * - `accent` + `outline` coloured the title bar and the border: `accentMode: 'frame'`.
 * - `accent` alone painted the whole tile: `accentMode: 'fill'`.
 * - `panel` was the plain surface, which is what an instance with none of these keys already is.
 *
 * Both legacy keys go either way, so the converted instance carries nothing v4 does not know.
 */
export function migrateAppearance(widget: V3WidgetInstance): void {
  const { appearance, accentStyle } = widget
  if (appearance === 'transparent') {
    widget.opacity = 0
    widget.bgColor = undefined
  } else if (appearance === 'accent') {
    widget.accentMode = accentStyle === 'outline' ? 'frame' : 'fill'
  }
  delete widget.appearance
  delete widget.accentStyle
}

/**
 * The normalisations a v3 config went through on every load, run once more on the v3 shape
 * before it is converted: the legacy appearance keys and the clock's `cities` string. Mutates the
 * config it is given, which is always a fresh parse.
 */
export function normalizeV3(config: V3Config): V3Config {
  for (const page of config.pages) {
    for (const widget of page.widgets) {
      migrateAppearance(widget)
      convertClockCities(widget)
    }
  }
  return config
}

/** The one screen a v3 file described: the Edge, under the name a fresh install gives it. */
const EDGE_SCREEN = { id: 'edge', name: 'Xeneon Edge', kind: 'edge' } as const

/**
 * Makes a list of instance ids unique, in order, within the 64 characters an id may have.
 *
 * v3 only refused a duplicate id *within a page*, so the same id could sit on two pages, or on a
 * page and in the bar — and each was its own tile, with its own settings. v4 keys widgets by id,
 * so each later occurrence is renamed `<id>-<n>` with the smallest `n` that no id in the list
 * holds, original or already renamed. The first occurrence keeps its id, and an id that is
 * already in the file is never taken by a rename, whichever comes first. The base is cut before
 * the suffix is added, so the result stays within the limit the proxy enforces.
 */
export function renameCollisions(ids: string[]): string[] {
  const fit = (id: string) => id.slice(0, INSTANCE_ID_MAX)
  const taken = new Set(ids.map(fit))
  const kept = new Set<string>()
  return ids.map((id) => {
    const base = fit(id)
    if (!kept.has(base)) {
      kept.add(base)
      return base
    }
    for (let n = 2; ; n++) {
      const suffix = `-${n}`
      const candidate = base.slice(0, INSTANCE_ID_MAX - suffix.length) + suffix
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
  })
}

/**
 * Converts a normalised v3 config to v4: one Edge screen, rendering exactly what the v3 file did.
 *
 * The display becomes the screen's, minus the theme (now top-level, the same on every screen)
 * and the bar's content (now the screen's `nav`). Each tile becomes a `widgets` entry — every
 * field but its id and geometry — plus a placement with the same rectangle on the page of the
 * same id. Each bar widget becomes a `widgets` entry plus a nav item. Ids are made unique by
 * `renameCollisions`, pages in order, then the bar.
 */
export function toV4(v3: V3Config): Config {
  const { theme, navWidgets = [], ...display } = v3.display
  const ids = renameCollisions([
    ...v3.pages.flatMap((page) => page.widgets.map((tile) => tile.instanceId)),
    ...navWidgets.map((entry) => entry.instanceId),
  ])
  let next = 0
  const widgets: Record<string, Widget> = {}
  const pages: Page[] = v3.pages.map((page) => ({
    id: page.id,
    name: page.name,
    items: page.widgets.map(({ instanceId: _old, x, y, w, h, ...widget }) => {
      const instanceId = ids[next++]
      widgets[instanceId] = widget
      return { instanceId, x, y, w, h }
    }),
  }))
  const nav: NavItem[] = navWidgets.map(({ widgetId, slot, popup, settings }) => {
    const instanceId = ids[next++]
    widgets[instanceId] = { widgetId, showTitle: true, settings }
    return popup === undefined ? { instanceId, slot } : { instanceId, slot, popup }
  })
  // Parsed rather than cast, so a v3 value v4 would refuse fails here, before anything is written.
  return ConfigSchema.parse({
    version: CONFIG_VERSION,
    theme,
    connections: v3.connections,
    secrets: v3.secrets,
    locale: v3.locale,
    privacy: v3.privacy,
    marketplace: v3.marketplace,
    widgets,
    screens: [{ ...EDGE_SCREEN, display, nav, pages }],
  })
}

/**
 * Moves a migrated Homey connection's API key to the field name the declaration uses.
 *
 * Separate from `migrateConfig` because the secret store is asynchronous and lives behind a
 * backend the config layer knows nothing about. Idempotent, and safe to run on every start: a
 * connection whose key is already under `token` is left alone, and one with nothing under
 * `apiKey` costs a read that answers null.
 *
 * It also has to run after a *restore*: a backup carries no secrets, so a restored archive
 * brings back a connection whose key is still sitting in the keychain under the old field name.
 */
export async function migrateHomeySecret(config: Config, secrets: SecretStore): Promise<number> {
  let moved = 0
  for (const connection of config.connections) {
    if (connection.type !== HOMEY_DECLARED_TYPE) continue
    const already = await secrets.get(`${connection.id}/${HOMEY_NEW_SECRET}`)
    if (already !== null) continue
    const old = await secrets.get(`${connection.id}/${HOMEY_OLD_SECRET}`)
    if (old === null) continue
    await secrets.set(`${connection.id}/${HOMEY_NEW_SECRET}`, old)
    await secrets.delete(`${connection.id}/${HOMEY_OLD_SECRET}`)
    moved += 1
  }
  return moved
}
