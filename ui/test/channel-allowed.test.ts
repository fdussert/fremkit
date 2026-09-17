import { describe, expect, it } from 'vitest'
import { channelAllowed } from '../src/shared/types'

describe('channelAllowed', () => {
  it('accepts an exact channel', () => {
    expect(channelAllowed(['volume'], 'volume')).toBe(true)
    expect(channelAllowed(['volume'], 'volumes')).toBe(false)
  })

  it('accepts any suffix under a declared prefix', () => {
    expect(channelAllowed(['azure-devops:*'], 'azure-devops:ado-x1z9')).toBe(true)
    expect(channelAllowed(['azure-devops:*'], 'azure-devops:')).toBe(true)
    expect(channelAllowed(['azure-devops:*'], 'bambu:a1b2')).toBe(false)
  })

  it('refuses everything when nothing is declared', () => {
    expect(channelAllowed([], 'volume')).toBe(false)
  })
})
