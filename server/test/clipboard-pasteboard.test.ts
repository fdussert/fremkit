import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls: { cmd: string; options: { env?: NodeJS.ProcessEnv } }[] = []

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }, cb: (err: Error | null, stdout: string) => void) => {
    calls.push({ cmd, options })
    queueMicrotask(() => cb(null, ''))
    return { stdin: { end: () => {} } }
  },
}))

const { pbPasteboard } = await import('../src/providers/clipboard.js')

describe('pbPasteboard', () => {
  beforeEach(() => { calls.length = 0 })

  // Under launchd the server has no locale, and pbcopy/pbpaste would read and write Mac Roman.
  it('runs pbcopy with a UTF-8 locale', async () => {
    await pbPasteboard.write('a · b × é')
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('/usr/bin/pbcopy')
    expect(calls[0].options.env).toMatchObject({ LC_CTYPE: 'UTF-8', LANG: 'en_US.UTF-8' })
  })

  it('runs pbpaste with a UTF-8 locale', async () => {
    await pbPasteboard.read()
    expect(calls[0].cmd).toBe('/usr/bin/pbpaste')
    expect(calls[0].options.env).toMatchObject({ LC_CTYPE: 'UTF-8', LANG: 'en_US.UTF-8' })
  })

  it('keeps the rest of the environment', async () => {
    await pbPasteboard.read()
    expect(calls[0].options.env?.PATH).toBe(process.env.PATH)
  })
})
