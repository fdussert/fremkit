import { execFile } from 'node:child_process'

/** An open Claude Code CLI process discovered on the host, independent of any hook event. */
export interface ClaudeProcess { pid: number; cwd: string; startedAt: number }
export type Runner = (cmd: string, args: string[]) => Promise<string>

const run: Runner = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    // lsof exits 1 (but still prints the rest) when one of the requested pids
    // has already vanished between listing it and querying it; treat that as success.
    if (err && ((err as { code?: number }).code === 1 && stdout)) return resolve(stdout)
    if (err) return reject(err)
    resolve(stdout)
  }))

const LSTART = /^(\w{3}) +(\d{1,2}) (\w{3}) (\d\d:\d\d:\d\d) (\d{4})/
const CLAUDE_CMD = /^(?:\S*\/)?claude(?:\s|$)/

/** Parses `ps -axo pid=,lstart=,command=`; keeps Claude Code CLI processes only. */
export function parsePs(out: string): { pid: number; startedAt: number }[] {
  const res: { pid: number; startedAt: number }[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[3].trim()
    if (!CLAUDE_CMD.test(cmd) || cmd.includes('--chrome-native-host')) continue
    const d = LSTART.exec(m[2].trim())
    const startedAt = d ? Date.parse(`${d[3]} ${d[2]}, ${d[5]} ${d[4]}`) : NaN
    res.push({ pid: Number(m[1]), startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() })
  }
  return res
}

/** Parses `lsof -a -d cwd -p … -Fpn` output into pid → cwd. */
export function parseLsof(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1))
  }
  return map
}

/** Lists open Claude Code sessions as processes. Returns null when discovery itself failed. */
export async function listClaudeProcesses(runner: Runner = run): Promise<ClaudeProcess[] | null> {
  try {
    const procs = parsePs(await runner('ps', ['-axo', 'pid=,lstart=,command=']))
    if (!procs.length) return []
    const cwds = parseLsof(await runner('lsof', ['-a', '-d', 'cwd', '-p', procs.map((p) => p.pid).join(','), '-Fpn']))
    return procs.flatMap((p) => { const cwd = cwds.get(p.pid); return cwd ? [{ pid: p.pid, cwd, startedAt: p.startedAt }] : [] })
  } catch { return null }
}
