/**
 * @vitest-environment jsdom
 *
 * The Connection block of the consent dialog.
 *
 * A declared connection is the one permission that costs the user a credential, and the only one
 * that is not a list of channel names. What the dialog has to say is therefore in words: which
 * service, which field of theirs, how it will be carried, to a host **they** enter, and for
 * exactly which requests. This asserts the dialog says all five.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ConsentDialog from '../src/admin/ConsentDialog.vue'
import UpdateAllDialog from '../src/admin/UpdateAllDialog.vue'
import type { ConnectionDecl, MarketplaceWidget, WidgetPermissionSet } from '../src/shared/types'

const NONE: WidgetPermissionSet = { subscriptions: [], commands: [], network: [] }

const decl = (over: Partial<ConnectionDecl> = {}): ConnectionDecl => ({
  name: 'Homey Flows',
  kind: 'http-bearer',
  scheme: 'https',
  fields: [
    { key: 'host', label: { fr: 'Adresse', en: 'Address' } },
    { key: 'token', label: { fr: 'Clé API', en: 'API key' }, secret: true },
  ],
  requests: [
    { method: 'GET', path: '/api/manager/flow/flow' },
    { method: 'POST', path: '/api/manager/flow/flow/*/trigger' },
  ],
  ...over,
})

function widget(): MarketplaceWidget {
  return {
    id: 'homey-flows', version: '2.0.0', sdk: 1, category: 'home',
    name: { fr: 'Flows Homey', en: 'Homey flows' }, description: { fr: 'd', en: 'd' },
    icon: 'play', permissions: NONE, connections: [], size: 9000,
    publishedAt: '2026-09-19T08:00:00.000Z',
    installed: false, installedVersion: null, updateAvailable: false,
    sdkTooNew: false, consentNeeded: true, newPermissions: NONE,
    shadowsBuiltin: false, placedOn: [],
  }
}

const open = (over: Partial<{ added: WidgetPermissionSet; all: WidgetPermissionSet; update: boolean }> = {}) =>
  mount(ConsentDialog, {
    attachTo: document.body,
    props: {
      prompt: {
        widget: widget(), update: false,
        added: { ...NONE, connection: decl() },
        all: { ...NONE, connection: decl() },
        send: { ...NONE, connection: decl() },
        ...over,
      } as never,
    },
  })

describe('what the dialog says about a declared connection', () => {
  it('names the service, the field, how it is carried and every request', () => {
    const wrapper = open()
    const block = wrapper.find('.conn')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('Homey Flows')
    // The user's own word for the credential, not the manifest's key.
    expect(block.text()).toMatch(/Clé API|API key/)
    expect(block.text()).toContain('Authorization: Bearer')
    const requests = block.findAll('code').map((c) => c.text())
    expect(requests).toEqual(['GET /api/manager/flow/flow', 'POST /api/manager/flow/flow/*/trigger'])
    wrapper.unmount()
  })

  it('says the host is one the user will enter, not one the widget named', () => {
    // There is no host yet, and that is the point: the credential goes where they type.
    const wrapper = open()
    expect(wrapper.find('.conn').text()).toMatch(/admin/)
    wrapper.unmount()
  })

  it('names each kind the way somebody would recognise it', () => {
    for (const [d, expected] of [
      [decl({ kind: 'http-basic' }), 'Authorization: Basic'],
      [decl({ kind: 'api-key-header', headerName: 'X-API-Key' }), 'X-API-Key'],
      [decl({ kind: 'api-key-query', queryName: 'apikey' }), '?apikey='],
    ] as [ConnectionDecl, string][]) {
      const wrapper = open({ added: { ...NONE, connection: d }, all: { ...NONE, connection: d } })
      expect(wrapper.find('.conn').text(), expected).toContain(expected)
      wrapper.unmount()
    }
  })

  it('says there is no credential when the kind has none', () => {
    const host = decl({ kind: 'host', fields: [{ key: 'host', label: 'Address' }] })
    const wrapper = open({ added: { ...NONE, connection: host }, all: { ...NONE, connection: host } })
    expect(wrapper.find('.conn').text()).toMatch(/Aucun identifiant|No credential/)
    wrapper.unmount()
  })

  it('warns when the declaration asks for plain HTTP', () => {
    const http = decl({ scheme: 'http' })
    const wrapper = open({ added: { ...NONE, connection: http }, all: { ...NONE, connection: http } })
    expect(wrapper.find('.conn .warn').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders the author’s hint as text and nothing else', () => {
    // A manifest from the network, in a dialog about whether to trust it.
    const hinted = decl({ hint: 'Settings → API\n<script>alert(1)</script>' })
    const wrapper = open({ added: { ...NONE, connection: hinted }, all: { ...NONE, connection: hinted } })
    const hint = wrapper.find('.conn .hint')
    expect(hint.text()).toContain('Settings')
    expect(hint.element.querySelector('script')).toBeNull()
    expect(wrapper.html()).not.toContain('<script>alert(1)</script>')
    wrapper.unmount()
  })

  it('shows an unchanged declaration as context rather than as a new ask', () => {
    const wrapper = open({ update: true, added: NONE, all: { ...NONE, connection: decl() } })
    expect(wrapper.find('.conn').classes()).toContain('dim')
    wrapper.unmount()
  })

  it('says nothing at all when the widget declares none', () => {
    const wrapper = open({ added: NONE, all: NONE })
    expect(wrapper.find('.conn').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('the bulk dialog', () => {
  const entry = (added: Partial<WidgetPermissionSet>) => ({ widget: widget(), added: { ...NONE, ...added } })

  it('renders the connection block for a widget whose declaration changed', async () => {
    // This is where a changed declaration would slip through: "update all" and "install the
    // missing ones" build their list from `newPermissions` and one dialog covers the series.
    const wrapper = mount(UpdateAllDialog, {
      attachTo: document.body,
      props: { entries: [entry({ connection: decl() })] } as never,
    })
    await wrapper.vm.$nextTick()
    const block = wrapper.find('.conn')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('Homey Flows')
    expect(block.text()).toContain('Authorization: Bearer')
    expect(block.findAll('code').map((c) => c.text()))
      .toEqual(['GET /api/manager/flow/flow', 'POST /api/manager/flow/flow/*/trigger'])
    wrapper.unmount()
  })

  it('warns about plain HTTP there too', async () => {
    const wrapper = mount(UpdateAllDialog, {
      attachTo: document.body,
      props: { entries: [entry({ connection: decl({ scheme: 'http' }) })] } as never,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.conn .warn').exists()).toBe(true)
    wrapper.unmount()
  })

  it('does not call a widget with a new declaration "no new permission"', async () => {
    const wrapper = mount(UpdateAllDialog, {
      attachTo: document.body,
      props: { entries: [entry({ connection: decl() })] } as never,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.none').exists()).toBe(false)
    wrapper.unmount()
  })

  it('still says so for one that really asks for nothing new', async () => {
    const wrapper = mount(UpdateAllDialog, { attachTo: document.body, props: { entries: [entry({})] } as never })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.none').exists()).toBe(true)
    expect(wrapper.find('.conn').exists()).toBe(false)
    wrapper.unmount()
  })
})
