/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TileIcon from '../src/shared/TileIcon.vue'
import WidgetFrame from '../src/dashboard/WidgetFrame.vue'
import type { WidgetInstance } from '../src/shared/types'

describe('TileIcon', () => {
  it('draws a choosable pictogram inline', () => {
    const w = mount(TileIcon, { props: { icon: { kind: 'lucide', name: 'server' } } })
    expect(w.find('span.tile-icon.pictogram svg').exists()).toBe(true)
    expect(w.attributes('aria-hidden')).toBe('true')
  })
  it('draws nothing for a pictogram outside the set', () => {
    for (const name of ['trash-2', 'not-a-thing', 'constructor'])
      expect(mount(TileIcon, { props: { icon: { kind: 'lucide', name } } }).find('.tile-icon').exists(), name).toBe(false)
  })
  it('paints a tinted file as a mask of the served file', () => {
    const w = mount(TileIcon, { props: { icon: { kind: 'file', name: '1-nas.svg' } } })
    const el = w.find('span.tile-icon.mask').element as HTMLElement
    expect(el.style.getPropertyValue('--tile-icon-url')).toBe('url("/api/tile-icons/1-nas.svg")')
    expect(w.find('img').exists()).toBe(false)
  })
  it('shows a file in its own colours as an image, and hides it once it fails to load', async () => {
    const w = mount(TileIcon, { props: { icon: { kind: 'file', name: '1-logo.png', tint: false } } })
    const img = w.find('img.tile-icon')
    expect(img.attributes('src')).toBe('/api/tile-icons/1-logo.png')
    expect(img.attributes('alt')).toBe('')
    await img.trigger('error')
    expect(w.find('img').exists()).toBe(false)
  })
  it('tries again when the icon changes after a failure', async () => {
    const w = mount(TileIcon, { props: { icon: { kind: 'file', name: '1-gone.png', tint: false } } })
    await w.find('img').trigger('error')
    await w.setProps({ icon: { kind: 'file', name: '2-new.png', tint: false } })
    expect(w.find('img').attributes('src')).toBe('/api/tile-icons/2-new.png')
  })
})

describe('the icon in the tile title', () => {
  const instance = (extra: Partial<WidgetInstance>): WidgetInstance => ({
    instanceId: 'w-1', widgetId: 'clock', x: 0, y: 0, w: 8, h: 4, showTitle: true, title: 'NAS', settings: {}, ...extra,
  })
  it('sits before the title text', () => {
    const w = mount(WidgetFrame, { props: { instance: instance({ icon: { kind: 'lucide', name: 'server' } }), cell: 40 } })
    const title = w.find('.title')
    expect(title.find('.tile-icon').exists()).toBe(true)
    expect(title.find('.text').text()).toBe('NAS')
    expect(title.element.firstElementChild?.classList.contains('tile-icon')).toBe(true)
  })
  it('is not drawn when the title is hidden, and comes back with it', async () => {
    const w = mount(WidgetFrame, { props: { instance: instance({ showTitle: false, icon: { kind: 'lucide', name: 'server' } }), cell: 40 } })
    expect(w.find('.tile-icon').exists()).toBe(false)
    await w.setProps({ instance: instance({ showTitle: true, icon: { kind: 'lucide', name: 'server' } }) })
    expect(w.find('.title .tile-icon').exists()).toBe(true)
  })
  it('leaves a title without an icon as it was', () => {
    const w = mount(WidgetFrame, { props: { instance: instance({}), cell: 40 } })
    expect(w.find('.title .tile-icon').exists()).toBe(false)
    expect(w.find('.title .text').text()).toBe('NAS')
  })
})
