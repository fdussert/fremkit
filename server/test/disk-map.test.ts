import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskMapProvider, parseMounts, resolveInside, type DiskMapSnapshot } from '../src/providers/disk-map.js'
import { ScanError, type DiskScanner, type ScanOutcome, type ScanProgress } from '../src/providers/disk-map-scanner.js'
import type { DiskNode, DiskPolicy } from '../src/providers/disk-map-tree.js'
import type { Provider } from '../src/providers/types.js'

const LOCAL = { loopback: true }

interface Started {
  path: string; policy: DiskPolicy; resolve(o: ScanOutcome): void; reject(e: Error): void; cancelled: boolean
  progress(p: ScanProgress): void
}

/** A scanner whose scans the test finishes by hand. */
function fakeScanner(): DiskScanner & { started: Started[] } {
  const started: Started[] = []
  return {
    kind: 'native',
    started,
    start(path, policy, onProgress) {
      let resolve!: (o: ScanOutcome) => void
      let reject!: (e: Error) => void
      const result = new Promise<ScanOutcome>((res, rej) => { resolve = res; reject = rej })
      const entry: Started = { path, policy, resolve, reject, cancelled: false, progress: onProgress }
      started.push(entry)
      return { result, cancel: () => { entry.cancelled = true; reject(new ScanError('cancelled')) } }
    },
  }
}

const outcome = (tree: DiskNode): ScanOutcome => ({ tree, stats: { directories: 3, files: 4, unreadable: tree.unreadable ?? 0, ms: 5 } })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('parseMounts', () => {
  it('keeps local browsable volumes under /Volumes and nothing else', () => {
    const out = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
      '/dev/disk7s1 on /Volumes/Backup Disk (apfs, local, nodev, nosuid, journaled, noowners)',
      '/dev/disk8s2 on /Volumes/USB (exfat, local, nodev, nosuid, noowners, noatime, fskit)',
      '//guest@192.0.2.10/share on /Volumes/share (smbfs, nodev, nosuid, mounted by example)',
      'server.example.com:/export on /Volumes/nfs (nfs, nodev, nosuid, mounted by example)',
      '/dev/disk9s1 on /Volumes/com.apple.TimeMachine.localsnapshots/x (apfs, local, nobrowse)',
      '/dev/disk9s2 on /Volumes/.hidden (apfs, local)',
    ].join('\n')
    expect(parseMounts(out)).toEqual([
      { name: 'Backup Disk', path: '/Volumes/Backup Disk' },
      { name: 'USB', path: '/Volumes/USB' },
    ])
  })
})

