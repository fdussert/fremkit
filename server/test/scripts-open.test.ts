import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
// @ts-expect-error plain JavaScript beside the shell scripts, no declaration file
import { main as openMain, parseArgs, openerCommand, systemRoot } from '../../scripts/open.mjs'
import {
  main as kioskMain,
  edgePath,
  kioskCommand,
  kioskFlags,
  parseScreenOrigin,
  profileDir,
  screenCommand,
  POWERSHELL_SCREEN_SCRIPT,
  findScreen,
  launch,
  runScript,
  SWIFT_SCREEN_SCRIPT,
  // @ts-expect-error plain JavaScript beside the shell scripts, no declaration file
} from '../../scripts/kiosk.mjs'

const LINK = 'http://127.0.0.1:4242/auth?code=abc123&next=%2Fadmin'

describe('open.mjs parseArgs', () => {
  it('defaults to the dashboard on 4242', () => {
    expect(parseArgs([], {})).toEqual({ server: 'http://127.0.0.1:4242', page: 'http://127.0.0.1:4242', print: false, path: '/' })
  })
  it('reads FREMKIT_URL and FREMKIT_PORT', () => {
    expect(parseArgs([], { FREMKIT_PORT: '18160' }).server).toBe('http://127.0.0.1:18160')
    expect(parseArgs([], { FREMKIT_URL: 'http://localhost:9', FREMKIT_PORT: '1' }).server).toBe('http://localhost:9')
  })
  it('takes --dev, --print and a path in any order', () => {
    const a = parseArgs(['--print', '/admin', '--dev'], {})
    expect(a).toMatchObject({ print: true, path: '/admin', page: 'http://localhost:5173', server: 'http://127.0.0.1:4242' })
  })
  it('refuses anything else with the usage line', () => {
    expect(parseArgs(['admin'], {}).error).toBe('usage: pnpm open [--dev] [--print] [/path]')
    expect(parseArgs(['--nope'], {}).error).toBeTruthy()
  })
})

describe('systemRoot and openerCommand', () => {
  it('takes an absolute drive path from the environment', () => {
    expect(systemRoot({ SystemRoot: 'D:\\WINNT' })).toBe('D:\\WINNT')
  })
  it('falls back to C:\\Windows for relative, traversing or odd values', () => {
    for (const v of ['Windows', '..\\x', 'C:\\a\\..\\b', 'C:\\a|b', '', undefined]) {
      expect(systemRoot({ SystemRoot: v })).toBe('C:\\Windows')
    }
  })
  it('opens by absolute path on each platform, URL as one argument', () => {
    expect(openerCommand(LINK, 'darwin', {})).toEqual({ file: '/usr/bin/open', args: [LINK] })
    expect(openerCommand(LINK, 'win32', {})).toEqual({
      file: 'C:\\Windows\\System32\\rundll32.exe',
      args: ['url.dll,FileProtocolHandler', LINK],
    })
  })
})

describe('open.mjs main', () => {
  const io = () => {
    const lines: string[] = []
    const errs: string[] = []
    return { lines, errs, io: { out: (s: string) => lines.push(s), err: (s: string) => errs.push(s) } }
  }
  it('prints the link with --print and opens nothing', async () => {
    const t = io()
    const opener = vi.fn()
    const mint = vi.fn().mockResolvedValue(LINK)
    expect(await openMain(['--print', '/admin'], { env: {}, platform: 'darwin', io: t.io, opener, mint })).toBe(0)
    expect(t.lines).toEqual([LINK])
    expect(opener).not.toHaveBeenCalled()
    expect(mint).toHaveBeenCalledWith('http://127.0.0.1:4242', '/admin', 'http://127.0.0.1:4242')
  })
  it('opens the link through the platform opener', async () => {
    const opener = vi.fn().mockResolvedValue(undefined)
    expect(await openMain([], { env: {}, platform: 'win32', io: io().io, opener, mint: async () => LINK })).toBe(0)
    expect(opener).toHaveBeenCalledWith('C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', LINK])
  })
  it('exits 2 on bad usage and 1 when no link can be minted', async () => {
    const a = io()
    expect(await openMain(['bad'], { env: {}, io: a.io, mint: async () => LINK })).toBe(2)
    expect(a.errs).toEqual(['usage: pnpm open [--dev] [--print] [/path]'])
    const b = io()
    expect(await openMain([], { env: {}, platform: 'darwin', io: b.io, mint: async () => null })).toBe(1)
    expect(b.errs[0]).toContain('could not get a sign-in link from http://127.0.0.1:4242')
    expect(b.errs[1]).toContain('access-4242.token')
  })
  it('exits 1 when the opener fails', async () => {
    const t = io()
    const opener = vi.fn().mockRejectedValue(new Error('x'))
    expect(await openMain([], { env: {}, platform: 'darwin', io: t.io, opener, mint: async () => LINK })).toBe(1)
  })
})

