/**
 * The registry index, as Fremkit reads it.
 *
 * The mirror of `tools/schema.ts` in the registry repository. It is written twice on purpose:
 * this side never trusts the other's description of what it published, and a shared package
 * would make one repository's release schedule the other's problem. `INDEX_SCHEMA` is what holds
 * them together — an index announcing a different number is refused before a single field is
 * read, so a Fremkit too old to understand a future index says so instead of guessing.
 *
 * Everything here is data from the network. Nothing in it is believed: the URLs are checked
 * against the registry's own host before anything is fetched, the hash and the size are verified
 * against the bytes that arrive, and the permissions are re-read from the manifest inside the
 * package rather than taken from the index entry that advertised them.
 */

import { ConnectionDeclSchema } from '../widgets/manifest.js'
import { z } from 'zod'
import { SEMVER_RE, WIDGET_CATEGORIES } from '../widgets/manifest.js'
import { WIDGET_ID_RE } from '../config/schema.js'

/** The version of the index format this build reads. */
export const INDEX_SCHEMA = 1

const LocalizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())])
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * A package URL, by shape only.
 *
 * The rule that matters is not "https" — it is "on the registry's own host, with the registry's
 * own scheme", and only `Registry` knows what that host is. It applies it to every URL in the
 * index before the index is accepted, which is both stricter than a scheme check here and the
 * reason a development registry on `http://127.0.0.1` can exist without this file knowing.
 */
const PackageUrl = z.url()
/** A link the admin renders. Not a registry file, so https and nothing else. */
const HttpsUrl = z.url({ protocol: /^https$/ })

/**
 * What a version changed, as the registry extracted it from the package's `CHANGELOG.md`.
 *
 * **Plain text, and it has to stay that way.** The registry strips the markdown — a link keeps
 * its text and loses its URL, a raw tag is dropped — but this is a string from the network, so
 * it is rendered as text on this side and never as markup. Capped here too: the registry caps
 * it at 500, and a registry that stopped doing so would not get to decide how much of somebody
 * else's prose lands in the admin.
 *
 * Optional, because an index published before changelogs existed has none — and because a
 * package that never wrote one is not an error, only a card with nothing to say.
 */
const ChangesSchema = z.string().max(500)

const DownloadSchema = z.object({
  version: z.string().regex(SEMVER_RE),
  url: PackageUrl,
  sha256: Sha256Schema,
  size: z.number().int().min(1),
  changes: ChangesSchema.optional(),
})
export type Download = z.infer<typeof DownloadSchema>

export const IndexWidgetSchema = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  version: z.string().regex(SEMVER_RE),
  sdk: z.number().int().min(1),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  icon: z.string().min(1),
  /**
   * The shelf of the library the admin puts it on, before it is installed.
   *
   * Both forgiving forms on purpose, and for two different reasons. `.default('other')` is for an
   * index published before categories reached it, which must not be refused whole over a key it
   * never had. `.catch('other')` is for a registry that has grown a category this build does not
   * know: the widget belongs on a shelf that exists here rather than taking the whole index down
   * — the same rule the manifest schema applies to an installed widget.
   */
  category: z.enum(WIDGET_CATEGORIES).default('other').catch('other'),
  author: z.string().max(200).optional(),
  license: z.string().max(64).optional(),
  homepage: HttpsUrl.optional(),
  /** What the entry *advertises*. The installer consents against the downloaded manifest. */
  permissions: z.object({
    subscriptions: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    network: z.array(z.string()).default([]),
    /**
     * The connection the widget declares, copied from its manifest so the dialog can show it
     * before anything is downloaded.
     *
     * Parsed with the real schema, because this is the thing the dialog renders and the user
     * agrees to — an index advertising a declaration Fremkit would refuse should be refused
     * here rather than after the download. The grant is still checked against the manifest
     * inside the package: the entry is a shop window, and only the package was hashed.
     */
    connection: ConnectionDeclSchema.optional(),
  }),
  /** Connection types the widget's settings need, so the admin can say so before installing. */
  connections: z.array(z.string()).default([]),
  size: z.number().int().min(1),
  sha256: Sha256Schema,
  url: PackageUrl,
  publishedAt: z.iso.datetime(),
  /** What this version changed; the one thing the person pressing Update is asking about. */
  changes: ChangesSchema.optional(),
  previous: z.array(DownloadSchema).default([]),
})
export type IndexWidget = z.infer<typeof IndexWidgetSchema>

/**
 * A colour as a token holds it, held to the shape a colour has rather than to any string.
 *
 * The same expression the registry's `tools/theme.ts` refuses a package with, deliberately: the
 * four swatch tokens end up in a `style` attribute on a card, and a value that reached one
 * unchecked could close the attribute. It is not a CSS parser — Fremkit's `TokensSchema` is the
 * authority on what a token may be, and this is what must not travel that far.
 */
const ColorSchema = z.string().min(1).max(64).regex(/^[#a-zA-Z0-9(),.%\s/-]+$/)

/**
 * A theme, as the index lists it.
 *
 * No `sdk`, no `permissions`, no `connections`: a theme is a JSON file of colour tokens, it runs
 * nothing and reaches nothing, and there is nothing for a user to consent to. What it carries
 * that a widget does not is `tokens` — the four the admin paints as a swatch strip, so a theme
 * needs no preview image and a card needs no second request.
 *
 * Nothing reads this yet. It is here so an index that already lists themes parses on a Fremkit
 * that cannot install them, rather than being refused whole.
 */
export const IndexThemeSchema = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  version: z.string().regex(SEMVER_RE),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  author: z.string().max(200).optional(),
  license: z.string().max(64).optional(),
  homepage: HttpsUrl.optional(),
  tokens: z.object({ accent: ColorSchema, bg: ColorSchema, surface: ColorSchema, text: ColorSchema }),
  size: z.number().int().min(1),
  sha256: Sha256Schema,
  url: PackageUrl,
  publishedAt: z.iso.datetime(),
  changes: ChangesSchema.optional(),
  previous: z.array(DownloadSchema).default([]),
})
export type IndexTheme = z.infer<typeof IndexThemeSchema>

export const RegistryIndexSchema = z.object({
  registry: z.string().min(1).max(64),
  generatedAt: z.iso.datetime(),
  schema: z.literal(INDEX_SCHEMA),
  widgets: z.array(IndexWidgetSchema),
  /**
   * Absent from the indexes published before themes existed, which is why it defaults rather
   * than being required — and why `schema` does not move: a Fremkit that ignores the key reads
   * such an index exactly as it did before, and one that reads it finds an empty list.
   */
  themes: z.array(IndexThemeSchema).default([]),
})
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>
