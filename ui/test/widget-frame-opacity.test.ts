/**
 * @vitest-environment jsdom
 *
 * The tile's opacity is what the editor's "show the background" checkbox writes, so everything
 * the tile paints under the widget has to answer to it. The surface and the border always did;
 * the instance's own image did not, and a tile with an image kept showing it while the control
 * said the background was off.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WidgetFrame from '../src/dashboard/WidgetFrame.vue'
import type { WidgetInstance } from '../src/shared/types'

const instance = (extra: Partial<WidgetInstance>): WidgetInstance => ({
  instanceId: 'w-1', widgetId: 'clock', x: 0, y: 0, w: 8, h: 4, showTitle: false, settings: {}, ...extra,
})

function image(extra: Partial<WidgetInstance>): CSSStyleDeclaration {
  const wrapper = mount(WidgetFrame, {
    props: { instance: instance({ background: { image: 'wall.png' }, ...extra }), cell: 40 },
    attachTo: document.body,
  })
  const el = wrapper.find('.image').element as HTMLElement
  return el.style
}

describe('the tile image and the tile opacity', () => {
  it('paints the image solid when the instance carries no opacity', () => {
    expect(image({}).opacity).toBe('1')
  })

  it('fades the image with the tile', () => {
    expect(image({ opacity: 0.4 }).opacity).toBe('0.4')
  })

  it('hides it entirely at 0, which is what the checkbox writes', () => {
    expect(image({ opacity: 0 }).opacity).toBe('0')
  })
})
