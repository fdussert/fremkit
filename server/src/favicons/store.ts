import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { USER_AGENT } from '../version.js'
import { pickIconHref } from './pick.js'

/** How long a cached icon is served without asking the site again. */
export const FAVICON_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Only the head of a page is read: the icon links live in `<head>`, and pages can be huge. */
export const MAX_HTML_BYTES = 64 * 1024
/** Largest icon accepted. Well above any real apple-touch-icon. */
export const MAX_ICON_BYTES = 512 * 1024
/** One hop for the site's own canonicalisation, a couple more for a CDN. */
export const MAX_REDIRECTS = 3
const TIMEOUT_MS = 5_000

/**
 * Content types we accept, and the extension each is stored under.
 *
 * No SVG: an SVG is a document that can carry script, and an icon is served from this server's
 * own origin — the one the WebSocket and the connections API trust. A site whose only icon is an
 * SVG gets no icon rather than a foothold.
 */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/ico': 'ico',
}
/** The extensions a cached file can carry, for the lookup that has no content type to go on. */
const CACHED_EXTENSIONS = [...new Set(Object.values(EXTENSIONS))]
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon',
}

export interface FaviconIcon { body: Buffer; contentType: string }
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The cache file name for an origin.
 *
 * The origin alone is the key, so every page of a site shares one icon and the cache cannot be
 * grown by a widget pointing at a thousand paths of the same host. Hashed rather than spelled
 * out, so the file names carry no host name and cannot escape the folder.
 */
export function cacheKey(origin: string): string {
  return createHash('sha256').update(origin).digest('hex')
}

/** True while a file written at `mtimeMs` may still be served without asking the site again. */
export function isFresh(mtimeMs: number, now: number): boolean {
  return now - mtimeMs < FAVICON_TTL_MS
}

/** The stored extension for a content type, or null when it is not an image we keep. */
export function extensionFor(contentType: string | null): string | null {
  if (!contentType) return null
  const type = contentType.split(';')[0].trim().toLowerCase()
  return EXTENSIONS[type] ?? null
}

/**
 * The image type a file's first bytes announce, for sites that serve their icon as
 * `application/octet-stream` or with no type at all — a common setup for `favicon.ico`.
 * Only formats whose signature is unambiguous are recognised; anything else is not an image.
 */
export function sniffImageType(body: Uint8Array): string | null {
  const b = body
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  // ICO: reserved 0, type 1, then a small image count.
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0 && b[5] === 0) return 'image/x-icon'
  return null
}

/**
 * Site icons, fetched once a week and kept on disk.
 *
 * Nothing here ever logs or echoes the URL it was given: the only thing a caller learns from a
 * failure is that there is no icon.
 */
export class FaviconStore {
  private readonly dir: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  /** One refresh per origin at a time, so a row of buttons on one site makes one fetch. */
  private readonly inFlight = new Map<string, Promise<FaviconIcon | null>>()

  constructor(opts: { dir: string; fetchImpl?: FetchLike; now?: () => number }) {
    this.dir = opts.dir
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? Date.now
  }

