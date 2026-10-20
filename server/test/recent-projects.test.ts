import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecentProjectsProvider, mergeEntries, mergedWants, tileWants, MAX_PROJECTS,
  type RecentProjectsSnapshot,
} from '../src/providers/recent-projects/index.js'
import { canonicalProject, isAllowedProject, shortParent } from '../src/providers/recent-projects/paths.js'
import { repoTouchedAt, scanRoot, gitSource } from '../src/providers/recent-projects/sources/git.js'
import { createClaudeSource, decodeClaudeName, encodeClaudeName } from '../src/providers/recent-projects/sources/claude.js'
import { createCodexSource, sessionCwd } from '../src/providers/recent-projects/sources/codex.js'
import { createVscodeSource, parseRecentlyOpened } from '../src/providers/recent-projects/sources/vscode.js'
import { parseRecentProjects } from '../src/providers/recent-projects/sources/jetbrains.js'
import { binaryCandidates, createCliSources, parseHerdrPanes, parseTmux, parseZoxide } from '../src/providers/recent-projects/sources/cli.js'
import { installedApps, openWith } from '../src/providers/recent-projects/apps.js'
import { detectHerdrTerminal } from '../src/providers/recent-projects/herdr.js'
import { LIVE_MEMORY, loadMemory } from '../src/providers/recent-projects/memory.js'
import type { Source } from '../src/providers/recent-projects/types.js'
import { BUILTIN_ONLY_CHANNELS } from '../src/widgets/manifest.js'
import { LOCAL_ONLY_CHANNELS } from '../src/ws/hub.js'

const LOCAL = { loopback: true, paired: false }
const T = (iso: string) => Date.parse(iso)

