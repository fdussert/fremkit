import { basename, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { z } from 'zod'
import { summarizeTool } from './tool-summary.js'
import type { AttentionEvent } from './attention.js'
import type { ClaudeProcess } from './processes.js'

export type ClaudeState = 'idle' | 'working' | 'permission' | 'done' | 'error'

/**
 * Where a session lives, as its own hook read it out of its environment.
 *
 * Held server-side and never published: it is how `focus` finds the window again, and it carries
 * a pane key, a tty and an application id — the kind of thing that is of no use on a dashboard
 * and of some use to anything that can read one. The snapshot carries {@link ClientView} instead.
 */
export interface SessionClient {
  bundleId?: string
  program?: string
  pid?: number
  tty?: string
  terminalSession?: string
  orca?: { pane?: string; tab?: string; terminal?: string }
}

/** The client kinds `focus` knows how to act on. Anything else is `other`. */
export type ClientKind = 'orca' | 'terminal' | 'iterm' | 'vscode' | 'other'

/** All a card needs: which kind of window, and what to call it. */
export interface ClientView { kind: ClientKind; label: string }

/**
 * Bundle ids and `TERM_PROGRAM` values that name a kind, and the label that goes on the card.
 *
 * A closed table on purpose: the label is written here rather than taken from the environment,
 * so a session cannot choose what a card says about it by exporting a variable.
 */
const CLIENTS: { kind: ClientKind; label: string; bundleIds: string[]; programs: string[] }[] = [
  { kind: 'orca', label: 'Orca', bundleIds: ['com.stablyai.orca'], programs: ['orca'] },
  { kind: 'terminal', label: 'Terminal', bundleIds: ['com.apple.terminal'], programs: ['apple_terminal'] },
  { kind: 'iterm', label: 'iTerm2', bundleIds: ['com.googlecode.iterm2'], programs: ['iterm.app'] },
  { kind: 'vscode', label: 'VS Code', bundleIds: ['com.microsoft.vscode', 'com.visualstudio.code.oss'], programs: ['vscode'] },
]
/** A label made from an unknown client's own words is cut short: it is on a card, not in a log. */
const LABEL_MAX = 24

/**
 * The card's view of a client: a known kind with its own name, or `other` with whatever it
 * calls itself.
 *
 * `undefined` for a session whose hook predates this, or one discovered from a process — and the
 * card simply says nothing, which is what it did before.
 */
export function clientView(client: SessionClient | undefined): ClientView | undefined {
  if (!client) return undefined
  const bundleId = client.bundleId?.toLowerCase()
  const program = client.program?.toLowerCase()
  const known = CLIENTS.find((c) => (bundleId && c.bundleIds.includes(bundleId)) || (program && c.programs.includes(program)))
  if (known) return { kind: known.kind, label: known.label }
  const own = client.program || client.bundleId?.split('.').pop()
  if (!own) return undefined
  return { kind: 'other', label: own.slice(0, LABEL_MAX) }
}

/** A session as the dashboard sees it: the raw client replaced by what a card may know. */
export type PublicClaudeSession = Omit<ClaudeSession, 'client'> & { client?: ClientView }

export interface ClaudeSession {
  sessionId: string
  project: string
  cwd: string
  model?: string
  /** Model id from the statusline (e.g. `claude-opus-5`), in addition to the display name in `model`. */
  modelId?: string
  /** Session name from the statusline, truncated to TITLE_MAX chars. No title is inferred from the prompt. */
  title?: string
  /** Git branch forwarded by the statusline script as `fremkit_branch`. */
  branch?: string
  state: ClaudeState
  since: number
  lastEventAt: number
  tool?: string
  toolDetail?: string
  lastMessage?: string
  error?: string
  subagents: number
  /** Ids of the subagents currently running; `subagents` is its size. */
  agentIds?: string[]
  context?: { used: number; size: number; pct: number }
  costUsd?: number
  permissionMode?: string
  /** Pending AskUserQuestion, read-only on the card; cleared on the matching PostToolUse, the next prompt, or Stop. */
  question?: { header?: string; text: string; options: string[] }
  /** Pid of the process backing this session, once matched by syncProcesses(). */
  pid?: number
  /** Where the session lives. Server-side only — `snapshot()` replaces it with a {@link ClientView}. */
  client?: SessionClient
  /** True for a placeholder created from a running process with no hook event yet. */
  discovered?: boolean
}

/**
 * Most sessions held at once.
 *
 * A Mac runs a handful of Claude Code sessions; the widget shows the most recent few. The cap is
 * what stops a hook caller — the endpoint takes any session id — from filling the map.
 */
export const MAX_SESSIONS = 200

export interface HookEvent {
  hook_event_name?: string
  session_id?: string
  /** SubagentStart / SubagentStop: the subagent's own id (the session id stays the parent's). */
  agent_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: unknown
  notification_type?: string
  message?: string
  last_assistant_message?: string
  error?: unknown
  model?: { id?: string; display_name?: string } | string
  /** Session name set by the user or the client, forwarded by the statusline script. */
  session_name?: string
  /** Git branch of the session's cwd, forwarded by the statusline script. */
  fremkit_branch?: string
  workspace?: { current_dir?: string; project_dir?: string }
  cost?: { total_cost_usd?: number }
  context_window?: { context_window_size?: number; used_percentage?: number; current_usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }
  permission_mode?: string
  /** Rate-limit windows, forwarded by the statusline script and read by ClaudeUsage. */
  rate_limits?: unknown
  /** Where the session lives, added by `scripts/claude-hook.sh` from its own environment. */
  client?: SessionClient
}

const MESSAGE_MAX = 200
const TITLE_MAX = 80
// Substring heuristic, not a real shell parse: `git -C x commit` is missed, `rg "git commit"` is counted.
const GIT_COMMIT_RE = /\bgit\s+commit\b/
const QUESTION_MAX = 200
const OPTION_MAX = 60
const OPTIONS_MAX = 4
/** Events the switch below handles. Anything else must not bring a session into existence. */
const KNOWN_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'StatusLine', 'SessionEnd',
])
const STATE_ORDER: Record<ClaudeState, number> = { permission: 0, working: 1, error: 2, done: 3, idle: 4 }
/** A restart must not lose an in-progress session: keep it around long enough to survive one. */
const DEFAULT_TTL_MS = 4 * 60 * 60_000
const PERSIST_MS = 5_000

