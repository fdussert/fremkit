/**
 * Talking to the registry: the index, and the packages it names.
 *
 * One registry, named in one place. A second one is a decision nobody has taken, so this is a
 * constant rather than a setting — but the index carries its own `registry` name and every
 * consent record stores it, which is the part that would be expensive to add afterwards.
 *
 * The outbound rules are the project's usual ones, for the usual reason: this is the server
 * fetching a URL on the user's behalf, and the only thing standing between the network and the
 * disk. https only, a timeout on every call, a byte ceiling read as the body streams rather
 * than trusted from `content-length`, no redirect off the registry's own host, and the
 * private-address refusal in case that host ever resolves somewhere it should not.
 */

import { RegistryIndexSchema, type IndexWidget, type RegistryIndex } from './index-schema.js'
import { resolvesToPrivate } from '../net/private.js'
import { USER_AGENT } from '../version.js'
import { tr } from '../i18n.js'
import type { Locale } from '../config/schema.js'

/** The one registry, and the only URL this module will fetch anything from. */
export const REGISTRY_URL = 'https://fdussert.github.io/fremkit-widgets/index.json'

/** Twenty minutes of network trouble is a bad afternoon; a day-old index is never wrong enough to matter. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000

const INDEX_TIMEOUT_MS = 15_000
const PACKAGE_TIMEOUT_MS = 60_000
/** An index of a few hundred widgets is tens of kilobytes; this is three orders of magnitude of room. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024
/** The registry refuses anything bigger, and so does this — neither trusts the other's word for it. */
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024

export class RegistryError extends Error {
  constructor(readonly key: 'marketplace.unreachable' | 'marketplace.badIndex' | 'marketplace.badUrl' | 'marketplace.tooLarge', locale?: Locale) {
    super(tr(locale, key))
    this.name = 'RegistryError'
  }
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>

export interface RegistryOptions {
  url?: string
  /** Injected by the tests; production uses the global `fetch`. */
  fetch?: Fetcher
  isPrivate?: (host: string) => Promise<boolean>
  now?: () => number
}

/** Reads a body with a ceiling, rather than believing `content-length`. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { void reader.cancel().catch(() => {}); throw new RegistryError('marketplace.tooLarge') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export class Registry {
  private cached: RegistryIndex | null = null
  private fetchedAt = 0
  /** One flight at a time: four widgets asking at once must not make four requests. */
  private inFlight: Promise<RegistryIndex> | null = null

  readonly url: string
  private readonly doFetch: Fetcher
  private readonly isPrivate: (host: string) => Promise<boolean>
  private readonly now: () => number

  constructor(opts: RegistryOptions = {}) {
    this.url = opts.url ?? REGISTRY_URL
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'manual' }))
    this.isPrivate = opts.isPrivate ?? resolvesToPrivate
    this.now = opts.now ?? Date.now
  }

  /** The host every URL in the index must be on. A registry does not get to name other servers. */
  get host(): string { return new URL(this.url).hostname }

  /** The last index read, however old, or null if none ever was. Never fetches. */
  get last(): RegistryIndex | null { return this.cached }
  get lastFetchedAt(): number | null { return this.cached ? this.fetchedAt : null }

  /**
   * The index, from memory while it is fresh. A failed refresh keeps the cached one: an offline
   * afternoon should leave the marketplace readable, with the admin saying it could not reach
   * the registry — not empty, which reads as "every widget was withdrawn".
   */
  async index(force = false): Promise<RegistryIndex> {
    if (!force && this.cached && this.now() - this.fetchedAt < INDEX_TTL_MS) return this.cached
    if (this.inFlight) return this.inFlight
    this.inFlight = this.load().finally(() => { this.inFlight = null })
    try {
      return await this.inFlight
    } catch (err) {
      if (this.cached) return this.cached
      throw err
    }
  }

  private async load(): Promise<RegistryIndex> {
    const body = await this.get(this.url, MAX_INDEX_BYTES)
    let json: unknown
    try { json = JSON.parse(body.toString('utf8')) } catch { throw new RegistryError('marketplace.badIndex') }
    const parsed = RegistryIndexSchema.safeParse(json)
    if (!parsed.success) throw new RegistryError('marketplace.badIndex')
    // Every URL the index names, checked once, here — so nothing downstream has to remember to.
    for (const widget of parsed.data.widgets) {
      for (const url of [widget.url, ...widget.previous.map((p) => p.url)]) {
        if (!this.onRegistryHost(url)) throw new RegistryError('marketplace.badUrl')
      }
    }
    this.cached = parsed.data
    this.fetchedAt = this.now()
    return parsed.data
  }

  /** True when a URL is https and on the registry's own host. */
  onRegistryHost(url: string): boolean {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' && parsed.hostname === this.host
    } catch { return false }
  }

  /**
   * Downloads a package named by the index and checks it is the one the index named.
   *
   * The size and the hash are verified *before* a single entry is read, because unpacking is
   * where an archive gets to be clever and verifying is where it does not.
   */
  async download(entry: { url: string; sha256: string; size: number }): Promise<Buffer> {
    if (!this.onRegistryHost(entry.url)) throw new RegistryError('marketplace.badUrl')
    if (entry.size > MAX_PACKAGE_BYTES) throw new RegistryError('marketplace.tooLarge')
    const body = await this.get(entry.url, Math.min(entry.size, MAX_PACKAGE_BYTES), PACKAGE_TIMEOUT_MS)
    return body
  }

  private async get(url: string, max: number, timeout = INDEX_TIMEOUT_MS): Promise<Buffer> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new RegistryError('marketplace.badUrl')
    if (await this.isPrivate(parsed.hostname)) throw new RegistryError('marketplace.badUrl')
    let res: Response
    try {
      res = await this.doFetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json, application/zip, */*', 'user-agent': USER_AGENT },
      })
    } catch { throw new RegistryError('marketplace.unreachable') }
    // `redirect: 'manual'`: a 3xx is a hop this module has not checked, and the registry has no
    // reason to redirect anything. Pages serves the files it was given, at the URL it was given.
    if (res.status >= 300 && res.status < 400) throw new RegistryError('marketplace.unreachable')
    if (!res.ok) throw new RegistryError('marketplace.unreachable')
    try {
      return await readCapped(res, max)
    } catch (err) {
      if (err instanceof RegistryError) throw err
      throw new RegistryError('marketplace.unreachable')
    }
  }
}

/** The entry for a version, current or older, or undefined when the index does not hold it. */
export function releaseOf(widget: IndexWidget, version?: string): { version: string; url: string; sha256: string; size: number } | undefined {
  if (!version || version === widget.version) {
    return { version: widget.version, url: widget.url, sha256: widget.sha256, size: widget.size }
  }
  return widget.previous.find((p) => p.version === version)
}
