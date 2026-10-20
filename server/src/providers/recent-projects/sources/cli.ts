import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../../exec.js'
import type { Source, SourceEntry } from '../types.js'
import { isExecutableFile } from '../util.js'

/**
 * Where a command-line tool is looked for, by absolute path and never through `PATH`: Homebrew on
 * Apple silicon and Intel, cargo, and `~/.local/bin` (where installers like Herdr's put it).
 */
export function binaryCandidates(name: string, home: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.cargo', 'bin'), join(home, '.local', 'bin')].map((d) => join(d, name))
}

export type ResolveBinary = (name: 'zoxide' | 'tmux' | 'herdr') => Promise<string | null>

export const resolveBinary: ResolveBinary = async (name) => {
  for (const candidate of binaryCandidates(name, homedir())) {
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

/** `zoxide query --list --score`: `  12.5 /path` per line, best first. zoxide keeps no date. */
export function parseZoxide(stdout: string): SourceEntry[] {
  const out: SourceEntry[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*[\d.]+\s+(\/.*)$/.exec(line)
    if (m) out.push({ path: m[1], seenAt: null })
  }
  return out.slice(0, 50)
}

/** `tmux list-panes -a -F '#{pane_current_path}\t#{window_activity}'`, activity in seconds. */
export function parseTmux(stdout: string): SourceEntry[] {
  const out: SourceEntry[] = []
  for (const line of stdout.split('\n')) {
    const [path, activity] = line.split('\t')
    if (!path?.startsWith('/')) continue
    const seconds = Number(activity)
    out.push({ path, seenAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null })
  }
  return out
}

/**
 * `herdr pane list`: a JSON envelope `{ result: { panes: [...] } }`. Each pane's folder is its
 * foreground process's (`foreground_cwd`), else the shell's (`cwd`). Nothing else of a pane —
 * its title, its scrollback — is read.
 */
export function parseHerdrPanes(stdout: string, now: number): SourceEntry[] {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return []
  }
  const root = data as { result?: { panes?: unknown }; panes?: unknown }
  const panes = root.result?.panes ?? root.panes
  if (!Array.isArray(panes)) return []
  const out: SourceEntry[] = []
  for (const pane of panes) {
    const p = pane as { cwd?: unknown; foreground_cwd?: unknown }
    const path = typeof p.foreground_cwd === 'string' && p.foreground_cwd ? p.foreground_cwd : p.cwd
    if (typeof path === 'string' && path.startsWith('/')) out.push({ path, seenAt: now })
  }
  return out
}

/** A source backed by one command-line tool: unavailable, not failing, when it is not installed. */
function cliSource(
  id: 'zoxide' | 'tmux' | 'herdr',
  label: { fr: string; en: string },
  args: string[],
  parse: (stdout: string) => SourceEntry[],
  exec: Exec,
  resolve: ResolveBinary,
  opts: { live?: boolean; emptyWhen?: RegExp } = {},
): Source {
  return {
    id,
    label,
    live: opts.live,
    available: async () => (await resolve(id)) !== null,
    async list() {
      const bin = await resolve(id)
      if (!bin) return []
      try {
        return parse(await exec(bin, args))
      } catch (err) {
        // tmux with no server running is an empty list, not a failure.
        if (opts.emptyWhen && opts.emptyWhen.test((err as Error).message)) return []
        throw err
      }
    },
  }
}

export function createCliSources(exec: Exec, resolve: ResolveBinary = resolveBinary, now: () => number = Date.now): Source[] {
  return [
    cliSource('zoxide', { fr: 'zoxide', en: 'zoxide' }, ['query', '--list', '--score'], parseZoxide, exec, resolve),
    cliSource('tmux', { fr: 'tmux', en: 'tmux' }, ['list-panes', '-a', '-F', '#{pane_current_path}\t#{window_activity}'], parseTmux, exec, resolve,
      { live: true, emptyWhen: /no server running|error connecting/i }),
    cliSource('herdr', { fr: 'Herdr', en: 'Herdr' }, ['pane', 'list'], (s) => parseHerdrPanes(s, now()), exec, resolve, { live: true }),
  ]
}
