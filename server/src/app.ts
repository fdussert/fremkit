import Fastify, { type FastifyInstance, type FastifyServerOptions, type RouteOptions } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { homedir } from 'node:os'
import { shippedPaths } from './paths.js'
import { join } from 'node:path'
import { access, mkdir, readFile } from 'node:fs/promises'
import { ConfigStore } from './config/store.js'
import { ConfigHistory } from './config/history.js'
import { historyRoutes } from './config/history-routes.js'
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
import { screenReloadRoutes } from './config/screen-reload.js'
import { WidgetCatalog } from './widgets/catalog.js'
import { installedWidgetsDir } from './widgets/installed.js'
import { WIDGET_DEV_CHANNEL, WidgetDevWatcher } from './widgets/dev.js'
import { Registry } from './marketplace/registry.js'
import { marketplaceRoutes } from './marketplace/routes.js'
import { recoverStaging } from './marketplace/install.js'
import { ThemeCatalog } from './themes/catalog.js'
import { installedThemesDir } from './themes/installed.js'
import { themeRoutes } from './themes/routes.js'
import { createThemeProvider } from './themes/schedule.js'
import { widgetRoutes } from './widgets/routes.js'
import { ProviderRegistry } from './providers/registry.js'
import { publishHealth } from './providers/health.js'
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
import { createCodexProvider } from './providers/codex.js'
import { createLocalChatValidator } from './codex/local-chats.js'
import { createClaudeIdentityProvider } from './claude/identity.js'
import { createAttention } from './claude/attention.js'
import { DockState } from './dock/state.js'
import { dockRoutes } from './dock/routes.js'
import { InstalledApps } from './apps/installed.js'
import { AppIcons } from './apps/icons.js'
import { appsRoutes } from './apps/routes.js'
import { helperRoutes } from './helper/routes.js'
import { createDockProvider } from './dock/provider.js'
import { bambuCameras } from './bambu/cameras.js'
import { sweepStaleCameraDirs } from './providers/bambu-rtsp.js'
import { DEFAULT_BACKGROUND, seedDefaultBackground } from './backgrounds/seed.js'
import { isSafeBackgroundName } from './config/schema.js'
import { backupRoutes } from './backup/routes.js'
import { bambuRoutes } from './bambu/routes.js'
import { createPastePadProvider } from './providers/paste-pad.js'
import { createShortcutsProvider } from './providers/shortcuts.js'
import { createMessages2FAProvider } from './providers/messages-2fa.js'
import { createRectangleProvider } from './providers/rectangle.js'
import { createServiceStatusProvider } from './providers/service-status.js'
import { createSystemProvider } from './providers/system.js'
import { createDiskMapProvider } from './providers/disk-map.js'
import { createRecentProjectsProvider } from './providers/recent-projects.js'
import { BrightnessService } from './brightness/service.js'
import { createBrightnessProvider, BRIGHTNESS_INTERVAL_MS } from './brightness/provider.js'
import { brightnessRoutes } from './brightness/routes.js'
import { findInstance, findInstances, type InstanceLookup } from './config/instances.js'
import { commandScope, instanceInScope, type ScreenOfDevice } from './devices/scope.js'
import { migrateHomeySecret } from './config/migrate.js'
import { BYTES_CSP, hostCsp, isByteRoute } from './http/headers.js'
import { isAllowedHost, isReadMethod } from './http/guard.js'
import { AccessGate, isCompanionRoute } from './http/access.js'
import { installAccessGate } from './http/access-routes.js'
import { LOGGER_OPTIONS } from './http/logging.js'
import { MAX_WS_PAYLOAD_BYTES } from './ws/hub.js'
import { isOriginAllowed } from './ws/routes.js'
import { tr } from './i18n.js'
import { isRemoteRequest } from './net/remote.js'
import { DeviceStore } from './devices/store.js'
import { registerRemoteGate } from './devices/gate.js'
import { PairingCodes } from './devices/codes.js'
import { DeviceService } from './devices/service.js'
import { deviceRoutes } from './devices/routes.js'
import { REMOTE_PORT } from './devices/listener.js'
import type { Advertiser } from './devices/bonjour.js'
import { createCompanion, type Companion } from './companion/index.js'
import type { Exec } from './secrets/keychain.js'
import { diagnosticsRoutes } from './diagnostics/routes.js'
import { shareRoutes } from './share/routes.js'
import { shareRedaction } from './share/context.js'
import type { LogTail } from './diagnostics/log-tail.js'
import { isDeclaredType } from './connections/declared.js'
import { tightenDataDir } from './data-permissions.js'
import { createDemoProviders } from './demo/providers.js'
import { demoConnectionTypes } from './demo/connections.js'
import { demoPublicFetch } from './demo/fetch.js'
import { demoConnectionFetch } from './demo/declared.js'
import { demoIcon } from './demo/icons.js'
import { DEMO_APPS } from './demo/world.js'
import { FileSecretStore } from './secrets/file.js'

