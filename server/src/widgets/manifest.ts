import { z } from 'zod'
import { isPrivateLiteral } from '../net/private.js'
import { WIDGET_ID_RE } from '../config/schema.js'

export const SizeSchema = z.tuple([z.number().int().min(1), z.number().int().min(1)])

/**
 * A text a manifest shows to the user. Either one string — how every manifest was written before
 * this existed, and still the right shape for a name that reads the same in both languages — or a
 * `{ fr, en }` pair. Either way the server passes it through untouched: the admin resolves it,
 * because only the admin knows which language it is rendering.
 */
export const LocalizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())])
export type LocalizedText = z.infer<typeof LocalizedTextSchema>

/**
 * One choice of an `enum` setting. A bare string is both the stored value and its label; the
 * object form separates them, because the value ends up in the user's config and must not move
 * when they switch language.
 */
export const SettingOptionSchema = z.union([
  z.string(),
  z.object({ value: z.string(), label: LocalizedTextSchema }),
])
export type SettingOption = z.infer<typeof SettingOptionSchema>

/**
 * The types a `list` item may be made of. Deliberately the plain ones: no nested list, and
 * nothing that needs the admin's own data (a connection, the Dock apps), because a list row is
 * rendered inline and must stay one compact line.
 */
export const LIST_ITEM_TYPES = ['string', 'boolean', 'enum', 'number', 'timezone'] as const

/** Where the admin reads the suggestions a list item field offers while the user types. */
export const SUGGEST_SOURCES = ['apps'] as const

export const ListItemFieldSchema = z.object({
  type: z.enum(LIST_ITEM_TYPES),
  label: LocalizedTextSchema,
  default: z.unknown().optional(),
  options: z.array(SettingOptionSchema).optional(),
  /**
   * `string` fields only: the admin offers these as a drop-down while typing. `apps` names the
   * applications installed on this machine. Suggestions never restrict: any value stays typeable.
   */
  suggest: z.enum(SUGGEST_SOURCES).optional(),
  /**
   * Narrows `suggest` to the rows where a sibling field of the same item holds a given value —
   * `{ "kind": "app" }` offers the applications only while the row's kind is "app". Absent means
   * the suggestions are offered on every row.
   */
  suggestWhen: z.record(z.string(), z.string()).optional(),
})
  .refine((f) => f.suggest === undefined || f.type === 'string', {
    message: 'suggest ne vaut que pour un champ de type string',
  })
  .refine((f) => f.suggestWhen === undefined || f.suggest !== undefined, {
    message: 'suggestWhen ne vaut que pour un champ qui déclare suggest',
  })
export type ListItemField = z.infer<typeof ListItemFieldSchema>

/**
 * Which rendering of the widget a setting belongs to: the `tile` drawn on a page, or the
 * `compact` one drawn in the navigation bar. Absent means both, so a manifest written before this
 * existed keeps showing every setting in both editors.
 */
export const SettingScopeSchema = z.enum(['tile', 'compact'])
export type SettingScope = z.infer<typeof SettingScopeSchema>

