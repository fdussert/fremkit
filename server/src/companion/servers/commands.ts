/**
 * The commands of `companion:servers`: kill, open and reveal a listed server. Every one is this
 * Mac's only (`ctx.loopback`), refused while Fremdev is off, and names a row of the last snapshot
 * by its id (`pid:start`). A kill reads `ps` again first, so a pid recycled since the snapshot is
 * refused, and signals the server's launch root (`launchRoot`): its process group when that group
 * is the server's own, else the root's tree pid by pid (`killGroup`).
 *
 * Fremkit itself is never signalled, nor anything above it: a runner that started both Fremkit and
 * the server (`concurrently`, `turbo dev`, `pnpm -r dev`) is not the server's to take down, so the
 * root is narrowed to the highest process on the way to the listener that is not Fremkit's
 * ancestor (`narrowRoot`).
 *
 * A server Fremkit restarted (`managed.ts`) is Fremkit's child, so inside `protectedPids`: its own
 * tree, matched by pid and start time against the managed set, is taken out of that set again, and
 * its kill signals the group it leads (`detached`).
 *
 * `createKiller` is the kill flow on its own, for the restart to reuse. A restart reads the launch
 * root's exact argv and environment (`procargs.ts`), kills, waits for the ports, and spawns it again
 * under Fremkit (`managed.ts`); the environment lives in that one call's variables only.
 */

import { z } from 'zod'
import { INSTANCE_ID_MAX, type Config } from '../../config/schema.js'
import { tr, type MessageKey } from '../../i18n.js'
import type { CommandContext } from '../../providers/types.js'
import { fremdevEnabled } from '../dev.js'
import { isDockerHolder, isHelper, isSystemProcess, launchRoot, parseLsofCwd, parseLsofListen, parsePs, selfTree, type ProcInfo } from './list.js'
import { isAlive, managedRootOf, type ManagedEntry, type ManagedServers } from './managed.js'
import type { ProcArgs } from './procargs.js'
import type { ServerRow } from './provider.js'
import type { ServersSystem } from './system.js'

/** How long a TERM is given before whatever is left gets KILL. */
export const KILL_GRACE_MS = 3_000
/** The list is read again this long after any command, so the row shows what it did. */
export const COMMAND_REFRESH_MS = 1_000
/** How long a restart waits for the killed server's ports to be free. */
export const PORT_FREE_MS = 5_000
const PORT_POLL_MS = 250

export type KillTarget = { pgid: number } | { pids: number[] }

/**
 * What a kill must never signal: Fremkit's own tree (`selfTree`) and every ancestor of Fremkit up
 * to launchd, since killing a parent can take Fremkit with it (`tsx watch` above the server).
 */
export function protectedPids(selfPid: number, procs: Map<number, ProcInfo>): Set<number> {
  const set = selfTree(selfPid, procs)
  for (let cur = procs.get(selfPid)?.ppid; cur !== undefined && cur >= 1 && !set.has(cur); cur = procs.get(cur)?.ppid) set.add(cur)
  return set
}

/** A process Fremkit may signal: this account's, not protected, not the helper, not the system's, not Docker's. */
function signallable(p: ProcInfo, uid: number, guarded: Set<number>): boolean {
  return p.uid === uid && !guarded.has(p.pid) && !isHelper(p) && !isSystemProcess(p) && !isDockerHolder(p)
}

/**
 * The launch root, moved down toward the listener while it is an ancestor of Fremkit: the highest
 * process on the listener's chain whose subtree no longer holds Fremkit. The listener itself when
 * nothing above it qualifies.
 */
export function narrowRoot(root: number, listener: number, procs: Map<number, ProcInfo>, guarded: Set<number>): number {
  const path: number[] = []
  for (let cur: number | undefined = listener; cur !== undefined && !path.includes(cur); cur = procs.get(cur)?.ppid) {
    path.push(cur)
    if (cur === root) break
  }
  if (path[path.length - 1] !== root) return listener
  for (let i = path.length - 1; i >= 0; i--) if (!guarded.has(path[i])) return path[i]
  return listener
}

/**
 * What a kill of `root` signals. Its process group, when the group is its own job: another group
 * than its parent's (a shell's job, not an IDE or agent that spawned it without job control), than
 * Fremkit's or its ancestors', and holding nothing protected, of the system or of another account.
 * Otherwise the root and its descendants, pid by pid, those Fremkit may signal only. `guarded` is
 * `protectedPids`.
 */
