import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import {
  APP_BUNDLE_ID_RE, InstalledApps, appFromPlist, defaultRoots, summarize,
} from '../src/apps/installed.js'
import { AppIcons, icnsPath } from '../src/apps/icons.js'
import { appsRoutes } from '../src/apps/routes.js'
import { dockRoutes } from '../src/dock/routes.js'
import { DockState } from '../src/dock/state.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** A fake filesystem: folder path → entry names. Anything absent throws, as `readdir` does. */
function fakeDirs(tree: Record<string, string[]>) {
  return async (path: string): Promise<string[]> => {
    const entries = tree[path]
    if (!entries) throw new Error(`ENOENT: ${path}`)
    return entries
  }
}

/** A fake `Info.plist` reader: bundle path → the keys the scanner reads. */
function fakePlists(plists: Record<string, Record<string, unknown>>, calls: string[] = []) {
  return async (path: string): Promise<Record<string, unknown> | null> => {
    calls.push(path)
    return plists[path] ?? null
  }
}

const info = (path: string): string => join(path, 'Contents', 'Info.plist')

const TREE = {
  '/Applications': ['Safari.app', 'Setapp', '.hidden.app', 'README.txt'],
  '/Applications/Setapp': ['Paste.app', 'notes.md'],
  '/System/Applications': ['Calculator.app'],
  '/System/Applications/Utilities': ['Terminal.app'],
}
const PLISTS = {
  [info('/Applications/Safari.app')]: { CFBundleIdentifier: 'com.example.safari', CFBundleDisplayName: 'Safari', CFBundleIconFile: 'AppIcon' },
  [info('/Applications/Setapp/Paste.app')]: { CFBundleIdentifier: 'com.example.paste', CFBundleName: 'Paste Board', CFBundleIconFile: 'icon.icns' },
  [info('/System/Applications/Calculator.app')]: { CFBundleIdentifier: 'com.example.calculator', CFBundleIconName: 'AppIcon' },
  [info('/System/Applications/Utilities/Terminal.app')]: { CFBundleIdentifier: 'com.example.terminal', CFBundleDisplayName: 'Terminal' },
}
const ROOTS = [
  { path: '/Applications', deep: true },
  { path: '/System/Applications' },
  { path: '/System/Applications/Utilities' },
]

const scanner = (overrides: Partial<ConstructorParameters<typeof InstalledApps>[0]> = {}): InstalledApps =>
  new InstalledApps({ roots: ROOTS, readDir: fakeDirs(TREE), readPlist: fakePlists(PLISTS), ...overrides })

describe('defaultRoots', () => {
  it('covers the four places macOS keeps applications, deep only where folders are nested', () => {
    const roots = defaultRoots('/Users/someone')
    expect(roots.map((r) => r.path)).toEqual([
      '/Applications', '/Users/someone/Applications', '/System/Applications', '/System/Applications/Utilities',
    ])
    expect(roots.filter((r) => r.deep).map((r) => r.path)).toEqual(['/Applications', '/Users/someone/Applications'])
  })
})

describe('appFromPlist', () => {
  it('prefers the display name, falls back to the bundle name then to the file name', () => {
    expect(appFromPlist('/a/One.app', { CFBundleIdentifier: 'x.y', CFBundleDisplayName: 'D', CFBundleName: 'N' })?.name).toBe('D')
    expect(appFromPlist('/a/One.app', { CFBundleIdentifier: 'x.y', CFBundleName: 'N' })?.name).toBe('N')
    expect(appFromPlist('/a/One.app', { CFBundleIdentifier: 'x.y' })?.name).toBe('One')
  })
  it('keeps the file name only when it differs from the name', () => {
    expect(appFromPlist('/a/Code.app', { CFBundleIdentifier: 'x.y', CFBundleDisplayName: 'Visual Studio Code' })?.file).toBe('Code')
    expect(appFromPlist('/a/Code.app', { CFBundleIdentifier: 'x.y', CFBundleDisplayName: 'Code' })?.file).toBeNull()
  })
  it('refuses a missing plist, a missing identifier and one that could become a path', () => {
    expect(appFromPlist('/a/One.app', null)).toBeNull()
    expect(appFromPlist('/a/One.app', { CFBundleName: 'N' })).toBeNull()
    expect(appFromPlist('/a/One.app', { CFBundleIdentifier: '../../etc/passwd' })).toBeNull()
    expect(APP_BUNDLE_ID_RE.test('com.example.app-1')).toBe(true)
    expect(APP_BUNDLE_ID_RE.test('com/example')).toBe(false)
  })
})

