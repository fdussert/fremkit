import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { providers } from './providers/index.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
// A second checkout (a worktree, a test bench) can run beside the live server on another port.
// The native helper, the dashboard and the admin still assume 4242: this is for development only.
const port = Number(process.env.FREMKIT_PORT) || 4242

/**
 * Where the config, the backgrounds and the caches live. `<checkout>/data` unless told otherwise.
 *
 * `FREMKIT_DATA_DIR` is what makes a from-scratch run possible on the live checkout without
 * moving anything: the dashboard, the connections list and the background library all come from
 * here, so pointing it elsewhere gives a brand-new install. The keychain is keyed by connection
 * id, so a fresh config never names the real items and they are left untouched.
 *
 * Absolute only: a relative path would be read against whatever directory the process happened
 * to start in, which for the helper's child is the checkout and for a shell is anywhere.
 */
const configured = process.env.FREMKIT_DATA_DIR
if (configured && !isAbsolute(configured)) {
  console.error(`fremkit: FREMKIT_DATA_DIR must be an absolute path, got ${configured}`)
  process.exit(1)
}
const dataDir = configured || `${root}/data`

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

const app = await buildApp({
  dataDir,
  widgetsDir: `${root}/widgets`,
  ...(registryUrl ? { registryUrl, registryDev: true } : {}),
  uiDist: `${root}/ui/dist`,
  providers,
  logger: true,
  port,
})
await app.listen({ port, host: '127.0.0.1' })
