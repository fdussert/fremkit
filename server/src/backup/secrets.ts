/**
 * What a restore is allowed to do with the secrets already on this machine.
 *
 * Secrets never travel in an archive — they live in the keychain, keyed by `<connectionId>/<field>`
 * — and the restore keeps the connection ids, which is what lets a backup restored onto the same
 * Mac come back working. That convenience is also the hole: the archive chooses the *fields*, and
 * a connection's host is one of them. An archive naming a connection with the id of one that is
 * already here, and a `host` of the author's choosing, would have the victim's PAT handed to that
 * host on the very next poll — while `reenterSecrets: []` told them everything was fine.
 *
 * The connections API refuses exactly that move (`ConnectionTypeRegistry.bindingErrors`): change a
 * field a secret is bound to and the secret must be re-entered. The restore path went around it.
 * These are the same rule, applied to a whole config instead of one form: a stored secret survives
 * a restore only when the connection it belongs to comes back *identical in every bound field*.
 * Anything else — a changed host, a changed type, an id the live config does not even hold — drops
 * it, and `missingSecrets` then lists the connection as one to re-enter.
 */

import type { Connection } from '../config/schema.js'
import type { ConnectionTypeRegistry } from '../connections/registry.js'
import type { SecretStore } from '../secrets/index.js'

/** `keep`: the secret may stay where it is. `rebind`: the archive moved it, so it goes. */
export type SecretVerdict = 'keep' | 'rebind'

/**
 * Whether the secrets stored under `restored.id` still belong to the connection coming back.
 *
 * `existing` is the connection of the same id in the config as it stands *before* the restore.
 * Its absence is not innocent: it means keychain items survive for an id nothing configured uses,
 * and nothing says which host they were issued for, so they are not handed to whatever the archive
 * decided that id now means.
 */
export function secretVerdict(
  restored: Connection,
  existing: Connection | undefined,
  types: ConnectionTypeRegistry,
): SecretVerdict {
  if (!existing) return 'rebind'
  // A different type reads the fields differently and may not even bind the same ones; the value
  // stored as `token` for a GitHub host has no business reaching a Homey.
  if (existing.type !== restored.type) return 'rebind'
  const type = types.get(restored.type)
  // A type this build does not know builds no provider today, but the next one might, and nothing
  // here can say what its secret is bound to.
  if (!type) return 'rebind'
  for (const key of type.secretBindings ?? []) {
    if ((restored.fields[key] ?? '') !== (existing.fields[key] ?? '')) return 'rebind'
  }
  return 'keep'
}

/** The connections a restore must strip the secrets of, from both ends of the change. */
export interface RestoreSecretPlan {
  /** Coming back, but not as the connection the stored secret was issued for. */
  rebound: Connection[]
  /**
   * The connections *as they were* whose stored secrets no longer belong to anything coming back:
   * the ones the restore drops outright — `syncNow` unregisters their provider and nothing ever
   * dropped their keychain items — and the old side of every rebinding.
   *
   * Both sides are needed because which keys exist is a property of the *type*: an archive that
   * turns a `github` id into a `homey` one would otherwise have `gh/apiKey` deleted while `gh/token`
   * — the PAT — stayed behind for the next archive to claim.
   */
  removed: Connection[]
}

export function restoreSecretPlan(
  before: Connection[],
  after: Connection[],
  types: ConnectionTypeRegistry,
): RestoreSecretPlan {
  const existing = new Map(before.map((c) => [c.id, c]))
  const rebound = after.filter((c) => secretVerdict(c, existing.get(c.id), types) === 'rebind')
  const kept = new Set(after.map((c) => c.id))
  const reboundIds = new Set(rebound.map((c) => c.id))
  const removed = before.filter((c) => !kept.has(c.id) || reboundIds.has(c.id))
  return { rebound, removed }
}

/**
 * Deletes every secret of the connections in a plan.
 *
 * Runs *before* the config is saved, on purpose. Saving notifies the store's listeners, one of
 * which kicks off `ConnectionManager.sync` without waiting for it (`app.ts`), so a deletion after
 * the save races a poll that may already have the secret and the new host in hand. The cost of the
 * order is that a save which then fails leaves the secrets gone — the safe direction to fail in,
 * and the answer already tells the user which ones to type again.
 *
 * A delete that throws is not fatal to the restore, but it is not silently swallowed either: the
 * caller logs it and the connection stays in `reenterSecrets`, because `missingSecrets` asks the
 * store rather than this function.
 */
export async function applyRestoreSecretPlan(
  plan: RestoreSecretPlan,
  types: ConnectionTypeRegistry,
  secrets: SecretStore,
): Promise<void> {
  for (const connection of [...plan.rebound, ...plan.removed]) {
    const type = types.get(connection.type)
    // An unknown type: nothing here knows its field names, so nothing here can name its keys.
    if (!type) continue
    for (const key of types.secretKeys(type)) await secrets.delete(`${connection.id}/${key}`)
  }
}
