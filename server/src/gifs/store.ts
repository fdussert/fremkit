import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { USER_AGENT } from '../version.js'
import { resolvesToPrivate } from '../net/private.js'
import { publicFetch, type PublicFetch } from '../net/pinned.js'

/** Largest GIF accepted. A reaction GIF is a few MB; this leaves room without filling a disk. */
export const MAX_GIF_BYTES = 15 * 1024 * 1024
/** How long a Giphy temp copy may outlive the paste it was made for. */
export const TEMP_TTL_MS = 10 * 60_000
/** One hop for the site's own canonicalisation, a couple more for a CDN. */
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 10_000
const USER_AGENT_HEADER = `Mozilla/5.0 (compatible; ${USER_AGENT})`
const GIF_ACCEPT = 'image/gif,image/*;q=0.8,*/*;q=0.5'
/** Same rule as the config schema's `giphyId`: it ends up in a URL path. */
const GIPHY_ID = /^[A-Za-z0-9]{1,64}$/

export type GifError = 'notGif' | 'tooLarge' | 'unreachable' | 'privateHost' | 'giphyLink'

/** A download that failed. The message names the reason only, never the URL. */
export class GifFetchError extends Error {
  constructor(public code: GifError) {
    super(`GIF download failed: ${code}`)
    this.name = 'GifFetchError'
  }
}

/**
 * Giphy's own hosts, its short links included. A link to one becomes a giphy item in the editor,
 * and Giphy's content is never cached: `ensureCached` refuses them on every hop. A trailing dot
 * names the same host, so it is ignored.
 */
export function isGiphyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'giphy.com' || host.endsWith('.giphy.com') || host === 'gph.is' || host.endsWith('.gph.is')
}

export function giphyFullUrl(giphyId: string): string {
  return `https://i.giphy.com/${giphyId}.gif`
}

export function giphyThumbUrl(giphyId: string): string {
  return `https://media.giphy.com/media/${giphyId}/200w.gif`
}

export interface GifStoreOptions {
  dataDir: string
  fetchImpl?: PublicFetch
  isPrivate?: (host: string) => Promise<boolean>
  now?: () => number
  /** Runs `fn` after `ms`; the default is an unref'd `setTimeout`, so it never holds the process open. */
  schedule?: (fn: () => void, ms: number) => void
}

function scheduleUnref(fn: () => void, ms: number): void {
  setTimeout(fn, ms).unref()
}

