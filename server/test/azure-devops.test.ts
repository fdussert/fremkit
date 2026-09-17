import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createAzureDevOpsProvider,
  normalizeBuilds,
  normalizeTimeline,
  shortBranch,
  splitRuns,
  type AdoSnapshot,
} from '../src/providers/azure-devops.js'
import { azureDevOpsType } from '../src/connections/types/azure-devops.js'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'))

const BUILDS = fixture('ado-builds')
const STAGES = fixture('ado-timeline-stages')
const CLASSIC = fixture('ado-timeline-classic')

describe('shortBranch', () => {
  it('strips refs/heads and names a pull request', () => {
    expect(shortBranch('refs/heads/main')).toBe('main')
    expect(shortBranch('refs/heads/feature/login')).toBe('feature/login')
    expect(shortBranch('refs/pull/318/merge')).toBe('PR 318')
    expect(shortBranch('refs/tags/v1.2.0')).toBe('v1.2.0')
    expect(shortBranch('')).toBe('')
  })
})

describe('normalizeBuilds', () => {
  const runs = normalizeBuilds(BUILDS)

  it('reads the four builds in the order the API returned them', () => {
    expect(runs.map((r) => r.id)).toEqual([4821, 4820, 4819, 4818])
  })

  it('maps an in-progress build', () => {
    expect(runs[0]).toMatchObject({
      id: 4821, number: '20260917.3', pipeline: 'web-ci', branch: 'main',
      requestedFor: 'Placeholder User', reason: 'individualCI', status: 'running',
      url: 'https://dev.azure.com/example-org/example-project/_build/results?buildId=4821',
      stages: [],
    })
    expect(runs[0].result).toBeUndefined()
    expect(runs[0].queuedAt).toBe(Date.parse('2026-09-17T08:59:40.12Z'))
    expect(runs[0].startedAt).toBe(Date.parse('2026-09-17T09:00:02.44Z'))
    expect(runs[0].finishedAt).toBeUndefined()
  })

  it('maps a completed failure and a cancellation', () => {
    expect(runs[1]).toMatchObject({ status: 'completed', result: 'failed', branch: 'feature/login' })
    expect(runs[2]).toMatchObject({ status: 'completed', result: 'canceled', branch: 'PR 318' })
    expect(runs[1].finishedAt).toBe(Date.parse('2026-09-17T08:47:05Z'))
  })

  it('maps notStarted to queued', () => {
    expect(runs[3]).toMatchObject({ status: 'queued', pipeline: 'legacy-classic' })
  })

  it('survives a response that is not the expected shape', () => {
    expect(normalizeBuilds(null)).toEqual([])
    expect(normalizeBuilds({ value: 'nope' })).toEqual([])
    expect(normalizeBuilds({ value: [{}] })).toEqual([])
  })
})

describe('normalizeTimeline', () => {
  it('keeps the Stage records in `order` and maps their state and result', () => {
    expect(normalizeTimeline(STAGES)).toEqual([
      { name: 'Build', state: 'done', result: 'succeeded' },
      { name: 'Test', state: 'running' },
      { name: 'Package', state: 'done', result: 'partial' },
      { name: 'Deploy', state: 'pending' },
      { name: 'Smoke', state: 'done', result: 'skipped' },
    ])
  })

  it('falls back to the top-level Phase records of a classic pipeline', () => {
    expect(normalizeTimeline(CLASSIC)).toEqual([
      { name: 'Agent job', state: 'done', result: 'succeeded' },
      { name: 'Publish', state: 'running' },
    ])
  })

  it('returns nothing for an empty or broken timeline', () => {
    expect(normalizeTimeline({ records: [] })).toEqual([])
    expect(normalizeTimeline(null)).toEqual([])
  })
})

describe('splitRuns', () => {
  const runs = normalizeBuilds(BUILDS)

  it('puts queued and running builds first and fills the history with the rest', () => {
    const split = splitRuns(runs)
    expect(split.running.map((r) => r.id)).toEqual([4821, 4818])
    expect(split.history.map((r) => r.id)).toEqual([4820, 4819])
  })

  it('keeps up to forty completed runs and lets the widget slice them', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...runs[1], id: 2000 + i }))
    expect(splitRuns(many).history).toHaveLength(40)
    expect(splitRuns(many).history[0].id).toBe(2000)
  })
})

