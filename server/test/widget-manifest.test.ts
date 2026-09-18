import { describe, it, expect } from 'vitest'
import { ManifestSchema } from '../src/widgets/manifest.js'

const base = { id: 'clock', name: 'Horloge', version: '1.0.0' }

describe('ManifestSchema', () => {
  it('requires a semver version, because the registry orders them', () => {
    for (const version of ['1.0.0', '0.1.0', '2.10.3', '1.0.0-rc.1', '1.0.0+build.5']) {
      expect(ManifestSchema.safeParse({ ...base, version }).success).toBe(true)
    }
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', 'latest', '01.0.0', '']) {
      expect(ManifestSchema.safeParse({ ...base, version }).success).toBe(false)
    }
  })

  it('defaults sdk to 1, so a manifest written before the marketplace still reads', () => {
    expect(ManifestSchema.parse(base).sdk).toBe(1)
    expect(ManifestSchema.parse({ ...base, sdk: 3 }).sdk).toBe(3)
    for (const sdk of [0, -1, 1.5, '1']) {
      expect(ManifestSchema.safeParse({ ...base, sdk }).success).toBe(false)
    }
  })

  it('takes an https homepage and refuses anything else, including javascript:', () => {
    expect(ManifestSchema.parse({ ...base, homepage: 'https://example.com/widget' }).homepage)
      .toBe('https://example.com/widget')
    for (const homepage of ['http://example.com', 'javascript:alert(1)', 'example.com', 'file:///etc/passwd']) {
      expect(ManifestSchema.safeParse({ ...base, homepage }).success).toBe(false)
    }
  })

  it('takes an author and an SPDX licence, and refuses a sentence for the licence', () => {
    const m = ManifestSchema.parse({ ...base, author: 'A. Author', license: 'Apache-2.0' })
    expect(m.author).toBe('A. Author')
    expect(m.license).toBe('Apache-2.0')
    expect(ManifestSchema.safeParse({ ...base, license: 'do what you like with it' }).success).toBe(false)
    expect(ManifestSchema.safeParse({ ...base, license: '<img src=x>' }).success).toBe(false)
  })

  it('leaves the three optional fields absent rather than empty', () => {
    const m = ManifestSchema.parse(base)
    expect(m.homepage).toBeUndefined()
    expect(m.author).toBeUndefined()
    expect(m.license).toBeUndefined()
  })

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

describe('channels a manifest may not ask for', () => {
  const base = { id: 'w', name: 'W', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2] }

  it('refuses the config channel, which carries the whole dashboard', () => {
    // Every page, every widget's settings, and the id and fields of every connection.
    expect(ManifestSchema.safeParse({ ...base, subscriptions: ['config'] }).success).toBe(false)
    expect(ManifestSchema.safeParse({ ...base, commands: ['config'] }).success).toBe(false)
    expect(ManifestSchema.safeParse({ ...base, subscriptions: ['config:*'] }).success).toBe(false)
    expect(ManifestSchema.safeParse({ ...base, subscriptions: ['config:anything'] }).success).toBe(false)
  })

  it('names the reason', () => {
    const parsed = ManifestSchema.safeParse({ ...base, subscriptions: ['config'] })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].message).toMatch(/réservé/)
  })

  it('still accepts every channel the widgets here declare', () => {
    const ok = ['volume', 'system', 'claude-account', 'homey:*', 'github:gh-x1z9', 'calendar:*']
    expect(ManifestSchema.safeParse({ ...base, subscriptions: ok, commands: ok }).success).toBe(true)
  })

  it('refuses an empty channel name', () => {
    expect(ManifestSchema.safeParse({ ...base, subscriptions: [''] }).success).toBe(false)
  })
})
