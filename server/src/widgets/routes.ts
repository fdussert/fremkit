import type { FastifyInstance } from 'fastify'
import '@fastify/static'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { WIDGET_ID_RE } from '../config/schema.js'
import type { WidgetCatalog } from './catalog.js'
import type { ConfigStore } from '../config/store.js'
import { grantedCatalog, permissionsOf, type Permissions } from '../marketplace/consent.js'
import { SDK_VERSION } from '../bridge/sdk.js'
import { tr } from '../i18n.js'
import { isLocalRequest, isRemoteRequest } from '../net/remote.js'
import { requestScope, widgetInScope, type ScreenOfDevice } from '../devices/scope.js'
import { isIP } from 'node:net'
import { hostAddresses, webrtcLevel, type WebRtcLevel } from './webrtc.js'


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
 * what the widgets in this repository actually need. WebKit does not resolve `'self'` for
 * opaque frames, so the server's loopback origins are listed explicitly for packaged files.
 * `data:`/`blob:` cover what widgets generate, `i.scdn.co` covers album art the local
 * Spotify app hands us as an https URL. No `connect-src` at all: every network call goes through
 * `Fremkit.fetch`, which asks the host, which asks the proxy, which checks the manifest.
 *
 * `frame-ancestors`: only our own pages may frame a widget — the dashboard and the admin, on the
 * same loopback origins (CSP has no syntax for an IPv6 literal, so a page loaded from `[::1]`
 * frames none, as its own `frame-src` already could not), or, through the remote listener, the
 * device origin the page came from, so a paired iPad still frames its widgets. Any other web page
 * gets no widget document to frame, and so none to read the bridge's attributes (Fremplay's
 * `data-webrtc-hosts`, this Mac's addresses) or to hand a `fremkit:connect` from its own window.
 */
export function widgetCsp(port = 4242, dev = false, remoteOrigin?: string): string {
  // On the remote listener the page was loaded from `https://<host>:4243` and nothing else: the
  // loopback origins would name the iPad itself.
  const ownOrigins = remoteOrigin !== undefined
    ? [remoteOrigin]
    : [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  if (dev && remoteOrigin === undefined) ownOrigins.push('http://127.0.0.1:5173', 'http://localhost:5173')
  const own = ownOrigins.join(' ')
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'self' ${own} 'unsafe-inline'`,
    `style-src 'self' ${own} 'unsafe-inline'`,
    `img-src 'self' ${own} data: blob: https://i.scdn.co`,
    `media-src 'self' ${own} data:`,
    `font-src 'self' ${own}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${own}`,
  ].join('; ')
}

export const WIDGET_CSP = widgetCsp()

/**
 * Where the bridge goes: before anything of the widget's own can run.
 *
 * The bridge is what takes WebRTC away (see `webrtc.ts`), so a single widget script running
 * before it would have the constructors to itself. It is placed straight after a leading
 * doctype — the only thing allowed ahead of it, since a doctype cannot run anything and moving
 * it behind a script would put the page in quirks mode — and at the very start otherwise. Not
 * "after `<head>`": a regex for that also matches `<header>`, or a `<head>` inside a comment,
 * with a script of the widget's written before it.
 */
const LEADING_DOCTYPE = /^\uFEFF?[\t\n\f\r ]*<!doctype[^>]*>/i

export function bridgeTag(level: WebRtcLevel = 'none', addresses: string[] = []): string {
  if (level === 'none') return '<script src="/fremkit.js"></script>'
  // IP literals only (hostAddresses), so nothing here needs escaping; filtered again regardless.
  const hosts = addresses.filter((a) => isIP(a)).join(' ')
  return `<script src="/fremkit.js" data-webrtc="local" data-webrtc-hosts="${hosts}"></script>`
}

export function injectBridge(html: string, tag: string = bridgeTag()): string {
  const doctype = LEADING_DOCTYPE.exec(html)
  const at = doctype ? doctype[0].length : 0
  return html.slice(0, at) + tag + html.slice(at)
}

/**
 * Files a browser would run script in if the frame navigated to them. Only a widget's
 * `index.html` gets the bridge, so any other document is served with no script at all: a second
 * page would otherwise run with WebRTC intact. A widget has one page — the host disowns a frame
 * that navigates (`FrameTrust`) — so nothing that works today is lost.
 */
const DOCUMENT_EXTENSIONS = /\.(html?|xhtml|xht|svgz?|xml|xsl|xslt|mht|mhtml)$/i

export function scriptlessCsp(csp: string): string {
  return csp.replace(/script-src [^;]*/, "script-src 'none'")
}