describe('createAzureDevOpsProvider', () => {
  const ctx = {
    id: 'ado-x1z9',
    channel: 'azure-devops:ado-x1z9',
    fields: { organization: 'example-org', project: 'example-project' },
    secrets: { pat: 'token-1' },
  }

  const responder = (bodies: Record<string, unknown>, status = 200) => {
    const urls: string[] = []
    const headers: Record<string, string>[] = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      urls.push(String(url))
      headers.push({ ...(init?.headers as Record<string, string>) })
      const key = String(url).includes('/timeline') ? 'timeline' : 'builds'
      return new Response(JSON.stringify(bodies[key] ?? {}), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { urls, headers, fetchFn }
  }

  it('asks for the build list with Basic auth and the api-version', async () => {
    const { urls, headers, fetchFn } = responder({ builds: BUILDS, timeline: STAGES })
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => 1_000_000 })
    await provider.poll!()
    expect(provider.channel).toBe('azure-devops:ado-x1z9')
    expect(urls[0]).toBe('https://dev.azure.com/example-org/example-project/_apis/build/builds?$top=40&queryOrder=queueTimeDescending&api-version=7.1')
    expect(headers[0].Authorization).toBe(`Basic ${Buffer.from(':token-1').toString('base64')}`)
    expect(headers[0]['User-Agent']).toMatch(/^fremkit\//)
  })

  it('fetches a timeline for each unfinished run and attaches its stages', async () => {
    const { urls, fetchFn } = responder({ builds: BUILDS, timeline: STAGES })
    const snapshot = (await createAzureDevOpsProvider(ctx, { fetchFn, now: () => 1_000_000 }).poll!()) as AdoSnapshot
    expect(urls.filter((u) => u.includes('/timeline'))).toEqual([
      'https://dev.azure.com/example-org/example-project/_apis/build/builds/4821/timeline?api-version=7.1',
      'https://dev.azure.com/example-org/example-project/_apis/build/builds/4818/timeline?api-version=7.1',
    ])
    expect(snapshot.running[0].stages.map((s) => s.name)).toEqual(['Build', 'Test', 'Package', 'Deploy', 'Smoke'])
    expect(snapshot.history[0].stages).toEqual([])
  })

  it('publishes no timestamp, so an unchanged poll is byte-identical', async () => {
    const { fetchFn } = responder({ builds: BUILDS, timeline: STAGES })
    let now = 0
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => now })
    const first = JSON.stringify(await provider.poll!())
    now = 60_000
    expect(JSON.stringify(await provider.poll!())).toBe(first)
  })

  it('refreshes the build list every 30 s and the timelines every 10 s', async () => {
    let now = 0
    const { urls, fetchFn } = responder({ builds: BUILDS, timeline: STAGES })
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => now })
    await provider.poll!()
    const afterFirst = urls.length
    now = 10_000
    await provider.poll!()
    expect(urls.filter((u) => !u.includes('/timeline'))).toHaveLength(1)
    expect(urls.length).toBe(afterFirst + 2)
    now = 30_000
    await provider.poll!()
    expect(urls.filter((u) => !u.includes('/timeline'))).toHaveLength(2)
  })

  it('reports an unauthorized PAT and keeps the previous snapshot', async () => {
    let status = 200
    const fetchFn = (async (url: string) => new Response(
      status === 200 ? JSON.stringify(String(url).includes('/timeline') ? STAGES : BUILDS) : '',
      { status, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    let now = 0
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => now })
    const first = (await provider.poll!()) as AdoSnapshot
    expect(first.error).toBeUndefined()
    status = 401
    now = 60_000
    const second = (await provider.poll!()) as AdoSnapshot
    expect(second.error).toBe('unauthorized')
    expect(second.running.map((r) => r.id)).toEqual(first.running.map((r) => r.id))
  })

  it('keeps the last runs and reports offline on a network failure', async () => {
    let fail = false
    const fetchFn = (async (url: string) => {
      if (fail) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify(String(url).includes('/timeline') ? STAGES : BUILDS), { status: 200 })
    }) as unknown as typeof fetch
    let now = 0
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => now })
    const first = (await provider.poll!()) as AdoSnapshot
    fail = true
    now = 60_000
    const second = (await provider.poll!()) as AdoSnapshot
    expect(second.error).toBe('offline')
    expect(second.running.map((r) => r.id)).toEqual(first.running.map((r) => r.id))
    expect(second.history.map((r) => r.id)).toEqual(first.history.map((r) => r.id))
  })

  it('reports offline on a 429 or a 5xx too', async () => {
    for (const status of [429, 500]) {
      const { fetchFn } = responder({}, status)
      const snapshot = (await createAzureDevOpsProvider(ctx, { fetchFn, now: () => 0 }).poll!()) as AdoSnapshot
      expect(snapshot).toEqual({ running: [], history: [], error: 'offline' })
    }
  })

  it('opens only an Azure DevOps URL, and only from this machine', async () => {
    const opened: string[] = []
    const local = { loopback: true }
    const { fetchFn } = responder({ builds: BUILDS, timeline: STAGES })
    const provider = createAzureDevOpsProvider(ctx, { fetchFn, now: () => 0, open: async (u) => { opened.push(u) } })
    const run = 'https://dev.azure.com/example-org/example-project/_build/results?buildId=4821'
    await provider.commands!.open({ url: run }, local)
    expect(opened).toHaveLength(1)
    await expect(provider.commands!.open({ url: run }, { loopback: false })).rejects.toThrow('commande réservée à cette machine')
    await expect(provider.commands!.open({ url: run })).rejects.toThrow('commande réservée à cette machine')
    await expect(provider.commands!.open({ url: 'file:///etc/passwd' }, local)).rejects.toThrow('URL refusée')
    await expect(provider.commands!.open({ url: 'https://example.com/' }, local)).rejects.toThrow('URL refusée')
    await expect(provider.commands!.open({ url: 'https://dev.azure.com.evil.com/x' }, local)).rejects.toThrow('URL refusée')
    await expect(provider.commands!.open({ url: 'https://dev.azure.com@evil.com/x' }, local)).rejects.toThrow('URL refusée')
    expect(opened).toHaveLength(1)
  })
})

