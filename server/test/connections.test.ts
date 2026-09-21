import { ConnCache } from '../src/proxy/conn.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { OptionsError, type ConnectionType } from '../src/connections/types.js'

let tested: { fields: Record<string, string>; secrets: Record<string, string> } | null = null
let optioned: { source: string; fields: Record<string, string>; secrets: Record<string, string> } | null = null

const fakeType: ConnectionType = {
  id: 'azure-devops',
  name: 'Azure DevOps',
  description: { fr: 'Runs de pipeline', en: 'Pipeline runs' },
  icon: 'layout-grid',
  fields: [
    { key: 'organization', label: { fr: 'Organisation', en: 'Organization' }, required: true, placeholder: 'contoso' },
    { key: 'project', label: { fr: 'Projet', en: 'Project' }, required: true },
    // A plain string still works: a type that never got a translation is shown as written.
    { key: 'pat', label: 'Jeton d’accès', secret: true, required: true, help: 'Droit Build (lecture)' },
  ],
  test: async (fields, secrets) => {
    tested = { fields, secrets }
    return secrets.pat === 'token-1' ? { ok: true, detail: 'Connexion établie' } : { ok: false, error: 'PAT refusé' }
  },
  options: async (source, fields, secrets) => {
    optioned = { source, fields, secrets }
    if (source === 'pipelines') return [{ value: 'p1', label: 'Nightly', group: 'Build', hint: 'yaml' }]
    // Two ways of failing, so the route can be checked on both: a refusal it should pass through,
    // and a leak it must swallow.
    if (source === 'down') throw new OptionsError(502, 'serveur injoignable')
    if (source === 'boom') throw new Error(`leaky ${secrets.pat}`)
    throw new OptionsError(400, `source inconnue : ${source}`)
  },
  createProvider: (ctx) => ({ channel: ctx.channel, intervalMs: 1000, poll: async () => ({ ok: true }) }),
}

let bambuTested: { fields: Record<string, string>; secrets: Record<string, string> } | null = null

/** A second type, so a test call can be aimed at a type other than the stored one. */
const otherType: ConnectionType = {
  id: 'bambu',
  name: 'Bambu Lab',
  description: 'Imprimante',
  icon: 'layout-grid',
  // The access code belongs to one printer: moving the connection to another serial means
  // re-entering it.
  secretBindings: ['serial'],
  fields: [
    { key: 'serial', label: 'Numéro de série', required: true },
    { key: 'code', label: 'Code d’accès', secret: true, required: true },
  ],
  test: async (fields, secrets) => {
    bambuTested = { fields, secrets }
    return { ok: true, detail: 'Connexion établie' }
  },
}

// Pinned to French: the assertions below are about the exact wording of each refusal, so they
// must not follow whatever language the machine running the suite would pick. `buildEn` covers
// the other side.
const CONFIG = {
  version: 2,
  locale: 'fr',
  display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 },
  connections: [],
  secrets: { backend: 'file' },
  pages: [{ id: 'home', name: 'Accueil', widgets: [] }],
}

let app: FastifyInstance
let connCache: ConnCache
let dataDir: string

beforeEach(async () => {
  tested = null
  optioned = null
  bambuTested = null
  dataDir = await mkdtemp(join(tmpdir(), 'fremkit-conn-'))
  await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify(CONFIG), 'utf8')
  connCache = new ConnCache()
  app = await buildApp({ dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [fakeType, otherType], connCache })
})
afterEach(async () => { await app.close() })

