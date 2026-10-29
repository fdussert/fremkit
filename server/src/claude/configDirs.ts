import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * The Claude Code configuration folders this Mac's sessions run from.
 *
 * Claude Code keeps its OAuth token in the keychain under `Claude Code-credentials`, unless it runs
 * with `CLAUDE_CONFIG_DIR` set (a terminal app with profiles, Orca for one, does exactly that):
 * then the item is `Claude Code-credentials-<first 8 hex of sha256(dir)>`, and its transcripts live
 * in `<dir>/projects`. The default item is then refreshed by nobody and expires, which made the
 * account usage answer 401 although Claude Code itself was signed in.
 *
 * Nothing on the Mac lists these folders, but every hook and status-line event carries the
 * session's `transcript_path`, which sits under `<dir>/projects/`. So the folders are learnt from
 * the events, kept across restarts, and capped: the hook endpoint takes whatever its caller sends.
 */
export const MAX_CONFIG_DIRS = 8
export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials'

const persistedSchema = z.object({ dirs: z.array(z.string()).max(MAX_CONFIG_DIRS) })

/**
 * The configuration folder a transcript lives under, or null when the path does not look like one.
 * The last `/projects/` wins: a project folder's name never holds a slash, a parent folder may well
 * be called `projects`.
 */
export function configDirOf(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) return null
  if (transcriptPath.split('/').some((part) => part === '..' || part === '.')) return null
  const at = transcriptPath.lastIndexOf('/projects/')
  if (at <= 0) return null
  return transcriptPath.slice(0, at)
}

/** The keychain item Claude Code writes its token to when it runs from `dir`. */
export function keychainServiceFor(dir: string): string {
  return `${DEFAULT_KEYCHAIN_SERVICE}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
}

export class ClaudeConfigDirs {
  /** Most recently seen first. */
  private dirs: string[] = []
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: { filePath?: string } = {}) {}

  async load(): Promise<void> {
    if (!this.opts.filePath) return
    try {
      const parsed = persistedSchema.safeParse(JSON.parse(await readFile(this.opts.filePath, 'utf8')))
      if (parsed.success) this.dirs = parsed.data.dirs.filter((d) => configDirOf(`${d}/projects/x/x.jsonl`) === d)
    } catch { /* first run or unreadable */ }
  }

  /** Records the folder a transcript lives under. Writes only when the list actually changes. */
  note(transcriptPath: unknown): void {
    const dir = configDirOf(transcriptPath)
    if (!dir || this.dirs[0] === dir) return
    this.dirs = [dir, ...this.dirs.filter((d) => d !== dir)].slice(0, MAX_CONFIG_DIRS)
    this.persist()
  }

  list(): string[] {
    return [...this.dirs]
  }

  private persist(): void {
    const filePath = this.opts.filePath
    if (!filePath) return
    const data = JSON.stringify({ dirs: this.dirs })
    this.queue = this.queue.then(async () => {
      const tmp = `${filePath}.${process.pid}.tmp`
      await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, filePath)
    }).catch(() => { /* best effort: the next event writes again */ })
  }

  /** Resolves once every pending write is done. Tests and shutdown. */
  flush(): Promise<void> {
    return this.queue
  }
}