export const SettingFieldSchema = z.object({
  type: z.enum(['boolean', 'string', 'number', 'enum', 'color', 'connection', 'connections', 'apps', 'timezone', 'list', 'pick']),
  label: LocalizedTextSchema,
  /** Which editor shows the setting; absent means both. */
  scope: SettingScopeSchema.optional(),
  default: z.unknown().optional(),
  options: z.array(SettingOptionSchema).optional(),
  /**
   * `connection` and `connections` fields only: which connection type the admin offers.
   * `connection` stores one id, `connections` an array of them.
   */
  connectionType: z.string().optional(),
  /**
   * `pick` fields only: the key of the sibling `connection` setting whose value says which
   * connection the choices are read from.
   */
  connection: z.string().optional(),
  /** `pick` fields only: which list of that connection to offer — the type names its sources. */
  source: z.string().optional(),
  /** `list` fields only: the fields one item of the list is made of. */
  itemSchema: z.record(z.string(), ListItemFieldSchema).optional(),
  /** `list` fields only: how many items the user may add. Absent means no ceiling. */
  max: z.number().int().min(1).optional(),
})
  .refine((f) => (f.type !== 'connection' && f.type !== 'connections') || typeof f.connectionType === 'string', {
    message: 'un réglage de type connection doit déclarer connectionType',
  })
  .refine((f) => f.type !== 'pick' || (typeof f.connection === 'string' && f.connection !== ''), {
    message: 'un réglage de type pick doit déclarer connection',
  })
  .refine((f) => f.type !== 'pick' || (typeof f.source === 'string' && f.source !== ''), {
    message: 'un réglage de type pick doit déclarer source',
  })
  .refine((f) => f.type !== 'list' || Object.keys(f.itemSchema ?? {}).length > 0, {
    message: 'un réglage de type list doit déclarer itemSchema',
  })

/** v1 manifests described a 32x16 grid with fixed `sizes`; the v2 grid has twice the cells. */
const LEGACY_SCALE = 2

/** A manifest that declares neither `minSize` nor `sizes` is held to this floor (spec §3.3). */
const DEFAULT_MIN_SIZE: [number, number] = [4, 2]

/**
 * Declares that the widget has a compact rendering, the one the navigation bar draws: a single
 * line, no title and no surface of its own. `width` is how many grid cells wide the bar allots
 * it; its height is always the bar's. Absent means the widget is only ever drawn as a tile.
 */
export const CompactSchema = z.object({ width: z.number().int().min(2).max(16) })
export type Compact = z.infer<typeof CompactSchema>

const RawManifestSchema = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  name: LocalizedTextSchema,
  version: z.string().min(1),
  description: LocalizedTextSchema.default(''),
  icon: z.string().min(1).default('layout-grid'),
  sizes: z.array(SizeSchema).min(1).optional(),
  minSize: SizeSchema.optional(),
  defaultSize: SizeSchema.optional(),
  compact: CompactSchema.optional(),
  subscriptions: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  settingsSchema: z.record(z.string(), SettingFieldSchema).default({}),
  permissions: z.object({
    /**
     * Hosts the widget may reach through the proxy. A hostname, never a URL, and never a private
     * or local address: the proxy runs on the user's machine, so `127.0.0.1` here would let a
     * widget read this very API, and `169.254.169.254` a cloud metadata service. A name that
     * merely resolves to one is caught at request time instead (see net/private.ts).
     */
    network: z.array(z.string().refine((host) => !isPrivateLiteral(host), {
      message: 'hôte privé ou local interdit dans permissions.network',
    })).default([]),
  }).prefault({}),
})

export const ManifestSchema = RawManifestSchema.transform((m, ctx) => {
  const { sizes, ...rest } = m
  let minSize = m.minSize
  let defaultSize = m.defaultSize
  if (!minSize && sizes) {
    minSize = [Math.min(...sizes.map((s) => s[0])) * LEGACY_SCALE, Math.min(...sizes.map((s) => s[1])) * LEGACY_SCALE]
    defaultSize = defaultSize
      ? [defaultSize[0] * LEGACY_SCALE, defaultSize[1] * LEGACY_SCALE]
      : [sizes[0][0] * LEGACY_SCALE, sizes[0][1] * LEGACY_SCALE]
  }
  if (!minSize) minSize = DEFAULT_MIN_SIZE
  if (!defaultSize) defaultSize = minSize
  if (defaultSize[0] < minSize[0] || defaultSize[1] < minSize[1]) {
    ctx.addIssue({ code: 'custom', message: 'defaultSize doit être supérieur ou égal à minSize', path: ['defaultSize'] })
    return z.NEVER
  }
  return { ...rest, minSize, defaultSize }
})

export type WidgetManifest = z.infer<typeof ManifestSchema>
export type SettingField = z.infer<typeof SettingFieldSchema>
