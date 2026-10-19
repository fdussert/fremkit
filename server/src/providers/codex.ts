import { execFile } from 'node:child_process'
import { z } from 'zod'
import { isTrusted, type Provider } from './types.js'
import {
  createCodexSessionsProvider,
  type createSessionReader,
  type SessionsSnapshot,
} from '../codex/observations.js'
import { CodexBinarySchema } from '../codex/config.js'
import type { LocalChatValidator } from '../codex/local-chats.js'
import { CodexError, createLocalCodexClient, type CodexClient, type CodexFailure } from '../codex/adapter.js'
import { HistorySourceSchema, type HistorySource } from '../codex/sources.js'
import {
  AccountSchema,
  HistorySchema,
  QuotasSchema,
  UsageSchema,
  ThreadIdSchema,
  emptySnapshot,
  emptyPart,
  type CodexSnapshot,
  type SnapshotPart,
  type History,
} from '../codex/snapshot.js'
export type { CodexSnapshot } from '../codex/snapshot.js'
const OptionsSchema = z
  .object({
    binary: CodexBinarySchema.optional(),
    enabled: z.boolean().default(false),
    accountEnabled: z.boolean().default(false),
    historySources: z.array(HistorySourceSchema).max(10).default([]),
  })
  .strict()
export interface CodexProviderOptions {
  binary?: string
  enabled?: boolean | (() => boolean)
  accountEnabled?: boolean | (() => boolean)
  historySources?: HistorySource[] | (() => HistorySource[])
}
function resolveOptions(options: CodexProviderOptions) {
  try {
    const enabled = typeof options.enabled === 'function' ? options.enabled() : (options.enabled ?? false)
    const accountEnabled =
      typeof options.accountEnabled === 'function'
        ? options.accountEnabled()
        : (options.accountEnabled ?? enabled)
    const historySources =
      typeof options.historySources === 'function' ? options.historySources() : (options.historySources ?? [])
    return OptionsSchema.safeParse({ binary: options.binary, enabled, accountEnabled, historySources })
  } catch {
    return OptionsSchema.safeParse({ enabled: 'invalid' })
  }
}
export interface CodexProviderDeps {
  readSessions?: ReturnType<typeof createSessionReader>
  client?: CodexClient
  clientFactory?: () => Promise<CodexClient>
  now?: () => number
  /** Trusted host validation independent of sourceKind or title. Missing validator disables opens. */
  isLocalChat?: LocalChatValidator
  openUrl?: (url: string) => Promise<void>
}
const openUrl = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], { timeout: 15000, shell: false }, (error) => {
      if (error) reject(new CodexError('offline'))
      else resolve()
    })
  })
const failure = (error: unknown): CodexFailure =>
  error instanceof CodexError ? error.reason : error instanceof z.ZodError ? 'invalid' : 'offline'
