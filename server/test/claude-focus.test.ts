import { describe, it, expect } from 'vitest'
import { ClaudeTracker } from '../src/claude/tracker.js'
import { appOfProcess, focusClient } from '../src/claude/focus.js'
import { createClaudeSessionsProvider } from '../src/claude/providers.js'

/**
 * Going to the session, once the server knows where it lives.
 *
 * The card said "waiting for you" and a touch on it did nothing; the person then looked for the
 * window by hand. Everything below runs through `execFile` with a fixed argument list — there is
 * no shell anywhere — and every value taken from a session is matched against a pattern first,
 * because these end up as command-line arguments and an argument starting with a dash is a flag.
 * The AppleScripts are constants that take their one variable as `on run argv`.
 */

const ev = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'SessionStart', session_id: 's1', cwd: '/Users/alice/projects/fremkit', ...extra,
})
const ORCA = { bundleId: 'com.stablyai.orca', program: 'Orca', pid: 4242, tty: 'ttys028', orca: { pane: 'p:q', tab: 't', terminal: 'term_abc123' } }

describe('appOfProcess', () => {
  /** A process tree like the real one: claude → zsh → login → the app's helper. */
  const tree: Record<string, string> = {
    '1489': '83553 claude',
    '83553': '83552 -/bin/zsh',
    '83552': '9807 /usr/bin/login',
    '9807': '1 /Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper',
  }
  const reader = async (cmd: string, args: string[]) => {
    if (cmd === '/bin/ps') return `${tree[args[3]] ?? ''}\n`
    if (cmd === '/usr/bin/defaults') return args[1] === '/Applications/Orca.app/Contents/Info.plist' ? 'com.stablyai.orca\n' : ''
    throw new Error('unexpected ' + cmd)
  }

  it('walks up to the outermost .app and reads its bundle id', async () => {
    expect(await appOfProcess(1489, reader)).toBe('com.stablyai.orca')
  })

  it('recognises iTerm2 by its out-of-bundle server, and picks the tab by tty', async () => {
    const iterm: Record<string, string> = { '46407': '2219 claude', '2219': '2215 -zsh', '2215': '2214 /usr/bin/login', '2214': '1 /Users/someone/Library/Application Support/iTerm2/iTermServer-3.6.11' }
    const reader = async (cmd: string, args: string[]) => {
      if (cmd === '/bin/ps' && args[1] === 'tty=') return 'ttys000\n'
      if (cmd === '/bin/ps') return `${iterm[args[3]] ?? ''}\n`
      throw new Error('unexpected ' + cmd)
    }
    expect(await appOfProcess(46407, reader)).toBe('com.googlecode.iterm2')
    const calls: string[][] = []
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]) }
    const r = await focusClient(undefined, '/tmp', runner, 46407, reader)
    expect(r.ok).toBe(true)
    expect(calls[0][0]).toBe('/usr/bin/osascript')
    expect(calls[0]).toContain('/dev/ttys000')
  })

  it('answers null when no ancestor is an application', async () => {
    const bare = async (cmd: string, args: string[]) => cmd === '/bin/ps' ? ({ '7': '6 claude', '6': '1 -/bin/zsh' }[args[3]] ?? '') + '\n' : ''
    expect(await appOfProcess(7, bare)).toBeNull()
  })

  it('fronts the owning application for a session that only a scan found', async () => {
    const calls: string[][] = []
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]) }
    const r = await focusClient(undefined, '/tmp', runner, 1489, reader)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([['/usr/bin/open', '-b', 'com.stablyai.orca']])
  })
})