describe('kiosk.mjs Edge and profile', () => {
  const x86 = 'C:\\Program Files (x86)'
  const pf = 'C:\\Program Files'
  it('prefers Program Files (x86), then Program Files', () => {
    const env = { 'ProgramFiles(x86)': x86, ProgramFiles: pf }
    expect(edgePath(env, () => true)).toBe(`${x86}\\Microsoft\\Edge\\Application\\msedge.exe`)
    expect(edgePath(env, (p: string) => p.startsWith(pf + '\\'))).toBe(`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`)
  })
  it('ignores relative or traversing directories, and returns null when Edge is missing', () => {
    expect(edgePath({ 'ProgramFiles(x86)': '..\\evil', ProgramFiles: 'C:\\a\\..\\b' }, () => true)).toBeNull()
    expect(edgePath({ ProgramFiles: pf }, () => false)).toBeNull()
    expect(edgePath({}, () => true)).toBeNull()
  })
  it('places the profile per platform', () => {
    expect(profileDir({ LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }, 'win32', 'C:\\Users\\Sam')).toBe(
      'C:\\Users\\Sam\\AppData\\Local\\Fremkit\\kiosk-profile',
    )
    expect(profileDir({ LOCALAPPDATA: 'rel' }, 'win32', 'C:\\Users\\Sam')).toBe('C:\\Users\\Sam\\AppData\\Local\\Fremkit\\kiosk-profile')
    expect(profileDir({}, 'darwin', '/Users/sam')).toBe('/Users/sam/Library/Application Support/Fremkit/chrome-profile')
  })
})

