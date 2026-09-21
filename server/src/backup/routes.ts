import type { FastifyInstance } from 'fastify'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeBackgroundName, type Config } from '../config/schema.js'
import { migrateConfig } from '../config/migrate.js'
import { DegradedStoreError, type ConfigStore } from '../config/store.js'
import { detectImageType, MAX_BACKGROUND_BYTES } from '../backgrounds/routes.js'
import { isCrossSiteFetch } from '../http/guard.js'
import { FREMKIT_VERSION } from '../version.js'
import type { ConnectionTypeRegistry } from '../connections/registry.js'
import type { SecretStore } from '../secrets/index.js'
import { readZip, writeZip, ZipError } from './zip.js'
import { applyRestoreSecretPlan, restoreSecretPlan } from './secrets.js'
import { migrateHomeySecret } from '../config/migrate.js'
import { tr } from '../i18n.js'

/**
 * Taking the whole dashboard out and putting it back.
 *
 * What travels: the live config as the store has migrated it, and the background library. What
 * never travels: the secrets. They live in the macOS keychain, keyed by connection id, and the
 * whole point of putting them there is that a file copied to a USB stick does not carry them.
 *
 * Keyed by connection id, though — and a restore keeps the ids. So on the same Mac the items are
 * still there and the connections work straight away, which is why the answer asks the store which
 * secrets are genuinely absent instead of naming them all. The price of that convenience is that
 * the archive chooses the *fields*, a host among them; `backup/secrets.ts` is what keeps a stored
 * secret from following a connection to a host the archive picked.
 */

/** Where things sit inside the archive. */
export const CONFIG_ENTRY = 'fremkit.json'
export const BACKGROUNDS_PREFIX = 'backgrounds/'
export const MANIFEST_ENTRY = 'manifest.json'

/** Largest archive accepted. The background library is the bulk of it. */
export const MAX_RESTORE_BYTES = 50 * 1024 * 1024
/** Most files an archive may hold: one config, one manifest, and a large but finite library. */
const MAX_ENTRIES = 256

/** What the manifest records. Informational — the restore trusts the config, not this. */
export interface BackupManifest {
  fremkitVersion: string
  createdAt: string
  configVersion: number
  secrets: 'excluded'
}

/** A connection whose secret did not come back, for the admin to list. */
export interface MissingSecret { id: string; name: string; type: string }

/** `fremkit-backup-2026-09-18.zip` */
export function backupFilename(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `fremkit-backup-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}.zip`
}

/**
 * The entries a restore will act on, or a reason to refuse the archive.
 *
 * Every name is judged, never joined blindly: `isSafeBackgroundName` already refuses a path
 * separator, a leading dot and `..`, which is what keeps an entry called
 * `backgrounds/../../../.ssh/authorized_keys` from becoming a write. Backgrounds are also
 * identified by their magic bytes, exactly as the upload route does, so an archive cannot smuggle
 * a script in under a `.png` name.
 */
export function readBackup(archive: Buffer): {
  config: Config
  backgrounds: { name: string; data: Buffer }[]
} {
  const entries = readZip(archive, { maxEntries: MAX_ENTRIES, maxTotalBytes: MAX_RESTORE_BYTES })
  const config = entries.find((e) => e.name === CONFIG_ENTRY)
  if (!config) throw new ZipError(tr(undefined, 'backup.noConfig'))

  let raw: unknown
  try { raw = JSON.parse(config.data.toString('utf8')) } catch { throw new ZipError(tr(undefined, 'backup.badConfig')) }
  // Through the migrations, so a v1 backup restores as v2 rather than being refused.
  let migrated: Config
  try { migrated = migrateConfig(raw) } catch { throw new ZipError(tr(undefined, 'backup.badConfig')) }

  const backgrounds: { name: string; data: Buffer }[] = []
  for (const entry of entries) {
    if (entry.name === CONFIG_ENTRY || entry.name === MANIFEST_ENTRY) continue
    if (!entry.name.startsWith(BACKGROUNDS_PREFIX)) continue
    // A directory entry, which carries no bytes.
    if (entry.name.endsWith('/')) continue
    const name = entry.name.slice(BACKGROUNDS_PREFIX.length)
    if (!isSafeBackgroundName(name)) throw new ZipError(tr(undefined, 'backup.badName'))
    if (entry.data.byteLength > MAX_BACKGROUND_BYTES) throw new ZipError(tr(undefined, 'backup.imageTooLarge'))
    if (!detectImageType(entry.data)) throw new ZipError(tr(undefined, 'backup.notAnImage'))
    backgrounds.push({ name, data: entry.data })
  }
  return { config: migrated, backgrounds }
}

