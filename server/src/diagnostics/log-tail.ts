import { fstatSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The recent lines of the server's log, for a diagnostics report.
 *
 * Under the helper, the server's stdout and stderr both go to `~/Library/Logs/Fremkit/server.log`
 * (`ServerProcess.openLog` in the helper), which also holds the previous runs — and the crash a
 * bug report is usually about is in a previous run. So that file is read when it is *this
 * process's* stdout, which is checked by inode rather than assumed: a `pnpm dev` or a second
 * checkout writes to a terminal, and the file then belongs to some other server.
 *
 * Otherwise the lines come from a ring buffer of what this process itself wrote since it
 * started. The buffer holds raw lines; nothing leaves it except through `redact()` in the report.
 */

/** Lines kept in memory: enough for the 200 a report shows once request pairs are folded. */
const RING_CAPACITY = 1000
/** How far from the end of the log file a report reads; well over 200 lines of pino JSON. */
const FILE_TAIL_BYTES = 256 * 1024
/** A line longer than this is cut: a report is pasted into a form, not archived. */
export const MAX_LINE_LENGTH = 600

export class LineRing {
  private lines: string[] = []
  private partial = ''

  constructor(private readonly capacity = RING_CAPACITY) {}

  /** Adds a chunk as written to a stream: may hold several lines, or end mid-line. */
  write(chunk: string): void {
    const text = this.partial + chunk
    const parts = text.split('\n')
    this.partial = parts.pop() ?? ''
    // A partial line that never ends must not grow without bound.
    if (this.partial.length > MAX_LINE_LENGTH * 4) {
      parts.push(this.partial)
      this.partial = ''
    }
    for (const line of parts) {
      if (line.length === 0) continue
      this.lines.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line)
    }
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity)
  }

  tail(count: number): string[] {
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-count)
  }
}

/** Where the helper writes the server's log; `FREMKIT_SUPPORT_DIR` moves it, as `HelperPaths` does. */
export function helperLogPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.FREMKIT_SUPPORT_DIR
  if (override && override.startsWith('/')) return join(override, 'Logs', 'server.log')
  return join(home, 'Library', 'Logs', 'Fremkit', 'server.log')
}

/** Whether descriptor 1 is the file at `path`. False on any doubt. */
export function stdoutIsFile(path: string): boolean {
  try {
    const out = fstatSync(1)
    if (!out.isFile()) return false
    const file = statSync(path)
    return out.ino === file.ino && out.dev === file.dev
  } catch {
    return false
  }
}

/** The last `count` lines of a text file, read from its end. */
export async function readFileTail(path: string, count: number, maxBytes = FILE_TAIL_BYTES): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let lines = buffer.toString('utf8').split('\n')
    // Started mid-file: the first line is a fragment.
    if (length < size) lines = lines.slice(1)
    return lines
      .filter((line) => line.length > 0)
      .slice(-count)
      .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line))
  } finally {
    await handle.close()
  }
}

export interface LogSource {
  /** Where the lines came from, said in the report. */
  kind: 'file' | 'memory'
  lines: string[]
}

/**
 * Captures what this process writes to stdout and stderr, and answers the recent lines.
 *
 * Installed once, by `index.ts`, so the tests (which build many apps in one process) never
 * patch the streams. An app built without one reports no log at all.
 */
export class LogTail {
  readonly ring = new LineRing()

  constructor(private readonly filePath: string | null = null) {}

  /** Wraps `process.stdout.write` and `process.stderr.write`; the original still runs. */
  install(streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
    for (const stream of streams) {
      const original = stream.write.bind(stream) as (...args: unknown[]) => boolean
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        try {
          this.ring.write(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
        } catch {
          // Never let the copy break the write it is copying.
        }
        return original(chunk, ...rest)
      }) as typeof stream.write
    }
  }

  async recent(count: number): Promise<LogSource> {
    if (this.filePath && stdoutIsFile(this.filePath)) {
      try {
        return { kind: 'file', lines: await readFileTail(this.filePath, count) }
      } catch {
        // Fall through to what this process saw itself.
      }
    }
    return { kind: 'memory', lines: this.ring.tail(count) }
  }
}
