import { describe, expect, it } from 'vitest'
import { SettingFieldSchema } from '../src/widgets/manifest.js'

describe('service connection selectors', () => {
  it('preserves the service family used by the host account guard', () => {
    expect(SettingFieldSchema.parse({ type: 'connection', label: 'Account', connectionType: 'google', connectionService: 'gmail' }).connectionService).toBe('gmail')
  })
  it('refuses a service selector on an unrelated setting or with a default account', () => {
    for (const field of [
      { type: 'string', label: 'Account', connectionService: 'gmail' },
      { type: 'connection', label: 'Account', connectionType: 'google', connectionService: 'gmail', default: 'account-a' },
      { type: 'connection', label: 'Account', connectionType: 'google', connectionService: 'gmail:*' },
    ]) expect(SettingFieldSchema.safeParse(field).success).toBe(false)
  })
})
