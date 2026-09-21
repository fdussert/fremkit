/**
 * @vitest-environment jsdom
 *
 * The admin's side of a connection a widget declared.
 *
 * Three states are worth pinning. A form that names what asked for the credential; a settings
 * field that offers to create the right connection rather than sending somebody to a list of
 * nine types; and a connection whose widget is gone, which stays — greyed, and still removable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ConnectionForm from '../src/admin/ConnectionForm.vue'
import ConnectionsInspector from '../src/admin/ConnectionsInspector.vue'
import { useConnectionsStore } from '../src/admin/connections'
import { useAdminStore } from '../src/admin/store'
import { useMarketplaceStore } from '../src/admin/marketplace'
import type { ConnectionSummary, ConnectionTypeInfo, WidgetManifest } from '../src/shared/types'

const DECL_TYPE: ConnectionTypeInfo = {
  id: 'decl:homey-flows:homey-flows',
  name: 'Homey Flows',
  description: 'Settings → API keys → create one with Flow read and control.',
  icon: 'plug',
  declaredBy: 'homey-flows',
  secretBindings: ['host'],
  fields: [
    { key: 'host', label: 'Address' },
    { key: 'token', label: 'API key', secret: true },
  ],
}

/** The second Homey widget: a different type id, the same shape, so one key serves both. */
const DEVICES_TYPE: ConnectionTypeInfo = {
  id: 'decl:homey-devices:homey-devices',
  name: 'Homey (devices)',
  description: 'Settings → API keys → create one with Devices read and control.',
  icon: 'plug',
  declaredBy: 'homey-devices',
  secretBindings: ['host'],
  fields: [
    { key: 'host', label: 'Address' },
    { key: 'token', label: 'API key', secret: true },
  ],
}

const CODED_TYPE: ConnectionTypeInfo = {
  id: 'github', name: 'GitHub', description: 'A personal access token.', icon: 'github',
  secretBindings: ['host'], fields: [{ key: 'token', label: 'Token', secret: true }],
}

const MANIFEST = {
  id: 'homey-flows', name: { fr: 'Flows Homey', en: 'Homey flows' }, version: '2.0.0', sdk: 1,
  description: '', icon: 'play', minSize: [8, 4], defaultSize: [8, 4],
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
} as unknown as WidgetManifest

const DEVICES_MANIFEST = {
  id: 'homey-devices', name: { fr: 'Appareils Homey', en: 'Homey devices' }, version: '2.0.0', sdk: 1,
  description: '', icon: 'layout-grid', minSize: [8, 4], defaultSize: [24, 8],
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
} as unknown as WidgetManifest

function seed(types: ConnectionTypeInfo[], connections: ConnectionSummary[] = []): void {
  const s = useConnectionsStore()
  s.state.types = types
  s.state.connections = connections
  s.state.loaded = true
  s.state.error = ''
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request expected') }))
  useAdminStore().state.manifests = { 'homey-flows': MANIFEST }
})

afterEach(() => {
  useMarketplaceStore().state.leftover = null
  const s = useConnectionsStore()
  s.state.types = []
  s.state.connections = []
  s.state.loaded = false
  const admin = useAdminStore()
  admin.state.manifests = {}
  admin.state.newConnectionType = ''
  admin.closeModal()
  vi.unstubAllGlobals()
})

describe('the form for a declared type', () => {
  const form = (type: ConnectionTypeInfo) =>
    mount(ConnectionForm, { attachTo: document.body, props: { type, connection: null, id: 'x1' } })

  it('names the widget that asked for the credential, by its own name', () => {
    seed([DECL_TYPE])
    const wrapper = form(DECL_TYPE)
    const said = wrapper.find('.declared').text()
    expect(said).toMatch(/Flows Homey|Homey flows/)
    wrapper.unmount()
  })

  it('names every widget the same connection would serve, not only the one that declared it', () => {
    // Both Homey widgets declare the same shape, so the admin offers each of them the other's
    // connection. A form that named one of them is how somebody ends up making a second API key
    // — and a Homey invalidates the previous one when a new one is issued.
    useAdminStore().state.manifests = { 'homey-flows': MANIFEST, 'homey-devices': DEVICES_MANIFEST }
    seed([DECL_TYPE, DEVICES_TYPE])
    const wrapper = form(DECL_TYPE)
    const said = wrapper.find('.declared').text()
    expect(said).toMatch(/Flows Homey|Homey flows/)
    expect(said).toMatch(/Appareils Homey|Homey devices/)
    wrapper.unmount()
  })

  it('names only its own widget when nothing else declares that shape', () => {
    useAdminStore().state.manifests = { 'homey-flows': MANIFEST, 'homey-devices': DEVICES_MANIFEST }
    seed([DECL_TYPE, { ...DEVICES_TYPE, fields: [{ key: 'host', label: 'Address' }, { key: 'apiKey', label: 'Key', secret: true }] }])
    const said = form(DECL_TYPE).find('.declared').text()
    expect(said).not.toMatch(/Appareils Homey|Homey devices/)
  })

  it('shows the author’s setup instructions above the fields, as text', () => {
    seed([DECL_TYPE])
    const wrapper = form(DECL_TYPE)
    expect(wrapper.find('.hint').text()).toContain('API keys')
    wrapper.unmount()
  })

  it('says nothing of the sort for a type the core has code for', () => {
    seed([CODED_TYPE])
    const wrapper = form(CODED_TYPE)
    expect(wrapper.find('.declared').exists()).toBe(false)
    wrapper.unmount()
  })

  it('falls back to the widget id when that widget is no longer installed', () => {
    // Still better than nothing: the id is what somebody would search the registry for.
    useAdminStore().state.manifests = {}
    seed([DECL_TYPE])
    const wrapper = form(DECL_TYPE)
    expect(wrapper.find('.declared').text()).toContain('homey-flows')
    wrapper.unmount()
  })
})

