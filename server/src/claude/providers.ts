import type { Provider } from '../providers/types.js'
import type { ClaudeTracker } from './tracker.js'
import type { ClaudeUsage } from './usage.js'
import { listClaudeProcesses, type ClaudeProcess } from './processes.js'

export { createClaudeAccountProvider } from './account.js'

export interface ClaudeSessionsProviderOptions {
  listProcesses?: () => Promise<ClaudeProcess[] | null>
  /** Minimum delay between two process-discovery scans, in ms. */
  discoveryMs?: number
  now?: () => number
}

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
      dismiss: async (payload) => {
        const id = (payload as { sessionId?: unknown })?.sessionId
        if (typeof id !== 'string' || !id) throw new Error('sessionId manquant')
        return { dismissed: tracker.dismiss(id) }
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
