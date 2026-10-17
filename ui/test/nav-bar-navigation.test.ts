/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import NavBar from '../src/dashboard/NavBar.vue'
import type { AdminGesture } from '../src/shared/types'
const pages = ['Home', 'Agents', 'Google', 'Slack', 'Media'].map((name, i) => ({ id: String(i), name, widgets: [] }))
let wrapper: VueWrapper
let clock = 10000
function bar(adminGesture: AdminGesture = 'longPress') {
  wrapper = mount(NavBar, { props: { pages, active: 2, height: 80, navStyle: 'names', adminGesture }, attachTo: document.body })
  return wrapper.findAll('.page-button')
}
function pointer(el: Element | Window, type: string, x = 100, button = 0) {
  el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 30, button, bubbles: true, cancelable: true }))
}
function selections() { return wrapper.emitted('select') ?? [] }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockReturnValue(clock += 2000)
  let eventClock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => ++eventClock)
})

afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('named dashboard navigation', () => {
  it('renders configured names with an accessible current page', () => {
    const buttons = bar()
    expect(buttons.map(b => b.text())).toEqual(['Home', 'Agents', 'Google', 'Slack', 'Media'])
    expect(buttons[2]!.attributes('aria-current')).toBe('page')
    expect(buttons[1]!.attributes('aria-current')).toBeUndefined()
  })

  it('keeps dots as the default and a single-page admin target', () => {
    wrapper = mount(NavBar, { props: { pages: pages.slice(0, 1), active: 0, height: 80 }, attachTo: document.body })
    expect(wrapper.find('nav').classes()).not.toContain('named')
    expect(wrapper.findAll('.page-button')).toHaveLength(1)
    expect(wrapper.find('.page-button').text()).toBe('')
    expect(wrapper.find('.page-button').attributes('aria-label')).toBe('Home')
  })

  it('selects a page once on captured pointer release and ignores its generated click', () => {
    const button = bar()[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    expect(selections()).toEqual([[1]])
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(selections()).toEqual([[1]])
  })

  it('keeps native keyboard activation immediate', async () => {
    const button = bar('both')[3]!
    ;(button.element as HTMLElement).focus()
    expect(document.activeElement).toBe(button.element)
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(selections()).toEqual([[3]])
  })

  it('does not select after a swipe', () => {
    const button = bar()[1]!
    pointer(button.element, 'pointerdown', 200)
    pointer(window, 'pointermove', 100)
    pointer(wrapper.find('nav').element, 'pointerup', 100)
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(selections()).toEqual([])
    expect(wrapper.emitted('swipe')).toEqual([[1]])
  })

  it('does not select after pointer cancellation even if a click follows', () => {
    const button = bar()[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointercancel')
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    vi.runAllTimers()
    expect(selections()).toEqual([])
  })

  it('does not select after a completed long press', () => {
    const button = bar()[1]!
    pointer(button.element, 'pointerdown')
    vi.advanceTimersByTime(1500)
    pointer(wrapper.find('nav').element, 'pointerup')
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(wrapper.emitted('admin')).toEqual([[]])
    expect(selections()).toEqual([])
  })

  it('suppresses both selections when a double tap opens the admin', () => {
    const button = bar('both')[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    vi.advanceTimersByTime(100)
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    vi.advanceTimersByTime(600)
    expect(wrapper.emitted('admin')).toEqual([[]])
    expect(selections()).toEqual([])
  })

  it('selects a single tap after the double-tap window', () => {
    const button = bar('both')[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    expect(selections()).toEqual([])
    vi.advanceTimersByTime(501)
    expect(selections()).toEqual([[1]])
  })

  it('ignores a delayed tap when the selected page was deleted', async () => {
    const button = bar('both')[4]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    await wrapper.setProps({ pages: pages.slice(0, 4) })
    vi.advanceTimersByTime(501)
    expect(selections()).toEqual([])
  })

  it('resolves a delayed tap by page ID after the pages are reordered', async () => {
    const button = bar('both')[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    await wrapper.setProps({ pages: [pages[1]!, pages[0]!, ...pages.slice(2)] })
    vi.advanceTimersByTime(501)
    expect(selections()).toEqual([[0]])
  })

  it('cancels a pending tap when a wheel swipe changes page', () => {
    const button = bar('both')[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    clock += 1000
    vi.mocked(performance.now).mockReturnValue(clock)
    wrapper.find('nav').element.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, bubbles: true, cancelable: true }))
    vi.advanceTimersByTime(600)
    expect(wrapper.emitted('swipe')).toEqual([[1]])
    expect(selections()).toEqual([])
  })

  it('cancels a pending tap when the next gesture is cancelled', () => {
    const button = bar('both')[1]!
    pointer(button.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    pointer(wrapper.find('nav').element, 'pointercancel')
    vi.advanceTimersByTime(600)
    expect(selections()).toEqual([])
  })

  it('keeps page selection and current-page markers inside the 40px compact bar', async () => {
    const buttons = bar()
    await wrapper.setProps({ height: 40 })
    expect(buttons[2]!.attributes('aria-current')).toBe('page')
    expect((buttons[2]!.element as HTMLElement).style.minHeight).toBe('39px')
    pointer(buttons[4]!.element, 'pointerdown')
    pointer(wrapper.find('nav').element, 'pointerup')
    expect(selections()).toEqual([[4]])
    await wrapper.setProps({ height: 80 })
    expect((buttons[2]!.element as HTMLElement).style.minHeight).toBe('56px')
  })

  it('makes overflow names reachable through explicit controls without changing page', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1460)
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('page-button')
        ? [...this.parentElement!.children].indexOf(this) * 120 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('page-button') ? 120 : 0
    })
    bar()
    await wrapper.setProps({ pages: Array.from({ length: 15 }, (_, i) => ({ id: String(i), name: `Page ${i}`, widgets: [] })) })
    await wrapper.vm.$nextTick()
    const names = wrapper.find('.page-list').element as HTMLElement
    const next = wrapper.find('.next-names')
    expect(next.exists()).toBe(true)
    pointer(next.element, 'pointerdown', 100)
    pointer(next.element, 'pointerup', 100)
    next.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(names.scrollLeft).toBe(480)
    next.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(names.scrollLeft).toBe(960)
    await wrapper.vm.$nextTick()
    expect(next.attributes('disabled')).toBeDefined()
    const previous = wrapper.find('.previous-names')
    previous.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(names.scrollLeft).toBe(480)
    previous.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(names.scrollLeft).toBe(0)
    expect(selections()).toEqual([])
    expect(wrapper.emitted('admin')).toBeUndefined()
    expect(wrapper.emitted('swipe')).toBeUndefined()
  })

  it('makes overflowing dots reachable through the same controls', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(512)
    wrapper = mount(NavBar, { props: { pages: [...pages, ...pages.map((p, i) => ({ ...p, id: 'extra-' + i }))], active: 0, height: 80 }, attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.next-names').exists()).toBe(true)
  })

  it('updates overflow controls when pages are appended to the reactive config', async () => {
    const configuredPages = reactive([...pages])
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => configuredPages.length * 100)
    bar()
    await wrapper.setProps({ pages: configuredPages })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.next-names').exists()).toBe(false)
    configuredPages.push({ id: 'extra', name: 'Extra', widgets: [] })
    await flushPromises()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.next-names').exists()).toBe(true)
  })

  it('keeps compact popover taps separate and cancels swiped popovers', async () => {
    bar()
    await wrapper.setProps({ navWidgets: [{ instanceId: 'clock-1', widgetId: 'clock', slot: 'left', settings: {}, popup: true }] })
    const overlay = wrapper.find('.tap').element
    pointer(overlay, 'pointerdown', 100)
    pointer(wrapper.find('nav').element, 'pointerup', 100)
    expect(wrapper.emitted('tap')?.length).toBe(1)
    expect(selections()).toEqual([])
    pointer(overlay, 'pointerdown', 100)
    pointer(wrapper.find('nav').element, 'pointercancel', 100)
    pointer(window, 'pointerup', 100)
    expect(wrapper.emitted('tap')?.length).toBe(1)
    pointer(overlay, 'pointerdown', 200)
    pointer(wrapper.find('nav').element, 'pointerup', 100)
    expect(wrapper.emitted('tap')?.length).toBe(1)
  })
})