describe('the list of connections', () => {
  const connection = (type: string): ConnectionSummary =>
    ({ id: 'homey-x1', type, name: 'Homey', fields: { host: '192.168.1.40' }, secrets: { token: true } })

  it('greys a connection whose declaring widget is gone, and says why', async () => {
    // Uninstalling takes the type away and leaves the credential: reinstalling finds it where it
    // was, and deleting somebody's API key for them is not this code's decision.
    seed([CODED_TYPE], [connection('decl:homey-flows:homey-flows')])
    const wrapper = mount(ConnectionsInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    const row = wrapper.find('[data-connection="homey-x1"]')
    expect(row.classes()).toContain('orphan')
    expect(row.text()).toMatch(/n’est plus install|no longer installed/)
    wrapper.unmount()
  })

  it('leaves a live one alone', async () => {
    seed([DECL_TYPE], [connection(DECL_TYPE.id)])
    const wrapper = mount(ConnectionsInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    const row = wrapper.find('[data-connection="homey-x1"]')
    expect(row.classes()).not.toContain('orphan')
    expect(row.text()).toContain('Homey Flows')
    wrapper.unmount()
  })

  it('opens straight onto a new connection when the admin asked for that type', async () => {
    seed([DECL_TYPE])
    useAdminStore().openNewConnection(DECL_TYPE.id)
    const wrapper = mount(ConnectionsInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // The form, not the list: the point is not having to find the right type among nine.
    expect(wrapper.find('form.form').exists()).toBe(true)
    expect(wrapper.find('.declared').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ignores a request to open on a type that does not exist', async () => {
    seed([CODED_TYPE])
    useAdminStore().openNewConnection('decl:gone:gone')
    const wrapper = mount(ConnectionsInspector, { attachTo: document.body })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('form.form').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('what an uninstall leaves behind', () => {
  const answer = (connections: { id: string; name: string }[]) => ({
    registry: 'r', generatedAt: null, widgets: [], themes: [], offline: false, sdk: 1, connections,
  })

  /** A server that removes the widget and names the connections its type owned. */
  function serveUninstall(connections: { id: string; name: string }[]): { deleted: string[] } {
    const deleted: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/marketplace/uninstall') {
        return new Response(JSON.stringify({ ok: true, id: 'homey-flows', connections }),
          { headers: { 'content-type': 'application/json' } })
      }
      if (url.startsWith('/api/connections/') && init?.method === 'DELETE') {
        deleted.push(url.slice('/api/connections/'.length))
        return new Response(null, { status: 204 })
      }
      const body = url === '/api/marketplace' ? answer([])
        : url === '/api/widgets' ? { widgets: {}, errors: [], sources: {}, asks: {} }
        : url.startsWith('/api/themes') ? { themes: {}, errors: [] }
        : url === '/api/connections' ? [] : url === '/api/connections/types' ? [] : {}
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))
    return { deleted }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0))
  }

  it('asks about them, and deletes only what was ticked', async () => {
    const { deleted } = serveUninstall([
      { id: 'homey-x1', name: 'Homey Pro' },
      { id: 'homey-x2', name: 'Homey du garage' },
    ])
    const m = useMarketplaceStore()
    await m.uninstall('homey-flows')
    await settle()

    expect(m.state.leftover?.connections.map((c) => c.name)).toEqual(['Homey Pro', 'Homey du garage'])
    // Off by default: the widget is gone either way, and a credential is not deleted by a
    // decision about a widget.
    expect(m.state.leftover?.connections.every((c) => !c.remove)).toBe(true)

    m.state.leftover!.connections[1].remove = true
    await m.applyLeftover()
    await settle()
    expect(deleted).toEqual(['homey-x2'])
    expect(m.state.leftover).toBeNull()
  })

  it('keeps every one when the prompt is dismissed', async () => {
    const { deleted } = serveUninstall([{ id: 'homey-x1', name: 'Homey Pro' }])
    const m = useMarketplaceStore()
    await m.uninstall('homey-flows')
    await settle()
    m.state.leftover!.connections[0].remove = true
    m.dismissLeftover()
    await settle()
    expect(deleted).toEqual([])
    expect(m.state.leftover).toBeNull()
  })

  it('asks nothing when the widget owned no connection', async () => {
    serveUninstall([])
    const m = useMarketplaceStore()
    await m.uninstall('clock')
    await settle()
    expect(m.state.leftover).toBeNull()
  })
})
