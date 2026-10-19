/**
 * @vitest-environment jsdom
 *
 * The dashboard on a paired device: the screen the server assigned, followed live, a message when
 * there is none or the device was revoked, and no way into the admin. Local, it is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { Config, Screen } from '../src/shared/types'

const fake = vi.hoisted(() => ({
  subs: new Map<string, Set<(data: unknown) => void>>(),
  config: null as unknown,
}))

vi.mock('../src/shared/socket', async () => {
  const { ref } = await import('vue')
  const socket = {
    status: ref('open'),
    subscribe(channel: string, cb: (data: unknown) => void) {
      let set = fake.subs.get(channel)
      if (!set) { set = new Set(); fake.subs.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    },
    command: async () => undefined,
  }
  return { useSocket: () => socket }
})
vi.mock('../src/shared/api', () => ({
  api: {
    getWidgets: async () => ({ widgets: {} }),
    getConfig: async () => fake.config,
  },
}))
vi.mock('../src/shared/theme', () => ({ useConfigTheme: () => {}, followThemeSchedule: () => () => {} }))

function push(channel: string, data: unknown): void {
  fake.subs.get(channel)?.forEach((cb) => cb(data))
}

function screen(id: string, kind: Screen['kind']): Screen {
  return {
    id, name: id, kind,
    display: { cols: 20, rows: 10, cell: 40, autoCycleSeconds: 0 },
    nav: [],
    pages: [{ id: `${id}-home`, name: 'Home', items: [] }],
  }
}

function config(): Config {
  return {
    version: 4,
    theme: 'fremkit',
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
    widgets: {},
    screens: [screen('edge', 'edge'), screen('pad', 'device')],
  }
}

/** Draws the page's id instead of its widgets: which screen is shown is all these tests ask. */
const PageStub = defineComponent({
  props: { page: { type: Object, required: true } },
  setup: (props) => () => h('div', { class: 'page-stub' }, (props.page as { id: string }).id),
})

/** What `/api/devices/me` answers, and every request the page made. */
function stubFetch(me: { status: number; body?: unknown }) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(String(input))
    if (String(input) === '/api/devices/me') {
      return new Response(me.body === undefined ? null : JSON.stringify(me.body), { status: me.status })
    }
    return new Response('{}', { status: 200 })
  }))
  return calls
}

async function mountApp(href: string) {
  const url = new URL(href)
  vi.stubGlobal('location', { protocol: url.protocol, search: url.search, host: url.host, href: url.href, reload: vi.fn() })
  const { default: App } = await import('../src/dashboard/App.vue')
  const wrapper = mount(App, { global: { stubs: { PageView: PageStub } }, attachTo: document.body })
  await flushPromises()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  vi.resetModules()
  fake.subs.clear()
  fake.config = config()
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the dashboard on a paired device', () => {
  it('shows the screen the server assigned, whatever ?screen= says', async () => {
    stubFetch({ status: 200, body: { id: 'd1', name: 'Kitchen iPad', screenId: 'pad', brightness: null } })
    const wrapper = await mountApp('https://example.local:4243/?screen=edge')
    expect(wrapper.find('.page-stub').text()).toBe('pad-home')
    wrapper.unmount()
  })

  it('follows a push that takes the screen away, and shows the message with the device name', async () => {
    stubFetch({ status: 200, body: { id: 'd1', name: 'Kitchen iPad', screenId: 'pad', brightness: null } })
    const wrapper = await mountApp('https://example.local:4243/')
    expect(wrapper.find('.page-stub').exists()).toBe(true)

    push('device', { id: 'd1', name: 'Kitchen iPad', screenId: null, brightness: null })
    await nextTick()
    expect(wrapper.find('.page-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('Kitchen iPad')
    expect(wrapper.text()).toContain('Choose a screen for this iPad in the Mac’s admin')
    wrapper.unmount()
  })

  it('treats a screen id naming no screen like no screen', async () => {
    stubFetch({ status: 200, body: { id: 'd1', name: 'Kitchen iPad', screenId: 'pad', brightness: null } })
    const wrapper = await mountApp('https://example.local:4243/')
    push('device', { id: 'd1', name: 'Kitchen iPad', screenId: 'deleted', brightness: null })
    await nextTick()
    expect(wrapper.find('.page-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('Choose a screen for this iPad')
    wrapper.unmount()
  })

  it('follows a push to another screen', async () => {
    stubFetch({ status: 200, body: { id: 'd1', name: 'Kitchen iPad', screenId: null, brightness: null } })
    const wrapper = await mountApp('https://example.local:4243/')
    expect(wrapper.find('.page-stub').exists()).toBe(false)
    push('device', { id: 'd1', name: 'Kitchen iPad', screenId: 'edge', brightness: null })
    await nextTick()
    expect(wrapper.find('.page-stub').text()).toBe('edge-home')
    wrapper.unmount()
  })

  it('says the iPad is no longer allowed on a 401', async () => {
    stubFetch({ status: 401 })
    const wrapper = await mountApp('https://example.local:4243/')
    expect(wrapper.text()).toContain('This iPad is no longer allowed')
    expect(wrapper.find('.page-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens no admin from the bar', async () => {
    const calls = stubFetch({ status: 200, body: { id: 'd1', name: 'Kitchen iPad', screenId: 'pad', brightness: null } })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const wrapper = await mountApp('https://example.local:4243/')
    const { default: NavBar } = await import('../src/dashboard/NavBar.vue')
    wrapper.findComponent(NavBar).vm.$emit('admin')
    await flushPromises()
    expect(open).not.toHaveBeenCalled()
    expect(calls).not.toContain('/api/helper/admin')
    wrapper.unmount()
  })
})

describe('the dashboard on the Mac', () => {
  it('honours ?screen= and asks nothing about a device', async () => {
    const calls = stubFetch({ status: 404 })
    const wrapper = await mountApp('http://127.0.0.1:4242/?screen=pad')
    expect(wrapper.find('.page-stub').text()).toBe('pad-home')
    expect(calls).not.toContain('/api/devices/me')
    expect(fake.subs.has('device')).toBe(false)
    wrapper.unmount()
  })

  it('still opens the admin in a new tab', async () => {
    stubFetch({ status: 404 })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const wrapper = await mountApp('http://127.0.0.1:4242/')
    const { default: NavBar } = await import('../src/dashboard/NavBar.vue')
    wrapper.findComponent(NavBar).vm.$emit('admin')
    await flushPromises()
    expect(open).toHaveBeenCalledWith('/admin', '_blank')
    wrapper.unmount()
  })
})
