import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { ConfigStore } from './config/store.js'
import { setServerLocale } from './i18n.js'
import { ConnectionManager } from './connections/manager.js'
import { ConnectionTypeRegistry } from './connections/registry.js'
import { declaredFromCatalog, syncDeclaredTypes } from './connections/declared.js'
import { grantedFor } from './marketplace/consent.js'
import { connectionRoutes } from './connections/routes.js'
import { defaultConnectionTypes } from './connections/types/index.js'
import type { ConnectionType } from './connections/types.js'
import { createSecretStore } from './secrets/index.js'
import { configRoutes } from './config/routes.js'
import { WidgetCatalog } from './widgets/catalog.js'
import { installedWidgetsDir } from './widgets/installed.js'
import { Registry } from './marketplace/registry.js'
import { marketplaceRoutes } from './marketplace/routes.js'
import { recoverStaging } from './marketplace/install.js'
import { ThemeCatalog } from './themes/catalog.js'
import { installedThemesDir } from './themes/installed.js'
import { themeRoutes } from './themes/routes.js'
import { widgetRoutes } from './widgets/routes.js'
import { ProviderRegistry } from './providers/registry.js'
import type { Provider } from './providers/types.js'
import { Hub } from './ws/hub.js'
import { wsRoutes } from './ws/routes.js'
import { proxyRoutes } from './proxy/routes.js'
import { ConnCache } from './proxy/conn.js'
import { backgroundRoutes } from './backgrounds/routes.js'
import { faviconRoutes } from './favicons/routes.js'
import { ClaudeTracker } from './claude/tracker.js'
import { ClaudeUsage } from './claude/usage.js'
import { claudeRoutes } from './claude/routes.js'
import { createClaudeSessionsProvider, createClaudeUsageProvider, createClaudeAccountProvider } from './claude/providers.js'
import { DockState } from './dock/state.js'
import { dockRoutes } from './dock/routes.js'
import { InstalledApps } from './apps/installed.js'
import { AppIcons } from './apps/icons.js'
import { appsRoutes } from './apps/routes.js'
import { helperRoutes } from './helper/routes.js'
import { createDockProvider } from './dock/provider.js'
import { bambuCameras } from './bambu/cameras.js'
import { sweepStaleCameraDirs } from './providers/bambu-rtsp.js'
import { seedDefaultBackground } from './backgrounds/seed.js'
import { backupRoutes } from './backup/routes.js'
import { bambuRoutes } from './bambu/routes.js'
import { createShortcutsProvider } from './providers/shortcuts.js'
import { createServiceStatusProvider } from './providers/service-status.js'
import { findInstance } from './config/instances.js'
import { BYTES_CSP, isByteRoute } from './http/headers.js'
import { isAllowedHost, isReadMethod } from './http/guard.js'
import { LOGGER_OPTIONS } from './http/logging.js'
import { MAX_WS_PAYLOAD_BYTES } from './ws/hub.js'
import { isOriginAllowed } from './ws/routes.js'
import { tr } from './i18n.js'

export interface AppOptions {
  dataDir: string
  widgetsDir: string
  /** Development only: a registry served from somewhere else. See `server/src/index.ts`. */
  registryUrl?: string
  /** Set with `registryUrl`, and only under `FREMKIT_DEV=1`; see `RegistryOptions.dev`. */
  registryDev?: boolean
  /** Where the themes live. Defaults to the repository folder, which is what ships the built-in one. */
  themesDir?: string
  /** Only ever passed by the tests, which need to look inside what the proxy cached. */
  connCache?: ConnCache
  uiDist?: string
  providers?: Provider[]
  logger?: boolean
  claudeTranscriptsDir?: string
  /** Overrides the built-in connection types; tests inject fakes here. */
  connectionTypes?: ConnectionType[]
  /**
   * The port this instance listens on, so the request gate can refuse a `Host` naming another
   * one. An embedded instance that never listens leaves it out and is judged on the host name
   * alone.
   */
  port?: number
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  // The query string is stripped from every logged request line: see http/logging.ts. Typed
  // explicitly, or an inline object literal sends TypeScript down Fastify's http2 overload.
  const serverOptions: FastifyServerOptions = { logger: opts.logger ? LOGGER_OPTIONS : false }
  const app = Fastify(serverOptions)

