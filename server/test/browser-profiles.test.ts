import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { BrowserProfiles } from '../src/browsers/profiles.js'
import { browserRoutes } from '../src/browsers/routes.js'
import { createShortcutsProvider } from '../src/providers/shortcuts.js'
import type { InstanceLookup } from '../src/config/instances.js'

let home: string
let apps: string
const support = (...p: string[]) => join(home, 'Library', 'Application Support', ...p)

/** A browser installed in `apps` with these profiles, as Chromium writes `Local State`. */
async function browser(app: string, data: string, profiles: Record<string, Record<string, unknown>>, folders = Object.keys(profiles)) {
  await mkdir(join(apps, app), { recursive: true })
  for (const dir of folders) await mkdir(support(data, dir), { recursive: true })
  await writeFile(support(data, 'Local State'), JSON.stringify({ profile: { info_cache: profiles } }))
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fremkit-browsers-'))
  apps = join(home, 'Apps')
  await browser('Brave Browser.app', 'BraveSoftware/Brave-Browser', {
    Default: { name: 'Perso', user_name: 'someone@example.com' },
    'Profile 1': { name: 'Boulot', user_name: 'work@example.com' },
    '../escape': { name: 'Escape' },
  }, ['Default', 'Profile 1', 'Profile 3'])
  // Edge's data is there, its bundle is not: an uninstalled browser offers nothing.
  await mkdir(support('Microsoft Edge', 'Default'), { recursive: true })
  await writeFile(support('Microsoft Edge', 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Edge' } } } }))
})
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

const profiles = () => new BrowserProfiles({ home, appDirs: [apps] })

describe('BrowserProfiles', () => {
  it('lists the installed browsers\' profiles by their names, never the account or a folder that escapes', async () => {
    const list = await profiles().list()
    expect(list).toEqual([
      { browser: 'Brave', name: 'Perso', value: 'Brave — Perso' },
      { browser: 'Brave', name: 'Boulot', value: 'Brave — Boulot' },
    ])
    expect(JSON.stringify(list)).not.toContain('example.com')
  })
  it('resolves a display name, case aside, and a dash typed for the em dash', async () => {
    const app = join(apps, 'Brave Browser.app')
    expect(await profiles().resolve('Brave — Boulot')).toEqual({ ok: true, app, dir: 'Profile 1' })
    expect(await profiles().resolve('brave - perso')).toEqual({ ok: true, app, dir: 'Default' })
  })
  it('resolves a profile folder typed by hand when it exists', async () => {
    expect(await profiles().resolve('Brave — Profile 3')).toMatchObject({ ok: true, dir: 'Profile 3' })
    expect(await profiles().resolve('Brave — Profile 9')).toEqual({ ok: false, error: 'unknownProfile' })
  })
  it('refuses a folder that would leave the data folder', async () => {
    for (const value of ['Brave — ../escape', 'Brave — ..', 'Brave — a/b', 'Brave — Escape']) {
      expect(await profiles().resolve(value), value).toEqual({ ok: false, error: 'unknownProfile' })
    }
  })
  it('refuses a browser that is not in the list or not installed', async () => {
    for (const value of ['Safari — Perso', 'Edge — Edge', 'Perso', '']) {
      expect(await profiles().resolve(value), value).toEqual({ ok: false, error: 'unknownBrowser' })
    }
  })
})

describe('GET /api/browsers/profiles', () => {
  it('answers the loopback and refuses anyone else', async () => {
    const app = Fastify()
    await app.register(browserRoutes, { profiles: profiles() })
    const local = await app.inject({ url: '/api/browsers/profiles', remoteAddress: '127.0.0.1' })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toHaveLength(2)
    expect((await app.inject({ url: '/api/browsers/profiles', remoteAddress: '198.51.100.7' })).statusCode).toBe(403)
    await app.close()
  })
})

describe('a link opened in a browser profile', () => {
  const LOCAL = { loopback: true, paired: false }
  const lookup = (buttons: unknown): InstanceLookup =>
    (id) => (id === 'sc-1' ? { widgetId: 'shortcuts', settings: { buttons } } : null)
  const open = (buttons: unknown) => {
    const run = vi.fn(async () => {})
    const p = createShortcutsProvider(run, lookup(buttons), profiles())
    return { run, press: () => p.commands!.open!({ instanceId: 'sc-1', index: 0 }, LOCAL) }
  }

  it('hands the bundle and the profile folder to open -n, the link last', async () => {
    const { run, press } = open([{ kind: 'url', target: 'https://example.com/a', profile: 'Brave — Boulot' }])
    expect(await press()).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open',
      ['-n', '-a', join(apps, 'Brave Browser.app'), '--args', '--profile-directory=Profile 1', 'https://example.com/a'])
  })
  it('opens in the default browser when no profile is set', async () => {
    const { run, press } = open([{ kind: 'url', target: 'https://example.com', profile: '' }])
    expect(await press()).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['https://example.com'])
  })
  it('refuses rather than open the link in another profile', async () => {
    const { run, press } = open([{ kind: 'url', target: 'https://example.com', profile: 'Brave — Gone' }])
    expect(await press()).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
  it('ignores a profile saved on an application button', async () => {
    const { run, press } = open([{ kind: 'app', target: 'Calculator', profile: 'Brave — Boulot' }])
    expect(await press()).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Calculator'])
  })
})
