import { describe, it, expect } from 'vitest'
import { WIDE_COMPACT_WIDTH, compactWidth, type WidgetManifest } from '../src/shared/types'

const manifest = (compact?: { width: number }): WidgetManifest => ({
  id: 'clock', name: 'Clock', version: '1.0.0', sdk: 1, description: '', icon: 'clock',
  minSize: [8, 4], defaultSize: [16, 4], compact,
  subscriptions: [], commands: [], settingsSchema: {}, permissions: { network: [] },
})

describe('compactWidth', () => {
  it('is the manifest width when no setting asks for more', () => {
    expect(compactWidth(manifest({ width: 4 }), {})).toBe(4)
    expect(compactWidth(manifest({ width: 5 }))).toBe(5)
  })
  it('is 0 for a widget with no compact rendering, and for a missing manifest', () => {
    expect(compactWidth(manifest(), {})).toBe(0)
    expect(compactWidth(undefined, { compactDate: true })).toBe(0)
  })
  it('widens when the date or the cities are on', () => {
    expect(compactWidth(manifest({ width: 5 }), { compactDate: true })).toBe(WIDE_COMPACT_WIDTH)
    expect(compactWidth(manifest({ width: 5 }), { compactCities: true })).toBe(WIDE_COMPACT_WIDTH)
    expect(compactWidth(manifest({ width: 4 }), { compactDate: true, compactCities: true })).toBe(WIDE_COMPACT_WIDTH)
  })
  it('ignores anything but a true flag', () => {
    expect(compactWidth(manifest({ width: 4 }), { compactDate: false, compactCities: 'yes' })).toBe(4)
  })
  it('never narrows a widget that already asks for more than the wide width', () => {
    expect(compactWidth(manifest({ width: 12 }), { compactDate: true })).toBe(12)
  })
})
