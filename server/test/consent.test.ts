import { describe, expect, it } from 'vitest'
import { addedPermissions, effectiveManifest, grantedCatalog, grantedFor, isEmpty, permissionsOf } from '../src/marketplace/consent.js'
import { ManifestSchema, type WidgetManifest } from '../src/widgets/manifest.js'
import { WidgetCatalog } from '../src/widgets/catalog.js'
import { DEFAULT_CONFIG, type Config, type WidgetConsent } from '../src/config/schema.js'

const manifest = (over: Record<string, unknown> = {}): WidgetManifest => ManifestSchema.parse({
  id: 'nas', name: 'NAS', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4],
  subscriptions: ['synology:*'], commands: ['synology'],
  permissions: { network: ['api.example.com'] },
  ...over,
})

const consent = (over: Partial<WidgetConsent['consentedPermissions']> = {}): WidgetConsent => ({
  kind: 'widget',
  version: '1.0.0',
  registry: 'fremkit-sietch',
  installedAt: '2026-09-18T12:00:00.000Z',
  consentedPermissions: { subscriptions: ['synology:*'], commands: ['synology'], network: ['api.example.com'], ...over },
})

describe('permissionsOf', () => {
  it('reads the three lists a manifest asks for', () => {
    expect(permissionsOf(manifest())).toEqual({
      subscriptions: ['synology:*'], commands: ['synology'], network: ['api.example.com'],
    })
  })
})

describe('addedPermissions', () => {
  it('is empty when a new version asks for nothing new', () => {
    const granted = permissionsOf(manifest())
    expect(isEmpty(addedPermissions(granted, permissionsOf(manifest())))).toBe(true)
    // Narrower is not new either: dropping a permission never needs a dialog.
    expect(isEmpty(addedPermissions(granted, { subscriptions: [], commands: [], network: [] }))).toBe(true)
  })

  it('names exactly what is new, in each of the three lists', () => {
    const granted = permissionsOf(manifest())
    const asked = permissionsOf(manifest({
      subscriptions: ['synology:*', 'system'],
      commands: ['synology', 'shortcuts'],
      permissions: { network: ['api.example.com', 'evil.example.net'] },
    }))
    expect(addedPermissions(granted, asked)).toEqual({
      subscriptions: ['system'], commands: ['shortcuts'], network: ['evil.example.net'],
    })
  })

  it('treats a narrowing of a wildcard as new, rather than reasoning about channel shapes', () => {
    // `homey:*` does cover `homey:abc`. Deciding that here would mean re-implementing the channel
    // matcher on the wrong side of a boundary, so the answer is deliberately the cautious one:
    // one extra dialog in a case nobody hits, instead of a silent widening.
    const granted = { subscriptions: ['homey:*'], commands: [], network: [] }
    expect(addedPermissions(granted, { subscriptions: ['homey:abc'], commands: [], network: [] }))
      .toEqual({ subscriptions: ['homey:abc'], commands: [], network: [] })
  })
})

describe('effectiveManifest', () => {
  it('leaves a built-in alone: it ships with the server and is trusted with it', () => {
    expect(effectiveManifest(manifest(), 'builtin', undefined)).toEqual(manifest())
  })

  it('narrows an installed widget to what was granted', () => {
    const asked = manifest({
      subscriptions: ['synology:*', 'system'],
      commands: ['synology', 'shortcuts'],
      permissions: { network: ['api.example.com', 'evil.example.net'] },
    })
    const effective = effectiveManifest(asked, 'installed', consent())
    expect(effective.subscriptions).toEqual(['synology:*'])
    expect(effective.commands).toEqual(['synology'])
    expect(effective.permissions.network).toEqual(['api.example.com'])
    // Everything that is not a permission is the widget's own business.
    expect(effective.minSize).toEqual(asked.minSize)
    expect(effective.name).toBe(asked.name)
  })

  it('grants an installed widget with no record nothing at all', () => {
    // A folder dropped into data/widgets by hand, or a config restored without the record:
    // neither is a user saying yes, and the safe reading of silence is "no".
    const effective = effectiveManifest(manifest(), 'installed', undefined)
    expect(effective.subscriptions).toEqual([])
    expect(effective.commands).toEqual([])
    expect(effective.permissions.network).toEqual([])
  })

  it('never widens: a grant for something the manifest no longer asks for adds nothing', () => {
    const effective = effectiveManifest(manifest({ subscriptions: [], commands: [], permissions: { network: [] } }), 'installed', consent())
    expect(effective.subscriptions).toEqual([])
    expect(effective.permissions.network).toEqual([])
  })
})

describe('grantedFor and grantedCatalog', () => {
  function catalogWith(source: 'builtin' | 'installed', m = manifest()): WidgetCatalog {
    const catalog = new WidgetCatalog('/nonexistent')
    catalog.entries.set('nas', { manifest: m, source, folder: '/nonexistent/nas' })
    return catalog
  }
  const config = (record?: WidgetConsent): Config =>
    ({ ...DEFAULT_CONFIG, marketplace: { installed: record ? { nas: record } : {} } })

  it('answers undefined for an id the catalogue does not hold', () => {
    expect(grantedFor(catalogWith('builtin'), config(), 'ghost')).toBeUndefined()
  })

  it('reads the record of the id it is asked about', () => {
    const narrowed = grantedFor(catalogWith('installed'), config(consent({ commands: [] })), 'nas')!
    expect(narrowed.commands).toEqual([])
    expect(narrowed.subscriptions).toEqual(['synology:*'])
  })

  it('narrows the whole catalogue in one pass', () => {
    const all = grantedCatalog(catalogWith('installed'), config(consent({ network: [] })))
    expect(all.get('nas')!.permissions.network).toEqual([])
  })
})
