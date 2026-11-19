import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { ClaudeAccountDiscovery, claudeJsonOf, parseFolderAccount, planOf } from '../src/claude/accounts.js'
import { defaultConfigDir } from '../src/claude/configDirs.js'

// Placeholder accounts: nothing here is anybody's.
const UUID_A = '00000000-0000-4000-8000-00000000000a'
const UUID_B = '00000000-0000-4000-8000-00000000000b'
const claudeJson = (uuid: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  numStartups: 3,
  projects: { '/p': {} },
  oauthAccount: { accountUuid: uuid, emailAddress: 'someone@example.com', organizationType: 'claude_max', organizationName: 'someone@example.com\'s Organization', ...extra },
})

describe('planOf', () => {
  it('names the plan from the organisation type, else from a display name', () => {
    expect(planOf('claude_max')).toBe('Max')
    expect(planOf('claude_team')).toBe('Team')
    expect(planOf('claude_pro')).toBe('Pro')
    expect(planOf('claude_enterprise')).toBe('Enterprise')
    expect(planOf('something_new', 'Max 20x')).toBe('Max 20x')
    expect(planOf(undefined, undefined)).toBeNull()
    expect(planOf('something_new')).toBeNull()
    // A display name is free text from a file: never an address, never a paragraph.
    expect(planOf(undefined, 'a@example.com')).toBeNull()
    expect(planOf(undefined, 'x'.repeat(200))).toBeNull()
  })
})

describe('claudeJsonOf', () => {
  it('is ~/.claude.json for the default folder and <dir>/.claude.json for any other', () => {
    expect(claudeJsonOf(defaultConfigDir(), '/home/u')).toBe('/home/u/.claude.json')
    expect(claudeJsonOf('/u/profile', '/home/u')).toBe('/u/profile/.claude.json')
  })
})

describe('parseFolderAccount', () => {
  it('reads the account uuid, the plan, an organisation that is not an address, and the e-mail', () => {
    expect(parseFolderAccount(claudeJson(UUID_A, { organizationName: 'Example Corp' }))).toEqual({
      uuid: UUID_A, plan: 'Max', org: 'Example Corp', email: 'someone@example.com',
    })
  })
  it('treats "<email>\'s Organization" as the e-mail it is', () => {
    expect(parseFolderAccount(claudeJson(UUID_A))?.org).toBeNull()
  })
  it('is no account when logged out, signed in with an API key, or unreadable', () => {
    expect(parseFolderAccount(JSON.stringify({ numStartups: 1 }))).toBeNull()
    expect(parseFolderAccount(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))).toBeNull()
    expect(parseFolderAccount(JSON.stringify({ oauthAccount: { accountUuid: '../../etc' } }))).toBeNull()
    expect(parseFolderAccount('{ nope')).toBeNull()
  })
})

describe('ClaudeAccountDiscovery', () => {
  const home = '/home/u'
  function setup(files: Record<string, string>, dirs: string[], seen: Record<string, number> = {}) {
    let mtime = 1
    const read = vi.fn(async (path: string) => { if (!(path in files)) throw new Error('ENOENT'); return files[path] })
    const stat = vi.fn(async (path: string) => { if (!(path in files)) throw new Error('ENOENT'); return mtime })
    const discovery = new ClaudeAccountDiscovery({ dirs: () => dirs, lastSeen: (d) => seen[d] ?? null, home, read, stat })
    return { discovery, read, stat, touch: () => { mtime += 1 } }
  }

  it('maps each folder to its account, and two folders on one account to one account', async () => {
    const { discovery } = setup({
      '/u/orca-1/.claude.json': claudeJson(UUID_A),
      '/u/orca-2/.claude.json': claudeJson(UUID_B, { organizationType: 'claude_team', organizationName: 'Example Corp' }),
      [join(home, '.claude.json')]: claudeJson(UUID_A),
    }, ['/u/orca-1', '/u/orca-2'], { '/u/orca-1': 500, [defaultConfigDir()]: 900 })
    const accounts = await discovery.list()
    expect(accounts).toEqual([
      { uuid: UUID_A, plan: 'Max', org: null, email: 'someone@example.com', dirs: ['/u/orca-1', defaultConfigDir()], lastSeen: 900 },
      { uuid: UUID_B, plan: 'Team', org: 'Example Corp', email: 'someone@example.com', dirs: ['/u/orca-2'], lastSeen: null },
    ])
  })

  it('gives a logged-out folder, or one without a .claude.json, no account', async () => {
    const { discovery } = setup({ '/u/out/.claude.json': JSON.stringify({ numStartups: 2 }) }, ['/u/out', '/u/missing'])
    expect(await discovery.list()).toEqual([])
  })

  it('reads a folder\'s file again only once it has changed', async () => {
    const { discovery, read, touch } = setup({ '/u/a/.claude.json': claudeJson(UUID_A) }, ['/u/a'])
    await discovery.list()
    await discovery.list()
    expect(read.mock.calls.filter(([p]) => p === '/u/a/.claude.json')).toHaveLength(1)
    touch()
    await discovery.list()
    expect(read.mock.calls.filter(([p]) => p === '/u/a/.claude.json')).toHaveLength(2)
  })
})
