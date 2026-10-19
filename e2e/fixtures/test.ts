/**
 * The fixtures every spec uses.
 *
 * - `server` (per worker): a throwaway server, see `server.ts`.
 * - `api` (per test): requests that carry the access secret, for seeding and for reading back
 *   what the admin saved.
 * - `seed` / `connections` (options): the state the test starts from. Before every test the
 *   server is put back to it, so tests sharing a worker never see each other's edits.
 * - `signIn(next)`: a one-time code from `POST /api/auth/code`, redeemed by the browser at
 *   `/auth?code=…`, which sets the session cookie and lands on `next`.
 */
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test'
import { baseConfig, type ConfigSeed } from './seeds.js'
import { FIRST_PORT, startServer, type RunningServer } from './server.js'

export interface ConnectionSeed {
  id: string
  type: string
  name: string
  fields?: Record<string, string>
  secrets?: Record<string, string>
}

interface WorkerFixtures {
  server: RunningServer
  /** Hostile widgets to load from the dev folder; a different value gets a server of its own. */
  devWidgets: string[]
}

interface TestFixtures {
  api: APIRequestContext
  seed: ConfigSeed
  connections: ConnectionSeed[]
  /** Put the server back to `seed` and `connections`. Runs before every test. */
  reset: void
  signIn: (next?: string) => Promise<void>
  /** Signs in and opens the editor, ready to edit. */
  openAdmin: () => Promise<void>
  /** The config as the server holds it now. */
  savedConfig: () => Promise<ConfigSeed>
}

export async function putConfig(api: APIRequestContext, config: unknown): Promise<void> {
  const res = await api.put('/api/config', { data: config })
  if (!res.ok()) throw new Error(`PUT /api/config: ${res.status()} ${await res.text()}`)
}

export async function resetServer(api: APIRequestContext, seed: ConfigSeed, connections: ConnectionSeed[]): Promise<void> {
  // First a config that names no connection, so every connection can go.
  await putConfig(api, baseConfig())
  const existing = await (await api.get('/api/connections')).json() as { id: string }[]
  for (const c of existing) {
    const res = await api.delete(`/api/connections/${c.id}`)
    if (!res.ok()) throw new Error(`DELETE /api/connections/${c.id}: ${res.status()} ${await res.text()}`)
  }
  for (const c of connections) {
    const res = await api.put(`/api/connections/${c.id}`, {
      data: { type: c.type, name: c.name, fields: c.fields ?? {}, ...(c.secrets ? { secrets: c.secrets } : {}) },
    })
    if (!res.ok()) throw new Error(`PUT /api/connections/${c.id}: ${res.status()} ${await res.text()}`)
  }
  await putConfig(api, seed)
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  devWidgets: [[], { option: true, scope: 'worker' }],

  server: [async ({ devWidgets }, use, workerInfo) => {
    const server = await startServer({ port: FIRST_PORT + workerInfo.parallelIndex, devWidgets })
    try {
      await use(server)
    } finally {
      await server.stop()
    }
  }, { scope: 'worker', timeout: 60_000 }],

  baseURL: async ({ server }, use) => { await use(server.baseURL) },

  api: async ({ playwright, server }, use) => {
    const api = await playwright.request.newContext({
      baseURL: server.baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${server.token}` },
    })
    await use(api)
    await api.dispose()
  },

  seed: [async ({}, use) => { await use(baseConfig()) }, { option: true }],
  connections: [[], { option: true }],

  reset: [async ({ api, seed, connections, server }, use, testInfo) => {
    const from = server.log.length
    await resetServer(api, seed, connections)
    await use()
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('server.log', { body: server.log.slice(from).join(''), contentType: 'text/plain' })
    }
  }, { auto: true }],

  signIn: async ({ page, api }, use) => {
    await use(async (next = '/admin') => {
      const res = await api.post('/api/auth/code')
      expect(res.ok()).toBe(true)
      const { code } = await res.json() as { code: string }
      await page.goto(`/auth?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`)
    })
  },

  openAdmin: async ({ page, signIn }, use) => {
    await use(async () => {
      await signIn('/admin')
      await expect(page.locator('.admin .canvas')).toBeVisible()
    })
  },

  savedConfig: async ({ api }, use) => {
    await use(async () => (await (await api.get('/api/config')).json()) as ConfigSeed)
  },
})

export { expect }

/** The tiles of the page being edited, in the order the overlay draws them. */
export function tiles(page: Page) {
  return page.locator('[data-test="tile"]')
}

/** One tile of the editor's overlay, by instance id. */
export function tile(page: Page, instanceId: string) {
  return page.locator(`[data-test="tile"][data-instance-id="${instanceId}"]`)
}
