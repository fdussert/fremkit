/**
 * `/api/marketplace`: what can be installed, and what installing it means.
 *
 * Four writes — install, update, uninstall, refresh — and one read. The writes go through the
 * Origin gate like every other write, and `install` additionally refuses a cross-site *fetch*:
 * it makes the server go out onto the network and put files on the disk, which is not something
 * another page gets to start even without reading the answer.
 *
 * Every error the user sees is a fixed translated sentence. Never the upstream body, never the
 * URL, never an exception message: an installer that quotes what a remote server said is a
 * remote server writing into the admin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { WIDGET_ID_RE, type Config, type WidgetConsent } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import type { WidgetCatalog } from '../widgets/catalog.js'
import type { ThemeCatalog } from '../themes/catalog.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { tr, type MessageKey } from '../i18n.js'
import { Registry, RegistryError, releaseOf } from './registry.js'
import { InstallError, readPackage, removePackage, writePackage, type PackageKind, type ReadPackageResult } from './install.js'
import { NO_PERMISSIONS, addedPermissions, grantedPermissions, isEmpty, permissionsOf, unionPermissions, type Permissions } from './consent.js'
import type { IndexTheme, IndexWidget, RegistryIndex } from './index-schema.js'
import { declaredBy, isDeclaredType } from '../connections/declared.js'
import { ConnectionDeclSchema } from '../widgets/manifest.js'
import { compareSemver } from './semver.js'

export interface MarketplaceOptions {
  store: ConfigStore
  catalog: WidgetCatalog
  themes: ThemeCatalog
  registry: Registry
  /** `<dataDir>/widgets`; the only folder the widget path writes to. */
  installedDir: string
  /** `<dataDir>/themes`; the only folder the theme path writes to. */
  installedThemesDir: string
}

/** One route's outcome, as a status and a body rather than as an HTTP answer. */
type Answer = { status: number; body: Record<string, unknown> }

const PermissionSetSchema = z.object({
  subscriptions: z.array(z.string().max(200)).max(200).default([]),
  commands: z.array(z.string().max(200)).max(200).default([]),
  network: z.array(z.string().max(253)).max(200).default([]),
  /**
   * The connection declaration the dialog rendered, when the widget declares one.
   *
   * It has to be here, and it was not: without it the server dropped the one part of the set the
   * user had just agreed to, found it "new" again against the package, and answered 409 for
   * ever — the dialog reopened on the same text, and no amount of pressing Install helped.
   */
  connection: ConnectionDeclSchema.optional(),
})

/**
 * What is being installed. Absent means `widget`, which is what every client sent before themes
 * could be installed and what the great majority of calls still mean.
 */
const KindSchema = z.enum(['widget', 'theme']).default('widget')

const InstallBody = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  kind: KindSchema,
  version: z.string().min(1).max(64).optional(),
  /**
   * **What the dialog listed**, not "a dialog was answered".
   *
   * It used to be a boolean, and that was the hole: the dialog is drawn from the *index* entry,
   * the record was written from the *package* manifest, and only the package is hashed. A
   * registry advertising `subscriptions: ["system"]` and shipping a zip asking for
   * `["system", "homey:*"]` plus a network host had all of it recorded as consented the moment
   * the button was pressed — the user agreed to one list and granted another.
   *
   * So the client sends the set it rendered, the server checks the package's ask against *that*
   * union the existing grant, and a package asking for more than was shown is refused with the
   * real difference. `false` (or absent) means nothing was shown at all.
   */
  consent: z.union([z.literal(false), PermissionSetSchema]).default(false),
})

const UninstallBody = z.object({ id: z.string().regex(WIDGET_ID_RE), kind: KindSchema })

/** Granting or revoking one widget's use of another's declared connection. */
const ShareBody = z.object({
  id: z.string().regex(WIDGET_ID_RE),
  connectionId: z.string().min(1).max(64),
  allow: z.boolean(),
})

/**
 * "Update everything waiting", with the consent for each one.
 *
 * A map rather than a flag: the dialog lists the widgets and what each is newly asking for, and
 * what it listed is what arrives here. A widget whose entry is missing — or `false` — is held to
 * the same rule as a single update with no consent, so a bulk update cannot grant in bulk what
 * was never shown.
 */
