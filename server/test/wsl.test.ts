import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanDistroNames, distroHome, distroRoot, listDistros, readWithTimeout, validHome, wslRoots, type WslListHost, type WslRun,
} from '../src/wsl/distros.js'
import { wslRoutes } from '../src/wsl/routes.js'
import { buildApp } from '../src/app.js'
import { ClaudeUsage } from '../src/claude/usage.js'
import { generateToken } from '../src/http/access.js'

/** What `wsl.exe --list --quiet` writes: UTF-16LE with a byte-order mark and CRLF line ends. */
const LIST_FIXTURE = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n\r\nbad name\r\n../x\r\n', 'utf16le'),
])

const hostAnswering = (value: unknown) => {
  const call = vi.fn(async () => value)
  return { host: { call } as unknown as WslListHost, call }
}

describe('listDistros', () => {
  it('keeps the valid names of the UTF-16LE list and drops the rest', () => {
    // What the PowerShell host hands back, one decoded line each, residue included.
    const lines = LIST_FIXTURE.toString('utf16le').split('\n').map((l) => `${l}\u0000`)
    expect(cleanDistroNames(lines)).toEqual(['Ubuntu-24.04', 'docker-desktop'])
    expect(cleanDistroNames(['Ubuntu', 'Ubuntu', 'x'.repeat(65)])).toEqual(['Ubuntu'])
    // The schema's characters allow an all-dots name; it would name no distribution but a path.
    expect(cleanDistroNames(['.', '..', 'Ubuntu.dev'])).toEqual(['Ubuntu.dev'])
    expect(cleanDistroNames('Ubuntu')).toEqual([])
  })

  it('asks the host on Windows', async () => {
    const { host, call } = hostAnswering(['﻿Ubuntu', 'Debian'])
    expect(await listDistros(host, 'win32')).toEqual(['Ubuntu', 'Debian'])
    expect(call).toHaveBeenCalledWith('wsl.list', undefined, expect.any(Number))
  })

  it('answers nothing, and asks nothing, off Windows', async () => {
    const { host, call } = hostAnswering(['Ubuntu'])
    expect(await listDistros(host, 'darwin')).toEqual([])
    expect(await listDistros(host, 'linux')).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('answers nothing when WSL is not there', async () => {
    const host = { call: vi.fn(async () => { throw new Error('no-wsl') }) } as unknown as WslListHost
    expect(await listDistros(host, 'win32')).toEqual([])
  })
})

describe('GET /api/wsl/distros', () => {
  it('answers the platform and the installed names', async () => {
    const app = Fastify()
    await app.register(wslRoutes, { platform: 'win32', list: async () => ['Ubuntu-24.04'] })
    const res = await app.inject({ url: '/api/wsl/distros' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ platform: 'win32', distros: ['Ubuntu-24.04'] })
    await app.close()
  })

  it('answers an empty list off Windows, behind the access secret like every route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-wsl-'))
    await mkdir(join(dir, 'widgets'))
    const token = generateToken()
    try {
      const app = await buildApp({ accessToken: token, port: 4301, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), platform: 'darwin' })
      try {
        const refused = await app.inject({ url: '/api/wsl/distros', headers: { host: '127.0.0.1:4301' } })
        expect(refused.statusCode).toBe(401)
        const res = await app.inject({ url: '/api/wsl/distros', headers: { host: '127.0.0.1:4301', authorization: `Bearer ${token}` } })
        expect(res.json()).toEqual({ platform: 'darwin', distros: [] })
      } finally { await app.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never lists in a demo, even on Windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-wsl-'))
    try {
      await mkdir(join(dir, 'widgets'))
      const list = vi.fn(async () => ['Ubuntu'])
      const app = await buildApp({ accessToken: null, demo: true, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), platform: 'win32', wsl: { list } })
      try {
        const res = await app.inject({ url: '/api/wsl/distros' })
        expect(res.json()).toEqual({ platform: 'win32', distros: [] })
        expect(list).not.toHaveBeenCalled()
      } finally { await app.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})


describe('distroHome', () => {
  const env = { SystemRoot: 'C:\\Windows', WSLENV: 'USERPROFILE/p', WSL_UTF8: '1', USERPROFILE: 'C:\\Users\\example' }
  const answering = (stdout: string) => vi.fn<WslRun>(async () => stdout)

  it('never runs wsl.exe for a distribution that is not ticked, nor off Windows', async () => {
    const run = answering('/home/example\n')
    expect(await distroHome('Ubuntu', { ticked: [], platform: 'win32', env, run, cache: new Map() })).toBeNull()
    expect(await distroHome('Ubuntu', { ticked: ['Debian'], platform: 'win32', env, run, cache: new Map() })).toBeNull()
    expect(await distroHome('Ubuntu', { ticked: ['Ubuntu'], platform: 'darwin', env, run, cache: new Map() })).toBeNull()
    expect(await distroHome('-d x', { ticked: ['-d x'], platform: 'win32', env, run, cache: new Map() })).toBeNull()
    // A name that would be an option to wsl.exe never reaches its argument list.
    for (const option of ['--exec', '-d', '-u']) {
      expect(await distroHome(option, { ticked: [option], platform: 'win32', env, run, cache: new Map() }), option).toBeNull()
      expect(() => distroRoot(option, '/home/example'), option).toThrow()
    }
    expect(cleanDistroNames(['--exec', '-d', 'Ubuntu'])).toEqual(['Ubuntu'])
    expect(run).not.toHaveBeenCalled()
  })

  it('asks a ticked distribution once, by absolute path, with a fixed argument list and a bare environment', async () => {
    const run = answering('/home/example\n')
    const cache = new Map()
    const deps = { ticked: ['Ubuntu-24.04'], platform: 'win32' as const, env, run, cache }
    expect(await distroHome('Ubuntu-24.04', deps)).toBe('/home/example')
    expect(await distroHome('Ubuntu-24.04', deps)).toBe('/home/example')
    expect(run).toHaveBeenCalledTimes(1)
    const [file, args, childEnv] = run.mock.calls[0]
    expect(file).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(args).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'printenv', 'HOME'])
    expect(childEnv).toEqual({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\example' })
  })

  it('caches a failed lookup, and never lets the cache outlive an untick', async () => {
    const run = vi.fn<WslRun>(async () => { throw new Error('offline') })
    const cache = new Map()
    expect(await distroHome('Broken', { ticked: ['Broken'], platform: 'win32', env, run, cache })).toBeNull()
    expect(await distroHome('Broken', { ticked: ['Broken'], platform: 'win32', env, run, cache })).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    const ok = answering('/home/example')
    const okCache = new Map()
    expect(await distroHome('Ubuntu', { ticked: ['Ubuntu'], platform: 'win32', env, run: ok, cache: okCache })).toBe('/home/example')
    expect(await distroHome('Ubuntu', { ticked: [], platform: 'win32', env, run: ok, cache: okCache })).toBeNull()
    // A newly ticked name is looked up even though another one is cached.
    expect(await distroHome('Debian', { ticked: ['Ubuntu', 'Debian'], platform: 'win32', env, run: ok, cache: okCache })).toBe('/home/example')
    expect(ok).toHaveBeenCalledTimes(2)
  })

  it('forgets a failure after a minute, never a found home, and shares a pending lookup', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn<WslRun>(async () => { throw new Error('offline') })
      const deps = { ticked: ['Ubuntu'], platform: 'win32' as const, env, run, cache: new Map() }
      expect(await distroHome('Ubuntu', deps)).toBeNull()
      expect(run).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(59_000)
      expect(await distroHome('Ubuntu', deps)).toBeNull()
      expect(run).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2_000)
      run.mockImplementation(async () => '/home/example\n')
      expect(await distroHome('Ubuntu', deps)).toBe('/home/example')
      expect(run).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(3_600_000)
      expect(await distroHome('Ubuntu', deps)).toBe('/home/example')
      expect(run).toHaveBeenCalledTimes(2)
      let finish!: (stdout: string) => void
      const slow = vi.fn<WslRun>(() => new Promise<string>((resolve) => { finish = resolve }))
      const slowDeps = { ticked: ['Debian'], platform: 'win32' as const, env, run: slow, cache: new Map() }
      const both = Promise.all([distroHome('Debian', slowDeps), distroHome('Debian', slowDeps)])
      finish('/home/example')
      expect(await both).toEqual(['/home/example', '/home/example'])
      expect(slow).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('accepts only a plain absolute POSIX path', async () => {
    for (const bad of ['home/example', '/home/../etc', '/home/ex\\ample', '/home/a\u0000b', '', 'C:\\Users\\x', '/a/..']) {
      expect(validHome(bad), bad).toBeNull()
      expect(await distroHome('Ubuntu', { ticked: ['Ubuntu'], platform: 'win32', env, run: answering(bad), cache: new Map() }), bad).toBeNull()
    }
    expect(validHome('/')).toBe('/')
    expect(validHome('/home/example.name')).toBe('/home/example.name')
  })
})

describe('distroRoot', () => {
  it('turns the home folder into a \\\\wsl.localhost path', () => {
    expect(distroRoot('Ubuntu-24.04', '/home/example')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\example')
    expect(distroRoot('Ubuntu', '/root/')).toBe('\\\\wsl.localhost\\Ubuntu\\root')
    expect(distroRoot('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu')
    expect(() => distroRoot('../x', '/home/example')).toThrow()
    expect(() => distroRoot('..', '/home/example')).toThrow()
    expect(() => distroRoot('Ubuntu', '/home/../x')).toThrow()
  })
})

describe('wslRoots', () => {
  it('keeps the ticked order and skips a distribution whose home is unknown', async () => {
    const run = vi.fn<WslRun>(async (_file, args) => {
      if (args[1] === 'Broken') throw new Error('offline')
      return `/home/${args[1].toLowerCase()}\n`
    })
    const deps = { ticked: ['Debian', 'Broken', 'Ubuntu'], platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, run, cache: new Map() }
    // The first poll starts the lookups and waits for none of them.
    expect(await wslRoots(deps)).toEqual([])
    expect(run).toHaveBeenCalledTimes(3)
    await new Promise((resolve) => setImmediate(resolve))
    const roots = await wslRoots(deps)
    expect(run).toHaveBeenCalledTimes(3)
    expect(roots).toEqual([
      { distro: 'Debian', root: '\\\\wsl.localhost\\Debian\\home\\debian' },
      { distro: 'Ubuntu', root: '\\\\wsl.localhost\\Ubuntu\\home\\ubuntu' },
    ])
    expect(await wslRoots({ ticked: ['Ubuntu'], platform: 'darwin', run, cache: new Map() })).toEqual([])
  })

  it('never lets a lookup that does not settle hold up the Windows folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-wsl-usage-'))
    try {
      const at = Date.now()
      const windows = join(dir, 'windows')
      await mkdir(join(windows, 'project'), { recursive: true })
      await writeFile(join(windows, 'project', 's.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: 'm1', usage: { input_tokens: 7, output_tokens: 1 } },
      }) + '\n')
      const run = vi.fn<WslRun>(() => new Promise<string>(() => {}))
      const deps = { ticked: ['Stuck'], platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, run, cache: new Map() }
      const usage = new ClaudeUsage({
        filePath: join(dir, 'u.json'), transcriptsDir: windows, now: () => at,
        transcriptsDirs: async () => (await wslRoots(deps)).map((r) => join(r.root, '.claude', 'projects')),
      })
      await usage.refreshToday()
      await usage.refreshToday()
      expect(usage.snapshot().today.input).toBe(7)
      expect(run).toHaveBeenCalledTimes(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('readWithTimeout', () => {
  afterEach(() => { vi.useRealTimers() })

  it('rejects with offline when a read never settles', async () => {
    vi.useFakeTimers()
    const pending = readWithTimeout(() => new Promise<string>(() => {}))
    const outcome = expect(pending).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(4999)
    let settled = false
    void pending.catch(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await outcome
  })

  it('answers what the read answers, and passes its failure on', async () => {
    expect(await readWithTimeout(async () => 'ok')).toBe('ok')
    await expect(readWithTimeout(async () => { throw new Error('ENOENT') })).rejects.toThrow('ENOENT')
  })
})
