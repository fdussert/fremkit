import { spawn } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { applyBudget, pruneTree, validateTree, type DiskNode, type DiskPolicy } from './disk-map-tree.js'

/**
 * The two ways the disk map measures a folder, behind one interface.
 *
 * `fremkit-scan` (native/Sources/FremkitScan) is the real one: getattrlistbulk, throttled I/O,
 * one JSON line per finished folder. The helper names it in `FREMKIT_SCANNER` when it spawns the
 * server. Without the helper — `pnpm dev`, a second checkout on another port — `/usr/bin/du`
 * stands in: slower, no individual files, same tree shape and the same "unreadable" state.
 *
 * Both are run by absolute path with an argument list and no shell. `spawn` rather than
 * `execFile` because the output is read as it arrives (it is the progress), but the rule is the
 * same: nothing a widget sends ever becomes an argument, only a path the server resolved itself.
 */

export interface ScanProgress {
  directories: number
  files: number
  /** Where the walk is, the first one or two levels below the scanned folder. */
  path: string[]
  /**
   * A folder whose opening macOS is holding, below the scanned folder ([] for that folder itself):
   * it is asking the user for access in a privacy prompt. null when nothing is held. Only the
   * native scanner ever sets it.
   */
  waiting: string[] | null
}

export interface ScanStats {
  directories: number
  files: number
  unreadable: number
  ms: number
}

export interface ScanOutcome {
  tree: DiskNode
  stats: ScanStats
}

/** Why a scan produced no tree. `cancelled` is not a failure: someone asked. */
export type ScanFailure = 'cancelled' | 'missing' | 'unreadable' | 'failed'

export class ScanError extends Error {
  constructor(readonly code: ScanFailure) { super(code) }
}

export interface ScanHandle {
  result: Promise<ScanOutcome>
  cancel(): void
}

export interface DiskScanner {
  kind: 'native' | 'du'
  start(path: string, policy: DiskPolicy, onProgress: (p: ScanProgress) => void): ScanHandle
}

/** A finished line of output can be the whole tree; anything beyond this is not ours. */
const MAX_LINE = 64 * 1024 * 1024
const KILL_AFTER_MS = 3000
/** How a du message starts, BSD's `du: ` or GNU's `/usr/bin/du: `. */
const DU_PREFIX = /^(?:\/\S*\/)?du: /

type Spawn = typeof spawn

/** Runs a program, hands each stdout and stderr line over, and resolves with its exit status. */
function runLines(
  file: string, args: string[], onLine: (line: string) => void, onErrLine: (line: string) => void, spawnImpl: Spawn,
): { exited: Promise<number | null>; kill: () => void } {
  const child = spawnImpl(file, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  let killTimer: NodeJS.Timeout | undefined
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => { if (killTimer) clearTimeout(killTimer); resolve(code) })
  })
  const out = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  out.on('line', (line) => { if (line.length <= MAX_LINE) onLine(line) })
  const err = createInterface({ input: child.stderr!, crlfDelay: Infinity })
  err.on('line', (line) => { if (line.length <= 64 * 1024) onErrLine(line) })
  return {
    exited,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, KILL_AFTER_MS)
      killTimer.unref()
    },
  }
}

/**
 * The scanner the helper named, if it is there: an absolute path to an executable regular file.
 * Anything else — unset, relative, missing, not executable — means the `du` fallback.
 */
export async function resolveScannerBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const path = env.FREMKIT_SCANNER
  if (!path || !isAbsolute(path)) return null
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    await access(path, constants.X_OK)
    return path
  } catch {
    return null
  }
}

/** `{"type":"waiting","path":[…] | null}`: bounded, since it is published to the widget as is. */
const WaitingLine = z.object({
  type: z.literal('waiting'),
  path: z.array(z.string().max(1024)).max(256).nullable(),
})

/** Parses the scanner's JSON lines; exported for the tests. */
export function nativeLineHandler(onProgress: (p: ScanProgress) => void): {
  line(text: string): void
  outcome(): ScanOutcome | ScanFailure | null
} {
  let done: ScanOutcome | null = null
  let failure: ScanFailure | null = null
  let last: ScanProgress = { directories: 0, files: 0, path: [], waiting: null }
  const report = (next: ScanProgress) => { last = next; onProgress(next) }
  return {
    line(text) {
      let message: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null) return
        message = parsed as Record<string, unknown>
      } catch {
        return
      }
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 2) : [])
      const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
      switch (message.type) {
        case 'progress':
          report({ directories: count(message.directories), files: count(message.files), path: strings(message.path), waiting: last.waiting })
          break
        case 'waiting': {
          const parsed = WaitingLine.safeParse(message)
          if (parsed.success) report({ ...last, waiting: parsed.data.path })
          break
        }
        case 'cancelled':
          failure = 'cancelled'
          break
        case 'error':
          failure = message.code === 'missing' || message.code === 'not-a-directory' ? 'missing'
            : message.code === 'unreadable' ? 'unreadable' : 'failed'
          break
        case 'done': {
          try {
            const tree = validateTree(message.tree)
            const s = (message.stats ?? {}) as Record<string, unknown>
            done = { tree, stats: { directories: count(s.directories), files: count(s.files), unreadable: count(s.unreadable), ms: count(s.ms) } }
          } catch {
            failure = 'failed'
          }
          break
        }
      }
    },
    outcome: () => done ?? failure,
  }
}

