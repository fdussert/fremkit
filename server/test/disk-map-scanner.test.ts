import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDuScanner, createNativeScanner, DuParser, nativeLineHandler, resolveScannerBinary, ScanError,
} from '../src/providers/disk-map-scanner.js'
import { DEFAULT_POLICY, findNode } from '../src/providers/disk-map-tree.js'

let fixture: string
beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'fremkit-disk-map-'))
  await mkdir(join(fixture, 'tree/big'), { recursive: true })
  await mkdir(join(fixture, 'tree/locked'), { recursive: true })
  await writeFile(join(fixture, 'tree/big/blob.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
  await writeFile(join(fixture, 'tree/locked/secret.bin'), Buffer.alloc(1024, 1))
  await chmod(join(fixture, 'tree/locked'), 0)
})
afterAll(async () => {
  await chmod(join(fixture, 'tree/locked'), 0o755).catch(() => {})
  await rm(fixture, { recursive: true, force: true })
})

describe('resolveScannerBinary', () => {
  it('takes only an absolute path to an executable file', async () => {
    const script = join(fixture, 'scan.sh')
    await writeFile(script, '#!/bin/sh\n', { mode: 0o755 })
    expect(await resolveScannerBinary({ FREMKIT_SCANNER: script })).toBe(script)
    expect(await resolveScannerBinary({ FREMKIT_SCANNER: 'scan.sh' })).toBeNull()
    expect(await resolveScannerBinary({ FREMKIT_SCANNER: fixture })).toBeNull()
    expect(await resolveScannerBinary({ FREMKIT_SCANNER: join(fixture, 'nope') })).toBeNull()
    expect(await resolveScannerBinary({})).toBeNull()
    const plain = join(fixture, 'plain.txt')
    await writeFile(plain, 'x', { mode: 0o644 })
    expect(await resolveScannerBinary({ FREMKIT_SCANNER: plain })).toBeNull()
  })
})

describe('nativeLineHandler', () => {
  it('reports progress and returns the validated tree', () => {
    const seen: unknown[] = []
    const h = nativeLineHandler((p) => seen.push(p))
    h.line('{"type":"start","root":"/x"}')
    h.line('{"type":"progress","directories":3,"files":9,"unreadable":0,"path":["a","b","c"]}')
    h.line('not json')
    expect(h.outcome()).toBeNull()
    h.line('{"type":"done","tree":{"name":"x","kind":"d","size":5},"stats":{"directories":1,"files":2,"unreadable":0,"ms":7}}')
    expect(seen).toEqual([{ directories: 3, files: 9, path: ['a', 'b'], waiting: null }])
    expect(h.outcome()).toEqual({ tree: { name: 'x', kind: 'd', size: 5 }, stats: { directories: 1, files: 2, unreadable: 0, ms: 7 } })
  })
  it('reports the folder macOS holds behind a privacy prompt, until the walk moves on', () => {
    const seen: unknown[] = []
    const h = nativeLineHandler((p) => seen.push(p))
    h.line('{"type":"progress","directories":3,"files":9,"path":["Library"]}')
    h.line('{"type":"waiting","path":["Documents"]}')
    h.line('{"type":"progress","directories":4,"files":9,"path":["Library"]}')
    h.line('{"type":"waiting","path":null}')
    // Malformed waiting lines are ignored, never published.
    h.line('{"type":"waiting","path":"Documents"}')
    h.line('{"type":"waiting","path":[1,2]}')
    h.line(`{"type":"waiting","path":["${'x'.repeat(2000)}"]}`)
    h.line('{"type":"waiting"}')
    expect(seen).toEqual([
      { directories: 3, files: 9, path: ['Library'], waiting: null },
      { directories: 3, files: 9, path: ['Library'], waiting: ['Documents'] },
      { directories: 4, files: 9, path: ['Library'], waiting: ['Documents'] },
      { directories: 4, files: 9, path: ['Library'], waiting: null },
    ])
  })
  it('maps the error lines and refuses a tree that does not validate', () => {
    const a = nativeLineHandler(() => {})
    a.line('{"type":"error","code":"unreadable"}')
    expect(a.outcome()).toBe('unreadable')
    const b = nativeLineHandler(() => {})
    b.line('{"type":"done","tree":{"name":"x","kind":"d","size":-5}}')
    expect(b.outcome()).toBe('failed')
  })
})

