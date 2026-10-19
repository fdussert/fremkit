/**
 * The decisions the host makes about a widget's messages, with no DOM in sight.
 *
 * `useWidgetBridge` is Vue glue — refs, watchers, `postMessage` — but the rules it applies are
 * the security boundary between the dashboard and third-party code, so they live here where they
 * can be exercised directly.
 */

import { channelAllowed } from './types'

/** A non-empty string, or null. Every field of a widget's message goes through this. */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The bundle id whose local icon the host may retrieve, never a path or URL. */
export function appIconTarget(message: { bundleId?: unknown }): string | null {
  const id = nonEmptyString(message.bundleId)
  return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : null
}

/**
 * The origin a `fremkit:favicon` request is about, or null.
 *
 * A widget hands over the link it holds; the host forwards the origin alone. The server keys its
 * cache by origin anyway, and the path — which can carry a token or a private page — then never
 * leaves the widget at all. Only http(s): a `file:` or `mailto:` link has no favicon.
 */
export function faviconTarget(message: { url?: unknown }): string | null {
  const url = nonEmptyString(message.url)
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
}

/**
 * The exact image address a `fremkit:image` message may have fetched, or null.
 *
 * Unlike a favicon, the whole address leaves the machine, path included — so the host fetches
 * only an address the user typed into this widget's own settings. A widget cannot use it to send
 * whatever it likes to whichever host it likes, one image request at a time. `settings` is the
 * instance's saved settings alone: a manifest default is the widget's own words, not the user's.
 */
export function imageTarget(message: { url?: unknown }, settings: unknown): string | null {
  const url = nonEmptyString(message.url)?.trim()
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return settingsHold(settings, url) ? url : null
}

function settingsHold(value: unknown, wanted: string): boolean {
  if (typeof value === 'string') return value.trim() === wanted
  if (Array.isArray(value)) return value.some((v) => settingsHold(v, wanted))
  if (value && typeof value === 'object') return Object.values(value).some((v) => settingsHold(v, wanted))
  return false
}

/**
 * Puts *this* frame's instanceId on a command payload, whatever the widget wrote there.
 *
 * Commands that act on the user's behalf — pressing a saved shortcut button, probing saved
 * hosts — resolve their target from the dashboard by instanceId, so the id is the authority. A
 * widget that simply named another instance's id would drive it, and the ids are guessable: a
 * known `<widgetId>-` prefix and four characters of `Math.random`. The host knows which frame
 * it is talking to, so the host is what says so.
 *
 * A payload that is not a plain object is passed through untouched; the server refuses it.
 */
export function stampInstance(payload: unknown, instanceId: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return { ...(payload as Record<string, unknown>), instanceId }
}

/**
 * The URL a `fremkit:fetch` may go to, or null when the request is refused.
 *
 * The proxy behind it is GET-only. An `init` naming any other method — or naming one that is
 * not even a string — is refused rather than quietly turned into a GET: the widget asked for
 * something the bridge never promised.
 */
export function fetchTarget(message: { url?: unknown; init?: unknown }): string | null {
  const url = nonEmptyString(message.url)
  if (!url) return null
  const init = message.init
  if (init === undefined || init === null) return url
  if (typeof init !== 'object' || Array.isArray(init)) return null
  const method = (init as { method?: unknown }).method
  // Absent is fine and means GET; present must be exactly the string.
  if (method === undefined) return url
  return method === 'GET' ? url : null
}

/**
 * A `conn:` request, as the host should read it, or null.
 *
 * `conn:` means "the connection this instance is bound to". The widget never names a connection,
 * a host or a token — it names a path, and the server decides the rest. So everything checked
 * here is shape: a rooted path, a method the declaration could have listed, a string body, and
 * the two headers a widget is allowed to set.
 *
 * The real allow-list is the server's. This only refuses what is not worth a round trip.
 */