export function createNativeScanner(binary: string, spawnImpl: Spawn = spawn): DiskScanner {
  return {
    kind: 'native',
    start(path, policy, onProgress) {
      const handler = nativeLineHandler(onProgress)
      let cancelled = false
      const args = [
        '--depth', String(policy.depth), '--min-bytes', String(Math.floor(policy.minBytes)),
        '--max-children', String(policy.maxChildren), '--budget', String(policy.budget),
        '--progress-depth', '1', '--', path,
      ]
      const run = runLines(binary, args, (l) => handler.line(l), () => {}, spawnImpl)
      const result = run.exited.then(
        () => {
          const outcome = handler.outcome()
          if (cancelled) throw new ScanError('cancelled')
          if (outcome === null) throw new ScanError('failed')
          if (typeof outcome === 'string') throw new ScanError(outcome)
          return outcome
        },
        () => { throw new ScanError(cancelled ? 'cancelled' : 'failed') },
      )
      return { result, cancel: () => { cancelled = true; run.kill() } }
    },
  }
}

/** `du -k -x -d N` output, turned into the scanner's tree. Exported for the tests. */
export class DuParser {
  private readonly root: DiskNode
  private readonly prefix: string
  private lines = 0
  unreadable = 0
  /** du could not read the folder it was asked about. */
  rootUnreadable = false

  /** Children by name, so a folder with 50 000 subfolders is not a quadratic walk. */
  private readonly index = new WeakMap<DiskNode, Map<string, DiskNode>>()

  /**
   * `minBytes` lets the parser drop small folders as soon as their parent is printed (du prints
   * a folder after everything in it), so what it holds follows the policy, not the disk.
   */
  constructor(private readonly path: string, rootName: string, private readonly minBytes = 0) {
    this.root = { name: rootName, kind: 'd', size: 0 }
    this.prefix = path.endsWith('/') ? path : `${path}/`
  }

  get directories(): number { return this.lines }

  private segments(p: string): string[] | null {
    if (p === this.path || p === this.prefix) return []
    if (!p.startsWith(this.prefix)) return null
    const rest = p.slice(this.prefix.length)
    const segments = rest.split('/')
    return segments.every((s) => s.length > 0 && s !== '.' && s !== '..') ? segments : null
  }

  private nodeAt(segments: string[]): DiskNode {
    let node = this.root
    for (const segment of segments) {
      let byName = this.index.get(node)
      if (!byName) { byName = new Map(); this.index.set(node, byName) }
      let next = byName.get(segment)
      if (!next) {
        next = { name: segment, kind: 'd', size: 0 }
        byName.set(segment, next)
        ;(node.children ??= []).push(next)
      }
      node = next
    }
    return node
  }

  /** A folder is complete: its subfolders under `minBytes` go into its "others" now. */
  private compact(node: DiskNode): void {
    if (!this.minBytes || !node.children) return
    const byName = this.index.get(node)
    const kept: DiskNode[] = []
    let count = 0
    let size = 0
    for (const child of node.children) {
      if (child.size >= this.minBytes || child.kind === 'x' || (child.unreadable ?? 0) > 0) { kept.push(child); continue }
      count++
      size += child.size
      byName?.delete(child.name)
    }
    if (count) {
      const [c, s] = node.others ?? [0, 0]
      node.others = [c + count, s + size]
    }
    if (kept.length) node.children = kept
    else delete node.children
  }

  /**
   * du ends each entry with a newline and has no other separator, so a folder whose name holds
   * one arrives as two lines: the second does not start with a size. Each line is held until the
   * next one says whether it was whole; `flush()` hands over the last. A refusal is applied as
   * soon as it reads as one, and only a message that does not yet is held for its next half.
   */
  private pendingOut: string | null = null
  private pendingErr: string | null = null

  /**
   * One stdout line: `<kilobytes>\t<path>`. Returns the path below the root of the entry this
   * line completes — the one before it — or null.
   */
  line(text: string): string[] | null {
    if (this.pendingOut !== null && !/^\d+\t/.test(text)) { this.pendingOut += `\n${text}`; return null }
    const whole = this.pendingOut
    this.pendingOut = text
    return whole === null ? null : this.entry(whole)
  }

  /** The entry held back by `line()`, once du has exited. */
  flush(): void {
    if (this.pendingOut !== null) { const o = this.pendingOut; this.pendingOut = null; this.entry(o) }
  }