/**
 * The connections whose secret is genuinely not there after a restore.
 *
 * Not simply "all of them". Secrets are keyed by connection id, and a restore keeps those ids —
 * so restoring onto the *same* Mac with the keychain backend finds the existing items and every
 * connection works straight away. Which is the common case: trying a from-scratch install.
 *
 * On another Mac, or with the file backend and a fresh data directory, they are missing, and
 * those are the ones worth naming. So the store is asked rather than assumed.
 */
export async function missingSecrets(
  config: Config,
  types: ConnectionTypeRegistry,
  secrets: SecretStore,
): Promise<MissingSecret[]> {
  const out: MissingSecret[] = []
  for (const connection of config.connections) {
    const type = types.get(connection.type)
    if (!type) continue
    const keys = types.secretKeys(type)
    // A type with no secret at all needs nothing entered.
    if (!keys.length) continue
    let complete = true
    for (const key of keys) {
      if ((await secrets.get(`${connection.id}/${key}`)) === null) { complete = false; break }
    }
    if (!complete) out.push({ id: connection.id, name: connection.name, type: connection.type })
  }
  return out
}

export async function backupRoutes(
  app: FastifyInstance,
  opts: {
    store: ConfigStore
    dataDir: string
    types: ConnectionTypeRegistry
    secrets: SecretStore
    onRestored?: (config: Config) => Promise<void> | void
  },
): Promise<void> {
  const { store, dataDir } = opts
  const backgroundsDir = join(dataDir, 'backgrounds')

  /**
   * `GET /api/backup` — the whole dashboard as a zip.
   *
   * A GET that hands back every page, every widget's settings and every connection's non-secret
   * fields, so a page on another site must not be able to trigger it: same `Sec-Fetch-Site`
   * refusal as `/api/favicon`. The byte-route headers come from the global hook in app.ts.
   */
  app.get('/api/backup', async (req, reply) => {
    if (isCrossSiteFetch(req.headers)) return reply.code(403).send({ error: tr(store.get().locale, 'http.originNotAllowed') })

    const config = store.get()
    const when = new Date()
    const manifest: BackupManifest = {
      fremkitVersion: FREMKIT_VERSION,
      createdAt: when.toISOString(),
      configVersion: config.version,
      secrets: 'excluded',
    }
    const entries = [
      { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
      { name: CONFIG_ENTRY, data: Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8') },
    ]
    let names: string[] = []
    try { names = await readdir(backgroundsDir) } catch { /* no library yet */ }
    for (const name of names.sort()) {
      if (!isSafeBackgroundName(name)) continue
      try {
        const data = await readFile(join(backgroundsDir, name))
        entries.push({ name: BACKGROUNDS_PREFIX + name, data })
      } catch { /* vanished between the listing and the read */ }
    }

    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${backupFilename(when)}"`)
      .header('cache-control', 'no-store')
      .send(writeZip(entries, when))
  })

  /**
   * `POST /api/restore` — replace the dashboard with the one in the archive.
   *
   * The raw zip as the body, not multipart: there is exactly one file, and a parser for a format
   * with boundaries is a thing to get wrong for no gain. Origin-gated like every other write by
   * the global hook, and refused outright while the store is degraded, because the store would
   * refuse the commit anyway and doing it here says why.
   */
  // The archive arrives as raw bytes. Registered for this plugin only, so the rest of the API
  // keeps refusing a body it has no parser for.
  app.addContentTypeParser(
    ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
    { parseAs: 'buffer', bodyLimit: MAX_RESTORE_BYTES },
    (_req, body, done) => { done(null, body) },
  )

  app.post('/api/restore', { bodyLimit: MAX_RESTORE_BYTES }, async (req, reply) => {
    if (store.degraded) {
      return reply.code(409).send({ errors: [tr(store.get().locale, 'config.degraded')] })
    }
    const body = req.body
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      return reply.code(400).send({ errors: [tr(store.get().locale, 'backup.noArchive')] })
    }

    let read: ReturnType<typeof readBackup>
    try {
      read = readBackup(body)
    } catch (err) {
      const message = err instanceof ZipError ? err.message : tr(store.get().locale, 'backup.badArchive')
      req.log.warn({ name: (err as Error).name }, 'restore refused')
      return reply.code(400).send({ errors: [message] })
    }

    // The backgrounds first: the config may name one, and a dashboard that points at an image
    // which is not there yet would paint a missing background for a moment. The cost is that a
    // restore refused *after* this point — a config the store will not take — leaves the archive's
    // images in the library beside the user's own. They are ordinary files in a list the Screen
    // inspector shows, so the user can delete them; nothing references them, so nothing changes on
    // screen. The other order would trade that for a visible flash on every successful restore.
    try {
      await mkdir(backgroundsDir, { recursive: true })
      for (const image of read.backgrounds) await writeFile(join(backgroundsDir, image.name), image.data)
    } catch (err) {
      req.log.warn({ err }, 'restore could not write the backgrounds')
      return reply.code(500).send({ errors: [tr(store.get().locale, 'backup.writeFailed')] })
    }

    // Before the save, and before anything can poll with the restored fields: a stored secret is
    // tied to the host it was issued for, and the archive chooses the hosts. See backup/secrets.ts.
    const plan = restoreSecretPlan(store.get().connections, read.config.connections, opts.types)
    if (plan.rebound.length || plan.removed.length) {
      try {
        await applyRestoreSecretPlan(plan, opts.types, opts.secrets)
      } catch (err) {
        req.log.warn({ err }, 'restore could not drop the secrets the archive rebinds')
        return reply.code(500).send({ errors: [tr(store.get().locale, 'backup.writeFailed')] })
      }
    }

    // Through the store, which keeps its own `.bak` of what was there and validates on the way in.
    let saved: Config
    try {
      saved = await store.save(read.config)
    } catch (err) {
      if (err instanceof DegradedStoreError) {
        return reply.code(409).send({ errors: [tr(store.get().locale, 'config.degraded')] })
      }
      req.log.warn({ err }, 'restore could not save the config')
      return reply.code(400).send({ errors: [tr(store.get().locale, 'backup.badConfig')] })
    }
    // A backup carries no secrets, so a restored Homey connection's key is still sitting in the
    // keychain under the field name the coded type used. Move it before anything asks whether it
    // is there — otherwise the answer names a connection whose key never went anywhere.
    await migrateHomeySecret(saved, opts.secrets).catch((err: unknown) => {
      req.log.warn({ err }, 'restore could not move the Homey key to its new field')
    })
    await opts.onRestored?.(saved)

    // Only the connections whose secret is actually absent: on the same Mac the keychain items
    // are keyed by the ids the archive carries, so most restores need nothing typed in. The ones
    // the plan above just stripped are absent now, so they are named here without a second list.
    return reply.send({
      ok: true,
      pages: saved.pages.length,
      backgrounds: read.backgrounds.length,
      reenterSecrets: await missingSecrets(saved, opts.types, opts.secrets),
    })
  })
}