function hashOf(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function isGif(body: Buffer): boolean {
  const head = body.subarray(0, 6).toString('latin1')
  return head === 'GIF87a' || head === 'GIF89a'
}

/**
 * The GIF board's files on disk.
 *
 * Two folders under `<dataDir>/gifs`: `cache/` holds the GIFs the user added by URL, one file per
 * URL, kept until `prune` drops it; `tmp/` holds the one Giphy GIF last copied. Giphy's terms
 * forbid keeping its content, so a Giphy GIF never reaches `cache/`: it is downloaded for a copy,
 * deleted on the next one, and swept once it is older than `TEMP_TTL_MS`.
 */
export class GifStore {
  private readonly cacheDir: string
  private readonly tmpDir: string
  private readonly fetchImpl: PublicFetch
  private readonly isPrivate: (host: string) => Promise<boolean>
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => void
  private readonly inFlight = new Map<string, Promise<string>>()
  private lastTemp: string | null = null
  private tempQueue: Promise<unknown> = Promise.resolve()

  constructor(opts: GifStoreOptions) {
    this.cacheDir = join(opts.dataDir, 'gifs', 'cache')
    this.tmpDir = join(opts.dataDir, 'gifs', 'tmp')
    this.fetchImpl = opts.fetchImpl ?? publicFetch
    this.isPrivate = opts.isPrivate ?? ((host) => resolvesToPrivate(host))
    this.now = opts.now ?? Date.now
    this.schedule = opts.schedule ?? scheduleUnref
  }

  cachedPath(url: string): string {
    return join(this.cacheDir, `${hashOf(url)}.gif`)
  }

  async isCached(url: string): Promise<boolean> {
    try { return (await stat(this.cachedPath(url))).isFile() } catch { return false }
  }

  /** The cached file for `url`, downloading it first if needed. Concurrent calls share one download. */
  ensureCached(url: string): Promise<string> {
    const path = this.cachedPath(url)
    const pending = this.inFlight.get(path)
    if (pending) return pending
    const job = (async () => {
      if (await this.isCached(url)) return path
      const body = await this.download(url, { refuseGiphy: true })
      await this.writeAtomically(this.cacheDir, path, body)
      return path
    })().finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, job)
    return job
  }

  /**
   * Downloads a Giphy GIF to a fresh temp file, deleting the previous one, and returns its path.
   *
   * Calls run one after the other: two interleaved downloads could each take the other's file
   * for "the previous one" and delete a path that was just handed out.
   */
  tempCopy(giphyId: string): Promise<string> {
    if (!GIPHY_ID.test(giphyId)) return Promise.reject(new GifFetchError('unreachable'))
    const job = this.tempQueue.then(() => this.writeTemp(giphyId))
    this.tempQueue = job.catch(() => {})
    return job
  }

  private async writeTemp(giphyId: string): Promise<string> {
    const body = await this.download(giphyFullUrl(giphyId))
    const path = join(this.tmpDir, `${randomUUID()}.gif`)
    await this.writeAtomically(this.tmpDir, path, body)
    const previous = this.lastTemp
    this.lastTemp = path
    if (previous) await unlink(previous).catch(() => {})
    // The sweep only runs while a board is on screen (a provider polls only with subscribers), so
    // each temp file also carries its own deadline: it goes after TEMP_TTL_MS whatever is shown.
    this.schedule(() => {
      if (this.lastTemp === path) this.lastTemp = null
      unlink(path).catch(() => {})
    }, TEMP_TTL_MS)
    return path
  }

  /** Deletes temp files older than `TEMP_TTL_MS`, including any left by an earlier run. */
  async sweepTemp(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.tmpDir) } catch { return }
    const cutoff = this.now() - TEMP_TTL_MS
    for (const name of names) {
      const file = join(this.tmpDir, name)
      try {
        if ((await stat(file)).mtimeMs < cutoff) {
          await unlink(file)
          if (file === this.lastTemp) this.lastTemp = null
        }
      } catch { /* gone already */ }
    }
  }

  /** Deletes every cached file that belongs to none of `keepUrls`. */
  async prune(keepUrls: Iterable<string>): Promise<void> {
    const keep = new Set<string>()
    for (const url of keepUrls) keep.add(hashOf(url))
    let names: string[]
    try { names = await readdir(this.cacheDir) } catch { return }
    for (const name of names) {
      // `<hash>.gif`, or `<hash>.gif.part` while a download is being written.
      if (keep.has(name.slice(0, 64))) continue
      await unlink(join(this.cacheDir, name)).catch(() => {})
    }
  }

  private async writeAtomically(dir: string, target: string, body: Buffer): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const part = `${target}.part`
    try {
      await writeFile(part, body, { mode: 0o600 })
      await rename(part, target)
    } catch (err) {
      await unlink(part).catch(() => {})
      throw err
    }
  }

  /** The checked bytes of a GIF, or a `GifFetchError`. Nothing is written until they pass. */
  private async download(url: string, rules: { refuseGiphy?: boolean } = {}): Promise<Buffer> {
    const res = await this.request(url, rules)
    try {
      if (!res.ok) throw new GifFetchError('unreachable')
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_GIF_BYTES) throw new GifFetchError('tooLarge')
      const body = await readCapped(res, MAX_GIF_BYTES)
      if (!isGif(body)) throw new GifFetchError('notGif')
      return body
    } finally {
      void res.body?.cancel().catch(() => {})
    }
  }

  /**
   * One GET, following at most `MAX_REDIRECTS` hops (https only after the first), each host checked for a
   * private address before it is asked (the URL given included). Mirrors the favicon store.
   * `refuseGiphy` also refuses Giphy's hosts on every hop: the cache never holds Giphy content.
   */
  private async request(url: string, rules: { refuseGiphy?: boolean }): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL
      try { parsed = new URL(current) } catch { throw new GifFetchError('unreachable') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new GifFetchError('unreachable')
      // A redirect never downgrades to http: the URL given had to be https when it was added.
      if (hop > 0 && parsed.protocol !== 'https:') throw new GifFetchError('unreachable')
      // A URL with credentials is never fetched: they would travel to whoever answers.
      if (parsed.username || parsed.password) throw new GifFetchError('unreachable')
      // A cache download that starts at, or is redirected to, Giphy would keep Giphy's content.
      if (rules.refuseGiphy && isGiphyHost(parsed.hostname)) throw new GifFetchError('giphyLink')
      if (await this.isPrivate(parsed.hostname)) throw new GifFetchError('privateHost')
      let res: Response
      try {
        res = await this.fetchImpl(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'user-agent': USER_AGENT_HEADER, accept: GIF_ACCEPT },
        })
      } catch {
        throw new GifFetchError('unreachable')
      }
      if (![301, 302, 303, 307, 308].includes(res.status)) return res
      const location = res.headers.get('location')
      void res.body?.cancel().catch(() => {})
      if (!location) throw new GifFetchError('unreachable')
      try { current = new URL(location, current).toString() } catch { throw new GifFetchError('unreachable') }
    }
    throw new GifFetchError('unreachable')
  }
}

/** Reads a body, refusing it as `tooLarge` past `max` bytes without reading the rest. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>
    try { step = await reader.read() } catch { throw new GifFetchError('unreachable') }
    if (step.done) break
    total += step.value.byteLength
    if (total > max) {
      void reader.cancel().catch(() => {})
      throw new GifFetchError('tooLarge')
    }
    chunks.push(Buffer.from(step.value))
  }
  return Buffer.concat(chunks)
}
