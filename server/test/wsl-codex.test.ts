import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWslCodexClient, wslCodexArgs, WSL_CODEX_SCRIPT } from '../src/codex/adapter.js'
import { codexWslDistro, createCodexSessionsReader, createWslSessionReader, sweepWslCopies, wslRolloutPath } from '../src/wsl/codex.js'
import { createSessionReader } from '../src/codex/observations.js'
import type { WslRun } from '../src/wsl/distros.js'

const A = '00000000-0000-4000-8000-000000000001'
const now = 1800000000000
const line = (type: string, payload: unknown, at = now) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n'
const HOME = '/home/example'
const platforms: NodeJS.Platform[] = process.platform === 'win32' ? ['win32'] : ['darwin', 'win32']

const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A distribution's home as Windows would see it, with a Codex that stored POSIX paths. */
async function distro() {
  const root = await tmp('wsl-root-')
  const dataDir = await tmp('wsl-data-')
  await mkdir(join(root, '.codex', 'sessions'), { recursive: true })
  await writeFile(join(root, '.codex', 'sessions', 'a.jsonl'),
    line('session_meta', { id: A }) + line('event_msg', { type: 'task_started', turn_id: 't', started_at: (now - 1000) / 1000 }, now - 1000))
  const db = new DatabaseSync(join(root, '.codex', 'state_5.sqlite'))
  try {
    db.exec(`
      CREATE TABLE threads (id TEXT, rollout_path TEXT, model TEXT, reasoning_effort TEXT,
        cwd TEXT, git_branch TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT,
        archived INTEGER, updated_at INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ('${A}','${HOME}/.codex/sessions/a.jsonl','stored-model','low','${HOME}/project','main',NULL,NULL,NULL,0,1);
    `)
  } finally { db.close() }
  return { root, dataDir }
}

describe('the Codex app-server inside WSL', () => {
  it('runs wsl.exe by absolute path with exactly the fixed argument list', async () => {
    expect(WSL_CODEX_SCRIPT).toBe('exec codex app-server --listen stdio:// -c features.hooks=false -c features.codex_hooks=false -c analytics.enabled=false')
    expect(wslCodexArgs('Ubuntu-24.04')).toEqual(['-d', 'Ubuntu-24.04', '--cd', '~', '--exec', 'bash', '-lc', 'exec codex app-server --listen stdio:// -c features.hooks=false -c features.codex_hooks=false -c analytics.enabled=false'])
    const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const spawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options })
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
      return child
    })
    const client = await createWslCodexClient({ distro: 'Ubuntu-24.04', env: { SystemRoot: 'D:\\Windows', WSLENV: 'X', OPENAI_API_KEY: 'secret' }, spawn: spawn as never })
    expect(client.supports('account/read')).toBe(true)
    expect(client.supports('turn/start')).toBe(false)
    const pending = client.request('account/read', { refreshToken: false }).catch((e) => e)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].file).toBe('D:\\Windows\\System32\\wsl.exe')
    expect(calls[0].args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '~', '--exec', 'bash', '-lc', 'exec codex app-server --listen stdio:// -c features.hooks=false -c features.codex_hooks=false -c analytics.enabled=false'])
    expect(calls[0].options).toMatchObject({ shell: false })
    const env = calls[0].options.env as Record<string, string>
    expect(env.WSLENV).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    client.close()
    expect(await pending).toMatchObject({ reason: 'offline' })
  })

  it('refuses a distribution name that could be an option or a path', async () => {
    for (const bad of ['-d x', '../x', 'a b', '', '..', '.', '--exec', '-d']) {
      expect(() => wslCodexArgs(bad), bad).toThrow()
      await expect(createWslCodexClient({ distro: bad, spawn: vi.fn() as never })).rejects.toMatchObject({ reason: 'refused' })
    }
  })
})

describe('wslRolloutPath', () => {
  it('maps a rollout under the Codex home and nothing else', () => {
    expect(wslRolloutPath(`${HOME}/.codex/sessions/2026/a.jsonl`, HOME, '/r')).toBe(join('/r', '.codex', 'sessions', '2026', 'a.jsonl'))
    for (const bad of ['/etc/passwd', `${HOME}/.codex/../x`, `${HOME}/.codex/a\\b`, `${HOME}/.codex/`, `${HOME}/.codexx/a`, `${HOME}/.codex//a`]) {
      expect(wslRolloutPath(bad, HOME, '/r'), bad).toBeNull()
    }
  })
})

describe.each(platforms)('the Codex history inside WSL (%s)', (platform) => {
  it('reads a copy of the state database and the rollout through the distribution root', async () => {
    const { root, dataDir } = await distro()
    const read = createWslSessionReader({ root, home: HOME, dataDir, platform })
    const { sessions } = await read([A], now)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: A, project: 'project', model: 'stored-model', state: 'working' })
    // The copy is gone once the read is over.
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
  })
})