export function killGroup(root: ProcInfo, procs: Map<number, ProcInfo>, guarded: Set<number>): KillTarget {
  const parent = procs.get(root.ppid)
  const ownGroups = new Set([...guarded].map((pid) => procs.get(pid)?.pgid).filter((g): g is number => g !== undefined))
  const members = [...procs.values()].filter((p) => p.pgid === root.pgid)
  const ownJob = root.pgid > 1 && parent !== undefined && parent.pgid !== root.pgid && !ownGroups.has(root.pgid)
    && members.every((m) => signallable(m, root.uid, guarded))
  if (ownJob) return { pgid: root.pgid }
  return { pids: rootTree(root, procs, guarded) }
}

/** `root` and its descendants, breadth first, those Fremkit may signal only. */
function rootTree(root: ProcInfo, procs: Map<number, ProcInfo>, guarded: Set<number>): number[] {
  const children = new Map<number, number[]>()
  for (const p of procs.values()) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const tree: number[] = []
  const seen = new Set<number>()
  const queue = [root.pid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []).sort((a, b) => a - b))
  }
  return tree.filter((pid) => signallable(procs.get(pid)!, root.uid, guarded))
}

export type KillOutcome = { ok: true; settled: Promise<void>; root: { pid: number; start: string } } | { ok: false; error: MessageKey }

export interface KillDeps {
  sys: Pick<ServersSystem, 'uid' | 'runPsStats' | 'runPsArgs' | 'kill'>
  selfPid: number
  /** The servers Fremkit started: theirs are the only processes of Fremkit's tree a kill may reach. */
  managed?: () => ManagedEntry[]
}

/** Every process, with the command lines of `pid` and its parents (what `launchRoot` reads). */
async function readProcs(sys: KillDeps['sys'], pid: number): Promise<Map<number, ProcInfo>> {
  const stats = await sys.runPsStats()
  const bare = parsePs(stats, '')
  const chain: number[] = []
  for (let cur: number | undefined = pid; cur !== undefined && cur > 1 && !chain.includes(cur); cur = bare.get(cur)?.ppid) chain.push(cur)
  return parsePs(stats, await sys.runPsArgs(chain))
}

