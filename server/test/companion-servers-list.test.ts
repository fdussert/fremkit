import { describe, expect, it } from 'vitest'
import {
  detectTool, displayCommand, isDevRuntime, maskSecrets, isDockerHolder, isSystemProcess, launchRoot, parseLsofCwd, parseLsofListen, parsePs, selfTree,
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
  const stats = [
    '  501     1   501   501 Wed Oct 22 09:01:02 2026       05:12   0.0  1024 /opt/homebrew/Cellar/node/22.1.0/bin/node',
    '  502   501   502   501 Wed Oct 22 09:01:03 2026    01:02:03  12.5 20480 /opt/homebrew/bin/pnpm',
    '  503   501   503   501 Thu Oct  2 10:00:00 2026  3-04:05:06   0.1   512 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper',
  ].join('\n')
  const argsOut = [
    '  501 node /x/node_modules/.bin/vite --port 18173',
    '  502 pnpm dev',
    '  503 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility',
  ].join('\n')
  it('merges stats and args by pid, with etime forms', () => {
    const m = parsePs(stats, argsOut)
    expect(m.get(501)).toMatchObject({ ppid: 1, pgid: 501, uid: 501, start: 'Wed Oct 22 09:01:02 2026', etimeSec: 312, cpu: 0, rssKb: 1024, comm: '/opt/homebrew/Cellar/node/22.1.0/bin/node', args: 'node /x/node_modules/.bin/vite --port 18173' })
    expect(m.get(502)?.etimeSec).toBe(3723)
    expect(m.get(502)?.cpu).toBe(12.5)
    expect(m.get(503)?.etimeSec).toBe(3 * 86400 + 4 * 3600 + 5 * 60 + 6)
    expect(m.get(503)?.start).toBe('Thu Oct 2 10:00:00 2026')
  })
  it('keeps a full comm path with spaces', () => {
    const p = parsePs(stats, argsOut).get(503)!
    expect(p.comm).toBe('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper')
    expect(p.args.endsWith('--type=utility')).toBe(true)
  })
  it('falls back to comm when a pid has no args line', () => {
    expect(parsePs(stats, '').get(502)?.args).toBe('/opt/homebrew/bin/pnpm')
  })
  it('skips lines it cannot read', () => {
    expect(parsePs('garbage\n', 'x').size).toBe(0)
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
    expect(detectTool('node app.js --name vite', '/usr/local/bin/node')).toBe('node')
    expect(detectTool('python3 -m uvicorn app:app', '/usr/bin/python3')).toBe('uvicorn')
    expect(detectTool('-m flask', '/usr/bin/python3')).toBe('Flask')
    expect(detectTool('foo -m flask', '/opt/bin/foo')).toBe('foo')
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
  it('accepts a binary in the folder or a build output under it', () => {
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/api/target/debug/api'), '/Users/someone/code/api')).toBe(true)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/api/target/release/api'), '/Users/someone/code/api')).toBe(true)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/api/server'), '/Users/someone/code/api')).toBe(true)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/api/dist/server'), '/Users/someone/code/api')).toBe(true)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/api/vendor/tool/server'), '/Users/someone/code/api')).toBe(false)
  })
  it('rejects an app helper or a plugin run from its own bundle', () => {
    const plugin = '/Users/someone/Library/Application Support/com.elgato.StreamDeck/Plugins/x.sdPlugin'
    expect(isDevRuntime(proc(1, 0, `${plugin}/bin/plugin`), plugin)).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/Library/Audio/Plug-Ins/x/bin/srv'), '/Library/Audio/Plug-Ins/x')).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/Applications/Tool.app/Contents/MacOS/helper'), '/Applications/Tool.app/Contents/MacOS')).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/opt/homebrew/opt/x/bin/x'), '/opt/homebrew/opt/x')).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/usr/local/x/bin/x'), '/usr/local/x')).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/Thing.app/Contents/MacOS/thing'), '/Users/someone/code/Thing.app/Contents/MacOS')).toBe(false)
    expect(isDevRuntime(proc(1, 0, '/Users/someone/code/x.plugin/srv'), '/Users/someone/code/x.plugin')).toBe(false)
  })
})

