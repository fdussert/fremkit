import { chmod, copyFile as fsCopyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { querySqlite } from '../codex/sqlite.js'
import { resolveCodexBinary } from '../codex/adapter.js'
import { targetPlatform } from '../platform/index.js'
import { CODEX_STATE_DB, createSessionReader } from '../codex/observations.js'
import { distroRoot, isDistroName, knownHome, readWithTimeout, validHome, type DistroHomeDeps } from './distros.js'

type SessionReader = ReturnType<typeof createSessionReader>

/** Runs the reader's SELECT on the copied database; the tests look at the copy through it. */
export type CopyQuery = (sql: string, path: string) => Promise<unknown>

export interface WslSessionReaderOptions {
  /** `\\wsl.localhost\<distro>\home\<you>`, from `distroRoot`. */
  root: string
  /** The same home folder as the distribution sees it, from `distroHome`. */
  home: string
  /** Fremkit's data folder: the copy is made under `<dataDir>/tmp`. */
  dataDir: string
  platform?: NodeJS.Platform
  query?: CopyQuery
  /** Tests: the file copy, to hold one pending. */
  copyFile?: (src: string, dest: string) => Promise<void>
}

/** Where the copies are made, under the data folder. */
const COPY_PREFIX = 'wsl-codex-'

/**
 * Removes the copy folders a server stopped mid-read left behind. Once, at start, best effort:
 * nothing else writes `wsl-codex-*` folders.
 */
export async function sweepWslCopies(dataDir: string): Promise<void> {
  const parent = join(dataDir, 'tmp')
  let names: string[]
  try { names = await readdir(parent) } catch { return }
  await Promise.all(names.filter((name) => name.startsWith(COPY_PREFIX))
    .map((name) => rm(join(parent, name), { recursive: true, force: true }).catch(() => {})))
}

/**
 * The rollout file a Codex inside WSL recorded (`/home/<you>/.codex/sessions/…`), as Windows
 * reaches it. Only a path under that Codex home, with no `..` segment and no backslash, maps;
 * anything else is skipped, and the reader still checks the result is inside its home.
 */
export function wslRolloutPath(stored: string, home: string, root: string): string | null {
  const prefix = `${home.replace(/\/+$/, '')}/.codex/`
  if (!stored.startsWith(prefix)) return null
  const rest = stored.slice(prefix.length)
  if (!rest || rest.includes('\\') || /[\u0000-\u001f]/.test(rest)) return null
  const parts = rest.split('/')
  if (parts.some((part) => part === '..' || part === '')) return null
  return join(root, '.codex', ...parts)
}

/** One reader's copy still in flight: a new read waits for none and refuses while it is pending. */
interface CopyState { copying: Promise<void> | null }

/**
 * Copies `state_5.sqlite` and its `-wal`/`-shm` out of the distribution into a private folder of
 * the data folder, then runs the query on the copy. Reading SQLite in place through
 * `\\wsl.localhost` would take its locks across the 9P file share, which neither side expects; a
 * copy is a plain read. A missing `-wal` or `-shm` is a checkpointed database, not an error.
 *
 * The wait is bounded by `readWithTimeout`, the copy itself is not: a wedged share can keep a
 * `copyFile` (and an I/O thread) for a long time. So the reader refuses another read while the
 * copy is pending, settled or not, and the folder is removed only once the copy has settled, when
 * nothing holds its files open any more.
 */
async function queryCopy(
  sql: string, codexHome: string, options: WslSessionReaderOptions, state: CopyState,
): Promise<unknown> {
  if (state.copying) throw Error('offline')
  const parent = join(options.dataDir, 'tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = await mkdtemp(join(parent, COPY_PREFIX))
  const copy = join(dir, CODEX_STATE_DB)
  const copyFile = options.copyFile ?? ((src: string, dest: string) => fsCopyFile(src, dest))
  const copied = (async () => {
    await chmod(dir, 0o700)
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await copyFile(join(codexHome, CODEX_STATE_DB + suffix), copy + suffix)
        await chmod(copy + suffix, 0o600)
      } catch (error) {
        if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw Error('offline')
      }
    }
  })()
  // Registered first, so it has run by the time the wait below returns with the copy's outcome.
  let done = false
  const settled = copied.then(() => { done = true }, () => { done = true })
  state.copying = settled
  const cleanUp = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    if (state.copying === settled) state.copying = null
  }
  try {
    await readWithTimeout(() => copied)
    return await (options.query
      ? options.query(sql, copy)
      : querySqlite(sql, { path: copy, platform: options.platform, timeoutMs: 2500, maxBuffer: 512 * 1024 }))
  } finally {
    // The query has ended here. The copy has too, unless the wait timed out: then the folder goes
    // once the copy settles, never while it may still hold a file open.
    if (done) await cleanUp()
    else void settled.then(cleanUp)
  }
}