  const store = new ConfigStore(join(opts.dataDir, 'fremkit.json'))
  await store.load()
  // Providers, the proxy and the connection types are far from any request, so they read the
  // language from this module-level copy rather than being handed a store they have no use for.
  setServerLocale(store.get().locale)
  const installedDir = installedWidgetsDir(opts.dataDir)
  // Before the first scan, when no install of *this* process can be in flight: one killed
  // between its two renames left a widget's folder gone and its previous version in `<id>.bak`,
  // and this is where every one of those goes back. An install does the same for its own id
  // only, because installs of different widgets legitimately overlap.
  //
  // Not "no install anywhere": a second checkout on another `FREMKIT_PORT` sharing this
  // `dataDir` could be mid-swap while this one boots, and its `<id>.bak` would come back under
  // it. Two servers writing one data directory is already outside what anything here promises —
  // the config store would be racing too — so the comment says what is true rather than the
  // boot growing a lockfile for a case nobody is in.
  await recoverStaging(installedDir)
  const catalog = new WidgetCatalog(opts.widgetsDir, installedDir)
  await catalog.scan()
  const themes = new ThemeCatalog(
    opts.themesDir ?? fileURLToPath(new URL('../../themes', import.meta.url)),
    installedThemesDir(opts.dataDir),
  )
  await themes.scan()

  // A camera stream writes a one-line concat list into its own temp directory and removes it on
  // stop; a server that was killed never got there. Cleared once, at boot.
  sweepStaleCameraDirs()

  // The shipped wallpaper, copied into the user's background library as an ordinary file so it
  // can be picked and deleted like any upload. Before the store loads, so a fresh install's
  // default config already has the image it names.
  await seedDefaultBackground(opts.dataDir)

  const dock = new DockState({ iconsDir: join(opts.dataDir, 'icons') })
  await dock.loadIcons()
  const installedApps = new InstalledApps()
  const appIcons = new AppIcons({ dir: join(opts.dataDir, 'icons', 'apps'), apps: installedApps })

  const tracker = new ClaudeTracker({ filePath: join(opts.dataDir, 'claude-sessions.json') })
  await tracker.load()
  const usage = new ClaudeUsage({ filePath: join(opts.dataDir, 'claude-usage.json'), transcriptsDir: opts.claudeTranscriptsDir ?? join(homedir(), '.claude', 'projects') })
  await usage.load()

  let hub!: Hub
  const registry = new ProviderRegistry(
    (channel, data) => hub.broadcast(channel, data),
    (channel) => hub.forget(channel),
  )
  hub = new Hub(registry)
  for (const p of opts.providers ?? []) registry.register(p)
  registry.register(createClaudeSessionsProvider(tracker))
  registry.register(createClaudeUsageProvider(usage))
  registry.register(createClaudeAccountProvider({
    filePath: join(opts.dataDir, 'claude-account.json'),
    enabled: () => store.get().privacy.claudeAccountUsage,
  }))
  registry.register(createDockProvider(dock))
  // These two act on the user's behalf — opening an application, knocking on a host — so they
  // resolve what to act on from the saved dashboard rather than from the widget's message.
  // Registered here, not in providers/index.ts, because that is where the config store lives.
  const instances = (instanceId: string) => findInstance(store.get(), instanceId)
  registry.register(createShortcutsProvider(undefined, instances))
  registry.register(createServiceStatusProvider({}, instances))
  const secrets = createSecretStore(store.get().secrets.backend, opts.dataDir)
  const connectionTypes = new ConnectionTypeRegistry(opts.connectionTypes ?? defaultConnectionTypes())
  const connections = new ConnectionManager({ registry, types: connectionTypes, secrets })
  /**
   * What the proxy has cached per declared connection.
   *
   * Shared, because the three things that make a cached answer wrong are in three other files:
   * the credential changing, the connection going away, and a share being taken back.
   */
  const connCache = opts.connCache ?? new ConnCache()
  /**
   * The connection types the installed widgets declare, refreshed whenever the catalogue or the
   * config changes — an install adds one, an uninstall takes one away, and a consent that has
   * not been given yet grants none.
   */
  const syncDeclared = (): void => syncDeclaredTypes(
    connectionTypes,
    declaredFromCatalog(catalog.entries, (id) => grantedFor(catalog, store.get(), id)),
  )
  // Both, and both are needed. The catalogue changing is a widget arriving or leaving; the
  // config changing is the *consent record* being written, which is what turns a declaration
  // into a grant. An install does the two in that order — `catalog.scan()` then `store.update()`
  // — so hooking only the first registered nothing at all: at that moment there was no record
  // yet, and a declaration nobody has agreed to grants no type.
  catalog.onScan(syncDeclared)
  syncDeclared()
  /** A camera whose connection is gone keeps neither a socket nor the access code it was built on. */
  const retainCameras = (cfg: { connections: { id: string; type: string }[] }): void => {
    bambuCameras.retain(new Set(cfg.connections.filter((c) => c.type === 'bambu').map((c) => c.id)))
  }
  await connections.sync(store.get().connections)
  retainCameras(store.get())

