import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { providers } from './providers/index.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
// A second checkout (a worktree, a test bench) can run beside the live server on another port.
// The native helper, the dashboard and the admin still assume 4242: this is for development only.
const port = Number(process.env.FREMKIT_PORT) || 4242
const app = await buildApp({
  dataDir: `${root}/data`,
  widgetsDir: `${root}/widgets`,
  uiDist: `${root}/ui/dist`,
  providers,
  logger: true,
  port,
})
await app.listen({ port, host: '127.0.0.1' })
