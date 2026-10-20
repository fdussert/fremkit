import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { CompanionDev, COMPANION_DEV_CHANNEL, createDevProvider, DEV_PUBLISH_MS } from '../src/companion/dev.js'
import type { DevTab, ServerMessage } from '../src/companion/protocol.js'
import { tr } from '../src/i18n.js'
import type { CommandContext } from '../src/providers/types.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const LOCAL: CommandContext = { loopback: true, paired: false }
const PAIRED: CommandContext = { loopback: false, paired: true, deviceId: 'ipad-1' }

function row(tabId: number, total = 1): DevTab {
  return {
    tabId,
    app: 'My app',
    host: 'localhost:5173',
    errors: { total, open: total, seen: 0, last: { text: `TypeError #${total}`, at: 1_000 } },
    requests: { total: 0, open: 0, seen: 0, last: null },
    history: [],
    server: 'up',
    activity: 1_000,
  }
}

function setup(opts: { enabled?: () => boolean; paired?: number } = {}) {
  const send = vi.fn<(deviceId: string, msg: ServerMessage) => void>()
  const changed = vi.fn<() => void>()
  const dev = new CompanionDev({
    send,
    changed,
    enabled: opts.enabled ?? (() => true),
    pairedCount: () => opts.paired ?? 2,
  })
  const tabs = (deviceId: string, rows: DevTab[]) => dev.onMessage(deviceId, { type: 'dev.tabs', tabs: rows })
  return { dev, send, changed, tabs }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('CompanionDev', () => {
  it('lists a connected install that announced fremdev, with its rows', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremplay', 'fremdev'])
    t.tabs(A, [row(7)])
    expect(t.dev.snapshot()).toEqual({
      enabled: true,
      paired: 2,
      installs: [{ deviceId: A, name: 'Chrome', on: true, connected: true, report: false, tabs: [row(7)] }],
    })
  })

  it('leaves out an install that sent no modules (an older extension)', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', undefined)
    t.tabs(A, [row(7)])
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev'] })
    expect(t.dev.snapshot().installs).toEqual([])
  })

  it('ignores dev.tabs while the install has fremdev off, and lists it with no rows', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremplay'])
    t.tabs(A, [row(7)])
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, report: false, tabs: [] }])
    // Turned on, it reports; turned off again, its rows go.
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev'] })
    t.tabs(A, [row(7)])
    expect(t.dev.snapshot().installs[0]).toMatchObject({ on: true, tabs: [row(7)] })
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay'] })
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, report: false, tabs: [] }])
  })

  it('keeps an install listed when it disconnects, with no rows: the extension\'s idle state', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    t.changed.mockClear()
    t.dev.disconnect(A)
    const idle = { deviceId: A, name: 'Chrome', on: true, connected: false, report: false, tabs: [] }
    expect(t.dev.snapshot().installs).toEqual([idle])
    expect(t.changed).toHaveBeenCalled()
    // A message from it afterwards is not heard.
    t.tabs(A, [row(7)])
    t.dev.onMessage(A, { type: 'modules', modules: [] })
    expect(t.dev.snapshot().installs).toEqual([idle])
    // A second disconnect publishes nothing new.
    t.changed.mockClear()
    t.dev.disconnect(A)
    expect(t.changed).not.toHaveBeenCalled()
    // It comes back in its place, connected, with what its hello says.
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.dev.connect(A, 'Chrome', ['fremplay'])
    expect(t.dev.snapshot().installs.map((i) => [i.deviceId, i.on, i.connected])).toEqual([[A, false, true], [B, true, true]])
  })

  it('forgets an install when its device is removed, or comes back unable to run Fremdev', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.dev.disconnect(A)
    t.changed.mockClear()
    t.dev.prune((id) => id === B)
    expect(t.dev.snapshot().installs.map((i) => i.deviceId)).toEqual([B])
    expect(t.changed).toHaveBeenCalledTimes(1)
    t.changed.mockClear()
    t.dev.prune(() => true)
    expect(t.changed).not.toHaveBeenCalled()
    t.dev.forget(B)
    expect(t.dev.snapshot().installs).toEqual([])
    // An older extension in place of a known install: no longer listed.
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.dev.connect(A, 'Chrome', undefined)
    expect(t.dev.snapshot().installs).toEqual([])
  })

  it('merges two installs, each with its own name', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.tabs(A, [row(7)])
    t.tabs(B, [row(9), row(10)])
    expect(t.dev.snapshot().installs).toEqual([
      { deviceId: A, name: 'Chrome', on: true, connected: true, report: false, tabs: [row(7)] },
      { deviceId: B, name: 'Brave', on: true, connected: true, report: false, tabs: [row(9), row(10)] },
    ])
  })

  it('replaces an install\'s rows wholesale with each message', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7), row(8)])
    t.tabs(A, [row(8, 3)])
    expect(t.dev.snapshot().installs[0].tabs).toEqual([row(8, 3)])
  })

  it('relays focus and clear to the install that reported the tab, and refuses an unknown tab or install', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.tabs(A, [row(7)])
    expect(t.dev.focus(A, 7)).toBe(true)
    expect(t.send).toHaveBeenLastCalledWith(A, { type: 'dev.focus', tabId: 7 })
    expect(t.dev.clear(A, 7)).toBe(true)
    expect(t.send).toHaveBeenLastCalledWith(A, { type: 'dev.clear', tabId: 7 })
    t.send.mockClear()
    expect(t.dev.focus(A, 8)).toBe(false)
    expect(t.dev.focus(B, 7)).toBe(false)
    expect(t.dev.clear(B, 7)).toBe(false)
    expect(t.dev.focus('33333333-3333-4333-8333-333333333333', 7)).toBe(false)
    t.dev.disconnect(A)
    expect(t.dev.focus(A, 7)).toBe(false)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('publishes at most 4 times a second per install and keeps the last rows', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.changed.mockClear()
    for (let i = 1; i <= 100; i++) {
      t.tabs(A, [row(7, i)])
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed.mock.calls.length).toBeGreaterThan(0)
    expect(t.changed.mock.calls.length).toBeLessThanOrEqual(5)
    expect(t.dev.snapshot().installs[0].tabs).toEqual([row(7, 100)])
  })

  it('publishes each install on its own clock', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.changed.mockClear()
    t.tabs(A, [row(7)])
    t.tabs(B, [row(9)])
    // Neither waits on the other.
    expect(t.changed).toHaveBeenCalledTimes(2)
  })

  it('a disconnect cancels the install\'s pending publish', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7, 1)])
    t.tabs(A, [row(7, 2)])
    t.dev.disconnect(A)
    t.changed.mockClear()
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed).not.toHaveBeenCalled()
  })

  it('a ping changes nothing and is not published', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.changed.mockClear()
    t.dev.onMessage(A, { type: 'ping' })
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })

  it('shows nothing while labs.companion is off', async () => {
    let on = true
    const t = setup({ enabled: () => on })
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    on = false
    expect(t.dev.snapshot()).toEqual({ enabled: false, paired: 2, installs: [] })
    expect(t.dev.focus(A, 7)).toBe(false)
    const config = { ...DEFAULT_CONFIG, labs: { devices: false, companion: false } } as Config
    const provider = createDevProvider({ dev: t.dev, config: () => config })
    expect(await provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toMatchObject({ ok: false })
    expect(await provider.commands!.clear({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toMatchObject({ ok: false })
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('createDevProvider', () => {
  const config = { ...DEFAULT_CONFIG, labs: { devices: false, companion: true } } as Config

  function provider() {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    return { ...t, provider: createDevProvider({ dev: t.dev, config: () => config }) }
  }

  it('publishes the snapshot on companion:dev', async () => {
    const t = provider()
    expect(t.provider.channel).toBe(COMPANION_DEV_CHANNEL)
    expect(COMPANION_DEV_CHANNEL).toBe('companion:dev')
    expect(await t.provider.poll!()).toEqual(t.dev.snapshot())
  })

  it('relays focus and clear from this Mac', async () => {
    const t = provider()
    expect(await t.provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toEqual({ ok: true })
    expect(t.send).toHaveBeenLastCalledWith(A, { type: 'dev.focus', tabId: 7 })
    expect(await t.provider.commands!.clear({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toEqual({ ok: true })
    expect(t.send).toHaveBeenLastCalledWith(A, { type: 'dev.clear', tabId: 7 })
    expect(await t.provider.commands!.focus({ deviceId: A, tabId: 8, instanceId: 'dev-1' }, LOCAL))
      .toEqual({ ok: false, error: tr(config.locale, 'companion.devUnknownTab') })
  })

  it('answers { ok: false } for an install that is not connected', async () => {
    const t = provider()
    t.dev.disconnect(A)
    expect(await t.provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL))
      .toEqual({ ok: false, error: tr(config.locale, 'companion.devUnknownTab') })
    expect(await t.provider.commands!.clear({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toMatchObject({ ok: false })
    expect(t.send).not.toHaveBeenCalled()
  })

  it('refuses focus from a paired device', async () => {
    const t = provider()
    await expect(t.provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, PAIRED))
      .rejects.toThrow(tr(config.locale, 'provider.localOnly'))
    await expect(t.provider.commands!.clear({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, undefined))
      .rejects.toThrow(tr(config.locale, 'provider.localOnly'))
    expect(t.send).not.toHaveBeenCalled()
  })

  it('refuses a payload with an extra key', async () => {
    const t = provider()
    const bad = [
      { deviceId: A, tabId: 7, instanceId: 'dev-1', url: 'https://example.com' },
      { deviceId: 'not-a-uuid', tabId: 7, instanceId: 'dev-1' },
      { deviceId: A, tabId: 7.5, instanceId: 'dev-1' },
      { deviceId: A, tabId: 7 },
    ]
    for (const payload of bad) {
      await expect(t.provider.commands!.focus(payload, LOCAL)).rejects.toThrow(tr(config.locale, 'provider.invalidPayload'))
    }
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('Fremdev reports', () => {
  const config = { ...DEFAULT_CONFIG, labs: { devices: false, companion: true } } as Config
  const REPORT = ['fremdev', 'fremdev.report']

  function asked(send: ReturnType<typeof setup>['send']) {
    return send.mock.calls.filter(([, m]) => m.type === 'dev.report.ask') as Array<[string, Extract<ServerMessage, { type: 'dev.report.ask' }>]>
  }

  function two() {
    const t = setup()
    t.dev.connect(A, 'Chrome', REPORT)
    t.dev.connect(B, 'Brave', REPORT)
    t.tabs(A, [row(7)])
    t.tabs(B, [row(7)])
    return t
  }

  it('lists whether an install can report', () => {
    const t = two()
    t.dev.connect(B, 'Brave', ['fremdev'])
    expect(t.dev.snapshot().installs.map((i) => [i.deviceId, i.report])).toEqual([[A, true], [B, false]])
    t.dev.onMessage(B, { type: 'modules', modules: REPORT })
    expect(t.dev.snapshot().installs[1].report).toBe(true)
  })

  it('asks the install named, and resolves to the text it answers', async () => {
    const t = two()
    const pending = t.dev.report(A, 7, true)
    const calls = asked(t.send)
    expect(calls).toHaveLength(1)
    const [to, msg] = calls[0]
    expect(to).toBe(A)
    expect(msg).toEqual({ type: 'dev.report.ask', id: expect.stringMatching(/^[0-9a-f-]{36}$/), tabId: 7, stack: true })
    t.dev.onMessage(A, { type: 'dev.report', id: msg.id, tabId: 7, text: 'Report' })
    expect(await pending).toBe('Report')
  })

  it('two browsers with tab 7: only the one named is asked, and the other cannot answer for it', async () => {
    const t = two()
    const pending = t.dev.report(A, 7, false)
    expect(asked(t.send).map(([to]) => to)).toEqual([A])
    const { id } = asked(t.send)[0][1]
    t.dev.onMessage(B, { type: 'dev.report', id, tabId: 7, text: 'from B' })
    // Nor an unknown id, nor another tab.
    t.dev.onMessage(A, { type: 'dev.report', id: '33333333-3333-4333-8333-333333333333', tabId: 7, text: 'stranger' })
    t.dev.onMessage(A, { type: 'dev.report', id, tabId: 8, text: 'other tab' })
    t.dev.onMessage(A, { type: 'dev.report', id, tabId: 7, text: 'from A' })
    expect(await pending).toBe('from A')
  })

  it('gives null after 5 s without an answer, and at once on a disconnect', async () => {
    const t = two()
    const late = t.dev.report(A, 7, false)
    let settled: string | null | undefined
    void late.then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeNull()
    // The pending entry is gone: a late answer changes nothing, and does not answer the next ask.
    const lateId = asked(t.send)[0][1].id
    t.dev.onMessage(A, { type: 'dev.report', id: lateId, tabId: 7, text: 'late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeNull()
    const next = t.dev.report(A, 7, false)
    const nextId = asked(t.send)[1][1].id
    expect(nextId).not.toBe(lateId)
    t.dev.onMessage(A, { type: 'dev.report', id: lateId, tabId: 7, text: 'late again' })
    t.dev.onMessage(A, { type: 'dev.report', id: nextId, tabId: 7, text: 'fresh' })
    expect(await next).toBe('fresh')
    // Neither left an entry behind: all 8 places are free again.
    const cut = Array.from({ length: 8 }, () => t.dev.report(A, 7, false))
    expect(asked(t.send)).toHaveLength(10)

    t.dev.disconnect(A)
    expect(await Promise.all(cut)).toEqual(Array(8).fill(null))
  })

  it('gives null at once when the install switches Fremdev off, or stops reporting', async () => {
    const t = two()
    const off = t.dev.report(A, 7, false)
    // Off with fremdev.report still listed (a buggy or newer extension): nothing will answer either.
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev.report'] })
    expect(await off).toBeNull()
    const quiet = t.dev.report(B, 7, false)
    t.dev.onMessage(B, { type: 'modules', modules: ['fremdev'] })
    expect(await quiet).toBeNull()
  })

  it('gives null at once when the tab asked for leaves the install\'s rows, and keeps the others waiting', async () => {
    const t = two()
    t.tabs(A, [row(7), row(8)])
    const gone = t.dev.report(A, 7, false)
    const kept = t.dev.report(A, 8, false)
    const keptId = asked(t.send)[1][1].id
    t.tabs(A, [row(8)])
    expect(await gone).toBeNull()
    t.dev.onMessage(A, { type: 'dev.report', id: keptId, tabId: 8, text: 'still here' })
    expect(await kept).toBe('still here')
  })

  it('gives null and sends nothing for an install without fremdev.report, an unknown tab or install', async () => {
    const t = two()
    t.dev.connect(B, 'Brave', ['fremdev'])
    t.tabs(B, [row(7)])
    expect(await t.dev.report(B, 7, false)).toBeNull()
    expect(await t.dev.report(A, 8, false)).toBeNull()
    expect(await t.dev.report('44444444-4444-4444-8444-444444444444', 7, false)).toBeNull()
    expect(asked(t.send)).toEqual([])
  })

  it('keeps at most 8 asks waiting per install: a 9th gives null', async () => {
    const t = two()
    for (let i = 0; i < 8; i++) void t.dev.report(A, 7, false)
    expect(await t.dev.report(A, 7, false)).toBeNull()
    expect(asked(t.send)).toHaveLength(8)
    // Another install has its own room.
    void t.dev.report(B, 7, false)
    expect(asked(t.send)).toHaveLength(9)
  })

  describe('the report command', () => {
    function provider(write = vi.fn<(text: string) => Promise<void>>(async () => undefined)) {
      const t = two()
      const pasteboard = { read: async () => '', write }
      return { ...t, write, provider: createDevProvider({ dev: t.dev, config: () => config, pasteboard }) }
    }
    const payload = { deviceId: A, tabId: 7, instanceId: 'dev-1', stack: true }

    it('refuses a caller that is not this Mac', async () => {
      const t = provider()
      await expect(t.provider.commands!.report(payload, PAIRED)).rejects.toThrow(tr(config.locale, 'provider.localOnly'))
      expect(asked(t.send)).toEqual([])
    })

    it('refuses a payload without stack', async () => {
      const t = provider()
      await expect(t.provider.commands!.report({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL))
        .rejects.toThrow(tr(config.locale, 'provider.invalidPayload'))
    })

    it('writes the text to the pasteboard', async () => {
      const t = provider()
      const result = t.provider.commands!.report(payload, LOCAL)
      const [, msg] = asked(t.send)[0]
      t.dev.onMessage(A, { type: 'dev.report', id: msg.id, tabId: 7, text: 'Report' })
      expect(await result).toEqual({ ok: true })
      expect(t.write).toHaveBeenCalledWith('Report')
    })

    it('fails when no report comes, or the pasteboard throws', async () => {
      const t = provider(vi.fn(async () => { throw new Error('pbcopy') }))
      const error = tr(config.locale, 'companion.devReportFailed')
      const none = t.provider.commands!.report(payload, LOCAL)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await none).toEqual({ ok: false, error })
      expect(t.write).not.toHaveBeenCalled()

      const thrown = t.provider.commands!.report(payload, LOCAL)
      t.dev.onMessage(A, { type: 'dev.report', id: asked(t.send)[1][1].id, tabId: 7, text: 'Report' })
      expect(await thrown).toEqual({ ok: false, error })
    })
  })
})