/** Sends one signal; a process already gone is not a failure. */
function send(sys: KillDeps['sys'], pid: number, signal: NodeJS.Signals): boolean {
  try {
    sys.kill(pid, signal)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** One pid, never 0, 1 or a negative number (which would be a group). */
function sendPid(sys: KillDeps['sys'], pid: number, signal: NodeJS.Signals): boolean {
  return Number.isInteger(pid) && pid > 1 ? send(sys, pid, signal) : false
}

/** A process group, never 0, 1 or Fremkit's own; refused when Fremkit's group is not known. */
function sendGroup(sys: KillDeps['sys'], pgid: number, ownPgid: number | undefined, signal: NodeJS.Signals): boolean {
  return Number.isInteger(pgid) && pgid > 1 && ownPgid !== undefined && pgid !== ownPgid ? send(sys, -pgid, signal) : false
}

type Target = { procs: Map<number, ProcInfo>; root: ProcInfo; guarded: Set<number>; owner: ManagedEntry | null }

/**
 * What a kill or a restart of a row acts on, from a fresh `ps`: refused unless it still shows the
 * row's pid with the row's start time, and unless both it and its (narrowed) launch root are
 * processes Fremkit may signal. A row of a server Fremkit started has that server as its root, and
 * that server's tree only is taken out of `protectedPids`.
 */
async function resolveTarget(row: Pick<ServerRow, 'id' | 'pid'>, deps: KillDeps): Promise<Target | { error: MessageKey }> {
  const { sys, selfPid } = deps
  const procs = await readProcs(sys, row.pid)
  const p = procs.get(row.pid)
  if (!p || `${p.pid}:${p.start}` !== row.id) return { error: 'companion.serversUnknown' }
  // Without Fremkit in ps, its tree and its ancestors are unknown: nothing can be judged safe.
  if (!procs.has(selfPid)) return { error: 'companion.serversKillFailed' }
  const guarded = protectedPids(selfPid, procs)
  let managed = managedRootOf(p.pid, deps.managed?.() ?? [], procs)
  const managedTree = managed ? selfTree(managed.pid, procs) : null
  // A tree holding Fremkit is never one Fremkit started.
  if (managedTree?.has(selfPid)) managed = null
  else if (managedTree) for (const pid of managedTree) guarded.delete(pid)
  if (!signallable(p, sys.uid, guarded)) return { error: 'companion.serversNotAllowed' }
  const root = procs.get(managed ? managed.pid : narrowRoot(launchRoot(p.pid, procs), p.pid, procs, guarded))!
  if (!signallable(root, sys.uid, guarded)) return { error: 'companion.serversNotAllowed' }
  return { procs, root, guarded, owner: managed }
}

/**
 * Kills the server a row names (`resolveTarget`). TERM now; after `KILL_GRACE_MS`, KILL to whatever
 * is still alive with the same start time (`settled` resolves then). Refused rows send nothing.
 */
export async function killServer(row: Pick<ServerRow, 'id' | 'pid'>, deps: KillDeps): Promise<KillOutcome> {
  const { sys, selfPid } = deps
  const resolved = await resolveTarget(row, deps)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { procs, root, guarded, owner } = resolved

  const ownPgid = procs.get(selfPid)!.pgid
  const target = killGroup(root, procs, guarded)
  const watched = 'pgid' in target
    ? [...procs.values()].filter((m) => m.pgid === target.pgid)
    : target.pids.map((pid) => procs.get(pid)!)
  const sent = 'pgid' in target
    ? sendGroup(sys, target.pgid, ownPgid, 'SIGTERM')
    : target.pids.map((pid) => sendPid(sys, pid, 'SIGTERM')).some(Boolean)
  if (!sent) return { ok: false, error: 'companion.serversKillFailed' }

  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void escalate(deps, target, watched, owner).catch(() => undefined).finally(resolve)
    }, KILL_GRACE_MS)
    timer.unref?.()
  })
  return { ok: true, settled, root: { pid: root.pid, start: root.start } }
}

/** KILL to the processes TERM left alive: the same pid with the same start, still signallable, nothing else. */
async function escalate(deps: KillDeps, target: KillTarget, watched: ProcInfo[], owner: ManagedEntry | null): Promise<void> {
  const { sys, selfPid } = deps
  const now = parsePs(await sys.runPsStats(), '')
  const guarded = protectedPids(selfPid, now)
  // The managed trees as they are now, the killed one included though it was forgotten since the
  // TERM: a server Fremkit started is still not Fremkit.
  for (const entry of [...(deps.managed?.() ?? []), ...(owner ? [owner] : [])]) {
    if (!isAlive(entry, now)) continue
    const tree = selfTree(entry.pid, now)
    if (!tree.has(selfPid)) for (const pid of tree) guarded.delete(pid)
  }
  const alive = watched.filter((w) => {
    const cur = now.get(w.pid)
    return cur !== undefined && cur.start === w.start && signallable(cur, sys.uid, guarded)
  })
  if (alive.length === 0) return
  if ('pgid' in target) {
    // The group again, as it is now: still the same job, still nothing we must not touch.
    const members = [...now.values()].filter((m) => m.pgid === target.pgid)
    const stillOurs = alive.some((w) => now.get(w.pid)!.pgid === target.pgid) && members.every((m) => signallable(m, sys.uid, guarded))
    if (stillOurs && sendGroup(sys, target.pgid, now.get(selfPid)?.pgid, 'SIGKILL')) return
  }
  for (const w of alive) sendPid(sys, w.pid, 'SIGKILL')
}

export interface ServerKiller {
  /** Kills the row's server; while a kill of that row is still settling, its outcome instead of a second TERM. */
  kill(row: Pick<ServerRow, 'id' | 'pid'>): Promise<KillOutcome>
  /** The kill of that row still settling, if any: what a restart awaits. */
  pending(id: string): Promise<KillOutcome> | undefined
}

/** `killServer` with one kill in flight per row, until its escalation has run. */
export function createKiller(deps: KillDeps): ServerKiller {
  const inFlight = new Map<string, Promise<KillOutcome>>()
  return {
    kill(row) {
      const running = inFlight.get(row.id)
      if (running) return running
      const outcome = killServer(row, deps)
      inFlight.set(row.id, outcome)
      void outcome
        .then((o) => (o.ok ? o.settled : undefined), () => undefined)
        .finally(() => { if (inFlight.get(row.id) === outcome) inFlight.delete(row.id) })
      return outcome
    },
    pending: (id) => inFlight.get(id),
  }
}