const claudeSessionSchema = z.object({
  sessionId: z.string(),
  project: z.string(),
  cwd: z.string(),
  model: z.string().optional(),
  modelId: z.string().optional(),
  title: z.string().optional(),
  branch: z.string().optional(),
  state: z.enum(['idle', 'working', 'permission', 'done', 'error']),
  since: z.number(),
  lastEventAt: z.number(),
  tool: z.string().optional(),
  toolDetail: z.string().optional(),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
  subagents: z.number(),
  agentIds: z.array(z.string()).optional(),
  context: z.object({ used: z.number(), size: z.number(), pct: z.number() }).optional(),
  costUsd: z.number().optional(),
  permissionMode: z.string().optional(),
  question: z.object({ header: z.string().optional(), text: z.string(), options: z.array(z.string()) }).optional(),
  pid: z.number().optional(),
  discovered: z.boolean().optional(),
  client: z.object({
    bundleId: z.string().optional(),
    program: z.string().optional(),
    pid: z.number().optional(),
    tty: z.string().optional(),
    terminalSession: z.string().optional(),
    orca: z.object({ pane: z.string().optional(), tab: z.string().optional(), terminal: z.string().optional() }).optional(),
  }).optional(),
})

interface TodayCounters { day: number; sessions: string[]; done: string[]; commits: number }
const todaySchema = z.object({ day: z.number(), sessions: z.array(z.string()), done: z.array(z.string()), commits: z.number() })
/** Persisted file shape: v1 was a bare array of sessions; v2 wraps it with the day counters. */
const persistedSchema = z.union([z.array(z.unknown()), z.object({ sessions: z.array(z.unknown()), today: todaySchema.optional() })])