export interface AppOptions {
  dataDir: string
  /**
   * Demo mode (`FREMKIT_DEMO=1`, docs/demo-mode.md): every channel is answered by the fakes in
   * `demo/` instead of the real providers, which are never constructed — nothing reads the Mac,
   * the keychain or an account, and nothing a provider does reaches the network. `providers` is
   * ignored. `index.ts` also gives a demo its own data folder; this option does not check that.
   */
  demo?: boolean
  /**
   * This instance may take over the keychain items an earlier version filed under the shared
   * `fremkit` service. Only the live server (port 4242) passes it; see `secrets/keychain.ts`.
   */
  adoptLegacyKeychain?: boolean
  widgetsDir: string
  /** Development only: a registry served from somewhere else. See `server/src/index.ts`. */
  registryUrl?: string
  /** Set with `registryUrl`, and only under `FREMKIT_DEV=1`; see `RegistryOptions.dev`. */
  registryDev?: boolean
  /**
   * The widget author's folder, read and watched only when set — which `index.ts` does under
   * `FREMKIT_WIDGET_DEV=1` and nowhere else. See `widgets/dev.ts`.
   */
  widgetDevDir?: string
  /** Where the themes live. Defaults to the repository folder, which is what ships the built-in one. */
  themesDir?: string
  /** Only ever passed by the tests, which need to look inside what the proxy cached. */
  connCache?: ConnCache
  uiDist?: string
  /** The widget SDK served as `/fremkit.js`. Defaults to the one in the checkout, see `paths.ts`. */
  bridgePath?: string
  /** Only ever passed by the tests: the built-ins allowed WebRTC's `local` level (`widgets/webrtc.ts`). */
  webrtcLocalBuiltins?: ReadonlySet<string>
  /** The wallpaper copied into a fresh background library. Defaults like `bridgePath`. */
  wallpaperPath?: string
  providers?: Provider[]
  logger?: boolean
  /**
   * What this process has written to its log, for `GET /api/diagnostics`. `index.ts` installs
   * one on the real streams; the tests leave it out and the report says the log is unavailable.
   */
  logTail?: LogTail
  claudeTranscriptsDir?: string
  /** Overrides the built-in connection types; tests inject fakes here. */
  connectionTypes?: ConnectionType[]
  /**
   * The port this instance listens on, so the request gate can refuse a `Host` naming another
   * one. An embedded instance that never listens leaves it out and is judged on the host name
   * alone.
   */
  port?: number
  /**
   * The local access secret every request must carry (see `http/access.ts`), or `null` for no
   * gate at all. Required rather than optional so that leaving the gate out is something a
   * caller writes down: `index.ts` always passes one, the tests that exercise other things pass
   * `null`.
   */
  accessToken: string | null
  /**
   * Test seam: called for every route as it is registered, from before the first plugin, so a
   * test can walk the whole route table (the remote allow-list test does).
   */
  onRoute?: (route: RouteOptions) => void
  /** The port paired devices reach the remote listener on. 4243; the tests pass 0. */
  devicesPort?: number
  /** Tests: the brightness service to use instead of one over the live config. */
  brightness?: BrightnessService
  /**
   * Test seam for the device service: a fixed host name and addresses, and an advertiser that
   * does not run `dns-sd`.
   */
  devices?: {
    exec?: Exec
    advertise?: Advertiser
    lanAddresses?: () => string[]
    preferredAddress?: (addresses: string[]) => Promise<string | null>
    appAddresses?: (addresses: string[]) => Promise<string[]>
    /** How a taken remote port is tried again (`DeviceServiceOptions.bindRetry`). */
    bindRetry?: { attempts: number; delayMs: number }
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  // The query string is stripped from every logged request line: see http/logging.ts. Typed
  // explicitly, or an inline object literal sends TypeScript down Fastify's http2 overload.
  //
  // With a log tail, pino writes through `process.stdout` rather than straight to descriptor 1,
  // so the tail's copy of the stream sees the request lines too.
  const logger = opts.logger
    ? (opts.logTail ? { ...(LOGGER_OPTIONS as object), stream: process.stdout } : LOGGER_OPTIONS)
    : false
  const serverOptions: FastifyServerOptions = { logger }
  const app = Fastify(serverOptions)
  // The paired device a remote request authenticated as (see `net/remote.ts`). Declared up front
  // with a null value so every request has the same shape; only the devices gate sets it.
  app.decorateRequest('deviceId', null)
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute)

