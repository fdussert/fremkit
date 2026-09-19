import { z } from 'zod'
import { isPrivateLiteral } from '../net/private.js'
import { WIDGET_ID_RE } from '../config/schema.js'
import { tr } from '../i18n.js'

/**
 * A widget's version, in the shape the registry can order.
 *
 * Free text was enough while every widget shipped with the server: the number was documentation.
 * The marketplace compares it — "is this newer than what is installed", "is this newer than the
 * last published one" — and a comparison needs a grammar, so this is semver.org's own, kept whole
 * including the pre-release and build parts so `1.0.0-rc.1` is sayable.
 */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * An SPDX licence identifier, by shape rather than by list: the list moves, and nothing here
 * decides anything from the value — the admin shows it and the registry's reviewer reads it.
 * The shape still matters, because it is rendered, and a sentence is not an identifier.
 */
const LICENSE_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/

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
    error: () => tr(undefined, 'manifest.suggestWhenWithoutSuggest'),
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
    error: () => tr(undefined, 'manifest.connectionNeedsType'),
  })
  .refine((f) => f.type !== 'pick' || (typeof f.connection === 'string' && f.connection !== ''), {
    error: () => tr(undefined, 'manifest.pickNeedsConnection'),
  })
  .refine((f) => f.type !== 'pick' || (typeof f.source === 'string' && f.source !== ''), {
    error: () => tr(undefined, 'manifest.pickNeedsSource'),
  })
  .refine((f) => f.type !== 'list' || Object.keys(f.itemSchema ?? {}).length > 0, {
    error: () => tr(undefined, 'manifest.listNeedsItemSchema'),
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
/**
 * The shelf of the library a widget sits on. A manifest that names none lands in `other`, which
 * is where a widget written before this existed still shows up.
 */
export const WIDGET_CATEGORIES = ['ai', 'dev', 'system', 'productivity', 'media', 'info', 'home', 'other'] as const
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number]

export const CompactSchema = z.object({ width: z.number().int().min(2).max(16) })
export type Compact = z.infer<typeof CompactSchema>

/**
 * Channels the host broadcasts that are not a widget's business.
 *
 * `config` carries the whole dashboard — every page, every widget's settings, the id and the
 * fields of every connection. A widget that asked for it would be handed all of it, and no
 * widget here has ever needed it. Refused when the manifest is read, so a folder dropped into
 * `widgets/` cannot quietly ask for the lot.
 */
const RESERVED_CHANNELS = new Set(['config'])

const ChannelSchema = z.string().min(1).refine((channel) => {
  // `azure-devops:*` covers every connection of a type, so the family is what matters here.
  const family = channel.split(':')[0]
  return !RESERVED_CHANNELS.has(family) && !RESERVED_CHANNELS.has(channel)
}, { error: () => tr(undefined, 'manifest.reservedChannel') })


/**
 * A connection a widget declares for itself, instead of one the core has code for.
 *
 * Most services a widget wants are one auth header on HTTPS: the host is typed by the user, a
 * token goes in a header, and the widget reads JSON. Writing a coded connection type for each
 * of those means a release of Fremkit per service. So a widget may describe one, and the core
 * stores it, tests it and injects the secret — **the widget never sees the secret**, only the
 * answers.
 *
 * What stays coded is everything this shape cannot express: a session handshake (Synology), a
 * protocol that is not HTTP (Bambu's MQTT), OAuth, a local binary. A declaration is not an
 * escape hatch, it is the easy half.
 *
 * Everything here is read from a manifest that arrived over the network, so every rule below is
 * enforced by this schema rather than assumed by the code that reads it.
 */

/** How the secret is presented to the service. `host` is the case with no secret at all. */
export const CONNECTION_KINDS = ['host', 'http-bearer', 'http-basic', 'api-key-header', 'api-key-query'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

/**
 * Headers a declaration may put an API key in.
 *
 * An allow-list because a header name is a way to reach past the proxy: `Host` changes which
 * virtual host answers, `Cookie` turns a declared connection into a session, and a `X-Forwarded-*`
 * is a lie told to whatever is in front of the service. These four are the ones services
 * actually use.
 */
export const API_KEY_HEADERS = ['Authorization', 'X-API-Key', 'X-Api-Key', 'X-Auth-Token'] as const

/** The methods a declared request may use. No `HEAD`, no `OPTIONS`: nothing needs them yet. */
export const CONNECTION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** The names of the coded types, lower-cased. A declaration may not borrow one as its label. */
const CODED_TYPE_NAMES = new Set([
  'azure devops', 'bambu lab', 'github', 'homey pro', 'ics calendar', 'calendrier ics', 'synology',
])

/**
 * One path the widget is allowed to ask for.
 *
 * `/`-rooted, and every segment is a literal, `*` (exactly one segment) or `**` (the rest, and
 * only at the end). No query string — the proxy builds the URL, and a pattern that could carry
 * one would be a pattern that could carry a second host. No `.` or `..`, which a service's own
 * router may collapse in ways this one cannot predict.
 */
const PATH_SEGMENT = /^(?:\*|\*\*|[A-Za-z0-9._~%!$&'()+,;=:@-]+)$/
export const ConnectionPathSchema = z.string().min(1).max(200).refine((path) => {
  if (!path.startsWith('/')) return false
  if (path.includes('?') || path.includes('#')) return false
  const segments = path.slice(1).split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false
  if (!segments.every((seg) => PATH_SEGMENT.test(seg))) return false
  // `**` swallows everything after it, so anything written after it is a rule nobody applies.
  return segments.findIndex((seg) => seg === '**') === -1
    || segments.findIndex((seg) => seg === '**') === segments.length - 1
}, { error: () => tr(undefined, 'manifest.badConnectionPath') })

/** A field of a declared connection: a `ConnectionFieldSpec` without the admin-only extras. */
const ConnectionDeclFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: LocalizedTextSchema,
  help: LocalizedTextSchema.optional(),
  placeholder: LocalizedTextSchema.optional(),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
})

const ConnectionRequestSchema = z.object({
  method: z.enum(CONNECTION_METHODS),
  path: ConnectionPathSchema,
  /**
   * Serve a GET from a per-connection cache for this long, so two widgets on one screen do not
   * poll the same service twice. Five minutes is the ceiling: past that it is not a cache, it is
   * a stale reading presented as a live one.
   */
  cacheMs: z.number().int().min(0).max(300_000).optional(),
})

export const ConnectionDeclSchema = z.object({
  name: LocalizedTextSchema,
  kind: z.enum(CONNECTION_KINDS),
  fields: z.array(ConnectionDeclFieldSchema).min(1).max(8),
  headerName: z.enum(API_KEY_HEADERS).optional(),
  queryName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  /**
   * `http` is allowed, and has to be: a Key Light or a Homey on the LAN serves plain HTTP or a
   * certificate no authority signed. The proxy refuses `http` to a public host — see
   * `declared.ts` — so the exception stays where it belongs, on the local network.
   */
  scheme: z.enum(['https', 'http']).default('https'),
  test: z.object({
    method: z.literal('GET'),
    path: ConnectionPathSchema,
    expect: z.number().int().min(100).max(599),
  }).optional(),
  requests: z.array(ConnectionRequestSchema).min(1).max(32),
  /** Setup instructions, shown above the fields. Rendered as text: no HTML, no links followed. */
  hint: LocalizedTextSchema.optional(),
})
  .refine((c) => c.fields.filter((f) => f.key === 'host').length === 1, {
    error: () => tr(undefined, 'manifest.connectionNeedsHost'),
  })
  .refine((c) => !c.fields.some((f) => f.key === 'host' && f.secret), {
    error: () => tr(undefined, 'manifest.connectionHostNotSecret'),
  })
  .refine((c) => {
    const secrets = c.fields.filter((f) => f.secret).length
    return c.kind === 'host' ? secrets === 0 : secrets === 1
  }, { error: () => tr(undefined, 'manifest.connectionSecretCount') })
  .refine((c) => (c.kind === 'api-key-header') === (c.headerName !== undefined), {
    error: () => tr(undefined, 'manifest.connectionHeaderName'),
  })
  .refine((c) => (c.kind === 'api-key-query') === (c.queryName !== undefined), {
    error: () => tr(undefined, 'manifest.connectionQueryName'),
  })
  .refine((c) => !CODED_TYPE_NAMES.has(localizedValues(c.name).join(' ').toLowerCase().trim())
    && !localizedValues(c.name).some((v) => CODED_TYPE_NAMES.has(v.toLowerCase().trim())), {
    error: () => tr(undefined, 'manifest.connectionNameTaken'),
  })
  .refine((c) => localizedValues(c.hint).every((v) => v.length <= 2000), {
    error: () => tr(undefined, 'manifest.connectionHintTooLong'),
  })
export type ConnectionDecl = z.infer<typeof ConnectionDeclSchema>

/** Every string a `LocalizedText` holds, whichever of its two shapes it is in. */
function localizedValues(text: LocalizedText | undefined): string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : Object.values(text)
}

const RawManifestSchema = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  name: LocalizedTextSchema,
  version: z.string().regex(SEMVER_RE, { error: () => tr(undefined, 'manifest.badVersion') }),
  /**
   * The SDK generation the widget needs. Absent means 1: every widget written before this
   * existed asks for the bridge as it was, which is generation 1 by definition.
   */
  sdk: z.number().int().min(1).default(1),
  /** Shown in the admin beside the widget, and nowhere else — none of these three is executed. */
  homepage: z.url({ protocol: /^https$/, error: () => tr(undefined, 'manifest.badHomepage') }).optional(),
  author: z.string().min(1).max(200).optional(),
  license: z.string().regex(LICENSE_RE, { error: () => tr(undefined, 'manifest.badLicense') }).optional(),
  description: LocalizedTextSchema.default(''),
  icon: z.string().min(1).default('layout-grid'),
  /**
   * The shelf of the library it sits on. A manifest published for a newer Fremkit may name a
   * category this one does not have: it is filed under 'other' rather than refused, which would
   * take the whole widget out of the catalogue.
   */
  category: z.enum(WIDGET_CATEGORIES).default('other').catch('other'),
  sizes: z.array(SizeSchema).min(1).optional(),
  minSize: SizeSchema.optional(),
  defaultSize: SizeSchema.optional(),
  compact: CompactSchema.optional(),
  subscriptions: z.array(ChannelSchema).default([]),
  commands: z.array(ChannelSchema).default([]),
  settingsSchema: z.record(z.string(), SettingFieldSchema).default({}),
  permissions: z.object({
    /**
     * Hosts the widget may reach through the proxy. A hostname, never a URL, and never a private
     * or local address: the proxy runs on the user's machine, so `127.0.0.1` here would let a
     * widget read this very API, and `169.254.169.254` a cloud metadata service. A name that
     * merely resolves to one is caught at request time instead (see net/private.ts).
     */
    network: z.array(z.string().refine((host) => !isPrivateLiteral(host), {
      error: () => tr(undefined, 'manifest.privateNetworkHost'),
    })).default([]),
  }).prefault({}),
  /**
   * A connection this widget describes for itself. Absent in almost every manifest.
   *
   * It is a *permission*, not a setting: the consent dialog renders it, the consent record
   * stores it, and the proxy will only make the requests it lists. A widget that changes it in
   * an update asks again.
   */
  connection: ConnectionDeclSchema.optional(),
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
    ctx.addIssue({ code: 'custom', message: tr(undefined, 'manifest.defaultSizeTooSmall'), path: ['defaultSize'] })
    return z.NEVER
  }
  return { ...rest, minSize, defaultSize }
})

export type WidgetManifest = z.infer<typeof ManifestSchema>
export type SettingField = z.infer<typeof SettingFieldSchema>
