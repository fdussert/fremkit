/**
 * A connection type built from a widget's declaration.
 *
 * What the schema could not say, said here: where the secret goes, what scheme the request
 * actually uses, and what the generic Test button answers. Every assertion about a secret is an
 * assertion about `authFor`, which is the one place it is ever put into a request.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  authFor, declaredBy, declaredFromCatalog, declaredType, declaredTypeId,
  isDeclaredType, originOf, parseDeclaredHost, schemeFor, slugText, syncDeclaredTypes,
} from '../src/connections/declared.js'
import { ConnectionDeclSchema, type ConnectionDecl } from '../src/widgets/manifest.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'
import { rejectsHost } from '../src/connections/routes.js'
import type { ConnectionType } from '../src/connections/types.js'

const decl = (over: Record<string, unknown> = {}): ConnectionDecl => ConnectionDeclSchema.parse({
  name: 'Key Light',
  kind: 'host',
  fields: [{ key: 'host', label: 'Address' }],
  requests: [{ method: 'GET', path: '/elgato/lights' }],
  ...over,
})

const bearer = (over: Record<string, unknown> = {}): ConnectionDecl => decl({
  name: 'Homey Flows', kind: 'http-bearer',
  fields: [{ key: 'host', label: 'Address' }, { key: 'token', label: 'Key', secret: true }],
  ...over,
})

describe('the id a declaration gets', () => {
  it('is namespaced by the widget, so two widgets never share one by accident', () => {
    expect(declaredTypeId('homey-flows', 'Homey Flows')).toBe('decl:homey-flows:homey-flows')
    expect(declaredTypeId('a', 'Homey Flows')).not.toBe(declaredTypeId('b', 'Homey Flows'))
    expect(isDeclaredType('decl:a:b')).toBe(true)
    expect(isDeclaredType('homey')).toBe(false)
    expect(declaredBy('decl:homey-flows:homey')).toBe('homey-flows')
    expect(declaredBy('homey')).toBeUndefined()
  })

  it('makes a slug out of anything, including a name that is all punctuation', () => {
    expect(declaredTypeId('w', 'Ma Connexion Élégante')).toBe('decl:w:ma-connexion-elegante')
    expect(declaredTypeId('w', '···')).toBe('decl:w:connection')
  })

  it('is the same id however the manifest happened to order its locales', () => {
    // Otherwise a manifest reformatted between two versions changes the type id and orphans
    // every connection made with it.
    expect(slugText({ fr: 'Flows Homey', en: 'Homey flows' })).toBe('Homey flows')
    expect(slugText({ en: 'Homey flows', fr: 'Flows Homey' })).toBe('Homey flows')
    // No English: the alphabetically first locale, which is still a fixed choice.
    expect(slugText({ fr: 'Flows', de: 'Abläufe' })).toBe('Abläufe')
    expect(slugText('Plain')).toBe('Plain')
  })
})

describe('where the secret goes', () => {
  it('puts nothing anywhere for a declaration with no secret', () => {
    expect(authFor(decl(), { host: 'h' }, {})).toEqual({ headers: {}, query: {} })
  })

  it('carries a bearer token in Authorization', () => {
    expect(authFor(bearer(), { host: 'h' }, { token: 's3cret' }).headers)
      .toEqual({ Authorization: 'Bearer s3cret' })
  })

  it('builds Basic from a named user field, or an empty user when none is declared', () => {
    const withUser = decl({
      kind: 'http-basic',
      fields: [{ key: 'host', label: 'A' }, { key: 'account', label: 'U' }, { key: 'pw', label: 'P', secret: true }],
    })
    expect(authFor(withUser, { host: 'h', account: 'admin' }, { pw: 'p' }).headers.Authorization)
      .toBe(`Basic ${Buffer.from('admin:p').toString('base64')}`)

    const tokenOnly = decl({
      kind: 'http-basic',
      fields: [{ key: 'host', label: 'A' }, { key: 'pw', label: 'P', secret: true }],
    })
    expect(authFor(tokenOnly, { host: 'h' }, { pw: 'p' }).headers.Authorization)
      .toBe(`Basic ${Buffer.from(':p').toString('base64')}`)
  })

  it('uses the declared header or the declared query parameter', () => {
    const header = decl({
      kind: 'api-key-header', headerName: 'X-API-Key',
      fields: [{ key: 'host', label: 'A' }, { key: 'key', label: 'K', secret: true }],
    })
    expect(authFor(header, { host: 'h' }, { key: 'k' })).toEqual({ headers: { 'X-API-Key': 'k' }, query: {} })

    const query = decl({
      kind: 'api-key-query', queryName: 'apikey',
      fields: [{ key: 'host', label: 'A' }, { key: 'key', label: 'K', secret: true }],
    })
    expect(authFor(query, { host: 'h' }, { key: 'k' })).toEqual({ headers: {}, query: { apikey: 'k' } })
  })
})

describe('the host field, which is the one string the user types', () => {
  it('takes a name, an address, a port and an IPv6 literal', () => {
    expect(parseDeclaredHost('192.168.1.10')).toEqual({ hostname: '192.168.1.10', authority: '192.168.1.10' })
    expect(parseDeclaredHost('192.168.1.10:9123')).toEqual({ hostname: '192.168.1.10', authority: '192.168.1.10:9123' })
    expect(parseDeclaredHost('nas.local:5001')).toEqual({ hostname: 'nas.local', authority: 'nas.local:5001' })
    // Brackets are how an IPv6 address carries a port; the hostname the rules judge has none.
    expect(parseDeclaredHost('[::1]:8080')).toEqual({ hostname: '::1', authority: '[::1]:8080' })
    // Accepted and lower-cased, which is what a URL does with a host anyway.
    expect(parseDeclaredHost('EXAMPLE.COM')).toEqual({ hostname: 'example.com', authority: 'example.com' })
  })

  it('refuses everything that is not only a host', () => {
    // Each of these got through the hand-rolled split this replaced. The first is the whole
    // reason it matters: read as private, so `http` is honoured, and sent to `evil.example`
    // with the user's key in the clear.
    for (const raw of [
      '10.0.0.1:x@evil.example',
      'user:pw@evil.example',
      '10.0.0.1/../x',
      '10.0.0.1?a=b',
      '10.0.0.1#f',
      'a b',
      'a\r\nb',
      'evil.example/',
      'http://evil.example',
      '',
      '  ',
      'x'.repeat(400),
    ]) {
      expect(parseDeclaredHost(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('the scheme a request really uses', () => {
  const at = (raw: string) => parseDeclaredHost(raw)!

  it('is https unless the declaration asked for http', () => {
    expect(schemeFor(decl(), at('192.168.1.10'))).toBe('https')
    expect(schemeFor(decl({ scheme: 'http' }), at('192.168.1.10'))).toBe('http')
  })

  it('refuses to send a key over plain http to a public host, whatever the author declared', () => {
    // The exception exists because a LAN device has no certificate to be had. It is not a way
    // to take somebody's API key off TLS on the open internet.
    expect(schemeFor(decl({ scheme: 'http' }), at('api.example.com'))).toBe('https')
    expect(schemeFor(decl({ scheme: 'http' }), at('203.0.113.5'))).toBe('https')
    for (const host of ['192.168.1.10', '10.0.0.4', '127.0.0.1', '[::1]', '172.16.0.1']) {
      expect(schemeFor(decl({ scheme: 'http' }), at(host)), host).toBe('http')
    }
  })

  it('judges the address the parser produced, not the string that was typed', () => {
    // `10.0.0.1:x@evil.example` used to read as `10.0.0.1` — private, so plain http — while the
    // request went to `evil.example`. There is no such string to judge any more.
    expect(parseDeclaredHost('10.0.0.1:x@evil.example')).toBeNull()
  })

  it('keeps the port and strips the brackets only to judge the address', () => {
    expect(originOf(decl({ scheme: 'http' }), at('192.168.1.10:9123'))).toBe('http://192.168.1.10:9123')
    expect(originOf(decl(), at('api.example.com'))).toBe('https://api.example.com')
    expect(originOf(decl({ scheme: 'http' }), at('[::1]:8080'))).toBe('http://[::1]:8080')
  })
})

describe('the generic Test', () => {
  const type = (d: ConnectionDecl, doFetch: typeof fetch) => declaredType('w', d, { fetch: doFetch })

  it('asks for the declared path and calls the declared status a success', async () => {
    const doFetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const t = type(decl({ test: { method: 'GET', path: '/elgato/lights', expect: 200 }, scheme: 'http' }), doFetch as never)
    const res = await t.test({ host: '192.168.1.10:9123' }, {})
    expect(res.ok).toBe(true)
    expect(String((doFetch.mock.calls[0] as unknown[])[0])).toBe('http://192.168.1.10:9123/elgato/lights')
  })

  it('carries the secret to the service and to nowhere else', async () => {
    let seen: RequestInit | undefined
    const doFetch = vi.fn(async (_url: unknown, init?: RequestInit) => { seen = init; return new Response('{}', { status: 200 }) })
    const t = type(bearer({ test: { method: 'GET', path: '/api/manager/flow/flow', expect: 200 } }), doFetch as never)
    await t.test({ host: 'homey.example.com' }, { token: 's3cret' })
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer s3cret')
    expect(seen?.redirect).toBe('manual')
  })

  it('never quotes the body, the URL or the exception', async () => {
    const doFetch = vi.fn(async () => new Response('<html>token s3cret leaked</html>', { status: 500 }))
    const t = type(bearer({ test: { method: 'GET', path: '/a', expect: 200 } }), doFetch as never)
    const res = await t.test({ host: 'homey.example.com' }, { token: 's3cret' })
    expect(res.ok).toBe(false)
    const said = JSON.stringify(res)
    expect(said).not.toContain('s3cret')
    expect(said).not.toContain('homey.example.com')
    expect(said).not.toContain('leaked')
    // The status is the service's own number and says something useful.
    expect(said).toContain('500')
  })

  it('tells a refusal from an unreachable host', async () => {
    const refused = type(bearer({ test: { method: 'GET', path: '/a', expect: 200 } }),
      (async () => new Response('', { status: 401 })) as never)
    const one = await refused.test({ host: 'h.example.com' }, { token: 't' })
    expect(one.ok).toBe(false)
    if (!one.ok) expect(one.error).toMatch(/refus|credentials/i)

    const down = type(bearer({ test: { method: 'GET', path: '/a', expect: 200 } }),
      (async () => { throw new Error('ECONNREFUSED 192.168.1.10') }) as never)
    const two = await down.test({ host: 'h.example.com' }, { token: 't' })
    expect(two.ok).toBe(false)
    if (!two.ok) {
      expect(two.error).toMatch(/injoignable|could not be reached/)
      expect(two.error).not.toContain('192.168.1.10')
    }
  })

  it('says it saved rather than pretending to check when nothing is declared to check', async () => {
    const doFetch = vi.fn()
    const t = type(decl(), doFetch as never)
    const res = await t.test({ host: 'h.example.com' }, {})
    expect(res.ok).toBe(true)
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('asks for a host before anything else', async () => {
    const doFetch = vi.fn()
    const t = type(decl({ test: { method: 'GET', path: '/a', expect: 200 } }), doFetch as never)
    expect((await t.test({ host: '  ' }, {})).ok).toBe(false)
    expect(doFetch).not.toHaveBeenCalled()
  })
})

describe('the type a declaration amounts to', () => {
  it('binds its secret to the host, so moving the host asks for the key again', () => {
    const t = declaredType('homey-flows', bearer())
    expect(t.secretBindings).toEqual(['host'])
    expect(t.fields.map((f) => f.key)).toEqual(['host', 'token'])
    expect(t.fields[1].secret).toBe(true)
  })

  it('publishes no channel and builds no provider', () => {
    const t = declaredType('w', bearer())
    expect(t.channelPrefix).toBeUndefined()
    expect(t.createProvider).toBeUndefined()
  })
})

describe('keeping the registry in step with what is installed', () => {
  const entry = (source: 'builtin' | 'installed', connection?: ConnectionDecl) =>
    ({ manifest: { connection } as never, source })

  it('registers a declared type for an installed widget and drops it when it goes', () => {
    const registry = new ConnectionTypeRegistry([{ id: 'homey', name: 'Homey Pro' } as ConnectionType])
    syncDeclaredTypes(registry, [{ widgetId: 'homey-flows', decl: bearer() }])
    expect(registry.get('decl:homey-flows:homey-flows')).toBeDefined()

    syncDeclaredTypes(registry, [])
    expect(registry.get('decl:homey-flows:homey-flows')).toBeUndefined()
    // A coded type is not this function's to remove.
    expect(registry.get('homey')).toBeDefined()
  })

  it('never registers one for a built-in, which would have a coded type written for it', () => {
    const entries: [string, ReturnType<typeof entry>][] = [
      ['clock', entry('builtin', bearer())],
      ['homey-flows', entry('installed', bearer())],
    ]
    const found = declaredFromCatalog(entries, (id) => entries.find(([i]) => i === id)?.[1].manifest)
    expect(found.map((f) => f.widgetId)).toEqual(['homey-flows'])
  })

  it('registers nothing for a widget whose declaration was not granted', () => {
    // `granted` is the narrowed manifest: a widget that has not been consented to has no
    // `connection` there, however loudly its own file declares one.
    const entries: [string, ReturnType<typeof entry>][] = [['homey-flows', entry('installed', bearer())]]
    const found = declaredFromCatalog(entries, () => ({ connection: undefined } as never))
    expect(found).toEqual([])
  })
})

describe('when the registry is refreshed', () => {
  /**
   * A declaration becomes a grant when the *consent record* is written, not when the folder
   * lands. An install does `catalog.scan()` and then `store.update()`, in that order — so a sync
   * hooked to the catalogue alone runs at the moment there is still no record, and registers
   * nothing at all. Found on a bench server; this is the shape of it.
   */
  it('registers nothing until the record exists, and everything once it does', () => {
    const registry = new ConnectionTypeRegistry()
    const decl = bearer()
    let record: { connection?: ConnectionDecl } | undefined
    const entries: [string, { manifest: never; source: 'installed' }][] =
      [['homey-flows', { manifest: { connection: decl } as never, source: 'installed' }]]
    const sync = (): void => syncDeclaredTypes(
      registry,
      declaredFromCatalog(entries, () => ({ connection: record?.connection } as never)),
    )

    // The folder is there, the record is not: the state right after `catalog.scan()`.
    sync()
    expect(registry.get('decl:homey-flows:homey-flows')).toBeUndefined()

    // The record lands, and the second sync is the one that matters.
    record = { connection: decl }
    sync()
    expect(registry.get('decl:homey-flows:homey-flows')).toBeDefined()
  })
})

describe('the guard the connection save applies', () => {
  it('refuses a declared type whose address is not an address', () => {
    // The route's own expression, as a function: a declared type exists only while a widget
    // that declares it is installed, so the route cannot be reached from a connections test.
    for (const host of ['10.0.0.1:x@evil.example', 'user:pw@evil.example', '10.0.0.1/../x', '10.0.0.1?a=b', '']) {
      expect(rejectsHost('decl:w:thing', { host }), host).toBe(true)
    }
    expect(rejectsHost('decl:w:thing', { host: '192.168.1.40:9123' })).toBe(false)
    expect(rejectsHost('decl:w:thing', undefined)).toBe(true)
  })

  it('leaves a coded type alone, whose host means whatever its own code decides', () => {
    // An ICS calendar's "host" is a whole URL; a Bambu has none at all.
    expect(rejectsHost('ics', { host: 'https://example.com/cal.ics?x=1' })).toBe(false)
    expect(rejectsHost('bambu', {})).toBe(false)
  })
})
