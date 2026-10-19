import { rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { buildApp } from './app.js'
import { DemoDataDirError, prepareDemoDataDir } from './demo/seed.js'
import { shippedPaths } from './paths.js'
import { DEFAULT_BACKGROUND } from './backgrounds/seed.js'
import { safePath } from './system-path.js'
import { widgetDevDir } from './widgets/dev.js'
import { accessTokenPath, removeAccessToken, resolveAccessToken, writeAccessToken } from './http/access-file.js'

import { helperLogPath, LogTail } from './diagnostics/log-tail.js'
import { closeAppListenersNow, installShutdown } from './shutdown.js'
import { remotePortFrom } from './devices/listener.js'

// Every file and folder this process (and its children) creates is this account's alone; the data
// folder's older files are brought to the same modes at start (data-permissions.ts).
process.umask(0o077)

// System folders first on PATH, for every child this process runs: see system-path.ts.
process.env.PATH = safePath(process.env.PATH)

// First, so the diagnostics report sees every line this process writes, the boot's included.
const logTail = new LogTail(helperLogPath())
logTail.install()

// A checkout's own folders, or the app bundle's when the helper sets `FREMKIT_ROOT`: see paths.ts.
let shipped: ReturnType<typeof shippedPaths>
try {
  shipped = shippedPaths()
} catch (error) {
  console.error(`fremkit: ${(error as Error).message}`)
  process.exit(1)
}
// A second checkout (a worktree, a test bench) can run beside the live server on another port.
// The helper passes its own configured port here; 4242 is what everything assumes otherwise.
/**
 * Demo mode: invented data on every channel, nothing read off the Mac or any account, a data
 * folder of its own. See docs/demo-mode.md. `pnpm demo` sets the variable; `--demo` does too.
 */
const demo = process.env.FREMKIT_DEMO === '1' || process.argv.includes('--demo')
// A demo never takes the live server's port by default: it runs beside it.
const port = Number(process.env.FREMKIT_PORT) || (demo ? 4250 : 4242)
/**
 * The remote listener's port (paired devices), 4243 unless told otherwise. A second checkout or a
 * test bench sets it so its listener never fights the live one's.
 */
const remote = remotePortFrom(process.env.FREMKIT_REMOTE_PORT, port)
if (remote.error) {
  console.error(`fremkit: ${remote.error}`)
  process.exit(1)
}
const remotePort = remote.port
// The WebSocket's origin check reads the port from the environment (ws/routes.ts).
if (demo && !process.env.FREMKIT_PORT) process.env.FREMKIT_PORT = String(port)

/**
 * Where the config, the backgrounds and the caches live. `<checkout>/data` unless told otherwise;
 * the app always tells, because its bundle is replaced by every update.
 *
 * `FREMKIT_DATA_DIR` is what makes a from-scratch run possible on the live checkout without
 * moving anything: the dashboard, the connections list and the background library all come from
 * here, so pointing it elsewhere gives a brand-new install. Keychain items are filed per data
 * folder (`instanceService`), so another data folder never reads or deletes the real ones.
 *
 * Absolute only: a relative path would be read against whatever directory the process happened
 * to start in, which for the helper's child is the checkout and for a shell is anywhere.
 */
const configured = process.env.FREMKIT_DATA_DIR
if (configured && !isAbsolute(configured)) {
  console.error(`fremkit: FREMKIT_DATA_DIR must be an absolute path, got ${configured}`)
  process.exit(1)
}
// Inside the app, `<root>/data` would be inside the signed bundle, which every update replaces:
// the helper always passes FREMKIT_DATA_DIR there, and a hand-run bundled server must too.
if (!configured && process.env.FREMKIT_ROOT) {
  console.error('fremkit: FREMKIT_ROOT is set but FREMKIT_DATA_DIR is not; refusing to write data inside the app')
  process.exit(1)
}
let dataDir = configured || `${shipped.root}/data`

/**
 * Writing a widget (`FREMKIT_WIDGET_DEV=1`, which `pnpm dev` exports): the author's folder is read
 * beside the built-ins and watched, and a save reloads the widget. See `widgets/dev.ts`.
 */
let devDir: string | undefined
try {
  devDir = widgetDevDir(process.env, dataDir)
} catch (error) {
  console.error(`fremkit: ${(error as Error).message}`)
  process.exit(1)
}

/**
 * A registry served from somewhere else, for development only.
 *
 * The production registry is a constant: one host, https, private addresses refused. That is
 * right, and it makes the install path untestable until something is actually published — so
 * `FREMKIT_REGISTRY_URL` can point at a locally built one, and is honoured **only** under
 * `FREMKIT_DEV=1`. Outside that it is ignored, loudly: an environment variable that silently
 * redirected where a Fremkit installs widgets from would be the worst kind of quiet.
 */
const dev = process.env.FREMKIT_DEV === '1'
const requestedRegistry = process.env.FREMKIT_REGISTRY_URL
let registryUrl: string | undefined
if (requestedRegistry && !dev) {
  console.error('fremkit: FREMKIT_REGISTRY_URL is ignored without FREMKIT_DEV=1; using the published registry')
} else if (requestedRegistry) {
  registryUrl = requestedRegistry
  console.error(`fremkit: FREMKIT_DEV=1, installing widgets from ${requestedRegistry}`)
}

// Not a top-level await: the app's bundled server is CommonJS (see server/scripts/bundle.mjs),
// which has none. A failure still ends the process with a non-zero status, as it did.
/**
 * The local access secret (see `http/access.ts`): the helper's, passed in the environment, or a
 * new one for a server started by hand. Read here, before anything else can spawn a child that
 * would inherit the variable. Never printed.
 */
const access = resolveAccessToken(process.env)
if (access.rejected) console.error('fremkit: FREMKIT_ACCESS_TOKEN is not a valid secret (base64url, 32 bytes or more); using a new one')
const tokenFile = accessTokenPath(port)

async function main(): Promise<void> {
  if (demo) {
    // Never the live dashboard: a temporary folder, or one the caller named that is a demo's.
    try {
      const prepared = await prepareDemoDataDir({ configured, liveDataDir: `${shipped.root}/data` })
      dataDir = prepared.dir
      if (prepared.temporary) process.on('exit', () => rmSync(prepared.dir, { recursive: true, force: true }))
    } catch (error) {
      if (!(error instanceof DemoDataDirError)) throw error
      console.error(`fremkit: ${error.message}`)
      process.exit(1)
    }
    console.error(`fremkit: demo mode, invented data only, data folder ${dataDir}`)
  }
  // Imported only outside demo mode: a demo constructs none of the real providers.
  const providers = demo ? [] : (await import('./providers/index.js')).providers
  const app = await buildApp({
    accessToken: access.token,
    dataDir,
    demo,
    // Keychain items from before they were filed per data folder belong to the live instance.
    adoptLegacyKeychain: !demo && port === 4242,
    widgetsDir: shipped.widgetsDir,
    ...(devDir ? { widgetDevDir: devDir } : {}),
    ...(registryUrl ? { registryUrl, registryDev: true } : {}),
    themesDir: shipped.themesDir,
    uiDist: shipped.uiDist,
    bridgePath: shipped.bridgePath,
    wallpaperPath: join(shipped.wallpaperDir, DEFAULT_BACKGROUND),
    providers,
    logger: true,
    logTail,
    port,
    ...(remotePort !== undefined ? { devicesPort: remotePort } : {}),
  })
  // Both ports stop accepting from the signal handler itself (shutdown.ts).
  installShutdown({ close: () => app.close(), closeListenersNow: () => closeAppListenersNow(app) })
  await app.listen({ port, host: '127.0.0.1' })
  // Written once the port is ours, and removed on the way out: the file names a server that is
  // listening, never one that failed to bind or has gone. The helper knows the secret of a
  // server it spawned without reading this; scripts and a helper facing a `pnpm dev` read it.
  await writeAccessToken(tokenFile, access.token)
  process.on('exit', () => removeAccessToken(tokenFile, access.token))
  app.log.info({ tokenFile, source: access.source }, 'local access secret written')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