  private entry(text: string): string[] | null {
    const tab = text.indexOf('\t')
    if (tab <= 0) return null
    const kb = Number(text.slice(0, tab))
    if (!Number.isFinite(kb) || kb < 0) return null
    const segments = this.segments(text.slice(tab + 1))
    if (!segments) return null
    this.lines++
    const node = this.nodeAt(segments)
    node.size = kb * 1024
    this.compact(node)
    return segments
  }

  /**
   * One stderr line. `du: <path>: Permission denied` or `Operation not permitted` is a folder that
   * could not be read: it becomes an unreadable node, never a small one. Anything else (a dataless
   * iCloud folder answers "Resource deadlock avoided") is not a permission problem and is ignored.
   * GNU du, which the CI runs on, names itself as it was run and words it differently:
   * `/usr/bin/du: cannot read directory '<path>': Permission denied`.
   */
  errorLine(text: string): void {
    const joined = this.pendingErr !== null && !DU_PREFIX.test(text) ? `${this.pendingErr}\n${text}` : text
    this.pendingErr = null
    if (this.refusal(joined)) return
    // Not a refusal, or not yet: the first half of one whose path holds a newline.
    if (DU_PREFIX.test(joined) && joined.length <= 64 * 1024) this.pendingErr = joined
  }

  private refusal(text: string): boolean {
    const match = /^(?:\/\S*\/)?du: (.+): (?:Permission denied|Operation not permitted)$/s.exec(text)
    if (!match) return false
    const gnu = /^cannot (?:read directory|access) '(.+)'$/s.exec(match[1])
    const segments = this.segments(gnu ? gnu[1] : match[1])
    if (!segments) return true
    if (segments.length === 0) { this.rootUnreadable = true; return true }
    this.unreadable++
    const node = this.nodeAt(segments)
    node.kind = 'x'
    node.unreadable = 1
    let ancestor = this.root
    ancestor.unreadable = (ancestor.unreadable ?? 0) + 1
    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor.children!.find((c) => c.name === segment)!
      ancestor.unreadable = (ancestor.unreadable ?? 0) + 1
    }
    return true
  }

  /** The finished tree: what each folder holds besides its subfolders goes into its "others". */
  finish(policy: DiskPolicy, maxDepth: number): DiskNode {
    this.flush()
    const settle = (node: DiskNode, depth: number): void => {
      const children = node.children ?? []
      for (const child of children) settle(child, depth + 1)
      if (node.kind === 'x') return
      const [count, folded] = node.others ?? [0, 0]
      const held = children.reduce((sum, c) => sum + c.size, 0) + folded
      const rest = Math.max(0, node.size - held)
      if (rest > 0 || count > 0) node.others = [count, folded + rest]
      // At du's depth limit the subfolders were not listed: say so, so a drill rescans.
      if (depth >= maxDepth && node.size >= policy.minBytes) node.more = true
    }
    settle(this.root, 0)
    pruneTree(this.root, policy)
    applyBudget(this.root, policy.budget)
    return this.root
  }
}

/** How deep `du` lists: its output grows with every level, its cost does not. */
export const DU_MAX_DEPTH = 5

export function createDuScanner(spawnImpl: Spawn = spawn, du = '/usr/bin/du'): DiskScanner {
  return {
    kind: 'du',
    start(path, policy, onProgress) {
      const depth = Math.min(policy.depth, DU_MAX_DEPTH)
      const parser = new DuParser(path, path.split('/').filter(Boolean).pop() ?? '/', policy.minBytes)
      const started = Date.now()
      let cancelled = false
      let lastProgress = 0
      const run = runLines(du, ['-k', '-x', '-d', String(depth), path], (line) => {
        const segments = parser.line(line)
        const now = Date.now()
        if (segments && now - lastProgress >= 250) {
          lastProgress = now
          onProgress({ directories: parser.directories, files: 0, path: segments.slice(0, 2), waiting: null })
        }
      }, (line) => parser.errorLine(line), spawnImpl)
      const result = run.exited.then(
        (code) => {
          if (cancelled) throw new ScanError('cancelled')
          parser.flush()
          // du exits 1 when it met errors along the way and still printed its totals.
          if (code !== 0 && code !== 1) throw new ScanError('failed')
          if (parser.rootUnreadable) throw new ScanError('unreadable')
          if (parser.directories === 0) throw new ScanError(parser.unreadable > 0 ? 'unreadable' : 'missing')
          const tree = parser.finish(policy, depth)
          return { tree, stats: { directories: parser.directories, files: 0, unreadable: parser.unreadable, ms: Date.now() - started } }
        },
        () => { throw new ScanError(cancelled ? 'cancelled' : 'failed') },
      )
      return { result, cancel: () => { cancelled = true; run.kill() } }
    },
  }
}