  // Private before anything is read from it or written to it: see data-permissions.ts.
  await tightenDataDir(opts.dataDir)
  const store = new ConfigStore(join(opts.dataDir, 'fremkit.json'), { history: new ConfigHistory(join(opts.dataDir, 'history')) })
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
  // Created up front so the watcher has something to watch and `pnpm widget:new` somewhere to write.
  if (opts.widgetDevDir) await mkdir(opts.widgetDevDir, { recursive: true })
  const catalog = new WidgetCatalog(opts.widgetsDir, installedDir, opts.widgetDevDir)
  await catalog.scan()
  const themes = new ThemeCatalog(
    opts.themesDir ?? shippedPaths().themesDir,
    installedThemesDir(opts.dataDir),
  )
  await themes.scan()

  // A camera stream writes a one-line concat list into its own temp directory and removes it on
  // stop; a server that was killed never got there. Cleared once, at boot.
  sweepStaleCameraDirs()

  // The shipped wallpaper, copied into the user's background library as an ordinary file so it
  // can be picked and deleted like any upload. Before the store loads, so a fresh install's
  // default config already has the image it names.
  await seedDefaultBackground(opts.dataDir, opts.wallpaperPath)

  const dock = new DockState({ iconsDir: join(opts.dataDir, 'icons') })
  await dock.loadIcons()
  const demo = opts.demo === true
  // A demo lists no installed application and extracts no icon from one: both read the Mac.
  const installedApps = demo ? new InstalledApps({ roots: [] }) : new InstalledApps()
  const appIcons = demo ? undefined : new AppIcons({ dir: join(opts.dataDir, 'icons', 'apps'), apps: installedApps })
  if (demo) {
    // The helper uploads the Dock's icons; a demo has no helper, so it draws its own.
    for (const app of DEMO_APPS) await dock.setIcon(app.bundleId, demoIcon(app.hue, app.glyph))
  }

  // The sound is a widget setting the *core* acts on: an iframe cannot start audio nobody
  // clicked on, and the moment worth hearing about is the one where the dashboard is not in
  // front of you. The first placed tile that chose a sound is the one that gets it.
  const attention = createAttention({ instances: () => findInstances(store.get(), 'claude-sessions') })
  const tracker = new ClaudeTracker({ filePath: join(opts.dataDir, 'claude-sessions.json'), onAttention: attention })
  await tracker.load()
  const usage = new ClaudeUsage({ filePath: join(opts.dataDir, 'claude-usage.json'), transcriptsDir: demo ? join(opts.dataDir, 'demo-transcripts') : opts.claudeTranscriptsDir ?? join(homedir(), '.claude', 'projects') })
  await usage.load()

