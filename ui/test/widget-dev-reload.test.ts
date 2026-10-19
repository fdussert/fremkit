/**
 * @vitest-environment jsdom
 *
 * Live reload while a widget is being written: the server names the widgets whose files were
 * saved on the `widget-dev` channel, and every frame showing one of them loads its page again —
 * after the page has the new manifest, when the manifest is what changed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const channels = new Map<string, ((data: unknown) => void)[]>()
vi.mock('../src/shared/socket', () => ({
  useSocket: () => ({
    status: { value: 'open' },
    subscribe: (channel: string, cb: (data: unknown) => void) => {
      channels.set(channel, [...(channels.get(channel) ?? []), cb])
      return () => {}
    },
    command: async () => undefined,
  }),
}))

import WidgetFrame from '../src/dashboard/WidgetFrame.vue'
import { parseReload, WIDGET_DEV_CHANNEL } from '../src/shared/widgetDev'
import type { WidgetInstance, WidgetManifest } from '../src/shared/types'

const instance = (widgetId: string): WidgetInstance => ({
  instanceId: `${widgetId}-1`, widgetId, x: 0, y: 0, w: 8, h: 4, showTitle: false, settings: {},
})
const manifest = (id: string, extra: Partial<WidgetManifest> = {}): WidgetManifest => ({
  id, name: id, version: '1.0.0', minSize: [4, 2], defaultSize: [8, 4], subscriptions: [], commands: [],
  settingsSchema: {}, ...extra,
} as WidgetManifest)

function send(data: unknown) {
  for (const cb of channels.get(WIDGET_DEV_CHANNEL) ?? []) cb(data)
}

/** Counts the navigations the frame is asked for, which is all a reload is. */
function frameOf(wrapper: ReturnType<typeof mount>) {
  const el = wrapper.find('iframe').element as HTMLIFrameElement
  const set = vi.spyOn(el, 'setAttribute')
  return { reloads: () => set.mock.calls.filter(([name]) => name === 'src').length, el }
}

beforeEach(() => { vi.useRealTimers() })

describe('parseReload', () => {
  it('reads the server message and refuses anything else', () => {
    expect(parseReload({ ids: ['a'], manifest: true })).toEqual({ ids: ['a'], manifest: true })
    expect(parseReload({ ids: ['a'] })).toEqual({ ids: ['a'], manifest: false })
    expect(parseReload(null)).toBeNull()
    expect(parseReload({ ids: 'a' })).toBeNull()
    expect(parseReload({ ids: [1] })).toBeNull()
  })
})

describe('a frame whose widget was saved', () => {
  it('reloads when its widget is named, and only then', async () => {
    const wrapper = mount(WidgetFrame, { props: { instance: instance('mine'), manifest: manifest('mine'), cell: 40 }, attachTo: document.body })
    const frame = frameOf(wrapper)
    send({ ids: ['other'], manifest: false })
    expect(frame.reloads()).toBe(0)
    send({ ids: ['mine'], manifest: false })
    expect(frame.reloads()).toBe(1)
    expect(frame.el.getAttribute('src')).toBe('/widgets/mine/index.html')
    wrapper.unmount()
  })

  it('waits for the new manifest before reloading after a manifest change', async () => {
    const wrapper = mount(WidgetFrame, { props: { instance: instance('mine'), manifest: manifest('mine'), cell: 40 }, attachTo: document.body })
    const frame = frameOf(wrapper)
    send({ ids: ['mine'], manifest: true })
    expect(frame.reloads()).toBe(0)
    await wrapper.setProps({ manifest: manifest('mine', { subscriptions: ['system'] }) })
    await nextTick()
    expect(frame.reloads()).toBe(1)
    wrapper.unmount()
  })

  it('reloads anyway when no new manifest comes within a second', async () => {
    vi.useFakeTimers()
    const wrapper = mount(WidgetFrame, { props: { instance: instance('mine'), manifest: manifest('mine'), cell: 40 }, attachTo: document.body })
    const frame = frameOf(wrapper)
    send({ ids: ['mine'], manifest: true })
    vi.advanceTimersByTime(999)
    expect(frame.reloads()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(frame.reloads()).toBe(1)
    wrapper.unmount()
  })

  it('stops listening once unmounted', () => {
    const wrapper = mount(WidgetFrame, { props: { instance: instance('mine'), manifest: manifest('mine'), cell: 40 }, attachTo: document.body })
    const frame = frameOf(wrapper)
    wrapper.unmount()
    send({ ids: ['mine'], manifest: false })
    expect(frame.reloads()).toBe(0)
  })
})
