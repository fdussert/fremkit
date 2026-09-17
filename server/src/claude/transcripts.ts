import { readdir, stat, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

export interface TodayTokens { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; sessions: number; hourly: number[] }

const EMPTY: TodayTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: 0, hourly: new Array(24).fill(0) }

function startOfDay(d: Date): number { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }

/** Per-file usage, without the `sessions` counter (one file is at most one session). */
type FileTotals = Omit<TodayTokens, 'sessions'>

interface CacheEntry {
  mtimeMs: number
  size: number
  /** Byte offset of the first byte not yet parsed (never inside a partial line). */
  offset: number
  totals: FileTotals
  ids: Set<string>
  day: number
  counted: boolean
}

interface FoundFile { path: string; mtimeMs: number; size: number }

export interface TranscriptScannerOptions {
  /** Injectable for tests: lets a spy count how many files are actually opened. */
  openFile?: (path: string) => Promise<FileHandle>
}

export interface TranscriptScanner {
  scanToday(now?: Date): Promise<TodayTokens>
}

/**
 * Incremental scanner over the Claude Code transcripts tree.
 *
 * Transcripts are append-only JSONL files and the tree can weigh tens of
 * megabytes, so a full re-read every minute is wasteful. The scanner keeps a
 * per-file cache keyed by `(mtimeMs, size)`: unchanged files are reused as is,
 * grown files are read from their last parsed offset only, and shrunk files or
 * files from a previous day are dropped and read again in full.
 */
export function createTranscriptScanner(rootDir: string, opts: TranscriptScannerOptions = {}): TranscriptScanner {
  const openFile = opts.openFile ?? ((p: string) => open(p, 'r'))
  const cache = new Map<string, CacheEntry>()
  // Union of every cached entry's ids: assistant messages are deduplicated
  // across files (a resumed session replays earlier messages), and ingesting an
  // id only once keeps the cached per-file totals disjoint so they can be summed.
  let seenIds = new Set<string>()

  function rebuildSeenIds(): void {
    seenIds = new Set<string>()
    for (const e of cache.values()) for (const id of e.ids) seenIds.add(id)
  }

  async function readRange(path: string, from: number, length: number): Promise<Buffer> {
    const fh = await openFile(path)
    try {
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await fh.read(buf, 0, length, from)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }

  /** Parses the complete lines of `chunk` into `entry`; returns the bytes consumed. */
  function ingest(entry: CacheEntry, chunk: Buffer, dayStart: number, filePath: string): number {
    const end = chunk.lastIndexOf(0x0a) + 1
    if (end === 0) return 0
    // Cutting on a newline is always a valid UTF-8 boundary, so a multi-byte
    // character can never be split by the incremental read.
    for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      if (j?.type !== 'assistant' || !j.message?.usage) continue
      const ts = Date.parse(j.timestamp ?? '')
      if (!Number.isFinite(ts) || ts < dayStart) continue
      // Ids are deduplicated globally across files (seenIds), so the fallback for an
      // entry with neither field must stay unique per file or two files' entries
      // that happen to land on the same size/index would collide and be dropped.
      const id = j.message.id ?? j.requestId ?? `${filePath}:${entry.ids.size}:${line.length}`
      if (seenIds.has(id)) continue
      seenIds.add(id)
      entry.ids.add(id)
      const u = j.message.usage
      entry.totals.input += u.input_tokens ?? 0
      entry.totals.output += u.output_tokens ?? 0
      entry.totals.cacheRead += u.cache_read_input_tokens ?? 0
      entry.totals.cacheWrite += u.cache_creation_input_tokens ?? 0
      entry.totals.messages += 1
      entry.counted = true
      const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      const h = new Date(ts).getHours()
      entry.totals.hourly[h] += total
    }
    return end
  }

  async function scanToday(now: Date = new Date()): Promise<TodayTokens> {
    const dayStart = startOfDay(now)
    const files: FoundFile[] = []
    await listJsonl(rootDir, files)
    const total = { ...EMPTY, hourly: new Array(24).fill(0) }
    const live = new Set<string>()
    let dropped = false

    for (const file of files) {
      if (file.mtimeMs < dayStart) continue
      live.add(file.path)
      let entry = cache.get(file.path)
      if (entry && (entry.day !== dayStart || file.size < entry.size)) {
        cache.delete(file.path)
        entry = undefined
        dropped = true
      }
      if (dropped) { rebuildSeenIds(); dropped = false }
      if (!entry) {
        entry = { mtimeMs: -1, size: 0, offset: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, hourly: new Array(24).fill(0) }, ids: new Set(), day: dayStart, counted: false }
        cache.set(file.path, entry)
      }
      if (entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) {
        const length = file.size - entry.offset
        if (length > 0) {
          try {
            const chunk = await readRange(file.path, entry.offset, length)
            entry.offset += ingest(entry, chunk, dayStart, file.path)
          } catch { continue }
        }
        entry.mtimeMs = file.mtimeMs
        entry.size = file.size
      }
      total.input += entry.totals.input
      total.output += entry.totals.output
      total.cacheRead += entry.totals.cacheRead
      total.cacheWrite += entry.totals.cacheWrite
      total.messages += entry.totals.messages
      for (let i = 0; i < 24; i++) total.hourly[i] += entry.totals.hourly[i]
      if (entry.counted) total.sessions += 1
    }

    let pruned = false
    for (const path of [...cache.keys()]) if (!live.has(path)) { cache.delete(path); pruned = true }
    if (pruned) rebuildSeenIds()
    return total
  }

  return { scanToday }
}

/**
 * Lists `.jsonl` transcripts under `dir`. Recursion follows real directories
 * only (`dirent.isDirectory()`), never symlinks, so a symlink loop cannot hang
 * the scan.
 */
async function listJsonl(dir: string, out: FoundFile[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const dirent of entries) {
    const p = join(dir, dirent.name)
    if (dirent.isDirectory()) { await listJsonl(p, out); continue }
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    try { const s = await stat(p); out.push({ path: p, mtimeMs: s.mtimeMs, size: s.size }) } catch { /* vanished */ }
  }
}

/** Sum assistant token usage for today across Claude Code transcripts, deduplicated by message id. */
export async function scanTranscriptsToday(rootDir: string, now: Date = new Date()): Promise<TodayTokens> {
  return createTranscriptScanner(rootDir).scanToday(now)
}