describe('DuParser', () => {
  it('builds the tree from du lines and maps refusals to unreadable folders', () => {
    const p = new DuParser('/Users/example', 'example')
    p.errorLine('du: /Users/example/Library/Mail: Operation not permitted')
    p.errorLine('du: /Users/example/Library/Mobile Documents/x: Resource deadlock avoided')
    p.errorLine('du: /elsewhere/x: Permission denied')
    for (const line of ['4\t/Users/example/Library/Mail', '2048\t/Users/example/Library/Caches', '3072\t/Users/example/Library', '1\t/etc/passwd', '5120\t/Users/example']) p.line(line)
    const tree = p.finish({ ...DEFAULT_POLICY, minBytes: 1024 }, 5)
    expect(tree.size).toBe(5120 * 1024)
    expect(tree.unreadable).toBe(1)
    expect(p.unreadable).toBe(1)
    expect(findNode(tree, ['Library', 'Mail'])).toMatchObject({ kind: 'x', unreadable: 1 })
    expect(findNode(tree, ['Library', 'Caches'])?.size).toBe(2048 * 1024)
    // What Library holds besides its subfolders: its files, in "others".
    expect(findNode(tree, ['Library'])?.others).toEqual([0, (3072 - 2048 - 4) * 1024])
    expect(tree.others).toEqual([0, 2048 * 1024])
  })
  it('folds small folders away as their parent completes, and stays fast on a huge folder', () => {
    const p = new DuParser('/Volumes/Big', 'Big', 1024 * 1024)
    const started = Date.now()
    for (let i = 0; i < 50_000; i++) p.line(`8\t/Volumes/Big/cache/item-${i}`)
    p.line('4096\t/Volumes/Big/cache/large')
    p.line(`${8 * 50_000 + 4096 + 4}\t/Volumes/Big/cache`)
    p.line(`${8 * 50_000 + 4096 + 4}\t/Volumes/Big`)
    expect(Date.now() - started).toBeLessThan(2000)
    const tree = p.finish({ ...DEFAULT_POLICY, minBytes: 1024 * 1024 }, 5)
    const cache = findNode(tree, ['cache'])!
    expect(cache.children?.map((c) => c.name)).toEqual(['large'])
    expect(cache.others).toEqual([50_000, (8 * 50_000 + 4) * 1024])
  })
  it('reads a folder whose name holds a newline as one folder', () => {
    const p = new DuParser('/Volumes/Big', 'Big')
    p.errorLine('du: /Volumes/Big/two')
    p.errorLine('lines: Permission denied')
    p.line('16\t/Volumes/Big/odd')
    p.line('name')
    p.line('4\t/Volumes/Big/two')
    p.line('lines')
    p.line('32\t/Volumes/Big')
    const tree = p.finish({ ...DEFAULT_POLICY, minBytes: 1 }, 5)
    expect(tree.size).toBe(32 * 1024)
    expect(tree.children?.map((c) => c.name).sort()).toEqual(['odd\nname', 'two\nlines'])
    expect(findNode(tree, ['odd\nname'])?.size).toBe(16 * 1024)
    expect(findNode(tree, ['two\nlines'])).toMatchObject({ kind: 'x', unreadable: 1 })
    expect(p.unreadable).toBe(1)
  })
  it('reads the refusals of GNU du too', () => {
    const p = new DuParser('/Volumes/Big', 'Big')
    p.errorLine("/usr/bin/du: cannot read directory '/Volumes/Big/locked': Permission denied")
    p.line('4\t/Volumes/Big/locked')
    p.line('8\t/Volumes/Big')
    const tree = p.finish(DEFAULT_POLICY, 5)
    expect(findNode(tree, ['locked'])?.kind).toBe('x')
    expect(p.unreadable).toBe(1)
  })
  it('notices that the root itself was refused', () => {
    const p = new DuParser('/Volumes/Locked', 'Locked')
    p.errorLine('du: /Volumes/Locked: Permission denied')
    expect(p.rootUnreadable).toBe(true)
  })
})

