import { reactive } from 'vue'
import { api as realApi, type ConnectionInput, type ConnectionTestResult } from '../shared/api'
import type { ConnectionSummary, ConnectionTypeInfo } from '../shared/types'

export interface ConnectionsState {
  types: ConnectionTypeInfo[]
  connections: ConnectionSummary[]
  loaded: boolean
  busy: boolean
  error: string
}

export interface ConnectionsApi {
  getConnectionTypes(): Promise<ConnectionTypeInfo[]>
  getConnections(): Promise<ConnectionSummary[]>
  putConnection(id: string, body: ConnectionInput): Promise<ConnectionSummary>
  deleteConnection(id: string): Promise<void>
  testConnection(id: string, body: Partial<ConnectionInput>): Promise<ConnectionTestResult>
}

/**
 * The `secrets` map to send with a save or a test.
 *
 * Only keys the user actually typed into are sent. Revealing a stored secret to look at the empty
 * input is not typing: an untouched key stays out of the payload, so the server keeps what it has
 * — and a test still authenticates with the stored value instead of an empty string. A key that
 * was typed into and then emptied *is* sent, as `''`, which the server reads as "forget it".
 */
export function buildSecretsPayload(
  values: Record<string, string>,
  touched: Record<string, boolean>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, isTouched] of Object.entries(touched)) if (isTouched) out[key] = values[key] ?? ''
  return out
}

/**
 * The stored secrets a form must offer for re-entry after a field was edited.
 *
 * The server refuses to send a stored token to a destination the user just changed — a GitHub
 * host, a printer's serial. Rather than let them fill a form that is bound to be refused, the
 * form opens those secrets for re-entry as soon as a bound field moves away from its stored
 * value. Nothing to re-enter on a new connection, or on a field no secret is tied to.
 */
export function boundSecretsToReveal(
  type: ConnectionTypeInfo,
  connection: ConnectionSummary | null,
  key: string,
  value: string,
): string[] {
  if (!connection) return []
  if (!(type.secretBindings ?? []).includes(key)) return []
  if (value === (connection.fields[key] ?? '')) return []
  return type.fields.filter((f) => f.secret && connection.secrets[f.key]).map((f) => f.key)
}

export interface ConnectionsStore {
  state: ConnectionsState
  load(): Promise<void>
  save(id: string, input: ConnectionInput): Promise<void>
  remove(id: string): Promise<void>
  test(id: string, input: Partial<ConnectionInput>): Promise<ConnectionTestResult>
  ofType(typeId: string): ConnectionSummary[]
  suggestId(typeId: string): string
  clearError(): void
}

const defaultUid = (): string => Math.random().toString(36).slice(2, 6)

/**
 * Connections are their own little store, not part of the layout store.
 *
 * The layout saves on every change; a connection form must not, because a half-typed secret
 * would be written to the keychain. So this store only talks to the server when the user presses
 * a button, and reloads the whole list afterwards rather than patching it locally — the server
 * masks secrets as booleans, and the reload is what keeps those flags honest.
 */
export function createConnectionsStore(deps: { api: ConnectionsApi; uid?: () => string }): ConnectionsStore {
  const uid = deps.uid ?? defaultUid
  const state = reactive<ConnectionsState>({ types: [], connections: [], loaded: false, busy: false, error: '' })
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  async function refresh(): Promise<void> {
    state.connections = await deps.api.getConnections()
  }

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    state.busy = true
    state.error = ''
    try {
      return await run()
    } catch (e) {
      state.error = message(e)
      throw e
    } finally {
      state.busy = false
    }
  }

  const store: ConnectionsStore = {
    state,

    async load(): Promise<void> {
      await guarded(async () => {
        const [types, connections] = await Promise.all([deps.api.getConnectionTypes(), deps.api.getConnections()])
        state.types = types
        state.connections = connections
        state.loaded = true
      })
    },

    async save(id, input): Promise<void> {
      await guarded(async () => {
        await deps.api.putConnection(id, input)
        await refresh()
      })
    },

    async remove(id): Promise<void> {
      await guarded(async () => {
        await deps.api.deleteConnection(id)
        await refresh()
      })
    },

    test(id, input): Promise<ConnectionTestResult> {
      return guarded(() => deps.api.testConnection(id, input))
    },

    ofType(typeId): ConnectionSummary[] {
      return state.connections.filter((c) => c.type === typeId)
    },

    clearError(): void {
      state.error = ''
    },

    suggestId(typeId): string {
      let candidate = `${typeId}-${uid()}`
      while (state.connections.some((c) => c.id === candidate)) candidate = `${typeId}-${uid()}`
      return candidate
    },
  }

  return store
}

let singleton: ConnectionsStore | null = null

export function useConnectionsStore(): ConnectionsStore {
  if (!singleton) singleton = createConnectionsStore({ api: realApi })
  return singleton
}
