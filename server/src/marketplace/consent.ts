/**
 * What an installed widget is actually allowed to do, as opposed to what it asks for.
 *
 * The manifest on disk is the *ask*: the channels it reads, the commands it sends, the hosts it
 * reaches. The consent record in the config is the *grant*: what the user was shown and accepted
 * on the day it was installed. They agree at that moment and can disagree the moment an update
 * lands — and the update brings the widget's own files, including its manifest, so a manifest
 * left to speak for itself would be a widget granting itself permissions.
 *
 * So everything downstream is handed the intersection. A channel the manifest declares and the
 * consent does not is refused exactly like one that was never declared at all: the bridge host
 * never relays it, the proxy never fetches for it. An update whose permissions grew does nothing
 * new until the user has seen the difference and said yes, and the recorded grant is what says
 * yes — not the presence of the files.
 *
 * Built-ins have no record and need none. They ship with the server, they are reviewed with it,
 * and holding them to a record nothing ever writes would simply break them.
 */

import { ConnectionDeclSchema, type ConnectionDecl, type WidgetManifest } from '../widgets/manifest.js'
import type { WidgetCatalog, WidgetSource } from '../widgets/catalog.js'
import type { Config, WidgetConsent } from '../config/schema.js'

export interface Permissions {
  subscriptions: string[]
  commands: string[]
  network: string[]
  /**
   * The connection the widget declares, if it declares one.
   *
   * A permission rather than a setting, and the one that is not a list of strings: what it grants
   * is "the server will hold your credentials for this service and make *these* requests with
   * them". Stored whole, because every part of it decides something — the kind decides where the
   * secret goes, the scheme whether it goes in the clear, the requests what may be asked for.
   */
  connection?: ConnectionDecl
}

export function permissionsOf(manifest: WidgetManifest): Permissions {
  return {
    subscriptions: [...manifest.subscriptions],
    commands: [...manifest.commands],
    network: [...manifest.permissions.network],
    ...(manifest.connection ? { connection: manifest.connection } : {}),
  }
}

/**
 * A stored grant, as the code that enforces it should read it.
 *
 * The record in the config is this machine's own file and is kept loose on purpose — a config
 * written before a rule existed must still load. But what the proxy *acts* on has to meet
 * today's rules, so the stored declaration is parsed here and a record that does not parse
 * grants no connection at all. Fail closed: a grant nobody can validate is not a grant.
 */
export function grantedPermissions(consent: WidgetConsent): Permissions {
  const g = consent.consentedPermissions
  const parsed = g.connection ? ConnectionDeclSchema.safeParse(g.connection) : undefined
  return {
    subscriptions: [...g.subscriptions],
    commands: [...g.commands],
    network: [...g.network],
    ...(parsed?.success ? { connection: parsed.data } : {}),
  }
}

/**
 * Whether two declarations are the same offer.
 *
 * Compared as a whole rather than field by field, because there is no part of a declaration that
 * could change harmlessly: a new request is a new thing the widget may ask the service for, a
 * changed kind moves the secret to a different header, `scheme: 'http'` takes the key off TLS,
 * and a changed hint is the text the user read while deciding. Serialised with sorted keys, so
 * a manifest reformatted between two versions is not a new ask.
 */
export function sameConnection(a: ConnectionDecl | undefined, b: ConnectionDecl | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return stable(a) === stable(b)
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const record = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]))
  })
}

/**
 * The entries of `asked` that `granted` does not cover, which is what an update has to show.
 *
 * Exact strings, deliberately. `synology:*` covers every Synology connection and `synology:abc` covers
 * one, so a grant of the wildcard does cover the narrower ask — but reasoning about that here
 * would mean re-implementing the channel matcher on the wrong side of a security boundary, and
 * getting it subtly wrong is how a widget ends up with more than the user agreed to. An update
 * that narrows `synology:*` to `synology:abc` therefore asks again. That is one extra dialog in a case
 * nobody has hit, against a class of mistake that is silent.
 */
function added(granted: string[], asked: string[]): string[] {
  const have = new Set(granted)
  return asked.filter((a) => !have.has(a))
}