export function connRequest(message: { url?: unknown; init?: unknown }): {
  path: string
  method: string
  body?: string
  headers?: Record<string, string>
} | null {
  const url = nonEmptyString(message.url)
  if (!url || !url.startsWith('conn:')) return null
  const path = url.slice('conn:'.length)
  if (!path.startsWith('/')) return null

  const init = message.init
  if (init === undefined || init === null) return { path, method: 'GET' }
  if (typeof init !== 'object' || Array.isArray(init)) return null
  const raw = init as { method?: unknown; body?: unknown; headers?: unknown }

  const method = raw.method === undefined ? 'GET' : raw.method
  if (typeof method !== 'string') return null
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null

  let body: string | undefined
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body !== 'string') return null
    body = raw.body
  }

  let headers: Record<string, string> | undefined
  if (raw.headers !== undefined && raw.headers !== null) {
    if (typeof raw.headers !== 'object' || Array.isArray(raw.headers)) return null
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      // The server refuses anything else too; saying so here saves a request the widget's author
      // would otherwise have to read a 403 to understand.
      if (!['content-type', 'accept'].includes(name.toLowerCase())) return null
      out[name.toLowerCase()] = value
    }
    headers = out
  }

  return { path, method, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }
}

/**
 * Whether the document currently inside a widget's iframe is still the one the host trusts.
 *
 * `ev.source` is the iframe's `contentWindow`, and that object survives a navigation: a widget
 * that sets `location` gets a brand-new document holding the same `contentWindow`, which would
 * keep answering as that widget and inherit its subscriptions — a channel carrying a
 * connection's data among them.
 *
 * Two signs of a new document, whichever comes first:
 *
 * - a second `fremkit:hello` for the same `src`. The bridge says hello exactly once per document,
 *   synchronously, before any of the widget's code runs — so this one arrives *before* the new
 *   document's `load`, and also catches a navigation made before the first `load` ever fired;
 * - a `load` whose `src` is unchanged (a self-navigation to a page that runs no bridge).
 *
 * A hello or a load with a *different* `src` is the host pointing the frame at another widget,
 * and is trusted. A *new element* — which is what a `v-if` does when a manifest disappears and
 * comes back after a rescan — starts over: before that, a rescan disowned an innocent frame for
 * the rest of its life.
 *
 * Trust decides whether the host answers at all; what it answers *over* is a `MessagePort`
 * handed to the document that said hello (see `useWidgetBridge`), so nothing the host sends
 * after a navigation can reach the next document even before this class has noticed.
 */
export class FrameTrust {
  private loadedSrc: string | null = null
  private helloSrc: string | null = null
  /** The src that was disowned; only the host pointing the frame elsewhere lifts it. */
  private disownedSrc: string | null = null

  /** True while the host should answer the frame. */
  get trusted(): boolean {
    return this.disownedSrc === null
  }

  /** Called on every `load` event of the current element. */
  onLoad(src: string | null): void {
    this.loadedSrc = this.see(this.loadedSrc, src ?? '')
  }

  /** Called on every `fremkit:hello` the frame's window posts. */
  onHello(src: string | null): void {
    this.helloSrc = this.see(this.helloSrc, src ?? '')
  }

  /** A second sighting of the same src is a new document; a different src is the host's doing. */
  private see(previous: string | null, value: string): string {
    if (previous === value) this.disownedSrc = value
    else if (this.disownedSrc !== null && this.disownedSrc !== value) this.disownedSrc = null
    return value
  }

  /** Called when the iframe element itself is replaced: a fresh element is a fresh document. */
  reset(): void {
    this.loadedSrc = null
    this.helloSrc = null
    this.disownedSrc = null
  }
}

/**
 * The nonce of a `fremkit:hello`, or null when the message is not one.
 *
 * The bridge sends the same nonce twice: in the hello it posts to the window, and as the first
 * message on the port the host hands back. A document that got the port without having said
 * that hello — the next one, after a navigation raced the answer — cannot repeat it.
 */
export function helloNonce(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const m = message as { type?: unknown; nonce?: unknown }
  if (m.type !== 'fremkit:hello' || typeof m.nonce !== 'string') return null
  return /^[0-9a-f]{16,64}$/.test(m.nonce) ? m.nonce : null
}

/**
 * Whether a widget may read the list of installed applications through the host.
 *
 * Only a widget subscribed to `dock`, which already shows it the Dock's applications and their
 * bundle ids and which the consent dialog lists. A list of what is installed on this Mac is a fine
 * fingerprint, so a widget that asked for nothing gets nothing.
 */
export function mayListApps(subscriptions: string[] | undefined): boolean {
  return channelAllowed(subscriptions ?? [], 'dock')
}

/** Dispatched on the host window when a widget asks, through the bridge, to hold swipes off. */
export const HOLD_SWIPE_EVENT = 'fremkit:hold-swipe'
