/**
 * A rolling history of the dashboard as it was saved, in `<dataDir>/history/`.
 *
 * Undo in the admin covers one editing session and `fremkit.json.bak` one save. This keeps the
 * versions a person can still want back a week later: a page deleted yesterday, an import that
 * replaced everything, a format upgrade that went wrong.
 *
 * - One snapshot file per entry (`<id>.json`, the config exactly as saved) and one `index.json`
 *   listing the entries with their time, their kind and what changed (`history-diff.ts`). The
 *   index is a cache of the files: when it is missing or unreadable it is rebuilt from them.
 * - Saves are coalesced: an ordinary save less than `coalesceMs` after the start of the entry on
 *   top replaces that entry's snapshot instead of adding one, so continuous editing leaves one
 *   version per window — the last state of the burst.
 * - Nothing coalesces into, or over, an entry of another kind. A restore, an import or a format
 *   upgrade therefore always leaves the version before it in the list, frozen. And when the list
 *   does not end with the state about to be replaced (a fresh install, a first save after this
 *   feature arrived) that state is recorded first, as an `earlier` entry.
 * - Capped by count and by age, whichever bites first. The newest entry is never dropped.
 *
 * Files are 0600 in a 0700 folder like the rest of the data folder. They hold what `fremkit.json`
 * holds, which is no secret: connection secrets live in the keychain (or `secrets.json`) and the
 * config only ever carries a connection's non-secret fields. They are not part of a backup: a
 * backup is a file meant to travel, and the history keeps what the user removed on purpose (a
 * deleted connection's host, a page they did not want) — that stays on this Mac. README, *Backup*.
 *
 * Every failure here is the caller's to log and ignore: the history must never stop a save.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Config } from './schema.js'
import { migrateConfig } from './migrate.js'
import { normalizeInstances } from './normalize.js'
import { summarizeChange, type ChangeSummary } from './history-diff.js'

/**
 * - `save`: an ordinary edit (the only kind that coalesces).
 * - `earlier`: the state found in place when the history did not hold it yet.
 * - `before-migration`: the file as an older release wrote it, before this one upgraded it.
 * - `restore` / `import` / `revert`: what a backup restore, a setup import or a restore from this
 *   history put in place.
 */
export type HistoryKind = 'save' | 'earlier' | 'before-migration' | 'restore' | 'import' | 'revert'

export interface HistoryEntry {
  id: string
  /** When the entry was opened, in ms: the first save of a coalesced burst. */
  at: number
  /** When its snapshot was last written: the last save of the burst. */
  savedAt: number
  kind: HistoryKind
  summary: ChangeSummary
  /** For a `revert`: the `savedAt` of the version that was put back. */
  revertedTo?: number
}

export interface HistoryOptions {
  now?: () => number
  /** An ordinary save this soon after the top entry opened replaces it. */
  coalesceMs?: number
  maxEntries?: number
  maxAgeMs?: number
}

export const HISTORY_COALESCE_MS = 2 * 60_000
export const HISTORY_MAX_ENTRIES = 100
export const HISTORY_MAX_AGE_MS = 30 * 24 * 3600_000

/** `<13-digit ms>-<6 hex>`: what an id must look like before it is ever joined to a path. */
export const HISTORY_ID_RE = /^\d{13}-[0-9a-f]{6}$/

const INDEX = 'index.json'
const FILE_MODE = 0o600

/** JSON with sorted keys, so two equal configs compare equal whatever order their keys came in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return v
  })
}

/** A snapshot file's content as a current config, whatever version wrote it. */
export function configOf(raw: unknown): Config {
  return normalizeInstances(migrateConfig(raw))
}