describe('azureDevOpsType', () => {
  const fields = { organization: 'example-org', project: 'example-project' }

  it('declares the three fields with the PAT as a secret', () => {
    expect(azureDevOpsType.fields.map((f) => f.key)).toEqual(['organization', 'project', 'pat'])
    expect(azureDevOpsType.fields[2].secret).toBe(true)
  })

  it('accepts a 200 from the definitions endpoint', async () => {
    const fetchFn = vi.fn(async () => new Response('{"count":1}', { status: 200 })) as unknown as typeof fetch
    await expect(azureDevOpsType.test(fields, { pat: 'token-1' }, { fetchFn })).resolves.toEqual({
      ok: true, detail: 'Connexion établie avec example-org/example-project',
    })
  })

  it('turns 401, 403 and 404 into readable French', async () => {
    const at = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch
    await expect(azureDevOpsType.test(fields, { pat: 'x' }, { fetchFn: at(401) })).resolves.toEqual({ ok: false, error: 'PAT refusé' })
    await expect(azureDevOpsType.test(fields, { pat: 'x' }, { fetchFn: at(403) })).resolves.toEqual({ ok: false, error: 'PAT refusé' })
    await expect(azureDevOpsType.test(fields, { pat: 'x' }, { fetchFn: at(404) })).resolves.toEqual({ ok: false, error: 'organisation ou projet introuvable' })
    await expect(azureDevOpsType.test(fields, { pat: 'x' }, { fetchFn: at(500) })).resolves.toEqual({ ok: false, error: 'réponse inattendue (HTTP 500)' })
  })

  it('reports a network failure without leaking the PAT', async () => {
    const fetchFn = (async () => { throw new Error('getaddrinfo ENOTFOUND dev.azure.com') }) as unknown as typeof fetch
    const result = await azureDevOpsType.test(fields, { pat: 'token-1' }, { fetchFn })
    expect(result).toEqual({ ok: false, error: 'serveur injoignable' })
    expect(JSON.stringify(result)).not.toContain('token-1')
  })
})