const UpdateAllBody = z.object({
  consent: z.record(z.string().regex(WIDGET_ID_RE), z.union([z.literal(false), PermissionSetSchema])).default({}),
})

/** One widget's outcome in a bulk update. `newPermissions` means it was not attempted. */
export interface UpdateAllResult {
  id: string
  ok: boolean
  version?: string
  error?: string
  newPermissions?: Permissions
}

/** One row of what the admin shows: the index entry, plus what this machine makes of it. */
export interface MarketplaceEntry extends IndexWidget {
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  /** The candidate needs an SDK this build does not have: the answer is "update Fremkit". */
  sdkTooNew: boolean
  /** Installing or updating would ask for something the record does not already cover. */
  consentNeeded: boolean
  /** Exactly what that something is, so the dialog does not have to guess. */
  newPermissions: Permissions
  /** A built-in already owns this id, so it can never be installed. */
  shadowsBuiltin: boolean
  /**
   * The pages this widget is placed on, by name — empty for almost every row.
   *
   * A dashboard can hold an instance of a widget that is not installed: the widget moved to the
   * registry, or the config came from another machine. The tile then paints as missing, and
   * without this nobody could tell the admin that the thing it is missing is one click away.
   * The same list an uninstall uses to say what it would break, computed for every row at once.
   */
  placedOn: string[]
}

/**
 * One theme as the admin shows it. No `permissions`, no `consentNeeded`, no `sdkTooNew`: there is
 * nothing in a file of colour tokens to consent to and nothing in it that a newer Fremkit would
 * be needed to run. What it carries instead is `tokens`, the four the card paints as a swatch
 * strip — so a theme needs no preview image and a card needs no second request.
 */
export interface MarketplaceThemeEntry extends IndexTheme {
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  /** A built-in already owns this id, so it can never be installed. */
  shadowsBuiltin: boolean
  /** True while the screen is painted with it: removing it is refused until another is chosen. */
  inUse: boolean
}

function themeEntryFor(theme: IndexTheme, config: Config, themes: ThemeCatalog): MarketplaceThemeEntry {
  // `installed` is keyed by id across both kinds, so the record has to say it is a theme's: a
  // widget called `nuit` would otherwise lend its version to a theme of the same name.
  const record = recordOf(config, theme.id, 'theme')
  const local = themes.entry(theme.id)
  const installed = record !== undefined && local?.source === 'installed'
  return {
    ...theme,
    installed,
    installedVersion: installed ? record.version : null,
    updateAvailable: installed && compareSemver(theme.version, record.version) > 0,
    shadowsBuiltin: local?.source === 'builtin',
    inUse: config.display.theme === theme.id,
  }
}

/**
 * The install record for an id, but only when it is the right kind's.
 *
 * `marketplace.installed` is one map keyed by id, and a widget and a theme may legitimately
 * share a name — the two live in different folders and neither shadows the other. What they
 * cannot share is the record, which holds a version and a grant. Reading one as the other is how
 * a theme reports the widget's version, or a widget is granted a theme's empty permissions.
 */
function recordOf(config: Config, id: string, kind: PackageKind): WidgetConsent | undefined {
  const record = config.marketplace.installed[id]
  return record && record.kind === kind ? record : undefined
}

function entryFor(widget: IndexWidget, config: Config, catalog: WidgetCatalog): MarketplaceEntry {
  const record = recordOf(config, widget.id, 'widget')
  const local = catalog.entry(widget.id)
  const installed = record !== undefined && local?.source === 'installed'
  const installedVersion = installed ? record.version : null
  const asked: Permissions = {
    subscriptions: widget.permissions.subscriptions,
    commands: widget.permissions.commands,
    network: widget.permissions.network,
  }
  const granted: Permissions = record ? grantedPermissions(record) : NO_PERMISSIONS
  const added = addedPermissions(granted, asked)
  return {
    ...widget,
    installed,
    installedVersion,
    updateAvailable: installed && compareSemver(widget.version, record.version) > 0,
    sdkTooNew: widget.sdk > SDK_VERSION,
    consentNeeded: !isEmpty(added),
    newPermissions: added,
    shadowsBuiltin: local?.source === 'builtin',
    placedOn: usedBy(config, widget.id),
  }
}

