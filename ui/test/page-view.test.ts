/**
 * @vitest-environment jsdom
 *
 * A page stores placements only; the widget a placement shows, its settings and its look are the
 * config's shared entry. The page has to join the two, so one widget placed on two screens is the
 * same widget on both.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PageView from '../src/dashboard/PageView.vue'
import type { Config, Page } from '../src/shared/types'

const config = {
  version: 4,
  connections: [], secrets: { backend: 'file' }, locale: 'en',
  privacy: { claudeAccountUsage: false, showAccountEmail: false, codexAccount: false, codexHistorySources: [], macmonTemperature: false },
  widgets: {
    'clock-1': { widgetId: 'clock', showTitle: false, settings: {} },
    'weather-1': { widgetId: 'weather', showTitle: true, settings: {} },
  },
  screens: [],
} as unknown as Config

const page: Page = {
  id: 'home', name: 'Home',
  items: [
    { instanceId: 'clock-1', x: 0, y: 0, w: 8, h: 4 },
    { instanceId: 'weather-1', x: 10, y: 2, w: 12, h: 6 },
  ],
}

describe('PageView', () => {
  it('draws one tile per placement, with the widget it names, where it is placed', () => {
    const wrapper = mount(PageView, {
      props: { page, config, display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }, manifests: {} },
    })
    const tiles = wrapper.findAll('.missing')
    expect(tiles.map((t) => t.text())).toEqual([expect.stringContaining('clock'), expect.stringContaining('weather')])
    const weather = wrapper.findAll('.frame')[1].element as HTMLElement
    expect([weather.style.left, weather.style.top, weather.style.width]).toEqual(['400px', '80px', '480px'])
    // The title is the shared widget's setting, not the placement's.
    expect(wrapper.findAll('.title')).toHaveLength(1)
    expect((wrapper.find('.page').element as HTMLElement).style.height).toBe('640px')
    wrapper.unmount()
  })
  it('paints the background unless the dashboard, which paints it once behind everything, says not to', () => {
    const display = { cols: 34, rows: 23, cell: 40, autoCycleSeconds: 0, background: { color: '#101820' } }
    const style = (paintBackground?: boolean) => {
      const wrapper = mount(PageView, { props: { page, config, display, manifests: {}, ...(paintBackground === undefined ? {} : { paintBackground }) } })
      const color = (wrapper.find('.page').element as HTMLElement).style.backgroundColor
      wrapper.unmount()
      return color
    }
    expect(style()).toBe('rgb(16, 24, 32)')
    expect(style(false)).toBe('')
  })
})
