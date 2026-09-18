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

import { z } from 'zod'
import { SEMVER_RE } from '../widgets/manifest.js'
import { WIDGET_ID_RE } from '../config/schema.js'

/** The version of the index format this build reads. */
export const INDEX_SCHEMA = 1

const LocalizedTextSchema = z.union([z.string(), z.record(z.string(), z.string())])
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const HttpsUrl = z.url({ protocol: /^https$/ })

const DownloadSchema = z.object({
  version: z.string().regex(SEMVER_RE),
  url: HttpsUrl,
  sha256: Sha256Schema,
  size: z.number().int().min(1),
})
export type Download = z.infer<typeof DownloadSchema>

export const IndexWidgetSchema = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  version: z.string().regex(SEMVER_RE),
  sdk: z.number().int().min(1),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema,
  icon: z.string().min(1),
  author: z.string().max(200).optional(),
  license: z.string().max(64).optional(),
  homepage: HttpsUrl.optional(),
  /** What the entry *advertises*. The installer consents against the downloaded manifest. */
  permissions: z.object({
    subscriptions: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    network: z.array(z.string()).default([]),
  }),
  /** Connection types the widget's settings need, so the admin can say so before installing. */
  connections: z.array(z.string()).default([]),
  size: z.number().int().min(1),
  sha256: Sha256Schema,
  url: HttpsUrl,
  publishedAt: z.iso.datetime(),
  previous: z.array(DownloadSchema).default([]),
})
export type IndexWidget = z.infer<typeof IndexWidgetSchema>

export const RegistryIndexSchema = z.object({
  registry: z.string().min(1).max(64),
  generatedAt: z.iso.datetime(),
  schema: z.literal(INDEX_SCHEMA),
  widgets: z.array(IndexWidgetSchema),
})
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>
