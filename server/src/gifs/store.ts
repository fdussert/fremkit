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

export type GifError = 'notGif' | 'tooLarge' | 'unreachable' | 'privateHost'

/** A download that failed. The message names the reason only, never the URL. */
export class GifFetchError extends Error {
  constructor(public code: GifError) {
    super(`GIF download failed: ${code}`)
    this.name = 'GifFetchError'
  }
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
  private readonly inFlight = new Map<string, Promise<string>>()
  private lastTemp: string | null = null

  constructor(opts: GifStoreOptions) {
    this.cacheDir = join(opts.dataDir, 'gifs', 'cache')
    this.tmpDir = join(opts.dataDir, 'gifs', 'tmp')
    this.fetchImpl = opts.fetchImpl ?? publicFetch
    this.isPrivate = opts.isPrivate ?? ((host) => resolvesToPrivate(host))
    this.now = opts.now ?? Date.now
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
      const body = await this.download(url)
      await this.writeAtomically(this.cacheDir, path, body)
      return path
    })().finally(() => this.inFlight.delete(path))
    this.inFlight.set(path, job)
    return job
  }

  /** Downloads a Giphy GIF to a fresh temp file, deleting the previous one, and returns its path. */
  async tempCopy(giphyId: string): Promise<string> {
    const body = await this.download(giphyFullUrl(giphyId))
    const path = join(this.tmpDir, `${randomUUID()}.gif`)
    await this.writeAtomically(this.tmpDir, path, body)
    const previous = this.lastTemp
    this.lastTemp = path
    if (previous) await unlink(previous).catch(() => {})
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
  private async download(url: string): Promise<Buffer> {
    const res = await this.request(url)
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
   * One GET, following at most `MAX_REDIRECTS` hops over http/https only, each host checked for a
   * private address before it is asked (the URL given included). Mirrors the favicon store.
   */
  private async request(url: string): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL
      try { parsed = new URL(current) } catch { throw new GifFetchError('unreachable') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new GifFetchError('unreachable')
      // A URL with credentials is never fetched: they would travel to whoever answers.
      if (parsed.username || parsed.password) throw new GifFetchError('unreachable')
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