describe('the Codex state copy', () => {
  it('lives in a private folder of the data folder, with private files, removed after the read', async () => {
    const { root, dataDir } = await distro()
    await writeFile(join(root, '.codex', 'state_5.sqlite-wal'), 'wal')
    const seen: { dir: string; dirMode: number; files: Record<string, number> }[] = []
    const query = async (_sql: string, path: string) => {
      const dir = join(path, '..')
      const files: Record<string, number> = {}
      for (const name of await readdir(dir)) files[name] = (await stat(join(dir, name))).mode & 0o777
      seen.push({ dir, dirMode: (await stat(dir)).mode & 0o777, files })
      return []
    }
    await createWslSessionReader({ root, home: HOME, dataDir, query })([A], now)
    expect(seen).toHaveLength(1)
    expect(seen[0].dir.startsWith(join(dataDir, 'tmp', 'wsl-codex-'))).toBe(true)
    if (process.platform !== 'win32') {
      expect(seen[0].dirMode).toBe(0o700)
      expect(seen[0].files).toEqual({ 'state_5.sqlite': 0o600, 'state_5.sqlite-wal': 0o600 })
    }
    await expect(stat(seen[0].dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports offline when the database is missing, and still removes the folder', async () => {
    const root = await tmp('wsl-root-')
    const dataDir = await tmp('wsl-data-')
    await expect(createWslSessionReader({ root, home: HOME, dataDir })([A], now)).rejects.toThrow()
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([])
  })

  it('reports offline after 5 s when the distribution does not answer, without starting a second read', async () => {
    const { root, dataDir } = await distro()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const query = vi.fn(() => new Promise<unknown>(() => {}))
    const read = createWslSessionReader({ root, home: HOME, dataDir, query })
    const first = read([A], now)
    const outcome = expect(first).rejects.toThrow('offline')
    // The copy is real file work: let it reach the query before the clock moves.
    for (let i = 0; i < 1000 && query.mock.calls.length === 0; i++) await new Promise((r) => setImmediate(r))
    expect(query).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    await outcome
    await expect(read([A], now)).rejects.toThrow('offline')
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('a copy that does not settle', () => {
  it('stays the only one across polls, and its folder goes once it settles', async () => {
    const { root, dataDir } = await distro()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const copies = vi.fn(async (src: string, dest: string) => {
      if (src.endsWith('state_5.sqlite')) await gate
      await copyFile(src, dest)
    })
    const read = createWslSessionReader({ root, home: HOME, dataDir, copyFile: copies })
    for (let poll = 0; poll < 3; poll++) {
      const outcome = expect(read([A], now)).rejects.toThrow('offline')
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(5000)
      await outcome
    }
    expect(copies).toHaveBeenCalledTimes(1)
    expect(await readdir(join(dataDir, 'tmp'))).toHaveLength(1)
    release()
    await vi.waitFor(async () => expect(await readdir(join(dataDir, 'tmp'))).toEqual([]))
    // Settled and cleaned up: the next poll copies again.
    vi.useRealTimers()
    expect((await read([A], now)).sessions).toHaveLength(1)
    expect(copies.mock.calls.filter(([src]) => src.endsWith('state_5.sqlite'))).toHaveLength(2)
  })
})

describe('sweepWslCopies', () => {
  it('removes the copy folders a stopped server left, and nothing else', async () => {
    const dataDir = await tmp('wsl-data-')
    await mkdir(join(dataDir, 'tmp', 'wsl-codex-abc123'), { recursive: true })
    await writeFile(join(dataDir, 'tmp', 'wsl-codex-abc123', 'state_5.sqlite'), 'x')
    await mkdir(join(dataDir, 'tmp', 'other'))
    await sweepWslCopies(dataDir)
    expect(await readdir(join(dataDir, 'tmp'))).toEqual(['other'])
    await sweepWslCopies(await tmp('wsl-empty-'))
  })
})

describe('createCodexSessionsReader', () => {
  it('reads the Windows home unless Codex runs in a distribution, and asks only a ticked one', async () => {
    const windows = vi.fn(async () => ({ sessions: [], truncated: false }))
    const run = vi.fn<WslRun>(async () => `${HOME}\n`)
    let distroName: string | null = null
    let ticked: string[] = ['Ubuntu']
    const read = createCodexSessionsReader({
      windows: windows as unknown as ReturnType<typeof createSessionReader>,
      distro: () => distroName, ticked: () => ticked, platform: 'win32', run, cache: new Map(), dataDir: await tmp('wsl-data-'),
    })
    await read([A], now)
    expect(windows).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    distroName = 'Debian'
    ticked = ['Ubuntu']
    await expect(read([A], now)).rejects.toThrow('offline')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('codexWslDistro', () => {
  const env = { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }
  it('is the first ticked distribution, only when Windows has no Codex', () => {
    expect(codexWslDistro({ ticked: ['Ubuntu', 'Debian'], platform: 'win32', env, exists: () => false })).toBe('Ubuntu')
    expect(codexWslDistro({ ticked: ['Ubuntu'], platform: 'win32', env, exists: () => true })).toBeNull()
    expect(codexWslDistro({ ticked: [], platform: 'win32', env, exists: () => false })).toBeNull()
    expect(codexWslDistro({ ticked: ['Ubuntu'], platform: 'darwin', env, exists: () => false })).toBeNull()
  })
})