describe('kiosk.mjs screen and command', () => {
  it('parses the origin strictly', () => {
    expect(parseScreenOrigin('2560 0\n')).toEqual({ x: 2560, y: 0 })
    expect(parseScreenOrigin('-1920 120\r\n')).toEqual({ x: -1920, y: 120 })
    for (const bad of ['', '1 2 3', 'x y', '1 2; rm', '1  2', 'warning\n1 2', '1e3 2']) expect(parseScreenOrigin(bad)).toBeNull()
  })
  it('runs the constant screen script by absolute path', () => {
    expect(screenCommand('darwin', {})).toEqual({ file: '/usr/bin/swift', args: ['-'], script: SWIFT_SCREEN_SCRIPT })
    expect(screenCommand('win32', { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-Command', '-'],
      script: POWERSHELL_SCREEN_SCRIPT,
    })
    expect(POWERSHELL_SCREEN_SCRIPT).toContain('2560')
    expect(POWERSHELL_SCREEN_SCRIPT).toContain('720')
    expect(POWERSHELL_SCREEN_SCRIPT.indexOf('SetProcessDPIAware()')).toBeGreaterThan(-1)
    expect(POWERSHELL_SCREEN_SCRIPT.lastIndexOf('SetProcessDPIAware()')).toBeLessThan(POWERSHELL_SCREEN_SCRIPT.indexOf('AllScreens'))
  })
  const input = { profile: 'P', url: LINK, x: 2560, y: 0 }
  it('builds the same flags on both platforms', () => {
    expect(kioskFlags(input)).toEqual([
      '--user-data-dir=P',
      `--app=${LINK}`,
      '--window-position=2560,0',
      '--window-size=2560,720',
      '--kiosk',
      '--no-first-run',
      '--disable-session-crashed-bubble',
      '--autoplay-policy=no-user-gesture-required',
    ])
  })
  it('starts Chrome through open -na on the Mac and Edge directly on Windows', () => {
    const mac = kioskCommand({ ...input, platform: 'darwin', env: {} })
    expect(mac.file).toBe('/usr/bin/open')
    expect(mac.args.slice(0, 3)).toEqual(['-na', 'Google Chrome', '--args'])
    const env = { ProgramFiles: 'C:\\Program Files' }
    const win = kioskCommand({ ...input, platform: 'win32', env, exists: () => true })
    expect(win.file).toBe('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(win.args).toEqual(kioskFlags(input))
    expect(kioskCommand({ ...input, platform: 'win32', env: {}, exists: () => false }).error).toContain('Edge')
  })
})

describe('kiosk.mjs main', () => {
  const base = (over = {}) => {
    const errs: string[] = []
    return {
      errs,
      opts: {
        env: { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\Program Files' },
        platform: 'win32' as NodeJS.Platform,
        io: { err: (s: string) => errs.push(s) },
        mint: async () => LINK,
        run: async () => '2560 0\n',
        start: vi.fn().mockResolvedValue(undefined),
        exists: () => true,
        mkdir: vi.fn(),
        home: 'C:\\Users\\Sam',
        ...over,
      },
    }
  }
  it('starts Edge on the found display and creates the profile', async () => {
    const t = base()
    expect(await kioskMain([], t.opts)).toBe(0)
    expect(t.opts.mkdir).toHaveBeenCalledWith('C:\\L\\Fremkit\\kiosk-profile', expect.anything())
    const [file, args] = t.opts.start.mock.calls[0]
    expect(file).toContain('msedge.exe')
    expect(args).toContain('--window-position=2560,0')
  })
  it('falls back to 0,0 when the screen script fails or prints garbage', async () => {
    const a = base({ run: async () => { throw new Error('boom') } })
    await kioskMain([], a.opts)
    expect(a.opts.start.mock.calls[0][1]).toContain('--window-position=0,0')
    const b = base({ run: async () => 'junk' })
    await kioskMain([], b.opts)
    expect(b.opts.start.mock.calls[0][1]).toContain('--window-position=0,0')
  })
  it('exits 1 with the clear message when the profile or the launch fails', async () => {
    const a = base({ mkdir: vi.fn(() => { throw new Error('EROFS') }) })
    expect(await kioskMain([], a.opts)).toBe(1)
    expect(a.errs.at(-1)).toContain('could not start the browser')
    const b = base({ start: vi.fn().mockRejectedValue(new Error('ENOENT')) })
    expect(await kioskMain([], b.opts)).toBe(1)
    expect(b.errs.at(-1)).toContain('could not start the browser')
  })
  it('warns once on stderr when the display is not found', async () => {
    const t = base({ run: async () => 'junk' })
    expect(await kioskMain([], t.opts)).toBe(0)
    expect(t.errs).toEqual(['fremkit: the 2560x720 Edge display was not found; opening on the main display.'])
  })
  it('exits 1 when there is no link, or no Edge', async () => {
    const a = base({ mint: async () => null })
    expect(await kioskMain([], a.opts)).toBe(1)
    expect(a.errs[0]).toContain('is the server running?')
    const b = base({ exists: () => false })
    expect(await kioskMain([], b.opts)).toBe(1)
    expect(b.opts.start).not.toHaveBeenCalled()
    expect(b.errs[0]).toContain('Edge')
  })
})

describe('kiosk.mjs runScript, findScreen and launch', () => {
  it('sends the script on stdin and resolves to stdout', async () => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
    const execFile = vi.fn((_f: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) => {
      queueMicrotask(() => cb(null, '2560 0\n'))
      return { stdin }
    })
    const out = await runScript({ file: 'F', args: ['-'], script: 'SCRIPT' }, { execFile, timeout: 5 })
    expect(out).toBe('2560 0\n')
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual(['F', ['-']])
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 5, windowsHide: true })
    expect(stdin.end).toHaveBeenCalledWith('SCRIPT')
  })
  it('rejects on a timeout, and findScreen then warns and falls back to 0,0', async () => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
    const execFile = (_f: string, _a: string[], _o: object, cb: (e: Error) => void) => {
      queueMicrotask(() => cb(Object.assign(new Error('timed out'), { killed: true })))
      return { stdin }
    }
    const warn = vi.fn()
    const origin = await findScreen({ platform: 'win32', env: {}, warn, run: (c: never) => runScript(c, { execFile }) })
    expect(origin).toEqual({ x: 0, y: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('not found')
  })
  it('does not warn when the display is found', async () => {
    const warn = vi.fn()
    expect(await findScreen({ platform: 'darwin', warn, run: async () => '2560 -720\n' })).toEqual({ x: 2560, y: -720 })
    expect(warn).not.toHaveBeenCalled()
  })
  it('launches detached with the argument list, and rejects when the spawn fails', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await launch('E', ['--a', '--b'], { spawn })
    expect(spawn).toHaveBeenCalledWith('E', ['--a', '--b'], { detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()
    const bad = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const failing = vi.fn(() => {
      queueMicrotask(() => bad.emit('error', new Error('ENOENT')))
      return bad
    })
    await expect(launch('E', [], { spawn: failing })).rejects.toThrow('ENOENT')
    expect(bad.unref).not.toHaveBeenCalled()
  })
})
