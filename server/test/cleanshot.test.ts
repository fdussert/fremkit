import { describe, it, expect, vi } from 'vitest'
import { createCleanshotProvider, urlFor, RunPayloadSchema, ACTION_NAMES, CLEANSHOT_BUNDLE_ID, openArgs } from '../src/providers/cleanshot.js'

const LOCAL = { loopback: true }

function provider() {
  // `lsappinfo` answers nothing by default, so `open` targets the bundle id.
  const run = vi.fn(async () => '')
  return { run, p: createCleanshotProvider(run) }
}

/** The allow-list, as the documentation spells it, written out by hand so a typo shows up here. */
const EXPECTED = [
  'all-in-one',
  'capture-area',
  'capture-window',
  'capture-fullscreen',
  'capture-previous-area',
  'self-timer',
  'scrolling-capture',
  'capture-text',
  'record-screen',
  'pin',
  'open-from-clipboard',
  'open-history',
  'toggle-desktop-icons',
  'restore-recently-closed',
]

describe('cleanshot allow-list', () => {
  it('is exactly the documented set of actions', () => {
    expect([...ACTION_NAMES].sort()).toEqual([...EXPECTED].sort())
  })
  it('maps every allowed action to its exact URL', async () => {
    const { run, p } = provider()
    for (const action of EXPECTED) {
      expect(await p.commands!.run({ action }, LOCAL)).toEqual({ ok: true })
      expect(run).toHaveBeenLastCalledWith('open', ['-b', CLEANSHOT_BUNDLE_ID, `cleanshot://${action}`])
    }
    // One `lsappinfo` lookup and one `open` per action.
    expect(run).toHaveBeenCalledTimes(EXPECTED.length * 2)
  })
  it('refuses an action that is not on the list', async () => {
    const { run, p } = provider()
    for (const action of ['open-settings', 'open-annotate', 'add-quick-access-overlay', 'hide-desktop-icons', '', 'capture-area?x=1', 'CAPTURE-AREA']) {
      expect((await p.commands!.run({ action }, LOCAL) as { ok: boolean }).ok, action).toBe(false)
    }
    for (const payload of [null, undefined, 'capture-area', { action: 1 }, {}]) {
      expect((await p.commands!.run(payload, LOCAL) as { ok: boolean }).ok, JSON.stringify(payload)).toBe(false)
    }
    expect(run).not.toHaveBeenCalled()
  })
})

describe('cleanshot parameters', () => {
  it('accepts the documented enum and boolean parameters, in the URL', () => {
    expect(urlFor(RunPayloadSchema.parse({ action: 'capture-area', params: { action: 'upload' } }))).toBe('cleanshot://capture-area?action=upload')
    expect(urlFor(RunPayloadSchema.parse({ action: 'capture-window', params: { action: 'copy' } }))).toBe('cleanshot://capture-window?action=copy')
    expect(urlFor(RunPayloadSchema.parse({ action: 'capture-text', params: { linebreaks: true } }))).toBe('cleanshot://capture-text?linebreaks=true')
    expect(urlFor(RunPayloadSchema.parse({ action: 'scrolling-capture', params: { start: true, autoscroll: false } }))).toBe('cleanshot://scrolling-capture?autoscroll=false&start=true')
    expect(urlFor(RunPayloadSchema.parse({ action: 'open-history', params: {} }))).toBe('cleanshot://open-history')
  })
  it('refuses a value outside the enum, a wrong type, and a free-text parameter', () => {
    const refused = [
      { action: 'capture-area', params: { action: 'delete' } },
      { action: 'capture-area', params: { action: 'copy; rm -rf /' } },
      { action: 'capture-text', params: { linebreaks: 'true' } },
      { action: 'scrolling-capture', params: { start: 'yes' } },
      // Documented, but free text or geometry: never accepted from a widget.
      { action: 'pin', params: { filepath: '/etc/passwd' } },
      { action: 'capture-text', params: { filepath: '/etc/passwd' } },
      { action: 'capture-area', params: { x: 0, y: 0, width: 10, height: 10 } },
      { action: 'record-screen', params: { display: 1 } },
      // A parameter the action does not take at all.
      { action: 'open-history', params: { action: 'copy' } },
      { action: 'capture-window', params: { linebreaks: true } },
    ]
    for (const payload of refused) {
      expect(RunPayloadSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false)
    }
  })
  it('never runs anything for a refused payload', async () => {
    const { run, p } = provider()
    for (const payload of [{ action: 'capture-area', params: { action: 'delete' } }, { action: 'pin', params: { filepath: '/etc/passwd' } }, { action: 'open-settings' }]) {
      const result = await p.commands!.run(payload, LOCAL) as { ok: boolean; error?: string }
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(typeof result.error).toBe('string')
    }
    expect(run).not.toHaveBeenCalled()
  })
})

describe('cleanshot run', () => {
  it('hands `open` an argument list, never a shell', async () => {
    const { run, p } = provider()
    await p.commands!.run({ action: 'capture-area', params: { action: 'copy' } }, LOCAL)
    const [file, args] = run.mock.calls.at(-1) as unknown as [string, string[]]
    expect(file).toBe('open')
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual(['-b', CLEANSHOT_BUNDLE_ID, 'cleanshot://capture-area?action=copy'])
    expect(file).not.toMatch(/sh$/)
    expect(args.some((a) => /[;&|`$]/.test(a))).toBe(false)
  })
  it('sends the URL to the running copy of CleanShot by path when there is one', async () => {
    // An older copy on another volume also claims the scheme; `open <url>` alone may pick it.
    const run = vi.fn(async (file: string) => (file === 'lsappinfo' ? '"LSBundlePath"="/Applications/CleanShot X.app"\n' : ''))
    expect(await openArgs('cleanshot://open-history', run)).toEqual(['-a', '/Applications/CleanShot X.app', 'cleanshot://open-history'])
    expect(run).toHaveBeenCalledWith('lsappinfo', ['info', '-only', 'bundlepath', CLEANSHOT_BUNDLE_ID])
  })
  it('falls back to the bundle id when CleanShot is not running or lsappinfo fails', async () => {
    expect(await openArgs('cleanshot://pin', vi.fn(async () => ''))).toEqual(['-b', CLEANSHOT_BUNDLE_ID, 'cleanshot://pin'])
    expect(await openArgs('cleanshot://pin', vi.fn(async () => { throw new Error('nope') }))).toEqual(['-b', CLEANSHOT_BUNDLE_ID, 'cleanshot://pin'])
    expect(await openArgs('cleanshot://pin', vi.fn(async () => '"LSBundlePath"="relative/path"'))).toEqual(['-b', CLEANSHOT_BUNDLE_ID, 'cleanshot://pin'])
  })
  it('refuses a command that did not come from this machine', async () => {
    const { run, p } = provider()
    expect(await p.commands!.run({ action: 'capture-area' }, { loopback: false })).toMatchObject({ ok: false })
    expect(await p.commands!.run({ action: 'capture-area' })).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
  it('turns a failure into { ok: false, error }', async () => {
    const run = vi.fn(async (file: string) => { if (file === 'open') throw new Error('No application knows how to open this URL'); return '' })
    const p = createCleanshotProvider(run)
    expect(await p.commands!.run({ action: 'capture-area' }, LOCAL)).toEqual({ ok: false, error: 'No application knows how to open this URL' })
  })
  it('publishes nothing: no poll, no interval', () => {
    const { p } = provider()
    expect(p.channel).toBe('cleanshot')
    expect(p.poll).toBeUndefined()
    expect(p.intervalMs).toBeUndefined()
  })
})