const CommandSchema = z.strictObject({
  // The host stamps it on every widget command.
  instanceId: z.string().min(1).max(INSTANCE_ID_MAX),
  id: z.string().min(1).max(64),
})

type Result = { ok: true } | { ok: false; error: string }

export interface ServerCommandsOptions {
  sys: ServersSystem
  selfPid: number
  config: () => Config
  /** A row of the last snapshot. */
  lookup(id: string): ServerRow | null
  /** The row's real working folder, kept server-side: the snapshot only has the `~` form. */
  folderOf(id: string): string | null
  /** Polls the channel again (the registry's `refresh`). */
  refresh?: () => void
  /** One kill in flight per row; made here when not given, so a restart can share it. */
  killer?: ServerKiller
  /** `FREMKIT_SCANNER`: without it there is no restart. */
  scanner?: string | null
  /** `readProcArgs`, bound to its runner. */
  readProcArgs?: (scanner: string, pid: number) => Promise<ProcArgs>
  /** The servers Fremkit started. */
  managed?: ManagedServers
  /** The managed server a row of the last snapshot belongs to. */
  managedOf?(id: string): ManagedEntry | null
  /** Called once a restart spawned: the row it replaced, for the new server's row while it has none. */
  started?(entry: ManagedEntry, replaced: ServerRow): void
}

/**
 * Waits until nothing listens on `ports`, polling lsof, for `PORT_FREE_MS` of real time at most:
 * measured with the clock, since a slow lsof makes each round longer than its pause.
 */
async function portsFree(sys: Pick<ServersSystem, 'runLsofListen'>, ports: number[]): Promise<boolean> {
  const since = Date.now()
  const left = () => PORT_FREE_MS - (Date.now() - since)
  const pause = (ms: number) => new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.() })
  for (;;) {
    // An lsof still running when the time is up does not stretch the wait.
    const out = await Promise.race([sys.runLsofListen(), pause(Math.max(0, left()))])
    if (out === null) return false
    const held = new Set(parseLsofListen(out).flatMap((l) => l.ports))
    if (!ports.some((port) => held.has(port))) return true
    if (left() <= 0) return false
    await pause(Math.min(PORT_POLL_MS, left()))
  }
}

