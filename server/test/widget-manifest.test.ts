import { describe, it, expect } from 'vitest'
import { ManifestSchema } from '../src/widgets/manifest.js'

const base = { id: 'clock', name: 'Horloge', version: '1.0.0' }

describe('ManifestSchema', () => {
  it('accepts a v2 manifest and defaults the icon', () => {
    const m = ManifestSchema.parse({ ...base, minSize: [8, 4], defaultSize: [16, 4] })
    expect(m.icon).toBe('layout-grid')
    expect(m.minSize).toEqual([8, 4])
    expect(m.defaultSize).toEqual([16, 4])
    expect(m).not.toHaveProperty('sizes')
  })
  it('accepts a compact declaration', () => {
    const m = ManifestSchema.parse({ ...base, minSize: [8, 4], compact: { width: 4 } })
    expect(m.compact).toEqual({ width: 4 })
  })
  it('leaves compact absent when the manifest declares none', () => {
    expect(ManifestSchema.parse({ ...base, minSize: [8, 4] }).compact).toBeUndefined()
  })
  it('refuses a compact width outside 2..16', () => {
    for (const width of [1, 17, 4.5]) {
      expect(ManifestSchema.safeParse({ ...base, minSize: [8, 4], compact: { width } }).success).toBe(false)
    }
  })
  it('keeps an explicit icon', () => {
    expect(ManifestSchema.parse({ ...base, icon: 'clock', minSize: [8, 4], defaultSize: [8, 4] }).icon).toBe('clock')
  })
  it('converts a v1 manifest: smallest sizes doubled, defaultSize doubled', () => {
    const m = ManifestSchema.parse({ ...base, sizes: [[8, 2], [4, 2], [8, 4], [12, 2]], defaultSize: [8, 2] })
    expect(m.minSize).toEqual([8, 4])
    expect(m.defaultSize).toEqual([16, 4])
  })
  it('falls back to the first size when a v1 manifest has no defaultSize', () => {
    const m = ManifestSchema.parse({ ...base, sizes: [[12, 4], [4, 2]] })
    expect(m.minSize).toEqual([8, 4])
    expect(m.defaultSize).toEqual([24, 8])
  })
  it('defaults defaultSize to minSize when only minSize is given', () => {
    expect(ManifestSchema.parse({ ...base, minSize: [6, 2] }).defaultSize).toEqual([6, 2])
  })
  it('defaults minSize to [4, 2] when a manifest has neither minSize nor sizes', () => {
    const m = ManifestSchema.parse(base)
    expect(m.minSize).toEqual([4, 2])
    expect(m.defaultSize).toEqual([4, 2])
  })
  it('keeps an explicit defaultSize when minSize falls back to the default', () => {
    expect(ManifestSchema.parse({ ...base, defaultSize: [12, 4] }).minSize).toEqual([4, 2])
  })
  it('rejects a defaultSize smaller than minSize', () => {
    expect(ManifestSchema.safeParse({ ...base, minSize: [8, 4], defaultSize: [4, 4] }).success).toBe(false)
  })

  it('accepts a connection setting and refuses one without a connectionType', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    expect(ManifestSchema.safeParse({ ...base, settingsSchema: { connection: { type: 'connection', label: 'Connexion', connectionType: 'azure-devops' } } }).success).toBe(true)
    expect(ManifestSchema.safeParse({ ...base, settingsSchema: { connection: { type: 'connection', label: 'Connexion' } } }).success).toBe(false)
  })

  it('accepts a connections setting and refuses one without a connectionType', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    expect(ManifestSchema.safeParse({ ...base, settingsSchema: { calendars: { type: 'connections', label: 'Agendas', connectionType: 'ics', default: [] } } }).success).toBe(true)
    expect(ManifestSchema.safeParse({ ...base, settingsSchema: { calendars: { type: 'connections', label: 'Agendas' } } }).success).toBe(false)
  })

  it('accepts a pick setting and refuses one missing its connection or its source', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    const withPick = (devices: unknown) => ManifestSchema.safeParse({ ...base, settingsSchema: { devices } })
    const parsed = withPick({ type: 'pick', label: 'Appareils', connection: 'connection', source: 'devices', default: [] })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.settingsSchema.devices.source).toBe('devices')
    expect(withPick({ type: 'pick', label: 'Appareils', source: 'devices' }).success).toBe(false)
    expect(withPick({ type: 'pick', label: 'Appareils', connection: 'connection' }).success).toBe(false)
    expect(withPick({ type: 'pick', label: 'Appareils', connection: '', source: '' }).success).toBe(false)
  })

  it('accepts an apps setting', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    expect(ManifestSchema.safeParse({ ...base, settingsSchema: { apps: { type: 'apps', label: 'Applications', default: [] } } }).success).toBe(true)
  })

  describe('list settings', () => {
    const base = { id: 'x', name: 'X', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }
    const withSetting = (cities: unknown) => ManifestSchema.safeParse({ ...base, settingsSchema: { cities } })

    it('accepts a list of every allowed item type', () => {
      const parsed = withSetting({
        type: 'list', label: 'Villes', default: [], max: 6,
        itemSchema: {
          label: { type: 'string', label: 'Libellé' },
          timezone: { type: 'timezone', label: 'Fuseau' },
          hour12: { type: 'boolean', default: false, label: '12 h' },
          rank: { type: 'number', default: 0, label: 'Rang' },
          size: { type: 'enum', label: 'Taille', options: ['small', 'big'] },
        },
      })
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.settingsSchema.cities.max).toBe(6)
    })
    it('accepts a bare timezone setting', () => {
      expect(withSetting({ type: 'timezone', label: 'Fuseau', default: '' }).success).toBe(true)
    })
    it('refuses a list without an itemSchema', () => {
      expect(withSetting({ type: 'list', label: 'Villes' }).success).toBe(false)
      expect(withSetting({ type: 'list', label: 'Villes', itemSchema: {} }).success).toBe(false)
    })
    it('refuses a nested list, and any item type the row cannot render inline', () => {
      for (const type of ['list', 'color', 'connection', 'apps']) {
        expect(withSetting({ type: 'list', label: 'Villes', itemSchema: { x: { type, label: 'X' } } }).success).toBe(false)
      }
    })
    it('accepts suggest on a string item field, with an optional sibling condition', () => {
      const list = (x: unknown) => withSetting({ type: 'list', label: 'Boutons', itemSchema: { x } })
      expect(list({ type: 'string', label: 'Cible', suggest: 'apps' }).success).toBe(true)
      expect(list({ type: 'string', label: 'Cible', suggest: 'apps', suggestWhen: { kind: 'app' } }).success).toBe(true)
    })
    it('refuses an unknown suggest source, one on a field that cannot be typed into, and a lone suggestWhen', () => {
      const list = (x: unknown) => withSetting({ type: 'list', label: 'Boutons', itemSchema: { x } })
      expect(list({ type: 'string', label: 'Cible', suggest: 'everything' }).success).toBe(false)
      expect(list({ type: 'number', label: 'Rang', suggest: 'apps' }).success).toBe(false)
      expect(list({ type: 'string', label: 'Cible', suggestWhen: { kind: 'app' } }).success).toBe(false)
    })
    it('refuses a max that is not a positive whole number', () => {
      for (const max of [0, -1, 1.5, '6']) {
        expect(withSetting({ type: 'list', label: 'Villes', max, itemSchema: { x: { type: 'string', label: 'X' } } }).success).toBe(false)
      }
    })
  })
})
