import { describe, it, expect, afterEach } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tightenDataDir } from '../src/data-permissions.js'
import { buildApp } from '../src/app.js'

const mode = async (path: string) => (await stat(path)).mode & 0o777
let root: string
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('tightenDataDir', () => {
  it('brings an older data folder to 0700 folders and 0600 files, links left alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(join(data, 'disk-map'), { recursive: true })
    await writeFile(join(data, 'fremkit.json'), '{}')
    await writeFile(join(data, 'fremkit.json.bak'), '{}')
    await writeFile(join(data, 'disk-map', 'home.json'), '{}')
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'x')
    await symlink(outside, join(data, 'link'))
    for (const p of [data, join(data, 'disk-map')]) await chmod(p, 0o755)
    for (const p of [join(data, 'fremkit.json'), join(data, 'fremkit.json.bak'), join(data, 'disk-map', 'home.json'), outside]) await chmod(p, 0o644)

    expect(await tightenDataDir(data)).toBe(5)
    expect(await mode(data)).toBe(0o700)
    expect(await mode(join(data, 'disk-map'))).toBe(0o700)
    expect(await mode(join(data, 'fremkit.json'))).toBe(0o600)
    expect(await mode(join(data, 'fremkit.json.bak'))).toBe(0o600)
    expect(await mode(join(data, 'disk-map', 'home.json'))).toBe(0o600)
    // Not followed: the file a link points at keeps its mode.
    expect(await mode(outside)).toBe(0o644)
    expect((await lstat(join(data, 'link'))).isSymbolicLink()).toBe(true)
    // Nothing left to do the second time.
    expect(await tightenDataDir(data)).toBe(0)
  })

  it('runs when the server starts, and the config it writes is private', async () => {
    root = await mkdtemp(join(tmpdir(), 'fremkit-perm-'))
    const data = join(root, 'data')
    await mkdir(data, { recursive: true, mode: 0o755 })
    await chmod(data, 0o755)
    await writeFile(join(data, 'claude-usage.json'), '{}', { mode: 0o644 })
    await chmod(join(data, 'claude-usage.json'), 0o644)
    const app = await buildApp({ accessToken: null, dataDir: data, widgetsDir: join(root, 'widgets'), uiDist: join(root, 'ui') })
    try {
      expect(await mode(data)).toBe(0o700)
      expect(await mode(join(data, 'claude-usage.json'))).toBe(0o600)
      const res = await app.inject({ method: 'PUT', url: '/api/config', headers: { host: '127.0.0.1:4242' }, payload: (await app.inject({ url: '/api/config', headers: { host: '127.0.0.1:4242' } })).json() })
      expect(res.statusCode).toBe(200)
      expect(await mode(join(data, 'fremkit.json'))).toBe(0o600)
    } finally {
      await app.close()
    }
  })
})
