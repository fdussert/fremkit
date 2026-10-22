/**
 * The dev servers Fremkit restarted: it spawns them, keeps their output, and remembers them.
 *
 * A restarted server is Fremkit's child, in its own process group (`detached`), with stdout and
 * stderr on a log file opened `O_APPEND` under `<dataDir>/servers/` (folder 0700, files 0600) and
 * stdin on /dev/null. It outlives a restart of Fremkit, which is why `managed.json` remembers it:
 * pid, start time, log, ports and when it was started, nothing else — never its argv, never its
 * environment, which the caller hands to `start` for the one `spawn` call and nobody keeps.
 *
 * Kept out of backups (`backup/routes.ts` packs the config, backgrounds and tile icons only) and
 * diagnostics (which read the helper's `server.log` only).
 */

import { closeSync, openSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { z } from 'zod'
import { homeToTilde } from '../../home-tilde.js'
import { maskSecrets, type ProcInfo } from './list.js'

export const SERVERS_DIR = 'servers'
export const MANAGED_FILE = 'managed.json'
/** How long a restarted server may take to listen before its row turns red. */
export const START_TIMEOUT_MS = 30_000
/** Past this size a log is cut back to its last `LOG_KEEP_BYTES`. */
export const LOG_CUT_BYTES = 1024 * 1024
export const LOG_KEEP_BYTES = 512 * 1024
/** How long the log of a server that is gone is kept. */
export const LOG_RETAIN_MS = 24 * 60 * 60 * 1000
export const LOG_TAIL_LINES = 20
export const LOG_LINE_CHARS = 300
/** What a server prints when its port is taken (Node, Python, Vite, Next…). */
export const PORT_IN_USE = /EADDRINUSE|address already in use|port \d+ is (already )?in use/i

/** The most `managed.json` remembers: more than anyone restarts, a bound all the same. */
const MAX_ENTRIES = 64
/** What the tail reads from the end of a log. */
const TAIL_BYTES = 64 * 1024
const SWEEP_EVERY_MS = 60_000
const LOG_NAME = /^server-\d+-[0-9a-f]{8}\.log$/

export type ManagedEntry = { pid: number; start: string; log: string; ports: number[]; startedAt: number }

/** What a restart replays. `env` goes to `spawn` and nowhere else. */
export type Launch = { exe: string; argv: string[]; cwd: string; env: Record<string, string>; ports: number[] }

/** The slice of `child_process.spawn` used here, injectable for tests. */
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => {
  pid?: number
  unref(): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node's own listener type
  once(event: string, listener: (...args: any[]) => void): unknown
}

const Entry = z.object({
  pid: z.number().int().min(2),
  start: z.string().max(64),
  log: z.string().min(1).max(4096),
  ports: z.array(z.number().int().min(1).max(65535)).max(64),
  startedAt: z.number().finite(),
})

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** One output line as a row shows it: no colours, home as `~`, secrets masked, then cut to 300. */
export function cleanLogLine(line: string, home: string): string {
  const plain = line.replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '')
  // Masked before the cut, so a credential is never left half-shown at the edge.
  return maskSecrets(homeToTilde(plain, home)).slice(0, LOG_LINE_CHARS)
}

/** The last 20 non-blank lines of a log, cleaned; nothing when it cannot be read. */
export async function readLogTail(path: string, home: string): Promise<string[]> {
  let file
  try {
    file = await open(path, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await file.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await file.read(buf, 0, length, size - length)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r\n|\n|\r/)
    // Read from the middle of the file: the first line is a piece of one.
    if (length < size) lines.shift()
    return lines.map((l) => cleanLogLine(l, home)).filter((l) => l.trim() !== '').slice(-LOG_TAIL_LINES)
  } catch {
    return []
  } finally {
    await file.close().catch(() => undefined)
  }
}

/**
 * Past `LOG_CUT_BYTES`, the last `LOG_KEEP_BYTES` copied to the start and the rest truncated. The
 * child writes `O_APPEND`, so it goes on at the new end; a few lines written during the cut are lost.
 */
export async function cutBack(path: string): Promise<boolean> {
  let file
  try {
    file = await open(path, 'r+')
  } catch {
    return false
  }
  try {
    const { size } = await file.stat()
    if (size <= LOG_CUT_BYTES) return false
    const buf = Buffer.alloc(LOG_KEEP_BYTES)
    const { bytesRead } = await file.read(buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES)
    await file.write(buf, 0, bytesRead, 0)
    await file.truncate(bytesRead)
    return true
  } catch {
    return false
  } finally {
    await file.close().catch(() => undefined)
  }
}

export type ManagedState = 'up' | 'starting' | 'failed' | 'drop'

/**
 * A restarted server's light. Listening is up, whatever its log says (Vite prints "port in use" and
 * moves to the next one). Alive and not listening: starting, or failed once its log says its port is
 * taken or 30 s went by. Gone: failed, unless Fremkit saw it exit 0 (`drop`, no row). After a restart
 * of Fremkit the exit code is unknowable: gone is failed.
 */
