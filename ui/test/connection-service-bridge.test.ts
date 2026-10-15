// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useWidgetBridge } from '../src/shared/useWidgetBridge'
import type { WidgetManifest } from '../src/shared/types'

const socket = vi.hoisted(() => ({ subscribe: vi.fn(), command: vi.fn() }))
vi.mock('../src/shared/socket', () => ({ useSocket: () => socket }))
let wrapper: VueWrapper | undefined
let frame: HTMLIFrameElement
function load() {
  const selected = ref<Record<string, unknown>>({ account: 'account-a' })
  const manifest = ref<WidgetManifest>({
    id: 'mail-test', name: 'Mail', description: '', version: '1.0.0', icon: 'mail', sdk: 1,
    minSize: [2, 2], defaultSize: [2, 2], subscriptions: ['gmail:*'], commands: ['gmail:*'],
    permissions: { network: [] },
    settingsSchema: { account: { type: 'connection', label: 'Account', connectionType: 'google', connectionService: 'gmail' } },
  })
  const relays = new Map<string, (data: unknown) => void>()
  socket.subscribe.mockImplementation((channel, relay) => { relays.set(channel, relay); return () => { relays.delete(channel) } })
  socket.command.mockResolvedValue('command result')
  frame = document.createElement('iframe'); document.body.appendChild(frame)
  const reply = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  wrapper = mount(defineComponent({ setup() {
    useWidgetBridge(ref(frame), () => ({ instanceId: 'mail-1', widgetId: 'mail-test', x: 0, y: 0, w: 2, h: 2, showTitle: true, settings: selected.value }), () => manifest.value, () => 40)
    return () => h('div')
  } }))
  const send = (type: string, channel: string) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type, channel, name: 'read', id: channel } }))
  return { selected, manifest, relays, reply, send }
}
afterEach(() => { wrapper?.unmount(); frame?.remove(); vi.clearAllMocks(); vi.restoreAllMocks() })

describe('selected service and account authorization', () => {
  it('relays only the selected account and consented service', async () => {
    const { send, relays, reply } = load()
    for (const channel of ['gmail:account-b', 'google-calendar:account-a', 'gmail:account-a']) send('fremkit:subscribe', channel)
    expect([...relays.keys()]).toEqual(['gmail:account-a'])
    relays.get('gmail:account-a')!('mail snapshot')
    expect(reply).toHaveBeenCalledWith({ type: 'fremkit:data', channel: 'gmail:account-a', data: 'mail snapshot' }, '*')
    for (const channel of ['gmail:account-b', 'google-calendar:account-a', 'gmail:account-a']) send('fremkit:command', channel)
    await nextTick()
    expect(socket.command.mock.calls.map((c) => c[0])).toEqual(['gmail:account-a'])
  })

  it('revokes existing relays on account change and refuses late data and command results', async () => {
    const { send, relays, reply, selected } = load()
    send('fremkit:subscribe', 'gmail:account-a')
    const oldRelay = relays.get('gmail:account-a')!
    let resolve!: (value: unknown) => void
    socket.command.mockImplementation(() => new Promise((r) => { resolve = r }))
    send('fremkit:command', 'gmail:account-a')
    selected.value = { account: 'account-b' }
    await nextTick()
    expect(relays.size).toBe(0)
    oldRelay('stale data')
    resolve('stale command')
    await nextTick()
    expect(JSON.stringify(reply.mock.calls)).not.toContain('stale')
    send('fremkit:subscribe', 'gmail:account-b')
    expect([...relays.keys()]).toEqual(['gmail:account-b'])
  })

  it('cannot bypass account selection by removing the service metadata or using a default account', async () => {
    const { manifest, selected, send, relays } = load()
    delete manifest.value.settingsSchema.account.connectionService
    send('fremkit:subscribe', 'gmail:account-a')
    expect(relays.size).toBe(0)
    manifest.value.settingsSchema.account.connectionService = 'gmail'
    manifest.value.settingsSchema.account.default = 'account-a'
    selected.value = {}
    send('fremkit:subscribe', 'gmail:account-a')
    expect(relays.size).toBe(0)
  })

  it('drops a relay when consent is removed and preserves legacy single-provider behavior', async () => {
    const { manifest, send, relays } = load()
    send('fremkit:subscribe', 'gmail:account-a')
    manifest.value.subscriptions = []
    await nextTick()
    expect(relays.size).toBe(0)
    manifest.value.subscriptions = ['calendar:*']
    manifest.value.settingsSchema = { calendars: { type: 'connections', connectionType: 'ics', label: 'Calendars' } }
    send('fremkit:subscribe', 'calendar:ics-a')
    expect([...relays.keys()]).toEqual(['calendar:ics-a'])
  })
})

it('does not revive a revoked relay after selecting the original account again', async () => {
  const { send, relays, reply, selected } = load()
  send('fremkit:subscribe', 'gmail:account-a')
  const oldRelay = relays.get('gmail:account-a')!
  selected.value = { account: 'account-b' }; await nextTick()
  selected.value = { account: 'account-a' }; await nextTick()
  send('fremkit:subscribe', 'gmail:account-a')
  oldRelay('retired data')
  expect(JSON.stringify(reply.mock.calls)).not.toContain('retired data')
})

it('preserves a legacy command response when only display settings change', async () => {
  const { manifest, selected, send, reply } = load()
  manifest.value.commands = ['calendar:*']
  manifest.value.settingsSchema = {
    calendars: { type: 'connections', connectionType: 'ics', label: 'Calendars' },
    color: { type: 'string', label: 'Color' },
  }
  selected.value = { calendars: ['ics-a'], color: 'blue' }
  let resolve!: (value: unknown) => void
  socket.command.mockImplementation(() => new Promise((r) => { resolve = r }))
  send('fremkit:command', 'calendar:ics-a')
  selected.value.color = 'green'
  resolve('valid display result'); await nextTick()
  expect(reply).toHaveBeenCalledWith({ type: 'fremkit:result', id: 'calendar:ics-a', result: 'valid display result' }, '*')
})

it('drops a command result even when the original account is selected again before it resolves', async () => {
  const { send, reply, selected } = load()
  let resolve!: (value: unknown) => void
  socket.command.mockImplementation(() => new Promise((r) => { resolve = r }))
  send('fremkit:command', 'gmail:account-a')
  selected.value.account = 'account-b'
  selected.value.account = 'account-a'
  resolve('retired command result'); await nextTick()
  expect(JSON.stringify(reply.mock.calls)).not.toContain('retired command result')
})
