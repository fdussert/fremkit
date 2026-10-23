import { describe, expect, it } from 'vitest'
import { txtRecord } from '../src/devices/txt.js'

describe('the TXT record of the pairing listener', () => {
  it('carries an address literal and the port, and nothing else', () => {
    expect(txtRecord('192.0.2.10', 4243)).toEqual({ a: '192.0.2.10', p: '4243' })
    expect(txtRecord('fe80::1%en0', 4300)).toEqual({ a: 'fe80::1%en0', p: '4300' })
    for (const bad of [null, '', 'x b=1', 'example.local', '192.0.2.1 p=1']) expect(txtRecord(bad, 4243)).toBeNull()
  })
})
