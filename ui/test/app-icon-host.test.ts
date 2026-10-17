// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
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
function load(subscriptions = ['dock']) {
  frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const reply = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  wrapper = mount(defineComponent({
    setup() {
      useWidgetBridge(ref(frame), () => ({ instanceId: 'n-1', widgetId: 'notifications', x: 0, y: 0, w: 10, h: 10, showTitle: true, settings: {} }),
        () => ({ ...manifest, subscriptions }), () => 40)
      return () => h('div')
    },
  }))
  return reply
}
function request(bundleId: unknown, source: Window | null = frame.contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { source, data: {type: 'fremkit:app-icon', id: 'icon-1', bundleId} }))
}
afterEach(() => { wrapper?.unmount(); frame?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('host application icon requests', () => {
  it('fetches the local PNG for a Dock widget and replies with image data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ok: true, blob: async () => new Blob(['icon'], {type: 'image/png'})})
    vi.stubGlobal('fetch', fetcher)
    const reply = load()
    request('com.apple.mail')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({type: 'fremkit:result', id: 'icon-1', result: 'data:image/png;base64,aWNvbg=='}, '*'))
    expect(fetcher).toHaveBeenCalledWith('/api/apps/icon/com.apple.mail', {cache: 'no-store'})
  })
  it('explains when a local application icon is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false}))
    const reply = load()
    request('com.apple.mail')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({type: 'fremkit:result', id: 'icon-1', error: 'pas d’icône pour cette application'}, '*'))
  })
  it('refuses widgets without a Dock subscription before fetching', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const reply = load([])
    request('com.apple.mail')
    expect(fetcher).not.toHaveBeenCalled()
    expect(reply.mock.calls.at(-1)?.[0]).toMatchObject({type: 'fremkit:result', id: 'icon-1', error: expect.any(String)})
  })
  it('refuses a path and ignores messages outside the widget frame', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const reply = load()
    request('../config')
    expect(reply).toHaveBeenCalledTimes(1)
    request('com.apple.mail', null)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
