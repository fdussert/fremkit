import type { FastifyInstance } from 'fastify'
import type { Platform } from '../platform/index.js'

export interface WslRoutesOptions {
  /** The platform the server runs on: the Privacy pane shows its WSL section on `win32` only. */
  platform: Platform
  /** The installed distributions (`listDistros`); answers nothing off Windows and in a demo. */
  list: () => Promise<string[]>
}

/**
 * `GET /api/wsl/distros`: which WSL distributions the admin may offer to tick. Behind the access
 * secret like every route, and local only: it is not in `devices/allowlist.ts`, so the remote
 * listener answers 404 (`devices-gate.test.ts`). Listing boots nothing.
 */
export async function wslRoutes(app: FastifyInstance, opts: WslRoutesOptions): Promise<void> {
  app.get('/api/wsl/distros', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return { platform: opts.platform, distros: await opts.list() }
  })
}
