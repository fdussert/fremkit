import { describe, expect, it } from 'vitest'
import {
  detectTool, isDevRuntime, isDockerHolder, isSystemProcess, launchRoot, parseLsofCwd, parseLsofListen, parsePs, selfTree,
  type ProcInfo,
} from '../src/companion/servers/list.js'

function proc(pid: number, ppid: number, comm: string, args = comm, extra: Partial<ProcInfo> = {}): ProcInfo {
  return { pid, ppid, pgid: pid, uid: 501, start: 'Wed Oct 22 09:01:02 2026', etimeSec: 1, cpu: 0, rssKb: 1, comm, args, ...extra }
}
const tree = (...ps: ProcInfo[]) => new Map(ps.map((p) => [p.pid, p]))

describe('parseLsofListen', () => {
  it('merges IPv4/IPv6 and several ports per pid', () => {
    const out = ['p501', 'cnode', 'u501', 'Lsomeone', 'n*:5173', 'n[::1]:5173', 'n127.0.0.1:24678', 'p777', 'cpython3', 'u501', 'Lsomeone', 'n*:8000'].join('\n')
    expect(parseLsofListen(out)).toEqual([
      { pid: 501, ports: [5173, 24678], comm: 'node' },
      { pid: 777, ports: [8000], comm: 'python3' },
    ])
  })
})

describe('parsePs', () => {
  const out = [
    '  501     1   501   501 Wed Oct 22 09:01:02 2026       05:12   0.0  1024 /usr/local/bin/node node /x/node_modules/.bin/vite --port 18173',
    '  502   501   502   501 Wed Oct 22 09:01:03 2026    01:02:03  12.5 20480 /opt/homebrew/bin/pnpm pnpm dev',
    '  503   501   503   501 Thu Oct  2 10:00:00 2026  3-04:05:06   0.1   512 /Applications/Visual Studio Code.app/Contents/MacOS/Electron /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=x',
    '  504   501   504   501 Wed Oct 22 09:01:03 2026       00:09   0.0   512 /usr/local/bin/node node: renamed title',
  ].join('\n')
  it('reads fields, lstart and etime forms', () => {
    const m = parsePs(out)
    expect(m.get(501)).toMatchObject({ ppid: 1, pgid: 501, uid: 501, start: 'Wed Oct 22 09:01:02 2026', etimeSec: 312, cpu: 0, rssKb: 1024, comm: '/usr/local/bin/node', args: 'node /x/node_modules/.bin/vite --port 18173' })
    expect(m.get(502)?.etimeSec).toBe(3723)
    expect(m.get(502)?.cpu).toBe(12.5)
    expect(m.get(503)?.etimeSec).toBe(3 * 86400 + 4 * 3600 + 5 * 60 + 6)
    expect(m.get(503)?.start).toBe('Thu Oct 2 10:00:00 2026')
  })
  it('copes with a comm holding spaces', () => {
    const p = parsePs(out).get(503)!
    expect(p.comm).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Electron')
    expect(p.args).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=x')
  })
  it('takes the first word as comm when argv[0] was rewritten', () => {
    expect(parsePs(out).get(504)).toMatchObject({ comm: '/usr/local/bin/node', args: 'node: renamed title' })
  })
  it('skips lines it cannot read', () => {
    expect(parsePs('garbage\n').size).toBe(0)
  })
})

describe('parseLsofCwd', () => {
  it('maps pid to folder', () => {
    const m = parseLsofCwd(['p501', 'fcwd', 'n/Users/someone/app', 'p502', 'fcwd', 'n/Users/someone/other dir'].join('\n'))
    expect(m.get(501)).toBe('/Users/someone/app')
    expect(m.get(502)).toBe('/Users/someone/other dir')
  })
})

describe('detectTool', () => {
  it('names the tool', () => {
    expect(detectTool('node /x/node_modules/.bin/vite --port 18173', '/usr/local/bin/node')).toBe('Vite')
    expect(detectTool('node /x/node_modules/.bin/next dev', '/usr/local/bin/node')).toBe('Next')
    expect(detectTool('next-server (v15.0.0)', '/usr/local/bin/node')).toBe('Next')
    expect(detectTool('python3 -m http.server 8000', '/usr/bin/python3')).toBe('http.server')
    expect(detectTool('python manage.py runserver', '/usr/bin/python')).toBe('Django')
    expect(detectTool('dotnet run', '/usr/local/share/dotnet/dotnet')).toBe('.NET')
    expect(detectTool('/opt/thing/serve', '/opt/thing/serve')).toBe('serve')
  })
})

