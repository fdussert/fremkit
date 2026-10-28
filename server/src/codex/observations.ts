import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { z } from 'zod'
import { querySqlite } from './sqlite.js'
import { ThreadIdSchema, type History } from './snapshot.js'
import type { Provider } from '../providers/types.js'

const MAX_ROWS = 300
const TAIL_BYTES = 512 * 1024
const INITIAL_BYTES = 16 * 1024 * 1024
const FRESH_MS = 90_000
const text = z.string().max(4096).nullable()
const Row = z.object({
  id: ThreadIdSchema,
  parentId: ThreadIdSchema.nullable(),
  rollout: text,
  model: text,
  effort: text,
  cwd: text,
  branch: text,
  nickname: text,
  role: text,
  agentPath: text,
  childCount: z.number().int().nonnegative(),
})
type Row = z.infer<typeof Row>
export interface TurnObservation {
  state: 'working' | 'waiting' | 'done' | 'interrupted' | 'error' | 'unknown'
  turnId: string | null
  startedAt: number | null
  finishedAt: number | null
  lastEventAt: number | null
  model: string | null
  effort: string | null
  durationMs: number | null
}
export interface SessionObservation extends TurnObservation {
  id: string
  parentId: string | null
  project: string | null
  branch: string | null
  modelSource: 'turn' | 'stored' | null
  nickname: string | null
  role: string | null
  agentName: string | null
  subagents: SessionObservation[]
  subagentCount: number
  agentsTruncated: boolean
}
export interface SessionsSnapshot {
  sessions: SessionObservation[]
  updatedAt: number | null
  error: 'offline' | 'unconfigured' | 'invalid' | null
  truncated: boolean
}
const emptyTurn = (): TurnObservation => ({ state: 'unknown', turnId: null, startedAt: null, finishedAt: null, lastEventAt: null, model: null, effort: null, durationMs: null })
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const milliseconds = (v: unknown): number | null => { const n = number(v); return n === null ? null : n < 1e12 ? n * 1000 : n }
const label = (v: unknown): string | null => typeof v === 'string' && v.length <= 200 ? v : null
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** Project lifecycle/model fields only. Prompt, reasoning and tool arguments are discarded. */
export function parseTurnRecords(raw: string, previous: TurnObservation = emptyTurn()): TurnObservation {
  let result = { ...previous }
  for (const line of raw.split('\n')) {
    if (!line || line.length > TAIL_BYTES) continue
    let decoded: unknown
    try { decoded = JSON.parse(line) } catch { continue }
    const record = object(decoded)
    const p = object(record?.payload)
    const at = Date.parse(typeof record?.timestamp === 'string' ? record.timestamp : '')
    if (!record || !p || !Number.isFinite(at)) continue
    if (record.type === 'event_msg' && p.type === 'task_started') {
      result = { ...emptyTurn(), state: 'working', turnId: label(p.turn_id), startedAt: milliseconds(p.started_at) ?? at, lastEventAt: at }
    } else if (record.type === 'turn_context') {
      // A turn context without a retained start records a model, but cannot establish runtime state.
      if (!result.turnId || !p.turn_id || p.turn_id === result.turnId) {
        result.model = label(p.model)
        result.effort = label(p.effort ?? p.reasoning_effort)
      }
    } else if (record.type === 'event_msg' &&
      (p.type === 'task_complete' || p.type === 'turn_aborted' || p.type === 'error')) {
      if (result.turnId && p.turn_id && p.turn_id !== result.turnId) continue
      result.state = p.type === 'task_complete' ? 'done' : p.type === 'turn_aborted' ? 'interrupted' : 'error'
      result.turnId = label(p.turn_id) ?? result.turnId
      result.finishedAt = milliseconds(p.completed_at) ?? at
      result.startedAt = milliseconds(p.started_at) ?? result.startedAt
      result.durationMs = number(p.duration_ms) ??
        (result.startedAt === null ? null : Math.max(0, result.finishedAt - result.startedAt))
      result.lastEventAt = at
    } else if (record.type === 'event_msg' || record.type === 'response_item') {
      if (result.state === 'working' || result.state === 'waiting') {
        result.lastEventAt = at
        if (record.type === 'response_item' && p.type === 'function_call' &&
          typeof p.name === 'string' && /request_user_input(?:_async)?$/.test(p.name)) result.state = 'waiting'
        // New model output after a wait demonstrates that execution resumed.
        else if (result.state === 'waiting' && record.type === 'response_item' &&
          (p.type === 'reasoning' || p.type === 'function_call' || p.type === 'custom_tool_call')) result.state = 'working'
      }
    }
  }
  return result
}
export function freshTurn(turn: TurnObservation, now: number): TurnObservation {
  if (['working', 'waiting'].includes(turn.state) && (!turn.lastEventAt || now < turn.lastEventAt || now - turn.lastEventAt > FRESH_MS)) return { ...turn, state: 'unknown' }
  return { ...turn }
}
interface Cache { id: string; ino: number; size: number; mtime: number; turn: TurnObservation }
/** The state database the reader's query is written for, in the Codex home folder. */
export const CODEX_STATE_DB = 'state_5.sqlite'
export interface SessionReaderOptions {
  codexHome?: string
  query?: (sql: string) => Promise<unknown>
  platform?: NodeJS.Platform
  /**
   * Where a stored rollout path is read from, or null to skip it. A Codex inside WSL stores POSIX
   * paths that Windows reaches under `\\wsl.localhost`; the containment check below still applies.
   */
  rolloutPath?: (stored: string) => string | null
}
export function createSessionReader(options: SessionReaderOptions = {}) {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const cache = new Map<string, Cache>()
  const query = options.query ?? ((sql: string) =>
    querySqlite(sql, { path: join(home, CODEX_STATE_DB), platform: options.platform, timeoutMs: 2500, maxBuffer: 512 * 1024 }))
  async function tail(row: Row): Promise<TurnObservation> {
    const rollout = row.rollout && options.rolloutPath ? options.rolloutPath(row.rollout) : row.rollout
    if (!rollout) return emptyTurn()
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const [root, path] = await Promise.all([realpath(home), realpath(rollout)])
      if (![join(root, 'sessions') + sep, join(root, 'archived_sessions') + sep].some(base => path.startsWith(base))) return emptyTurn()
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await file.stat()
      if (!info.isFile()) return emptyTurn()
      const old = cache.get(path)
      if (!old || old.ino !== info.ino || old.id !== row.id) {
        const head = Buffer.alloc(Math.min(65_536, info.size))
        const read = await file.read(head, 0, head.length, 0)
        const end = head.subarray(0, read.bytesRead).indexOf(10)
        if (end < 0) return emptyTurn()
        const first = object(JSON.parse(head.subarray(0, end).toString('utf8')))
        if (first?.type !== 'session_meta' || object(first.payload)?.id !== row.id) return emptyTurn()
      }
      if (old && old.id === row.id && old.ino === info.ino && old.size === info.size && old.mtime === info.mtimeMs) return { ...old.turn }
      const contiguous = !!old && old.id === row.id && old.ino === info.ino && old.size <= info.size && info.size - old.size <= TAIL_BYTES
      const limit = contiguous ? TAIL_BYTES : INITIAL_BYTES
      const offset = contiguous ? old!.size : Math.max(0, info.size - limit)
      const buffer = Buffer.alloc(Math.min(limit, info.size - offset))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      // Advance only through complete bytes, preserving partial JSON and UTF-8 for the next read.
      const consumed = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1
      let raw = buffer.subarray(0, consumed).toString('utf8')
      if (!contiguous && offset > 0) raw = raw.slice(raw.indexOf('\n') + 1)
      const turn = parseTurnRecords(raw, contiguous ? old!.turn : emptyTurn())
      cache.set(path, { id: row.id, ino: info.ino, size: offset + consumed, mtime: info.mtimeMs, turn })
      if (cache.size > 200) cache.delete(cache.keys().next().value!)
      return { ...turn }
    } catch {
      return emptyTurn()
    } finally {
      await file?.close()
    }
  }
  return async (ids: string[], now: number): Promise<{ sessions: SessionObservation[]; truncated: boolean }> => {
    const selected = [...new Set(ids.filter(id => ThreadIdSchema.safeParse(id).success))].slice(0, 50)
    if (!selected.length) return { sessions: [], truncated: false }
    const list = selected.map(id => `'${id}'`).join(',')
    const priority = selected.map((id, i) => `WHEN '${id}' THEN ${i}`).join(' ')
    // Only UUIDs enter SQL. Read direct children of selected history, not every thread.
    const sql = `SELECT t.id, e.parent_thread_id AS parentId, t.rollout_path AS rollout,
      t.model, t.reasoning_effort AS effort, t.cwd, t.git_branch AS branch,
      t.agent_nickname AS nickname, t.agent_role AS role, t.agent_path AS agentPath,
      (SELECT COUNT(*) FROM thread_spawn_edges ce JOIN threads ct ON ct.id=ce.child_thread_id
        WHERE ce.parent_thread_id=t.id AND ct.archived=0) AS childCount
    FROM threads t LEFT JOIN thread_spawn_edges e ON e.child_thread_id=t.id
    WHERE t.id IN (${list}) OR (e.parent_thread_id IN (${list}) AND t.archived=0)
    ORDER BY (t.id IN (${list})) DESC,
      CASE COALESCE(e.parent_thread_id,t.id) ${priority} ELSE 50 END,
      t.updated_at DESC LIMIT ${MAX_ROWS + 1};`
    const parsed = z.array(Row).max(MAX_ROWS + 1).parse(await query(sql))
    const truncated = parsed.length > MAX_ROWS
    const rows = parsed.slice(0, MAX_ROWS)
    const observe = async (row: Row): Promise<SessionObservation> => {
      const observed = freshTurn(await tail(row), now)
      const turnModel = observed.model
      return {
        ...observed,
        id: row.id,
        parentId: row.parentId,
        project: row.cwd ? basename(row.cwd) : null,
        branch: label(row.branch),
        model: turnModel ?? label(row.model),
        effort: observed.effort ?? label(row.effort),
        modelSource: turnModel ? 'turn' : row.model ? 'stored' : null,
        nickname: label(row.nickname),
        role: label(row.role),
        agentName: row.agentPath ? basename(row.agentPath) : null,
        subagents: [],
        subagentCount: row.childCount,
        agentsTruncated: false,
      }
    }
    const observations: SessionObservation[] = []
    // Bound concurrent cold reads: a large conversation cannot multiply file buffers by the row cap.
    for (let i = 0; i < rows.length; i += 4) {
      observations.push(...await Promise.all(rows.slice(i, i + 4).map(observe)))
    }
    const sessions = selected
      .map(id => observations.find(session => session.id === id))
      .filter((session): session is SessionObservation => !!session)
      .map(session => {
        const subagents = observations.filter(child => child.parentId === session.id && child.id !== session.id)
        return { ...session, subagents, agentsTruncated: subagents.length < session.subagentCount }
      })
    return { sessions, truncated }
  }
}

