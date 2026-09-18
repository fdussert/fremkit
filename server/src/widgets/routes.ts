import type { FastifyInstance } from 'fastify'
import '@fastify/static'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIDGET_ID_RE } from '../config/schema.js'
import type { WidgetCatalog } from './catalog.js'
import type { ConfigStore } from '../config/store.js'
import { grantedCatalog } from '../marketplace/consent.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { tr } from '../i18n.js'

const BRIDGE_PATH = fileURLToPath(new URL('../bridge/fremkit.js', import.meta.url))
const BRIDGE_TAG = '<script src="/fremkit.js"></script>'

/**
 * What a widget may do, said in a header rather than left to the iframe.
 *
 * A widget is third-party code. The dashboard runs it in a `sandbox="allow-scripts"` iframe, but
 * that only binds the frame: a browser pointed straight at `/widgets/<id>/index.html` — a link,
 * a redirect, a page opening a window — used to run the widget with the full rights of
 * `http://127.0.0.1:4242`, the origin the WebSocket and the connections API trust. The header
 * travels with the bytes, so it holds wherever the document ends up.
 *
 * `sandbox allow-scripts` without `allow-same-origin` puts the document in an opaque origin:
 * scripts run, but nothing they do counts as coming from us. Everything else is an allow-list of
 * what the widgets in this repository actually need — `'self'` for their own files and the
 * bridge, `data:`/`blob:` for what they generate, `i.scdn.co` for the album art the local
 * Spotify app hands us as an https URL. No `connect-src` at all: every network call goes through
 * `Fremkit.fetch`, which asks the host, which asks the proxy, which checks the manifest.
 */
export const WIDGET_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://i.scdn.co",
  "media-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function injectBridge(html: string): string {
  const i = html.search(/<head[^>]*>/i)
  if (i >= 0) {
    const end = html.indexOf('>', i) + 1
    return html.slice(0, end) + BRIDGE_TAG + html.slice(end)
  }
  return BRIDGE_TAG + html
}

export async function widgetRoutes(app: FastifyInstance, opts: { catalog: WidgetCatalog; store: ConfigStore }): Promise<void> {
  const bridge = await readFile(BRIDGE_PATH, 'utf8')

  app.get('/fremkit.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').send(bridge))

  /**
   * The catalogue, and the SDK generation it is being read against: a manifest declaring more
   * than `sdk` needs a newer Fremkit, and saying so is the admin's job, which means the admin has
   * to be told the number rather than guess it from the server's own version.
   */
  const answer = (): { widgets: Record<string, unknown>; sources: Record<string, string>; errors: unknown[]; sdk: number } => ({
    // What each widget may do, not what it asks for: an installed widget's manifest is narrowed
    // to the permissions the user accepted, so the bridge host relays nothing beyond them.
    widgets: Object.fromEntries(grantedCatalog(opts.catalog, opts.store.get())),
    // Where each widget came from, so the library can mark the installed ones and the admin can
    // offer to remove them. A manifest cannot carry it: it is a fact about the folder, not a
    // claim the widget's author gets to make.
    sources: Object.fromEntries([...opts.catalog.entries].map(([id, e]) => [id, e.source])),
    errors: opts.catalog.errors,
    sdk: SDK_VERSION,
  })

  app.get('/api/widgets', async () => answer())

  app.post('/api/widgets/rescan', async () => {
    await opts.catalog.scan()
    return answer()
  })

  app.get<{ Params: { id: string; '*': string } }>('/widgets/:id/*', async (req, reply) => {
    const { id } = req.params
    const rel = req.params['*'] || 'index.html'
    // On every answer, not just the entry point: a widget's second HTML file is the same
    // untrusted code, and on a case-insensitive filesystem so is `Index.html`.
    reply.header('content-security-policy', WIDGET_CSP)
    // The folder rather than the root: a widget may be a built-in or one the user installed, and
    // which of the two owns an id is the catalogue's answer, decided once at scan time.
    const folder = opts.catalog.folderOf(id)
    if (!WIDGET_ID_RE.test(id) || !folder) return reply.code(404).send({ error: tr(undefined, 'widgets.unknown') })
    const safeRel = normalize(rel)
    if (safeRel.startsWith('..') || safeRel.includes('/../')) return reply.code(400).send({ error: 'chemin invalide' })
    if (safeRel.toLowerCase() === 'index.html') {
      let html: string
      try {
        html = await readFile(join(folder, 'index.html'), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'widget introuvable' })
        throw err
      }
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(injectBridge(html))
    }
    // A widget folder has no business serving its own dotfiles, whatever an author drops in it.
    // `folder` is the widget's own, so `root` is it: @fastify/static still refuses a path that
    // escapes the root it is handed, and `safeRel` was checked before getting here.
    return reply.sendFile(safeRel, folder, { dotfiles: 'deny' })
  })
}