describe('isSystemProcess and isDockerHolder', () => {
  it('flags macOS programs only', () => {
    expect(isSystemProcess(proc(1, 0, '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/usr/libexec/rapportd'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/System/Applications/Notes.app/Contents/MacOS/Notes'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/Library/Apple/usr/libexec/x'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/bin/zsh'))).toBe(true)
    expect(isSystemProcess(proc(1, 0, '/sbin/launchd'))).toBe(true)
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
  it('survives a parent cycle, a missing parent and a pid that is its own parent', () => {
    const pnpm = (pid: number, ppid: number) => proc(pid, ppid, '/opt/homebrew/bin/pnpm', 'pnpm')
    expect(launchRoot(80, tree(pnpm(80, 81), pnpm(81, 80)))).toBe(81)
    expect(launchRoot(82, tree(proc(82, 999, '/opt/x/x')))).toBe(82)
    expect(launchRoot(83, tree(pnpm(83, 83)))).toBe(83)
  })
  it('does not take an agent for a runner because its arguments name one', () => {
    const t1 = tree(proc(90, 1, '/usr/local/bin/node', 'node /opt/agent/cli.js -p start pnpm dev'), proc(91, 90, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(91, t1)).toBe(91)
    const t2 = tree(proc(92, 1, '/usr/local/bin/node', 'node harness.js --package-manager pnpm'), proc(93, 92, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(93, t2)).toBe(93)
  })
  it('bun is a runner only for run/x or a runner script', () => {
    const t = tree(proc(94, 1, '/opt/homebrew/bin/bun', 'bun agent.ts'), proc(95, 94, '/opt/homebrew/bin/pnpm', 'pnpm dev'), proc(96, 95, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(96, t)).toBe(95)
    const t2 = tree(proc(97, 1, '/bin/zsh', '-zsh'), proc(98, 97, '/opt/homebrew/bin/bun', 'bun run dev'), proc(99, 98, '/opt/homebrew/bin/bun', 'bun vite'))
    expect(launchRoot(99, t2)).toBe(98)
  })
  it('bun run <file> is not a runner, bun run <script> is', () => {
    for (const file of ['agent.ts', './agent.ts']) {
      const t = tree(proc(110, 1, '/opt/homebrew/bin/bun', `bun run ${file}`), proc(111, 110, '/opt/homebrew/bin/pnpm', 'pnpm'), proc(112, 111, '/usr/local/bin/node', 'node vite'))
      expect(launchRoot(112, t)).toBe(111)
    }
    const t = tree(proc(113, 1, '/bin/zsh', '-zsh'), proc(114, 113, '/opt/homebrew/bin/bun', 'bun run dev'), proc(115, 114, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(115, t)).toBe(114)
  })
  it.each([
    ['/usr/local/bin/node', 'node -r turbo agent.js'],
    ['/usr/local/bin/node', 'node --require ./npm.js agent.js'],
    ['/opt/homebrew/bin/bun', 'bun --cwd /Users/someone/code/nx agent.ts'],
    ['/usr/local/bin/node', 'node --env-file ./pnpm agent.js'],
    ['/opt/homebrew/bin/deno', 'deno -r ./agent.ts pnpm dev'],
  ])('an option value is not the script: %s', (comm, args) => {
    const t = tree(proc(120, 1, comm, args), proc(121, 120, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(121, t)).toBe(121)
  })
  it('treats combined shell flags like -c', () => {
    const t = tree(proc(60, 1, '/bin/zsh', '-zsh'), proc(61, 60, '/opt/homebrew/bin/npm', 'npm run dev'), proc(62, 61, '/bin/sh', 'sh -ec vite'), proc(63, 62, '/usr/local/bin/node', 'node vite'))
    expect(launchRoot(63, t)).toBe(61)
  })
})

describe('selfTree', () => {
  it('holds the pid and all descendants', () => {
    const t = tree(proc(1, 0, 'a'), proc(100, 1, 'b'), proc(101, 100, 'c'), proc(102, 101, 'd'), proc(200, 1, 'e'))
    expect([...selfTree(100, t)].sort()).toEqual([100, 101, 102])
  })
})

describe('displayCommand', () => {
  it('shows a non-dev row by program name only', () => {
    expect(displayCommand(proc(1, 0, '/opt/homebrew/bin/cloudflared', 'cloudflared tunnel run --token abc'), false)).toBe('cloudflared')
  })
  it('hides sensitive values on a dev row', () => {
    expect(displayCommand(proc(1, 0, '/usr/local/bin/node', 'node server.js --api-key=abc PORT=3000'), true)).toBe('node server.js --api-key=••• PORT=3000')
    expect(displayCommand(proc(1, 0, '/usr/local/bin/node', 'API_TOKEN=abc vite'), true)).toBe('API_TOKEN=••• vite')
    expect(displayCommand(proc(1, 0, '/usr/local/bin/node', 'node s.js --password abc --port 1'), true)).toBe('node s.js --password ••• --port 1')
  })
  it('masks a value that starts with a dash and credentials in URLs', () => {
    expect(displayCommand(proc(1, 0, '/usr/local/bin/node', 'node s.js --token -abc'), true)).toBe('node s.js --token •••')
    expect(displayCommand(proc(1, 0, '/usr/local/bin/node', 'node s.js --db postgres://bob:pw@db.example.com/x --hook https://tok@example.com/h'), true)).toBe('node s.js --db postgres://bob:•••@db.example.com/x --hook https://•••@example.com/h')
  })
  it('masks the whole userinfo, query secrets and scheme-less credentials', () => {
    const d = (a: string) => displayCommand(proc(1, 0, '/usr/local/bin/node', a), true)
    expect(d('node s.js postgres://bob:p@ss@h/db')).toBe('node s.js postgres://bob:•••@h/db')
    expect(d('node s.js postgres://bob:pa/ss@h/db')).toBe('node s.js postgres://bob:•••@h/db')
    expect(d('node s.js https://h/x?token=abc&page=2')).toBe('node s.js https://h/x?token=•••&page=2')
    expect(d('node s.js bob:pw@host:5432')).toBe('node s.js bob:•••@host:5432')
  })
  it('masks a URL that follows an equals sign', () => {
    const d = (a: string) => displayCommand(proc(1, 0, '/usr/local/bin/node', a), true)
    expect(d('DATABASE_URL=postgres://bob:pw@h/db node s.js')).toBe('DATABASE_URL=postgres://bob:•••@h/db node s.js')
    expect(d('node s.js --db=postgres://bob:pw@h')).toBe('node s.js --db=postgres://bob:•••@h')
    expect(d('node s.js --hook=https://tok@example.com/h')).toBe('node s.js --hook=https://•••@example.com/h')
  })
  it('keeps the host when only the query or fragment holds an @', () => {
    const d = (a: string) => displayCommand(proc(1, 0, '/usr/local/bin/node', a), true)
    expect(d('node s.js https://h/x?email=a@b.com')).toBe('node s.js https://h/x?email=a@b.com')
    expect(d('node s.js https://h/x#a@b.com')).toBe('node s.js https://h/x#a@b.com')
    expect(d('node s.js https://bob:pw@h/x?email=a@b.com&token=t')).toBe('node s.js https://bob:•••@h/x?email=a@b.com&token=•••')
  })
  it('does not over-mask', () => {
    const d = (a: string) => displayCommand(proc(1, 0, '/usr/local/bin/node', a), true)
    expect(d('node s.js --token --port 1')).toBe('node s.js --token --port 1')
    expect(d('node --no-auth server.js')).toBe('node --no-auth server.js')
  })
})

describe('maskSecrets', () => {
  const S = 's3cr3t'
  it('masks a sensitive name followed by a colon: util.inspect, JSON, YAML and dotenv forms', () => {
    for (const [line, out] of [
      [`  SECRET_TOKEN: '${S}',`, `  SECRET_TOKEN: '•••',`],
      [`{ SECRET_TOKEN: "${S}", PORT: '3000' }`, `{ SECRET_TOKEN: "•••", PORT: '3000' }`],
      [`{"SECRET_TOKEN":"${S}","PORT":"3000"}`, `{"SECRET_TOKEN":"•••","PORT":"3000"}`],
      [`API_KEY: ${S}`, 'API_KEY: •••'],
      [`  password: ${S}`, '  password: •••'],
      [`SECRET_TOKEN=${S}`, 'SECRET_TOKEN=•••'],
      [`export API_KEY="${S}"`, 'export API_KEY=•••'],
    ] as const) {
      expect(maskSecrets(line)).toBe(out)
      expect(maskSecrets(line)).not.toContain(S)
    }
  })

  it('leaves ordinary lines, URLs and timestamps alone', () => {
    for (const line of ['  ➜  Local: http://localhost:5173/', '10:42:01 ready in 312 ms', 'PORT: 3000', 'compiled 12 modules']) expect(maskSecrets(line)).toBe(line)
  })
})