describe('focus', () => {
  const calls: { cmd: string; args: string[] }[] = []
  const runner = async (cmd: string, args: string[]): Promise<void> => { calls.push({ cmd, args }) }
  const fresh = (): typeof calls => { calls.length = 0; return calls }

  it('raises the exact Orca pane by its runtime handle', async () => {
    fresh()
    expect(await focusClient(ORCA, '/x', runner)).toEqual({ ok: true, how: 'pane' })
    expect(calls[0].args).toEqual(['terminal', 'switch', '--terminal', 'term_abc123'])
    // And Orca itself comes forward: the switch alone changes nothing on screen when another
    // application has the focus.
    expect(calls[1].cmd).toBe('/usr/bin/open')
    expect(calls[1].args).toEqual(['-b', 'com.stablyai.orca'])
  })

  it('falls back to fronting Orca when the pane cannot be raised', async () => {
    fresh()
    const failing = async (cmd: string, args: string[]): Promise<void> => {
      calls.push({ cmd, args })
      if (cmd.endsWith('/orca')) throw new Error('gone')
    }
    expect(await focusClient(ORCA, '/x', failing)).toEqual({ ok: true, how: 'app' })
    expect(calls[1]).toEqual({ cmd: '/usr/bin/open', args: ['-b', 'com.stablyai.orca'] })
  })

  it('passes the tty to an AppleScript as an argument, never inside it', async () => {
    fresh()
    expect(await focusClient({ program: 'Apple_Terminal', tty: 'ttys028' }, '/x', runner)).toEqual({ ok: true, how: 'tab' })
    const [cmd, args] = [calls[0].cmd, calls[0].args]
    expect(cmd).toBe('/usr/bin/osascript')
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('on run argv')
    expect(args[1]).not.toContain('ttys028')
    expect(args[2]).toBe('/dev/ttys028')
  })

  it('refuses a tty that is not one and fronts the application instead', async () => {
    fresh()
    // It ends up as a command-line argument. There is no shell to eat it — the worry is an
    // argument that starts with a dash, which is a flag.
    expect(await focusClient({ program: 'iTerm.app', tty: '--bad' }, '/x', runner)).toEqual({ ok: true, how: 'app' })
    expect(calls[0]).toEqual({ cmd: '/usr/bin/open', args: ['-b', 'com.googlecode.iterm2'] })
  })

  it('reuses the VS Code window already on the folder', async () => {
    fresh()
    expect(await focusClient({ program: 'vscode' }, '/Users/alice/p', runner)).toEqual({ ok: true, how: 'app' })
    expect(calls[0].args).toEqual(['-b', 'com.microsoft.VSCode', '/Users/alice/p'])
  })

  it('fronts an unknown client by its bundle id', async () => {
    fresh()
    expect(await focusClient({ bundleId: 'com.mitchellh.ghostty', program: 'ghostty' }, '/x', runner))
      .toEqual({ ok: true, how: 'app' })
    expect(calls[0].args).toEqual(['-b', 'com.mitchellh.ghostty'])
  })

  it('refuses a bundle id that is not one, and runs nothing', async () => {
    fresh()
    expect(await focusClient({ bundleId: '-b /etc/passwd' }, '/x', runner)).toEqual({ ok: false, reason: 'unknownClient' })
    expect(calls).toHaveLength(0)
  })

  it('has nothing to aim at when the hook said nothing', async () => {
    expect(await focusClient(undefined, '/x', runner)).toEqual({ ok: false, reason: 'unknownClient' })
    expect(await focusClient({}, '/x', runner)).toEqual({ ok: false, reason: 'unknownClient' })
  })
})

