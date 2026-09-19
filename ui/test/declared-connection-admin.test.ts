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

const CODED_TYPE: ConnectionTypeInfo = {
  id: 'github', name: 'GitHub', description: 'A personal access token.', icon: 'github',
  secretBindings: ['host'], fields: [{ key: 'token', label: 'Token', secret: true }],
}

const MANIFEST = {
  id: 'homey-flows', name: { fr: 'Flows Homey', en: 'Homey flows' }, version: '2.0.0', sdk: 1,
  description: '', icon: 'play', minSize: [8, 4], defaultSize: [8, 4],
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