/**
 * Task 14's session reader over the Codex home of a WSL distribution: the database read from a
 * copy, the rollouts through `\\wsl.localhost`. A whole read is bounded by `readWithTimeout`, and
 * one still running from an earlier poll, or a copy still pending, is not started again: the poll
 * reports offline instead.
 */
export function createWslSessionReader(options: WslSessionReaderOptions): SessionReader {
  const home = validHome(options.home)
  if (home === null) throw new Error('invalid-home')
  const codexHome = join(options.root, '.codex')
  const state: CopyState = { copying: null }
  const read = createSessionReader({
    codexHome,
    platform: options.platform,
    query: (sql) => queryCopy(sql, codexHome, options, state),
    rolloutPath: (stored) => wslRolloutPath(stored, home, options.root),
  })
  let running: Promise<unknown> | null = null
  return async (ids, now) => {
    if (running || state.copying) throw Error('offline')
    const job = read(ids, now)
    running = job
    void job.catch(() => {}).finally(() => { if (running === job) running = null })
    return readWithTimeout(() => job)
  }
}

export interface CodexWslSessionsOptions extends Omit<DistroHomeDeps, 'ticked'> {
  /** The ticked distributions, read at call time. */
  ticked: () => readonly string[]
  /** The distribution Codex runs in now, or null when it runs on Windows. */
  distro: () => string | null
  /** The reader used when Codex runs on Windows. */
  windows: SessionReader
  dataDir: string
}

/**
 * The `codex-live` reader on Windows: the Windows Codex home, or the home of the distribution the
 * Codex client runs in. The distribution's home is asked only for a ticked name (`knownHome`).
 */
export function createCodexSessionsReader(options: CodexWslSessionsOptions): SessionReader {
  const readers = new Map<string, SessionReader>()
  return async (ids, now) => {
    const distro = options.distro()
    if (!distro) return options.windows(ids, now)
    // Never waits for the home lookup: until it is known, this distribution is offline.
    const home = knownHome(distro, { ...options, ticked: options.ticked() })
    if (!home) throw Error('offline')
    const key = `${distro}\u0000${home}`
    let reader = readers.get(key)
    if (!reader) {
      reader = createWslSessionReader({ root: distroRoot(distro, home), home, dataDir: options.dataDir, platform: options.platform })
      readers.set(key, reader)
    }
    return reader(ids, now)
  }
}

/**
 * The distribution Codex is read in: the first ticked one, and only on Windows when the Windows
 * Codex CLI is not installed (`resolveCodexBinary` finds none). Null means Codex runs on Windows.
 */
export function codexWslDistro(options: {
  ticked: readonly string[]
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}): string | null {
  if (targetPlatform(options.platform) !== 'win32') return null
  const first = options.ticked[0]
  if (first === undefined || !isDistroName(first)) return null
  return resolveCodexBinary(options.env ?? process.env, 'win32', options.exists) === null ? first : null
}
