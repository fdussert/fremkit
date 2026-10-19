// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KeyboardShortcuts from '../src/admin/KeyboardShortcuts.vue'
import { SHORTCUTS } from '../src/admin/shortcuts'
import { setLocale } from '../src/shared/i18n'

describe('the keyboard shortcuts sheet', () => {
  it('lists every shortcut of the table, with its keys and its name', () => {
    setLocale('en')
    const wrapper = mount(KeyboardShortcuts)
    const rows = wrapper.findAll('.row')
    expect(rows).toHaveLength(SHORTCUTS.length)
    expect(rows.map((r) => r.find('kbd').text())).toEqual(SHORTCUTS.map((s) => s.display))
    expect(wrapper.text()).toContain('Open the command palette')
    expect(wrapper.findAll('h3').map((h) => h.text())).toEqual(['General', 'Selected widgets', 'Selection', 'Layout'])
  })
})
