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
import { isCrossSiteFetch } from '../http/guard.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { tr, type MessageKey } from '../i18n.js'
import { Registry, RegistryError, releaseOf } from './registry.js'
import { InstallError, readPackage, removePackage, writePackage } from './install.js'
import { NO_PERMISSIONS, addedPermissions, isEmpty, permissionsOf, unionPermissions, type Permissions } from './consent.js'
import type { IndexWidget, RegistryIndex } from './index-schema.js'
import { compareSemver } from './semver.js'

export interface MarketplaceOptions {
  store: ConfigStore
  catalog: WidgetCatalog
  registry: Registry
  /** `<dataDir>/widgets`; the only folder anything here writes to. */
  installedDir: string
}

const PermissionSetSchema = z.object({
  subscriptions: z.array(z.string().max(200)).max(200).default([]),
  commands: z.array(z.string().max(200)).max(200).default([]),
  network: z.array(z.string().max(253)).max(200).default([]),
})

const InstallBody = z.object({
  id: z.string().regex(WIDGET_ID_RE),
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

const UninstallBody = z.object({ id: z.string().regex(WIDGET_ID_RE) })

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
}

function entryFor(widget: IndexWidget, config: Config, catalog: WidgetCatalog): MarketplaceEntry {
  const record = config.marketplace.installed[widget.id]
  const local = catalog.entry(widget.id)
  const installed = Boolean(record) && local?.source === 'installed'
  const installedVersion = installed ? record.version : null
  const asked: Permissions = {
    subscriptions: widget.permissions.subscriptions,
    commands: widget.permissions.commands,
    network: widget.permissions.network,
  }
  const granted: Permissions = record
    ? record.consentedPermissions
    : { subscriptions: [], commands: [], network: [] }
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

export async function marketplaceRoutes(app: FastifyInstance, opts: MarketplaceOptions): Promise<void> {
  const { store, catalog, registry, installedDir } = opts
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

  const exclusive = async (id: string, reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> => {
    if (working.has(id)) return reply.code(409).send(fail('marketplace.busy'))
    working.add(id)
    try { return await work() }
    finally { working.delete(id) }
  }

  /** The index, plus what this machine makes of every row. `offline` when it could not be read. */
  const view = async (force = false): Promise<{ registry: string | null; generatedAt: string | null; widgets: MarketplaceEntry[]; offline: boolean; sdk: number }> => {
    let index: RegistryIndex | null = null
    let offline = false
    try { index = await registry.index(force) } catch { offline = true; index = registry.last }
    const config = store.get()
    return {
      registry: index?.registry ?? null,
      generatedAt: index?.generatedAt ?? null,
      widgets: (index?.widgets ?? []).map((w) => entryFor(w, config, catalog)),
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

  const doInstall = async (req: FastifyRequest, reply: FastifyReply, mode: 'install' | 'update'): Promise<unknown> => {
    // A write *and* an outbound fetch *and* a disk write. The Origin gate covers the first;
    // this covers a page that never reads the answer and does not care.
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ errors: [tr(locale(), 'http.originNotAllowed')] })
    const parsed = InstallBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))
    const { id, version, consent } = parsed.data

    // The *folder* names, not the entries: a built-in whose manifest fails to parse is an error
    // rather than an entry, and it would have freed its id for an installed widget to take.
    if (catalog.builtinIds.has(id)) return reply.code(409).send(fail('marketplace.builtinId'))
    if (mode === 'update' && !store.get().marketplace.installed[id]) {
      return reply.code(409).send(fail('marketplace.notInstalled'))
    }

    let index: RegistryIndex
    try { index = await registry.index() } catch { return reply.code(503).send(fail('marketplace.unreachable')) }
    const widget = index.widgets.find((w) => w.id === id)
    if (!widget) return reply.code(404).send(fail('marketplace.unknownWidget'))
    if (widget.sdk > SDK_VERSION) return reply.code(409).send(fail('marketplace.sdkTooNew'))
    const release = releaseOf(widget, version)
    if (!release) return reply.code(404).send(fail('marketplace.unknownVersion'))

    let zip: Buffer
    try { zip = await registry.download(release) }
    catch (err) { return reply.code(502).send(fail(err instanceof RegistryError ? err.key : 'marketplace.unreachable')) }

    let pkg: ReturnType<typeof readPackage>
    try { pkg = readPackage(zip, { id, sha256: release.sha256, size: release.size }, locale()) }
    catch (err) { return reply.code(422).send(fail(err instanceof InstallError ? err.key : 'marketplace.badPackage')) }

    // The version in the package must be the one the index sent us to. A zip at the `1.0.0` URL
    // claiming `9.9.9` would otherwise be recorded as 9.9.9, and `updateAvailable` would be
    // false for the rest of that install's life.
    if (pkg.manifest.version !== release.version) return reply.code(422).send(fail('marketplace.badManifest'))

    // What the widget asks comes from the manifest *inside* the package, never from the index
    // entry that advertised it: the entry is a shop window, and only one of the two was hashed.
    const record = store.get().marketplace.installed[id]
    const installed = Boolean(record) && catalog.entry(id)?.source === 'installed'
    // A record whose folder is gone is not a grant: a reinstall is an install, and pre-approving
    // it from a stale record would skip the dialog for a widget that is no longer here.
    const granted: Permissions = record && installed ? record.consentedPermissions : NO_PERMISSIONS
    const asked = permissionsOf(pkg.manifest)
    // Everything the user has seen: what they already hold, plus what the dialog they answered
    // listed. Anything the package asks for beyond that was never shown to anybody.
    const shown = consent === false ? granted : unionPermissions(granted, consent)
    if (!isEmpty(addedPermissions(shown, asked))) {
      // The difference reported is the one against the *grant*, which is what a dialog has to
      // show — and when the index and the package disagree, this is the honest path: the user is
      // asked again, on the package's real ask.
      return reply.code(409).send({ ...fail('marketplace.consentRequired'), newPermissions: addedPermissions(granted, asked) })
    }

    try { await writePackage(installedDir, id, pkg.files) }
    catch (err) { req.log.warn({ err }, 'marketplace install could not write the widget'); return reply.code(500).send(fail('marketplace.writeFailed')) }

    await catalog.scan()

    const consented: WidgetConsent = {
      version: pkg.manifest.version,
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
      req.log.warn({ err }, 'marketplace install could not record the consent')
      return reply.code(500).send(fail('marketplace.writeFailed'))
    }

    return reply.send({ ok: true, id, version: pkg.manifest.version, consentedPermissions: asked })
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

  app.post('/api/marketplace/uninstall', async (req, reply) => {
    const parsed = UninstallBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail('marketplace.badRequest'))
    const { id } = parsed.data
    return exclusive(id, reply, () => doUninstall(id, req, reply))
  })

  const doUninstall = async (id: string, req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const config = store.get()
    if (!config.marketplace.installed[id] && catalog.entry(id)?.source !== 'installed') {
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
    return reply.send({ ok: true, id })
  }
}
