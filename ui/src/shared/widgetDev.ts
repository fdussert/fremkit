import { useSocket } from './socket'

/**
 * Live reload while a widget is being written.
 *
 * A server started with `FREMKIT_WIDGET_DEV=1` watches the widget folders and says, on this
 * channel, which widgets' files were just saved (`server/src/widgets/dev.ts`). Every frame on the
 * page — the dashboard's tiles, the bar, the popover, the admin's previews — reloads when its
 * widget is named; the pages fetch the catalogue again first when a manifest changed. Without
 * the flag the channel is simply silent.
 */
export const WIDGET_DEV_CHANNEL = 'widget-dev'

export interface WidgetReload {
  ids: string[]
  /** A manifest changed (or a widget appeared or went): the catalogue has to be read again. */
  manifest: boolean
}

/** The message as the server sends it, or null for anything else. */
export function parseReload(data: unknown): WidgetReload | null {
  if (typeof data !== 'object' || data === null) return null
  const { ids, manifest } = data as Record<string, unknown>
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null
  return { ids: ids as string[], manifest: manifest === true }
}

type Listener = (reload: WidgetReload) => void
const listeners = new Set<Listener>()
let subscribed = false

/**
 * Calls `cb` for every reload. One socket subscription for the whole page, taken on first use
 * and kept: frames come and go with every page turn, and each one subscribing on its own would
 * have the socket replay the last reload to every frame mounted after it.
 */
export function onWidgetReload(cb: Listener): () => void {
  if (!subscribed) {
    subscribed = true
    useSocket().subscribe(WIDGET_DEV_CHANNEL, (data) => {
      const reload = parseReload(data)
      if (reload) for (const listener of [...listeners]) listener(reload)
    })
  }
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
