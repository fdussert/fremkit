import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import type { SaveOptions } from '../config/store.js'
import { nodeIo, syncDir, syncFile, type DurableIo } from './durable.js'
import { SECRET_KEY_RE } from './types.js'

/**
 * What the move did or why it did not, for one log line. Fixed codes only: never a key name, a
 * value, an error message or a path.
 *
 * - `moved`: every secret now in DPAPI, the config switched, `secrets.json` removed.
 * - `leftover-removed`: a `secrets.json` left by a move interrupted after the switch, removed.
 * - `entries-skipped`: entries of `secrets.json` no store can read (a malformed name, a value that
 *   is not text), left out of the move; logged with their count only.
 * - `file-unreadable`: `secrets.json` is not a JSON object; nothing moved.
 * - `dpapi-failed`: DPAPI refused a write or a read (host unreachable, timed out, …); nothing moved.
 * - `mismatch`: a secret read back from DPAPI was not the one written; nothing moved.
 * - `config-save`: the config could not be saved with the new backend; nothing moved.
 * - `config-sync`: moved, but the saved config could not be flushed to disk, so `secrets.json`
 *   is kept; the next start removes it.
 * - `file-remove`: moved, but `secrets.json` could not be removed; the next start removes it.
 * - `leftover-unreadable` / `leftover-differs`: a `secrets.json` beside a DPAPI config that is not
 *   an exact copy of what DPAPI holds, kept for the user to look at.
 */
export type MoveCode =
  | 'moved'
  | 'leftover-removed'
  | 'entries-skipped'
  | 'file-unreadable'
  | 'dpapi-failed'
  | 'mismatch'
  | 'config-save'
  | 'config-sync'
  | 'file-remove'
  | 'leftover-unreadable'
  | 'leftover-differs'

/** The success codes; every other one is a warning. */
export const MOVE_DONE: ReadonlySet<MoveCode> = new Set(['moved', 'leftover-removed'])

/** The part of `DpapiSecretStore` the move uses. */
export interface DpapiLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface MoveToDpapiDeps {
  platform: string
  demo: boolean
  dataDir: string
  /** The config store's file, flushed to disk before the plaintext copy is removed. */
  configFile: string
  store: {
    readonly degraded: boolean
    get(): Config
    save(input: unknown, opts?: SaveOptions): Promise<Config>
  }
  /**
   * A new DPAPI store over `dataDir` on every call: the read-back uses a second one, so what is
   * checked is what went to disk and unwraps again, not the first store's memory.
   */
  dpapi: () => DpapiLike
  /** `count` only for `entries-skipped`: how many, never which. */
  log: (code: MoveCode, count?: number) => void
  /** The file calls of the flush and the removal; the node ones when not given. */
  io?: DurableIo
}

export type MoveOutcome = 'skipped' | 'nothing' | 'moved' | 'failed' | 'leftover-removed' | 'leftover-kept'

type Plain = { kind: 'missing' } | { kind: 'bad' } | { kind: 'ok'; entries: Map<string, string>; skipped: number }

/**
 * Moves a Windows config's plaintext `secrets.json` into DPAPI, once, at start.
 *
 * A config carried over from another machine, or written before DPAPI existed, may say
 * `secrets.backend: "file"`, and nothing else can change that: `PUT /api/config` keeps the backend,
 * and hand-editing `fremkit.json` is not something the user should be asked to do. So on win32,
 * outside a demo, before the secret store is built:
 *
 * 1. Backend `file`: every entry of `secrets.json` the file store can read is written to DPAPI, DPAPI entries the file does
 *    not hold are dropped, and each one is read back through a fresh store and compared, in memory.
 *    Only when all of them match is the config saved with `dpapi` (reason `secrets-moved`, so the
 *    history keeps the version before) and flushed to disk, and only then is `secrets.json`
 *    removed. Any failure leaves the config (on disk and in memory) and `secrets.json` as they
 *    were, logs one code, and the next start retries.
 * 2. Backend `dpapi` (or `keychain`, which is DPAPI here) with a `secrets.json` still present: a
 *    move interrupted between the switch and the removal. The file goes only when every entry is
 *    in DPAPI with the same value; anything else keeps it and logs one code.
 *
 * Every step is safe to repeat, which is the whole crash-safety argument: before the config file
 * is renamed into place the backend is still `file` and the plaintext copy is whole, so the next
 * start does it all again (the DPAPI writes overwrite); after it, case 2 finishes the job. The
 * DPAPI files are flushed as they are written (`DpapiSecretStore`) and the config before the
 * removal, so a power cut cannot keep the removal and lose what replaced the file.
 *
 * Never on another platform (the Mac keeps its keychain and this never runs there), never in a
 * demo, never on a degraded config store (its config is the default, not the user's).
 */