export async function widgetRoutes(
  app: FastifyInstance,
  opts: {
    catalog: WidgetCatalog; store: ConfigStore; bridgePath: string; port?: number; dev?: boolean
    /** The device screen a paired device is attached to: what its catalogue is narrowed to. */
    screenOfDevice?: ScreenOfDevice
    /** The built-ins allowed WebRTC's `local` level; `WEBRTC_LOCAL_BUILTINS` unless a test says otherwise. */
    webrtcLocalBuiltins?: ReadonlySet<string>
  },
): Promise<void> {
  const bridge = await readFile(opts.bridgePath, 'utf8')
  const csp = widgetCsp(opts.port, opts.dev)

  app.get('/fremkit.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').send(bridge))

  /**
   * The catalogue, and the SDK generation it is being read against: a manifest declaring more
   * than `sdk` needs a newer Fremkit, and saying so is the admin's job, which means the admin has
   * to be told the number rather than guess it from the server's own version.
   */
  const answer = (): {
    widgets: Record<string, unknown>
    sources: Record<string, string>
    asks: Record<string, Permissions>
    errors: unknown[]
    sdk: number
  } => ({
    // What each widget may do, not what it asks for: an installed widget's manifest is narrowed
    // to the permissions the user accepted, so the bridge host relays nothing beyond them.
    widgets: Object.fromEntries(grantedCatalog(opts.catalog, opts.store.get())),
    // Where each widget came from, so the library can mark the installed ones and the admin can
    // offer to remove them. A manifest cannot carry it: it is a fact about the folder, not a
    // claim the widget's author gets to make.
    sources: Object.fromEntries([...opts.catalog.entries].map(([id, e]) => [id, e.source])),
    /**
     * What each widget's manifest *asks* for, un-narrowed.
     *
     * The dashboard must never read this — it would be a widget's own claim about itself, and
     * the whole point of the narrowing is that nothing downstream sees it. The admin does need
     * it: "asks for X, granted Y" is the only way a user can tell a widget that is quietly
     * missing a permission from one that never wanted it.
     */
    asks: Object.fromEntries([...opts.catalog.entries].map(([id, e]) => [id, permissionsOf(e.manifest)])),
    errors: opts.catalog.errors,
    sdk: SDK_VERSION,
  })

  app.get('/api/widgets', async (req) => {
    const all = answer()
    if (!isRemoteRequest(req)) return all
    // A paired device draws the widgets of its own screen and nothing else. Its page looks a
    // manifest up only through an instance of its config view (pages, bar and bar popover alike),
    // which holds that screen's instances alone, so the rest of the catalogue — what else is
    // installed on this Mac — is none of its business; a device with no screen gets none. The
    // scan's errors quote paths on this Mac, and the un-narrowed asks are the admin's (see above).
    const config = opts.store.get()
    const scope = requestScope(req, opts.screenOfDevice ?? (() => null))
    const shown = (id: string): boolean => widgetInScope(config, scope, id)
    return {
      ...all,
      widgets: Object.fromEntries(Object.entries(all.widgets).filter(([id]) => shown(id))),
      sources: Object.fromEntries(Object.entries(all.sources).filter(([id]) => shown(id))),
      asks: {},
      errors: [],
    }
  })

  app.post('/api/widgets/rescan', async () => {
    await opts.catalog.scan()
    return answer()
  })

  app.get<{ Params: { id: string; '*': string } }>('/widgets/:id/*', async (req, reply) => {
    const { id } = req.params
    const rel = req.params['*'] || 'index.html'
    // On every answer, not just the entry point: a widget's second HTML file is the same
    // untrusted code, and on a case-insensitive filesystem so is `Index.html`.
    // Remote: built per request from the Host the devices gate has already checked against the
    // names the listener answers to, so it cannot be steered to an origin of the sender's choice.
    const policy = isRemoteRequest(req)
      ? widgetCsp(opts.port, opts.dev, `https://${String(req.headers.host).toLowerCase()}`)
      : csp
    reply.header('content-security-policy', policy)
    // The folder rather than the root: a widget may be a built-in or one the user installed, and
    // which of the two owns an id is the catalogue's answer, decided once at scan time.
    const folder = opts.catalog.folderOf(id)
    if (!WIDGET_ID_RE.test(id) || !folder) return reply.code(404).send({ error: tr(undefined, 'widgets.unknown') })
    const safeRel = normalize(rel)
    if (safeRel.startsWith('..') || safeRel.includes('/../')) return reply.code(400).send({ error: tr(undefined, 'widgets.badPath') })
    if (safeRel.toLowerCase() === 'index.html') {
      let html: string
      try {
        html = await readFile(join(folder, 'index.html'), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: tr(undefined, 'widgets.missing') })
        throw err
      }
      // The `local` level, and the Mac's addresses it carries, only for a page asked for on this
      // Mac. Through the remote listener these files answer before pairing, to any LAN peer it
      // accepts, and a device can never receive an offer anyway (`companion` is local-only).
      const level = isLocalRequest(req) ? webrtcLevel(id, opts.catalog.entry(id)?.source, opts.webrtcLocalBuiltins) : 'none'
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(injectBridge(html, bridgeTag(level, level === 'local' ? hostAddresses() : [])))
    }
    if (DOCUMENT_EXTENSIONS.test(safeRel)) reply.header('content-security-policy', scriptlessCsp(policy))
    // A widget folder has no business serving its own dotfiles, whatever an author drops in it.
    // `folder` is the widget's own, so `root` is it: @fastify/static still refuses a path that
    // escapes the root it is handed, and `safeRel` was checked before getting here.
    return reply.sendFile(safeRel, folder, { dotfiles: 'deny' })
  })
}
