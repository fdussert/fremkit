import { describe, expect, it, vi } from 'vitest'
import { parseProcArgs, ProcArgsError, readProcArgs } from '../src/companion/servers/procargs.js'

const SENTINEL = 's3cr3t'
const ENV = { PATH: '/usr/bin:/bin', SECRET_TOKEN: SENTINEL }
const ARGV = ['node', '/opt/homebrew/bin/pnpm', 'dev', '--title', 'my app']

describe('procargs', () => {
  it('reads one JSON line from `fremkit-scan procargs <pid>`', async () => {
    const run = vi.fn(async () => JSON.stringify({ type: 'procargs', exe: '/opt/homebrew/bin/node', argv: ARGV, env: ENV }) + '\n')
    const args = await readProcArgs('/Applications/Fremkit.app/Contents/MacOS/fremkit-scan', 1001, run)
    expect(run).toHaveBeenCalledWith('/Applications/Fremkit.app/Contents/MacOS/fremkit-scan', ['procargs', '1001'])
    expect(args).toEqual({ exe: '/opt/homebrew/bin/node', argv: ARGV, env: ENV })
  })

  it('refuses a hidden environment rather than lending Fremkit’s own', () => {
    expect(() => parseProcArgs(JSON.stringify({ type: 'procargs', exe: '/bin/x', argv: ['x'], env: null }))).toThrow(ProcArgsError)
    try { parseProcArgs(JSON.stringify({ type: 'procargs', exe: '/bin/x', argv: ['x'], env: null })) } catch (e) { expect((e as ProcArgsError).code).toBe('hidden') }
  })

  it('turns the scanner’s errors and any garbage into a code that quotes nothing', () => {
    for (const [line, code] of [
      ['{"type":"error","code":"no-such-process"}', 'no-such-process'],
      ['{"type":"error","code":"denied"}', 'denied'],
      ['{"type":"error","code":"failed"}', 'failed'],
      [`{"type":"procargs","exe":"relative","argv":["x"],"env":{"SECRET_TOKEN":"${SENTINEL}"}}`, 'invalid'],
      [`{"type":"procargs","exe":"/bin/x","argv":[],"env":{"SECRET_TOKEN":"${SENTINEL}"}}`, 'invalid'],
      [`not json SECRET_TOKEN=${SENTINEL}`, 'invalid'],
      ['', 'invalid'],
    ] as const) {
      let error: unknown
      try { parseProcArgs(line) } catch (e) { error = e }
      expect(error).toBeInstanceOf(ProcArgsError)
      expect((error as ProcArgsError).code).toBe(code)
      expect((error as Error).message).not.toContain(SENTINEL)
    }
  })
})
