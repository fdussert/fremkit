// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { useWidgetBridge } from '../src/shared/useWidgetBridge'
import type { WidgetManifest } from '../src/shared/types'

vi.mock('../src/shared/socket', () => ({ useSocket: () => ({ subscribe: vi.fn(), command: vi.fn() }) }))
function manifestOf(id: string): WidgetManifest {
  return JSON.parse(readFileSync(new NodeURL(`../../widgets/${id}/manifest.json`, import.meta.url), 'utf8')) as WidgetManifest
}
let wrapper: VueWrapper | undefined
let frame: HTMLIFrameElement
let hostPort: MessagePort | undefined
const NONCE = '0123456789abcdef0123456789abcdef'
const GIF_URL = 'https://example.com/a.gif'

/** Mounts the host for `widgetId` and plays the frame's half of the handshake (see app-icon-host.test.ts). */
async function load(widgetId: string) {
  const manifest = manifestOf(widgetId)
  frame = document.createElement('iframe')
  frame.setAttribute('src', `/widgets/${widgetId}/index.html`)
  document.body.appendChild(frame)
  const windowPost = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  wrapper = mount(defineComponent({
    setup() {
      useWidgetBridge(ref(frame), () => ({ instanceId: 'g-1', widgetId, x: 0, y: 0, w: 10, h: 10, showTitle: true, settings: {} }),
        () => manifest, () => 40)
      return () => h('div')
    },
  }))
  const reply = vi.fn()
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'fremkit:hello', nonce: NONCE } }))
  const call = windowPost.mock.calls[0] as unknown as [unknown, string, MessagePort[]]
  expect(call[0]).toEqual({ type: 'fremkit:connect' })
  hostPort = call[2][0]
  hostPort.onmessage = (e) => reply(e.data)
  hostPort.postMessage({ type: 'fremkit:hello', nonce: NONCE })
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'fremkit:init' })))
  reply.mockClear()
  return reply
}

afterEach(() => { hostPort?.close(); hostPort = undefined; wrapper?.unmount(); frame?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('host GIF requests', () => {
  it('answers the GIF board with the cached GIF', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['GIF89a'], { type: 'image/gif' }) })
    vi.stubGlobal('fetch', fetcher)
    const reply = await load('gif-board')
    hostPort!.postMessage({ type: 'fremkit:gif', id: 'g1', url: GIF_URL })
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ type: 'fremkit:result', id: 'g1', result: 'data:image/gif;base64,R0lGODlh' }))
    expect(fetcher).toHaveBeenCalledWith(`/api/gifs/cached?url=${encodeURIComponent(GIF_URL)}`)
  })

  it('refuses any other widget before fetching', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const reply = await load('clock')
    hostPort!.postMessage({ type: 'fremkit:gif', id: 'g1', url: GIF_URL })
    await vi.waitFor(() => expect(reply).toHaveBeenCalled())
    expect(fetcher).not.toHaveBeenCalled()
    expect(reply.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'fremkit:result', id: 'g1', error: expect.any(String) })
  })
})
