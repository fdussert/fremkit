/**
 * Putting a whole config in place of the live one: what a backup restore and a restore from the
 * history (`config/history-routes.ts`) both do once they hold a config to apply.
 *
 * One function so the two cannot drift apart on what matters: what an incoming config does not get
 * to decide, and what happens to the secrets already on this Mac.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config/schema.js'
import { DegradedStoreError, type ConfigStore, type SaveOptions } from '../config/store.js'
import { migrateHomeySecret } from '../config/migrate.js'
import type { ConnectionTypeRegistry } from '../connections/registry.js'
import type { SecretStore } from '../secrets/index.js'
import { applyRestoreSecretPlan, restoreSecretPlan } from './secrets.js'
import { missingSecrets, type MissingSecret } from './routes.js'

export interface ApplyConfigDeps {
  store: ConfigStore
  types: ConnectionTypeRegistry
  secrets: SecretStore
  onRestored?: (config: Config) => Promise<void> | void
}

/** Why an apply failed, for the route to turn into a status and a translated message. */
export type ApplyFailure = 'degraded' | 'secrets' | 'invalid'

export type ApplyResult =
  | { ok: true; saved: Config; reenterSecrets: MissingSecret[] }
  | { ok: false; failure: ApplyFailure }

/**
 * Applies `incoming` (already migrated) as the dashboard. Mutates it: the security settings are
 * this Mac's, whatever it says.
 */
export async function applyConfig(deps: ApplyConfigDeps, incoming: Config, save: SaveOptions, log: FastifyBaseLogger): Promise<ApplyResult> {
  const { store } = deps
  // What an incoming config does not get to decide: where secrets are kept (`file` would move
  // every new one to plaintext), what the user agreed to share (`privacy` turns on reading account
  // tokens), and what each installed widget was granted (`marketplace.installed`, shares
  // included). A backup is a file anyone can hand over, and an old version of this Mac's own
  // config predates choices the user has made since; these stay as they are now.
  const here = store.get()
  incoming.secrets = here.secrets
  incoming.privacy = here.privacy
  // The experimental features are a choice made on this Mac too, not something a file brings.
  incoming.labs = here.labs
  incoming.marketplace = { ...incoming.marketplace, installed: here.marketplace.installed }

  // Before the save, and before anything can poll with the restored fields: a stored secret is
  // tied to the host it was issued for, and the incoming config chooses the hosts. See secrets.ts.
  const plan = restoreSecretPlan(here.connections, incoming.connections, deps.types)
  if (plan.rebound.length || plan.removed.length) {
    try {
      await applyRestoreSecretPlan(plan, deps.types, deps.secrets)
    } catch (err) {
      log.warn({ err }, 'restore could not drop the secrets the incoming config rebinds')
      return { ok: false, failure: 'secrets' }
    }
  }

  // Through the store, which keeps its own `.bak` and its history, and validates on the way in.
  let saved: Config
  try {
    saved = await store.save(incoming, save)
  } catch (err) {
    if (err instanceof DegradedStoreError) return { ok: false, failure: 'degraded' }
    log.warn({ err }, 'restore could not save the config')
    return { ok: false, failure: 'invalid' }
  }
  // A restored Homey connection's key may still sit in the keychain under the field name the coded
  // type used. Move it before anything asks whether it is there — otherwise the answer names a
  // connection whose key never went anywhere.
  await migrateHomeySecret(saved, deps.secrets).catch((err: unknown) => {
    log.warn({ err }, 'restore could not move the Homey key to its new field')
  })
  await deps.onRestored?.(saved)
  // Only the connections whose secret is actually absent: on the same Mac the keychain items are
  // keyed by the ids the config carries, so most restores need nothing typed in. The ones the plan
  // above just stripped are absent now, so they are named here without a second list.
  return { ok: true, saved, reenterSecrets: await missingSecrets(saved, deps.types, deps.secrets) }
}