  /**
   * Deletes icons the cache is no longer allowed to serve.
   *
   * An older version accepted SVG, so a cache filled before this one can hold `.svg` files.
   * `readCached` already ignores them — this removes them from disk so they cannot come back if
   * the accepted types ever widen again.
   */
  async purgeUnservable(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.dir) } catch { return }
    for (const name of names) {
      if (!/\.svg(\.tmp)?$/i.test(name)) continue
      try { await unlink(join(this.dir, name)) } catch { /* gone already */ }
    }
  }

  /** The icon for an origin: cached while fresh, re-fetched after that, stale on failure. */
  async get(origin: string): Promise<FaviconIcon | null> {
    const cached = await this.readCached(origin)
    if (cached && isFresh(cached.mtimeMs, this.now())) return cached.icon
    const pending = this.inFlight.get(origin) ?? this.refresh(origin)
    this.inFlight.set(origin, pending)
    try {
      const fresh = await pending
      // Stale beats nothing: a site that is down for a day keeps showing the icon it had.
      return fresh ?? cached?.icon ?? null
    } finally {
      this.inFlight.delete(origin)
    }
  }

  private async refresh(origin: string): Promise<FaviconIcon | null> {
    try {
      const icon = await this.resolve(origin)
      if (!icon) return null
      await this.write(origin, icon)
      return icon
    } catch {
      return null
    }
  }

  /** Reads the page, picks the declared icon, falls back to `/favicon.ico` at the origin. */
  private async resolve(origin: string): Promise<FaviconIcon | null> {
    let declared: string | null = null
    try {
      const page = await this.request(origin + '/')
      if (page && /text\/html|application\/xhtml/i.test(page.res.headers.get('content-type') ?? '')) {
        const html = await readCapped(page.res, MAX_HTML_BYTES, true)
        if (html) declared = pickIconHref(html.toString('utf8'), page.finalUrl)
      } else if (page) {
        void page.res.body?.cancel().catch(() => {})
      }
    } catch { /* unreachable page: the fallback below may still work */ }

    if (declared) {
      const icon = await this.fetchIcon(declared)
      if (icon) return icon
    }
    return await this.fetchIcon(origin + '/favicon.ico')
  }

  private async fetchIcon(url: string): Promise<FaviconIcon | null> {
    let got: { res: Response; finalUrl: string } | null
    try { got = await this.request(url) } catch { return null }
    if (!got) return null
    const { res } = got
    if (!res.ok) { void res.body?.cancel().catch(() => {}); return null }
    const declaredType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    // A declared text, HTML or XML type is never an icon we keep (a login page answering for
    // /favicon.ico, or an SVG); an image type is taken at its word; anything else is settled by
    // the bytes themselves.
    if (/^text\/|html|json|xml|svg/.test(declaredType)) { void res.body?.cancel().catch(() => {}); return null }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) { void res.body?.cancel().catch(() => {}); return null }
    const body = await readCapped(res, MAX_ICON_BYTES, false)
    if (!body || body.byteLength === 0) return null
    const contentType = extensionFor(declaredType) ? declaredType : sniffImageType(body)
    if (!contentType) return null
    return { body, contentType }
  }

  /**
   * One GET, following at most `MAX_REDIRECTS` hops and never leaving http/https: a `Location`
   * pointing at `file:` or anything else ends the walk instead of being followed.
   */
  private async request(url: string): Promise<{ res: Response; finalUrl: string } | null> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      })
      if (![301, 302, 303, 307, 308].includes(res.status)) return { res, finalUrl: current }
      const location = res.headers.get('location')
      void res.body?.cancel().catch(() => {})
      if (!location) return null
      let next: URL
      try { next = new URL(location, current) } catch { return null }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return null
      current = next.toString()
    }
    return null
  }

  private async readCached(origin: string): Promise<{ icon: FaviconIcon; mtimeMs: number } | null> {
    for (const ext of CACHED_EXTENSIONS) {
      const file = join(this.dir, `${cacheKey(origin)}.${ext}`)
      try {
        const info = await stat(file)
        return { icon: { body: await readFile(file), contentType: TYPE_BY_EXTENSION[ext] }, mtimeMs: info.mtimeMs }
      } catch { /* not this extension */ }
    }
    return null
  }

  private async write(origin: string, icon: FaviconIcon): Promise<void> {
    const ext = extensionFor(icon.contentType)
    if (!ext) return
    await mkdir(this.dir, { recursive: true })
    const key = cacheKey(origin)
    const target = join(this.dir, `${key}.${ext}`)
    const tmp = `${target}.tmp`
    await writeFile(tmp, icon.body)
    await rename(tmp, target)
    // A site that switched format would otherwise keep a second, older file forever.
    for (const other of CACHED_EXTENSIONS) {
      if (other === ext) continue
      try { await unlink(join(this.dir, `${key}.${other}`)) } catch { /* never existed */ }
    }
  }
}

/**
 * Reads a body, giving up past `max` bytes.
 *
 * `truncate` is for HTML, where the first 64 kB is all we want and the rest is dropped; an icon
 * past the cap is refused outright instead, since half a PNG is not an icon.
 */
async function readCapped(res: Response, max: number, truncate: boolean): Promise<Buffer | null> {
  const reader = res.body?.getReader()
  if (!reader) {
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength <= max) return buffer
    return truncate ? buffer.subarray(0, max) : null
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.byteLength
      if (total >= max) {
        void reader.cancel().catch(() => {})
        return truncate ? Buffer.concat(chunks).subarray(0, max) : null
      }
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks)
}
