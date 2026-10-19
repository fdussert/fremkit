import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures/test.js'
import { ROOT } from '../fixtures/server.js'

/** What answers without the session, by design (`server/src/http/access.ts`, PUBLIC_ROUTES). */
const PUBLIC = new Set(['GET /auth', 'GET /auth/proof', 'GET /fremkit.js', 'GET /widgets/:id/*'])
/**
 * The browser companion's routes skip the session too (`COMPANION_ROUTES` in the same file): an
 * extension cannot read the secret. Without an extension's `Origin` they answer 403 instead.
 */
const COMPANION = new Set(['POST /api/companion/pair', 'POST /api/companion/pair/e2e', 'POST /api/companion/pair/e2e/confirm', 'GET /companion/ws'])

/**
 * Every route the server registers, read from its sources, so a route added tomorrow is in this
 * sweep without anybody listing it. Parameters get a placeholder value.
 */
async function serverRoutes(): Promise<{ method: string; path: string }[]> {
  const out = new Map<string, { method: string; path: string }>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      const text = await readFile(full, 'utf8')
      for (const m of text.matchAll(/app\.(get|post|put|delete|patch)(?:<[^(]*>)?\(\s*'([^']+)'/g)) {
        const method = m[1].toUpperCase()
        if (PUBLIC.has(`${method} ${m[2]}`)) continue
        const path = m[2].replace(/:[A-Za-z]+/g, 'e2e').replace(/\*$/, 'index.html')
        out.set(`${method} ${path}`, { method, path })
      }
    }
  }
  await walk(join(ROOT, 'server', 'src'))
  return [...out.values()]
}

test('nothing answers without the session but 401, the public routes aside', async ({ playwright, server }) => {
  const routes = await serverRoutes()
  expect(routes.length).toBeGreaterThan(40)
  // The pages and files of the UI, and paths nothing serves, are behind the same gate.
  routes.push(
    { method: 'GET', path: '/' }, { method: 'GET', path: '/admin' }, { method: 'GET', path: '/index.html' },
    { method: 'GET', path: '/assets/e2e.js' }, { method: 'GET', path: '/api/nothing-here' }, { method: 'POST', path: '/nothing-here' },
  )
  const anonymous = await playwright.request.newContext({ baseURL: server.baseURL })
  const wrongBearer = await playwright.request.newContext({
    baseURL: server.baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${'A'.repeat(43)}`, Cookie: `fremkit_access_${server.port}=${'B'.repeat(43)}` },
  })
  const refused: string[] = []
  for (const client of [anonymous, wrongBearer]) {
    for (const { method, path } of routes) {
      const res = await client.fetch(path, { method, data: method === 'GET' ? undefined : {}, maxRedirects: 0 })
      const expected = COMPANION.has(`${method} ${path}`) ? 403 : 401
      if (res.status() !== expected) refused.push(`${method} ${path} → ${res.status()}`)
    }
  }
  expect(refused).toEqual([])
  expect(routes.filter((r) => COMPANION.has(`${r.method} ${r.path}`))).toHaveLength(COMPANION.size)

  // The public ones do answer, and `/auth` with a code that was never issued still refuses.
  expect((await anonymous.get('/fremkit.js')).status()).toBe(200)
  expect((await anonymous.get('/widgets/clock/index.html')).status()).toBe(200)
  expect((await anonymous.get(`/auth?code=${'C'.repeat(43)}&next=/admin`, { maxRedirects: 0 })).status()).toBe(401)
  await anonymous.dispose()
  await wrongBearer.dispose()
})

test('the host pages send their CSP, and widget documents a sandbox of their own', async ({ api, server }) => {
  for (const path of ['/', '/admin']) {
    const res = await api.get(path)
    expect(res.status()).toBe(200)
    const csp = res.headers()['content-security-policy'] ?? ''
    expect(csp, path).toContain("script-src 'self'")
    expect(csp, path).toContain("frame-ancestors 'none'")
    expect(csp, path).toContain("object-src 'none'")
    // Frames may load the widgets and nothing else.
    expect(csp, path).toContain(`frame-src http://127.0.0.1:${server.port}/widgets/`)
  }
  const widget = await api.get('/widgets/clock/index.html')
  const csp = widget.headers()['content-security-policy'] ?? ''
  expect(csp).toContain('sandbox allow-scripts')
  expect(csp).not.toContain('allow-same-origin')
  expect(csp).toContain("connect-src 'none'")
})
