import type { Socket } from './socket'

/**
 * "Reload yourself", from the admin to the pages showing one screen (`POST /api/screens/:id/reload`,
 * `server/src/config/screen-reload.ts`). The server sends it as an event and never replays it, so
 * the page that reloads does not hear it again; a paired device hears it for its own screen only.
 */
export const SCREEN_RELOAD_CHANNEL = 'screen-reload'

/** The screen a reload names, or null for anything that is not one. */
export function reloadTarget(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { screenId } = data as Record<string, unknown>
  return typeof screenId === 'string' ? screenId : null
}

/**
 * Calls `reload` whenever the admin asks for the screen this page shows. `screenId` is read at
 * the moment the message comes: the screen a page shows can change under it (a device moved to
 * another screen, a config with no such screen any more), and a page showing none reloads for none.
 */
export function onScreenReload(socket: Pick<Socket, 'subscribe'>, screenId: () => string | undefined, reload: () => void): () => void {
  return socket.subscribe(SCREEN_RELOAD_CHANNEL, (data) => {
    const target = reloadTarget(data)
    if (target !== null && target === screenId()) reload()
  })
}