export class ConfigHistory {
  private readonly now: () => number
  private readonly coalesceMs: number
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  /** Oldest first. Null until the first call reads or rebuilds it. */
  private entries: HistoryEntry[] | null = null
  /** `stable()` of the newest entry's config, to tell a no-op save and a missing baseline. */
  private topStable: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string, opts: HistoryOptions = {}) {
    this.now = opts.now ?? Date.now
    this.coalesceMs = opts.coalesceMs ?? HISTORY_COALESCE_MS
    this.maxEntries = Math.max(1, opts.maxEntries ?? HISTORY_MAX_ENTRIES)
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS
  }

  /** One operation at a time: two writes of the index racing would lose an entry. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Newest first. */
  list(): Promise<HistoryEntry[]> {
    return this.serial(async () => [...(await this.load())].reverse())
  }

  /** One version as a current config, or null when there is no such entry. */
  read(id: string): Promise<{ entry: HistoryEntry; config: Config } | null> {
    return this.serial(async () => {
      if (!HISTORY_ID_RE.test(id)) return null
      const entry = (await this.load()).find((e) => e.id === id)
      if (!entry) return null
      return { entry, config: configOf(await this.readRaw(id)) }
    })
  }

  /**
   * Records the change from `before` to `after`. `before` is what the file held until now: when
   * the newest entry is not that, it goes in first as `earlier`, so the version being replaced
   * can always be found again. A save that changes nothing records nothing.
   */
  recordChange(before: Config, after: Config, kind: HistoryKind, extra: { revertedTo?: number } = {}): Promise<void> {
    return this.serial(async () => {
      await this.load()
      const beforeStable = stable(before)
      if (this.topStable !== beforeStable) await this.add(before, beforeStable, 'earlier')
      const afterStable = stable(after)
      // Nothing changed, and nothing worth marking: a restore of what is already there is still
      // worth a line, since the user asked for it, but a save that replays the same config is not.
      if (afterStable === this.topStable && kind === 'save') return
      await this.add(after, afterStable, kind, extra)
    })
  }

  /**
   * Records a file as an older release wrote it, before a migration rewrites it. Kept raw: it is
   * read back through the migrations like any snapshot, and a summary is attempted the same way.
   */
  recordRaw(raw: unknown, kind: HistoryKind): Promise<void> {
    return this.serial(async () => {
      await this.load()
      let config: Config | null = null
      try { config = configOf(raw) } catch { /* recorded anyway; the summary says nothing */ }
      await this.add(raw, config ? stable(config) : null, kind, {}, config)
    })
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // A folder an older process made, or `mkdir` under a wider umask: the mode passed above only
    // applies to a folder it creates.
    await chmod(this.dir, 0o700)
  }

  private async write(name: string, body: string): Promise<void> {
    const path = join(this.dir, name)
    const tmp = `${path}.tmp`
    await writeFile(tmp, body, { encoding: 'utf8', mode: FILE_MODE })
    await rename(tmp, path)
  }

  private async readRaw(id: string): Promise<unknown> {
    return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as unknown
  }

  private async readConfig(id: string): Promise<Config | null> {
    try { return configOf(await this.readRaw(id)) } catch { return null }
  }

  private async saveIndex(): Promise<void> {
    await this.write(INDEX, JSON.stringify({ version: 1, entries: this.entries }, null, 2) + '\n')
  }

  /** Reads the index, or rebuilds it from the snapshot files when it is missing or unreadable. */
  private async load(): Promise<HistoryEntry[]> {
    if (this.entries) return this.entries
    let names: string[] = []
    try { names = await readdir(this.dir) } catch { /* no history yet */ }
    const ids = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => HISTORY_ID_RE.test(id)))

    let entries: HistoryEntry[] | null = null
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, INDEX), 'utf8')) as { entries?: unknown }
      if (Array.isArray(parsed.entries)) {
        entries = (parsed.entries as HistoryEntry[])
          .filter((e) => e && typeof e.id === 'string' && HISTORY_ID_RE.test(e.id) && ids.has(e.id)
            && typeof e.at === 'number' && typeof e.savedAt === 'number' && typeof e.kind === 'string' && e.summary)
      }
    } catch { /* rebuilt below */ }

    if (!entries) {
      entries = []
      let previous: Config | null = null
      for (const id of [...ids].sort()) {
        const config = await this.readConfig(id)
        const at = Number(id.slice(0, 13))
        entries.push({ id, at, savedAt: at, kind: 'save', summary: config ? summarizeChange(previous, config) : summarizeChange(null, previous ?? ({} as Config)) })
        if (config) previous = config
      }
    }
    entries.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    this.entries = entries
    const top = entries.at(-1)
    const topConfig = top ? await this.readConfig(top.id) : null
    this.topStable = topConfig ? stable(topConfig) : null
    return entries
  }

  /**
   * Adds `content` on top, or replaces the top entry when this is an ordinary save inside the
   * coalescing window of an ordinary save. `config` is `content` read as a current config, when
   * that is not `content` itself (a raw pre-migration file).
   */
  private async add(content: unknown, contentStable: string | null, kind: HistoryKind,
    extra: { revertedTo?: number } = {}, config: Config | null = content as Config): Promise<void> {
    const entries = this.entries!
    await this.ensureDir()
    const now = this.now()
    const top = entries.at(-1)
    const coalesce = kind === 'save' && top?.kind === 'save' && now - top.at < this.coalesceMs
    const below = coalesce ? entries.at(-2) : top
    const previous = below ? await this.readConfig(below.id) : null
    const summary = config ? summarizeChange(previous, config) : summarizeChange(null, previous ?? ({} as Config))
    const body = JSON.stringify(content, null, 2) + '\n'

    if (coalesce && top && previous && contentStable === stable(previous)) {
      // The burst came back to where it started (edited, then undone): the entry says nothing.
      entries.pop()
      await rm(join(this.dir, `${top.id}.json`), { force: true })
    } else if (coalesce && top) {
      await this.write(`${top.id}.json`, body)
      top.savedAt = now
      top.summary = summary
    } else {
      // Strictly increasing ids, even for two entries within one millisecond.
      const at = Math.max(now, (top?.at ?? 0) + 1)
      const id = `${String(at).padStart(13, '0')}-${randomBytes(3).toString('hex')}`
      await this.write(`${id}.json`, body)
      entries.push({ id, at, savedAt: now, kind, summary, ...(extra.revertedTo !== undefined ? { revertedTo: extra.revertedTo } : {}) })
    }
    this.topStable = contentStable
    await this.prune(now)
    await this.saveIndex()
  }

  /** Drops what is past either cap, oldest first, never the newest entry. */
  private async prune(now: number): Promise<void> {
    const entries = this.entries!
    const dropped: HistoryEntry[] = []
    while (entries.length > 1 && (entries.length > this.maxEntries || now - entries[0].savedAt > this.maxAgeMs)) {
      dropped.push(entries.shift()!)
    }
    for (const e of dropped) await rm(join(this.dir, `${e.id}.json`), { force: true })
  }
}