function localDay(t: number): number { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

export interface ClaudeTrackerOptions {
  now?: () => number
  ttlMs?: number
  /** When set, sessions are persisted to this path and reloaded from it on load(). */
  filePath?: string
  /** Debounce window between two persists; 0 writes on every event. */
  persistMs?: number
  /** Injectable for tests: counts the actual writes behind the debounce. */
  writeFn?: (path: string, data: string) => Promise<void>
  /**
   * Called when a session starts waiting for the user.
   *
   * The transition *into* `permission`, not the state: a session sitting in it for ten minutes
   * has already been announced. Whether anything happens is the listener's business — the
   * tracker knows when, and nothing about sounds.
   */
  onAttention?: (event: AttentionEvent) => void
}

export class ClaudeTracker {
  private sessions = new Map<string, ClaudeSession>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly filePath?: string
  private readonly persistMs: number
  private readonly writeFn: (path: string, data: string) => Promise<void>
  private readonly onAttention?: (event: AttentionEvent) => void
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Serialises persists: every write chains onto the previous one. */
  private queue: Promise<void> = Promise.resolve()
  /** Counters for the local day: sessions seen, sessions that reached "done", git commits observed. */
  private todayCounters: TodayCounters = { day: 0, sessions: [], done: [], commits: 0 }

  /** Accepts either the historical positional `(now, ttlMs)` form or an options object. */
  constructor(nowOrOpts?: (() => number) | ClaudeTrackerOptions, ttlMsArg?: number) {
    const opts: ClaudeTrackerOptions = typeof nowOrOpts === 'function' ? { now: nowOrOpts, ttlMs: ttlMsArg } : (nowOrOpts ?? {})
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.filePath = opts.filePath
    this.persistMs = opts.persistMs ?? PERSIST_MS
    this.writeFn = opts.writeFn ?? ((path, data) => writeFile(path, data, 'utf8'))
    this.onAttention = opts.onAttention
  }

  handle(event: HookEvent): void {
    const id = event.session_id
    if (!id) return
    const t = this.now()
    this.sweep(t)
    const name = event.hook_event_name
    // An unknown event (a future hook, or a typo in a script) must not register a
    // ghost session; it only refreshes one that already exists.
    const known = KNOWN_EVENTS.has(name ?? '')
    // A session this very event brought into existence never announces itself: the first thing
    // heard from a session is not a question, and a dismissed card that comes back is new again.
    const fresh = known && !this.sessions.has(id)
    const s = known ? this.getOrCreate(id, event, t) : this.sessions.get(id)
    if (!s) return
    s.lastEventAt = t
    if (!known) return
    this.rollDay(t)
    this.noteSeen(id)
    const before = s.state
    if (event.client) this.mergeClient(s, event.client)
    if (event.cwd && name !== 'StatusLine') { s.cwd = event.cwd; s.project = basename(event.cwd) || event.cwd }
    switch (name) {
      case 'SessionStart': this.setState(s, 'idle', t); break
      case 'UserPromptSubmit': this.setState(s, 'working', t); this.clearTool(s); s.question = undefined; break
      case 'PreToolUse':
        if (event.tool_name === 'AskUserQuestion') {
          const q = parseQuestion(event.tool_input)
          if (q) { this.setState(s, 'permission', t); s.question = q; s.tool = 'AskUserQuestion'; s.toolDetail = undefined; break }
        }
        this.setState(s, 'working', t); this.setTool(s, event)
        break
      case 'PostToolUse': case 'PostToolUseFailure':
        this.setState(s, 'working', t); this.clearTool(s); s.question = undefined
        if (name === 'PostToolUse' && event.tool_name === 'Bash' && isGitCommit(event.tool_input)) this.todayCounters.commits += 1
        break
      case 'PermissionRequest': this.setState(s, 'permission', t); this.setTool(s, event); break
      case 'Notification':
        if (event.notification_type === 'permission_prompt' || event.notification_type === 'agent_needs_input') {
          this.setState(s, 'permission', t); s.lastMessage = truncate(event.message)
        } else if (event.notification_type === 'idle_prompt') {
          this.setState(s, 'idle', t)
        }
        break
      case 'Stop':
        this.setState(s, 'done', t); this.clearTool(s); s.lastMessage = truncate(event.last_assistant_message); s.question = undefined
        if (!this.todayCounters.done.includes(id)) this.todayCounters.done.push(id)
        break
      case 'StopFailure': this.setState(s, 'error', t); s.error = errorType(event.error); break
      case 'SubagentStart': this.agentStarted(s, event.agent_id); break
      case 'SubagentStop': this.agentStopped(s, event.agent_id); break
      case 'StatusLine': this.applyStatusLine(s, event); break
      case 'SessionEnd': this.sessions.delete(id); break
      default: break
    }
    if (!fresh && s.state === 'permission' && before !== 'permission') {
      this.onAttention?.({ sessionId: id, isQuestion: s.question !== undefined })
    }
    this.schedulePersist()
  }

  dismiss(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    // A discovered placeholder has no hook to dismiss it: it would just reappear
    // on the next syncProcesses() while the process is still running.
    if (s.discovered) return false
    if (s.state === 'working' || s.state === 'permission') throw new Error('session en cours')
    this.sessions.delete(sessionId)
    this.schedulePersist()
    return true
  }

  /** Reconciles known sessions with the live Claude Code processes (null = discovery failed, no change). */
  syncProcesses(procs: ClaudeProcess[] | null): void {
    if (!procs) return
    const t = this.now()
    const alive = new Map(procs.map((p) => [p.pid, p]))
    const free = new Map<string, ClaudeProcess[]>()
    for (const p of procs) { const l = free.get(p.cwd) ?? []; l.push(p); free.set(p.cwd, l) }
    const take = (cwd: string, pid?: number): ClaudeProcess | undefined => {
      const l = free.get(cwd); if (!l?.length) return undefined
      const i = pid !== undefined ? l.findIndex((p) => p.pid === pid) : -1
      return l.splice(i >= 0 ? i : 0, 1)[0]
    }
    let changed = false
    // Hook sessions first: they claim a process of their cwd, or disappear when none is left.
    for (const [id, s] of this.sessions) {
      if (s.discovered) continue
      const p = take(s.cwd, s.pid)
      if (!p) { this.sessions.delete(id); changed = true; continue }
      if (s.pid !== p.pid) { s.pid = p.pid; changed = true }
    }
    // Placeholders: drop the dead or claimed ones, add one per unclaimed process.
    for (const [id, s] of this.sessions) {
      if (!s.discovered) continue
      const p = s.pid !== undefined ? alive.get(s.pid) : undefined
      const stillFree = p && (free.get(p.cwd) ?? []).includes(p)
      if (!stillFree) { this.sessions.delete(id); changed = true } else take(p!.cwd, p!.pid)
    }
    for (const list of free.values()) for (const p of list) {
      this.sessions.set(`proc:${p.pid}`, { sessionId: `proc:${p.pid}`, project: basename(p.cwd) || p.cwd, cwd: p.cwd, state: 'idle', since: p.startedAt, lastEventAt: t, subagents: 0, pid: p.pid, discovered: true })
      changed = true
    }
    if (changed) this.schedulePersist()
  }

  /** Reads any persisted sessions from disk, dropping stale or invalid entries. Call once at startup. */
  async load(): Promise<void> {
    if (!this.filePath) return
    await mkdir(dirname(this.filePath), { recursive: true }).catch(() => { /* created later, or read-only */ })
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch {
      return // missing or corrupt: start empty
    }
    const parsedFile = persistedSchema.safeParse(raw)
    if (!parsedFile.success) return
    const items = Array.isArray(parsedFile.data) ? parsedFile.data : parsedFile.data.sessions
    const today = Array.isArray(parsedFile.data) ? undefined : parsedFile.data.today
    const t = this.now()
    for (const item of items) {
      const parsed = claudeSessionSchema.safeParse(item)
      if (!parsed.success) continue // drop invalid entries, keep the rest
      const s = parsed.data
      if (t - s.lastEventAt > this.ttlMs) continue // drop stale entries
      this.sessions.set(s.sessionId, s)
    }
    // Only restore the day counters if they still refer to the current local day;
    // a stale "today" (server restarted the next day) starts empty instead.
    if (today && today.day === localDay(t)) this.todayCounters = today
  }

  /** Writes any pending state now. Called on server shutdown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.persist()
  }

  snapshot(): { sessions: PublicClaudeSession[]; updatedAt: number } {
    const t = this.now()
    this.sweep(t)
    const sessions = [...this.sessions.values()]
      .map((s) => ({ ...s, context: s.context ? { ...s.context } : undefined, client: clientView(s.client) }))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastEventAt - a.lastEventAt)
    return { sessions, updatedAt: t }
  }

  /**
   * Where one session lives, for `focus` and for nothing else.
   *
   * The only way out of the tracker for the raw client, deliberately separate from `snapshot()`:
   * whatever is added to a session from now on reaches the dashboard, and this does not.
   */
  clientOf(sessionId: string): SessionClient | undefined {
    const s = this.sessions.get(sessionId)
    return s ? s.client : undefined
  }

  /**
   * First event wins; a later one only fills what is still missing.
   *
   * A session does not move between panes, so the first hook to report is the one that was there.
   * Filling the gaps matters all the same: the statusline runs in a different shell from the
   * hooks, and between them they know more than either does alone.
   */
  private mergeClient(s: ClaudeSession, incoming: SessionClient): void {
    const cur = s.client ?? {}
    const merged: SessionClient = {
      bundleId: cur.bundleId ?? incoming.bundleId,
      program: cur.program ?? incoming.program,
      pid: cur.pid ?? incoming.pid,
      tty: cur.tty ?? incoming.tty,
      terminalSession: cur.terminalSession ?? incoming.terminalSession,
    }
    const orca = { ...(incoming.orca ?? {}), ...(cur.orca ?? {}) }
    if (Object.values(orca).some((v) => v !== undefined)) merged.orca = orca
    s.client = merged
  }

  /** Drops sessions whose last event is older than the TTL. */
  /**
   * Drops sessions nothing has been heard from for `ttlMs`, then enforces the ceiling.
   *
   * The TTL alone is not a bound: a script looping over fresh session ids fills the map inside
   * one window, and every session is held in memory and written to `data/claude-sessions.json`.
   * Past the cap the least recently heard from go, which is the same order the TTL would have
   * taken them in.
   */
  private sweep(t: number): void {
    for (const [id, s] of this.sessions) if (t - s.lastEventAt > this.ttlMs) this.sessions.delete(id)
    if (this.sessions.size <= MAX_SESSIONS) return
    const byAge = [...this.sessions.entries()].sort((a, b) => a[1].lastEventAt - b[1].lastEventAt)
    for (const [id] of byAge.slice(0, byAge.length - MAX_SESSIONS)) this.sessions.delete(id)
  }

  /** Counters for the local day: sessions seen, sessions that reached "done", git commits observed. */
  today(): { sessions: number; done: number; commits: number } {
    this.rollDay(this.now())
    return { sessions: this.todayCounters.sessions.length, done: this.todayCounters.done.length, commits: this.todayCounters.commits }
  }
  private rollDay(t: number): void {
    const day = localDay(t)
    if (this.todayCounters.day !== day) this.todayCounters = { day, sessions: [], done: [], commits: 0 }
  }
  private noteSeen(id: string): void { if (!this.todayCounters.sessions.includes(id)) this.todayCounters.sessions.push(id) }

  /**
   * Hook events arrive in bursts (a tool call is PreToolUse then PostToolUse
   * within milliseconds), so persisting on each one hammers the disk for no
   * gain: mark the state dirty and let a single timer collapse a burst into
   * one write.
   */
  private schedulePersist(): void {
    if (!this.filePath) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.persist() }, this.persistMs)
    this.timer.unref?.()
  }

  private persist(): Promise<void> {
    this.queue = this.queue.then(() => this.write()).catch(() => { /* keep the chain alive */ })
    return this.queue
  }

  private async write(): Promise<void> {
    if (!this.dirty || !this.filePath) return
    this.dirty = false
    // The pid keeps two servers sharing a data dir from clobbering each other's tmp file.
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await this.writeFn(tmp, JSON.stringify({ sessions: [...this.sessions.values()], today: this.todayCounters }))
    await rename(tmp, this.filePath)
  }

  private getOrCreate(id: string, event: HookEvent, t: number): ClaudeSession {
    let s = this.sessions.get(id)
    if (!s) {
      const cwd = event.cwd ?? event.workspace?.current_dir ?? ''
      s = { sessionId: id, project: basename(cwd) || cwd || id, cwd, state: 'idle', since: t, lastEventAt: t, subagents: 0 }
      // A discovered placeholder for the same cwd is now a real, named session:
      // drop it immediately rather than waiting for the next syncProcesses().
      for (const [key, existing] of this.sessions) {
        if (existing.discovered && existing.cwd === cwd) { s.pid = existing.pid; this.sessions.delete(key); break }
      }
      this.sessions.set(id, s)
    }
    return s
  }

  private setState(s: ClaudeSession, state: ClaudeState, t: number): void {
    if (s.state !== state) { s.state = state; s.since = t }
    if (state !== 'error') s.error = undefined
  }
  private setTool(s: ClaudeSession, event: HookEvent): void {
    s.tool = event.tool_name
    s.toolDetail = event.tool_name ? summarizeTool(event.tool_name, event.tool_input) : undefined
  }
  private clearTool(s: ClaudeSession): void { s.tool = undefined; s.toolDetail = undefined }

  // Claude Code fires SubagentStop several times for one agent (once per turn it stops on)
  // and also for internal agents that never fired SubagentStart, so a plain counter drifts to
  // zero. The set of ids is the truth; the counter stays as a fallback for hooks without one.
  private agentStarted(s: ClaudeSession, agentId: string | undefined): void {
    if (!agentId) { s.subagents += 1; return }
    const ids = s.agentIds ?? []
    if (!ids.includes(agentId)) ids.push(agentId)
    s.agentIds = ids
    s.subagents = ids.length
  }

  private agentStopped(s: ClaudeSession, agentId: string | undefined): void {
    if (!agentId) { s.subagents = Math.max(0, s.subagents - 1); return }
    const ids = (s.agentIds ?? []).filter((id) => id !== agentId)
    s.agentIds = ids
    s.subagents = ids.length
  }

  private applyStatusLine(s: ClaudeSession, e: HookEvent): void {
    const cwd = e.workspace?.current_dir ?? e.cwd
    if (cwd) { s.cwd = cwd; s.project = basename(cwd) || cwd }
    if (typeof e.model === 'string') s.model = e.model
    else if (e.model?.display_name || e.model?.id) s.model = e.model.display_name ?? e.model.id
    if (typeof e.model !== 'string' && e.model?.id) s.modelId = e.model.id
    if (typeof e.session_name === 'string' && e.session_name.trim()) s.title = e.session_name.trim().slice(0, TITLE_MAX)
    if (typeof e.fremkit_branch === 'string' && e.fremkit_branch.trim()) s.branch = e.fremkit_branch.trim()
    if (typeof e.cost?.total_cost_usd === 'number') s.costUsd = e.cost.total_cost_usd
    if (e.permission_mode) s.permissionMode = e.permission_mode
    const cw = e.context_window
    if (cw && typeof cw.context_window_size === 'number') {
      const u = cw.current_usage ?? {}
      const used = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      s.context = { used, size: cw.context_window_size, pct: cw.used_percentage ?? Math.round((used / cw.context_window_size) * 1000) / 10 }
    }
  }
}

