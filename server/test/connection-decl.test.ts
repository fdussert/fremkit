/**
 * What a widget may declare as a connection.
 *
 * Every rule here is enforced by the schema rather than by the code that reads it, because a
 * manifest arrives over the network: the proxy, the admin form and the consent dialog all read a
 * declaration that has already been through this file, and none of them re-checks its shape.
 */
import { describe, expect, it } from 'vitest'
import { ConnectionDeclSchema, ConnectionPathSchema, ManifestSchema } from '../src/widgets/manifest.js'

const decl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Key Light',
  kind: 'host',
  fields: [{ key: 'host', label: { fr: 'Adresse', en: 'Address' } }],
  requests: [{ method: 'GET', path: '/elgato/lights' }],
  ...over,
})

const bearer = (over: Record<string, unknown> = {}): Record<string, unknown> => decl({
  // Not `Homey`: that is a coded type's id, and the schema refuses it as a label. See below.
  name: 'Homey Flows',
  kind: 'http-bearer',
  fields: [
    { key: 'host', label: 'Address' },
    { key: 'token', label: 'API key', secret: true },
  ],
  requests: [{ method: 'GET', path: '/api/manager/flow/flow' }],
  ...over,
})

const parse = (body: Record<string, unknown>) => ConnectionDeclSchema.safeParse(body)

describe('the path patterns a declaration may ask for', () => {
  it('takes a rooted path of literals, one-segment stars and a trailing rest', () => {
    for (const path of [
      '/elgato/lights',
      '/api/manager/devices/device',
      '/api/manager/devices/device/*/capability/*',
      '/api/manager/devices/**',
      '/v1',
      '/a.b~c/d-e',
    ]) {
      expect(ConnectionPathSchema.safeParse(path).success, path).toBe(true)
    }
  })

  it('refuses anything that is not one', () => {
    for (const path of [
      'elgato/lights',        // not rooted: the proxy builds the URL and joins on this
      '/a?b=1',               // a query would be a second thing the pattern controls
      '/a#b',
      '/a/../b',              // a router may collapse this in a way the matcher cannot predict
      '/a/./b',
      '/a//b',
      '/**/a',                // `**` swallows the rest, so a rule after it is one nobody applies
      '/a/**/b',
      '/',
      '/a b',
      '/a/<script>',
    ]) {
      expect(ConnectionPathSchema.safeParse(path).success, path).toBe(false)
    }
  })
})