describe('the focus command', () => {
  const calls: { cmd: string; args: string[] }[] = []
  const provider = (tracker: ClaudeTracker) => createClaudeSessionsProvider(tracker, {
    focusRunner: async (cmd, args) => { calls.push({ cmd, args }) },
  })

  it('looks the session up itself: the payload is an id and nothing else', async () => {
    calls.length = 0
    const tracker = new ClaudeTracker()
    tracker.handle(ev({ client: ORCA }))
    const out = await provider(tracker).commands!.focus({ sessionId: 's1' }, { loopback: true, paired: false })
    expect(out).toEqual({ ok: true, how: 'pane' })
    expect(calls[0].args).toContain('term_abc123')
  })

  it('answers rather than throws for a session it does not know', async () => {
    const out = await provider(new ClaudeTracker()).commands!.focus({ sessionId: 'nope' }, { loopback: true, paired: false })
    expect(out).toEqual({ ok: false, reason: 'unknownSession' })
  })

  it('refuses a caller that is not on this machine', async () => {
    calls.length = 0
    const tracker = new ClaudeTracker()
    tracker.handle(ev({ client: ORCA }))
    const out = await provider(tracker).commands!.focus({ sessionId: 's1' }, { loopback: false, paired: false }) as { ok: boolean }
    expect(out.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a payload that is not a session id', async () => {
    await expect(provider(new ClaudeTracker()).commands!.focus({}, { loopback: true, paired: false })).rejects.toThrow()
  })
})


describe('cmux session navigation', () => {
  const workspace = '85F7E39D-4EC1-43B6-ADA7-CDCDF7A354EB'
  const surface = '22C82604-948E-469D-B2B4-849070102A18'
  it('uses the live process panel even when the hook already named cmux', async () => {
    const calls: string[][] = []
    const reader = async (_cmd: string, args: string[]) => args[0] === 'eww'
      ? `claude TERM_PROGRAM=ghostty __CFBundleIdentifier=com.cmuxterm.app CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface}` : 'ttys003'
    const result = await focusClient({ bundleId: 'com.cmuxterm.app', program: 'ghostty', pid: 123 }, '/x',
      async (cmd, args) => { calls.push([cmd, ...args]) }, 123, reader)
    expect(result).toEqual({ ok: true, how: 'pane' })
    expect(calls).toEqual([
      ['/Applications/cmux.app/Contents/Resources/bin/cmux', 'focus-panel', '--panel', surface, '--workspace', workspace],
      ['/usr/bin/open', '-b', 'com.cmuxterm.app'],
    ])
  })
  it.each([
    ['vscode', 'com.microsoft.VSCode', ['/usr/bin/open', '-b', 'com.microsoft.VSCode', '/project']],
    ['iTerm.app', 'com.googlecode.iterm2', ['/usr/bin/open', '-b', 'com.googlecode.iterm2']],
    ['Apple_Terminal', 'com.apple.Terminal', ['/usr/bin/open', '-b', 'com.apple.Terminal']],
  ])('honours %s over inherited cmux IDs', async (program, _bundle, expected) => {
    const calls: string[][] = []
    const reader = async (_cmd: string, args: string[]) => args[0] === 'eww'
      ? `claude TERM_PROGRAM=${program} __CFBundleIdentifier=com.cmuxterm.app CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface}` : 'ttys003'
    const result = await focusClient({ bundleId: 'com.cmuxterm.app', pid: 123 }, '/project',
      async (cmd, args) => { calls.push([cmd, ...args]) }, 123, reader)
    expect(result.ok).toBe(true)
    expect(calls.some(call => call[0].endsWith('/cmux'))).toBe(false)
    expect(calls.at(-1)).toEqual(expected)
  })
  it('falls back to fronting cmux when selecting the panel fails', async () => {
    const calls: string[][] = []
    const reader = async (_cmd: string, args: string[]) => args[0] === 'eww'
      ? `claude __CFBundleIdentifier=com.cmuxterm.app CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface}` : 'ttys003'
    const result = await focusClient({ bundleId: 'com.cmuxterm.app' }, '/x', async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd.endsWith('/cmux')) throw new Error('panel closed')
    }, 123, reader)
    expect(result).toEqual({ ok: true, how: 'app' })
    expect(calls.at(-1)).toEqual(['/usr/bin/open', '-b', 'com.cmuxterm.app'])
  })
  it('does not route an inherited cmux handle ahead of an Orca pane', async () => {
    const calls: string[][] = []
    const reader = async (_cmd: string, args: string[]) => args[0] === 'eww'
      ? `claude __CFBundleIdentifier=com.cmuxterm.app ORCA_TERMINAL_HANDLE=term_123 CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface}` : 'ttys003'
    const result = await focusClient({ bundleId: 'com.stablyai.orca', orca: { terminal: 'term_123' } }, '/x',
      async (cmd, args) => { calls.push([cmd, ...args]) }, 123, reader)
    expect(result).toEqual({ ok: true, how: 'pane' })
    expect(calls[0]?.[0]).toContain('/orca')
    expect(calls.some(call => call[0].endsWith('/cmux'))).toBe(false)
  })
  it('uses the live client when an unrelated process inherited CMUX variables', async () => {
    const calls: string[][] = []
    const reader = async (_cmd: string, args: string[]) => args[0] === 'eww'
      ? `code __CFBundleIdentifier=com.microsoft.VSCode CMUX_WORKSPACE_ID=${workspace} CMUX_SURFACE_ID=${surface}` : 'ttys003'
    const result = await focusClient({ bundleId: 'com.cmuxterm.app' }, '/project',
      async (cmd, args) => { calls.push([cmd, ...args]) }, 123, reader)
    expect(result).toEqual({ ok: true, how: 'app' })
    expect(calls).toEqual([['/usr/bin/open', '-b', 'com.microsoft.VSCode', '/project']])
  })
  it('never puts invalid process handles into a link', async () => {
    const calls: string[][] = []
    const reader = async () => 'CMUX_WORKSPACE_ID=--bad CMUX_SURFACE_ID=../../evil __CFBundleIdentifier=com.cmuxterm.app'
    expect(await focusClient({ bundleId: 'com.cmuxterm.app' }, '/x', async (cmd, args) => { calls.push([cmd, ...args]) }, 123, reader))
      .toEqual({ ok: true, how: 'app' })
    expect(calls).toEqual([['/usr/bin/open', '-b', 'com.cmuxterm.app']])
  })
})
