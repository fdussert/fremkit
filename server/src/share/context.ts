import type { Config, Connection } from '../config/schema.js'
import { hostOf, type RedactionContext } from '../diagnostics/redact.js'
import { readSystemFacts, type SystemFacts } from '../diagnostics/report.js'

export interface ShareRedactionDeps {
  secretsFor(connection: Connection): Promise<Record<string, string>>
  devices(): { name: string }[]
  accessToken?: string | null
  /** Test seam: the Mac's names, home and account, read from the system otherwise. */
  system?: Pick<SystemFacts, 'machineNames' | 'home' | 'username'>
}

/**
 * What a shared layout must never carry, gathered the way the diagnostics report gathers it:
 * every connection's secrets and hosts, the names given to connections, paired devices and the
 * screens made for them, the Mac's own names, the home folder and the account name.
 *
 * The shapes — e-mail addresses, IPs, LAN host names, tokens — are `redact()`'s own and need no
 * context. A keychain that will not answer leaves them to catch what it would have named.
 */
export async function shareRedaction(config: Config, deps: ShareRedactionDeps): Promise<RedactionContext> {
  const secrets: string[] = []
  const hosts: string[] = []
  const names: string[] = []
  for (const connection of config.connections) {
    try { secrets.push(...Object.values(await deps.secretsFor(connection))) } catch { /* the shapes still apply */ }
    for (const value of Object.values(connection.fields)) {
      const host = hostOf(value)
      if (host) hosts.push(host)
    }
    names.push(connection.name)
  }
  names.push(...deps.devices().map((d) => d.name))
  names.push(...config.screens.filter((s) => s.kind === 'device').map((s) => s.name))
  if (deps.accessToken) secrets.push(deps.accessToken)
  const system = deps.system ?? await readSystemFacts()
  // A name equal to a widget or connection type id would blank that id's every mention, as in
  // the diagnostics: the id says nothing about the user, and such a name is worth no more.
  const reserved = new Set([
    ...config.connections.map((c) => c.type),
    ...Object.values(config.widgets).map((w) => w.widgetId),
  ].map((v) => v.toLowerCase()))
  return {
    secrets, hosts,
    names: names.filter((n) => !reserved.has(n.trim().toLowerCase())),
    machineNames: system.machineNames,
    home: system.home,
    username: system.username,
  }
}