describe('isDevRuntime', () => {
  it.each(['node', 'bun', 'deno', 'python3', 'python3.12', 'ruby', 'php', 'java', 'dotnet', 'go'])('%s', (n) => {
    expect(isDevRuntime(proc(1, 0, `/opt/bin/${n}`, n), null)).toBe(true)
  })
  it('rejects a system app', () => {
    const p = proc(1, 0, '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter')
    expect(isDevRuntime(p, '/')).toBe(false)
    expect(isDevRuntime(p, null)).toBe(false)
  })
  it('accepts a binary built under its folder', () => {
    expect(isDevRuntime(proc(1, 0, '/Users/someone/api/bin/server'), '/Users/someone/api')).toBe(true)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/api/bin/server'), '/Users/someone/other')).toBe(false)
  })
})

describe('isSystemProcess and isDockerHolder', () => {
  it('flags macOS programs only', () => {
    expect(isSystemProcess(proc(1, 0, '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/usr/libexec/rapportd'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/System/Applications/Notes.app/Contents/MacOS/Notes'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/Library/Apple/usr/libexec/x'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/usr/local/bin/node'))).toBe(false)
    expect(isSystemProcess(proc(1, 0, '/opt/homebrew/bin/node'))).toBe(false)
  })
  it('spots Docker holders', () => {
    expect(isDockerHolder(proc(1, 0, '/Applications/Docker.app/Contents/MacOS/com.docker.backend'))).toBe(true)
    expect(isDockerHolder(proc(1, 0, '/x/vpnkit-bridge'))).toBe(true)
    expect(isDockerHolder(proc(1, 0, '/usr/local/bin/node'))).toBe(false)
  })
})

describe('launchRoot', () => {
  it('zsh > pnpm > node: the pnpm', () => {
    const t = tree(proc(10, 1, '/bin/zsh', '-zsh'), proc(11, 10, '/opt/homebrew/bin/pnpm', 'pnpm dev'), proc(12, 11, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(12, t)).toBe(11)
  })
  it('tmux > zsh > npm > sh -c > node: the npm', () => {
    const t = tree(
      proc(1, 0, '/sbin/launchd'),
      proc(18, 1, '/opt/homebrew/bin/tmux', 'tmux'),
      proc(19, 18, '/bin/zsh', '-zsh'),
      proc(21, 19, '/usr/local/bin/node', 'node /usr/local/lib/node_modules/npm/bin/npm-cli.js run dev'),
      proc(22, 21, '/bin/sh', 'sh -c vite'),
      proc(23, 22, '/usr/local/bin/node', 'node vite'),
    )
    expect(launchRoot(23, t)).toBe(21)
  })
  it('npm named by its own executable is climbed too', () => {
    const t = tree(proc(19, 1, '/bin/zsh', '-zsh'), proc(21, 19, '/opt/homebrew/bin/npm', 'npm run dev'), proc(22, 21, '/bin/sh', 'sh -c vite'), proc(23, 22, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(23, t)).toBe(21)
  })
  it('Code Helper > node: the node itself', () => {
    const t = tree(proc(30, 1, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper', 'Code Helper --type=x'), proc(31, 30, '/usr/local/bin/node', 'node server.js'))
    expect(launchRoot(31, t)).toBe(31)
  })
  it('launchd > x: x', () => {
    expect(launchRoot(40, tree(proc(1, 0, '/sbin/launchd'), proc(40, 1, '/opt/x/x')))).toBe(40)
  })
  it('an agent node above pnpm is not climbed', () => {
    const t = tree(proc(50, 1, '/usr/local/bin/node', 'node /opt/agent/harness.js'), proc(51, 50, '/opt/homebrew/bin/pnpm', 'pnpm dev'), proc(52, 51, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(52, t)).toBe(51)
  })
  it('an interactive shell above a sh -c is not a runner', () => {
    const t = tree(proc(60, 1, '/bin/zsh', '-zsh'), proc(61, 60, '/bin/sh', 'sh -c ./run.sh'), proc(62, 61, '/opt/x/x'))
    expect(launchRoot(62, t)).toBe(62)
  })
  it('climbs through turbo and concurrently', () => {
    const t = tree(proc(70, 1, '/bin/zsh', '-zsh'), proc(71, 70, '/usr/local/bin/node', 'node /x/node_modules/.bin/turbo run dev'), proc(72, 71, '/usr/local/bin/node', 'node /x/node_modules/.bin/concurrently a b'), proc(73, 72, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(73, t)).toBe(71)
  })
  it('survives a parent cycle', () => {
    const t = tree(proc(80, 81, '/opt/homebrew/bin/pnpm', 'pnpm'), proc(81, 80, '/opt/homebrew/bin/pnpm', 'pnpm'))
    expect(() => launchRoot(80, t)).not.toThrow()
  })
})

describe('selfTree', () => {
  it('holds the pid and all descendants', () => {
    const t = tree(proc(1, 0, 'a'), proc(100, 1, 'b'), proc(101, 100, 'c'), proc(102, 101, 'd'), proc(200, 1, 'e'))
    expect([...selfTree(100, t)].sort()).toEqual([100, 101, 102])
  })
})