/** Where a widget is still placed, so an uninstall can say what would break. */
export function usedBy(config: Config, id: string): string[] {
  const places: string[] = []
  for (const page of config.pages) {
    if (page.widgets.some((w) => w.widgetId === id)) places.push(page.name)
  }
  if ((config.display.navWidgets ?? []).some((w) => w.widgetId === id)) {
    places.push(tr(config.locale, 'marketplace.navBar'))
  }
  return places
}

/**
 * The connections that belong to a widget's declared type, by id and name.
 *
 * Named on an uninstall so the admin can ask "delete the key too?". Nothing here deletes
 * anything: a credential the user entered is theirs to keep, and reinstalling the widget finds
 * the connection exactly where it was.
 */
export function declaredConnections(config: Config, widgetId: string): { id: string; name: string }[] {
  return config.connections
    .filter((c) => declaredBy(c.type) === widgetId)
    .map((c) => ({ id: c.id, name: c.name }))
}

export async function marketplaceRoutes(app: FastifyInstance, opts: MarketplaceOptions): Promise<void> {
  const { store, catalog, themes, registry, installedDir, installedThemesDir } = opts
  const locale = (): Config['locale'] => store.get().locale
  const fail = (key: MessageKey): { errors: string[] } => ({ errors: [tr(locale(), key)] })

  /**
   * The widget ids currently being installed or removed.
   *
   * Two requests for the same id would race on the same folder: both stage, both rename, and
   * which version survives depends on the order two `rename` calls happened to land in. The
   * second is refused rather than queued — a person pressing Install twice wants one install,
   * not two, and a queue would just make the duplicate arrive later.
   */
  const working = new Set<string>()

  /** Runs `work` while holding the id, or answers `null` when somebody else already holds it. */
  const withLock = async <T>(id: string, work: () => Promise<T>): Promise<T | null> => {
    if (working.has(id)) return null
    working.add(id)
    try { return await work() }
    finally { working.delete(id) }
  }

  const exclusive = async (id: string, reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> => {
    const out = await withLock(id, work)
    if (out === null) return reply.code(409).send(fail('marketplace.busy'))
    return out
  }

  /** The index, plus what this machine makes of every row. `offline` when it could not be read. */
  const view = async (force = false): Promise<{ registry: string | null; generatedAt: string | null; widgets: MarketplaceEntry[]; themes: MarketplaceThemeEntry[]; offline: boolean; sdk: number }> => {
    let index: RegistryIndex | null = null
    let offline = false
    try { index = await registry.index(force) } catch { offline = true; index = registry.last }
    const config = store.get()
    return {
      registry: index?.registry ?? null,
      generatedAt: index?.generatedAt ?? null,
      widgets: (index?.widgets ?? []).map((w) => entryFor(w, config, catalog)),
      themes: (index?.themes ?? []).map((t) => themeEntryFor(t, config, themes)),
      offline,
      sdk: SDK_VERSION,
    }
  }

  app.get('/api/marketplace', async (req, reply) => {
    // A read that makes the server go out onto the network on the caller's behalf, so the same
    // refusal as the proxy and the favicon route: `Sec-Fetch-Site` is the only signal a
    // cross-site `<img>` or `fetch` in `no-cors` mode gives, and it is enough.
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    return view()
  })

  app.post('/api/marketplace/refresh', async (_req, reply) => {
    const answer = await view(true)
    if (answer.offline) return reply.code(503).send(fail('marketplace.unreachable'))
    return answer
  })

  /**
   * One install or update, as a status and a body rather than as an HTTP answer.
   *
   * Written this way so "update all" is the same code path run in a series, and not a second,
   * subtly different one: every check below — the built-in ids, the SDK, the hash, the version
   * in the package, the consent — has to hold for each widget of a bulk update exactly as it
   * holds for a single one.
   */
  const installOne = async (
    args: { id: string; version?: string; consent: Permissions | false; mode: 'install' | 'update' },
    log: FastifyRequest['log'],
  ): Promise<Answer> => {
    const { id, version, consent, mode } = args

    // The *folder* names, not the entries: a built-in whose manifest fails to parse is an error
    // rather than an entry, and it would have freed its id for an installed widget to take.
    if (catalog.builtinIds.has(id)) return { status: 409, body: fail('marketplace.builtinId') }
    // One record per id across both kinds: installing over the other kind's would take its
    // version and its grant with it. Refused rather than merged — the user removes one first.
    const held = store.get().marketplace.installed[id]
    if (held && held.kind !== 'widget') return { status: 409, body: fail('marketplace.idIsATheme') }
    if (mode === 'update' && !held) {
      return { status: 409, body: fail('marketplace.notInstalled') }
    }

    let index: RegistryIndex
    try { index = await registry.index() } catch { return { status: 503, body: fail('marketplace.unreachable') } }
    const widget = index.widgets.find((w) => w.id === id)
    if (!widget) return { status: 404, body: fail('marketplace.unknownWidget') }
    if (widget.sdk > SDK_VERSION) return { status: 409, body: fail('marketplace.sdkTooNew') }
    const release = releaseOf(widget, version)
    if (!release) return { status: 404, body: fail('marketplace.unknownVersion') }

    let zip: Buffer
    try { zip = await registry.download(release) }
    catch (err) { return { status: 502, body: fail(err instanceof RegistryError ? err.key : 'marketplace.unreachable') } }

    let pkg: ReturnType<typeof readPackage>
    try { pkg = readPackage(zip, { id, sha256: release.sha256, size: release.size }, locale()) }
    catch (err) { return { status: 422, body: fail(err instanceof InstallError ? err.key : 'marketplace.badPackage') } }

    // The version in the package must be the one the index sent us to. A zip at the `1.0.0` URL
    // claiming `9.9.9` would otherwise be recorded as 9.9.9, and `updateAvailable` would be
    // false for the rest of that install's life.
    if (pkg.kind !== 'widget') return { status: 422, body: fail('marketplace.badPackage') }
    if (pkg.version !== release.version) return { status: 422, body: fail('marketplace.badManifest') }

    // What the widget asks comes from the manifest *inside* the package, never from the index
    // entry that advertised it: the entry is a shop window, and only one of the two was hashed.
    const record = store.get().marketplace.installed[id]
    const installed = Boolean(record) && catalog.entry(id)?.source === 'installed'
    // A record whose folder is gone is not a grant: a reinstall is an install, and pre-approving
    // it from a stale record would skip the dialog for a widget that is no longer here.
    const granted: Permissions = record && installed ? grantedPermissions(record) : NO_PERMISSIONS
    const asked = permissionsOf(pkg.manifest)
    // Everything the user has seen: what they already hold, plus what the dialog they answered
    // listed. Anything the package asks for beyond that was never shown to anybody.
    const shown = consent === false ? granted : unionPermissions(granted, consent)
    if (!isEmpty(addedPermissions(shown, asked))) {
      // The difference reported is the one against the *grant*, which is what a dialog has to
      // show — and when the index and the package disagree, this is the honest path: the user is
      // asked again, on the package's real ask.
      return {
        status: 409,
        body: { ...fail('marketplace.consentRequired'), newPermissions: addedPermissions(granted, asked) },
      }
    }

    try { await writePackage(installedDir, id, pkg.files) }
    catch (err) { log.warn({ err }, 'marketplace install could not write the widget'); return { status: 500, body: fail('marketplace.writeFailed') } }

    await catalog.scan()

    const consented: WidgetConsent = {
      kind: 'widget',
      // An update keeps what was shared with it: the user agreed to that connection for this
      // widget, and a new version of the same widget is not a different widget.
      sharedConnections: record?.sharedConnections ?? [],
      version: pkg.version,
      registry: index.registry,
      // What was *shown*, which is what the package asks for — not the union with an older
      // grant, so uninstalling a permission by publishing a narrower version actually narrows it.
      consentedPermissions: asked,
      installedAt: new Date().toISOString(),
    }
    try {
      await store.update((config) => ({
        ...config,
        marketplace: { ...config.marketplace, installed: { ...config.marketplace.installed, [id]: consented } },
      }))
    } catch (err) {
      // The files are on disk but nothing granted them anything; `effectiveManifest` gives a
      // widget with no record nothing at all, so this fails closed rather than open.
      log.warn({ err }, 'marketplace install could not record the consent')
      return { status: 500, body: fail('marketplace.writeFailed') }
    }

    return { status: 200, body: { ok: true, id, version: pkg.version, consentedPermissions: asked } }
  }

  /**
   * The same journey for a theme, which is short enough to be worth writing out rather than
   * threading a kind through every line above.
   *
   * There is no SDK to check and no consent to ask for: a theme is a JSON file of colour tokens
   * that runs nothing, reaches nothing and subscribes to nothing, so a dialog would be asking
   * the user to approve an empty list. Everything that is *not* different stays identical —
   * the hash before anything is parsed, the id deciding the folder, the version in the package
   * matching the release, the staged-and-renamed write, the record in the config.
   */
  const installTheme = async (
    args: { id: string; version?: string; mode: 'install' | 'update' },
    log: FastifyRequest['log'],
  ): Promise<Answer> => {
    const { id, version, mode } = args

    if (themes.builtinIds.has(id)) return { status: 409, body: fail('marketplace.builtinThemeId') }
    const held = store.get().marketplace.installed[id]
    if (held && held.kind !== 'theme') return { status: 409, body: fail('marketplace.idIsAWidget') }
    if (mode === 'update' && !held) {
      return { status: 409, body: fail('marketplace.themeNotInstalled') }
    }

    let index: RegistryIndex
    try { index = await registry.index() } catch { return { status: 503, body: fail('marketplace.unreachable') } }
    const entry = index.themes.find((t) => t.id === id)
    if (!entry) return { status: 404, body: fail('marketplace.unknownTheme') }
    const release = releaseOf(entry, version)
    if (!release) return { status: 404, body: fail('marketplace.unknownVersion') }

    let zip: Buffer
    try { zip = await registry.download(release, 'theme') }
    catch (err) { return { status: 502, body: fail(err instanceof RegistryError ? err.key : 'marketplace.unreachable') } }

    let pkg: ReadPackageResult
    try { pkg = readPackage(zip, { id, sha256: release.sha256, size: release.size, kind: 'theme' }, locale()) }
    catch (err) { return { status: 422, body: fail(err instanceof InstallError ? err.key : 'marketplace.badPackage') } }
    if (pkg.kind !== 'theme') return { status: 422, body: fail('marketplace.badPackage') }
    if (pkg.version !== release.version) return { status: 422, body: fail('marketplace.badTheme') }

    try { await writePackage(installedThemesDir, id, pkg.files) }
    catch (err) { log.warn({ err }, 'marketplace install could not write the theme'); return { status: 500, body: fail('marketplace.writeFailed') } }

    await themes.scan()

    const record: WidgetConsent = {
      kind: 'theme',
      // A theme reaches nothing; the field exists once, on the record, for both kinds.
      sharedConnections: [],
      version: pkg.version,
      registry: index.registry,
      // Nothing to consent to, and an empty set says exactly that — rather than a missing key
      // that would read as "not recorded yet".
      consentedPermissions: NO_PERMISSIONS,
      installedAt: new Date().toISOString(),
    }
    try {
      await store.update((config) => ({
        ...config,
        marketplace: { ...config.marketplace, installed: { ...config.marketplace.installed, [id]: record } },
      }))
    } catch (err) {
      log.warn({ err }, 'marketplace install could not record the theme')
      return { status: 500, body: fail('marketplace.writeFailed') }
    }

    return { status: 200, body: { ok: true, id, kind: 'theme', version: pkg.version } }
  }

  const doInstall = async (req: FastifyRequest, reply: FastifyReply, mode: 'install' | 'update'): Promise<unknown> => {
    // A write *and* an outbound fetch *and* a disk write. The Origin gate covers the first;
    // this covers a page that never reads the answer and does not care.
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    const parsed = InstallBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))
    const { id, kind, version, consent } = parsed.data
    const out = kind === 'theme'
      ? await installTheme({ id, version, mode }, req.log)
      : await installOne({ id, version, consent, mode }, req.log)
    return reply.code(out.status).send(out.body)
  }

  /** The id for the lock, read before the body is trusted for anything else. */
  const lockId = (body: unknown): string | null => {
    const id = (body as { id?: unknown } | null)?.id
    return typeof id === 'string' && WIDGET_ID_RE.test(id) ? id : null
  }

  app.post('/api/marketplace/install', async (req, reply) => {
    const id = lockId(req.body)
    if (!id) return doInstall(req, reply, 'install')
    return exclusive(id, reply, () => doInstall(req, reply, 'install'))
  })
  app.post('/api/marketplace/update', async (req, reply) => {
    const id = lockId(req.body)
    if (!id) return doInstall(req, reply, 'update')
    return exclusive(id, reply, () => doInstall(req, reply, 'update'))
  })

  /**
   * A series of installs or updates, each through `installOne` and each under the per-id lock.
   *
   * **Never stops on a failure**: a run of five where the second package does not match its hash
   * must still do the other four, and the answer has to say which was which. So the caller
   * answers 200 with a result per widget rather than the first error, and paints them per row.
   */
  const runSeries = async (
    widgets: IndexWidget[],
    mode: 'install' | 'update',
    consents: Record<string, Permissions | false>,
    log: FastifyRequest['log'],
  ): Promise<UpdateAllResult[]> => {
    const results: UpdateAllResult[] = []
    for (const widget of widgets) {
      const out = await withLock(widget.id, () =>
        installOne({ id: widget.id, consent: consents[widget.id] ?? false, mode }, log))
      if (out === null) { results.push({ id: widget.id, ok: false, error: tr(locale(), 'marketplace.busy') }); continue }
      if (out.status === 200) {
        results.push({ id: widget.id, ok: true, version: String(out.body.version ?? '') })
        continue
      }
      const errors = out.body.errors
      results.push({
        id: widget.id,
        ok: false,
        error: Array.isArray(errors) ? String(errors[0]) : tr(locale(), 'marketplace.writeFailed'),
        ...(out.body.newPermissions ? { newPermissions: out.body.newPermissions as Permissions } : {}),
      })
    }
    return results
  }

  /** The index, or a 503: both series routes need it before they can decide anything. */
  const seriesIndex = async (reply: FastifyReply): Promise<RegistryIndex | null> => {
    try { return await registry.index() }
    catch { void reply.code(503).send(fail('marketplace.unreachable')); return null }
  }

  /** Updates every installed widget the registry has something newer for. */
  app.post('/api/marketplace/update-all', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    const parsed = UpdateAllBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))

    const index = await seriesIndex(reply)
    if (!index) return reply

    const config = store.get()
    // What the server itself thinks is waiting, not what the caller listed: a client asking to
    // update something that is not installed, or not out of date, is asking for an install.
    const waiting = index.widgets.filter((w) => {
      const record = config.marketplace.installed[w.id]
      return Boolean(record) && catalog.entry(w.id)?.source === 'installed'
        && compareSemver(w.version, record.version) > 0
    })
    return reply.send({ results: await runSeries(waiting, 'update', parsed.data.consent, req.log) })
  })

  /**
   * Installs every registry widget a screen already places and this machine does not have.
   *
   * The upgrade path for a dashboard built before a widget moved to the registry: the tiles are
   * there, the folders are not, and doing them one at a time means reading the same consent
   * dialog eight times. Which widgets those are is the server's answer, from its own config and
   * its own catalogue — a client asking to install something nothing places is asking for an
   * ordinary install, and gets the ordinary route.
   */
  app.post('/api/marketplace/install-missing', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    const parsed = UpdateAllBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))

    const index = await seriesIndex(reply)
    if (!index) return reply

    const config = store.get()
    // `sdkTooNew` is excluded here and not left to `installOne` to refuse: the panel does not
    // list such a widget in the dialog, so a result coming back for it would name something the
    // user was never shown and could do nothing about. The answer to that one is "update
    // Fremkit", and it is already on its own row.
    const missing = index.widgets.filter((w) =>
      usedBy(config, w.id).length > 0 && catalog.entry(w.id) === undefined && w.sdk <= SDK_VERSION)
    return reply.send({ results: await runSeries(missing, 'install', parsed.data.consent, req.log) })
  })

  /**
   * "Reuse this connection for that widget too?", and the undoing of it.
   *
   * A grant, so it goes through the same door every other grant does — the config, on the
   * widget's consent record — rather than becoming a property of the connection. Two widgets
   * wanting the same Homey should cost one credential and one form, and revoking should be
   * deleting one line rather than hunting for a copy.
   *
   * The connection has to be a *declared* one. Sharing can widen a widget's reach only to
   * something of exactly the kind it could have asked the user to create for it; a coded type's
   * credentials — a Synology password, a Bambu access code — are never on offer here.
   */
  app.post('/api/marketplace/share', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    const parsed = ShareBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))
    const { id, connectionId, allow } = parsed.data

    const config = store.get()
    if (!recordOf(config, id, 'widget')) return reply.code(404).send(fail('marketplace.notInstalled'))
    const connection = config.connections.find((c) => c.id === connectionId)
    if (allow && (!connection || !isDeclaredType(connection.type))) {
      return reply.code(409).send(fail('marketplace.notShareable'))
    }

    await store.update((c) => {
      const record = c.marketplace.installed[id]
      if (!record) return c
      const held = new Set(record.sharedConnections)
      if (allow) held.add(connectionId)
      else held.delete(connectionId)
      return {
        ...c,
        marketplace: {
          ...c.marketplace,
          installed: { ...c.marketplace.installed, [id]: { ...record, sharedConnections: [...held] } },
        },
      }
    })
    return reply.send({ ok: true, id, connectionId, allow })
  })

  app.post('/api/marketplace/uninstall', async (req, reply) => {
    const parsed = UninstallBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))
    const { id, kind } = parsed.data
    return exclusive(id, reply, () => doUninstall(id, kind, req, reply))
  })

  const doUninstall = async (id: string, kind: PackageKind, req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const config = store.get()
    if (kind === 'theme') return uninstallTheme(id, req, reply)
    if (!recordOf(config, id, 'widget') && catalog.entry(id)?.source !== 'installed') {
      return reply.code(404).send(fail('marketplace.notInstalled'))
    }
    // Refused rather than cascaded: removing the widget would leave holes in pages the user
    // never asked to change, and the admin can name the places instead.
    const places = usedBy(config, id)
    if (places.length) {
      return reply.code(409).send({ errors: [tr(config.locale, 'marketplace.stillUsed', { places: places.join(', ') })], places })
    }

    try { await removePackage(installedDir, id) }
    catch (err) { req.log.warn({ err }, 'marketplace uninstall could not remove the widget'); return reply.code(500).send(fail('marketplace.writeFailed')) }
    await catalog.scan()
    await store.update((c) => {
      const installed = { ...c.marketplace.installed }
      delete installed[id]
      return { ...c, marketplace: { ...c.marketplace, installed } }
    })
    // The connections this widget's declared type owns are left alone — see `syncDeclaredTypes`
    // — but the answer names them, so the admin can offer to delete them and their keys too
    // rather than leaving a credential behind with nothing to explain it.
    return reply.send({ ok: true, id, connections: declaredConnections(config, id) })
  }

  /**
   * Removing an installed theme.
   *
   * The refusal is the same idea as a widget's, for a different reason: a placed widget would
   * leave a hole in a page, and a theme in use would leave the screen repainting itself in
   * something the user never chose. Both are the user's decision to make first, and both name
   * what is in the way rather than cascading.
   */
  const uninstallTheme = async (id: string, req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const config = store.get()
    if (!recordOf(config, id, 'theme') && themes.entry(id)?.source !== 'installed') {
      return reply.code(404).send(fail('marketplace.themeNotInstalled'))
    }
    if (config.display.theme === id) return reply.code(409).send(fail('marketplace.themeInUse'))

    try { await removePackage(installedThemesDir, id) }
    catch (err) { req.log.warn({ err }, 'marketplace uninstall could not remove the theme'); return reply.code(500).send(fail('marketplace.writeFailed')) }
    await themes.scan()
    await store.update((c) => {
      const installed = { ...c.marketplace.installed }
      delete installed[id]
      return { ...c, marketplace: { ...c.marketplace, installed } }
    })
    return reply.send({ ok: true, id, kind: 'theme' })
  }
}
