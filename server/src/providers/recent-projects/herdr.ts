import { realpath } from 'node:fs/promises'
import type { Exec } from '../exec.js'

/** The terminal Herdr runs in, brought to the front once a pane is focused: a closed list. */
export const HERDR_TERMINALS = ['auto', 'terminal', 'iterm', 'ghostty'] as const
export type HerdrTerminal = (typeof HERDR_TERMINALS)[number]
export type TerminalApp = Exclude<HerdrTerminal, 'auto'>

/** How far the open went: the pane that was already there, only its tab, or a new pane. */
export type HerdrReach = 'pane' | 'tab' | 'new-pane'

const PS = '/bin/ps'
/** `pane neighbor` questions asked to find a way to a pane: a tab holds a handful of panes. */
const MAX_NEIGHBOR_QUERIES = 32
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const

interface Pane {
  pane_id: string
  tab_id: string
  workspace_id: string
  cwd?: string
  foreground_cwd?: string
}

function resultOf(stdout: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(stdout) as { result?: unknown }
    return data && typeof data.result === 'object' && data.result ? (data.result as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The panes of `herdr pane list` with the ids an open needs; anything malformed is skipped. */
export function parsePanes(stdout: string): Pane[] {
  const panes = resultOf(stdout)?.panes
  if (!Array.isArray(panes)) return []
  return panes.filter((p): p is Pane =>
    !!p && typeof p.pane_id === 'string' && typeof p.tab_id === 'string' && typeof p.workspace_id === 'string')
}

async function canonical(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

/** The first pane whose foreground process or shell sits in `path` (a canonical folder). */
export async function paneAt(panes: Pane[], path: string): Promise<Pane | null> {
  for (const pane of panes) {
    for (const cwd of [pane.foreground_cwd, pane.cwd]) {
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) continue
      if (cwd === path || (await canonical(cwd)) === path) return pane
    }
  }
  return null
}

/**
 * Moves Herdr's focus to `target` inside its (already focused) tab. Herdr focuses a pane only by
 * direction, so the way is found first with `pane neighbor`, which asks the same question
 * `pane focus --direction` answers and moves nothing; the steps are then taken, and the focus is
 * read back. True only when Herdr says the target is focused. A zoomed tab is left alone.
 */
async function walkTo(exec: Exec, bin: string, target: string): Promise<boolean> {
  const layoutOf = async () => resultOf(await exec(bin, ['pane', 'layout', '--pane', target]))?.layout as
    { focused_pane_id?: unknown; zoomed?: unknown; panes?: { pane_id?: unknown }[] } | undefined
  const layout = await layoutOf()
  if (!layout || layout.zoomed === true || typeof layout.focused_pane_id !== 'string') return false
  const start = layout.focused_pane_id
  if (start === target) return true
  const inTab = new Set((layout.panes ?? []).map((p) => p.pane_id).filter((id): id is string => typeof id === 'string'))
  if (!inTab.has(target) || !inTab.has(start)) return false

  const via = new Map<string, { from: string; direction: (typeof DIRECTIONS)[number] }>()
  const queue = [start]
  let queries = 0
  search: while (queue.length) {
    const from = queue.shift()!
    for (const direction of DIRECTIONS) {
      if (++queries > MAX_NEIGHBOR_QUERIES) break search
      const res = resultOf(await exec(bin, ['pane', 'neighbor', '--direction', direction, '--pane', from]))
      const next = (res?.neighbor as { neighbor_pane_id?: unknown } | undefined)?.neighbor_pane_id
      if (typeof next !== 'string' || !inTab.has(next) || next === start || via.has(next)) continue
      via.set(next, { from, direction })
      if (next === target) break search
      queue.push(next)
    }
  }
  if (!via.has(target)) return false
  const steps: { from: string; direction: string }[] = []
  for (let at = target; at !== start; at = via.get(at)!.from) steps.unshift(via.get(at)!)
  for (const step of steps) await exec(bin, ['pane', 'focus', '--direction', step.direction, '--pane', step.from])
  return (await layoutOf())?.focused_pane_id === target
}

/**
 * Opens a folder in Herdr: the pane already sitting in it when there is one (its workspace, its
 * tab, then the pane itself when the way there can be walked), else a new pane split beside the
 * focused one without taking the focus. Every call is Herdr's CLI by its absolute path with an
 * argument list.
 */
export async function openInHerdr(exec: Exec, bin: string, path: string): Promise<HerdrReach> {
  const pane = await paneAt(parsePanes(await exec(bin, ['pane', 'list'])), path)
  if (!pane) {
    await exec(bin, ['pane', 'split', '--cwd', path, '--direction', 'right', '--no-focus'])
    return 'new-pane'
  }
  await exec(bin, ['workspace', 'focus', pane.workspace_id])
  await exec(bin, ['tab', 'focus', pane.tab_id])
  try {
    return (await walkTo(exec, bin, pane.pane_id)) ? 'pane' : 'tab'
  } catch {
    return 'tab'
  }
}

/** The coding agents a project can be opened with: a closed list, and Herdr's own kind names. */
export const AGENTS = ['claude', 'codex'] as const
export type Agent = (typeof AGENTS)[number]

/** How long `agent start` may wait for the agent to be ready, and the CLI call around it. */
const AGENT_START_MS = 30_000

/**
 * Splits a new pane on the folder, focused, and starts a coding agent in it with Herdr's own
 * `agent start`, which launches the agent of that kind and waits until it takes input. Never an
 * existing pane: one already in the folder may be busy. The folder goes only as `--cwd`; the
 * agent's name is generated, never derived from the folder. Herdr's `agent_not_ready` (the agent
 * is up but waiting at a startup question, such as trusting the folder) is still a started agent.
 */
export async function startAgentInHerdr(exec: Exec, bin: string, path: string, agent: Agent, now: number = Date.now()): Promise<'started' | 'waiting'> {
  const split = resultOf(await exec(bin, ['pane', 'split', '--cwd', path, '--direction', 'right', '--focus']))
  const paneId = (split?.pane as { pane_id?: unknown } | undefined)?.pane_id
  if (typeof paneId !== 'string' || !/^[\w:-]{1,64}$/.test(paneId)) throw new Error('no-pane')
  const name = `fremkit-${agent}-${now.toString(36)}`
  try {
    await exec(bin, ['agent', 'start', name, '--kind', agent, '--pane', paneId, '--timeout', String(AGENT_START_MS)], { timeoutMs: AGENT_START_MS + 5000 })
    return 'started'
  } catch (err) {
    if (/agent_not_ready/.test((err as Error).message)) return 'waiting'
    throw err
  }
}

/** The terminal application a process path belongs to, from its bundle in the path. */
function terminalOf(command: string): TerminalApp | null {
  if (command.includes('/iTerm.app/') || command.includes('/iTerm2/iTermServer')) return 'iterm'
  if (command.includes('/Terminal.app/')) return 'terminal'
  if (command.includes('/Ghostty.app/')) return 'ghostty'
  return null
}

/**
 * The terminal Herdr's client runs in, found by walking each `herdr` process's parents in one
 * `ps` listing up to a terminal's bundle. Null when none is found or when Herdr runs in two
 * different terminals: guessing would bring the wrong one forward.
 */
export async function detectHerdrTerminal(exec: Exec): Promise<TerminalApp | null> {
  const parent = new Map<number, number>()
  const command = new Map<number, string>()
  for (const line of (await exec(PS, ['-axo', 'pid=,ppid=,comm='])).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    parent.set(Number(m[1]), Number(m[2]))
    command.set(Number(m[1]), m[3].trim())
  }
  const found = new Set<TerminalApp>()
  for (const [pid, cmd] of command) {
    if (cmd !== 'herdr' && !cmd.endsWith('/herdr')) continue
    let at: number | undefined = parent.get(pid)
    for (let hops = 0; at && at > 1 && hops < 20; hops++, at = parent.get(at)) {
      const app = terminalOf(command.get(at) ?? '')
      if (app) {
        found.add(app)
        break
      }
    }
  }
  return found.size === 1 ? [...found][0] : null
}
