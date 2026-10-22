/**
 * The commands of `companion:servers`: kill, open and reveal a listed server. Every one is this
 * Mac's only (`ctx.loopback`), refused while Fremdev is off, and names a row of the last snapshot
 * by its id (`pid:start`). A kill reads `ps` again first, so a pid recycled since the snapshot is
 * refused, and signals the server's launch root (`launchRoot`): its process group when that group
 * is the server's own, else the root's tree pid by pid (`killGroup`).
 *
 * `killServer` is the kill flow on its own, for the restart to reuse.
 */

import { z } from 'zod'
import { INSTANCE_ID_MAX, type Config } from '../../config/schema.js'
import { tr, type MessageKey } from '../../i18n.js'
import type { CommandContext } from '../../providers/types.js'
import { fremdevEnabled } from '../dev.js'
import { isDockerHolder, isHelper, isSystemProcess, launchRoot, parsePs, selfTree, type ProcInfo } from './list.js'
import type { ServerRow } from './provider.js'
import type { ServersSystem } from './system.js'

/** How long a TERM is given before whatever is left gets KILL. */
export const KILL_GRACE_MS = 3_000
/** The list is read again this long after any command, so the row shows what it did. */
export const COMMAND_REFRESH_MS = 1_000

export type KillTarget = { pgid: number } | { pids: number[] }

/** A process Fremkit may signal: this account's, not Fremkit's tree, not the helper, not the system's, not Docker's. */
function signallable(p: ProcInfo, uid: number, self: Set<number>): boolean {
  return p.uid === uid && !self.has(p.pid) && !isHelper(p) && !isSystemProcess(p) && !isDockerHolder(p)
}

/**
 * What a kill of `root` signals. Its process group, when the group is its own job: another group
 * than its parent's (a shell's job, not an IDE or agent that spawned it without job control), than
 * Fremkit's, and holding nothing of Fremkit's tree, of the system or of another account. Otherwise
 * the root and its descendants, pid by pid, those Fremkit may signal only.
 */
export function killGroup(root: ProcInfo, procs: Map<number, ProcInfo>, self: Set<number>): KillTarget {
  const parent = procs.get(root.ppid)
  const ownGroups = new Set([...self].map((pid) => procs.get(pid)?.pgid).filter((g): g is number => g !== undefined))
  const members = [...procs.values()].filter((p) => p.pgid === root.pgid)
  const ownJob = root.pgid > 1 && parent !== undefined && parent.pgid !== root.pgid && !ownGroups.has(root.pgid)
    && members.every((m) => signallable(m, root.uid, self))
  if (ownJob) return { pgid: root.pgid }

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
  return { pids: tree.filter((pid) => signallable(procs.get(pid)!, root.uid, self)) }
}

export type KillOutcome = { ok: true; settled: Promise<void> } | { ok: false; error: MessageKey }

export interface KillDeps {
  sys: Pick<ServersSystem, 'uid' | 'runPsStats' | 'runPsArgs' | 'kill'>
  selfPid: number
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

/**
 * Kills the server a row names: refused unless `ps` still shows its pid with the row's start time,
 * and unless both it and its launch root are processes Fremkit may signal. TERM now; after
 * `KILL_GRACE_MS`, KILL to whatever is still alive with the same start time (`settled` resolves
 * then). Refused rows send nothing.
 */
export async function killServer(row: Pick<ServerRow, 'id' | 'pid'>, deps: KillDeps): Promise<KillOutcome> {
  const { sys, selfPid } = deps
  const procs = await readProcs(sys, row.pid)
  const p = procs.get(row.pid)
  if (!p || `${p.pid}:${p.start}` !== row.id) return { ok: false, error: 'companion.serversUnknown' }
  const self = selfTree(selfPid, procs)
  if (!signallable(p, sys.uid, self)) return { ok: false, error: 'companion.serversNotAllowed' }
  const root = procs.get(launchRoot(p.pid, procs))!
  if (!signallable(root, sys.uid, self)) return { ok: false, error: 'companion.serversNotAllowed' }

  const target = killGroup(root, procs, self)
  const watched = 'pgid' in target
    ? [...procs.values()].filter((m) => m.pgid === target.pgid)
    : target.pids.map((pid) => procs.get(pid)!)
  const sent = 'pgid' in target
    ? send(sys, -target.pgid, 'SIGTERM')
    : target.pids.map((pid) => send(sys, pid, 'SIGTERM')).some(Boolean)
  if (!sent) return { ok: false, error: 'companion.serversKillFailed' }

  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void escalate(sys, selfPid, target, watched).catch(() => undefined).finally(resolve)
    }, KILL_GRACE_MS)
    timer.unref?.()
  })
  return { ok: true, settled }
}

/** KILL to the processes TERM left alive: the same pid with the same start, nothing else. */
async function escalate(sys: KillDeps['sys'], selfPid: number, target: KillTarget, watched: ProcInfo[]): Promise<void> {
  const now = parsePs(await sys.runPsStats(), '')
  const alive = watched.filter((w) => now.get(w.pid)?.start === w.start)
  if (alive.length === 0) return
  if ('pgid' in target) {
    // The group again, as it is now: still the same job, still nothing we must not touch.
    const self = selfTree(selfPid, now)
    const members = [...now.values()].filter((m) => m.pgid === target.pgid)
    const stillOurs = alive.some((w) => now.get(w.pid)!.pgid === target.pgid) && members.every((m) => signallable(m, sys.uid, self))
    if (stillOurs) {
      send(sys, -target.pgid, 'SIGKILL')
      return
    }
  }
  for (const w of alive) send(sys, w.pid, 'SIGKILL')
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
}

export function createServerCommands(opts: ServerCommandsOptions): Record<string, (payload: unknown, ctx?: CommandContext) => Promise<Result>> {
  const locale = () => opts.config().locale
  const failed = (key: MessageKey): Result => ({ ok: false, error: tr(locale(), key) })

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

  return {
    kill: command(async (row) => {
      if (row.system) return failed('companion.serversNotAllowed')
      let outcome: KillOutcome
      try {
        outcome = await killServer(row, { sys: opts.sys, selfPid: opts.selfPid })
      } catch {
        return failed('companion.serversKillFailed')
      }
      return outcome.ok ? { ok: true } : failed(outcome.error)
    }),
    open: command(async (row) => open([`http://localhost:${row.ports[0]}/`])),
    reveal: command(async (row) => {
      const folder = opts.folderOf(row.id)
      if (folder === null || !folder.startsWith('/')) return failed('companion.serversNoFolder')
      return open(['-R', folder])
    }),
  }
}
