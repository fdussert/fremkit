import type { FastifyInstance } from 'fastify'
import { isLocalRequest } from '../net/remote.js'
import type { ConfigStore } from './store.js'

/**
 * The channel a dashboard hears "reload yourself" on: `{ screenId, at }`, for the pages showing
 * screen `screenId`. A host channel (`HOST_CHANNELS`), so the dashboard page subscribes to it
 * outside any widget, and a paired device hears it only for its own screen (`deviceHostView`).
 *
 * An event, never a state: the hub sends it with `notify`, which keeps no last value, so a page
 * that loads after the request — the reloaded one included — is not told to reload again.
 */
export const SCREEN_RELOAD_CHANNEL = 'screen-reload'

export interface ScreenReload {
  screenId: string
  /** When the admin asked, in this Mac's epoch ms. Informative: no replay to guard against. */
  at: number
}

/** The message as the server sends it, or null for anything else. */
export function parseScreenReload(data: unknown): ScreenReload | null {
  if (typeof data !== 'object' || data === null) return null
  const { screenId, at } = data as Record<string, unknown>
  if (typeof screenId !== 'string' || typeof at !== 'number') return null
  return { screenId, at }
}

/**
 * `POST /api/screens/:id/reload`: the admin's "Reload the dashboard", the counterpart of the
 * helper's status-menu item, which reaches every page showing that screen — the Edge's kiosk,
 * a browser tab, a paired iPad — rather than the kiosk alone.
 *
 * Local only, twice over, like the diagnostics: the remote listener's allow-list does not name it
 * (a paired device gets 404 there), and the handler checks `isLocalRequest` itself.
 */
export async function screenReloadRoutes(
  app: FastifyInstance,
  opts: { store: ConfigStore; notify: (channel: string, data: ScreenReload) => void; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now
  app.post<{ Params: { id: string } }>('/api/screens/:id/reload', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send()
    const { id } = req.params
    if (!opts.store.get().screens.some((s) => s.id === id)) return reply.code(404).send()
    opts.notify(SCREEN_RELOAD_CHANNEL, { screenId: id, at: now() })
    return reply.code(204).send()
  })
}