export async function moveFileSecretsToDpapi(deps: MoveToDpapiDeps): Promise<MoveOutcome> {
  if (deps.platform !== 'win32' || deps.demo || deps.store.degraded) return 'skipped'
  const path = join(deps.dataDir, 'secrets.json')
  const backend = deps.store.get().secrets.backend
  if (backend === 'file') return move(deps, path)
  return cleanLeftover(deps, path)
}

async function move(deps: MoveToDpapiDeps, path: string): Promise<MoveOutcome> {
  const plain = await readPlain(path)
  if (plain.kind === 'bad') {
    deps.log('file-unreadable')
    return 'failed'
  }
  const entries = plain.kind === 'ok' ? plain.entries : new Map<string, string>()
  if (plain.kind === 'ok' && plain.skipped > 0) deps.log('entries-skipped', plain.skipped)
  try {
    const target = deps.dpapi()
    for (const [key, value] of entries) await target.set(key, value)
    // Copies a previous, interrupted attempt wrote for secrets deleted since: the file is the
    // truth while the backend says `file`, so DPAPI ends up holding exactly what it holds.
    for (const key of await target.keys()) if (!entries.has(key)) await target.delete(key)
    const check = deps.dpapi()
    const keys = await check.keys()
    if (keys.length !== entries.size || keys.some((k) => !entries.has(k))) {
      deps.log('mismatch')
      return 'failed'
    }
    for (const [key, value] of entries) {
      if ((await check.get(key)) !== value) {
        deps.log('mismatch')
        return 'failed'
      }
    }
  } catch {
    // The error says which host code failed, and nothing else; the log line says less still.
    deps.log('dpapi-failed')
    return 'failed'
  }
  try {
    const config = deps.store.get()
    await deps.store.save({ ...config, secrets: { ...config.secrets, backend: 'dpapi' } }, { reason: 'secrets-moved' })
  } catch {
    // The store publishes a config only once it is on disk, so memory still says `file` here.
    deps.log('config-save')
    return 'failed'
  }
  const io = deps.io ?? nodeIo
  try {
    await syncFile(io, deps.configFile)
    await syncDir(io, deps.dataDir)
  } catch {
    deps.log('config-sync')
    return 'moved'
  }
  deps.log((await removePlain(io, path)) ? 'moved' : 'file-remove')
  return 'moved'
}

async function cleanLeftover(deps: MoveToDpapiDeps, path: string): Promise<MoveOutcome> {
  const plain = await readPlain(path)
  if (plain.kind === 'missing') return 'nothing'
  if (plain.kind === 'bad') {
    deps.log('leftover-unreadable')
    return 'leftover-kept'
  }
  if (plain.skipped > 0) deps.log('entries-skipped', plain.skipped)
  try {
    const check = deps.dpapi()
    for (const [key, value] of plain.entries) {
      if ((await check.get(key)) !== value) {
        deps.log('leftover-differs')
        return 'leftover-kept'
      }
    }
  } catch {
    deps.log('dpapi-failed')
    return 'leftover-kept'
  }
  if (!(await removePlain(deps.io ?? nodeIo, path))) {
    deps.log('file-remove')
    return 'leftover-kept'
  }
  deps.log('leftover-removed')
  return 'leftover-removed'
}

/**
 * What `FileSecretStore` can read of `secrets.json`: string values under keys `SECRET_KEY_RE`
 * accepts (`get` asserts it, so no store reads any other). The rest is counted, not moved. A file
 * that is not a JSON object is `bad`, where the file store reads it as empty: an unreadable file
 * stops the move rather than being removed as "nothing to move".
 */
async function readPlain(path: string): Promise<Plain> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { kind: 'bad' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'bad' }
  const entries = new Map<string, string>()
  let skipped = 0
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && SECRET_KEY_RE.test(key)) entries.set(key, value)
    else skipped++
  }
  return { kind: 'ok', entries, skipped }
}

/**
 * Removes the plaintext file and the temporary a crashed file-store write may have left beside it.
 * A plain unlink: overwriting first means nothing on NTFS, whose writes need not land in place.
 */
async function removePlain(io: DurableIo, path: string): Promise<boolean> {
  for (const p of [`${path}.tmp`, path]) {
    try {
      await io.unlink(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
  }
  return true
}
