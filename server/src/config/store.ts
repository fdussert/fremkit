import { readFile, writeFile, rename, copyFile, mkdir, access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ConfigSchema, DEFAULT_CONFIG, type Config } from './schema.js'
import { migrateConfig } from './migrate.js'
import { normalizeInstances } from './normalize.js'

type Listener = (config: Config) => void

/**
 * Thrown by every write while the config on disk could not be read.
 *
 * A named class rather than a message, so a route can map it to a 409 without matching text.
 */
export class DegradedStoreError extends Error {
  constructor() {
    super('config store is degraded')
    this.name = 'DegradedStoreError'
  }
}

export class ConfigStore {
  private config: Config = structuredClone(DEFAULT_CONFIG)
  private listeners = new Set<Listener>()
  /**
   * True when the file on disk is valid JSON we could not interpret, so the config served here
   * is the default one and NOT what the user wrote. Writing in that state would destroy their
   * layout, so the API refuses to save until a later load succeeds.
   */
  private degradedFlag = false

  constructor(private readonly filePath: string) {}

  /**
   * Load the config in two phases, because the two ways a file can be unusable deserve very
   * different treatment. Bad bytes (unreadable, not JSON) mean the file is lost anyway, so we
   * rescue it aside and rebuild. A file that is valid JSON but that we cannot interpret — an
   * unknown version, a shape a future or half-written release produced — is somebody's layout:
   * we never touch it, we just run on the defaults until a build that understands it starts.
   */
  async load(): Promise<Config> {
    // Cleared here and set again only by the degraded branch below: a successful load is the
    // one and only way out of the degraded state.
    this.degradedFlag = false
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.config = structuredClone(DEFAULT_CONFIG)
        await this.write()
        return this.config
      }
      return this.recover(err as Error)
    }

    let raw: { version?: unknown } | null
    try {
      raw = JSON.parse(text) as { version?: unknown } | null
    } catch (err) {
      return this.recover(err as Error)
    }

    try {
      const needsMigration = raw?.version !== 2
      this.config = normalizeInstances(migrateConfig(raw))
      // write() copies the original to .bak first, so the user's v1 file survives the rewrite.
      if (needsMigration) await this.write()
      return this.config
    } catch (err) {
      console.error(
        `${this.filePath} is valid JSON but cannot be migrated (${(err as Error).message}); ` +
        'leaving it untouched and running on the default config for this session only.',
      )
      this.config = structuredClone(DEFAULT_CONFIG)
      this.degradedFlag = true
      return this.config
    }
  }

  /** True while the in-memory config is a stand-in for a file we could not interpret. */
  get degraded(): boolean { return this.degradedFlag }

  /** Read and validate a config file; throws ENOENT when missing, or a parse/schema error. */
  private async read(path: string): Promise<Config> {
    return normalizeInstances(migrateConfig(JSON.parse(await readFile(path, 'utf8'))))
  }

  /** The main file is unreadable: fall back to the .bak, else to the defaults, keeping the bad file. */
  private async recover(cause: Error): Promise<Config> {
    let recovered: Config | null = null
    try {
      recovered = await this.read(this.filePath + '.bak')
    } catch {
      recovered = null
    }
    // Stamped with an epoch so a second failure never overwrites the first casualty.
    const corrupt = `${this.filePath}.corrupt-${Date.now()}`
    await rename(this.filePath, corrupt).catch(() => undefined)
    this.config = recovered ?? structuredClone(DEFAULT_CONFIG)
    await this.write()
    console.error(
      recovered
        ? `fremkit.json unreadable (${cause.message}); restored from fremkit.json.bak, bad file kept as ${corrupt}`
        : `fremkit.json unreadable (${cause.message}) and no usable fremkit.json.bak; falling back to the default config, bad file kept as ${corrupt}`,
    )
    return this.config
  }

  get(): Config { return this.config }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Serializes mutations. A save is a read (in the caller), a change, then a write; two
   * overlapping ones would each start from the same snapshot and silently drop the other's change.
   */
  private queue: Promise<unknown> = Promise.resolve()

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    // Chain onward whatever the outcome: a rejected mutation must not wedge every later one,
    // and the failure still reaches its own caller through `result`.
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async save(input: unknown): Promise<Config> {
    return this.enqueue(() => this.commit(input))
  }

  /**
   * Read-modify-write under the same queue: `fn` receives a copy of the config as it stands when
   * its turn comes, so two concurrent updates compose instead of overwriting one another. A `fn`
   * that throws leaves the config and the file untouched, because nothing is committed.
   */
  async update(fn: (config: Config) => Config | Promise<Config>): Promise<Config> {
    return this.enqueue(async () => this.commit(await fn(structuredClone(this.config))))
  }

  private async commit(input: unknown): Promise<Config> {
    // The one gate every write passes. While the store is degraded the config held in memory is
    // the default one, not the user's: writing it would overwrite a dashboard we merely failed to
    // read. `PUT /api/config` refuses before it gets here, but the connections API went straight
    // to `update()` and would have flattened the file.
    if (this.degradedFlag) throw new DegradedStoreError()
    const parsed = normalizeInstances(ConfigSchema.parse(input))
    this.config = parsed
    await this.write()
    // Listeners run inside the queue's turn: one that calls back into `save`/`update` would
    // deadlock, so a listener must only ever kick work off (see app.ts's `void connections.sync`).
    for (const cb of this.listeners) cb(parsed)
    return parsed
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const exists = await access(this.filePath).then(() => true, () => false)
    if (exists) await copyFile(this.filePath, this.filePath + '.bak')
    const tmp = this.filePath + '.tmp'
    await writeFile(tmp, JSON.stringify(this.config, null, 2) + '\n', 'utf8')
    await rename(tmp, this.filePath)
  }
}
