import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore } from '../src/devices/store.js'

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'fremkit-devices-')), 'devices.json')
}

const viewport = { width: 1180, height: 820 }

/** The screen of the first listed device, which these tests pair as an iPad. */
function firstScreen(store: DeviceStore): string | null | undefined {
  const [first] = store.list()
  return first.kind === 'ipad' ? first.screenId : undefined
}

describe('DeviceStore', () => {
  it('starts disabled and empty when the file is missing', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    expect(store.enabled).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('round-trips a created device through a reload', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file, () => new Date('2026-10-18T10:00:00.000Z'))
    await store.load()
    await store.setEnabled(true)
    const { device, token } = await store.create('Kitchen iPad', viewport, 'screen-1')
    expect(device).toEqual({
      id: expect.any(String),
      kind: 'ipad',
      name: 'Kitchen iPad',
      pairedAt: '2026-10-18T10:00:00.000Z',
      lastSeen: null,
      viewport,
      screenId: 'screen-1',
    })
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    const again = new DeviceStore(file)
    await again.load()
    expect(again.enabled).toBe(true)
    expect(again.list()).toEqual([device])
    expect(again.findByToken(token, 'ipad')).toEqual(device)
  })

  it('writes the file with mode 0600 and stores only the token hash', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    const { token } = await store.create('iPad', viewport, null)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(token)
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(2)
    expect(parsed.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never exposes tokenHash from list()', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    await store.create('A', viewport, null)
    await store.create('B', viewport, null)
    for (const d of store.list()) expect(d).not.toHaveProperty('tokenHash')
  })

  it('finds a device by its token and nothing by any other', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const a = await store.create('A', viewport, null)
    const b = await store.create('B', viewport, null)
    expect(store.findByToken(a.token, 'ipad')?.id).toBe(a.device.id)
    expect(store.findByToken(b.token, 'ipad')?.id).toBe(b.device.id)
    expect(store.findByToken(a.token + 'x', 'ipad')).toBeNull()
    expect(store.findByToken('', 'ipad')).toBeNull()
    expect(store.findByToken('not-a-token', 'ipad')).toBeNull()
    expect(store.findByToken(a.token, 'ipad')).not.toHaveProperty('tokenHash')
  })

  it('writes lastSeen at most once a minute', async () => {
    const file = await tempFile()
    let t = Date.parse('2026-10-18T10:00:00.000Z')
    const store = new DeviceStore(file, () => new Date(t))
    await store.load()
    const { device } = await store.create('iPad', viewport, null)
    let writes = 0
    store.onChange(() => writes++)

    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:00:00.000Z')

    t += 59_000
    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:00:00.000Z')

    t += 2_000
    await store.touch(device.id)
    expect(writes).toBe(2)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T10:01:01.000Z')
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeen).toBe('2026-10-18T10:01:01.000Z')

    await store.touch('unknown')
    expect(writes).toBe(2)
  })

  it('detaches a device only from the screen it is still on', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const { device } = await store.create('iPad', viewport, 'old')
    expect(await store.detach(device.id, 'other')).toBe(false)
    expect(firstScreen(store)).toBe('old')
    expect(await store.detach('unknown', 'old')).toBe(false)
    expect(await store.detach(device.id, 'old')).toBe(true)
    expect(firstScreen(store)).toBeNull()
  })

  it('lets an attach queued first win over a detach from the old screen', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const { device } = await store.create('iPad', viewport, 'old')
    const [attached, detached] = await Promise.all([
      store.update(device.id, { screenId: 'new' }),
      store.detach(device.id, 'old'),
    ])
    expect(attached?.kind === 'ipad' ? attached.screenId : undefined).toBe('new')
    expect(detached).toBe(false)
    expect(firstScreen(store)).toBe('new')
  })

  it('writes lastSeen again when the clock stepped back behind it', async () => {
    const file = await tempFile()
    let t = Date.parse('2026-10-18T10:00:00.000Z')
    const store = new DeviceStore(file, () => new Date(t))
    await store.load()
    const { device } = await store.create('iPad', viewport, null)
    await store.touch(device.id)
    let writes = 0
    store.onChange(() => writes++)

    // An hour back: the stored lastSeen is now in the future.
    t -= 3_600_000
    await store.touch(device.id)
    expect(writes).toBe(1)
    expect(store.list()[0].lastSeen).toBe('2026-10-18T09:00:00.000Z')
    // And from there on, the minute counts again from the corrected time.
    t += 30_000
    await store.touch(device.id)
    expect(writes).toBe(1)
  })

  it('moves a corrupt file aside and starts empty', async () => {
    const file = await tempFile()
    await writeFile(file, '{ not json')
    const store = new DeviceStore(file)
    await store.load()
    expect(store.enabled).toBe(false)
    expect(store.list()).toEqual([])
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe('{ not json')
  })

  it('treats a file that fails the schema as corrupt', async () => {
    const file = await tempFile()
    const bad = JSON.stringify({ version: 1, enabled: true, devices: [{ id: 'x' }] })
    await writeFile(file, bad)
    const store = new DeviceStore(file)
    await store.load()
    expect(store.list()).toEqual([])
    expect(await readFile(`${file}.corrupt`, 'utf8')).toBe(bad)
  })

  it('updates, removes and clears the iPads', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    const a = await store.create('A', viewport, null)
    const b = await store.create('B', viewport, null)

    expect(await store.update('unknown', { name: 'X' })).toBeNull()
    const updated = await store.update(a.device.id, { name: 'Hall', screenId: 'screen-2' })
    expect(updated).toMatchObject({ id: a.device.id, name: 'Hall', screenId: 'screen-2' })
    expect(updated).not.toHaveProperty('tokenHash')
    expect(await store.update(a.device.id, { screenId: null })).toMatchObject({ name: 'Hall', screenId: null })

    expect(await store.remove('unknown')).toBe(false)
    expect(await store.remove(b.device.id)).toBe(true)
    expect(store.findByToken(b.token, 'ipad')).toBeNull()
    expect(store.list().map((d) => d.id)).toEqual([a.device.id])

    const ext = await store.createExtension({ name: 'Chrome', origin: `chrome-extension://${'h'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d' })
    expect(await store.removeIpads()).toEqual([a.device.id])
    // The extension stays, token included: it pins no key and is removed from its own row.
    expect(store.list().map((d) => d.id)).toEqual([ext.device.id])
    expect(store.findByToken(ext.token, 'extension')).toMatchObject({ id: ext.device.id })
    expect(await store.removeIpads()).toEqual([])
    const again = new DeviceStore(file)
    await again.load()
    expect(again.list().map((d) => d.id)).toEqual([ext.device.id])
  })

  it('serializes concurrent mutations', async () => {
    const file = await tempFile()
    const store = new DeviceStore(file)
    await store.load()
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.create(`D${n}`, viewport, null)))
    const again = new DeviceStore(file)
    await again.load()
    expect(again.list().map((d) => d.name).sort()).toEqual(['D1', 'D2', 'D3', 'D4', 'D5'])
  })

  it('notifies listeners after a write, with public devices, until unsubscribed', async () => {
    const store = new DeviceStore(await tempFile())
    await store.load()
    const seen: unknown[][] = []
    const off = store.onChange((devices) => seen.push(devices))
    await store.create('A', viewport, null)
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).not.toHaveProperty('tokenHash')
    off()
    await store.create('B', viewport, null)
    expect(seen).toHaveLength(1)
  })

  describe('kinds', () => {
    const origin = 'chrome-extension://' + 'a'.repeat(32)
    const installA = '3f1c1d6e-5a53-4a52-9d0b-0d6a3f3a9a01'
    const installB = '3f1c1d6e-5a53-4a52-9d0b-0d6a3f3a9a02'

    it('a version 1 file loads with every record as kind ipad and is written back as version 2', async () => {
      const file = await tempFile()
      const hash = 'a'.repeat(64)
      await writeFile(file, JSON.stringify({
        version: 1,
        enabled: true,
        devices: [{ id: 'd1', name: 'iPad', tokenHash: hash, pairedAt: '2026-10-18T10:00:00.000Z', lastSeen: null, viewport, screenId: null }],
      }))
      const store = new DeviceStore(file)
      await store.load()
      expect(store.list()[0].kind).toBe('ipad')
      await expect(stat(`${file}.corrupt`)).rejects.toThrow()
      await store.setEnabled(false)
      const written = JSON.parse(await readFile(file, 'utf8'))
      expect(written.version).toBe(2)
      expect(written.devices[0].kind).toBe('ipad')
    })

    it('createExtension stores origin and installId and returns a token found only for its kind', async () => {
      const file = await tempFile()
      const store = new DeviceStore(file)
      await store.load()
      const { device, token } = await store.createExtension({ name: 'Chrome', origin, installId: installA })
      expect(device).toMatchObject({ kind: 'extension', name: 'Chrome', origin, installId: installA })
      expect(device).not.toHaveProperty('tokenHash')
      expect(store.findByToken(token, 'extension')?.id).toBe(device.id)
      expect(store.findByToken(token, 'ipad')).toBeNull()
      const again = new DeviceStore(file)
      await again.load()
      expect(again.list()).toEqual([device])
    })

    it('createExtension replaces the record of the same origin and install', async () => {
      const store = new DeviceStore(await tempFile())
      await store.load()
      const first = await store.createExtension({ name: 'Chrome', origin, installId: installA })
      const second = await store.createExtension({ name: 'Chrome', origin, installId: installA })
      expect(store.list()).toHaveLength(1)
      expect(store.findByToken(first.token, 'extension')).toBeNull()
      expect(store.findByToken(second.token, 'extension')?.id).toBe(second.device.id)
    })

    it('two installs on one origin are two records', async () => {
      const store = new DeviceStore(await tempFile())
      await store.load()
      await store.createExtension({ name: 'A', origin, installId: installA })
      await store.createExtension({ name: 'B', origin, installId: installB })
      expect(store.list()).toHaveLength(2)
    })

    it('update and detach ignore extension records', async () => {
      const store = new DeviceStore(await tempFile())
      await store.load()
      const { device } = await store.createExtension({ name: 'Chrome', origin, installId: installA })
      expect(await store.detach(device.id, 'x')).toBe(false)
      const renamed = await store.update(device.id, { name: 'Work', screenId: 'x' })
      expect(renamed).toMatchObject({ kind: 'extension', name: 'Work' })
      expect(renamed).not.toHaveProperty('screenId')
    })

    it('createExtension refuses a bad origin or install id and leaves store and file unchanged', async () => {
      const file = await tempFile()
      const store = new DeviceStore(file)
      await store.load()
      await store.create('iPad', viewport, null)
      const before = await readFile(file, 'utf8')
      await expect(store.createExtension({ name: 'X', origin: 'https://example.com', installId: installA })).rejects.toThrow()
      await expect(store.createExtension({ name: 'X', origin, installId: 'not-a-uuid' })).rejects.toThrow()
      expect(store.list()).toHaveLength(1)
      expect(await readFile(file, 'utf8')).toBe(before)
      const again = new DeviceStore(file)
      await again.load()
      expect(again.list()).toHaveLength(1)
    })
  })
})