describe('createDuScanner', () => {
  it('scans a real folder with /usr/bin/du', async () => {
    const progress: unknown[] = []
    const outcome = await createDuScanner().start(join(fixture, 'tree'), { ...DEFAULT_POLICY, minBytes: 1 }, (p) => progress.push(p)).result
    expect(findNode(outcome.tree, ['big'])!.size).toBeGreaterThanOrEqual(3 * 1024 * 1024)
    if (process.getuid?.() !== 0) {
      expect(findNode(outcome.tree, ['locked'])?.kind).toBe('x')
      expect(outcome.stats.unreadable).toBe(1)
    }
  })
  it('fails on a folder that is not there', async () => {
    await expect(createDuScanner().start(join(fixture, 'missing'), DEFAULT_POLICY, () => {}).result).rejects.toBeInstanceOf(ScanError)
  })
  it('stops when cancelled', async () => {
    const handle = createDuScanner().start('/', DEFAULT_POLICY, () => {})
    handle.cancel()
    await expect(handle.result).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('createNativeScanner', () => {
  it('runs a scanner by path with its argument list and reads its lines', async () => {
    const fake = join(fixture, 'fake-scan.sh')
    // Prints its arguments back inside the tree's name, so the test sees exactly what it was given.
    await writeFile(fake, [
      '#!/bin/sh',
      'echo \'{"type":"progress","directories":1,"files":1,"path":["a"]}\'',
      'printf \'{"type":"done","tree":{"name":"%s","kind":"d","size":42},"stats":{"directories":1,"files":0,"unreadable":0,"ms":1}}\\n\' "$*"',
    ].join('\n'), { mode: 0o755 })
    const outcome = await createNativeScanner(fake).start('/Volumes/With space', { ...DEFAULT_POLICY, depth: 4 }, () => {}).result
    expect(outcome.tree.size).toBe(42)
    expect(outcome.tree.name).toBe(`--depth 4 --min-bytes ${DEFAULT_POLICY.minBytes} --max-children 128 --budget 20000 --progress-depth 1 -- /Volumes/With space`)
  })
  it('reports a scanner that dies without a result as a failure', async () => {
    const fake = join(fixture, 'dies.sh')
    await writeFile(fake, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    await expect(createNativeScanner(fake).start('/x', DEFAULT_POLICY, () => {}).result).rejects.toMatchObject({ code: 'failed' })
  })

  // The real scanner, when `pnpm helper:build` has built it in this checkout.
  const built = fileURLToPath(new URL('../../native/dist/Fremkit Helper.app/Contents/MacOS/fremkit-scan', import.meta.url))
  it.skipIf(!existsSync(built))('agrees with du on a fixture folder', async () => {
    const policy = { ...DEFAULT_POLICY, minBytes: 1 }
    const native = await createNativeScanner(built).start(join(fixture, 'tree'), policy, () => {}).result
    const du = await createDuScanner().start(join(fixture, 'tree'), policy, () => {}).result
    expect(Math.abs(native.tree.size - du.tree.size)).toBeLessThanOrEqual(64 * 1024)
    expect(findNode(native.tree, ['big', 'blob.bin'])?.kind).toBe('f')
    if (process.getuid?.() !== 0) expect(findNode(native.tree, ['locked'])?.kind).toBe('x')
  })
})