describe('InstalledApps', () => {
  it('walks every root and one level down, sorted by name and deduplicated by bundle id', async () => {
    const apps = await scanner().list()
    expect(apps.map((a) => a.name)).toEqual(['Calculator', 'Paste Board', 'Safari', 'Terminal'])
    // Calculator declares only an icon name: still an application, simply one with no `.icns`.
    expect(icnsPath(apps[0])).toBeNull()
    // Paste sits one level down, under a vendor folder.
    expect(apps[1].path).toBe('/Applications/Setapp/Paste.app')
  })
  it('skips dot folders, plain files and folders with no plist', async () => {
    const calls: string[] = []
    await new InstalledApps({ roots: ROOTS, readDir: fakeDirs(TREE), readPlist: fakePlists(PLISTS, calls) }).list()
    expect(calls).not.toContain(info('/Applications/.hidden.app'))
    expect(calls).not.toContain(info('/Applications/README.txt'))
    expect(calls).not.toContain(info('/Applications/Setapp/notes.md'))
  })
  it('keeps the first copy when two roots hold the same bundle id', async () => {
    const tree = { '/Applications': ['Thing.app'], '/System/Applications': ['Thing.app'] }
    const plists = {
      [info('/Applications/Thing.app')]: { CFBundleIdentifier: 'com.example.thing', CFBundleDisplayName: 'User Thing' },
      [info('/System/Applications/Thing.app')]: { CFBundleIdentifier: 'com.example.thing', CFBundleDisplayName: 'System Thing' },
    }
    const apps = await new InstalledApps({
      roots: [{ path: '/Applications' }, { path: '/System/Applications' }],
      readDir: fakeDirs(tree), readPlist: fakePlists(plists),
    }).list()
    expect(apps).toHaveLength(1)
    expect(apps[0].name).toBe('User Thing')
  })
  it('caches for the TTL, then scans again', async () => {
    const calls: string[] = []
    let now = 1_000
    const apps = new InstalledApps({
      roots: ROOTS, readDir: fakeDirs(TREE), readPlist: fakePlists(PLISTS, calls), now: () => now, ttlMs: 10_000,
    })
    await apps.list()
    const first = calls.length
    await apps.list()
    expect(calls.length).toBe(first)
    now += 10_001
    await apps.list()
    expect(calls.length).toBe(first * 2)
  })
  it('shares one scan between concurrent callers', async () => {
    const calls: string[] = []
    const apps = new InstalledApps({ roots: ROOTS, readDir: fakeDirs(TREE), readPlist: fakePlists(PLISTS, calls) })
    const [a, b] = await Promise.all([apps.list(), apps.list()])
    expect(a).toBe(b)
    expect(calls.length).toBe(4)
  })
  it('finds by bundle id and refuses one that does not match the shape', async () => {
    const apps = scanner()
    expect((await apps.find('com.example.safari'))?.name).toBe('Safari')
    expect(await apps.find('com.example.nothing')).toBeNull()
    expect(await apps.find('../escape')).toBeNull()
  })
  it('survives a root that does not exist', async () => {
    const apps = new InstalledApps({
      roots: [{ path: '/nowhere', deep: true }, ...ROOTS], readDir: fakeDirs(TREE), readPlist: fakePlists(PLISTS),
    })
    expect((await apps.list()).length).toBe(4)
  })
})

describe('icnsPath', () => {
  const base = { name: 'A', bundleId: 'com.example.a', path: '/Applications/A.app', file: null, iconName: null }
  it('appends .icns when the plist leaves it out, and keeps it when it is there', () => {
    expect(icnsPath({ ...base, iconFile: 'AppIcon' })).toBe('/Applications/A.app/Contents/Resources/AppIcon.icns')
    expect(icnsPath({ ...base, iconFile: 'AppIcon.icns' })).toBe('/Applications/A.app/Contents/Resources/AppIcon.icns')
  })
  it('gives up on an asset-catalogue icon and on a name that is a path', () => {
    expect(icnsPath({ ...base, iconFile: null, iconName: 'AppIcon' })).toBeNull()
    expect(icnsPath({ ...base, iconFile: '../../../etc/passwd' })).toBeNull()
  })
})