export function createServerCommands(opts: ServerCommandsOptions): Record<string, (payload: unknown, ctx?: CommandContext) => Promise<Result>> {
  const locale = () => opts.config().locale
  const failed = (key: MessageKey): Result => ({ ok: false, error: tr(locale(), key) })
  const deps: KillDeps = { sys: opts.sys, selfPid: opts.selfPid, managed: () => opts.managed?.list() ?? [] }
  const killer = opts.killer ?? createKiller(deps)
  const restarts = new Map<string, Promise<Result>>()

  function later(): void {
    if (!opts.refresh) return
    const timer = setTimeout(() => opts.refresh?.(), COMMAND_REFRESH_MS)
    timer.unref?.()
  }

  /** Guard, payload, switch and row, then `act`; the list is read again 1 s after. */
  function command(act: (row: ServerRow) => Promise<Result>) {
    return async (payload: unknown, ctx?: CommandContext): Promise<Result> => {
      // Fails closed: no context, or a paired device, is not this Mac.
      if (ctx?.loopback !== true) throw new Error(tr(locale(), 'provider.localOnly'))
      const parsed = CommandSchema.safeParse(payload)
      if (!parsed.success) throw new Error(tr(locale(), 'provider.invalidPayload'))
      if (!fremdevEnabled(opts.config())) return failed('companion.devDisabled')
      try {
        const row = opts.lookup(parsed.data.id)
        if (!row) return failed('companion.serversUnknown')
        // A Docker holder is Docker Desktop's, whatever port it holds: no action at all.
        if (row.docker !== null) return failed('companion.serversNotAllowed')
        return await act(row)
      } finally {
        later()
      }
    }
  }

  async function open(args: string[]): Promise<Result> {
    try {
      await opts.sys.runOpen(args)
      return { ok: true }
    } catch {
      return failed('companion.serversOpenFailed')
    }
  }

  const readStart = async (pid: number): Promise<string | null> => parsePs(await opts.sys.runPsStats(), '').get(pid)?.start ?? null

  /**
   * The launch root again, exactly: its argv and environment from `procargs`, its own folder (not
   * the listener's), every port its tree holds. Refused before anything is signalled when any of
   * that cannot be read; then the kill, the wait for the ports, and the spawn.
   */
  async function restartServer(row: ServerRow, scanner: string, managed: ManagedServers, read: NonNullable<ServerCommandsOptions['readProcArgs']>): Promise<Result> {
    const resolved = await resolveTarget(row, deps)
    if ('error' in resolved) return failed(resolved.error)
    const { procs, root } = resolved
    const cwd = parseLsofCwd(await opts.sys.runLsofCwd([root.pid])).get(root.pid)
    if (!cwd || !cwd.startsWith('/')) return failed('companion.serversNoFolder')
    const tree = selfTree(root.pid, procs)
    const held = parseLsofListen(await opts.sys.runLsofListen()).filter((l) => tree.has(l.pid)).flatMap((l) => l.ports)
    const ports = [...new Set([...row.ports, ...held])].sort((a, b) => a - b)
    let launch: ProcArgs
    try {
      launch = await read(scanner, root.pid)
    } catch {
      return failed('companion.serversNoRestart')
    }
    // What procargs read is the root's still: its pid did not change hands meanwhile.
    if ((await readStart(root.pid)) !== root.start) return failed('companion.serversUnknown')

    const owner = opts.managedOf?.(row.id) ?? null
    let outcome: KillOutcome
    try {
      outcome = await killer.kill(row)
    } catch {
      return failed('companion.serversKillFailed')
    }
    if (!outcome.ok) return failed(outcome.error)
    if (owner) await managed.forget(owner)
    if (outcome.root.pid !== root.pid || outcome.root.start !== root.start) return failed('companion.serversRestartFailed')
    await outcome.settled
    if (!(await portsFree(opts.sys, ports))) return failed('companion.serversPortBusy')
    try {
      const entry = await managed.start({ exe: launch.exe, argv: launch.argv, cwd, env: launch.env, ports }, readStart)
      opts.started?.(entry, row)
    } catch {
      return failed('companion.serversRestartFailed')
    }
    return { ok: true }
  }

  return {
    kill: command(async (row) => {
      if (row.system) return failed('companion.serversNotAllowed')
      const owner = opts.managedOf?.(row.id) ?? null
      // A server Fremkit started that is gone already: its red row is dismissed.
      if (owner && !isAlive(owner, parsePs(await opts.sys.runPsStats(), ''))) {
        await opts.managed?.forget(owner)
        return { ok: true }
      }
      let outcome: KillOutcome
      try {
        outcome = await killer.kill(row)
      } catch {
        return failed('companion.serversKillFailed')
      }
      if (outcome.ok && owner) await opts.managed?.forget(owner)
      return outcome.ok ? { ok: true } : failed(outcome.error)
    }),
    restart: command(async (row) => {
      const { scanner, managed, readProcArgs: read } = opts
      if (!scanner || !managed || !read) return failed('companion.serversNoRestart')
      if (row.system || !row.dev) return failed('companion.serversNotAllowed')
      // Every remembered server alive: no room, refused before anything is signalled. A managed
      // row's restart frees its own place.
      if (!managed.hasRoom() && !opts.managedOf?.(row.id)) return failed('companion.serversBusy')
      const running = restarts.get(row.id)
      if (running) return running
      if (killer.pending(row.id)) return failed('companion.serversBusy')
      const job = restartServer(row, scanner, managed, read).catch(() => failed('companion.serversRestartFailed')).finally(() => restarts.delete(row.id))
      restarts.set(row.id, job)
      return job
    }),
    open: command(async (row) => open([`http://localhost:${row.ports[0]}/`])),
    // A system program's folder is not the user's project, nor is a non-dev program's: Open only,
    // and Kill for the latter.
    reveal: command(async (row) => {
      if (row.system || !row.dev) return failed('companion.serversNotAllowed')
      const folder = opts.folderOf(row.id)
      if (folder === null || !folder.startsWith('/')) return failed('companion.serversNoFolder')
      return open(['-R', folder])
    }),
  }
}
