// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { useWidgetBridge } from '../src/shared/useWidgetBridge'
import type { WidgetManifest } from '../src/shared/types'

vi.mock('../src/shared/socket', () => ({ useSocket: () => ({ subscribe: vi.fn(), command: vi.fn() }) }))
const manifest = JSON.parse(readFileSync(new NodeURL('../../widgets/notifications/manifest.json', import.meta.url), 'utf8')) as WidgetManifest
let wrapper: VueWrapper | undefined
let frame: HTMLIFrameElement
let hostPort: MessagePort | undefined
const NONCE = '0123456789abcdef0123456789abcdef'

/**
 * Mounts the host side and plays the frame's half of the handshake: the hello on the window,
 * then the same nonce on the port the host hands back. `reply` collects what the host then says
 * on that port, the only place it speaks.
 */
async function load(subscriptions = ['dock'], settings: Record<string, unknown> = {}, schema: WidgetManifest['settingsSchema'] = manifest.settingsSchema) {
  frame = document.createElement('iframe')
  frame.setAttribute('src', '/widgets/notifications/index.html')
  document.body.appendChild(frame)
  const windowPost = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  wrapper = mount(defineComponent({
    setup() {
      useWidgetBridge(ref(frame), () => ({ instanceId: 'n-1', widgetId: 'notifications', x: 0, y: 0, w: 10, h: 10, showTitle: true, settings }),
        () => ({ ...manifest, subscriptions, settingsSchema: schema }), () => 40)
      return () => h('div')
    },
  }))
  const reply = vi.fn()
  hostPort = await hello(windowPost, NONCE, reply)
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'fremkit:init' })))
  reply.mockClear()
  return reply
}

async function hello(windowPost: ReturnType<typeof vi.spyOn>, nonce: string, reply: (m: unknown) => void, sayNonce = nonce): Promise<MessagePort> {
  const before = windowPost.mock.calls.length
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'fremkit:hello', nonce } }))
  const call = windowPost.mock.calls[before] as unknown as [unknown, string, MessagePort[]]
  expect(call[0]).toEqual({ type: 'fremkit:connect' })
  const port = call[2][0]
  port.onmessage = (e) => reply(e.data)
  port.postMessage({ type: 'fremkit:hello', nonce: sayNonce })
  return port
}

function request(bundleId: unknown) {
  hostPort!.postMessage({ type: 'fremkit:app-icon', id: 'icon-1', bundleId })
}
afterEach(() => { hostPort?.close(); hostPort = undefined; wrapper?.unmount(); frame?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('host application icon requests', () => {
  it('fetches the local PNG for a Dock widget and replies with image data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ok: true, blob: async () => new Blob(['icon'], {type: 'image/png'})})
    vi.stubGlobal('fetch', fetcher)
    const reply = await load()
    request('com.apple.mail')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({type: 'fremkit:result', id: 'icon-1', result: 'data:image/png;base64,aWNvbg=='}))
    expect(fetcher).toHaveBeenCalledWith('/api/apps/icon/com.apple.mail', {cache: 'no-store'})
  })
  it('explains when a local application icon is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false}))
    const reply = await load()
    request('com.apple.mail')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({type: 'fremkit:result', id: 'icon-1', error: 'pas d’icône pour cette application'}))
  })
  it('refuses widgets without a Dock subscription before fetching', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const reply = await load([])
    request('com.apple.mail')
    await vi.waitFor(() => expect(reply).toHaveBeenCalled())
    expect(fetcher).not.toHaveBeenCalled()
    expect(reply.mock.calls.at(-1)?.[0]).toMatchObject({type: 'fremkit:result', id: 'icon-1', error: expect.any(String)})
  })
  it('refuses a path, and a request posted on the window rather than the port', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const reply = await load()
    request('../config')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'fremkit:app-icon', id: 'icon-2', bundleId: 'com.apple.mail' } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(reply).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('the conversation with a frame (I3)', () => {
  it('stops answering the moment the same frame says hello again: a new document', async () => {
    const reply = await load()
    const windowPost = vi.mocked(frame.contentWindow!.postMessage)
    const calls = windowPost.mock.calls.length
    // The document that replaced it says hello: no port for it, and the old one is closed.
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'fremkit:hello', nonce: 'fedcba9876543210fedcba9876543210' } }))
    expect(windowPost.mock.calls.length).toBe(calls)
    request('com.apple.mail')
    await new Promise((r) => setTimeout(r, 20))
    expect(reply).not.toHaveBeenCalled()
  })
  it('says nothing on a port whose holder cannot repeat the nonce', async () => {
    frame = document.createElement('iframe')
    frame.setAttribute('src', '/widgets/notifications/index.html')
    document.body.appendChild(frame)
    const windowPost = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    wrapper = mount(defineComponent({
      setup() {
        useWidgetBridge(ref(frame), () => ({ instanceId: 'n-1', widgetId: 'notifications', x: 0, y: 0, w: 10, h: 10, showTitle: true, settings: { secret: 'x' } }),
          () => ({ ...manifest, subscriptions: ['dock'] }), () => 40)
        return () => h('div')
      },
    }))
    const reply = vi.fn()
    hostPort = await hello(windowPost, NONCE, reply, 'fedcba9876543210fedcba9876543210')
    await new Promise((r) => setTimeout(r, 20))
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('Fremkit.image (I4)', () => {
  const schema = { icon: { type: 'string', label: 'Icon', default: 'https://beacon.example.com/default.png' } } as WidgetManifest['settingsSchema']
  it('fetches an address the user typed, never one the manifest wrote as a default', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['i'], { type: 'image/png' }) })
    vi.stubGlobal('fetch', fetcher)
    const reply = await load(['dock'], {}, schema)
    hostPort!.postMessage({ type: 'fremkit:image', id: 'i-1', url: 'https://beacon.example.com/default.png' })
    await vi.waitFor(() => expect(reply).toHaveBeenCalled())
    expect(reply.mock.calls[0][0]).toMatchObject({ id: 'i-1', error: expect.any(String) })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('still fetches the same address once the user has typed it', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['i'], { type: 'image/png' }) })
    vi.stubGlobal('fetch', fetcher)
    const reply = await load(['dock'], { icon: 'https://cdn.example.com/mine.png' }, schema)
    hostPort!.postMessage({ type: 'fremkit:image', id: 'i-2', url: 'https://cdn.example.com/mine.png' })
    await vi.waitFor(() => expect(reply).toHaveBeenCalled())
    expect(fetcher).toHaveBeenCalledWith('/api/favicon?image=' + encodeURIComponent('https://cdn.example.com/mine.png'))
  })
})