describe('AppIcons', () => {
  const found = { find: async () => ({ name: 'A', bundleId: 'com.example.a', path: '/Applications/A.app', file: null, iconFile: 'AppIcon', iconName: null }) }

  it('converts once and serves the cached file afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-appicons-'))
    const seen: string[] = []
    const icons = new AppIcons({
      dir,
      apps: found,
      convert: async (icns, out) => { seen.push(icns); await writeFile(out, PNG) },
    })
    expect(await icons.get('com.example.a')).toEqual(PNG)
    expect(seen).toEqual(['/Applications/A.app/Contents/Resources/AppIcon.icns'])
    expect(await icons.get('com.example.a')).toEqual(PNG)
    expect(seen).toHaveLength(1)
    expect(await readFile(join(dir, 'com.example.a.png'))).toEqual(PNG)
  })

  it('answers null for an unknown bundle, a refused conversion and a bad identifier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-appicons-'))
    const unknown = new AppIcons({ dir, apps: { find: async () => null }, convert: async () => { throw new Error('no') } })
    expect(await unknown.get('com.example.b')).toBeNull()
    let tries = 0
    const broken = new AppIcons({ dir, apps: found, convert: async () => { tries += 1; throw new Error('sips failed') } })
    expect(await broken.get('com.example.a')).toBeNull()
    // The miss is remembered, so a grid of buttons does not spawn `sips` per render.
    expect(await broken.get('com.example.a')).toBeNull()
    expect(tries).toBe(1)
    expect(await broken.get('../escape')).toBeNull()
  })

  it('forgets a miss once its TTL is past', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-appicons-'))
    let now = 0
    let tries = 0
    const icons = new AppIcons({
      dir, apps: found, now: () => now,
      convert: async (_icns, out) => { tries += 1; if (tries < 2) throw new Error('not yet'); await writeFile(out, PNG) },
    })
    expect(await icons.get('com.example.a')).toBeNull()
    now += 5 * 60 * 1000 + 1
    expect(await icons.get('com.example.a')).toEqual(PNG)
  })
})

describe('GET /api/apps/installed', () => {
  it('answers the names and identifiers, without any filesystem path', async () => {
    const app = Fastify()
    await app.register(appsRoutes, { apps: scanner() })
    const res = await app.inject({ url: '/api/apps/installed', remoteAddress: '127.0.0.1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual([
      { name: 'Calculator', bundleId: 'com.example.calculator' },
      { name: 'Paste Board', bundleId: 'com.example.paste', file: 'Paste' },
      { name: 'Safari', bundleId: 'com.example.safari' },
      { name: 'Terminal', bundleId: 'com.example.terminal' },
    ])
    expect(JSON.stringify(body)).not.toContain('/Applications')
    await app.close()
  })
  it('refuses a caller that is not on the loopback', async () => {
    const app = Fastify()
    await app.register(appsRoutes, { apps: scanner() })
    const res = await app.inject({ url: '/api/apps/installed', remoteAddress: '198.51.100.7' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
  it('summarize drops the path and the icon keys', () => {
    expect(summarize({ name: 'A', bundleId: 'com.example.a', path: '/Applications/A.app', file: null, iconFile: 'AppIcon', iconName: null }))
      .toEqual({ name: 'A', bundleId: 'com.example.a' })
  })
})

describe('GET /api/apps/icon/:bundleId with an extraction fallback', () => {
  it('serves the extracted icon when the helper never uploaded one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-iconroute-'))
    const app = Fastify()
    await app.register(dockRoutes, {
      state: new DockState({ iconsDir: join(dir, 'icons') }),
      appIcons: { get: async (id) => (id === 'com.example.a' ? PNG : null) },
    })
    const hit = await app.inject({ url: '/api/apps/icon/com.example.a' })
    expect(hit.statusCode).toBe(200)
    expect(hit.headers['content-type']).toBe('image/png')
    const miss = await app.inject({ url: '/api/apps/icon/com.example.b' })
    expect(miss.statusCode).toBe(404)
    await app.close()
  })
  it('prefers the uploaded icon and survives an extractor that throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-iconroute-'))
    const state = new DockState({ iconsDir: join(dir, 'icons') })
    await state.setIcon('com.example.a', PNG)
    let asked = 0
    const app = Fastify()
    await app.register(dockRoutes, {
      state,
      appIcons: { get: async () => { asked += 1; throw new Error('sips exploded') } },
    })
    expect((await app.inject({ url: '/api/apps/icon/com.example.a' })).statusCode).toBe(200)
    expect(asked).toBe(0)
    expect((await app.inject({ url: '/api/apps/icon/com.example.b' })).statusCode).toBe(404)
    expect(asked).toBe(1)
    await app.close()
  })
})