describe('the shape of a declaration', () => {
  it('takes the simplest one: a host and nothing else', () => {
    const parsed = parse(decl())
    expect(parsed.success).toBe(true)
    // https unless the author says otherwise, even for the kind that has no secret.
    if (parsed.success) expect(parsed.data.scheme).toBe('https')
  })

  it('needs exactly one host field, which the user types', () => {
    expect(parse(decl({ fields: [{ key: 'token', label: 'T', secret: true }] })).success).toBe(false)
    expect(parse(decl({ fields: [
      { key: 'host', label: 'A' }, { key: 'host', label: 'B' },
    ] })).success).toBe(false)
  })

  it('refuses a host marked secret, which is shown wherever the connection is', () => {
    expect(parse(decl({ fields: [{ key: 'host', label: 'A', secret: true }] })).success).toBe(false)
  })

  it('counts the secrets the kind expects', () => {
    // `host` has none: there is nothing to inject.
    expect(parse(decl({ fields: [
      { key: 'host', label: 'A' }, { key: 'token', label: 'T', secret: true },
    ] })).success).toBe(false)
    expect(parse(bearer()).success).toBe(true)
    expect(parse(bearer({ fields: [{ key: 'host', label: 'A' }] })).success).toBe(false)
    expect(parse(bearer({ fields: [
      { key: 'host', label: 'A' },
      { key: 'token', label: 'T', secret: true },
      { key: 'other', label: 'O', secret: true },
    ] })).success).toBe(false)
  })

  it('ties headerName and queryName to the kind that uses them', () => {
    const header = { kind: 'api-key-header', fields: [
      { key: 'host', label: 'A' }, { key: 'key', label: 'K', secret: true },
    ] }
    expect(parse(decl({ ...header, headerName: 'X-API-Key' })).success).toBe(true)
    expect(parse(decl(header)).success).toBe(false)
    // Not on another kind, where nothing would read it.
    expect(parse(bearer({ headerName: 'X-API-Key' })).success).toBe(false)

    const query = { kind: 'api-key-query', fields: [
      { key: 'host', label: 'A' }, { key: 'key', label: 'K', secret: true },
    ] }
    expect(parse(decl({ ...query, queryName: 'apikey' })).success).toBe(true)
    expect(parse(decl(query)).success).toBe(false)
  })

  it('takes only the four headers an API key belongs in', () => {
    const base = { kind: 'api-key-header', fields: [
      { key: 'host', label: 'A' }, { key: 'key', label: 'K', secret: true },
    ] }
    for (const headerName of ['Authorization', 'X-API-Key', 'X-Api-Key', 'X-Auth-Token']) {
      expect(parse(decl({ ...base, headerName })).success, headerName).toBe(true)
    }
    // A header name is a way to reach past the proxy: `Host` picks a virtual host, `Cookie`
    // turns this into a session, `X-Forwarded-For` is a lie told to whatever is in front.
    for (const headerName of ['Host', 'Cookie', 'X-Forwarded-For', 'X-Custom']) {
      expect(parse(decl({ ...base, headerName })).success, headerName).toBe(false)
    }
  })

  it('will not let a declaration wear a built-in type name', () => {
    // The id is namespaced whatever happens; the *label* is what the user reads on the form
    // where they type a credential.
    for (const name of [
      'Homey Pro', 'homey pro', 'GitHub', 'Synology', { fr: 'Calendrier ICS', en: 'X' },
      // The ids too, which is what the docs and every settings schema call them.
      'homey', 'Homey', 'HOMEY', 'Home-y', 'home y', 'bambu', 'ics', 'azure-devops', 'Azure DevOps',
      // And the same with an accent, since that is one keystroke away from the real thing.
      'Sýnology',
    ]) {
      expect(parse(decl({ name })).success, JSON.stringify(name)).toBe(false)
    }
  })

  it('leaves a name that merely mentions one alone', () => {
    // "Homey Flows" is honest: it says what it is for, and it is not the built-in type.
    for (const name of ['Homey Flows', 'My Homey lights', { fr: 'Homey (flows)', en: 'Homey (flows)' }]) {
      expect(parse(decl({ name })).success, JSON.stringify(name)).toBe(true)
    }
  })

  it('caps what an author can make the admin render', () => {
    expect(parse(decl({ hint: 'x'.repeat(2001) })).success).toBe(false)
    expect(parse(decl({ hint: { fr: 'ok', en: 'x'.repeat(2001) } })).success).toBe(false)
    expect(parse(decl({ hint: 'x'.repeat(2000) })).success).toBe(true)
    expect(parse(decl({ requests: Array.from({ length: 33 }, () => ({ method: 'GET', path: '/a' })) })).success).toBe(false)
    expect(parse(decl({ requests: [] })).success).toBe(false)
  })

  it('caps a cache at five minutes, past which it is a stale reading shown as a live one', () => {
    expect(parse(decl({ requests: [{ method: 'GET', path: '/a', cacheMs: 300_000 }] })).success).toBe(true)
    expect(parse(decl({ requests: [{ method: 'GET', path: '/a', cacheMs: 300_001 }] })).success).toBe(false)
  })

  it('takes http, because a Key Light on the LAN does not serve anything else', () => {
    const parsed = parse(decl({ scheme: 'http' }))
    expect(parsed.success).toBe(true)
    expect(parse(decl({ scheme: 'ftp' })).success).toBe(false)
  })

  it('takes a test request, and only a GET', () => {
    expect(parse(decl({ test: { method: 'GET', path: '/elgato/lights', expect: 200 } })).success).toBe(true)
    expect(parse(decl({ test: { method: 'POST', path: '/x', expect: 200 } })).success).toBe(false)
    expect(parse(decl({ test: { method: 'GET', path: '/x', expect: 99 } })).success).toBe(false)
  })
})

describe('a manifest that carries one', () => {
  const manifest = (over: Record<string, unknown> = {}) => ManifestSchema.safeParse({
    id: 'key-light', name: 'Key Light', version: '1.0.0',
    minSize: [8, 4], defaultSize: [8, 4], ...over,
  })

  it('is absent from almost every manifest, and optional', () => {
    const parsed = manifest()
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.connection).toBeUndefined()
  })

  it('carries it through when it is there', () => {
    const parsed = manifest({ connection: decl({ scheme: 'http' }) })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.connection?.kind).toBe('host')
      expect(parsed.data.connection?.requests[0].path).toBe('/elgato/lights')
    }
  })

  it('refuses the whole manifest when the declaration is wrong', () => {
    // Not dropped quietly: a widget whose connection did not parse would run with no way to
    // reach anything, and look broken rather than refused.
    expect(manifest({ connection: decl({ fields: [{ key: 'token', label: 'T' }] }) }).success).toBe(false)
  })
})
