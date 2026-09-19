import { describe, expect, it } from 'vitest'
import { addedPermissions, effectiveManifest, grantedCatalog, grantedFor, grantedManifest, grantedPermissions, isEmpty, permissionsOf } from '../src/marketplace/consent.js'
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

describe('a declared connection as a permission', () => {
  const decl = (over: Record<string, unknown> = {}) => ({
    name: 'Homey Flows',
    kind: 'http-bearer',
    scheme: 'https',
    fields: [{ key: 'host', label: 'A' }, { key: 'token', label: 'K', secret: true }],
    requests: [{ method: 'GET', path: '/api/manager/flow/flow' }],
    ...over,
  })

  const asked = (connection?: unknown) => ({
    subscriptions: [], commands: [], network: [],
    ...(connection ? { connection } : {}),
  } as never)

  it('asks again when anything about the declaration changed', () => {
    // There is no part of a declaration that could change harmlessly: a new request is a new
    // call the widget may make, a changed kind moves the key to another header, and
    // `scheme: 'http'` takes it off TLS.
    const granted = asked(decl())
    for (const change of [
      { requests: [{ method: 'GET', path: '/api/manager/flow/flow' }, { method: 'POST', path: '/api/manager/system' }] },
      { kind: 'api-key-header', headerName: 'X-API-Key' },
      { scheme: 'http' },
      { hint: 'paste your key here' },
      { fields: [{ key: 'host', label: 'A' }, { key: 'token', label: 'Token', secret: true }] },
      { name: 'Homey Flows Pro' },
    ]) {
      const added = addedPermissions(granted, asked(decl(change)))
      expect(isEmpty(added), JSON.stringify(change)).toBe(false)
      expect(added.connection).toBeDefined()
    }
  })

  it('says nothing when it is the same offer, however the manifest was formatted', () => {
    const granted = asked(decl())
    expect(isEmpty(addedPermissions(granted, asked(decl())))).toBe(true)
    // Key order is not a change.
    const reordered = { requests: decl().requests, kind: 'http-bearer', scheme: 'https', name: 'Homey Flows', fields: decl().fields }
    expect(isEmpty(addedPermissions(granted, asked(reordered)))).toBe(true)
  })

  it('is new when there was none before, and is not carried by a grant alone', () => {
    expect(addedPermissions(asked(), asked(decl())).connection).toBeDefined()
    // A grant that still holds one, against a version that dropped it: nothing new to agree to.
    expect(isEmpty(addedPermissions(asked(decl()), asked()))).toBe(true)
  })

  it('is granted only while it is the declaration that was agreed to', () => {
    const manifest = ManifestSchema.parse({
      id: 'homey-flows', name: 'F', version: '2.0.0', minSize: [8, 4], defaultSize: [8, 4],
      connection: decl(),
    })
    const record = (connection?: unknown): WidgetConsent => ({
      kind: 'widget' as const, version: '2.0.0', registry: 'r', installedAt: 'x',
      consentedPermissions: {
        subscriptions: [], commands: [], network: [],
        ...(connection ? { connection: connection as Record<string, unknown> } : {}),
      },
    })
    expect(grantedManifest(manifest, record(decl())).connection).toBeDefined()
    // A widget that widened its own manifest reaches nothing, like a channel never granted.
    expect(grantedManifest(manifest, record(decl({ requests: [{ method: 'GET', path: '/x' }] }))).connection).toBeUndefined()
    expect(grantedManifest(manifest, record()).connection).toBeUndefined()
  })

  it('treats a stored declaration it cannot validate as no grant at all', () => {
    // The config is kept loose so an old file still loads; what enforces the grant is not.
    const bad = {
      kind: 'widget' as const, version: '2.0.0', registry: 'r', installedAt: 'x',
      consentedPermissions: { subscriptions: [], commands: [], network: [], connection: { name: 'X' } },
    }
    expect(grantedPermissions(bad).connection).toBeUndefined()
  })
})