export function managedState(s: { alive: boolean; listening: boolean; tail: string[]; startedAt: number; now: number; exitCode: number | null | undefined }): ManagedState {
  if (s.alive && s.listening) return 'up'
  if (s.alive) return s.tail.some((l) => PORT_IN_USE.test(l)) || s.now - s.startedAt > START_TIMEOUT_MS ? 'failed' : 'starting'
  return s.exitCode === 0 ? 'drop' : 'failed'
}

/** The ports a port-in-use failure names, with the ones the server held. */
export function busyPorts(entry: ManagedEntry, tail: string[]): number[] {
  const ports = new Set(entry.ports)
  for (const line of tail) {
    if (!PORT_IN_USE.test(line)) continue
    // A port after an address (`:::3000`, `127.0.0.1:3000`, `[::1]:3000`, `localhost:3000`,
    // `*:3000`) or after `port `/`PORT=`; never the pieces of a timestamp (`10:42:01`).
    for (const m of line.matchAll(/(?:(?:localhost|\b\d{1,3}(?:\.\d{1,3}){3}|\]|::|\*):|\bport[ =]+)(\d{1,5})\b/gi)) {
      const port = Number(m[1])
      if (port >= 1 && port <= 65535) ports.add(port)
    }
  }
  return [...ports]
}

/** The entry still runs: its pid shows the start time it was spawned with. */
export function isAlive(entry: ManagedEntry, procs: Map<number, ProcInfo>): boolean {
  return entry.start !== '' && procs.get(entry.pid)?.start === entry.start
}

/** The living managed server `pid` is or runs under, climbing its parents; null when none. */
export function managedRootOf(pid: number, entries: ManagedEntry[], procs: Map<number, ProcInfo>): ManagedEntry | null {
  const seen = new Set<number>()
  for (let cur: number | undefined = pid; cur !== undefined && cur > 1 && !seen.has(cur); cur = procs.get(cur)?.ppid) {
    seen.add(cur)
    const entry = entries.find((e) => e.pid === cur && isAlive(e, procs))
    if (entry) return entry
  }
  return null
}

export interface ManagedServers {
  /** Reads `managed.json` once. */
  ready(): Promise<void>
  list(): ManagedEntry[]
  /**
   * Spawns `launch.exe` with `launch.argv.slice(1)` and `argv0` `launch.argv[0]`, its folder and its environment, detached, no
   * shell, its output on a new log; `readStart` gives the child's `lstart` for its identity.
   */
  start(launch: Launch, readStart: (pid: number) => Promise<string | null>): Promise<ManagedEntry>
  /** The exit code Fremkit saw (null for a signal), undefined while it runs or when it was not watched. */
  exitCode(entry: ManagedEntry): number | null | undefined
  /**
   * Against the current `ps`: drops what was gone across a restart of Fremkit, what exited 0, and
   * what has been gone for a day (its log too).
   */
  reconcile(procs: Map<number, ProcInfo>): Promise<void>
  /** Killed or dismissed through Fremkit: no row any more. Its log goes a day later. */
  forget(entry: ManagedEntry): Promise<void>
  /** Cuts back the logs past 1 MB; deletes, once a minute at most, logs nobody refers to after a day. */
  maintain(): Promise<void>
}

type Tracked = {
  entry: ManagedEntry
  exitCode?: number | null
  goneAt?: number
  loaded: boolean
  /** Spawned by this Fremkit, which still holds its handle: until 'exit', the pid cannot be anyone else's. */
  child?: boolean
  /** Its start time could not be read, and it was stopped for it. */
  unidentified?: boolean
}