/** What a candidate version asks for beyond what is already granted. Empty means no new dialog. */
export function addedPermissions(granted: Permissions, asked: Permissions): Permissions {
  return {
    subscriptions: added(granted.subscriptions, asked.subscriptions),
    commands: added(granted.commands, asked.commands),
    network: added(granted.network, asked.network),
    // A declaration that changed in any way is a new ask, and one that has not changed is not
    // repeated: the dialog shows what is new, and "the same connection as before" is not.
    ...(asked.connection && !sameConnection(granted.connection, asked.connection)
      ? { connection: asked.connection }
      : {}),
  }
}

export function isEmpty(p: Permissions): boolean {
  return p.subscriptions.length === 0 && p.commands.length === 0 && p.network.length === 0
    && p.connection === undefined
}

export const NO_PERMISSIONS: Permissions = { subscriptions: [], commands: [], network: [] }

function merge(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

/**
 * Everything either side names. Used for "what the user has seen": what they already granted,
 * plus what the dialog they just answered listed.
 */
export function unionPermissions(a: Permissions, b: Permissions): Permissions {
  return {
    subscriptions: merge(a.subscriptions, b.subscriptions),
    commands: merge(a.commands, b.commands),
    network: merge(a.network, b.network),
    // The later one wins: `b` is what the dialog just listed, `a` what was granted before.
    ...(b.connection ?? a.connection ? { connection: b.connection ?? a.connection } : {}),
  }
}

function intersect(granted: string[], asked: string[]): string[] {
  const have = new Set(granted)
  return asked.filter((a) => have.has(a))
}

/**
 * The manifest as the rest of the server and the admin should read it.
 *
 * `consent` is undefined for a built-in, and the manifest comes back untouched. For an installed
 * widget the three permission lists are narrowed to what was granted; everything else — the
 * sizes, the settings schema, the name — is the widget's own business and is left alone.
 */
export function grantedManifest(manifest: WidgetManifest, consent: WidgetConsent | undefined): WidgetManifest {
  if (!consent) return manifest
  const g = grantedPermissions(consent)
  return {
    ...manifest,
    subscriptions: intersect(g.subscriptions, manifest.subscriptions),
    commands: intersect(g.commands, manifest.commands),
    permissions: { ...manifest.permissions, network: intersect(g.network, manifest.permissions.network) },
    // Granted only while it is the declaration that was agreed to. A widget that edits its own
    // manifest on disk — or an update that slipped past the dialog — reaches nothing, exactly
    // like a channel it was never granted.
    ...(manifest.connection && sameConnection(g.connection, manifest.connection)
      ? { connection: manifest.connection }
      : { connection: undefined }),
  }
}

/**
 * The manifest to hand the bridge host and the proxy, given where the widget came from.
 *
 * An installed widget with no consent record gets *nothing*, rather than everything: a record
 * can be missing because a folder was dropped into `data/widgets` by hand, or because a restore
 * brought a config back without one, and neither is a user saying yes. The widget still renders
 * and still says what it wants in the admin — it simply reaches nothing until it is installed
 * through the admin, which is what writes the record.
 */
export function effectiveManifest(
  manifest: WidgetManifest,
  source: WidgetSource,
  consent: WidgetConsent | undefined,
): WidgetManifest {
  if (source === 'builtin') return manifest
  if (!consent) {
    return {
      ...manifest, subscriptions: [], commands: [], connection: undefined,
      permissions: { ...manifest.permissions, network: [] },
    }
  }
  return grantedManifest(manifest, consent)
}

/** `effectiveManifest` for one id, looked up in the catalogue and the config. */
export function grantedFor(catalog: WidgetCatalog, config: Config, id: string): WidgetManifest | undefined {
  const entry = catalog.entry(id)
  if (!entry) return undefined
  return effectiveManifest(entry.manifest, entry.source, config.marketplace.installed[id])
}

/** Every manifest the catalogue holds, as the admin and the bridge should read them. */
export function grantedCatalog(catalog: WidgetCatalog, config: Config): Map<string, WidgetManifest> {
  return new Map([...catalog.entries].map(([id, e]) =>
    [id, effectiveManifest(e.manifest, e.source, config.marketplace.installed[id])]))
}
