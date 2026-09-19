/**
 * @vitest-environment jsdom
 *
 * A theme that appears after the page loaded.
 *
 * The catalog is read once per page. A theme can arrive later — installed from the registry in
 * this tab or another one, restored with a backup, dropped into the folder by hand — and until
 * this existed the screen went on painting the built-in theme until somebody reloaded it. Two
 * paths carry that, and neither had a test: the dashboard's own "I have never heard of this id,
 * go and look once", and the admin's rescan after an install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Config, ThemesResponse } from '../src/shared/types'

function config(theme: string): Config {
  return {
    version: 2,
    display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, theme },
    connections: [], secrets: { backend: 'file' }, locale: 'en',
    privacy: { claudeAccountUsage: false }, marketplace: { installed: {} },
    pages: [{ id: 'home', name: 'Home', widgets: [] }],
  } as unknown as Config
}

const themeInfo = (id: string, variables: Record<string, string>) =>
  ({ id, name: id, version: '1.0.0', tokens: {}, variables })

/** A server whose catalog starts empty and gains `late` on the second read. */
function serve(): { calls: string[]; body: () => ThemesResponse } {
  const calls: string[] = []
  let served = 0
  const body = (): ThemesResponse => {
    served += 1
    return served === 1
      ? { themes: {}, errors: [] }
      : { themes: { late: themeInfo('late', { '--accent': '#58a6ff' }) }, errors: [] }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body()), { headers: { 'content-type': 'application/json' } })
  }))
  return { calls, body }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0))
}

beforeEach(() => { document.documentElement.removeAttribute('style') })
afterEach(() => { vi.unstubAllGlobals() })

describe('useConfigTheme', () => {
  it('goes back for the catalog when the config names a theme it has never heard of', async () => {
    // Every test needs its own module instance: the "already asked" set is module scope, which
    // is the whole point of it — one request per id for the life of the page.
    vi.resetModules()
    const { useConfigTheme } = await import('../src/shared/theme')
    const { calls } = serve()

    useConfigTheme(ref(config('late')))
    await settle()

    expect(calls.filter((u) => u === '/api/themes')).toHaveLength(2)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#58a6ff')
  })

  it('asks once per id, so an id that does not exist costs one request', async () => {
    vi.resetModules()
    const { useConfigTheme } = await import('../src/shared/theme')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ themes: {}, errors: [] }),
      { headers: { 'content-type': 'application/json' } },
    )))

    const cfg = ref(config('deleted-yesterday'))
    useConfigTheme(cfg)
    await settle()
    const after = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    // Repainting for any other reason must not ask again.
    cfg.value = { ...config('deleted-yesterday') }
    await settle()
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(after)
  })

  it('says nothing and paints the defaults when the catalog cannot be read', async () => {
    vi.resetModules()
    const { useConfigTheme } = await import('../src/shared/theme')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    // The stylesheet holds the built-in theme's own values, so an unpainted page still looks
    // right; what must not happen is an unhandled rejection.
    expect(() => useConfigTheme(ref(config('late')))).not.toThrow()
    await settle()
  })
})

describe('what an install tells the rest of the admin to re-read', () => {
  it('rescans the widgets and the themes, so both lists are right without a reload', async () => {
    vi.resetModules()
    const { useMarketplaceStore } = await import('../src/admin/marketplace')
    const { useAdminStore } = await import('../src/admin/store')

    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url.startsWith('/api/themes')
        ? { themes: {}, errors: [] }
        : url === '/api/widgets'
          ? { widgets: {}, errors: [], sources: {}, asks: {} }
          : url === '/api/marketplace'
            ? { registry: 'r', generatedAt: null, widgets: [], themes: [], offline: false, sdk: 1 }
            : { ok: true, id: 'demo', version: '1.0.0' }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))

    const market = useMarketplaceStore()
    useAdminStore()
    await market.uninstall('demo')
    await settle()

    expect(calls).toContain('POST /api/themes/rescan')
    expect(calls.some((c) => c.includes('/api/widgets'))).toBe(true)
  })
})
