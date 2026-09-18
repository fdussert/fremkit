import { createHash } from 'node:crypto'
import type { Connection } from '../config/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SecretStore } from '../secrets/index.js'
import type { ConnectionTypeRegistry } from './registry.js'

export interface ConnectionManagerDeps {
  registry: ProviderRegistry
  types: ConnectionTypeRegistry
  secrets: SecretStore
}

/**
 * Keeps the provider registry in step with the configured connections.
 *
 * `sync` is called once at boot and on every config change. It diffs on a signature built from
 * the connection's fields and from a *hash* of its secret values, so a changed PAT rebuilds the
 * provider without the secret itself ever being kept around for comparison.
 */
export class ConnectionManager {
  /** channel -> signature of the connection the registered provider was built from. */
  private active = new Map<string, string>()

  /**
   * Serializes `sync`. A sync is a read (the secrets) then a write (the registry and `active`),
   * and the same config change reaches us twice: once from the config listener and once from the
   * route that just wrote the new secret. Overlapping, the slower run would register a provider
   * built from the secret it read first — the old one — and store its signature as current.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ConnectionManagerDeps) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    // Chain onward whatever the outcome: a failed sync must not wedge every later one, and the
    // failure still reaches its own caller through `result`.
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * The channel one connection publishes on. Usually `<type>:<id>`, but a type may declare
   * another family — `ics` publishes calendars, so its channel is `calendar:<id>`. The prefix is
   * read from the registry here and nowhere else, so registering and unregistering cannot drift.
   */
  channelFor(connection: Connection): string {
    const prefix = this.deps.types.get(connection.type)?.channelPrefix ?? connection.type
    return `${prefix}:${connection.id}`
  }

  /** Reads every secret field of a connection. Missing secrets are simply absent from the record. */
  async secretsFor(connection: Connection): Promise<Record<string, string>> {
    const type = this.deps.types.get(connection.type)
    if (!type) return {}
    const out: Record<string, string> = {}
    for (const key of this.deps.types.secretKeys(type)) {
      const value = await this.deps.secrets.get(`${connection.id}/${key}`)
      if (value !== null) out[key] = value
    }
    return out
  }

  /** Deletes every secret of a connection and drops its provider. Runs on the `sync` queue. */
  async forget(connection: Connection): Promise<void> {
    return this.enqueue(async () => {
      const type = this.deps.types.get(connection.type)
      for (const key of type ? this.deps.types.secretKeys(type) : []) {
        await this.deps.secrets.delete(`${connection.id}/${key}`)
      }
      const channel = this.channelFor(connection)
      this.deps.registry.unregister(channel)
      this.active.delete(channel)
    })
  }

  /**
   * Brings the registry in line with `connections`. Calls run one at a time, in the order they
   * were made, and each reads the secrets afresh when its turn comes, so the last caller wins.
   */
  async sync(connections: Connection[]): Promise<void> {
    return this.enqueue(() => this.syncNow(connections))
  }

  private async syncNow(connections: Connection[]): Promise<void> {
    const wanted = new Set<string>()
    for (const connection of connections) {
      const type = this.deps.types.get(connection.type)
      if (!type?.createProvider) continue
      const channel = this.channelFor(connection)
      wanted.add(channel)
      const secrets = await this.secretsFor(connection)
      const signature = this.signature(connection, secrets)
      if (this.active.get(channel) === signature) continue
      this.deps.registry.register(type.createProvider({
        id: connection.id, channel, fields: connection.fields, secrets,
        // Bound to this connection's id, so a provider can only ever write its own secrets —
        // and only under a key its own type declares.
        saveSecret: async (fieldKey, value) => {
          if (!this.deps.types.secretKeys(type).includes(fieldKey)) return
          await this.deps.secrets.set(`${connection.id}/${fieldKey}`, value)
        },
      }))
      this.active.set(channel, signature)
    }
    for (const channel of [...this.active.keys()]) {
      if (wanted.has(channel)) continue
      this.deps.registry.unregister(channel)
      this.active.delete(channel)
    }
  }

  /**
   * Fields in clear, secrets only as a digest: enough to notice a change, useless if leaked.
   * Both halves go through JSON, so a value containing a separator cannot forge a signature.
   */
  private signature(connection: Connection, secrets: Record<string, string>): string {
    const digest = createHash('sha256')
    for (const key of Object.keys(secrets).sort()) digest.update(JSON.stringify([key, secrets[key]]))
    const fields = JSON.stringify(Object.keys(connection.fields).sort().map((k) => [k, connection.fields[k]]))
    return `${connection.type}|${fields}|${digest.digest('hex')}`
  }
}
