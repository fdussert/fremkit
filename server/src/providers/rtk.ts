import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { localEnv } from './local-operations.js'
import type { Provider } from './types.js'

/**
 * The `rtk` channel: the token savings reported by RTK (https://github.com/rtk-ai/rtk), a CLI
 * proxy that compacts command output for coding agents. RTK keeps its own history and prints it
 * with `rtk gain --daily --format json`; this provider only reads that summary. It takes no
 * command and passes nothing a client sends to the program.
 */

export const RTK_POLL_MS = 60_000
export const RTK_RETRY_MS = 15_000
/** How many days of history the snapshot carries, most recent last. */
export const RTK_DAYS = 30

const count = z.number().nonnegative().finite()
const Summary = z.object({
  total_commands: count, total_input: count, total_output: count, total_saved: count,
  avg_savings_pct: count, avg_time_ms: count,
})
const Day = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  commands: count, input_tokens: count, output_tokens: count, saved_tokens: count, savings_pct: count,
})
const Gain = z.object({ summary: Summary, daily: z.array(Day).max(100_000).optional() })

export interface RtkDay { date: string; commands: number; input: number; output: number; saved: number; percent: number }
export interface RtkData {
  total: { commands: number; input: number; output: number; saved: number; percent: number; avgTimeMs: number }
  /** The entry for the local calendar day, or zeros when RTK has not run today. */
  today: RtkDay
  /** At most `RTK_DAYS` days, oldest first. Days RTK did not run are absent, not zero. */
  daily: RtkDay[]
}
export interface RtkSnapshot {
  data: RtkData | null
  /** True when `data` is the last good answer and the latest poll failed. */
  stale: boolean
  error: 'unavailable' | 'offline' | 'invalid' | null
  updatedAt: number | null
}

/** `YYYY-MM-DD` of the local calendar day, the date RTK files its daily rows under. */
export const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** Validates `rtk gain --daily --format json` and keeps only what a widget shows. */
export function parseGain(raw: string, now: Date = new Date()): RtkData {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new SyntaxError('too large')
  const gain = Gain.parse(JSON.parse(raw))
  const days = (gain.daily ?? []).map((d): RtkDay => ({
    date: d.date, commands: d.commands, input: d.input_tokens, output: d.output_tokens,
    saved: d.saved_tokens, percent: d.savings_pct,
  })).sort((a, b) => a.date.localeCompare(b.date))
  const date = localDate(now)
  const s = gain.summary
  return {
    total: {
      commands: s.total_commands, input: s.total_input, output: s.total_output, saved: s.total_saved,
      percent: s.avg_savings_pct, avgTimeMs: s.avg_time_ms,
    },
    today: days.find((d) => d.date === date) ?? { date, commands: 0, input: 0, output: 0, saved: 0, percent: 0 },
    daily: days.slice(-RTK_DAYS),
  }
}

/** Resolves RTK from a closed list of install locations, without a PATH lookup. */
export async function resolveRtkBinary(canExecute: (path: string) => Promise<void> = (path) => access(path, constants.X_OK)): Promise<string> {
  for (const path of ['/opt/homebrew/bin/rtk', '/usr/local/bin/rtk', join(homedir(), '.cargo/bin/rtk'), join(homedir(), '.local/bin/rtk')]) {
    try { await canExecute(path); return path } catch { /* Try the next known install. */ }
  }
  throw new Error('unavailable')
}

const rtkRun = async (args: string[]): Promise<string> => {
  const binary = await resolveRtkBinary()
  return new Promise((resolve, reject) => execFile(binary, args, {
    env: localEnv(process.env), timeout: 10_000, maxBuffer: 8 * 1024 * 1024, shell: false,
  }, (error, stdout) => error ? reject(new Error('offline')) : resolve(stdout)))
}

export function createRtkProvider(opts: { run?: (args: string[]) => Promise<string>; now?: () => Date } = {}): Provider<RtkSnapshot> {
  const run = opts.run ?? rtkRun
  const now = opts.now ?? (() => new Date())
  let last: RtkSnapshot = { data: null, stale: false, error: null, updatedAt: null }
  return {
    channel: 'rtk',
    get intervalMs() { return last.error ? RTK_RETRY_MS : RTK_POLL_MS },
    async poll() {
      try {
        const data = parseGain(await run(['gain', '--daily', '--format', 'json']), now())
        last = { data, stale: false, error: null, updatedAt: Date.now() }
      } catch (error) {
        const reason = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid'
          : error instanceof Error && error.message === 'unavailable' ? 'unavailable' : 'offline'
        last = { ...last, stale: last.data !== null, error: reason }
      }
      return last
    },
  }
}