const put = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/connections/${id}`, payload })

/** A second app on its own data dir, configured in English. The caller closes it. */
async function buildEn(): Promise<FastifyInstance> {
  const dir = await mkdtemp(join(tmpdir(), 'fremkit-conn-en-'))
  await writeFile(join(dir, 'fremkit.json'), JSON.stringify({ ...CONFIG, locale: 'en' }), 'utf8')
  return buildApp({ dataDir: dir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [fakeType, otherType] })
}

describe('GET /api/connections/types', () => {
  it('describes the fields of each type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections/types' })
    expect(res.statusCode).toBe(200)
    const [type] = res.json()
    expect(type.id).toBe('azure-devops')
    expect(type.fields.map((f: { key: string }) => f.key)).toEqual(['organization', 'project', 'pat'])
    expect(type.fields[2].secret).toBe(true)
    expect(type.description).toBe('Runs de pipeline')
    expect(type.fields[0].label).toBe('Organisation')
  })

  it('resolves every text to the language the config asks for', async () => {
    const en = await buildEn()
    try {
      const [type] = (await en.inject({ method: 'GET', url: '/api/connections/types' })).json()
      expect(type.description).toBe('Pipeline runs')
      expect(type.fields[0].label).toBe('Organization')
      // Untranslated texts are served exactly as the type wrote them.
      expect(type.fields[2].label).toBe('Jeton d’accès')
      expect(type.fields[0].placeholder).toBe('contoso')
    } finally {
      await en.close()
    }
  })
})

describe('PUT /api/connections/:id', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  it('creates a connection and never echoes the secret', async () => {
    const res = await put('ado-x1z9', body)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields: body.fields, secrets: { pat: true } })
    expect(res.body).not.toContain('token-1')
  })

  it('keeps the connection out of the config file but keeps the fields in it', async () => {
    await put('ado-x1z9', body)
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    expect(config.connections).toEqual([{ id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields: body.fields }])
    expect(JSON.stringify(config)).not.toContain('token-1')
  })

  it('keeps a stored secret that the update leaves out', async () => {
    await put('ado-x1z9', body)
    const res = await put('ado-x1z9', { ...body, name: 'Travail (2)', secrets: undefined })
    expect(res.statusCode).toBe(200)
    expect(res.json().secrets).toEqual({ pat: true })
  })

  it('treats an empty secret as a deletion, which a required field refuses', async () => {
    await put('ado-x1z9', body)
    const res = await put('ado-x1z9', { ...body, secrets: { pat: '' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('le champ « Jeton d’accès » est obligatoire')
  })

  it('refuses a missing required field', async () => {
    const res = await put('ado-x1z9', { ...body, fields: { organization: 'example-org' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('le champ « Projet » est obligatoire')
  })

  it('refuses an unknown field key', async () => {
    const res = await put('ado-x1z9', { ...body, fields: { ...body.fields, nope: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('champ inconnu pour le type azure-devops : nope')
  })

  it('refuses a secret passed as a plain field', async () => {
    const res = await put('ado-x1z9', { ...body, fields: { ...body.fields, pat: 'token-1' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('le champ « pat » est secret et ne peut pas être enregistré en clair')
  })

  it('refuses an unknown type and a malformed id', async () => {
    expect((await put('ado-x1z9', { ...body, type: 'nope' })).statusCode).toBe(400)
    expect((await put('Ado X', body)).statusCode).toBe(400)
  })
})

describe('GET /api/connections', () => {
  it('masks every secret with a boolean', async () => {
    await put('ado-x1z9', { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } })
    const res = await app.inject({ method: 'GET', url: '/api/connections' })
    expect(res.json()).toEqual([{
      id: 'ado-x1z9', type: 'azure-devops', name: 'Travail',
      fields: { organization: 'example-org', project: 'example-project' },
      secrets: { pat: true },
      // Empty for every connection nobody shared, which is almost all of them.
      sharedWith: [],
    }])
  })

  it('clears what the proxy cached for a connection when it is saved or deleted', async () => {
    // A cached answer was fetched with the address and the credential that were there then; a
    // save may have changed either. Asserted through the routes, which is where it has to run.
    await put('ado-x1z9', { type: 'azure-devops', name: 'T', fields: { organization: 'o', project: 'p' }, secrets: { pat: 't' } })
    connCache.put('ado-x1z9', '/a', { status: 200, body: Buffer.from('cached'), json: false })
    await put('ado-x1z9', { type: 'azure-devops', name: 'T', fields: { organization: 'other', project: 'p' }, secrets: { pat: 't' } })
    expect(connCache.get('ado-x1z9', '/a', 60_000)).toBeUndefined()

    connCache.put('ado-x1z9', '/a', { status: 200, body: Buffer.from('cached'), json: false })
    expect((await app.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9' })).statusCode).toBe(204)
    expect(connCache.get('ado-x1z9', '/a', 60_000)).toBeUndefined()
  })

  it('names the widgets a declared connection was shared with', async () => {
    // The route does not care what kind of type it is; the grant lives on the widget's record.
    await put('homey-x1', { type: 'azure-devops', name: 'Homey', fields: { organization: 'o', project: 'p' }, secrets: { pat: 't' } })
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    config.marketplace = { installed: {
      'homey-devices': {
        kind: 'widget', version: '1.0.0', registry: 'r', installedAt: 'x',
        sharedConnections: ['homey-x1'],
        consentedPermissions: { subscriptions: [], commands: [], network: [] },
      },
    } }
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: config })).statusCode).toBe(200)

    const body = (await app.inject({ method: 'GET', url: '/api/connections' })).json()
    expect(body.find((c: { id: string }) => c.id === 'homey-x1').sharedWith).toEqual(['homey-devices'])
  })
})

describe('GET /api/connections/:id/options', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }
  const options = (id: string, source: string) =>
    app.inject({ method: 'GET', url: `/api/connections/${id}/options?source=${source}` })

  it('serves what the type lists, with the stored fields and secrets', async () => {
    await put('ado-x1z9', body)
    const res = await options('ado-x1z9', 'pipelines')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ value: 'p1', label: 'Nightly', group: 'Build', hint: 'yaml' }])
    expect(optioned).toEqual({ source: 'pipelines', fields: body.fields, secrets: { pat: 'token-1' } })
  })

  it('404s on an unknown connection', async () => {
    expect((await options('ghost', 'pipelines')).statusCode).toBe(404)
  })

  it('400s when the type lists nothing', async () => {
    await put('bambu-x1', { type: 'bambu', name: 'Imprimante', fields: { serial: 'S1' }, secrets: { code: 'c' } })
    const res = await options('bambu-x1', 'pipelines')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('bambu')
  })

  it('400s on an unknown source, and on a missing one', async () => {
    await put('ado-x1z9', body)
    expect((await options('ado-x1z9', 'zones')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/connections/ado-x1z9/options' })).statusCode).toBe(400)
  })

  it('passes a refusal through as a 502', async () => {
    await put('ado-x1z9', body)
    const res = await options('ado-x1z9', 'down')
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'serveur injoignable' })
  })

  it('swallows an error the type did not sanitise, secret and all', async () => {
    await put('ado-x1z9', body)
    const res = await options('ado-x1z9', 'boom')
    expect(res.statusCode).toBe(502)
    expect(res.payload).not.toContain('token-1')
  })
})

describe('POST /api/connections/:id/test', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  it('delegates to the type with the stored values', async () => {
    await put('ado-x1z9', body)
    const res = await app.inject({ method: 'POST', url: '/api/connections/ado-x1z9/test', payload: {} })
    expect(res.json()).toEqual({ ok: true, detail: 'Connexion établie' })
    expect(tested).toEqual({ fields: body.fields, secrets: { pat: 'token-1' } })
  })

  it('lets the admin test values that are not saved yet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/ado-new/test',
      payload: { type: 'azure-devops', fields: body.fields, secrets: { pat: 'wrong' } },
    })
    expect(res.json()).toEqual({ ok: false, error: 'PAT refusé' })
  })

  it('404s on an unknown connection with no body to test', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/connections/ghost/test', payload: {} })).statusCode).toBe(404)
  })
})

describe('DELETE /api/connections/:id', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  it('removes the connection and its secrets', async () => {
    await put('ado-x1z9', body)
    expect((await app.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9' })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).json()).toEqual([])
  })

  it('refuses with 409 while a widget still points at it', async () => {
    await put('ado-x1z9', body)
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    config.pages[0].widgets.push({
      instanceId: 'ado-1', widgetId: 'ado-pipelines', x: 0, y: 0, w: 16, h: 8,
      showTitle: true, settings: { connection: 'ado-x1z9' },
    })
    await app.inject({ method: 'PUT', url: '/api/config', payload: config })
    const res = await app.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/Accueil/)
  })

  it('refuses with 409 while a widget lists it among several', async () => {
    await put('ado-x1z9', body)
    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    // `calendar` declares a `connections` setting: the id sits in an array, not in a string.
    config.pages[0].widgets.push({
      instanceId: 'cal-1', widgetId: 'calendar', x: 0, y: 0, w: 16, h: 10,
      showTitle: true, settings: { calendars: ['other', 'ado-x1z9'] },
    })
    await app.inject({ method: 'PUT', url: '/api/config', payload: config })
    const res = await app.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/calendar/)
  })

  it('404s on an unknown connection', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/connections/ghost' })).statusCode).toBe(404)
  })
})

describe('connection API hardening', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  it('refuses to change the type of an existing connection', async () => {
    await put('ado-x1z9', body)
    const res = await put('ado-x1z9', { type: 'bambu', name: 'Travail', fields: { serial: 'PRINTER-1' }, secrets: { code: 'c' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('le type d’une connexion existante ne peut pas changer')
  })

  it('reserves the id used by the types route', async () => {
    expect((await put('types', body)).statusCode).toBe(400)
    expect((await app.inject({ method: 'DELETE', url: '/api/connections/types' })).statusCode).toBe(400)
  })

  it('lets two overlapping writes both land', async () => {
    const [a, b] = await Promise.all([
      put('ado-x1z9', body),
      put('ado-y2w8', { ...body, name: 'Perso' }),
    ])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    const ids = (await app.inject({ method: 'GET', url: '/api/connections' })).json().map((c: { id: string }) => c.id)
    expect(ids.sort()).toEqual(['ado-x1z9', 'ado-y2w8'])
  })

  it('never hands the secrets of one type to another type test', async () => {
    await put('ado-x1z9', body)
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/ado-x1z9/test',
      payload: { type: 'bambu', fields: { serial: 'PRINTER-1' }, secrets: { code: 'c' } },
    })
    expect(res.statusCode).toBe(200)
    expect(bambuTested).toEqual({ fields: { serial: 'PRINTER-1' }, secrets: { code: 'c' } })
  })

  it('validates the submitted fields before testing them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/ado-new/test',
      payload: { type: 'azure-devops', fields: { ...body.fields, nope: 'x' }, secrets: { pat: 'token-1' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('champ inconnu pour le type azure-devops : nope')
    expect(tested).toBeNull()
  })

  it('refuses to test a required field that is neither submitted nor stored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections/ado-new/test',
      payload: { type: 'azure-devops', fields: { organization: 'example-org' }, secrets: { pat: 'token-1' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain('le champ « Projet » est obligatoire')
  })

  it('400s on an unknown type in the test body, and still 404s on an unknown connection', async () => {
    const unknownType = await app.inject({ method: 'POST', url: '/api/connections/ado-new/test', payload: { type: 'nope' } })
    expect(unknownType.statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/connections/ghost/test', payload: {} })).statusCode).toBe(404)
  })
})

describe('a stored secret never follows a changed destination', () => {
  const bambu = { type: 'bambu', name: 'Imprimante', fields: { serial: 'PRINTER-1' }, secrets: { code: 'code-1' } }
  const bound = 'le secret enregistré est lié au champ « Numéro de série » : ressaisissez-le pour le changer'
  const stored = async () => (await app.inject({ method: 'GET', url: '/api/connections' })).json()
    .find((c: { id: string }) => c.id === 'bambu-x1')

  beforeEach(async () => { await put('bambu-x1', bambu) })

  it('refuses a PUT that moves the destination and keeps the secret', async () => {
    const res = await put('bambu-x1', { type: 'bambu', name: 'Imprimante', fields: { serial: 'PRINTER-2' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain(bound)
    // Nothing moved: neither the field nor the secret.
    expect((await stored()).fields.serial).toBe('PRINTER-1')
    expect((await stored()).secrets.code).toBe(true)
  })

  it('accepts the move when the secret comes with it', async () => {
    const res = await put('bambu-x1', { type: 'bambu', name: 'Imprimante', fields: { serial: 'PRINTER-2' }, secrets: { code: 'code-2' } })
    expect(res.statusCode).toBe(200)
    expect((await stored()).fields.serial).toBe('PRINTER-2')
  })

  it('accepts the move when the secret is being forgotten', async () => {
    const res = await put('bambu-x1', { type: 'bambu', name: 'Imprimante', fields: { serial: 'PRINTER-2' }, secrets: { code: '' } })
    // The code is required, so the form is incomplete — but not for the binding reason.
    expect(res.json().errors ?? []).not.toContain(bound)
  })

  it('lets an ordinary edit leave the secret alone', async () => {
    const res = await put('bambu-x1', { type: 'bambu', name: 'Salon', fields: { serial: 'PRINTER-1' } })
    expect(res.statusCode).toBe(200)
    expect((await stored()).name).toBe('Salon')
    expect((await stored()).secrets.code).toBe(true)
  })

  it('refuses a test that points the stored secret at another destination', async () => {
    bambuTested = null
    const res = await app.inject({ method: 'POST', url: '/api/connections/bambu-x1/test',
      payload: { type: 'bambu', fields: { serial: 'PRINTER-2' } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors).toContain(bound)
    expect(bambuTested).toBeNull()
  })

  it('tests the new destination once the secret is resubmitted', async () => {
    bambuTested = null
    const res = await app.inject({ method: 'POST', url: '/api/connections/bambu-x1/test',
      payload: { type: 'bambu', fields: { serial: 'PRINTER-2' }, secrets: { code: 'code-2' } } })
    expect(res.statusCode).toBe(200)
    expect(bambuTested).toEqual({ fields: { serial: 'PRINTER-2' }, secrets: { code: 'code-2' } })
  })

  it('still tests the stored destination with the stored secret', async () => {
    bambuTested = null
    const res = await app.inject({ method: 'POST', url: '/api/connections/bambu-x1/test',
      payload: { type: 'bambu', fields: { serial: 'PRINTER-1' } } })
    expect(res.statusCode).toBe(200)
    expect(bambuTested).toEqual({ fields: { serial: 'PRINTER-1' }, secrets: { code: 'code-1' } })
  })

  it('says so in English too', async () => {
    const en = await buildEn()
    await en.inject({ method: 'PUT', url: '/api/connections/bambu-x1', payload: bambu })
    const res = await en.inject({ method: 'PUT', url: '/api/connections/bambu-x1',
      payload: { type: 'bambu', name: 'Imprimante', fields: { serial: 'PRINTER-2' } } })
    expect(res.json().errors).toContain('the stored secret is tied to the “Numéro de série” field: re-enter it to change it')
    await en.close()
  })

  it('leaves a type with nothing to bind alone', async () => {
    const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }
    await put('ado-x1z9', body)
    // The PAT never leaves dev.azure.com, so the organisation is free to change.
    const res = await put('ado-x1z9', { ...body, fields: { organization: 'other-org', project: 'p' }, secrets: undefined })
    expect(res.statusCode).toBe(200)
  })
})

describe('the real connection types bind their secrets', () => {
  it('names the fields that decide where each secret is sent', async () => {
    const { defaultConnectionTypes } = await import('../src/connections/types/index.js')
    const bindings = Object.fromEntries(defaultConnectionTypes().map((t) => [t.id, t.secretBindings ?? []]))
    expect(bindings).toEqual({
      github: ['host'],
      homey: ['host'],
      bambu: ['host', 'serial'],
      // The password, the one-time code and the device token are issued for one NAS.
      synology: ['host'],
      // dev.azure.com is hardcoded, and an ICS calendar's URL *is* its secret.
      'azure-devops': [],
      ics: [],
    })
    // Every bound key must be a real, non-secret field of its type.
    for (const type of defaultConnectionTypes()) {
      for (const key of type.secretBindings ?? []) {
        expect(type.fields.find((f) => f.key === key && !f.secret), `${type.id}.${key}`).toBeTruthy()
      }
    }
  })
})

describe('PUT /api/config and connections', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  /** The config as the admin reads it, which is what it sends back on a save. */
  const readConfig = async () => (await app.inject({ method: 'GET', url: '/api/config' })).json()
  const listed = async () => (await app.inject({ method: 'GET', url: '/api/connections' })).json()

  it('ignores the connections a config save carries', async () => {
    await put('ado-x1z9', body)
    const cfg = await readConfig()
    // The host a stored PAT would follow, and a second connection out of nowhere.
    cfg.connections = [
      { id: 'ado-x1z9', type: 'azure-devops', name: 'Travail', fields: { organization: 'evil-org', project: 'p' } },
      { id: 'ado-new', type: 'azure-devops', name: 'Injecté', fields: { organization: 'o', project: 'p' } },
    ]
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: cfg })
    expect(res.statusCode).toBe(200)
    expect(res.json().connections).toEqual((await readConfig()).connections)
    const after = await listed()
    expect(after.map((c: { id: string }) => c.id)).toEqual(['ado-x1z9'])
    expect(after[0].fields.organization).toBe('example-org')
  })

  it('ignores the secrets backend a config save carries', async () => {
    const cfg = await readConfig()
    expect(cfg.secrets.backend).toBe('file')
    cfg.secrets = { backend: 'keychain' }
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: cfg })
    expect(res.statusCode).toBe(200)
    expect(res.json().secrets.backend).toBe('file')
  })

  it('still saves everything else in the same request', async () => {
    await put('ado-x1z9', body)
    const cfg = await readConfig()
    cfg.pages = [{ id: 'other', name: 'Autre', widgets: [] }]
    cfg.connections = []
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: cfg })).statusCode).toBe(200)
    const saved = await readConfig()
    expect(saved.pages[0].id).toBe('other')
    expect(saved.connections.map((c: { id: string }) => c.id)).toEqual(['ado-x1z9'])
  })
})

describe('origin check', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }
  const foreign = { origin: 'http://evil.example' }

  it('refuses a write from a foreign origin', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/connections/ado-x1z9', payload: body, headers: foreign })
    expect(res.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).json()).toEqual([])
  })

  it('refuses a delete and a test from a foreign origin', async () => {
    await put('ado-x1z9', body)
    expect((await app.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9', headers: foreign })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/connections/ado-x1z9/test', payload: {}, headers: foreign })).statusCode).toBe(403)
  })

  it('accepts a write with no origin and one from the dashboard itself', async () => {
    expect((await put('ado-x1z9', body)).statusCode).toBe(200)
    const res = await app.inject({ method: 'PUT', url: '/api/connections/ado-x1z9', payload: body, headers: { origin: 'http://127.0.0.1:4242' } })
    expect(res.statusCode).toBe(200)
  })

  it('still serves reads from anywhere', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/connections/types', headers: foreign })).statusCode).toBe(200)
  })
})

describe('connection errors in English', () => {
  it('reports a missing required field in the configured language', async () => {
    const en = await buildEn()
    try {
      const res = await en.inject({ method: 'PUT', url: '/api/connections/ado-x1z9', payload: { type: 'azure-devops', name: 'Work', fields: { organization: 'example-org' }, secrets: { pat: 'token-1' } } })
      expect(res.statusCode).toBe(400)
      expect(res.json().errors).toContain('the “Project” field is required')
    } finally {
      await en.close()
    }
  })
})

describe('the connections API while the config on disk is unreadable', () => {
  const body = { type: 'azure-devops', name: 'Travail', fields: { organization: 'example-org', project: 'example-project' }, secrets: { pat: 'token-1' } }

  /** An app whose config file holds a version it cannot migrate: the store loads degraded. */
  async function degraded(): Promise<{ app: FastifyInstance; dir: string; onDisk: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-degraded-'))
    const onDisk = JSON.stringify({ version: 99, pages: [{ id: 'mine', name: 'Mienne' }] })
    await writeFile(join(dir, 'fremkit.json'), onDisk, 'utf8')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const built = await buildApp({ dataDir: dir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [fakeType, otherType] })
    err.mockRestore()
    return { app: built, dir, onDisk }
  }

  it('refuses to write a connection, and never touches the file', async () => {
    const { app: bad, dir, onDisk } = await degraded()
    expect((await bad.inject({ url: '/api/config/status' })).json()).toEqual({ degraded: true })
    const res = await bad.inject({ method: 'PUT', url: '/api/connections/ado-x1z9', payload: body })
    expect(res.statusCode).toBe(409)
    expect(res.json().errors[0]).toMatch(/illisible|unreadable/)
    // The rule that matters: the user's own file is still exactly as it was.
    expect(await readFile(join(dir, 'fremkit.json'), 'utf8')).toBe(onDisk)
    await bad.close()
  })

  it('refuses to delete one too', async () => {
    const { app: bad, dir, onDisk } = await degraded()
    const res = await bad.inject({ method: 'DELETE', url: '/api/connections/ado-x1z9' })
    // Nothing to delete in the default config, so a 404 is right — what must not happen is a write.
    expect([404, 409]).toContain(res.statusCode)
    expect(await readFile(join(dir, 'fremkit.json'), 'utf8')).toBe(onDisk)
    await bad.close()
  })

  it('still answers the reads, so the admin can say what is wrong', async () => {
    const { app: bad } = await degraded()
    expect((await bad.inject({ url: '/api/connections' })).statusCode).toBe(200)
    expect((await bad.inject({ url: '/api/connections/types' })).statusCode).toBe(200)
    await bad.close()
  })
})