/** Five-second local reads remain separate from slower account and network quota polling. */
export function createCodexSessionsProvider(options: {
  enabled: boolean | (() => boolean)
  history: () => History | null
  read?: ReturnType<typeof createSessionReader>
  now?: () => number
}): Provider<SessionsSnapshot> {
  const read = options.read ?? createSessionReader()
  const now = options.now ?? Date.now
  let generation = 0
  let inflight: Promise<SessionsSnapshot> | undefined
  let last: SessionsSnapshot = { sessions: [], updatedAt: null, error: 'unconfigured', truncated: false }
  return {
    channel: 'codex-live',
    intervalMs: 5000,
    stop() {
      generation++
      inflight = undefined
      last = { ...last, error: 'offline' }
    },
    poll() {
      const enabled = typeof options.enabled === 'function' ? options.enabled() : options.enabled
      if (!enabled) {
        generation++
        inflight = undefined
        last = { sessions: [], updatedAt: null, error: 'unconfigured', truncated: false }
        return Promise.resolve(last)
      }
      if (!inflight) {
        const epoch = generation
        const job = (async () => {
          try {
            const history = options.history()
            if (!history) return { ...last, error: 'unconfigured' as const }
            const value = await read(history.threads.map(thread => thread.id), now())
            if (epoch === generation) last = { ...value, updatedAt: now(), error: null }
          } catch {
            if (epoch === generation) last = { ...last, error: 'offline' }
          }
          return last
        })()
        inflight = job
        void job.finally(() => { if (inflight === job) inflight = undefined })
      }
      return inflight
    },
  }
}
