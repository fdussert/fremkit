import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { HELPER_ADMIN_URL, HELPER_BUNDLE_ID, helperRoutes, LSAPPINFO_PROGRAM, OPEN_PROGRAM, runningHelperPath, type Runner } from '../src/helper/routes.js'

const HELPER_PATH = '/Users/example/Applications/Fremkit Helper.app'
const ASN = 'ASN:0x0-0x9c7d673a-"Fremkit_Helper":'
/** `lsappinfo find` lists one ASN per running copy, separated by spaces. */
const FIND_OUT = `${ASN} ASN:0x0-0xa98787cf-"Fremkit_Helper":\n`
const INFO_OUT = `"LSBundlePath"="${HELPER_PATH}"\n`

let app: FastifyInstance | undefined

/** Registers the route on a bare server with a fake runner, and records what it was asked to run. */
async function build(run: Runner): Promise<FastifyInstance> {
  const server = Fastify({ logger: false })
  await server.register(helperRoutes, { run })
  await server.ready()
  app = server
  return server
}

/** A runner that reports a running helper and notes every call. */
function fakeRunner(calls: [string, string[]][], open?: () => Promise<string>): Runner {
  return async (file, args) => {
    calls.push([file, args])
    if (file === LSAPPINFO_PROGRAM) return args[0] === 'find' ? FIND_OUT : INFO_OUT
    return open ? await open() : ''
  }
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('runningHelperPath', () => {
  it('reads the bundle path of the first running helper', async () => {
    const calls: [string, string[]][] = []
    expect(await runningHelperPath(fakeRunner(calls))).toBe(HELPER_PATH)
    expect(calls).toEqual([
      [LSAPPINFO_PROGRAM, ['find', `bundleid=${HELPER_BUNDLE_ID}`]],
      [LSAPPINFO_PROGRAM, ['info', '-only', 'bundlepath', ASN]],
    ])
  })

  it('reports nothing when no helper runs, or when lsappinfo fails', async () => {
    expect(await runningHelperPath(async () => '')).toBeUndefined()
    expect(await runningHelperPath(async () => { throw new Error('nope') })).toBeUndefined()
  })
})

describe('POST /api/helper/admin', () => {
  it('sends the URL to the running helper by path and answers ok', async () => {
    const calls: [string, string[]][] = []
    const server = await build(fakeRunner(calls))

    const res = await server.inject({
      method: 'POST',
      url: '/api/helper/admin',
      headers: { origin: 'http://127.0.0.1:4242' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls[2]).toEqual([OPEN_PROGRAM, ['-a', HELPER_PATH, HELPER_ADMIN_URL]])
  })

  it('falls back to the bundle id when no helper is running', async () => {
    const calls: [string, string[]][] = []
    const server = await build(async (file, args) => { calls.push([file, args]); return '' })

    const res = await server.inject({ method: 'POST', url: '/api/helper/admin' })

    expect(res.statusCode).toBe(200)
    expect(calls.at(-1)).toEqual([OPEN_PROGRAM, ['-b', HELPER_BUNDLE_ID, HELPER_ADMIN_URL]])
  })

  it('answers 503 when open fails, without quoting the raw error', async () => {
    const server = await build(fakeRunner([], async () => { throw new Error('LSOpenURLsWithRole() failed') }))

    const res = await server.inject({ method: 'POST', url: '/api/helper/admin' })

    expect(res.statusCode).toBe(503)
    expect(res.payload).not.toContain('LSOpenURLsWithRole')
  })

  it('refuses a foreign origin without running anything', async () => {
    const calls: [string, string[]][] = []
    const server = await build(fakeRunner(calls))

    const res = await server.inject({
      method: 'POST',
      url: '/api/helper/admin',
      headers: { origin: 'http://evil.example' },
    })

    expect(res.statusCode).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses a request from another machine', async () => {
    const calls: [string, string[]][] = []
    const server = await build(fakeRunner(calls))

    const res = await server.inject({ method: 'POST', url: '/api/helper/admin', remoteAddress: '198.51.100.7' })

    expect(res.statusCode).toBe(403)
    expect(calls).toEqual([])
  })
})
