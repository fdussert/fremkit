import { describe, it, expect, vi } from 'vitest'
import { createShortcutsProvider, argvFor, OpenPayloadSchema, resolveButton } from '../src/providers/shortcuts.js'
import type { InstanceLookup } from '../src/config/instances.js'

const LOCAL = { loopback: true }
const INSTANCE = 'sc-1'

/** The buttons the three `open` tests below press, as the user would have saved them. */
const SAVED = [
  { label: 'Calc', kind: 'app', target: 'Calculator' },
  { label: 'Site', kind: 'url', target: ' https://example.com ' },
  { label: 'Morning', kind: 'shortcut', target: 'Good Morning' },
]

/** An instance lookup standing in for the saved dashboard. */
const lookup = (buttons: unknown, widgetId = 'shortcuts'): InstanceLookup =>
  (id) => (id === INSTANCE ? { widgetId, settings: { buttons } as Record<string, unknown> } : null)

function provider(buttons: unknown = SAVED) {
  const run = vi.fn(async () => {})
  return { run, p: createShortcutsProvider(run, lookup(buttons)) }
}

/** Pressing button `index` of our instance, which is all a widget may ask for. */
const press = (index: unknown) => ({ instanceId: INSTANCE, index })

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
  it('runs the argv of the saved button and reports ok', async () => {
    const { run, p } = provider()
    expect(await p.commands!.open(press(0), LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('open', ['-a', 'Calculator'])
    expect(await p.commands!.open(press(1), LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('open', ['https://example.com'])
    expect(await p.commands!.open(press(2), LOCAL)).toEqual({ ok: true })
    expect(run).toHaveBeenLastCalledWith('shortcuts', ['run', 'Good Morning'])
  })
  it('never runs anything for a refused request', async () => {
    const { run, p } = provider()
    for (const payload of [press(-1), press(3), press(1.5), press(24), press('0'), press(undefined),
      { index: 0 }, { instanceId: INSTANCE }, null]) {
      const result = await p.commands!.open(payload, LOCAL) as { ok: boolean; error?: string }
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(typeof result.error).toBe('string')
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('never runs a target the caller named rather than saved', async () => {
    const { run, p } = provider()
    // The old payload shape: the target straight from the widget. This is the hole being closed —
    // any widget declaring the `shortcuts` channel could run anything on the Mac.
    for (const payload of [{ kind: 'app', target: 'Terminal' }, { kind: 'url', target: 'file:///etc/passwd' },
      { kind: 'shortcut', target: 'Wipe disk' }, { instanceId: INSTANCE, index: 0, kind: 'app', target: 'Terminal' }]) {
      const result = await p.commands!.open(payload, LOCAL) as { ok: boolean }
      if (!('instanceId' in payload)) expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    // The last one carries a valid request *and* a target: the target is ignored.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenLastCalledWith('open', ['-a', 'Calculator'])
  })
  it('never runs a saved button that is not a usable target', async () => {
    const { run, p } = provider([
      { kind: 'url', target: 'file:///etc/passwd' },
      { kind: 'app', target: 'a/b' },
      { kind: 'shell', target: 'ls' },
      { kind: 'app', target: '-a' },
    ])
    for (const index of [0, 1, 2, 3]) {
      expect((await p.commands!.open(press(index), LOCAL) as { ok: boolean }).ok, String(index)).toBe(false)
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a command that did not come from this machine', async () => {
    const { run, p } = provider()
    expect(await p.commands!.open(press(0), { loopback: false })).toMatchObject({ ok: false })
    expect(await p.commands!.open(press(0))).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
  it('turns a failure into { ok: false, error }', async () => {
    const run = vi.fn(async () => { throw new Error('Unable to find application') })
    const p = createShortcutsProvider(run, lookup(SAVED))
    expect(await p.commands!.open(press(0), LOCAL)).toEqual({ ok: false, error: 'Unable to find application' })
  })
})

describe('resolveButton', () => {
  it('reads the button the user saved at that index', () => {
    const r = resolveButton(lookup(SAVED), { instanceId: INSTANCE, index: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload).toEqual({ kind: 'shortcut', target: 'Good Morning' })
  })
  it('refuses an instance it cannot find', () => {
    expect(resolveButton(lookup(SAVED), { instanceId: 'someone-else', index: 0 }).ok).toBe(false)
  })
  it('refuses an instance of another widget', () => {
    // Otherwise a widget could borrow a shortcuts instance's id to press its buttons.
    expect(resolveButton(lookup(SAVED, 'clock'), { instanceId: INSTANCE, index: 0 }).ok).toBe(false)
  })
  it('refuses an index past the saved buttons, and a missing list', () => {
    expect(resolveButton(lookup(SAVED), { instanceId: INSTANCE, index: 3 }).ok).toBe(false)
    expect(resolveButton(lookup([]), { instanceId: INSTANCE, index: 0 }).ok).toBe(false)
    expect(resolveButton(lookup(undefined), { instanceId: INSTANCE, index: 0 }).ok).toBe(false)
    expect(resolveButton(lookup('nope'), { instanceId: INSTANCE, index: 0 }).ok).toBe(false)
  })
})
