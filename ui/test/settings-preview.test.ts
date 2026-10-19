/**
 * @vitest-environment jsdom
 *
 * A settings field's ▶ preview is a command the admin sends with its own authority. It is
 * offered, and sent, only on a channel the widget is granted (M4 of the 2026-10 review).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SettingField } from '../src/shared/types'

const command = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/shared/socket', () => ({ useSocket: () => ({ command, subscribe: vi.fn(() => () => {}) }) }))
const SettingsForm = (await import('../src/admin/SettingsForm.vue')).default

const schema = (channel: string): Record<string, SettingField> => ({
  sound: { type: 'enum', label: 'Sound', default: 'ding', options: ['ding'], preview: { channel, command: 'preview' } } as SettingField,
})

afterEach(() => { command.mockClear() })

describe('the settings preview button', () => {
  it('is offered and sends on a granted command channel', async () => {
    const wrapper = mount(SettingsForm, { props: { schema: schema('claude-sessions'), values: {}, commands: ['claude-sessions'] } })
    const button = wrapper.find('button[title]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    expect(command).toHaveBeenCalledWith('claude-sessions', 'preview', { value: 'ding' })
    wrapper.unmount()
  })

  it('is not offered on a channel the commands do not cover, nor when none are given', () => {
    for (const commands of [['spotify'], [], undefined]) {
      const wrapper = mount(SettingsForm, { props: { schema: schema('mutedeck'), values: {}, ...(commands ? { commands } : {}) } })
      expect(wrapper.find('button[title]').exists(), JSON.stringify(commands)).toBe(false)
      wrapper.unmount()
    }
    expect(command).not.toHaveBeenCalled()
  })

  it('accepts a family wildcard, like the bridge does', () => {
    const wrapper = mount(SettingsForm, { props: { schema: schema('github:gh-1'), values: {}, commands: ['github:*'] } })
    expect(wrapper.find('button[title]').exists()).toBe(true)
    wrapper.unmount()
  })
})
