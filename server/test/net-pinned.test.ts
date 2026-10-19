import { describe, it, expect } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { guardedLookup, PrivateAddressError } from '../src/net/pinned.js'

/** A resolver that answers `addresses`, for every name. */
const answering = (addresses: LookupAddress[]) =>
  (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => cb(null, addresses)

function run(addresses: LookupAddress[], all: boolean): Promise<{ err: Error | null; result: unknown }> {
  return new Promise((resolve) => {
    guardedLookup(answering(addresses))('rebind.example', { all } as never, (err, result) => resolve({ err, result }))
  })
}

describe('guardedLookup', () => {
  it('hands back what it checked when every address is public', async () => {
    const one = await run([{ address: '198.51.100.7', family: 4 }], false)
    expect(one.err).toBeNull()
    expect(one.result).toBe('198.51.100.7')
    const all = await run([{ address: '198.51.100.7', family: 4 }, { address: '2001:db8::1', family: 6 }], true)
    expect(all.err).toBeNull()
    expect(all.result).toHaveLength(2)
  })
  it('refuses the lot when any address is private, in any spelling', async () => {
    for (const address of ['127.0.0.1', '192.0.2.1', '10.1.0.1', '::1', 'fe80::1', '::ffff:7f00:1', '169.254.169.254']) {
      const { err } = await run([{ address: '198.51.100.7', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }], true)
      expect(err, address).toBeInstanceOf(PrivateAddressError)
    }
  })
  it('refuses a name with no address at all', async () => {
    expect((await run([], false)).err).toBeInstanceOf(PrivateAddressError)
  })
})

describe('loading undici', () => {
  // A fresh process, because the global dispatcher is claimed once per process: a vitest worker
  // has long since used fetch by the time this file runs. And HTTP/2 over TLS, because that is
  // where it broke — GitHub, Azure DevOps and the Claude API answer h2; an HTTP/1.1 test passes
  // on the broken code too.
  it('leaves the global fetch decoding gzip answers, as at server start', async () => {
    const { createSecureServer } = await import('node:http2')
    const { gzipSync } = await import('node:zlib')
    const { generateKeyPairSync } = await import('node:crypto')
    const { execFile } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const { issueCertificate } = await import('../src/devices/certificate.js')
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const cert = await issueCertificate(key, { host: 'localhost', addresses: ['127.0.0.1'] })
    const server = createSecureServer({ key, cert, allowHTTP1: true }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync(JSON.stringify({ ok: true })))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}/`
    const pinned = fileURLToPath(new URL('../src/net/pinned.ts', import.meta.url))
    // What the server does under tsx: the module is loaded as CommonJS before any fetch, then
    // something publicFetches, then a provider uses the global fetch.
    const script = `import(${JSON.stringify(pinned)})
      .then((m) => m.publicFetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()))
      .then(() => fetch(${JSON.stringify(url)})).then((r) => r.json())
      .then((j) => console.log(JSON.stringify(j)), (e) => { console.error(e.message); process.exit(1) })`
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(tsx, ['-e', script], { timeout: 20_000, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' } },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))))
      expect(JSON.parse(out.trim())).toEqual({ ok: true })
    } finally {
      server.close()
    }
  }, 30_000)
})
