import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { ClaudeConfigDirs, configDirOf, defaultConfigDir, keychainServiceFor, MAX_CONFIG_DIRS } from '../src/claude/configDirs.js'
import { freshestToken } from '../src/claude/account.js'
import { claudeRoutes } from '../src/claude/routes.js'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { ClaudeUsage } from '../src/claude/usage.js'

const item = (token: string, expiresAt?: number) => JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt === undefined ? {} : { expiresAt }) } })

describe('configDirOf', () => {
  it('is the folder above projects/, the last one when a parent is called projects too', () => {
    expect(configDirOf('/Users/someone/.claude/projects/-p-a/1234.jsonl')).toBe('/Users/someone/.claude')
    expect(configDirOf('/Users/someone/projects/profile/projects/-p-a/1234.jsonl')).toBe('/Users/someone/projects/profile')
    expect(configDirOf('/Users/someone/.claude/projects/-p-a/1234/subagents/agent-1.jsonl')).toBe('/Users/someone/.claude')
  })
  it('refuses anything that is not an absolute transcript path', () => {
    for (const p of [undefined, 42, '', 'relative/projects/x/y.jsonl', '/a/projects/x/y.txt', '/a/../b/projects/x/y.jsonl', '/a/b/c.jsonl', '/projects/x/y.jsonl']) {
      expect(configDirOf(p)).toBeNull()
    }
  })
})

describe('keychainServiceFor', () => {
  it('is Claude Code\'s own name: the first 8 hex of sha256(dir)', () => {
    // printf %s /tmp/a | shasum -a 256
    expect(keychainServiceFor('/tmp/a')).toBe('Claude Code-credentials-d9b741ea')
  })
})

describe('ClaudeConfigDirs', () => {
  it('learns folders from transcript paths, most recent first, capped, and keeps them across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const filePath = join(dir, 'claude-config-dirs.json')
    const dirs = new ClaudeConfigDirs({ filePath })
    await dirs.load()
    dirs.note('/u/a/projects/p/1.jsonl')
    dirs.note('/u/b/projects/p/1.jsonl')
    dirs.note('/u/a/projects/p/2.jsonl')
    dirs.note('nonsense')
    expect(dirs.list()).toEqual(['/u/a', '/u/b'])
    for (let i = 0; i < MAX_CONFIG_DIRS + 3; i++) dirs.note(`/u/n${i}/projects/p/1.jsonl`)
    expect(dirs.list()).toHaveLength(MAX_CONFIG_DIRS)
    await dirs.flush()
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    const again = new ClaudeConfigDirs({ filePath })
    await again.load()
    expect(again.list()).toEqual(dirs.list())
  })
  it('drops what a hand-edited file holds that an event could never have taught it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const filePath = join(dir, 'claude-config-dirs.json')
    await writeFile(filePath, JSON.stringify({ dirs: ['/u/a', 'relative', '/u/../etc'] }))
    const dirs = new ClaudeConfigDirs({ filePath })
    await dirs.load()
    expect(dirs.list()).toEqual(['/u/a'])
  })
  it('remembers when each folder last sent an event, across restarts, without a write per event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const filePath = join(dir, 'claude-config-dirs.json')
    let t = 1_000_000
    const dirs = new ClaudeConfigDirs({ filePath, now: () => t })
    await dirs.load()
    dirs.note('/u/a/projects/p/1.jsonl')
    dirs.note('/u/b/projects/p/1.jsonl')
    expect(dirs.lastSeen('/u/a')).toBe(1_000_000)
    expect(dirs.lastSeen('/u/never')).toBeNull()
    t += 60_000
    dirs.note('/u/b/projects/p/2.jsonl')
    // Seen in memory at once; the file catches up within the hour, not on every event.
    expect(dirs.lastSeen('/u/b')).toBe(1_060_000)
    await dirs.flush()
    expect(JSON.parse(await readFile(filePath, 'utf8')).seen['/u/b']).toBe(1_000_000)
    t += 60 * 60_000
    dirs.note('/u/b/projects/p/3.jsonl')
    await dirs.flush()
    const again = new ClaudeConfigDirs({ filePath })
    await again.load()
    expect(again.lastSeen('/u/b')).toBe(t)
    expect(again.lastSeen('/u/a')).toBe(1_000_000)
  })
  it('reads a file written before folders had a last-seen time as never seen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const filePath = join(dir, 'claude-config-dirs.json')
    await writeFile(filePath, JSON.stringify({ dirs: ['/u/a'] }))
    const dirs = new ClaudeConfigDirs({ filePath })
    await dirs.load()
    expect(dirs.list()).toEqual(['/u/a'])
    expect(dirs.lastSeen('/u/a')).toBeNull()
  })
  it('is fed by the hook route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const configDirs = new ClaudeConfigDirs()
    const usage = new ClaudeUsage({ filePath: join(dir, 'usage.json'), transcriptsDir: join(dir, 'none') })
    const app = Fastify()
    await app.register(claudeRoutes, { tracker: new ClaudeTracker(), usage, configDirs })
    const res = await app.inject({ method: 'POST', url: '/api/hooks/claude', payload: { hook_event_name: 'StatusLine', session_id: 'a', transcript_path: '/u/profile/projects/-p/a.jsonl' } })
    expect(res.statusCode).toBe(204)
    expect(configDirs.list()).toEqual(['/u/profile'])
    await app.close()
  })
})

describe('freshestToken', () => {
  it('ranks an item that does not say when it expires after every one that does', () => {
    expect(freshestToken([{ token: 'unknown', expiresAt: null }, { token: 'dated', expiresAt: 1 }])).toBe('dated')
    expect(freshestToken([null, { token: 'only', expiresAt: null }])).toBe('only')
    expect(freshestToken([])).toBeNull()
  })
})

describe('ClaudeUsage over several configuration folders', () => {
  it('counts today\'s tokens in the default tree and in every learnt folder\'s projects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-dirs-'))
    const now = new Date('2026-09-16T15:00:00Z')
    const write = async (root: string, id: string, input: number) => {
      const folder = join(root, 'projects', '-p')
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${id}.jsonl`)
      await writeFile(file, JSON.stringify({ type: 'assistant', timestamp: now.toISOString(), message: { id, usage: { input_tokens: input } } }) + '\n')
      await utimes(file, now, now)
    }
    await write(join(dir, 'default'), 'a', 10)
    await write(join(dir, 'profile'), 'b', 5)
    let learnt: string[] = []
    const usage = new ClaudeUsage({ filePath: join(dir, 'u.json'), transcriptsDir: join(dir, 'default', 'projects'), moreTranscriptsDirs: () => learnt.map((d) => join(d, 'projects')), now: () => now.getTime() })
    await usage.refreshToday()
    expect(usage.snapshot().today).toMatchObject({ input: 10, sessions: 1 })
    learnt = [join(dir, 'profile'), join(dir, 'default')]
    await usage.refreshToday()
    expect(usage.snapshot().today).toMatchObject({ input: 15, sessions: 2 })
  })
})
