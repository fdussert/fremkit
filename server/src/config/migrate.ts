import { z } from 'zod'
import { ConfigSchema, defaultLocale, WIDGET_ID_RE, type Config } from './schema.js'
import { defaultSecretsBackend } from '../secrets/index.js'

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
 * Normalise any accepted config file to v2. A v2 file is validated as-is, a v1 file (or one
 * without a version) is scaled up, any other version throws so the caller can recover.
 */
export function migrateConfig(raw: unknown): Config {
  const version = (raw as { version?: unknown } | null)?.version
  if (version === 2) return adoptPrivacy(ConfigSchema.parse(raw), raw)
  if (version !== undefined && version !== 1) throw new Error(`version de config inconnue: ${String(version)}`)
  const v1 = V1Schema.parse(raw)
  const s = MIGRATION_SCALE
  const migrated: Config = {
    version: 2,
    display: {
      cols: v1.display.cols * s,
      rows: v1.display.rows * s,
      cell: Math.max(1, Math.round(v1.display.cell / s)),
      autoCycleSeconds: v1.display.autoCycleSeconds,
    },
    connections: [],
    secrets: { backend: defaultSecretsBackend() },
    locale: defaultLocale(),
    privacy: { claudeAccountUsage: false },
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
  return adoptPrivacy(migrated, raw)
}
