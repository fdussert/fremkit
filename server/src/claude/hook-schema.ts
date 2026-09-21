import { z } from 'zod'
import type { HookEvent } from './tracker.js'

/**
 * The shape `POST /api/hooks/claude` accepts.
 *
 * The route answers 204 whatever arrives — a non-2xx makes Claude Code's hook runner treat the
 * call as failed, which would disturb the session it is reporting on — so this schema never
 * refuses an event. Every field is `.catch(undefined)`: a value of the wrong type or past its
 * cap is dropped and the rest of the event still counts.
 *
 * What it is for is the caps. The body limit is 1 MB, and before this a single hook call could
 * put a megabyte of string into a session that is then held in memory and written to
 * `data/claude-sessions.json`. Unknown fields are dropped rather than passed through: the
 * tracker reads these and nothing else, and a future hook field should be added here on purpose.
 */

/** A short identifier or label. */
const shortText = (max: number) => z.string().max(max).optional().catch(undefined)

/** Caps, each a generous multiple of what the real hooks send. */
const ID_MAX = 200
const NAME_MAX = 200
const PATH_MAX = 1024
/** The tracker truncates these for display anyway; this is the ceiling on what it holds at all. */
const MESSAGE_MAX = 8192

/**
 * Where the session lives, as the hook read it out of its own environment.
 *
 * Same discipline as the rest: every field optional and `.catch(undefined)`, so a value of the
 * wrong shape costs that field and not the event. The caps are the point — these are environment
 * variables, and an environment variable is whatever somebody exported.
 */
const ClientSchema = z.object({
  bundleId: shortText(ID_MAX),
  program: shortText(NAME_MAX),
  pid: z.number().int().positive().max(9_999_999).optional().catch(undefined),
  tty: shortText(NAME_MAX),
  terminalSession: shortText(ID_MAX),
  orca: z.object({
    pane: shortText(ID_MAX),
    tab: shortText(ID_MAX),
    terminal: shortText(ID_MAX),
  }).optional().catch(undefined),
}).optional().catch(undefined)

const ModelSchema = z.union([
  z.string().max(NAME_MAX),
  z.object({ id: shortText(NAME_MAX), display_name: shortText(NAME_MAX) }),
]).optional().catch(undefined)

export const HookEventSchema = z.object({
  hook_event_name: shortText(NAME_MAX),
  session_id: shortText(ID_MAX),
  agent_id: shortText(ID_MAX),
  cwd: shortText(PATH_MAX),
  tool_name: shortText(NAME_MAX),
  // Read for a one-line summary only, and already bounded by the body limit.
  tool_input: z.unknown().optional().catch(undefined),
  notification_type: shortText(NAME_MAX),
  message: shortText(MESSAGE_MAX),
  last_assistant_message: shortText(MESSAGE_MAX),
  error: z.unknown().optional().catch(undefined),
  model: ModelSchema,
  session_name: shortText(NAME_MAX),
  fremkit_branch: shortText(NAME_MAX),
  client: ClientSchema,
  workspace: z.object({
    current_dir: shortText(PATH_MAX),
    project_dir: shortText(PATH_MAX),
  }).optional().catch(undefined),
  cost: z.object({ total_cost_usd: z.number().finite().optional().catch(undefined) }).optional().catch(undefined),
  context_window: z.object({
    context_window_size: z.number().finite().optional().catch(undefined),
    used_percentage: z.number().finite().optional().catch(undefined),
    current_usage: z.object({
      input_tokens: z.number().finite().optional().catch(undefined),
      output_tokens: z.number().finite().optional().catch(undefined),
      cache_creation_input_tokens: z.number().finite().optional().catch(undefined),
      cache_read_input_tokens: z.number().finite().optional().catch(undefined),
    }).optional().catch(undefined),
  }).optional().catch(undefined),
  permission_mode: shortText(NAME_MAX),
  /**
   * The statusline script's rate-limit windows, keyed by name (`five_hour`, `seven_day`,
   * `spend_limit`, and whatever is added next). ClaudeUsage validates each window itself, so the
   * record stays open — but it is bounded, which is the point here.
   */
  rate_limits: z.record(
    z.string().max(NAME_MAX),
    z.object({
      used_percentage: z.number().finite().optional().catch(undefined),
      resets_at: z.number().finite().optional().catch(undefined),
    }).optional().catch(undefined),
  ).optional().catch(undefined),
})

/**
 * Reads one hook payload, or null when it is not an object at all.
 *
 * Never throws and never refuses: the worst an unusable body gets is null, which the route
 * answers 204 to like everything else.
 */
export function parseHookEvent(body: unknown): HookEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const parsed = HookEventSchema.safeParse(body)
  return parsed.success ? (parsed.data as HookEvent) : null
}
