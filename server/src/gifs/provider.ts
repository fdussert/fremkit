import { z } from 'zod'
import type { Config, GifBoard, GifItem } from '../config/schema.js'
import { tr, type MessageKey } from '../i18n.js'
import { isTrusted, type CommandContext, type Provider } from '../providers/types.js'
import { writeGifToPasteboard } from './pasteboard.js'
import { GifFetchError, giphyFullUrl, giphyThumbUrl, type GifStore } from './store.js'

export interface GifSnapshotItem { id: string; kind: 'giphy' | 'link'; label?: string; src: string; thumb: string }
export interface GifSnapshot { groups: { id: string; name: string; items: GifSnapshotItem[] }[] }

const POLL_MS = 5000
/** Copies queued at once beyond which a new one is refused: two touches in quick succession pass. */
const MAX_PENDING_COPIES = 2
/** How often the cache is pruned and old temp copies swept; also how long a failed warm-up waits. */
const MAINTENANCE_MS = 60_000

// Unknown keys pass: the host stamps the widget's instance id onto every command.
const CopyPayloadSchema = z.object({ id: z.string().min(1).max(24) })

function snapshotItem(item: GifItem): GifSnapshotItem {
  const label = item.label !== undefined ? { label: item.label } : {}
  if (item.kind === 'giphy') {
    return { id: item.id, kind: 'giphy', ...label, src: giphyFullUrl(item.giphyId), thumb: giphyThumbUrl(item.giphyId) }
  }
  return { id: item.id, kind: 'link', ...label, src: item.url, thumb: item.url }
}

/** What the widget draws: the board as saved, each item with the URLs its tile shows. */
export function gifSnapshot(board: GifBoard | undefined): GifSnapshot {
  return {
    groups: (board?.groups ?? []).map((g) => ({ id: g.id, name: g.name, items: g.items.map(snapshotItem) })),
  }
}

export function linkUrls(board: GifBoard | undefined): string[] {
  const urls: string[] = []
  for (const g of board?.groups ?? []) for (const item of g.items) if (item.kind === 'link') urls.push(item.url)
  return urls
}

function findItem(board: GifBoard | undefined, id: string): GifItem | undefined {
  for (const g of board?.groups ?? []) {
    const item = g.items.find((i) => i.id === id)
    if (item) return item
  }
  return undefined
}

export interface GifBoardProviderOptions {
  config: () => Config
  gifs: GifStore
  /** Puts the file at `path` on the pasteboard; `writeGifToPasteboard` unless a test says otherwise. */
  paste?: (path: string) => Promise<void>
  now?: () => number
}

/**
 * The `gif-board` channel: the saved board as a snapshot, and one command, `copy`, which puts a
 * GIF on this Mac's clipboard so the next ⌘V in Teams or Slack sends it.
 *
 * Copying writes to this Mac's pasteboard, so it answers this Mac and paired devices only
 * (`isTrusted`), as the clipboard widget's `copy` does: a tablet beside the Mac is a second Edge.
 * The hub has already held a device to a screen that shows a GIF board, and the payload names an
 * item of the collection, never an address.
 */
export function createGifBoardProvider(opts: GifBoardProviderOptions): Provider<GifSnapshot> {
  const { gifs } = opts
  const paste = opts.paste ?? ((path: string) => writeGifToPasteboard(path))
  const now = opts.now ?? Date.now
  let lastMaintenance = -Infinity
  const failedWarm = new Map<string, number>()
  // One copy at a time, paste included: the next Giphy copy deletes the previous temp file.
  let copyQueue: Promise<unknown> = Promise.resolve()
  // Copies waiting or running. A touch is one copy; a client retrying in a loop (a tablet's
  // included) would otherwise queue a Giphy download per message.
  let pending = 0

  /** Downloads the links nobody has fetched yet, so a touch pastes at once. A failure waits a minute. */
  async function warm(urls: string[]): Promise<void> {
    for (const url of urls) {
      const failedAt = failedWarm.get(url)
      if (failedAt !== undefined && now() - failedAt < MAINTENANCE_MS) continue
      if (await gifs.isCached(url)) continue
      try {
        await gifs.ensureCached(url)
        failedWarm.delete(url)
      } catch {
        // The touch reports it, with the reason.
        failedWarm.set(url, now())
      }
    }
  }

  async function maintain(urls: string[]): Promise<void> {
    await gifs.sweepTemp().catch(() => {})
    await gifs.prune(urls).catch(() => {})
    for (const url of failedWarm.keys()) if (!urls.includes(url)) failedWarm.delete(url)
  }

  async function copy(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const item = findItem(opts.config().gifs, id)
    if (!item) return { ok: false, error: tr(undefined, 'gifs.unknownItem') }
    try {
      const path = item.kind === 'giphy' ? await gifs.tempCopy(item.giphyId) : await gifs.ensureCached(item.url)
      await paste(path)
      return { ok: true }
    } catch (err) {
      if (err instanceof GifFetchError) return { ok: false, error: tr(undefined, `gifs.${err.code}` as MessageKey) }
      // osascript's stderr (or a file system error naming a path) stays in the log; the widget
      // gets a fixed sentence.
      console.warn(`gif-board: copy failed (${err instanceof Error ? err.message : String(err)})`)
      return { ok: false, error: tr(undefined, 'gifs.pasteFailed') }
    }
  }

  return {
    channel: 'gif-board',
    intervalMs: POLL_MS,
    async poll() {
      const board = opts.config().gifs
      const urls = linkUrls(board)
      void warm(urls).catch(() => {})
      if (now() - lastMaintenance >= MAINTENANCE_MS) {
        lastMaintenance = now()
        void maintain(urls)
      }
      return gifSnapshot(board)
    },
    commands: {
      copy: async (payload: unknown, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const parsed = CopyPayloadSchema.safeParse(payload)
        if (!parsed.success) return { ok: false, error: tr(undefined, 'provider.invalidPayload') }
        if (pending >= MAX_PENDING_COPIES) return { ok: false, error: tr(undefined, 'gifs.busy') }
        pending++
        const job = copyQueue.then(() => copy(parsed.data.id)).finally(() => { pending-- })
        copyQueue = job.catch(() => {})
        return job
      },
    },
  }
}
