import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/** Owner read/write only: the file holds the hashes of the device tokens. */
const MODE = 0o600

/** `lastSeen` is written at most this often per device, so a busy iPad does not churn the disk. */
const TOUCH_INTERVAL_MS = 60_000

export const ViewportSchema = z.object({
  width: z.number().int().min(1).max(10000),
  height: z.number().int().min(1).max(10000),
})

/** A browser extension's origin: `chrome-extension://` and the 32 letters of its id. */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/

const BaseFields = {
  id: z.string().min(1),
  name: z.string(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  pairedAt: z.string(),
  lastSeen: z.string().nullable(),
}

const IpadSchema = z.object({
  ...BaseFields,
  kind: z.literal('ipad'),
  viewport: ViewportSchema,
  screenId: z.string().nullable(),
})

const ExtensionSchema = z.object({
  ...BaseFields,
  kind: z.literal('extension'),
  origin: z.string().regex(EXTENSION_ORIGIN),
  installId: z.string().uuid(),
})

/** What a caller may hand `createExtension`: the fields the loader would validate on the next start. */
const ExtensionInputSchema = ExtensionSchema.pick({ name: true, origin: true, installId: true })

const DeviceSchema = z.discriminatedUnion('kind', [IpadSchema, ExtensionSchema])

/** A version 1 record has no `kind`: every one of them is an iPad. */
const LegacyDeviceSchema = z.object({ ...BaseFields, viewport: ViewportSchema, screenId: z.string().nullable() })
  .transform((d) => ({ ...d, kind: 'ipad' as const }))

const FileSchema = z.union([
  z.object({ version: z.literal(2), enabled: z.boolean(), devices: z.array(DeviceSchema) }),
  z.object({ version: z.literal(1), enabled: z.boolean(), devices: z.array(LegacyDeviceSchema) }),
])

export type Viewport = z.infer<typeof ViewportSchema>
export type IpadDevice = z.infer<typeof IpadSchema>
export type ExtensionDevice = z.infer<typeof ExtensionSchema>
export type Device = IpadDevice | ExtensionDevice
export type PublicIpadDevice = Omit<IpadDevice, 'tokenHash'>
export type PublicExtensionDevice = Omit<ExtensionDevice, 'tokenHash'>
export type PublicDevice = PublicIpadDevice | PublicExtensionDevice

type State = { enabled: boolean; devices: Device[] }

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function toPublic(device: Device): PublicDevice {
  const { tokenHash: _omit, ...rest } = device
  return rest.kind === 'ipad' ? { ...rest, viewport: { ...rest.viewport } } : { ...rest }
}

/**
 * The paired devices, in `<dataDir>/devices.json`.
 *
 * The state lives in memory once loaded, so `findByToken` (called on every remote request) never
 * touches the disk. Every mutation builds the next state, writes it atomically, and only then
 * replaces the in-memory one: a failed write leaves memory and disk agreeing.
 */
export class DeviceStore {
  private state: State = { enabled: false, devices: [] }
  private readonly listeners = new Set<(devices: PublicDevice[]) => void>()

  // Serializes mutations, the same pattern as `secrets/file.ts`: two overlapping mutations would
  // otherwise both start from the same state and the second write would drop the first's change.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Resolves once every mutation queued so far has finished (failed ones included). For tests: a
   * write nobody awaited (`touch` on hello, a sweep's `remove`) must land before its folder goes.
   */
  settled(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  /** Reads the file. Missing means disabled and empty; corrupt is moved aside and starts empty. */
  async load(): Promise<void> {
    return this.enqueue(async () => {
      let raw: string
      try {
        raw = await readFile(this.filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.state = { enabled: false, devices: [] }
          return
        }
        throw err
      }
      let parsed: z.infer<typeof FileSchema> | null = null
      try {
        const result = FileSchema.safeParse(JSON.parse(raw))
        if (result.success) parsed = result.data
      } catch {
        parsed = null
      }
      if (!parsed) {
        // Kept rather than deleted, so a hand-edit gone wrong can still be recovered.
        await rename(this.filePath, `${this.filePath}.corrupt`)
        this.state = { enabled: false, devices: [] }
        return
      }
      this.state = { enabled: parsed.enabled, devices: parsed.devices as Device[] }
    })
  }

  get enabled(): boolean {
    return this.state.enabled
  }

  async setEnabled(on: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.enabled === on) return
      await this.commit({ ...this.state, enabled: on })
    })
  }

  list(): PublicDevice[] {
    return this.state.devices.map(toPublic)
  }

  /** Whether a device with this id is paired right now. */
  has(id: string): boolean {
    return this.state.devices.some((d) => d.id === id)
  }

  /** Pairs a device. The token is returned once, here, and only its hash is ever stored. */
  async create(
    name: string,
    viewport: Viewport,
    screenId: string | null,
  ): Promise<{ device: PublicDevice; token: string }> {
    return this.enqueue(async () => {
      const token = randomBytes(32).toString('base64url')
      const device: IpadDevice = {
        id: randomUUID(),
        kind: 'ipad',
        name,
        tokenHash: hashToken(token),
        pairedAt: this.now().toISOString(),
        lastSeen: null,
        viewport: { width: viewport.width, height: viewport.height },
        screenId,
      }
      await this.commit({ ...this.state, devices: [...this.state.devices, device] })
      return { device: toPublic(device), token }
    })
  }

  /**
   * Pairs a browser extension. An install that pairs again (same origin and install id) replaces
   * its record, so its old token stops working and the list holds one entry per install.
   */
  async createExtension(input: {
    name: string
    origin: string
    installId: string
  }): Promise<{ device: PublicDevice; token: string }> {
    // Parsed before anything is written: a record the loader would refuse makes the next start
    // move the whole file aside as corrupt, and every paired iPad with it.
    const checked = ExtensionInputSchema.parse(input)
    return this.enqueue(async () => {
      const token = randomBytes(32).toString('base64url')
      const device: ExtensionDevice = {
        id: randomUUID(),
        kind: 'extension',
        name: checked.name,
        tokenHash: hashToken(token),
        pairedAt: this.now().toISOString(),
        lastSeen: null,
        origin: checked.origin,
        installId: checked.installId,
      }
      const kept = this.state.devices.filter(
        (d) => !(d.kind === 'extension' && d.origin === checked.origin && d.installId === checked.installId),
      )
      await this.commit({ ...this.state, devices: [...kept, device] })
      return { device: toPublic(device), token }
    })
  }

  /**
   * The device of this kind a token belongs to, or null. The candidate is hashed and compared against every
   * stored hash in constant time, with no early exit, so timing reveals neither the match nor
   * which device it was.
   */
  findByToken(token: string, kind: Device['kind']): PublicDevice | null {
    const candidate = Buffer.from(hashToken(token), 'utf8')
    let found: Device | null = null
    for (const device of this.state.devices) {
      const stored = Buffer.from(device.tokenHash, 'utf8')
      // The schema pins every stored hash to 64 hex characters, as is the candidate's, so the
      // lengths always match; the guard only keeps timingSafeEqual from throwing.
      const same = stored.length === candidate.length && timingSafeEqual(stored, candidate)
      if (same && !found) found = device
    }
    return found && found.kind === kind ? toPublic(found) : null
  }

  /**
   * The key an extension's socket proof is signed with: the 32 raw bytes of its token's sha256,
   * which the extension can recompute from the token and nobody else can. Null when the id names
   * no record, or one that is not an extension.
   */
  extensionProofKey(id: string): { key: Buffer; origin: string } | null {
    const device = this.state.devices.find((d) => d.id === id)
    if (!device || device.kind !== 'extension') return null
    return { key: Buffer.from(device.tokenHash, 'hex'), origin: device.origin }
  }

  async update(id: string, patch: { name?: string; screenId?: string | null }): Promise<PublicDevice | null> {
    return this.enqueue(async () => {
      const index = this.state.devices.findIndex((d) => d.id === id)
      if (index < 0) return null
      const next: Device = { ...this.state.devices[index] }
      if (patch.name !== undefined) next.name = patch.name
      // A screen is an iPad's: an extension record keeps only its name.
      if (patch.screenId !== undefined && next.kind === 'ipad') next.screenId = patch.screenId
      const devices = [...this.state.devices]
      devices[index] = next
      await this.commit({ ...this.state, devices })
      return toPublic(next)
    })
  }

  /**
   * Takes a device off `screenId`, only if it is still on it when its turn in the queue comes: a
   * device the user attached elsewhere in the meantime keeps its new screen. True when it wrote.
   */
  async detach(id: string, screenId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = this.state.devices.findIndex((d) => d.id === id)
      const current = this.state.devices[index]
      if (index < 0 || current.kind !== 'ipad' || current.screenId !== screenId) return false
      const devices = [...this.state.devices]
      devices[index] = { ...current, screenId: null }
      await this.commit({ ...this.state, devices })
      return true
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const devices = this.state.devices.filter((d) => d.id !== id)
      if (devices.length === this.state.devices.length) return false
      await this.commit({ ...this.state, devices })
      return true
    })
  }

  /**
   * Every iPad, and only iPads: what "remove every iPad" and a certificate reset take away. A
   * browser extension has nothing to do with the TLS key and is removed from its own row. Answers
   * the ids removed.
   */
  async removeIpads(): Promise<string[]> {
    return this.enqueue(async () => {
      const ids = this.state.devices.filter((d) => d.kind === 'ipad').map((d) => d.id)
      if (ids.length === 0) return []
      await this.commit({ ...this.state, devices: this.state.devices.filter((d) => d.kind !== 'ipad') })
      return ids
    })
  }

  /**
   * Records that a device was seen, writing only when the stored `lastSeen` is a minute old. A
   * `lastSeen` in the future (the clock stepped back) or unreadable counts as stale: otherwise
   * the device would look unseen until the clock caught up with it again.
   */
  async touch(id: string): Promise<void> {
    return this.enqueue(async () => {
      const index = this.state.devices.findIndex((d) => d.id === id)
      if (index < 0) return
      const now = this.now()
      const last = this.state.devices[index].lastSeen
      const age = last === null ? Number.NaN : now.getTime() - Date.parse(last)
      if (age >= 0 && age < TOUCH_INTERVAL_MS) return
      const devices = [...this.state.devices]
      devices[index] = { ...devices[index], lastSeen: now.toISOString() }
      await this.commit({ ...this.state, devices })
    })
  }

  /** Called with the public device list after every successful write. Returns an unsubscribe. */
  onChange(cb: (devices: PublicDevice[]) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private async commit(next: State): Promise<void> {
    await this.write(next)
    this.state = next
    const devices = this.list()
    for (const cb of this.listeners) {
      try {
        cb(devices)
      } catch {
        // A listener's failure must not turn a successful write into a failed mutation.
      }
    }
  }

  private async write(state: State): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    const body = { version: 2, enabled: state.enabled, devices: state.devices }
    // The mode is given at creation *and* forced afterwards: `writeFile` only applies `mode`
    // when it creates the file, so a leftover temporary from a crashed run would keep its own.
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: MODE })
    await chmod(tmp, MODE)
    await rename(tmp, this.filePath)
  }
}