const stale = <T>(part: SnapshotPart<T>, error: CodexFailure): SnapshotPart<T> => ({
  ...part,
  freshness: part.data === null ? 'unavailable' : 'stale',
  error,
})
function normalizeSource(source: string | Record<string, unknown>): HistorySource {
  if (typeof source === 'string') {
    const parsed = HistorySourceSchema.safeParse(source)
    return parsed.success ? parsed.data : 'unknown'
  }
  if (!Object.hasOwn(source, 'subAgent')) return 'unknown'
  if (source.subAgent === 'review') return 'subAgentReview'
  if (source.subAgent === 'compact') return 'subAgentCompact'
  if (source.subAgent && typeof source.subAgent === 'object') {
    return Object.hasOwn(source.subAgent, 'thread_spawn') ? 'subAgentThreadSpawn' : 'subAgentOther'
  }
  return 'subAgentOther'
}
function selectedSource(source: HistorySource, sources: HistorySource[]): boolean {
  return sources.includes(source) || (sources.includes('subAgent') && source.startsWith('subAgent'))
}
function selectedHistory(part: SnapshotPart<History>, sources: HistorySource[]): SnapshotPart<History> {
  if (!sources.length) return emptyPart('unconfigured')
  if (!part.data) return part
  return { ...part, data: { ...part.data, threads: part.data.threads.filter((thread) => selectedSource(thread.sourceKind, sources)) } }
}
/** Opt-in core channel. The caller owns configuration and trusted local-chat validation. */
export function createCodexProvider(
  options: CodexProviderOptions = {},
  deps: CodexProviderDeps = {},
): Provider<CodexSnapshot> & { sessions: Provider<SessionsSnapshot> } {
  const now = deps.now ?? Date.now
  let last = emptySnapshot()
  let client = deps.client
  let inflight: Promise<CodexSnapshot> | undefined
  let generation = 0
  let authIdentity: string | undefined
  async function refresh(): Promise<CodexSnapshot> {
    const parsed = resolveOptions(options)
    if (!parsed.success) return emptySnapshot('invalid')
    if (!parsed.data.enabled) return emptySnapshot()
    const epoch = generation
    const sources = parsed.data.historySources
    const next: CodexSnapshot = {
      ...last,
      checkedAt: now(),
      error: null,
      history: selectedHistory(last.history, sources),
      ...(!parsed.data.accountEnabled
        ? { account: emptyPart(), quotas: emptyPart(), usage: emptyPart(), authMode: null }
        : {}),
    }
    if (!parsed.data.accountEnabled) authIdentity = undefined
    try {
      if (!client) {
        const created = deps.clientFactory
          ? await deps.clientFactory()
          : await createLocalCodexClient({ binary: parsed.data.binary })
        if (epoch !== generation) {
          created.close()
          return last
        }
        client = created
      }
      const api = client
      async function read<T>(
        method: string,
        params: unknown,
        previous: SnapshotPart<T>,
        transform: (raw: unknown) => Promise<T> | T,
      ): Promise<SnapshotPart<T>> {
        try {
          if (epoch !== generation) throw new CodexError('offline')
          if (!api.supports(method)) throw new CodexError('unsupported')
          const data = await transform(await api.request(method, params))
          return { data, updatedAt: now(), freshness: 'fresh', error: null }
        } catch (error) {
          return stale(previous, failure(error))
        }
      }
      let accountVerified = false
      if (parsed.data.accountEnabled)
        try {
          if (!api.supports('account/read')) throw new CodexError('unsupported')
          const auth = AccountSchema.parse(await api.request('account/read', { refreshToken: false }))
          if (epoch !== generation) return last
          next.authMode = auth.account?.type ?? null
          if (!auth.account) throw new CodexError('unauthorized')
          next.account = {
            data: {
              type: auth.account.type,
              planType: auth.account.type === 'chatgpt' ? (auth.account.planType ?? null) : null,
            },
            updatedAt: now(),
            freshness: 'fresh',
            error: null,
          }
          accountVerified = true
          // Private workspace marker only; the public account display fields are projected above.
          const identity = JSON.stringify([
            auth.account.type,
            auth.account.email ?? null,
            auth.account.planType ?? null,
            auth.workspaceRouting?.chatgptAccountId ?? null,
          ])
          if (authIdentity !== identity) {
            next.quotas = emptyPart()
            next.usage = emptyPart()
            authIdentity = identity
          }
          if (auth.account.type !== 'chatgpt') throw new CodexError('unsupported')
          next.quotas = await read(
            'account/rateLimits/read',
            { supportsLunaReserve: false, excludeResetCreditDetails: true },
            next.quotas,
            (raw) => QuotasSchema.parse(raw),
          )
          if (next.quotas.error === 'unauthorized') throw new CodexError('unauthorized')
          next.usage = await read('account/usage/read', {}, next.usage, (raw) => UsageSchema.parse(raw))
          if (next.usage.error === 'unauthorized') throw new CodexError('unauthorized')
        } catch (error) {
          const reason = failure(error)
          if (
            reason === 'unauthorized' ||
            reason === 'invalid' ||
            (reason === 'unsupported' && !accountVerified)
          )
            next.account = emptyPart(reason)
          else if (!accountVerified) next.account = stale(next.account, reason)
          if (reason === 'unauthorized' || reason === 'unsupported' || reason === 'invalid') {
            next.authMode = reason === 'unauthorized' ? null : next.authMode
            next.quotas = emptyPart(reason)
            next.usage = emptyPart(reason)
            authIdentity = undefined
          } else {
            next.quotas = stale(next.quotas, reason)
            next.usage = stale(next.usage, reason)
          }
        }
      else {
        next.account = emptyPart()
        next.quotas = emptyPart()
        next.usage = emptyPart()
        next.authMode = null
        authIdentity = undefined
      }
      next.history = sources.length
        ? await read<History>(
            'thread/list',
            { sourceKinds: sources, useStateDbOnly: true, limit: 50, sortKey: 'updated_at', archived: false },
            next.history,
            async (raw) => {
              const value = HistorySchema.parse(raw)
              const selected = value.data.filter((thread) => {
                const sourceKind = normalizeSource(thread.source)
                return (
                  !thread.ephemeral &&
                  selectedSource(sourceKind, sources)
                )
              })
              let localIds = new Set<string>()
              try {
                if (deps.isLocalChat?.validateMany)
                  localIds = await deps.isLocalChat.validateMany(selected.map((thread) => thread.id))
                else if (deps.isLocalChat) {
                  const results = await Promise.all(
                    selected.map(async (thread) => ((await deps.isLocalChat!(thread.id)) ? thread.id : null)),
                  )
                  localIds = new Set(results.filter((id): id is string => id !== null))
                }
              } catch {
                // Fail closed when the local catalog cannot validate the selected IDs.
              }
              const threads: History['threads'] = selected.map((thread) => ({
                id: thread.id,
                title: thread.name ?? null,
                sourceKind: normalizeSource(thread.source),
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                liveActivity: null,
                navigation: localIds.has(thread.id) ? 'localChat' : 'unavailable',
              }))
              return { threads, nextCursor: value.nextCursor ?? null, truncated: !!value.nextCursor }
            },
          )
        : emptyPart('unconfigured')
    } catch (error) {
      const reason = failure(error)
      next.account = stale(next.account, reason)
      next.quotas = stale(next.quotas, reason)
      next.usage = stale(next.usage, reason)
      next.history = sources.length ? stale(next.history, reason) : emptyPart('unconfigured')
    }
    // A poll owns its app-server child. Closing here avoids a second long-lived auth process
    // alongside the desktop app; injected test clients remain under the caller's control.
    if (!deps.client) {
      client?.close()
      client = undefined
    }
    next.error =
      (parsed.data.accountEnabled ? (next.account.error ?? next.quotas.error ?? next.usage.error) : null) ??
      (parsed.data.historySources.length ? next.history.error : null)
    if (epoch === generation && JSON.stringify(resolveOptions(options)) === JSON.stringify(parsed))
      last = next
    return last
  }
  return {
    sessions: createCodexSessionsProvider({
      enabled: () => {
        const current = resolveOptions(options)
        return current.success && current.data.enabled && current.data.historySources.length > 0
      },
      history: () => {
        const current = resolveOptions(options)
        return current.success && current.data.enabled
          ? selectedHistory(last.history, current.data.historySources).data
          : null
      },
      read: deps.readSessions,
      now,
    }),
    channel: 'codex',
    get intervalMs() {
      if (last.error === 'offline') return 15_000
      if (last.error && last.error !== 'unconfigured') return 300_000
      return 60_000
    },
    poll() {
      const current = resolveOptions(options)
      if (!current.success || !current.data.enabled) {
        generation++
        client?.close()
        client = deps.client
        inflight = undefined
        last = emptySnapshot(current.success ? 'unconfigured' : 'invalid')
        return Promise.resolve(last)
      }
      if (!inflight) {
        const running = refresh()
        inflight = running
        void running.finally(() => {
          if (inflight === running) inflight = undefined
        })
      }
      return inflight
    },
    stop() {
      generation++
      client?.close()
      client = deps.client
      inflight = undefined
      last = {
        ...last,
        account: stale(last.account, 'offline'),
        history: stale(last.history, 'offline'),
      }
    },
    commands: {
      open: async (payload, context) => {
        const request = z
          .object({ threadId: ThreadIdSchema, instanceId: z.string().min(1).max(200).optional() })
          .strict()
          .safeParse(payload)
        if (!isTrusted(context) || !request.success) return { ok: false, error: 'refused' }
        const history = last.history
        const epoch = generation
        const thread = history.data?.threads.find((t) => t.id === request.data.threadId)
        const parsed = resolveOptions(options)
        if (
          !parsed.success ||
          !parsed.data.enabled ||
          history.freshness !== 'fresh' ||
          history.updatedAt === null ||
          now() - history.updatedAt > 120000 ||
          thread?.navigation !== 'localChat' ||
          !selectedSource(thread.sourceKind, parsed.data.historySources) ||
          !deps.isLocalChat
        )
          return { ok: false, error: 'unavailable' }
        try {
          if (!(await deps.isLocalChat(thread.id))) return { ok: false, error: 'unavailable' }
          if (epoch !== generation || last.history !== history || now() - history.updatedAt > 120000)
            return { ok: false, error: 'unavailable' }
          await (deps.openUrl ?? openUrl)(`codex://threads/${thread.id}`)
          return { ok: true }
        } catch {
          return { ok: false, error: 'offline' }
        }
      },
    },
  }
}
