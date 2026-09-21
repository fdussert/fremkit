import { BUILTIN_THEME } from '../themes/theme.js'
import { z } from 'zod'
import { CONFIG_VERSION, ConfigSchema, defaultLocale, WIDGET_ID_RE, type Config } from './schema.js'
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
function renameFieldValues(config: Config): Config {
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

function declareHomey(config: Config): Config {
  if (!config.connections.some((c) => c.type === HOMEY_CODED_TYPE)) return config
  return {
    ...config,
    connections: config.connections.map((c) =>
      c.type === HOMEY_CODED_TYPE ? { ...c, type: HOMEY_DECLARED_TYPE } : c),
  }
}

/** The widget whose gauges come from the Claude account usage the `privacy` opt-in covers. */
const CLAUDE_USAGE_WIDGET = 'claude-usage'

/** True when a config already shows that widget, on a page or in the navigation bar. */
export function placesClaudeUsage(config: Config): boolean {
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
 */
function adoptPrivacy(config: Config, raw: unknown): Config {
  const stated = (raw as { privacy?: unknown } | null)?.privacy
  if (stated && typeof stated === 'object' && 'claudeAccountUsage' in stated) return config
  return { ...config, privacy: { ...config.privacy, claudeAccountUsage: placesClaudeUsage(config) } }
}

/**
 * Normalise any accepted config file to v3.
 *
 * A v3 file is validated as-is. A v2 file is the same shape with a Homey connection that still
 * names a coded type, so it is read through the v2 schema, rewritten, and stamped v3. A v1 file
 * (or one without a version) is scaled up and goes through the same rewrite. Any other version
 * throws so the caller can recover.
 */
export function migrateConfig(raw: unknown): Config {
  const version = (raw as { version?: unknown } | null)?.version
  if (version === CONFIG_VERSION) return renameFieldValues(adoptPrivacy(ConfigSchema.parse(raw), raw))
  if (version === 2) {
    // The only difference between v2 and v3 is the Homey connection's type, so a v2 file is
    // parsed by stamping it and letting the current schema do the rest.
    const stamped = ConfigSchema.parse({ ...(raw as object), version: CONFIG_VERSION })
    return declareHomey(renameFieldValues(adoptPrivacy(stamped, raw)))
  }
  if (version !== undefined && version !== 1) throw new Error(tr(undefined, 'config.unknownVersion', { version: String(version) }))
  const v1 = V1Schema.parse(raw)
  const s = MIGRATION_SCALE
  const migrated: Config = {
    version: CONFIG_VERSION,
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
    privacy: { claudeAccountUsage: false },
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
