import type { Provider } from '../providers/types.js'
import type { ClaudeTracker } from './tracker.js'
import type { ClaudeUsage } from './usage.js'
import { listClaudeProcesses, type ClaudeProcess } from './processes.js'
import { z } from 'zod'
import { tr } from '../i18n.js'
import { focusClient, type Reader as FocusReader, type Runner as FocusRunner } from './focus.js'
import { playSound, type Runner } from './attention.js'

export { createClaudeAccountProvider } from './account.js'

export interface ClaudeSessionsProviderOptions {
  listProcesses?: () => Promise<ClaudeProcess[] | null>
  /** Minimum delay between two process-discovery scans, in ms. */
  discoveryMs?: number
  now?: () => number
  /** Injectable for tests: what actually runs `osascript`, `open` and the Orca CLI. */
  focusRunner?: FocusRunner
  focusReader?: FocusReader
  /** Injected by the tests; production runs `afplay`. */
  soundRunner?: Runner
}

/** A session id is a non-empty string; nothing else can be dismissed. */
export const DismissPayloadSchema = z.object({ sessionId: z.string().min(1).max(200) })
/** Same shape for `focus`: the id names the session, and the server looks up everything else. */
export const FocusPayloadSchema = DismissPayloadSchema

export function createClaudeSessionsProvider(tracker: ClaudeTracker, opts: ClaudeSessionsProviderOptions = {}): Provider {
  const list = opts.listProcesses ?? listClaudeProcesses
  const every = opts.discoveryMs ?? 30_000
  const now = opts.now ?? Date.now
  let last = 0
  return {
    channel: 'claude-sessions',
    intervalMs: 1000,
    async poll() {
      // Idle-but-open sessions only surface via a process scan; keep it rare since
      // it shells out to ps/lsof, unlike the cheap in-memory snapshot below.
      const t = now()
      if (t - last >= every) { last = t; tracker.syncProcesses(await list()) }
      // Only the sessions array is returned: tracker.snapshot() also carries an
      // updatedAt timestamp that changes on every call, which would make the
      // registry re-publish this channel every second even when nothing changed.
      return { sessions: tracker.snapshot().sessions, today: tracker.today() }
    },
    commands: {
      /**
       * Bring the session's own window forward.
       *
       * The payload is a session id and nothing else: where that session lives is what the
       * server holds and the widget has never been told, which is the whole reason a tile in a
       * sandboxed iframe can ask for this at all. Local callers only, like every other command
       * that acts on the Mac itself.
       */
      focus: async (payload, ctx) => {
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const parsed = FocusPayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'claude.invalidDismiss'))
        const session = tracker.snapshot().sessions.find((s) => s.sessionId === parsed.data.sessionId)
        // Answered rather than thrown: "I do not know that session" is something the card shows,
        // not a failure of the command.
        if (!session) return { ok: false, reason: 'unknownSession' }
        return await focusClient(tracker.clientOf(parsed.data.sessionId), session.cwd, opts.focusRunner, tracker.pidOf(parsed.data.sessionId), opts.focusReader)
      },
      /**
       * The admin's ▶ beside the sound setting: play the chosen sound once, now. Local callers
       * only — it runs a program — and the value has to be one of the listed sounds, or `none`,
       * which plays nothing and answers ok.
       */
      preview: async (payload, ctx) => {
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const value = (payload as { value?: unknown } | undefined)?.value
        if (value === 'none') return { ok: true }
        const played = await playSound(value, opts.soundRunner)
        return played ? { ok: true } : { ok: false, reason: 'unknownSound' }
      },
      dismiss: async (payload) => {
        const parsed = DismissPayloadSchema.safeParse(payload)
        // Never the raw ZodError: it echoes the payload back to the caller.
        if (!parsed.success) throw new Error(tr(undefined, 'claude.invalidDismiss'))
        return { dismissed: tracker.dismiss(parsed.data.sessionId) }
      },
    },
  }
}

export function createClaudeUsageProvider(usage: ClaudeUsage): Provider {
  return {
    channel: 'claude-usage',
    intervalMs: 60_000,
    poll: async () => { await usage.refreshToday(); return usage.snapshot() },
  }
}