/** A throwaway home folder, canonical (macOS puts tmpdir behind /var → /private/var). */
let home = ''
beforeEach(async () => { home = await realpath(await mkdtemp(join(tmpdir(), 'fremkit-recent-'))) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function repo(path: string, at: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
  await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const d = new Date(at)
  await utimes(join(path, '.git', 'HEAD'), d, d)
}

describe('recent projects: paths', () => {
  it('allows the home folder and the volumes, never the system, the home itself or its Library', () => {
    expect(isAllowedProject('/Users/me/Dev/app', '/Users/me')).toBe(true)
    expect(isAllowedProject('/Volumes/Dev/app', '/Users/me')).toBe(true)
    expect(isAllowedProject('/Users/me', '/Users/me')).toBe(false)
    expect(isAllowedProject('/Users/me/Library/Caches', '/Users/me')).toBe(false)
    expect(isAllowedProject('/Volumes/Dev', '/Users/me')).toBe(false)
    expect(isAllowedProject('/private/tmp/x', '/Users/me')).toBe(false)
    expect(isAllowedProject('/Users/other/app', '/Users/me')).toBe(false)
    expect(isAllowedProject('/Users/me/app/node_modules/x', '/Users/me')).toBe(false)
    expect(isAllowedProject('relative/path', '/Users/me')).toBe(false)
  })

  it('canonicalises through symlinks and drops what is missing, a file, or escapes home', async () => {
    await mkdir(join(home, 'Dev', 'app'), { recursive: true })
    await symlink(join(home, 'Dev', 'app'), join(home, 'link'))
    await writeFile(join(home, 'file.txt'), 'x')
    await symlink(tmpdir(), join(home, 'out'))
    expect(await canonicalProject(join(home, 'link'), home)).toBe(join(home, 'Dev', 'app'))
    expect(await canonicalProject(join(home, 'missing'), home)).toBeNull()
    expect(await canonicalProject(join(home, 'file.txt'), home)).toBeNull()
    expect(await canonicalProject(join(home, 'out'), home)).toBeNull()
  })

  it('shortens the parent folder under home', () => {
    expect(shortParent('/Users/me/Dev/app', '/Users/me')).toBe('~/Dev')
    expect(shortParent('/Users/me/app', '/Users/me')).toBe('~')
    expect(shortParent('/Volumes/Dev/app', '/Users/me')).toBe('/Volumes/Dev')
  })
})

describe('recent projects: git source', () => {
  it('finds repositories at most three folders down, skipping dependencies and hidden folders', async () => {
    const root = join(home, 'Dev')
    await repo(join(root, 'one'), '2026-10-01T10:00:00Z')
    await repo(join(root, 'client', 'two'), '2026-10-02T10:00:00Z')
    await repo(join(root, 'a', 'b', 'three'), '2026-10-03T10:00:00Z')
    await repo(join(root, 'a', 'b', 'c', 'four'), '2026-10-04T10:00:00Z')
    await repo(join(root, 'node_modules', 'dep'), '2026-10-05T10:00:00Z')
    await repo(join(root, '.cache', 'hidden'), '2026-10-05T10:00:00Z')
    await repo(join(root, 'one', 'nested'), '2026-10-05T10:00:00Z')
    const found = await scanRoot(root)
    expect(found.map((e) => e.path.slice(root.length)).sort()).toEqual(['/a/b/three', '/client/two', '/one'])
    expect(found.find((e) => e.path.endsWith('/one'))?.seenAt).toBe(T('2026-10-01T10:00:00Z'))
  })

  it('dates a worktree through the git folder its .git file names, newest of HEAD and index', async () => {
    const gitDir = join(home, 'main', '.git', 'worktrees', 'wt')
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref\n')
    await writeFile(join(gitDir, 'index'), 'x')
    await utimes(join(gitDir, 'HEAD'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))
    await utimes(join(gitDir, 'index'), new Date('2026-09-02T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))
    await mkdir(join(home, 'wt'))
    await writeFile(join(home, 'wt', '.git'), `gitdir: ${gitDir}\n`)
    expect(await repoTouchedAt(join(home, 'wt'))).toBe(T('2026-09-02T00:00:00Z'))
  })

  it('walks the roots as typed, `~` included, and tags each repository with its root', async () => {
    await repo(join(home, 'Dev', 'app'), '2026-10-01T10:00:00Z')
    const entries = await gitSource.list({ home, gitRoots: ['~/Dev', '/nonexistent', '/System'] })
    expect(entries).toEqual([{ path: join(home, 'Dev', 'app'), seenAt: T('2026-10-01T10:00:00Z'), gitRoot: '~/Dev' }])
  })
})

describe('recent projects: claude source', () => {
  it('encodes like Claude Code and decodes against the disk, trying the lossy candidates', async () => {
    await mkdir(join(home, 'Dev', 'my.site', 'api_v2'), { recursive: true })
    await mkdir(join(home, 'Dev', 'my'), { recursive: true }) // a decoy that leads nowhere
    const encoded = encodeClaudeName(join(home, 'Dev', 'my.site', 'api_v2').slice(home.length))
    expect(encoded).toBe('-Dev-my-site-api-v2')
    expect(await decodeClaudeName(encoded, home)).toBe(join(home, 'Dev', 'my.site', 'api_v2'))
    expect(await decodeClaudeName('-Dev-gone', home)).toBeNull()
  })

  it('dates a project by the newest file inside, and never opens a transcript', async () => {
    await mkdir(join(home, 'Dev', 'app'), { recursive: true })
    const projects = join(home, 'claude-projects')
    const folder = join(projects, '-Dev-app')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'a.jsonl'), 'secret transcript')
    await writeFile(join(folder, 'b.jsonl'), 'secret transcript')
    await utimes(join(folder, 'a.jsonl'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    await utimes(join(folder, 'b.jsonl'), new Date('2026-10-03T00:00:00Z'), new Date('2026-10-03T00:00:00Z'))
    const source = createClaudeSource({ projectsDir: () => projects, root: home })
    expect(await source.list({ home, gitRoots: [] })).toEqual([{ path: join(home, 'Dev', 'app'), seenAt: T('2026-10-03T00:00:00Z') }])
  })
})

describe('recent projects: codex source', () => {
  it('reads the cwd from the first line only, current and older formats', async () => {
    const a = join(home, 'a.jsonl'), b = join(home, 'b.jsonl'), c = join(home, 'c.jsonl')
    await writeFile(a, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/Users/demo/Dev/api' } }) + '\n{"not json\n')
    await writeFile(b, JSON.stringify({ cwd: '/Users/demo/Dev/old' }) + '\n')
    await writeFile(c, 'garbage\n' + JSON.stringify({ cwd: '/second/line' }) + '\n')
    expect(await sessionCwd(a)).toBe('/Users/demo/Dev/api')
    expect(await sessionCwd(b)).toBe('/Users/demo/Dev/old')
    expect(await sessionCwd(c)).toBeNull()
  })

  it('walks the dated session folders newest first', async () => {
    const sessions = join(home, 'sessions')
    await mkdir(join(sessions, '2026', '10', '19'), { recursive: true })
    await mkdir(join(sessions, '2026', '10', '20'), { recursive: true })
    await writeFile(join(sessions, '2026', '10', '19', 'rollout-1.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: '/p/old' } }) + '\n')
    await writeFile(join(sessions, '2026', '10', '20', 'rollout-2.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: '/p/new' } }) + '\n')
    const entries = await createCodexSource({ sessionsDir: () => sessions }).list({ home, gitRoots: [] })
    expect(entries.map((e) => e.path)).toEqual(['/p/new', '/p/old'])
  })
})

describe('recent projects: editors', () => {
  it('keeps the local folders of VS Code’s recent list, in order', () => {
    const json = JSON.stringify({ entries: [
      { folderUri: 'file:///Users/demo/Dev/my%20app' },
      { fileUri: 'file:///Users/demo/notes.md' },
      { folderUri: 'vscode-remote://ssh-remote%2Bhost/home/demo/app' },
      { workspace: { configPath: 'file:///Users/demo/x.code-workspace' } },
      { folderUri: 'file:///Volumes/Dev/api' },
    ] })
    expect(parseRecentlyOpened(json)).toEqual(['/Users/demo/Dev/my app', '/Volumes/Dev/api'])
    expect(parseRecentlyOpened('not json')).toEqual([])
  })

  it('reads one key through sqlite3, read-only, and dates folders from workspaceStorage', async () => {
    const user = join(home, 'Library', 'Application Support', 'Code', 'User')
    await mkdir(join(user, 'globalStorage'), { recursive: true })
    await writeFile(join(user, 'globalStorage', 'state.vscdb'), '')
    await mkdir(join(user, 'workspaceStorage', 'abc'), { recursive: true })
    await writeFile(join(user, 'workspaceStorage', 'abc', 'workspace.json'), JSON.stringify({ folder: 'file:///Users/demo/Dev/b' }))
    const exec = vi.fn(async (_file: string, _args: string[]) => JSON.stringify({ entries: [{ folderUri: 'file:///Users/demo/Dev/a' }, { folderUri: 'file:///Users/demo/Dev/b' }] }) + '\n')
    const source = createVscodeSource('vscode', { fr: 'VS Code', en: 'VS Code' }, 'Code', exec)
    expect(await source.available({ home, gitRoots: [] })).toBe(true)
    const entries = await source.list({ home, gitRoots: [] })
    expect(exec.mock.calls[0][0]).toBe('/usr/bin/sqlite3')
    expect(exec.mock.calls[0][1]).toContain('-readonly')
    expect(entries.map((e) => e.path)).toEqual(['/Users/demo/Dev/a', '/Users/demo/Dev/b'])
    expect(entries.every((e) => typeof e.seenAt === 'number')).toBe(true)
  })

  it('parses JetBrains recent projects, Rider solutions and $USER_HOME$', () => {
    const xml = `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
      <entry key="$USER_HOME$/Dev/api"><value><RecentProjectMetaInfo frameTitle="api – Main.kt">
        <option name="activationTimestamp" value="1760000000000" /></RecentProjectMetaInfo></value></entry>
      <entry key="/Volumes/Dev/Shop/Shop.sln"><value><RecentProjectMetaInfo>
        <option name="projectOpenTimestamp" value="1750000000000" /></RecentProjectMetaInfo></value></entry>
      <entry key="/Users/demo/R&amp;D"><value><RecentProjectMetaInfo /></value></entry>
    </map></option></component></application>`
    expect(parseRecentProjects(xml, '/Users/demo')).toEqual([
      { path: '/Users/demo/Dev/api', seenAt: 1760000000000 },
      { path: '/Volumes/Dev/Shop', seenAt: 1750000000000 },
      { path: '/Users/demo/R&D', seenAt: null },
    ])
  })
})

describe('recent projects: command-line sources', () => {
  it('parses zoxide, tmux and Herdr output', () => {
    expect(parseZoxide('  24.0 /Users/demo/Dev/api\n   3.5 /Users/demo/Dev/web\nnoise\n')).toEqual([
      { path: '/Users/demo/Dev/api', seenAt: null }, { path: '/Users/demo/Dev/web', seenAt: null },
    ])
    expect(parseTmux('/Users/demo/Dev/api\t1760000000\n/Users/demo/x\t\n')).toEqual([
      { path: '/Users/demo/Dev/api', seenAt: 1760000000000 }, { path: '/Users/demo/x', seenAt: null },
    ])
    const herdr = JSON.stringify({ id: 'r', result: { panes: [
      { pane_id: 'p1', cwd: '/Users/demo', foreground_cwd: '/Users/demo/Dev/api', scroll: 'ignored' },
      { pane_id: 'p2', cwd: '/Users/demo/Dev/web', foreground_cwd: '' },
      { pane_id: 'p3', cwd: 'relative' },
    ] } })
    expect(parseHerdrPanes(herdr, 5)).toEqual([
      { path: '/Users/demo/Dev/api', seenAt: 5 }, { path: '/Users/demo/Dev/web', seenAt: 5 },
    ])
    expect(parseHerdrPanes('nope', 5)).toEqual([])
  })

  it('runs each tool by absolute path with an argument list, and is unavailable when missing', async () => {
    const exec = vi.fn(async () => '')
    const [zoxide, tmux, herdr] = createCliSources(exec, async (name) => (name === 'tmux' ? null : `/opt/homebrew/bin/${name}`))
    expect(await tmux.available({ home, gitRoots: [] })).toBe(false)
    await zoxide.list({ home, gitRoots: [] })
    await herdr.list({ home, gitRoots: [] })
    expect(exec.mock.calls).toEqual([
      ['/opt/homebrew/bin/zoxide', ['query', '--list', '--score']],
      ['/opt/homebrew/bin/herdr', ['pane', 'list']],
    ])
  })

  it('treats tmux with no server running as an empty list', async () => {
    const exec = vi.fn(async () => { throw new Error('no server running on /private/tmp/tmux-501/default') })
    const [, tmux] = createCliSources(exec, async () => '/opt/homebrew/bin/tmux')
    expect(await tmux.list({ home, gitRoots: [] })).toEqual([])
  })
})

describe('recent projects: settings and merge', () => {
  it('reads git alone by default, every other source only when ticked', () => {
    expect([...tileWants({}).sources]).toEqual(['git'])
    expect([...tileWants({ source_git: false, source_claude: true }).sources]).toEqual(['claude'])
    expect(tileWants({ gitRoots: [{ path: ' ~/Dev ' }, { path: '' }, 'x', 3] }).gitRoots).toEqual(['~/Dev', 'x'])
    const merged = mergedWants([
      { widgetId: 'recent-projects', settings: { source_herdr: true, gitRoots: [{ path: '~/A' }] } },
      { widgetId: 'recent-projects', settings: { source_git: false, gitRoots: [{ path: '~/A' }, { path: '~/B' }] } },
    ])
    expect([...merged.sources].sort()).toEqual(['git', 'herdr'])
    expect(merged.gitRoots).toEqual(['~/A', '~/B'])
  })

  it('dedupes by canonical path, keeping the newest date and every source, newest first', async () => {
    await mkdir(join(home, 'Dev', 'api'), { recursive: true })
    await mkdir(join(home, 'Dev', 'web'), { recursive: true })
    await mkdir(join(home, 'Dev', 'old'), { recursive: true })
    await symlink(join(home, 'Dev', 'api'), join(home, 'api-link'))
    const rows = await mergeEntries([
      { path: join(home, 'Dev', 'api'), seenAt: 10, source: 'git', gitRoot: '~/Dev' },
      { path: join(home, 'api-link'), seenAt: 30, source: 'claude' },
      { path: join(home, 'Dev', 'web'), seenAt: 20, source: 'vscode' },
      { path: join(home, 'Dev', 'old'), seenAt: null, source: 'zoxide' },
      { path: '/private/tmp', seenAt: 99, source: 'tmux' },
      { path: join(home, 'gone'), seenAt: 99, source: 'herdr' },
    ], home)
    expect(rows).toEqual([
      { path: join(home, 'Dev', 'api'), name: 'api', parent: '~/Dev', seenAt: 30, sources: ['git', 'claude'], gitRoots: ['~/Dev'] },
      { path: join(home, 'Dev', 'web'), name: 'web', parent: '~/Dev', seenAt: 20, sources: ['vscode'] },
      { path: join(home, 'Dev', 'old'), name: 'old', parent: '~/Dev', seenAt: null, sources: ['zoxide'] },
    ])
  })

  it('caps the list', async () => {
    const entries = []
    for (let i = 0; i < MAX_PROJECTS + 5; i++) {
      await mkdir(join(home, `p${i}`))
      entries.push({ path: join(home, `p${i}`), seenAt: i, source: 'git' as const })
    }
    const rows = await mergeEntries(entries, home)
    expect(rows).toHaveLength(MAX_PROJECTS)
    expect(rows[0].name).toBe(`p${MAX_PROJECTS + 4}`)
  })
})

function fakeSource(id: Source['id'], list: Source['list'], live = false): Source {
  return { id, label: { fr: id, en: id }, live, available: async () => true, list }
}

describe('recent projects: provider', () => {
  async function setup(sources: Source[], settings: Record<string, unknown>) {
    const exec = vi.fn(async () => '')
    const provider = createRecentProjectsProvider({
      instances: () => [{ widgetId: 'recent-projects', settings }],
      home, sources, exec,
      resolveBinary: async (name) => (name === 'herdr' ? '/Users/demo/.local/bin/herdr' : null),
      appExists: async (p) => p === '/Applications/Visual Studio Code.app' || p.endsWith('Finder.app'),
    })
    return { provider, exec }
  }

  it('never reads a source no tile ticked', async () => {
    await mkdir(join(home, 'a'))
    const claude = vi.fn(async () => [{ path: join(home, 'a'), seenAt: 1 }])
    const { provider } = await setup([fakeSource('claude', claude)], {})
    const snap = await provider.poll!() as RecentProjectsSnapshot
    expect(claude).not.toHaveBeenCalled()
    expect(snap.projects).toEqual([])
    expect(snap.sources).toEqual([{ id: 'claude', enabled: false, available: false, count: 0 }])
  })

  it('keeps a failing source’s last good answer and reports its error', async () => {
    await mkdir(join(home, 'a'))
    let fail = false
    const list = vi.fn(async () => {
      if (fail) throw new Error('boom /Users/demo/secret')
      return [{ path: join(home, 'a'), seenAt: 1 }]
    })
    const { provider } = await setup([fakeSource('claude', list)], { source_claude: true })
    await provider.poll!()
    fail = true
    const snap = await provider.poll!() as RecentProjectsSnapshot
    expect(snap.projects.map((p) => p.name)).toEqual(['a'])
    expect(snap.sources[0]).toEqual({ id: 'claude', enabled: true, available: true, count: 1, error: 'unreadable' })
  })

  it('remembers what a live source showed after it stops showing it', async () => {
    await mkdir(join(home, 'a'))
    await mkdir(join(home, 'b'))
    let panes = [join(home, 'a')]
    const { provider } = await setup([fakeSource('herdr', async () => panes.map((path) => ({ path, seenAt: 1 })), true)], { source_herdr: true })
    await provider.poll!()
    panes = [join(home, 'b')]
    const snap = await provider.poll!() as RecentProjectsSnapshot
    expect(snap.projects.map((p) => p.name).sort()).toEqual(['a', 'b'])
  })

  it('lists the installed applications', async () => {
    const { provider } = await setup([], {})
    expect((await provider.poll!() as RecentProjectsSnapshot).apps).toEqual(['finder', 'vscode', 'herdr'])
  })

  describe('open', () => {
    async function ready() {
      await mkdir(join(home, 'Dev', 'api'), { recursive: true })
      const s = await setup([fakeSource('git', async () => [{ path: join(home, 'Dev', 'api'), seenAt: 1 }])], {})
      await s.provider.poll!()
      return { ...s, path: join(home, 'Dev', 'api'), open: s.provider.commands!.open }
    }

    it('opens a listed folder with /usr/bin/open -a and the bundle path, or Herdr by argv', async () => {
      const { exec, path, open } = await ready()
      expect(await open({ path, app: 'vscode' }, LOCAL)).toEqual({ ok: true })
      expect(await open({ path, app: 'herdr' }, LOCAL)).toEqual({ ok: true, herdr: 'new-pane', front: null })
      expect(exec.mock.calls).toEqual([
        ['/usr/bin/open', ['-a', '/Applications/Visual Studio Code.app', path]],
        ['/Users/demo/.local/bin/herdr', ['pane', 'list']],
        ['/Users/demo/.local/bin/herdr', ['pane', 'split', '--cwd', path, '--direction', 'right', '--no-focus']],
        ['/bin/ps', ['-axo', 'pid=,ppid=,comm=']],
      ])
    })

    it('refuses a remote or paired caller, an unlisted path, an unknown app, a missing app', async () => {
      const { exec, path, open } = await ready()
      expect(await open({ path, app: 'finder' })).toMatchObject({ ok: false, error: 'local-only' })
      expect(await open({ path, app: 'finder' }, { loopback: false, paired: false })).toMatchObject({ ok: false, error: 'local-only' })
      expect(await open({ path, app: 'finder' }, { loopback: false, paired: true, deviceId: 'd' })).toMatchObject({ ok: false, error: 'local-only' })
      expect(await open({ path: '/Applications/Calculator.app', app: 'finder' }, LOCAL)).toMatchObject({ ok: false, error: 'unknown-project' })
      expect(await open({ path: join(home, 'Dev'), app: 'finder' }, LOCAL)).toMatchObject({ ok: false, error: 'unknown-project' })
      expect(await open({ path, app: 'sh' }, LOCAL)).toMatchObject({ ok: false, error: 'invalid-request' })
      expect(await open({ path, app: 'herdr', terminal: 'Calculator' }, LOCAL)).toMatchObject({ ok: false, error: 'invalid-request' })
      expect(await open({ path, app: 'finder', command: 'rm -rf ~' }, LOCAL)).toEqual({ ok: true })
      expect(await open({ path, app: 'cursor' }, LOCAL)).toMatchObject({ ok: false, error: 'not-installed' })
      expect(await open({ path, app: 'tmux' }, LOCAL)).toMatchObject({ ok: false, error: 'not-installed' })
      expect(exec.mock.calls).toEqual([['/usr/bin/open', ['-a', '/System/Library/CoreServices/Finder.app', path]]])
    })

    it('refuses a listed folder that has since been removed', async () => {
      const { path, open } = await ready()
      await rm(path, { recursive: true })
      expect(await open({ path, app: 'finder' }, LOCAL)).toMatchObject({ ok: false, error: 'unknown-project' })
    })
  })

  it('opens tmux in a new window at the folder', async () => {
    const exec = vi.fn(async () => '')
    await openWith('tmux', '/Users/demo/Dev/api', { exec, resolveBinary: async () => '/opt/homebrew/bin/tmux' })
    expect(exec).toHaveBeenCalledWith('/opt/homebrew/bin/tmux', ['new-window', '-c', '/Users/demo/Dev/api'])
  })
})

/**
 * A Herdr with two workspaces: w1 holds one pane, w2 one tab of three panes side by side
 * (p1 | p3 | p2), focused on p1. It answers `pane list`, `pane layout`, `pane neighbor` and
 * moves its focus on `pane focus`, as Herdr 0.9.5 does; `stuck` makes focus moves do nothing.
 */
function fakeHerdr(opts: { zoomed?: boolean; stuck?: boolean; ps?: string; agentError?: string; agents?: string[] } = {}) {
  const BIN = '/Users/demo/.local/bin/herdr'
  const panes = [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/Users/demo', foreground_cwd: '/Users/demo' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/Users/demo/Dev/web' },
    { pane_id: 'w2:p3', tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/Users/demo/Dev/web' },
    { pane_id: 'w2:p2', tab_id: 'w2:t1', workspace_id: 'w2', cwd: '/Users/demo', foreground_cwd: '/Users/demo/Dev/api' },
  ]
  const row = ['w2:p1', 'w2:p3', 'w2:p2']
  let focused = 'w2:p1'
  const neighbor = (from: string, direction: string) => {
    const i = row.indexOf(from)
    if (direction === 'right') return row[i + 1]
    if (direction === 'left') return i > 0 ? row[i - 1] : undefined
    return undefined
  }
  const layout = () => ({ focused_pane_id: focused, zoomed: !!opts.zoomed, panes: row.map((pane_id) => ({ pane_id })), tab_id: 'w2:t1' })
  const exec = vi.fn(async (file: string, args: string[], _opts?: { timeoutMs?: number }) => {
    if (file === '/bin/ps') return opts.ps ?? ''
    if (file !== BIN) return ''
    const [group, verb] = args
    const flag = (name: string) => args[args.indexOf(name) + 1]
    if (group === 'pane' && verb === 'list') return JSON.stringify({ id: 'cli:pane:list', result: { panes } })
    if (group === 'pane' && verb === 'layout') return JSON.stringify({ result: { layout: layout() } })
    if (group === 'pane' && verb === 'neighbor') {
      const id = neighbor(flag('--pane'), flag('--direction'))
      return JSON.stringify({ result: { neighbor: { layout: layout(), pane_id: flag('--pane'), ...(id ? { neighbor_pane_id: id } : {}) } } })
    }
    if (group === 'pane' && verb === 'split') return JSON.stringify({ id: 'cli:pane:split', result: { pane: { pane_id: 'w2:p9', tab_id: 'w2:t1' } } })
    if (group === 'agent' && verb === 'start' && opts.agentError) throw new Error(opts.agentError)
    if (group === 'pane' && verb === 'focus') {
      if (!opts.stuck) focused = neighbor(flag('--pane'), flag('--direction')) ?? focused
      return '{}'
    }
    return '{}'
  })
  const deps = {
    exec,
    resolveBinary: async (name: string) =>
      name === 'herdr' ? BIN : (opts.agents ?? ['claude']).includes(name) ? `/Users/demo/.local/bin/${name}` : null,
    exists: async (p: string) => p === '/Applications/iTerm.app' || p === '/Applications/Ghostty.app',
  }
  const calls = () => exec.mock.calls.map(([f, a]) => (f === BIN ? 'herdr ' : f + ' ') + a.join(' '))
  return { exec, deps, calls }
}

/** `ps -axo pid=,ppid=,comm=` with Herdr's client in a shell under iTerm, and its server below it. */
const PS_ITERM = [
  '    1     0 /sbin/launchd',
  '  300     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '  310   300 /Users/demo/Library/Application Support/iTerm2/iTermServer-3.7.6',
  '  320   310 /usr/bin/login',
  '  330   320 -zsh',
  '  340   330 herdr',
  '  350   340 /Users/demo/.local/bin/herdr',
].join('\n')

describe('recent projects: Herdr', () => {
  it('goes to the pane already in the folder: its workspace, its tab, then the walk to it', async () => {
    const h = fakeHerdr()
    expect(await openWith('herdr', '/Users/demo/Dev/api', h.deps, { terminal: 'iterm' })).toEqual({ ok: true, herdr: 'pane', front: 'iterm' })
    const calls = h.calls()
    expect(calls.slice(0, 3)).toEqual(['herdr pane list', 'herdr workspace focus w2', 'herdr tab focus w2:t1'])
    expect(calls.filter((c) => c.startsWith('herdr pane focus'))).toEqual([
      'herdr pane focus --direction right --pane w2:p1',
      'herdr pane focus --direction right --pane w2:p3',
    ])
    expect(calls.at(-1)).toBe('/usr/bin/open -a /Applications/iTerm.app')
    expect(calls.some((c) => c.includes('split'))).toBe(false)
  })

  it('matches a pane by its shell’s folder too, and stays put when that pane is already focused', async () => {
    const h = fakeHerdr()
    expect(await openWith('herdr', '/Users/demo/Dev/web', h.deps, { terminal: 'ghostty' })).toEqual({ ok: true, herdr: 'pane', front: 'ghostty' })
    expect(h.calls().some((c) => c.startsWith('herdr pane focus') || c.startsWith('herdr pane neighbor'))).toBe(false)
  })

  it('stops at the tab and says so when the focus does not reach the pane, or the tab is zoomed', async () => {
    const stuck = fakeHerdr({ stuck: true })
    expect(await openWith('herdr', '/Users/demo/Dev/api', stuck.deps, { terminal: 'iterm' })).toMatchObject({ ok: true, herdr: 'tab' })
    const zoomed = fakeHerdr({ zoomed: true })
    expect(await openWith('herdr', '/Users/demo/Dev/api', zoomed.deps, { terminal: 'iterm' })).toMatchObject({ ok: true, herdr: 'tab' })
    expect(zoomed.calls().some((c) => c.startsWith('herdr pane neighbor') || c.startsWith('herdr pane focus'))).toBe(false)
  })

  it('splits a new pane when no pane is in the folder, and finds the terminal Herdr runs in', async () => {
    const h = fakeHerdr({ ps: PS_ITERM })
    expect(await openWith('herdr', '/Users/demo/Dev/new', h.deps)).toEqual({ ok: true, herdr: 'new-pane', front: 'iterm' })
    expect(h.calls()).toEqual([
      'herdr pane list',
      'herdr pane split --cwd /Users/demo/Dev/new --direction right --no-focus',
      '/bin/ps -axo pid=,ppid=,comm=',
      '/usr/bin/open -a /Applications/iTerm.app',
    ])
  })

  it('brings nothing forward when the terminal is not installed or cannot be told', async () => {
    expect(await openWith('herdr', '/Users/demo/Dev/new', fakeHerdr().deps, { terminal: 'terminal' })).toMatchObject({ front: null })
    expect(await openWith('herdr', '/Users/demo/Dev/new', fakeHerdr().deps)).toMatchObject({ ok: true, front: null })
  })

  it('detects one terminal only: none or two is no answer', async () => {
    const ps = async (out: string) => detectHerdrTerminal(async () => out)
    expect(await ps(PS_ITERM)).toBe('iterm')
    expect(await ps(PS_ITERM + '\n  400     1 /Applications/Ghostty.app/Contents/MacOS/ghostty\n  410   400 herdr')).toBeNull()
    expect(await ps('  340     1 herdr')).toBeNull()
    expect(await ps('  300     1 /Applications/iTerm.app/Contents/MacOS/iTerm2')).toBeNull()
  })
})

describe('recent projects: an agent in a new pane', () => {
  it('splits a new focused pane on the folder, then starts the agent there with Herdr’s agent start', async () => {
    const h = fakeHerdr()
    expect(await openWith('herdr-claude', '/Users/demo/Dev/api', h.deps, { terminal: 'iterm' }))
      .toEqual({ ok: true, herdr: 'new-pane', agent: 'started', front: 'iterm' })
    const calls = h.calls()
    expect(calls[0]).toBe('herdr pane split --cwd /Users/demo/Dev/api --direction right --focus')
    expect(calls[1]).toMatch(/^herdr agent start fremkit-claude-[a-z0-9]+ --kind claude --pane w2:p9 --timeout 30000$/)
    expect(calls.at(-1)).toBe('/usr/bin/open -a /Applications/iTerm.app')
    // Never the pane already in the folder, and the folder on no command line but as --cwd.
    expect(calls.some((c) => c.includes('pane list') || c.includes('focus w2'))).toBe(false)
    expect(calls.filter((c) => c.includes('/Users/demo/Dev/api'))).toHaveLength(1)
    // The agent's start may take Herdr's 30 s: the call around it waits longer than the default.
    expect(h.exec.mock.calls[1][2]).toEqual({ timeoutMs: 35_000 })
    expect(calls[1].split(' ')[3]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('counts an agent waiting at a startup question as started, and anything else as a failure', async () => {
    const waiting = fakeHerdr({ agentError: 'agent_not_ready: blocked at startup' })
    expect(await openWith('herdr-claude', '/Users/demo/Dev/api', waiting.deps)).toMatchObject({ ok: true, agent: 'waiting' })
    await expect(openWith('herdr-claude', '/Users/demo/Dev/api', fakeHerdr({ agentError: 'unknown kind' }).deps)).rejects.toThrow()
  })

  it('offers no agent whose binary is missing, and refuses it', async () => {
    const h = fakeHerdr({ agents: ['claude'] })
    const apps = await installedApps(h.deps)
    expect(apps).toContain('herdr-claude')
    expect(apps).not.toContain('herdr-codex')
    expect(apps).not.toContain('tmux-claude')
    expect(await openWith('herdr-codex', '/Users/demo/Dev/api', h.deps)).toEqual({ ok: false, error: 'not-installed' })
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('starts the agent by its absolute path in a new tmux window, and only a path a shell reads as is', async () => {
    const exec = vi.fn(async () => '')
    const bins: Record<string, string> = { tmux: '/opt/homebrew/bin/tmux', codex: '/opt/homebrew/bin/codex', claude: '/Users/my demo/.local/bin/claude' }
    const deps = { exec, resolveBinary: async (n: string) => bins[n] ?? null }
    expect(await openWith('tmux-codex', '/Users/demo/Dev/api', deps)).toEqual({ ok: true })
    expect(exec.mock.calls).toEqual([['/opt/homebrew/bin/tmux', ['new-window', '-c', '/Users/demo/Dev/api', '/opt/homebrew/bin/codex']]])
    expect(await installedApps(deps)).toEqual(expect.arrayContaining(['tmux-codex']))
    expect(await installedApps(deps)).not.toContain('tmux-claude')
    expect(await openWith('tmux-claude', '/Users/demo/Dev/api', deps)).toEqual({ ok: false, error: 'not-installed' })
  })

  it('looks for Claude Code in its own installer’s folder too', () => {
    expect(binaryCandidates('claude', '/Users/demo')).toContain('/Users/demo/.claude/local/claude')
    expect(binaryCandidates('codex', '/Users/demo')).not.toContain('/Users/demo/.claude/local/codex')
  })

  it('refuses an agent launch on a folder the snapshot does not list, and remembers one it opens', async () => {
    await mkdir(join(home, 'Dev', 'api'), { recursive: true })
    const file = join(home, 'recent-projects.json')
    const h = fakeHerdr()
    const provider = createRecentProjectsProvider({
      instances: () => [{ widgetId: 'recent-projects', settings: {} }],
      home, sources: [fakeSource('git', async () => [{ path: join(home, 'Dev', 'api'), seenAt: 1 }])],
      exec: h.exec, resolveBinary: h.deps.resolveBinary as never, appExists: async () => false, memoryFile: file,
    })
    await provider.poll!()
    const open = provider.commands!.open
    expect(await open({ path: join(home, 'Dev'), app: 'herdr-claude' }, LOCAL)).toMatchObject({ ok: false, error: 'unknown-project' })
    expect(await open({ path: '/Users/demo/elsewhere', app: 'herdr-claude' }, LOCAL)).toMatchObject({ ok: false, error: 'unknown-project' })
    expect(await open({ path: join(home, 'Dev', 'api'), app: 'herdr-claude' }, { loopback: false, paired: true, deviceId: 'd' })).toMatchObject({ ok: false, error: 'local-only' })
    expect(h.exec).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['split']), expect.anything())
    expect(h.calls().filter((c) => c.startsWith('herdr'))).toEqual([])

    expect(await open({ path: join(home, 'Dev', 'api'), app: 'herdr-claude' }, LOCAL)).toMatchObject({ ok: true, agent: 'started' })
    expect([...(await loadMemory(file)).get('herdr')!.keys()]).toEqual([join(home, 'Dev', 'api')])
  })
})

describe('recent projects: live sources remembered on disk', () => {
  function provider(file: string, list: Source['list']) {
    return createRecentProjectsProvider({
      instances: () => [{ widgetId: 'recent-projects', settings: { source_git: false, source_herdr: true } }],
      home, sources: [fakeSource('herdr', list, true)], exec: vi.fn(async () => ''),
      resolveBinary: async () => null, appExists: async () => false, memoryFile: file,
    })
  }
  const names = (snap: unknown) => (snap as RecentProjectsSnapshot).projects.map((p) => p.name).sort()

  it('keeps what Herdr showed across a restart, in an owner-only file of paths and dates', async () => {
    await mkdir(join(home, 'a'))
    await mkdir(join(home, 'b'))
    const file = join(home, 'recent-projects.json')
    await provider(file, async () => [{ path: join(home, 'a'), seenAt: 1000 }]).poll!()
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, sources: { herdr: [{ path: join(home, 'a'), seenAt: 1000 }] } })
    expect((await readdir(home)).filter((n) => n.endsWith('.tmp'))).toEqual([])

    // A new server: the pane in `a` is closed, one is open in `b`.
    const again = provider(file, async () => [{ path: join(home, 'b'), seenAt: 2000 }])
    expect(names(await again.poll!())).toEqual(['a', 'b'])
  })

  it('shows the remembered folders while the live source fails right after a restart', async () => {
    await mkdir(join(home, 'a'))
    const file = join(home, 'recent-projects.json')
    await provider(file, async () => [{ path: join(home, 'a'), seenAt: 1000 }]).poll!()
    const broken = provider(file, async () => { throw new Error('socket') })
    expect(names(await broken.poll!())).toEqual(['a'])
  })

  it('starts empty on a corrupt file, never crashes, and writes a good one over it', async () => {
    await mkdir(join(home, 'a'))
    const file = join(home, 'recent-projects.json')
    for (const junk of ['{not json', '[]', JSON.stringify({ version: 2, sources: {} }), JSON.stringify({ version: 1, sources: 'x' })]) {
      await writeFile(file, junk)
      expect((await loadMemory(file)).size).toBe(0)
    }
    await writeFile(file, '{not json')
    expect(names(await provider(file, async () => [{ path: join(home, 'a'), seenAt: 5 }]).poll!())).toEqual(['a'])
    expect((await loadMemory(file)).get('herdr')?.get(join(home, 'a'))).toBe(5)
  })

  it('drops bad entries and sources that are not live, and keeps the newest 50 per source', async () => {
    const file = join(home, 'recent-projects.json')
    const many = Array.from({ length: LIVE_MEMORY + 10 }, (_, i) => ({ path: `/Users/demo/p${i}`, seenAt: i }))
    await writeFile(file, JSON.stringify({ version: 1, sources: {
      herdr: [...many, { path: 'relative', seenAt: 1 }, { path: '/Users/demo/x', seenAt: 'yesterday' }, 42],
      tmux: [{ path: '/Users/demo/t', seenAt: null }],
      claude: [{ path: '/Users/demo/c', seenAt: 1 }],
    } }))
    const memory = await loadMemory(file)
    expect([...memory.keys()].sort()).toEqual(['herdr', 'tmux'])
    const herdr = [...memory.get('herdr')!.keys()]
    expect(herdr).toHaveLength(LIVE_MEMORY)
    expect(herdr[0]).toBe('/Users/demo/p10')
    expect(herdr.at(-1)).toBe(`/Users/demo/p${LIVE_MEMORY + 9}`)
  })
})

describe('recent projects: reach', () => {
  it('is reserved to built-in widgets and never reaches a paired device', () => {
    expect(BUILTIN_ONLY_CHANNELS.has('recent-projects')).toBe(true)
    expect(LOCAL_ONLY_CHANNELS.has('recent-projects')).toBe(true)
  })
})