  hub.broadcast('config', store.get())
  store.onChange((cfg) => {
    setServerLocale(cfg.locale)
    syncDeclared()
    hub.broadcast('config', cfg)
    // Fire and forget: a failed sync must not break the save that triggered it.
    void connections.sync(cfg.connections)
      .then(() => retainCameras(cfg))
      .catch((err: Error) => app.log.warn({ err }, 'connection sync failed'))
  })

  // The gate described in http/guard.ts: no request whose Host names anything but this server
  // (DNS rebinding), and no write from a page we did not serve (cross-site writes). It runs
  // before every route, the WebSocket handshake and the static UI included. A client that sends
  // no Origin at all — curl, the Claude Code hook scripts, the native helper — is not a browser
  // doing cross-site work and passes.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, opts.port)) {
      return reply.code(421).send({ error: tr(store.get().locale, 'http.hostNotAllowed') })
    }
    if (!isReadMethod(req.method) && !isOriginAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: tr(store.get().locale, 'http.originNotAllowed') })
    }
  })

  // Never let a browser re-guess a type we declared, and make the answers that carry bytes from
  // elsewhere inert if one is ever opened as a document. A route that sets its own CSP — the
  // widgets, which need a looser one to run at all — keeps it.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    if (isByteRoute(req.url) && !reply.getHeader('content-security-policy')) {
      reply.header('content-security-policy', BYTES_CSP)
    }
    return payload
  })

  // A widget's messages are a channel name or a small command payload; 64 kB is already an order
  // of magnitude more than any of them. Without a cap a single socket could make the server hold
  // an arbitrary amount of memory before anything got round to validating it.
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
  // `serve: false`: nothing is routed from here, the plugin is registered only for the
  // `sendFile` it decorates the reply with. The widget route names the folder it sends from,
  // which is the built-in one or the installed one depending on who owns the id.
  await app.register(fastifyStatic, { root: opts.widgetsDir, serve: false, decorateReply: true })

  await app.register(configRoutes, { store, catalog })
  await app.register(connectionRoutes, { store, catalog, types: connectionTypes, manager: connections, secrets, connCache })
  await app.register(widgetRoutes, { catalog, store })
  await app.register(themeRoutes, { catalog: themes })
  await app.register(proxyRoutes, { catalog, store, secrets, cache: connCache })
  const marketplaceRegistry = new Registry({
    ...(opts.registryUrl ? { url: opts.registryUrl } : {}),
    ...(opts.registryDev ? { dev: true } : {}),
  })
  await app.register(marketplaceRoutes, {
    store, catalog, themes, registry: marketplaceRegistry,
    installedDir, installedThemesDir: installedThemesDir(opts.dataDir),
    connCache,
  })
  await app.register(backgroundRoutes, { dataDir: opts.dataDir })
  await app.register(backupRoutes, {
    store,
    dataDir: opts.dataDir,
    types: connectionTypes,
    secrets,
    // A restored config brings its own connections; the manager rebuilds their providers, which
    // then report `unauthorized` until the secrets are typed back in.
    onRestored: async (config) => { await connections.sync(config.connections); retainCameras(config) },
  })
  await app.register(faviconRoutes, { dir: join(opts.dataDir, 'icons', 'favicons') })
  await app.register(claudeRoutes, { tracker, usage })
  await app.register(dockRoutes, { state: dock, appIcons })
  await app.register(appsRoutes, { apps: installedApps })
  await app.register(helperRoutes)
  await app.register(bambuRoutes, { cameras: bambuCameras })
  await app.register(wsRoutes, { hub })

  if (opts.uiDist && (await access(opts.uiDist).then(() => true, () => false))) {
    await app.register(fastifyStatic, { root: opts.uiDist, prefix: '/', serve: true, decorateReply: false })
    for (const route of ['/admin', '/admin/']) {
      app.get(route, async (_req, reply) => reply.sendFile('admin.html', opts.uiDist!))
    }
  }

  app.addHook('onClose', async () => { registry.stop(); bambuCameras.stopAll(); await tracker.flush(); await usage.flush() })
  return app
}
