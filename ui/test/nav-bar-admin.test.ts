/**
 * @vitest-environment jsdom
 *
 * What the bar *does* with the events, rather than what its source says.
 *
 * Four paths open the admin, because each is the only real one somewhere: the right button for the
 * helper's web view, `contextmenu` for a mouse, the taps counted in the page for the panel,
 * `dblclick` for a browser that does synthesise one. The question no reading of the source answers
 * is what happens where two of them are real *at the same time* — a desktop browser, the Chrome
 * kiosk — and the answer used to be two admin windows for one press.
 *
 * So the bar is mounted and the events are dispatched as the real ones arrive, in order.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NavBar from '../src/dashboard/NavBar.vue'
import type { AdminGesture } from '../src/shared/types'

const PAGES = [
  { id: 'home', name: 'Accueil', widgets: [] },
  { id: 'work', name: 'Travail', widgets: [] },
]

function bar(adminGesture?: AdminGesture) {
  const wrapper = mount(NavBar, {
    props: { pages: PAGES, active: 0, height: 64, ...(adminGesture ? { adminGesture } : {}) },
    attachTo: document.body,
  })
  const dots = wrapper.find('.dots').element
  /** A pointer event as the page receives it: jsdom has no PointerEvent, and none of this reads one. */
  const down = (button = 0, x = 100, y = 30): void => {
    dots.dispatchEvent(new MouseEvent('pointerdown', { button, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }
  const fire = (type: string): void => {
    dots.dispatchEvent(new MouseEvent(type, { clientX: 100, clientY: 30, bubbles: true, cancelable: true }))
  }
  const admins = (): number => wrapper.emitted('admin')?.length ?? 0
  return { wrapper, down, fire, admins }
}

describe('the dots open the admin once per gesture', () => {
  it('counts a right click as one, not as a button and a context menu', () => {
    // Both arrive in a browser: the button event this listens for because the helper's web view
    // delivers nothing else, then WebKit's own `contextmenu`. One press, one window.
    const { wrapper, down, fire, admins } = bar()
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('counts a double tap as one, not as two taps and a double click', () => {
    const { wrapper, down, fire, admins } = bar()
    down(0)
    down(0)
    fire('dblclick')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('opens nothing on a single tap', () => {
    const { wrapper, down, fire, admins } = bar()
    down(0)
    fire('pointerup')
    expect(admins()).toBe(0)
    wrapper.unmount()
  })

  it('opens nothing on two taps far enough apart to be two taps', () => {
    const { wrapper, down, admins } = bar()
    down(0, 100, 30)
    // Past DOUBLE_TAP_SLOP: two different dots, two separate taps.
    down(0, 400, 30)
    expect(admins()).toBe(0)
    wrapper.unmount()
  })
})

describe('the setting decides which gesture is listened to', () => {
  it('ignores the double tap when the setting is the long press', () => {
    const { wrapper, down, fire, admins } = bar('longPress')
    down(0)
    down(0)
    fire('dblclick')
    expect(admins()).toBe(0)
    // The long press still works, and still only once.
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(1)
    wrapper.unmount()
  })

  it('ignores the long press when the setting is the double tap', () => {
    const { wrapper, down, fire, admins } = bar('doubleTap')
    down(2)
    fire('contextmenu')
    expect(admins()).toBe(0)
    down(0)
    down(0)
    expect(admins()).toBe(1)
    wrapper.unmount()
  })
})
