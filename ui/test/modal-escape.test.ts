// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import BaseModal from '../src/shared/ui/BaseModal.vue'

let wrapper: VueWrapper | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })

function escapeFrom(target: Element): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

describe('BaseModal and Escape', () => {
  it('closes on an Escape pressed in the dialog', () => {
    wrapper = mount(BaseModal, { props: { title: 'Screen' }, attachTo: document.body })
    escapeFrom(wrapper.element.querySelector('.panel')!)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('stays open when the Escape belongs to a layer above it', () => {
    wrapper = mount(BaseModal, { props: { title: 'Screen' }, attachTo: document.body })
    const layer = document.createElement('div')
    layer.setAttribute('data-overlay', '')
    const field = layer.appendChild(document.createElement('input'))
    document.body.appendChild(layer)
    escapeFrom(field)
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
