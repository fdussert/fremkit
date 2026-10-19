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
    errors: { total, open: total, last: { text: `TypeError #${total}`, at: 1_000 } },
    requests: { total: 0, open: 0, last: null },
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
      installs: [{ deviceId: A, name: 'Chrome', on: true, connected: true, tabs: [row(7)] }],
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
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, tabs: [] }])
    // Turned on, it reports; turned off again, its rows go.
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev'] })
    t.tabs(A, [row(7)])
    expect(t.dev.snapshot().installs[0]).toMatchObject({ on: true, tabs: [row(7)] })
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay'] })
    expect(t.dev.snapshot().installs).toEqual([{ deviceId: A, name: 'Chrome', on: false, connected: true, tabs: [] }])
  })

  it('keeps an install listed when it disconnects, with no rows: the extension\'s idle state', () => {
    const t = setup()
    t.dev.connect(A, 'Chrome', ['fremdev'])
    t.tabs(A, [row(7)])
    t.changed.mockClear()
    t.dev.disconnect(A)
    const idle = { deviceId: A, name: 'Chrome', on: true, connected: false, tabs: [] }
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
      { deviceId: A, name: 'Chrome', on: true, connected: true, tabs: [row(7)] },
      { deviceId: B, name: 'Brave', on: true, connected: true, tabs: [row(9), row(10)] },
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