export function createManagedServers(opts: {
  dataDir: string
  home: string
  now?: () => number
  spawn?: SpawnFn
  /** Fremkit's pid: the parent a child whose start time was missed must show. */
  selfPid?: number
  /** `process.kill`, for a child that can never be identified. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
}): ManagedServers {
  const dir = join(opts.dataDir, SERVERS_DIR)
  const file = join(dir, MANAGED_FILE)
  const now = opts.now ?? Date.now
  const spawn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const selfPid = opts.selfPid ?? process.pid
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  let tracked: Tracked[] = []
  let loading: Promise<void> | null = null
  let lastSweep = -Infinity
  /** Saves run one after another; `dirty` when the last one failed, so the next reconcile writes again. */
  let saving: Promise<void> = Promise.resolve()
  let dirty = false

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // An older folder, or one made under a wider umask: mkdir's mode does not narrow it.
    await chmod(dir, 0o700)
  }

  /** Writes the set as it is when this save's turn comes, through a tmp file of its own. */
  function save(): Promise<void> {
    const write = async () => {
      await ensureDir()
      const body = JSON.stringify(tracked.map(({ entry: e }) => ({ pid: e.pid, start: e.start, log: e.log, ports: e.ports, startedAt: e.startedAt }))) + '\n'
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await writeFile(tmp, body, { mode: 0o600 })
        await chmod(tmp, 0o600)
        await rename(tmp, file)
      } catch (error) {
        await unlink(tmp).catch(() => undefined)
        throw error
      }
    }
    const done = saving.then(write, write)
    saving = done.then(() => { dirty = false }, () => { dirty = true })
    return done
  }

  const ready = () => {
    loading ??= (async () => {
      try {
        const parsed = z.array(Entry).max(MAX_ENTRIES).safeParse(JSON.parse(await readFile(file, 'utf8')))
        // Only logs of our own folder: a hand-edited file never points the tail or the sweep elsewhere.
        if (parsed.success) tracked = parsed.data.filter((e) => e.log.startsWith(dir + '/') && LOG_NAME.test(e.log.slice(dir.length + 1))).map((entry) => ({ entry, loaded: true }))
      } catch { /* none yet, or unreadable: nothing to remember */ }
    })()
    return loading
  }

  const find = (entry: ManagedEntry) => tracked.find((t) => t.entry === entry || t.entry.log === entry.log)

  return {
    ready,
    list: () => tracked.map((t) => t.entry),

    async start(launch, readStart) {
      await ready()
      await ensureDir()
      const startedAt = now()
      const log = join(dir, `server-${startedAt}-${randomBytes(4).toString('hex')}.log`)
      const fd = openSync(log, 'a', 0o600)
      let child: ReturnType<SpawnFn>
      try {
        // The server runs under 077; the child would write 0600 build output under it.
        const previous = process.umask(0o022)
        try {
          // `argv0`: the original argv[0] (`node`, not the exe's full path), so the replay is exact.
          child = spawn(launch.exe, launch.argv.slice(1), { argv0: launch.argv[0], cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', fd, fd] })
        } finally {
          process.umask(previous)
        }
      } catch {
        await unlink(log).catch(() => undefined)
        throw new Error('spawn failed')
      } finally {
        closeSync(fd)
      }
      // A bad folder or executable is reported on the next tick, with no pid.
      child.once('error', () => undefined)
      if (child.pid === undefined) {
        await unlink(log).catch(() => undefined)
        throw new Error('spawn failed')
      }
      child.unref()
      const t: Tracked = { entry: { pid: child.pid, start: '', log, ports: [...launch.ports], startedAt }, loaded: false, child: true }
      child.once('exit', (code: number | null) => { t.exitCode = code })
      tracked.push(t)
      if (tracked.length > MAX_ENTRIES) tracked.shift()
      t.entry.start = (await readStart(child.pid).catch(() => null)) ?? ''
      // The child runs whatever the disk says: a failed save leaves it remembered in memory, and
      // the next reconcile writes it again (`dirty`). Only a restart of Fremkit before then loses it.
      await save().catch(() => undefined)
      return t.entry
    },

    exitCode: (entry) => find(entry)?.exitCode,

    async reconcile(procs) {
      await ready()
      const t0 = now()
      let changed = false
      // A start time `ps` missed right after the spawn: read it again, once, from this ps. Without
      // one the server is invisible and cannot be killed through Fremkit, so a child still
      // unidentified is stopped (its group, then itself) and stays red. Safe to signal: no 'exit'
      // yet means Fremkit has not reaped it, so the pid is still that child's.
      for (const t of tracked) {
        if (t.entry.start !== '' || !t.child || t.unidentified || t.exitCode !== undefined) continue
        const p = procs.get(t.entry.pid)
        if (p && p.ppid === selfPid) {
          t.entry.start = p.start
          changed = true
          continue
        }
        t.unidentified = true
        if (t.entry.pid > 1) {
          for (const target of [-t.entry.pid, t.entry.pid]) {
            try { kill(target, 'SIGKILL') } catch { /* gone already */ }
          }
        }
      }
      tracked = tracked.filter((t) => {
        if (isAlive(t.entry, procs)) {
          t.loaded = false
          t.goneAt = undefined
          return true
        }
        if (t.loaded || t.exitCode === 0) { changed = true; return false }
        t.goneAt ??= t0
        if (t0 - t.goneAt > LOG_RETAIN_MS) {
          changed = true
          void unlink(t.entry.log).catch(() => undefined)
          return false
        }
        return true
      })
      if (changed || dirty) await save().catch(() => undefined)
    },

    async forget(entry) {
      const before = tracked.length
      tracked = tracked.filter((t) => t.entry !== entry && t.entry.log !== entry.log)
      if (tracked.length !== before) await save().catch(() => undefined)
    },

    async maintain() {
      for (const t of tracked) await cutBack(t.entry.log)
      const t0 = now()
      if (t0 - lastSweep < SWEEP_EVERY_MS) return
      lastSweep = t0
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      const kept = new Set(tracked.map((t) => t.entry.log))
      for (const name of names) {
        const path = join(dir, name)
        if (!LOG_NAME.test(name) || kept.has(path)) continue
        try {
          if (t0 - (await stat(path)).mtimeMs > LOG_RETAIN_MS) await unlink(path)
        } catch { /* gone already */ }
      }
    },
  }
}
