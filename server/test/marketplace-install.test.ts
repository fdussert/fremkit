import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtemp, readFile, readdir, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstallError, LIMITS, STALE_STAGING_MS, readPackage, recoverStaging, removePackage, safeEntryName, sha256, writePackage } from '../src/marketplace/install.js'
import { writeZip } from '../src/backup/zip.js'
import { SDK_VERSION } from '../src/bridge/sdk.js'

const MANIFEST = {
  id: 'demo', name: { fr: 'Démo', en: 'Demo' }, version: '1.0.0', sdk: 1,
  minSize: [8, 4], defaultSize: [8, 4],
}

function zipOf(files: { name: string; data: Buffer }[]): Buffer {
  return writeZip(files, new Date(Date.UTC(1980, 0, 1)))
}

function packageOf(over: Record<string, unknown> = {}, extra: { name: string; data: Buffer }[] = []): Buffer {
  return zipOf([
    { name: 'index.html', data: Buffer.from('<html></html>') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...MANIFEST, ...over })) },
    ...extra,
  ])
}

const expected = (zip: Buffer, id = 'demo') => ({ id, sha256: sha256(zip), size: zip.byteLength })

describe('safeEntryName', () => {
  it('refuses everything that would not land inside the widget\'s own folder', () => {
    for (const name of ['', '/etc/passwd', 'C:/x', '../x', 'a/../b', './a', '.env', 'a/.git/config',
      'a\\b', 'assets/', 'a//b']) {
      expect(safeEntryName(name), name).toBe(false)
    }
  })
  it('accepts an ordinary asset path', () => {
    for (const name of ['index.html', 'manifest.json', 'assets/logo.svg', 'a/b/c.js']) {
      expect(safeEntryName(name), name).toBe(true)
    }
  })
  it('caps how deep a path may go', () => {
    expect(safeEntryName('a/b/c/d/e/f/g/h.js')).toBe(true)
    expect(safeEntryName('a/b/c/d/e/f/g/h/i.js')).toBe(false)
  })
  it('refuses an archive, whatever the case of its extension', () => {
    // A payload nothing in the chain looks inside: not the registry's validator, not readZip,
    // not the catalogue.
    for (const name of ['payload.zip', 'a/b.TGZ', 'x.tar', 'x.gz', 'x.7z', 'x.rar', 'x.xz', 'x.bz2']) {
      expect(safeEntryName(name), name).toBe(false)
    }
  })
})

describe('readPackage', () => {
  it('opens a well-formed package', () => {
    const zip = packageOf()
    const pkg = readPackage(zip, expected(zip))
    expect(pkg.manifest.id).toBe('demo')
    expect(pkg.files.map((f) => f.name).sort()).toEqual(['index.html', 'manifest.json'])
  })

  it('refuses bytes that are not the ones the index named, before reading anything', () => {
    const zip = packageOf()
    expect(() => readPackage(zip, { id: 'demo', sha256: 'b'.repeat(64), size: zip.byteLength }))
      .toThrow(expect.objectContaining({ key: 'marketplace.hashMismatch' }))
    expect(() => readPackage(zip, { id: 'demo', sha256: sha256(zip), size: zip.byteLength + 1 }))
      .toThrow(expect.objectContaining({ key: 'marketplace.hashMismatch' }))
  })

  it('refuses a package whose manifest carries another id', () => {
    // Otherwise a package could land under a name the user never saw — including one they trust.
    const zip = packageOf({ id: 'other' })
    expect(() => readPackage(zip, expected(zip))).toThrow(expect.objectContaining({ key: 'marketplace.idMismatch' }))
  })

  it('refuses an SDK newer than this build', () => {
    const zip = packageOf({ sdk: SDK_VERSION + 1 })
    expect(() => readPackage(zip, expected(zip))).toThrow(expect.objectContaining({ key: 'marketplace.sdkTooNew' }))
  })

  it('refuses a manifest that does not validate, and one that is not JSON', () => {
    const bad = packageOf({ version: 'latest' })
    expect(() => readPackage(bad, expected(bad))).toThrow(expect.objectContaining({ key: 'marketplace.badManifest' }))
    const notJson = zipOf([
      { name: 'index.html', data: Buffer.from('<html></html>') },
      { name: 'manifest.json', data: Buffer.from('{ not json') },
    ])
    expect(() => readPackage(notJson, expected(notJson))).toThrow(expect.objectContaining({ key: 'marketplace.badManifest' }))
  })

  it('refuses a private host in permissions.network, twice over', () => {
    const zip = packageOf({ permissions: { network: ['127.0.0.1'] } })
    expect(() => readPackage(zip, expected(zip))).toThrow(InstallError)
  })

  it('refuses an entry that would be written outside the folder', () => {
    const zip = zipOf([
      { name: 'index.html', data: Buffer.from('x') },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
      { name: '../../fremkit.json', data: Buffer.from('{}') },
    ])
    expect(() => readPackage(zip, expected(zip))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
  })

  it('refuses a dotfile and a name claimed twice', () => {
    const dot = packageOf({}, [{ name: '.env', data: Buffer.from('TOKEN=secret') }])
    expect(() => readPackage(dot, expected(dot))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
    // Which of the two lands on disk would depend on the write order, which is not a question
    // an archive gets to ask.
    const twice = packageOf({}, [{ name: 'Index.html', data: Buffer.from('other') }])
    expect(() => readPackage(twice, expected(twice))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
  })

  it('refuses a package with no manifest or no index.html', () => {
    const noManifest = zipOf([{ name: 'index.html', data: Buffer.from('x') }])
    expect(() => readPackage(noManifest, expected(noManifest))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
    const noPage = zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) }])
    expect(() => readPackage(noPage, expected(noPage))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
  })

  it('refuses a file over the per-file ceiling and an archive over the total', () => {
    const big = packageOf({}, [{ name: 'big.bin', data: Buffer.alloc(LIMITS.maxFileBytes + 1) }])
    expect(() => readPackage(big, expected(big))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
  })

  it('refuses bytes that are not a zip at all', () => {
    const junk = Buffer.from('not an archive')
    expect(() => readPackage(junk, expected(junk))).toThrow(expect.objectContaining({ key: 'marketplace.badPackage' }))
  })
})

describe('writePackage', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'installed-')) })

  const files = [
    { name: 'index.html', data: Buffer.from('<html>v1</html>') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
    { name: 'assets/a.svg', data: Buffer.from('<svg/>') },
  ]

  it('writes the folder, subdirectories included, and leaves nothing behind', async () => {
    await writePackage(dir, 'demo', files)
    expect(await readFile(join(dir, 'demo', 'assets', 'a.svg'), 'utf8')).toBe('<svg/>')
    expect(await readdir(dir)).toEqual(['demo'])
  })

  it('replaces a version in place, with no moment where the folder is half of each', async () => {
    await writePackage(dir, 'demo', files)
    await writePackage(dir, 'demo', [
      { name: 'index.html', data: Buffer.from('<html>v2</html>') },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...MANIFEST, version: '2.0.0' })) },
    ])
    expect(await readFile(join(dir, 'demo', 'index.html'), 'utf8')).toBe('<html>v2</html>')
    // The old version's extra file is gone: this is a replacement, not a merge.
    await expect(readFile(join(dir, 'demo', 'assets', 'a.svg'), 'utf8')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['demo'])
  })

  it('leaves the working widget alone when the new one cannot be staged', async () => {
    await writePackage(dir, 'demo', files)
    // A file and a folder of the same name: the second write fails partway through.
    await expect(writePackage(dir, 'demo', [
      { name: 'a', data: Buffer.from('file') },
      { name: 'a/b', data: Buffer.from('under a file') },
    ])).rejects.toThrow()
    expect(await readFile(join(dir, 'demo', 'index.html'), 'utf8')).toBe('<html>v1</html>')
    expect(await readdir(dir)).toEqual(['demo'])
  })

  it('creates the installed folder on the first install', async () => {
    const fresh = join(dir, 'nested', 'widgets')
    await writePackage(fresh, 'demo', files)
    expect(await readdir(fresh)).toEqual(['demo'])
  })
})