function truncate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.length > MESSAGE_MAX ? v.slice(0, MESSAGE_MAX) : v
}

function isGitCommit(input: unknown): boolean {
  const cmd = (input as { command?: unknown } | null)?.command
  return typeof cmd === 'string' && GIT_COMMIT_RE.test(cmd)
}

/** Parses the first AskUserQuestion entry into a session question, or undefined for malformed input. */
function parseQuestion(input: unknown): ClaudeSession['question'] | undefined {
  const qs = (input as { questions?: unknown } | null)?.questions
  const q = Array.isArray(qs) ? qs[0] : undefined
  if (!q || typeof q !== 'object' || typeof (q as any).question !== 'string') return undefined
  const o = q as { header?: unknown; question: string; options?: unknown }
  const options = Array.isArray(o.options)
    ? o.options.map((x: any) => (typeof x?.label === 'string' ? x.label.slice(0, OPTION_MAX) : '')).filter(Boolean).slice(0, OPTIONS_MAX)
    : []
  return { header: typeof o.header === 'string' ? o.header.slice(0, OPTION_MAX) : undefined, text: o.question.slice(0, QUESTION_MAX), options }
}

function errorType(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e.type === 'string') return e.type
    if (typeof e.message === 'string') return e.message
  }
  return 'unknown'
}
