import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js'
import { CompanionDev, COMPANION_DEV_CHANNEL, createDevProvider, DEV_PUBLISH_MS, fremdevEnabled, MAX_PENDING_ASKS, OPEN_TIMEOUT_MS } from '../src/companion/dev.js'
import { FREMDEV_FEATURES, type DevTab, type ServerMessage } from '../src/companion/protocol.js'
// @ts-expect-error the extension's plain JavaScript has no declarations
import { FEATURE_MODULES } from '../../companion/fremdev.js'
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
    devServer: null,
    inFlight: 0,
    perf: {},
    server: 'up',
    activity: 1_000,
  }
}

function setup(opts: { enabled?: () => boolean; paired?: number; features?: readonly string[] } = {}) {
  const send = vi.fn<(deviceId: string, msg: ServerMessage) => void>()
  const changed = vi.fn<() => void>()
  const dev = new CompanionDev({
    send,
    changed,
    enabled: opts.enabled ?? (() => true),
    pairedCount: () => opts.paired ?? 2,
    ...(opts.features ? { features: opts.features } : {}),
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
      installs: [{ deviceId: A, name: 'Chrome', on: true, connected: true, report: false, features: [], tabs: [row(7)] }],
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
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, report: false, features: [], tabs: [] }])
    // Turned on, it reports; turned off again, its rows go.
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev'] })
    t.tabs(A, [row(7)])
    expect(t.dev.snapshot().installs[0]).toMatchObject({ on: true, tabs: [row(7)] })
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay'] })
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, report: false, features: [], tabs: [] }])
  })

  it('keeps an install listed when it disconnects, with no rows: the extension\'s idle state', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    t.changed.mockClear()
    t.dev.disconnect(A)
    const idle = { deviceId: A, name: 'Chrome', on: true, connected: false, report: false, features: [], tabs: [] }
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
      { deviceId: A, name: 'Chrome', on: true, connected: true, report: false, features: [], tabs: [row(7)] },
      { deviceId: B, name: 'Brave', on: true, connected: true, report: false, features: [], tabs: [row(9), row(10)] },
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

  it('shows nothing while labs.fremdev is off', async () => {
    let on = true
    const t = setup({ enabled: () => on })
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    on = false
    expect(t.dev.snapshot()).toEqual({ enabled: false, paired: 2, installs: [] })
    expect(t.dev.focus(A, 7)).toBe(false)
    const config = { ...DEFAULT_CONFIG, labs: { fremdev: false } } as Config
    const provider = createDevProvider({ dev: t.dev, config: () => config })
    expect(await provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toMatchObject({ ok: false })
    expect(await provider.commands!.clear({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL)).toMatchObject({ ok: false })
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('fremdevEnabled', () => {
  it('reads Fremdev\'s own switch alone', () => {
    expect(fremdevEnabled({ labs: { fremdev: false } })).toBe(false)
    expect(fremdevEnabled({ labs: { fremdev: true } })).toBe(true)
    expect(fremdevEnabled({} as Pick<Config, 'labs'>)).toBe(false)
  })
  it('ignores what a 0.5.0 config still says about labs.companion', () => {
    const old = (companion: boolean, fremdev: boolean) => ({ labs: { companion, fremdev } } as unknown as Pick<Config, 'labs'>)
    expect(fremdevEnabled(old(false, true))).toBe(true)
    expect(fremdevEnabled(old(true, false))).toBe(false)
  })
})

describe('with Fremdev off', () => {
  const config = { ...DEFAULT_CONFIG, labs: { fremdev: false } } as Config

  it('lists nothing, and focus says to turn Fremdev on', async () => {
    const t = setup({ enabled: () => fremdevEnabled(config) })
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    const snap = t.dev.snapshot()
    expect(snap.enabled).toBe(false)
    expect(snap.installs).toEqual([])
    const provider = createDevProvider({ dev: t.dev, config: () => config })
    expect(await provider.commands!.focus({ deviceId: A, tabId: 7, instanceId: 'dev-1' }, LOCAL))
      .toEqual({ ok: false, error: tr(config.locale, 'companion.devDisabled') })
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('createDevProvider', () => {
  const config = { ...DEFAULT_CONFIG, labs: { fremdev: true } } as Config

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
  const config = { ...DEFAULT_CONFIG, labs: { fremdev: true } } as Config
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
    expect(MAX_PENDING_ASKS).toBe(8)
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

describe('Fremdev features', () => {
  // A feature of the test's own, handed to the hub: FREMDEV_FEATURES itself is never changed.
  const TEST_FEATURE = 'fremdev.test'
  const FEATURES = [...FREMDEV_FEATURES, TEST_FEATURE]

  it('lists the features a control depends on', () => {
    expect(FREMDEV_FEATURES).not.toContain(TEST_FEATURE)
    expect(FREMDEV_FEATURES.every((f) => f.startsWith('fremdev.'))).toBe(true)
  })

  it("lists the same features as the extension's FEATURE_MODULES", () => {
    expect([...FEATURE_MODULES].sort()).toEqual([...FREMDEV_FEATURES].sort())
  })

  it('lists the features an install announced, sorted, and never an unknown fremdev name', () => {
    const t = setup({ features: FEATURES })
    t.dev.connect(A, 'Chrome', ['fremdev', 'fremdev.unknown', TEST_FEATURE, 'fremdev.report'])
    t.dev.connect(B, 'Brave', ['fremdev'])
    expect(t.dev.snapshot().installs.map((i) => [i.deviceId, i.features, i.report])).toEqual([[A, [TEST_FEATURE], true], [B, [], false]])
  })

  it('republishes when a modules message only adds or removes a feature', () => {
    const t = setup({ features: FEATURES })
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.changed.mockClear()
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev', TEST_FEATURE] })
    expect(t.changed).toHaveBeenCalledTimes(1)
    expect(t.dev.snapshot().installs[0].features).toEqual([TEST_FEATURE])
    // The same list again changes nothing.
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    t.changed.mockClear()
    t.dev.onMessage(A, { type: 'modules', modules: [TEST_FEATURE, 'fremdev'] })
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed).not.toHaveBeenCalled()
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev'] })
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed).toHaveBeenCalledTimes(1)
    expect(t.dev.snapshot().installs[0].features).toEqual([])
  })

  it('shows no features in the snapshot while Fremdev is off in Fremkit', () => {
    let on = true
    const t = setup({ enabled: () => on, features: FEATURES })
    t.dev.connect(A, 'Chrome', ['fremdev', TEST_FEATURE])
    on = false
    expect(t.dev.snapshot().installs).toEqual([])
  })

  /** The private generic ask, reached for the test: Tasks 4, 5 and 9 build their commands on it. */
  type Ask = (deviceId: string, tabId: number, feature: string, answer: 'dev.report', build: (id: string) => ServerMessage, timeoutMs: number) => Promise<unknown>
  const askOf = (dev: CompanionDev) => (dev as unknown as { ask: Ask }).ask.bind(dev)
  const build = (id: string): ServerMessage => ({ type: 'dev.report.ask', id, tabId: 7, stack: false })
  const lastId = (send: ReturnType<typeof setup>['send']) => (send.mock.calls.at(-1)![1] as { id: string }).id

  it('a generic ask needs its feature, resolves to the matching answer, and to null once the feature is withdrawn', async () => {
    const t = setup({ features: FEATURES })
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    const ask = askOf(t.dev)
    expect(await ask(A, 7, TEST_FEATURE, 'dev.report', build, 1_000)).toBeNull()
    expect(t.send).not.toHaveBeenCalled()

    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev', TEST_FEATURE] })
    const answered = ask(A, 7, TEST_FEATURE, 'dev.report', build, 1_000)
    const id = lastId(t.send)
    t.dev.onMessage(A, { type: 'dev.report', id, tabId: 8, text: 'other tab' })
    t.dev.onMessage(A, { type: 'dev.report', id, tabId: 7, text: 'mine' })
    expect(await answered).toEqual({ type: 'dev.report', id, tabId: 7, text: 'mine' })

    const withdrawn = ask(A, 7, TEST_FEATURE, 'dev.report', build, 1_000)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev'] })
    expect(await withdrawn).toBeNull()

    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev', TEST_FEATURE] })
    const timed = ask(A, 7, TEST_FEATURE, 'dev.report', build, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await timed).toBeNull()
  })

  it('withdrawing one feature leaves the asks of another waiting', async () => {
    const t = setup({ features: FEATURES })
    t.dev.connect(A, 'Chrome', ['fremdev', 'fremdev.report', TEST_FEATURE])
    t.tabs(A, [row(7)])
    const report = t.dev.report(A, 7, false)
    const id = lastId(t.send)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremdev', 'fremdev.report'] })
    t.dev.onMessage(A, { type: 'dev.report', id, tabId: 7, text: 'still here' })
    expect(await report).toBe('still here')
  })
})

describe('Fremdev open in editor', () => {
  const config = { ...DEFAULT_CONFIG, labs: { fremdev: true } } as Config
  const OPEN = ['fremdev', 'fremdev.open']

  /** Tab 7 with entries 3 and 4 in its last history. */
  function withHistory(tabId: number): DevTab {
    return {
      ...row(tabId),
      history: [
        { kind: 'error', id: 4, text: 'TypeError', origin: '/src/main.ts:1:1', n: 1, at: 1_000, state: 'open' },
        { kind: 'build', id: 3, text: 'Unexpected token', file: '~/app/src/App.vue', line: 12, col: 3, n: 1, at: 900, state: 'open' },
      ],
    }
  }

  function asked(send: ReturnType<typeof setup>['send']) {
    return send.mock.calls.filter(([, m]) => m.type === 'dev.open.ask') as Array<[string, Extract<ServerMessage, { type: 'dev.open.ask' }>]>
  }

  function two(opts: { enabled?: () => boolean } = {}) {
    const t = setup(opts)
    t.dev.connect(A, 'Chrome', OPEN)
    t.dev.connect(B, 'Brave', OPEN)
    t.tabs(A, [withHistory(7)])
    t.tabs(B, [withHistory(7)])
    return t
  }

  it('is one of the features a control depends on', () => {
    expect(FREMDEV_FEATURES).toContain('fremdev.open')
  })

  it('asks the device named only, and a matching dev.open.done resolves true', async () => {
    const t = two()
    const pending = t.dev.open(A, 7, 3)
    const calls = asked(t.send)
    expect(calls.map(([to]) => to)).toEqual([A])
    const [, msg] = calls[0]
    expect(msg).toEqual({ type: 'dev.open.ask', id: expect.stringMatching(/^[0-9a-f-]{36}$/), tabId: 7, entryId: 3 })
    // Another browser, or a report with that id, is not its answer.
    t.dev.onMessage(B, { type: 'dev.open.done', id: msg.id, tabId: 7, ok: true })
    t.dev.onMessage(A, { type: 'dev.report', id: msg.id, tabId: 7, text: 'not this' })
    t.dev.onMessage(A, { type: 'dev.open.done', id: msg.id, tabId: 7, ok: true })
    expect(await pending).toBe(true)
  })

  it('resolves to the answer\'s ok', async () => {
    const t = two()
    const pending = t.dev.open(A, 7, 4)
    t.dev.onMessage(A, { type: 'dev.open.done', id: asked(t.send)[0][1].id, tabId: 7, ok: false })
    expect(await pending).toBe(false)
  })

  it('resolves false, sending nothing, without fremdev.open, for an entry not in the tab\'s last history, or with Fremdev off', async () => {
    let on = true
    const t = two({ enabled: () => on })
    t.dev.connect(B, 'Brave', ['fremdev', 'fremdev.report'])
    t.tabs(B, [withHistory(7)])
    expect(await t.dev.open(B, 7, 3)).toBe(false)
    // Entry 2 has left the ring (Review Focus 3), and tab 8 was never reported.
    expect(await t.dev.open(A, 7, 2)).toBe(false)
    expect(await t.dev.open(A, 8, 3)).toBe(false)
    // A history that moved on since: entry 3 is no longer there.
    t.tabs(A, [{ ...withHistory(7), history: withHistory(7).history.slice(0, 1) }])
    expect(await t.dev.open(A, 7, 3)).toBe(false)
    on = false
    expect(await t.dev.open(A, 7, 4)).toBe(false)
    expect(asked(t.send)).toEqual([])
  })

  it('resolves false after 5 000 ms without an answer', async () => {
    expect(OPEN_TIMEOUT_MS).toBe(5_000)
    const t = two()
    let settled: boolean | undefined
    void t.dev.open(A, 7, 3).then((v) => { settled = v })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
  })

  describe('the open command', () => {
    function provider() {
      const t = two()
      return { ...t, provider: createDevProvider({ dev: t.dev, config: () => config }) }
    }
    const payload = { deviceId: A, tabId: 7, instanceId: 'dev-1', entryId: 3 }

    it('refuses a caller that is not this Mac', async () => {
      const t = provider()
      await expect(t.provider.commands!.open(payload, PAIRED)).rejects.toThrow(tr(config.locale, 'provider.localOnly'))
      await expect(t.provider.commands!.open(payload, undefined)).rejects.toThrow(tr(config.locale, 'provider.localOnly'))
      expect(asked(t.send)).toEqual([])
    })

    it('refuses an entry id out of bounds, missing or with an extra key', async () => {
      const t = provider()
      const bad = [
        { ...payload, entryId: 0 },
        { ...payload, entryId: 2_147_483_648 },
        { ...payload, entryId: 1.5 },
        { deviceId: A, tabId: 7, instanceId: 'dev-1' },
        { ...payload, url: 'http://localhost:5173/__open-in-editor' },
      ]
      for (const p of bad) {
        await expect(t.provider.commands!.open(p, LOCAL)).rejects.toThrow(tr(config.locale, 'provider.invalidPayload'))
      }
      expect(asked(t.send)).toEqual([])
    })

    it('answers { ok: true } when the extension says so, and { ok: false, error } otherwise', async () => {
      const t = provider()
      const done = t.provider.commands!.open(payload, LOCAL)
      t.dev.onMessage(A, { type: 'dev.open.done', id: asked(t.send)[0][1].id, tabId: 7, ok: true })
      expect(await done).toEqual({ ok: true })

      const refused = t.provider.commands!.open(payload, LOCAL)
      t.dev.onMessage(A, { type: 'dev.open.done', id: asked(t.send)[1][1].id, tabId: 7, ok: false })
      expect(await refused).toEqual({ ok: false, error: tr(config.locale, 'companion.devOpenFailed') })
      expect(await t.provider.commands!.open({ ...payload, entryId: 9 }, LOCAL))
        .toEqual({ ok: false, error: tr(config.locale, 'companion.devOpenFailed') })
    })

    it('says to turn Fremdev on while it is off', async () => {
      const off = { ...config, labs: { ...config.labs, fremdev: false } } as Config
      const t = setup({ enabled: () => fremdevEnabled(off) })
      t.dev.connect(A, 'Chrome', OPEN)
      t.tabs(A, [withHistory(7)])
      const p = createDevProvider({ dev: t.dev, config: () => off })
      expect(await p.commands!.open(payload, LOCAL)).toEqual({ ok: false, error: tr(off.locale, 'companion.devDisabled') })
      expect(asked(t.send)).toEqual([])
    })
  })
})

describe('Fremdev reload', () => {
  const config = { ...DEFAULT_CONFIG, labs: { fremdev: true } } as Config
  const RELOAD = ['fremdev', 'fremdev.reload']
  const sentReloads = (send: ReturnType<typeof setup>['send']) => send.mock.calls.filter(([, m]) => m.type === 'dev.reload')

  function two(opts: { enabled?: () => boolean } = {}) {
    const t = setup(opts)
    t.dev.connect(A, 'Chrome', RELOAD)
    t.dev.connect(B, 'Brave', RELOAD)
    t.tabs(A, [row(7)])
    t.tabs(B, [row(7)])
    return t
  }

  it('is one of the features a control depends on', () => {
    expect(FREMDEV_FEATURES).toContain('fremdev.reload')
  })

  it('sends the reload to the install named only', () => {
    const t = two()
    expect(t.dev.reload(A, 7, true)).toBe(true)
    expect(sentReloads(t.send)).toEqual([[A, { type: 'dev.reload', tabId: 7, bypassCache: true }]])
    expect(t.dev.reload(A, 7, false)).toBe(true)
    expect(t.send).toHaveBeenLastCalledWith(A, { type: 'dev.reload', tabId: 7, bypassCache: false })
  })

  it('sends nothing without the module, for an unreported tab, or for an unknown install', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    expect(t.dev.reload(A, 7, false)).toBe(false)
    t.dev.onMessage(A, { type: 'modules', modules: RELOAD })
    t.tabs(A, [row(7)])
    expect(t.dev.reload(A, 8, false)).toBe(false)
    expect(t.dev.reload(B, 7, false)).toBe(false)
    expect(sentReloads(t.send)).toEqual([])
  })

  describe('the reload command', () => {
    const payload = { deviceId: A, tabId: 7, instanceId: 'dev-1', bypassCache: true }
    function provider() {
      const t = two()
      return { ...t, provider: createDevProvider({ dev: t.dev, config: () => config }) }
    }

    it('refuses a caller that is not this Mac', async () => {
      const t = provider()
      await expect(t.provider.commands!.reload(payload, PAIRED)).rejects.toThrow(tr(config.locale, 'provider.localOnly'))
      await expect(t.provider.commands!.reload(payload, undefined)).rejects.toThrow(tr(config.locale, 'provider.localOnly'))
      expect(sentReloads(t.send)).toEqual([])
    })

    it('refuses a bypassCache that is not a boolean, a missing one or an extra key', async () => {
      const t = provider()
      for (const p of [{ ...payload, bypassCache: 'yes' }, { deviceId: A, tabId: 7, instanceId: 'dev-1' }, { ...payload, url: 'x' }]) {
        await expect(t.provider.commands!.reload(p, LOCAL)).rejects.toThrow(tr(config.locale, 'provider.invalidPayload'))
      }
      expect(sentReloads(t.send)).toEqual([])
    })

    it('answers ok, and fails on an unknown tab', async () => {
      const t = provider()
      expect(await t.provider.commands!.reload(payload, LOCAL)).toEqual({ ok: true })
      expect(sentReloads(t.send)).toHaveLength(1)
      expect(await t.provider.commands!.reload({ ...payload, tabId: 9 }, LOCAL)).toEqual({ ok: false, error: tr(config.locale, 'companion.devUnknownTab') })
    })

    it('fails while Fremdev is off, sending nothing', async () => {
      const off = { ...config, labs: { ...config.labs, fremdev: false } } as Config
      const t = two({ enabled: () => false })
      const p = createDevProvider({ dev: t.dev, config: () => off })
      expect(await p.commands!.reload(payload, LOCAL)).toEqual({ ok: false, error: tr(off.locale, 'companion.devDisabled') })
      expect(sentReloads(t.send)).toEqual([])
    })
  })
})
