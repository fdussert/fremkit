import { describe, it, expect, vi } from 'vitest'
import { createShortcutsProvider, argvFor, OpenPayloadSchema } from '../src/providers/shortcuts.js'

const LOCAL = { loopback: true }

function provider() {
  const run = vi.fn(async () => {})
  return { run, p: createShortcutsProvider(run) }
}

describe('shortcuts payload validation', () => {
  it('accepts the three kinds', () => {
    expect(OpenPayloadSchema.safeParse({ kind: 'app', target: 'Calculator' }).success).toBe(true)
    expect(OpenPayloadSchema.safeParse({ kind: 'url', target: 'https://example.com' }).success).toBe(true)
    expect(OpenPayloadSchema.safeParse({ kind: 'url', target: 'mailto:someone@example.com' }).success).toBe(true)
    expect(OpenPayloadSchema.safeParse({ kind: 'shortcut', target: 'Good Morning' }).success).toBe(true)
  })
  it('refuses any other kind, including a shell', () => {
    expect(OpenPayloadSchema.safeParse({ kind: 'shell', target: 'ls' }).success).toBe(false)
    expect(OpenPayloadSchema.safeParse({ kind: 'file', target: '/etc/passwd' }).success).toBe(false)
  })
  it('refuses a url that is not http, https or mailto', () => {
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'not a url']) {
      expect(OpenPayloadSchema.safeParse({ kind: 'url', target }).success, target).toBe(false)
    }
  })
  it('refuses a name with a path separator or a shell metacharacter', () => {
    for (const target of ['/Applications/Calculator.app', '..\\Windows', 'Calc; rm -rf /', 'Calc && ls', 'Calc | cat', 'Calc `id`', 'Calc $(id)', '-a']) {
      expect(OpenPayloadSchema.safeParse({ kind: 'app', target }).success, target).toBe(false)
      expect(OpenPayloadSchema.safeParse({ kind: 'shortcut', target }).success, target).toBe(false)
    }
  })
  it('refuses an empty target and one longer than 200 characters', () => {
    expect(OpenPayloadSchema.safeParse({ kind: 'app', target: '   ' }).success).toBe(false)
    expect(OpenPayloadSchema.safeParse({ kind: 'app', target: 'a'.repeat(201) }).success).toBe(false)
    expect(OpenPayloadSchema.safeParse({ kind: 'app', target: 'a'.repeat(200) }).success).toBe(true)
  })
})

describe('shortcuts argv', () => {
  it('maps each kind to a program and its arguments', () => {
    expect(argvFor({ kind: 'app', target: 'Calculator' })).toEqual(['open', ['-a', 'Calculator']])
    expect(argvFor({ kind: 'url', target: 'https://example.com' })).toEqual(['open', ['https://example.com']])
    expect(argvFor({ kind: 'shortcut', target: 'Good Morning' })).toEqual(['shortcuts', ['run', 'Good Morning']])
  })
})

describe('shortcuts open', () => {
  it('runs the right argv and reports ok', async () => {
    const { run, p } = provider()
    expect(await p.commands!.open({ kind: 'app', target: 'Calculator' }, LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('open', ['-a', 'Calculator'])
    expect(await p.commands!.open({ kind: 'url', target: ' https://example.com ' }, LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('open', ['https://example.com'])
    expect(await p.commands!.open({ kind: 'shortcut', target: 'Good Morning' }, LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('shortcuts', ['run', 'Good Morning'])
  })
  it('never runs anything for a refused payload', async () => {
    const { run, p } = provider()
    for (const payload of [{ kind: 'url', target: 'file:///etc/passwd' }, { kind: 'url', target: 'javascript:alert(1)' }, { kind: 'app', target: 'a/b' }, { kind: 'shortcut', target: 'a;b' }, { kind: 'shell', target: 'ls' }, null]) {
      const result = await p.commands!.open(payload, LOCAL) as { ok: boolean; error?: string }
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(typeof result.error).toBe('string')
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a command that did not come from this machine', async () => {
    const { run, p } = provider()
    expect(await p.commands!.open({ kind: 'app', target: 'Calculator' }, { loopback: false })).toMatchObject({ ok: false })
    expect(await p.commands!.open({ kind: 'app', target: 'Calculator' })).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
  it('turns a failure into { ok: false, error }', async () => {
    const run = vi.fn(async () => { throw new Error('Unable to find application') })
    const p = createShortcutsProvider(run)
    expect(await p.commands!.open({ kind: 'app', target: 'Nope' }, LOCAL)).toEqual({ ok: false, error: 'Unable to find application' })
  })
})