describe('resolveInside', () => {
  it('refuses what a symlink takes outside the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-inside-'))
    try {
      await mkdir(join(dir, 'root/inner'), { recursive: true })
      await symlink(tmpdir(), join(dir, 'root/escape'))
      expect(await resolveInside(join(dir, 'root'), ['inner'])).toMatch(/\/root\/inner$/)
      await expect(resolveInside(join(dir, 'root'), ['escape'])).rejects.toThrow()
      await expect(resolveInside(join(dir, 'root'), ['nope'])).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('disk-map provider', () => {
  let dataDir: string
  let home: string
  let scanner: ReturnType<typeof fakeScanner>
  let opened: string[][]
  let revealed: number
  let provider: Provider<DiskMapSnapshot>
  const cmd = (name: string, payload: unknown, ctx: { loopback: boolean } | undefined = LOCAL) =>
    provider.commands![name](payload, ctx) as Promise<Record<string, any>>

  const make = () => createDiskMapProvider({
    dataDir, home,
    scanner: async () => scanner,
    mounts: async () => '/dev/disk7s1 on /Volumes/Example (apfs, local, journaled)\n',
    open: async (args) => { opened.push(args) },
    revealHelper: async () => { revealed++ },
  })

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fremkit-dm-data-'))
    home = await mkdtemp(join(tmpdir(), 'fremkit-dm-home-'))
    await mkdir(join(home, 'Library/Caches'), { recursive: true })
    await writeFile(join(home, 'movie.mov'), 'x')
    scanner = fakeScanner()
    opened = []
    revealed = 0
    provider = make()
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  const homeTree = (): DiskNode => ({
    name: 'ignored', kind: 'd', size: 1000, files: 4, unreadable: 1,
    children: [
      { name: 'Library', kind: 'd', size: 700, children: [{ name: 'Caches', kind: 'd', size: 600, more: true }] },
      { name: 'movie.mov', kind: 'f', size: 290, files: 1 },
      { name: 'Mail', kind: 'x', size: 0, unreadable: 1 },
    ],
  })

  it('lists the home folder and the local volumes, and has nothing before a scan', async () => {
    const snap = await provider.poll!()
    expect(snap.roots).toEqual([{ id: 'home', label: '~', kind: 'home' }, { id: 'volume:Example', label: 'Example', kind: 'volume' }])
    expect(snap.scanner).toBe('native')
    expect(snap.results).toEqual({})
    expect(await cmd('view', { root: 'home' })).toEqual({ ok: true, view: null })
  })

  it('publishes the folder a privacy prompt holds while the scan waits for it', async () => {
    await cmd('scan', { root: 'home' })
    expect((await provider.poll!()).scanning).toMatchObject({ waiting: null })
    scanner.started[0].progress({ directories: 5, files: 7, path: ['Library'], waiting: ['Documents'] })
    expect((await provider.poll!()).scanning).toMatchObject({ directories: 5, current: ['Library'], waiting: ['Documents'] })
    scanner.started[0].progress({ directories: 5, files: 7, path: ['Library'], waiting: null })
    expect((await provider.poll!()).scanning).toMatchObject({ waiting: null })
  })

  it('scans on demand, shows progress, then serves the view and saves it', async () => {
    expect(await cmd('scan', { root: 'home' })).toEqual({ ok: true })
    expect(scanner.started[0].path).toBe(await import('node:fs/promises').then((f) => f.realpath(home)))
    expect((await provider.poll!()).scanning).toMatchObject({ root: 'home', path: [] })
    expect(provider.intervalMs).toBe(1000)
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    const snap = await provider.poll!()
    expect(snap.scanning).toBeNull()
    expect(snap.results.home).toMatchObject({ size: 1000, unreadable: 1, files: 4, scanner: 'native', generation: 1 })
    // The dashboard stamps the instance id on every widget command.
    const view = await cmd('view', { root: 'home', path: [], rings: 2, instanceId: 'dm-1' })
    expect(view.view.name).toBe('~')
    expect(view.view.children.map((c: DiskNode) => c.name)).toEqual(['Library', 'movie.mov', 'Mail'])
    // The save is written after the result is published; give a loaded machine a moment.
    await vi.waitFor(async () => expect(await readdir(join(dataDir, 'disk-map'))).toEqual(['home.json']))

    // A restart reads it back, date included.
    provider = make()
    const again = await provider.poll!()
    expect(again.results.home?.size).toBe(1000)
    expect(again.results.home?.scannedAt).toBe(snap.results.home!.scannedAt)
  })

  it('refuses paths that are not names, and roots that are not offered', async () => {
    for (const path of [['..'], ['a/b'], ['.'], ['x\0y']]) {
      expect((await cmd('view', { root: 'home', path })).ok).toBe(false)
      expect((await cmd('reveal', { root: 'home', path })).ok).toBe(false)
    }
    expect((await cmd('view', { root: '/etc' })).ok).toBe(false)
    expect((await cmd('scan', { root: 'volume:Elsewhere' }))).toEqual({ ok: false, error: 'unknown-root' })
    expect((await cmd('scan', { root: 'home', extra: 1 })).ok).toBe(false)
    expect(scanner.started).toHaveLength(0)
  })

  it('acts on the Mac only for a local client', async () => {
    for (const name of ['scan', 'cancel', 'reveal', 'openPrivacy', 'revealPrompt']) {
      expect((await cmd(name, { root: 'home' }, { loopback: false })).ok).toBe(false)
      expect((await provider.commands![name]({ root: 'home' })) as { ok: boolean }).toMatchObject({ ok: false })
    }
    expect(scanner.started).toHaveLength(0)
    expect(opened).toEqual([])
    expect(revealed).toBe(0)
  })

  it('asks the helper to lower the dashboard so the privacy prompt can be answered', async () => {
    expect(await cmd('revealPrompt', {})).toEqual({ ok: true })
    expect(revealed).toBe(1)
    expect((await cmd('revealPrompt', { seconds: 9999 })).ok).toBe(false)
    expect(revealed).toBe(1)
    const failing = createDiskMapProvider({
      dataDir, home, scanner: async () => scanner, mounts: async () => '',
      revealHelper: async () => { throw new Error('no helper') },
    })
    expect(await failing.commands!.revealPrompt({}, LOCAL)).toEqual({ ok: false, error: 'failed' })
  })

  it('reveals only what its own tree holds, resolved under the root', async () => {
    await cmd('scan', { root: 'home' })
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    expect(await cmd('reveal', { root: 'home', path: ['Library', 'Caches'] })).toEqual({ ok: true })
    expect(opened[0][0]).toBe('-R')
    expect(opened[0][1]).toMatch(/\/Library\/Caches$/)
    expect(await cmd('reveal', { root: 'home', path: ['Library', 'Elsewhere'] })).toEqual({ ok: false, error: 'gone' })
    expect(opened).toHaveLength(1)
    expect(await cmd('openPrivacy', {})).toEqual({ ok: true })
    expect(opened[1]).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
  })

  it('cancels the running scan when another starts, and on cancel', async () => {
    await cmd('scan', { root: 'home' })
    await cmd('scan', { root: 'home' })
    expect(scanner.started[0].cancelled).toBe(true)
    await cmd('cancel', {})
    expect(scanner.started[1].cancelled).toBe(true)
    await flush()
    const snap = await provider.poll!()
    expect(snap.scanning).toBeNull()
    expect(snap.errors).toEqual({})
  })

  it('cancels the first of two scans asked for at the same time', async () => {
    await Promise.all([cmd('scan', { root: 'home' }), cmd('scan', { root: 'home' })])
    expect(scanner.started).toHaveLength(2)
    expect(scanner.started[0].cancelled).toBe(true)
    expect(scanner.started[1].cancelled).toBe(false)
  })

  it('queues a scan of another root instead of cancelling the one running', async () => {
    // Two tiles, one on the home folder and one on a volume, both tapped at once.
    await cmd('scan', { root: 'home' })
    expect(await cmd('scan', { root: 'volume:Example' })).toEqual({ ok: true, queued: true })
    expect(scanner.started).toHaveLength(1)
    expect(scanner.started[0].cancelled).toBe(false)
    expect((await provider.poll!()).queued).toEqual(['volume:Example'])
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    await vi.waitFor(async () => expect((await provider.poll!()).queued).toEqual([]))
    const snap = await provider.poll!()
    expect(snap.results.home?.size).toBe(1000)
    // The queued root ran in turn: `/Volumes/Example` is not on this disk, and the tile says so
    // rather than staying on "never scanned".
    await vi.waitFor(async () => expect((await provider.poll!()).errors).toEqual({ 'volume:Example': { path: [], code: 'missing' } }))
  })

  it('starts queued scans one after the other, and cancels one by its root', async () => {
    await cmd('scan', { root: 'home', path: [] })
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    await cmd('scan', { root: 'volume:Example' })
    // The volume is missing, so it never runs: queue behind a running home scan instead.
    await cmd('scan', { root: 'home' })
    expect(await cmd('scan', { root: 'volume:Example' })).toEqual({ ok: true, queued: true })
    expect(await cmd('cancel', { root: 'volume:Example' })).toEqual({ ok: true })
    expect((await provider.poll!()).queued).toEqual([])
    // Cancelling a queued root leaves the running scan alone.
    expect(scanner.started[1].cancelled).toBe(false)
    expect(await cmd('scan', { root: 'volume:Example' })).toEqual({ ok: true, queued: true })
    await cmd('cancel', { root: 'home' })
    expect(scanner.started[1].cancelled).toBe(true)
    await vi.waitFor(async () => expect((await provider.poll!()).queued).toEqual([]))
    expect(scanner.started).toHaveLength(2)
  })

  it('answers gone for a folder that is no longer there, and never rescans the root instead', async () => {
    await cmd('scan', { root: 'home' })
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    // In the tree, not on disk any more.
    await rm(join(home, 'Library/Caches'), { recursive: true })
    expect(await cmd('scan', { root: 'home', path: ['Library', 'Caches'] })).toEqual({ ok: false, error: 'gone' })
    // Not in the tree at all.
    expect(await cmd('scan', { root: 'home', path: ['Nowhere'] })).toEqual({ ok: false, error: 'gone' })
    expect(scanner.started).toHaveLength(1)
  })

  it('keeps the last good result and says what failed', async () => {
    await cmd('scan', { root: 'home' })
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    await cmd('scan', { root: 'home' })
    scanner.started[1].reject(new ScanError('unreadable'))
    await flush()
    const snap = await provider.poll!()
    expect(snap.results.home?.size).toBe(1000)
    expect(snap.errors).toEqual({ home: { path: [], code: 'unreadable' } })
  })

  it('rescans a folder the tree did not hold the inside of, and serves it from then on', async () => {
    await cmd('scan', { root: 'home' })
    scanner.started[0].resolve(outcome(homeTree()))
    await flush()
    const before = await cmd('view', { root: 'home', path: ['Library', 'Caches'] })
    expect(before.view.more).toBe(true)
    await cmd('scan', { root: 'home', path: ['Library', 'Caches'] })
    const sub = scanner.started[1]
    expect(sub.path).toMatch(/\/Library\/Caches$/)
    expect(sub.policy.budget).toBeLessThan(20_000)
    sub.resolve(outcome({ name: 'Caches', kind: 'd', size: 610, children: [{ name: 'com.example.app', kind: 'd', size: 500 }] }))
    await flush()
    const after = await cmd('view', { root: 'home', path: ['Library', 'Caches'] })
    expect(after.view.more).toBeUndefined()
    expect(after.view.children[0].name).toBe('com.example.app')
    const snap = await provider.poll!()
    expect(snap.results.home?.generation).toBe(2)
    // The parents take the folder's new size.
    expect(snap.results.home?.size).toBe(1010)
    expect((await cmd('view', { root: 'home', path: ['Library'], rings: 1 })).view.size).toBe(710)
    expect(await cmd('reveal', { root: 'home', path: ['Library', 'Caches', 'com.example.app'] })).toEqual({ ok: false, error: 'gone' })
  })
})