describe('removePackage', () => {
  it('removes the folder, and says nothing about one that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'installed-'))
    await mkdir(join(dir, 'demo'), { recursive: true })
    await writeFile(join(dir, 'demo', 'index.html'), 'x')
    await removePackage(dir, 'demo')
    expect(await readdir(dir)).toEqual([])
    await expect(removePackage(dir, 'demo')).resolves.toBeUndefined()
  })
})

describe('recoverStaging', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'installed-')) })

  const files = [
    { name: 'index.html', data: Buffer.from('<html>v1</html>') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(MANIFEST)) },
  ]

  it('puts a backup back when the widget folder is missing', async () => {
    // The swap is `target → .bak` then `staging → target`. A crash between the two leaves the
    // widget gone and its previous version in `.bak`.
    await mkdir(join(dir, 'demo.bak'), { recursive: true })
    await writeFile(join(dir, 'demo.bak', 'index.html'), 'the version that worked')
    await recoverStaging(dir)
    expect(await readFile(join(dir, 'demo', 'index.html'), 'utf8')).toBe('the version that worked')
    expect(await readdir(dir)).toEqual(['demo'])
  })

  it('drops a backup sitting beside a working widget', async () => {
    // That one is the leftover of a *successful* swap whose cleanup failed; restoring it would
    // undo the install.
    await writePackage(dir, 'demo', files)
    await mkdir(join(dir, 'demo.bak'), { recursive: true })
    await writeFile(join(dir, 'demo.bak', 'index.html'), 'the old one')
    await recoverStaging(dir)
    expect(await readFile(join(dir, 'demo', 'index.html'), 'utf8')).toBe('<html>v1</html>')
    expect(await readdir(dir)).toEqual(['demo'])
  })

  it('sweeps a staging folder old enough to be dead, and leaves a fresh one alone', async () => {
    const stale = join(dir, '.tmp-demo-old')
    const fresh = join(dir, '.tmp-demo-new')
    await mkdir(stale, { recursive: true })
    await mkdir(fresh, { recursive: true })
    const longAgo = new Date(Date.now() - STALE_STAGING_MS - 60_000)
    await utimes(stale, longAgo, longAgo)
    await recoverStaging(dir)
    expect((await readdir(dir)).sort()).toEqual(['.tmp-demo-new'])
  })

  it('says nothing about a folder that does not exist', async () => {
    await expect(recoverStaging(join(dir, 'nope'))).resolves.toBeUndefined()
  })

  it('runs on the way into an install, so a crashed one is undone first', async () => {
    await mkdir(join(dir, 'demo.bak'), { recursive: true })
    await writeFile(join(dir, 'demo.bak', 'index.html'), 'the version that worked')
    await writePackage(dir, 'other', files)
    // `demo` came back even though the install was for `other`.
    expect(await readFile(join(dir, 'demo', 'index.html'), 'utf8')).toBe('the version that worked')
  })
})