  /**
   * The device screen a paired device is attached to, asked of the device service at call time:
   * the one rule (devices/scope.ts) the proxy, the commands and the config projection share. The
   * service is built further down, after the hub; nothing calls this before a request comes in.
   */
  const screenOfDevice: ScreenOfDevice = (deviceId) => deviceService.deviceScreenOf(deviceId)

  // Per-screen settings from the store, reports from the helper: see brightness/service.ts.
  const brightness = opts.brightness ?? new BrightnessService({ config: () => store.get() })
  // The service decides (and tells the devices) on every command and report itself; this only
  // asks the channel's watchers for an immediate poll.
  const brightnessChanged = (): void => registry.refresh('brightness')
  let hub!: Hub
  const registry = new ProviderRegistry(
    (channel, data) => hub.broadcast(channel, data),
    (channel) => hub.forget(channel),
  )
  hub = new Hub(registry)
  // These act on the user's behalf — opening an application, knocking on a host — so they
  // resolve what to act on from the saved dashboard rather than from the widget's message.
  // A paired device resolves only the instances of its own screen: see devices/scope.ts. The
  // demo's fakes resolve through it too, so a demo scopes a device exactly like the real thing.
  const instances: InstanceLookup = (instanceId, ctx) => {
    const config = store.get()
    return instanceInScope(config, commandScope(ctx, screenOfDevice), instanceId) ? findInstance(config, instanceId) : null
  }
  /** Every real provider: the Mac, the accounts, the helper's reports. Never called in demo mode. */
  function registerRealProviders(): void {
    for (const p of opts.providers ?? []) registry.register(p)
    // Consent lives in the config store, so this provider is registered beside the Claude providers.
    registry.register(createSystemProvider({ macmonTemperatureEnabled: () => store.get().privacy.macmonTemperature }))
    registry.register(createClaudeSessionsProvider(tracker))
    registry.register(createClaudeUsageProvider(usage))
    registry.register(createClaudeIdentityProvider())
    registry.register(createClaudeAccountProvider({
      filePath: join(opts.dataDir, 'claude-account.json'),
      enabled: () => store.get().privacy.claudeAccountUsage,
    }))
    const codex = createCodexProvider({
      enabled: () => store.get().privacy.codexAccount || store.get().privacy.codexHistorySources.length > 0,
      accountEnabled: () => store.get().privacy.codexAccount,
      historySources: () => store.get().privacy.codexHistorySources,
    }, { isLocalChat: createLocalChatValidator() })
    registry.register(codex)
    registry.register(codex.sessions)
    registry.register(createDockProvider(dock))
    // Registered here, not in providers/index.ts, because its last scan is saved under the data dir.
    registry.register(createDiskMapProvider({ dataDir: opts.dataDir }))
    // Registered here, not in providers/index.ts, because that is where the config store lives.
    registry.register(createShortcutsProvider(undefined, instances))
    registry.register(createPastePadProvider(undefined, instances))
    registry.register(createMessages2FAProvider({ enabled: () => store.get().privacy.messages2FA }))
    registry.register(createRectangleProvider())
    registry.register(createServiceStatusProvider({}, instances))
    registry.register(createRecentProjectsProvider({ filePath: join(opts.dataDir, 'recent-projects.json') }))
    // A paired device may set only its own screen's brightness: see mayCommandBrightness. Read
    // at command time, so a device moved to another screen (or unpaired) is judged as it is now.
    registry.register(createBrightnessProvider(brightness, brightnessChanged, (id) => deviceService.deviceScreenOf(id)))
  }
  if (demo) {
    // The demo has its own `brightness` channel; the service above still serves the routes and
    // the paired devices.
    for (const p of createDemoProviders({ config: () => store.get(), instances })) registry.register(p)
  } else {
    registerRealProviders()
  }
  // The theme in force, day or night: see themes/schedule.ts. Read from the config alone, so a
  // demo runs the real one.
  registry.register(createThemeProvider(() => store.get()))
  // A demo never asks the keychain, whatever its config says: a file in its own data folder.
  const secrets = demo
    ? new FileSecretStore(join(opts.dataDir, 'secrets.json'))
    : createSecretStore(store.get().secrets.backend, opts.dataDir, { adoptLegacyKeychain: opts.adoptLegacyKeychain === true })  // v2 → v3 moved the Homey connection to the type its widget declares, and the declaration
  // calls the key `token` where the coded type called it `apiKey`. The config half of that is in
  // `migrateConfig`; this is the half that needs the secret store. Idempotent, so it costs one
  // read per Homey connection on a start that has nothing to do.
  await migrateHomeySecret(store.get(), secrets).catch((err: unknown) => {
    console.error('could not move the Homey key to its new field:', (err as Error).message)
  })
  const codedTypes = opts.connectionTypes ?? defaultConnectionTypes()
  const connectionTypes = new ConnectionTypeRegistry(demo ? demoConnectionTypes(codedTypes) : codedTypes)
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
  // A demo's declared connections, Test button and proxy alike, reach the invented devices of
  // `demo/declared.ts` and never the network.
  const connectionFetch = demo ? demoConnectionFetch() : undefined
  const syncDeclared = (): void => syncDeclaredTypes(
    connectionTypes,
    declaredFromCatalog(catalog.entries, (id) => grantedFor(catalog, store.get(), id)),
    connectionFetch ? { fetch: connectionFetch } : {},
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
  // How each provider's last poll went, for the editor's widget health (providers/health.ts).
  const stopHealth = publishHealth(registry, (channel, data) => hub.broadcast(channel, data))
  let showAccountEmail = store.get().privacy.showAccountEmail
  store.onChange((cfg) => {
    setServerLocale(cfg.locale)
    if (cfg.privacy.showAccountEmail !== showAccountEmail) {
      showAccountEmail = cfg.privacy.showAccountEmail
      registry.reconsiderAccountEmail()
    }
    syncDeclared()
    hub.broadcast('config', cfg)
    brightness.snapshot()
    brightnessChanged()
    registry.refresh('theme')
    // Fire and forget: a failed sync must not break the save that triggered it.
    void connections.sync(cfg.connections)
      .then(() => retainCameras(cfg))
      .catch((err: Error) => app.log.warn({ err }, 'connection sync failed'))
  })

  // The paired devices, and what the remote listener answers to. The hosts start empty — every
  // remote request is refused 421 — until whoever starts the listener says which names it has.
  const devices = new DeviceStore(join(opts.dataDir, 'devices.json'))
  await devices.load()
  let remoteHosts: () => Set<string> = () => new Set()
  app.decorate('pairing', {
    store: devices,
    setRemoteHosts: (fn: () => Set<string>) => { remoteHosts = fn },
  })
  // First of the request hooks: a request that came in on the remote listener is judged there
  // and only there (see devices/gate.ts). The two below skip it.
  registerRemoteGate(app, { devices, remoteHosts: () => remoteHosts() })

  // The gate described in http/guard.ts: no request whose Host names anything but this server
  // (DNS rebinding), and no write from a page we did not serve (cross-site writes). It runs
  // before every route, the WebSocket handshake and the static UI included. A client that sends
  // no Origin at all — curl, the Claude Code hook scripts, the native helper — is not a browser
  // doing cross-site work and passes.
  app.addHook('onRequest', async (req, reply) => {
    if (isRemoteRequest(req)) return
    if (!isAllowedHost(req.headers.host, opts.port)) {
      return reply.code(421).send({ error: tr(store.get().locale, 'http.hostNotAllowed') })
    }
    // The extension's routes check its `chrome-extension://` origin themselves.
    if (isCompanionRoute(req.method, req.routeOptions.url)) return
    if (!isReadMethod(req.method) && !isOriginAllowed(req.headers.origin)) {
      return reply.code(403).send({ error: tr(store.get().locale, 'http.originNotAllowed') })
    }
  })
  // Then who sent it: the local access secret, as a bearer token or the session cookie (see
  // http/access.ts). A hook of its own, after the one above, so a rebinding attempt is still
  // told 421 and a cross-site write 403 whatever it carries.
  if (opts.accessToken !== null) {
    installAccessGate(app, {
      gate: new AccessGate(opts.accessToken, { port: opts.port }),
      // A paired device has its own credential, checked by the devices gate. The browser
      // extension pairs by the user's approval instead (see companion/routes.ts).
      appliesTo: (req) => !isRemoteRequest(req) && !isCompanionRoute(req.method, req.routeOptions.url),
    })
  }

  // Never let a browser re-guess a type we declared, and make the answers that carry bytes from
  // elsewhere inert if one is ever opened as a document. A route that sets its own CSP — the
  // widgets, which need a looser one to run at all — keeps it.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    if (isByteRoute(req.url) && !reply.getHeader('content-security-policy')) {
      reply.header('content-security-policy', BYTES_CSP)
    }
    // Every page of ours that sets nothing itself: the dashboard and the admin, whatever path
    // reached them. The widgets, the refusal page and the byte routes have their own.
    if (!reply.getHeader('content-security-policy') && /^text\/html/i.test(String(reply.getHeader('content-type') ?? ''))) {
      reply.header('content-security-policy', hostCsp(String(req.headers.host ?? '').toLowerCase(), isRemoteRequest(req)))
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

  await app.register(configRoutes, { store, catalog, screenOfDevice })
  await app.register(connectionRoutes, { store, catalog, types: connectionTypes, manager: connections, secrets, connCache })
  await app.register(widgetRoutes, {
    catalog,
    store,
    bridgePath: opts.bridgePath ?? shippedPaths().bridgePath,
    port: opts.port,
    dev: process.env.FREMKIT_DEV === '1',
    screenOfDevice,
    ...(opts.webrtcLocalBuiltins ? { webrtcLocalBuiltins: opts.webrtcLocalBuiltins } : {}),
  })
  await app.register(themeRoutes, { catalog: themes, config: () => store.get() })
  await app.register(proxyRoutes, {
    catalog, store, secrets, cache: connCache, screenOfDevice,
    // The proxy's checks all run; only the last step, the request itself, is answered locally.
    ...(demo ? { publicFetch: demoPublicFetch(), fetch: connectionFetch, isPrivate: async () => false } : {}),
  })
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
  await app.register(historyRoutes, {
    store,
    types: connectionTypes,
    secrets,
    // A version put back brings its connections back as they were, exactly like a backup.
    onRestored: async (config) => { await connections.sync(config.connections); retainCameras(config) },
  })
  await app.register(faviconRoutes, { dir: join(opts.dataDir, 'icons', 'favicons'), config: () => store.get(), screenOfDevice })
  await app.register(claudeRoutes, { tracker, usage })
  await app.register(dockRoutes, {
    state: dock,
    ...(appIcons ? { appIcons } : {}),
    deviceMayListApps: (id) => deviceService.maySubscribe(id, 'dock'),
  })
  /** Whether this is a demo server: `pnpm widget:preview` refuses to capture anything else. */
  app.get('/api/demo', async () => ({ demo }))
  await app.register(appsRoutes, { apps: installedApps, deviceMayListApps: (id) => deviceService.maySubscribe(id, 'dock') })
  await app.register(helperRoutes)
  await app.register(brightnessRoutes, { service: brightness, changed: brightnessChanged })
  await app.register(bambuRoutes, { cameras: bambuCameras })
  await app.register(wsRoutes, { hub })
  await app.register(screenReloadRoutes, { store, notify: (channel, data) => hub.notify(channel, data) })

  // Built after the device service, which lists its extensions and waiting request: it reads them
  // through these closures.
  let companion: Companion | null = null
  // After the hub and the config store, which it feeds and listens to.
  const deviceService = new DeviceService({
    app,
    store: devices,
    codes: new PairingCodes(),
    secrets,
    config: store,
    hub,
    catalog,
    channelOf: (connection) => connections.channelFor(connection),
    brightnessOf: (screenId) => {
      const s = brightness.snapshot().screens[screenId]
      return s ? { target: s.target, seq: s.seq } : null
    },
    listenerPort: opts.devicesPort ?? REMOTE_PORT,
    companionRequest: () => companion?.pairing.pending() ?? null,
    companionLocked: () => companion?.pairing.locked ?? false,
    companionConnected: () => companion?.session.connectedIds() ?? new Set(),
    ...opts.devices,
  })
  // A new target for a screen reaches the devices bound to it over the `device` channel.
  brightness.onChange((screens) => deviceService.screensChanged(screens))
  // The clock moves a ramp and ends a manual hold with nobody asking, and a paired device does
  // not watch the `brightness` channel: something has to keep deciding for it. Started here, after
  // the last await that can throw, so a failed start leaves no timer behind.
  const brightnessTick = setInterval(() => brightness.snapshot(), BRIGHTNESS_INTERVAL_MS)
  brightnessTick.unref()
  app.addHook('onClose', async () => { clearInterval(brightnessTick) })
  await app.register(deviceRoutes, {
    service: deviceService,
    config: store,
    reportBrightness: (screenId, report) => { brightness.deviceReport(screenId, report); brightnessChanged() },
  })
  await app.register(diagnosticsRoutes, {
    deps: {
      config: () => store.get(),
      widget: (id) => {
        const entry = catalog.entry(id)
        return entry ? { version: entry.manifest.version, source: entry.source } : undefined
      },
      connectionKind: (type) => (isDeclaredType(type) ? 'declared' : connectionTypes.get(type) ? 'coded' : 'unknown'),
      channelFor: (connection) => connections.channelFor(connection),
      secretsFor: (connection) => connections.secretsFor(connection),
      channels: () => registry.status(),
      devices: () => devices.list(),
      remoteAccess: () => devices.enabled,
      accessToken: opts.accessToken,
      ...(opts.logTail ? { log: (count: number) => opts.logTail!.recent(count) } : {}),
    },
  })
  await app.register(shareRoutes, {
    deps: {
      config: () => store.get(),
      manifest: (id) => catalog.get(id),
      source: (id) => catalog.entry(id)?.source,
      readImage: (name) => (isSafeBackgroundName(name)
        ? readFile(join(opts.dataDir, 'backgrounds', name)).catch(() => null)
        : Promise.resolve(null)),
      redaction: () => shareRedaction(store.get(), {
        secretsFor: (connection) => connections.secretsFor(connection),
        devices: () => devices.list(),
        accessToken: opts.accessToken,
      }),
      shippedBackground: DEFAULT_BACKGROUND,
    },
  })
  app.addHook('onClose', async () => { await deviceService.close() })

  // The browser extension: pairing by approval on the Edge, its socket, the share it carries and
  // the `companion` channel the dashboard watches. Closed with the app.
  // The pairing lock lives next to devices.json: a restart must not clear it.
  companion = await createCompanion({ app, store: devices, config: store, registry, lockPath: join(opts.dataDir, 'companion-lock.json') })

  if (opts.uiDist && (await access(opts.uiDist).then(() => true, () => false))) {
    await app.register(fastifyStatic, { root: opts.uiDist, prefix: '/', serve: true, decorateReply: false })
    for (const route of ['/admin', '/admin/']) {
      app.get(route, async (_req, reply) => reply.sendFile('admin.html', opts.uiDist!))
    }
  }

  app.addHook('onClose', async () => { stopHealth(); registry.stop(); bambuCameras.stopAll(); await tracker.flush(); await usage.flush() })

  // Writing a widget: a save reloads its frames, a manifest change rescans first so the frames
  // come back with the new one. The built-ins are watched too, for whoever works on those.
  if (opts.widgetDevDir) {
    const watcher = new WidgetDevWatcher({
      roots: [opts.widgetDevDir, opts.widgetsDir],
      onReload: async (reload) => {
        if (reload.manifest) await catalog.scan()
        hub.notify(WIDGET_DEV_CHANNEL, reload)
      },
      onError: (error) => app.log.warn({ err: error }, 'widget watcher'),
    })
    watcher.start()
    app.log.info({ dir: opts.widgetDevDir }, 'widget development: reading and watching the author folder')
    app.addHook('onClose', async () => { watcher.close() })
  }
  // Last: it may start the remote listener, which readies the app and so closes its route table.
  await deviceService.init()
  return app
}
