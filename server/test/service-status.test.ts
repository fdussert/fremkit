import { describe, it, expect, vi } from 'vitest'
import {
  createServiceStatusProvider,
  resolveServices,
  ProbePayloadSchema,
  PROBE_TIMEOUT_MS,
  probeOne,
  splitHostPort,
  stateForStatus,
  type Probes,
  type ProbeResult,
  type ServiceResult,
} from '../src/providers/service-status.js'
import type { InstanceLookup } from '../src/config/instances.js'
import { USER_AGENT } from '../src/version.js'

const LOCAL = { loopback: true }

/** Every outbound call replaced: nothing in this file touches a network or a process. */
function probes(over: Partial<Probes> = {}): Probes {
  return {
    fetchFn: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    tcpConnect: vi.fn(async () => {}),
    ping: vi.fn(async () => '64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.075 ms'),
    ...over,
  }
}

/**
 * Runs the command with every probe faked unless the test replaced one on purpose.
 *
 * `saved` is what the user configured on the widget instance — which is the only place the
 * targets can come from — so the command itself is sent nothing but the instance's id.
 */
async function probe(saved: unknown, deps: Partial<Probes> = {}, ...ctx: [{ loopback: boolean } | undefined] | []) {
  const instances: InstanceLookup = (id) =>
    (id === INSTANCE ? { widgetId: 'service-status', settings: saved as Record<string, unknown> } : null)
  const p = createServiceStatusProvider(probes(deps), instances)
  return (await p.commands!.probe({ instanceId: INSTANCE }, ctx.length ? ctx[0] : LOCAL)) as ProbeResult
}

const INSTANCE = 'svc-1'

function results(r: ProbeResult): ServiceResult[] {
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r.results
}

describe('service-status payload validation', () => {
  it('accepts the three kinds', () => {
    expect(ProbePayloadSchema.safeParse({ services: [
      { kind: 'http', name: 'Site', url: 'https://example.com' },
      { kind: 'http', name: 'Plain', url: 'http://example.com:8080/health' },
      { kind: 'tcp', name: 'DB', url: 'db.local:5432' },
      { kind: 'ping', name: 'Gateway', url: '192.0.2.1' },
    ] }).success).toBe(true)
  })
  it('refuses a url that is not http or https', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'mailto:a@b.c', 'not a url']) {
      expect(ProbePayloadSchema.safeParse({ services: [{ kind: 'http', name: 'x', url }] }).success, url).toBe(false)
    }
  })
  it('refuses a host with anything but letters, digits, dots, hyphens and colons', () => {
    for (const url of ['host;rm -rf /', 'host/path', 'host name', 'host|cat', '$(id)', '-oProxy', 'a`id`']) {
      expect(ProbePayloadSchema.safeParse({ services: [{ kind: 'ping', name: 'x', url }] }).success, url).toBe(false)
    }
    expect(ProbePayloadSchema.safeParse({ services: [{ kind: 'ping', name: 'x', url: 'fe80::1' }] }).success).toBe(true)
  })
  it('refuses a tcp target without a usable port', () => {
    for (const url of ['host', 'host:', 'host:0', 'host:70000', 'host:http', ':443', 'ho st:80']) {
      expect(ProbePayloadSchema.safeParse({ services: [{ kind: 'tcp', name: 'x', url }] }).success, url).toBe(false)
    }
    expect(splitHostPort('127.0.0.1:4305')).toEqual({ host: '127.0.0.1', port: 4305 })
    expect(splitHostPort('fe80::1:443')).toEqual({ host: 'fe80::1', port: 443 })
  })
  it('refuses an unknown kind, an empty list and more than twenty services', () => {
    expect(ProbePayloadSchema.safeParse({ services: [{ kind: 'shell', name: 'x', url: 'ls' }] }).success).toBe(false)
    expect(ProbePayloadSchema.safeParse({ services: [] }).success).toBe(false)
    const many = (n: number) => ({ services: Array.from({ length: n }, (_, i) => ({ kind: 'ping', name: `h${i}`, url: '127.0.0.1' })) })
    expect(ProbePayloadSchema.safeParse(many(20)).success).toBe(true)
    expect(ProbePayloadSchema.safeParse(many(21)).success).toBe(false)
  })
  it('refuses an empty name and one longer than eighty characters', () => {
    const svc = (name: string) => ({ services: [{ kind: 'ping', name, url: '127.0.0.1' }] })
    expect(ProbePayloadSchema.safeParse(svc('  ')).success).toBe(false)
    expect(ProbePayloadSchema.safeParse(svc('a'.repeat(81))).success).toBe(false)
  })
})

describe('service-status http probes', () => {
  it('maps every status class', () => {
    expect([200, 204, 301, 302, 399].map(stateForStatus)).toEqual(['up', 'up', 'up', 'up', 'up'])
    expect([400, 401, 404, 429].map(stateForStatus)).toEqual(['warn', 'warn', 'warn', 'warn'])
    expect([500, 502, 503].map(stateForStatus)).toEqual(['down', 'down', 'down'])
  })
  it('reports up, warn and down from the response status', async () => {
    for (const [status, state] of [[204, 'up'], [302, 'up'], [404, 'warn'], [503, 'down']] as const) {
      // 204 carries no body at all, and the Response constructor insists on that.
      const fetchFn = vi.fn(async () => new Response(status === 204 ? null : 'x', { status })) as unknown as typeof fetch
      const r = results(await probe({ services: [{ kind: 'http', name: 'Site', url: 'https://example.com' }] }, { fetchFn }))
      expect(r[0], String(status)).toMatchObject({ name: 'Site', state, detail: `HTTP ${status}` })
      expect(typeof r[0].latencyMs).toBe('number')
    }
  })
  it('reports down when the request times out or the host is unreachable', async () => {
    for (const err of [Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }), new Error('ECONNREFUSED')]) {
      const fetchFn = vi.fn(async () => { throw err }) as unknown as typeof fetch
      const r = results(await probe({ services: [{ kind: 'http', name: 'Site', url: 'https://example.com' }] }, { fetchFn }))
      expect(r[0].state).toBe('down')
      expect(typeof r[0].detail).toBe('string')
    }
  })
  it('sends a HEAD with the Fremkit user agent, follows no redirect and carries no credentials', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch
    await probe({ services: [{ kind: 'http', name: 'Site', url: 'https://example.com' }] }, { fetchFn })
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    // Nothing here reads the body, and a status is all a probe wants.
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com')
    expect(init.method).toBe('HEAD')
    expect(init.redirect).toBe('manual')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT)
    expect(init).not.toHaveProperty('credentials')
    expect(init).not.toHaveProperty('body')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to GET for a server that refuses HEAD', async () => {
    for (const refusal of [405, 501]) {
      const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) =>
        new Response('', { status: init?.method === 'HEAD' ? refusal : 200 })) as unknown as typeof fetch
      const r = results(await probe({ services: [{ kind: 'http', name: 'Site', url: 'https://example.com' }] }, { fetchFn }))
      const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.map((c) => (c[1] as RequestInit).method), String(refusal)).toEqual(['HEAD', 'GET'])
      // The service is up: refusing HEAD is not being down.
      expect(r[0], String(refusal)).toMatchObject({ name: 'Site', state: 'up', detail: 'HTTP 200' })
    }
  })

  it('does not retry any other status', async () => {
    for (const status of [200, 404, 500, 302]) {
      const fetchFn = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch
      await probe({ services: [{ kind: 'http', name: 'Site', url: 'https://example.com' }] }, { fetchFn })
      expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls, String(status)).toHaveLength(1)
    }
  })
})

describe('service-status resolves its targets from the saved dashboard', () => {
  const saved = [{ kind: 'http', name: 'Site', url: 'https://example.com' }]
  const lookup = (settings: unknown, widgetId = 'service-status'): InstanceLookup =>
    (id) => (id === 'svc-1' ? { widgetId, settings: settings as Record<string, unknown> } : null)

  it('reads the services the user configured on that instance', () => {
    const r = resolveServices(lookup({ services: saved }), 'svc-1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.services).toEqual(saved)
  })

  it('refuses an instance it cannot find', () => {
    expect(resolveServices(lookup({ services: saved }), 'someone-else').ok).toBe(false)
  })

  it('refuses an instance of another widget', () => {
    // Otherwise any widget could borrow a service-status instance's id and probe its hosts.
    expect(resolveServices(lookup({ services: saved }, 'clock'), 'svc-1').ok).toBe(false)
  })

  it('refuses an instance with no services saved', () => {
    for (const settings of [{}, { services: [] }, { services: 'nope' }, { services: [{ kind: 'http' }] }]) {
      expect(resolveServices(lookup(settings), 'svc-1').ok, JSON.stringify(settings)).toBe(false)
    }
  })

  it('never probes a host the caller named rather than saved', async () => {
    const deps = probes()
    const p = createServiceStatusProvider(deps, lookup({ services: saved }))
    // The old payload shape: a list of targets straight from the widget.
    const r = await p.commands!.probe({ services: [{ kind: 'http', name: 'Evil', url: 'https://evil.example' }] }, LOCAL)
    expect(r).toMatchObject({ ok: false })
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })
})

describe('service-status tcp and ping probes', () => {
  it('reports up on a connection and down when it is refused', async () => {
    const ok = results(await probe({ services: [{ kind: 'tcp', name: 'DB', url: 'db.local:5432' }] }))
    expect(ok[0]).toMatchObject({ name: 'DB', state: 'up' })

    const tcpConnect = vi.fn(async () => { throw new Error('connect ECONNREFUSED') })
    const bad = results(await probe({ services: [{ kind: 'tcp', name: 'DB', url: 'db.local:5432' }] }, { tcpConnect }))
    expect(bad[0]).toMatchObject({ name: 'DB', state: 'down' })
    expect(bad[0].detail).toContain('ECONNREFUSED')
  })
  it('hands the tcp probe a split host, port and the five second budget', async () => {
    const tcpConnect = vi.fn(async () => {})
    await probe({ services: [{ kind: 'tcp', name: 'DB', url: '127.0.0.1:4305' }] }, { tcpConnect })
    expect(tcpConnect).toHaveBeenCalledWith('127.0.0.1', 4305, PROBE_TIMEOUT_MS)
  })
  it('reads the latency out of ping, and calls a failed ping down', async () => {
    const up = results(await probe({ services: [{ kind: 'ping', name: 'GW', url: '127.0.0.1' }] }))
    expect(up[0]).toMatchObject({ name: 'GW', state: 'up', latencyMs: 0 })

    const ping = vi.fn(async () => { throw new Error('Request timeout for icmp_seq 0') })
    const down = results(await probe({ services: [{ kind: 'ping', name: 'GW', url: '192.0.2.9' }] }, { ping }))
    expect(down[0]).toMatchObject({ name: 'GW', state: 'down' })
  })
  it('hands ping the validated host and the five second budget', async () => {
    const ping = vi.fn(async () => 'time=1.5 ms')
    await probe({ services: [{ kind: 'ping', name: 'GW', url: 'gateway.local' }] }, { ping })
    expect(ping).toHaveBeenCalledWith('gateway.local', PROBE_TIMEOUT_MS)
  })
})

describe('service-status probe command', () => {
  it('refuses a probe that did not come from this machine', async () => {
    const deps = probes()
    const services = [{ kind: 'http', name: 'Site', url: 'https://example.com' }]
    expect(await probe({ services }, deps, { loopback: false })).toMatchObject({ ok: false })
    expect(await probe({ services }, deps, undefined)).toMatchObject({ ok: false })
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })
  it('probes nothing at all when one saved entry is refused', async () => {
    const deps = probes()
    const r = await probe({ services: [
      { kind: 'http', name: 'Good', url: 'https://example.com' },
      { kind: 'http', name: 'Bad', url: 'file:///etc/passwd' },
    ] }, deps)
    expect(r.ok).toBe(false)
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.tcpConnect).not.toHaveBeenCalled()
    expect(deps.ping).not.toHaveBeenCalled()
  })
  it('keeps the order of the services and answers one result each', async () => {
    const r = results(await probe({ services: [
      { kind: 'http', name: 'A', url: 'https://example.com' },
      { kind: 'tcp', name: 'B', url: 'b.local:80' },
      { kind: 'ping', name: 'C', url: '127.0.0.1' },
    ] }))
    expect(r.map((x) => x.name)).toEqual(['A', 'B', 'C'])
    expect(r.map((x) => x.state)).toEqual(['up', 'up', 'up'])
  })
  it('runs the probes in parallel, not one after the other', async () => {
    let live = 0
    let peak = 0
    const slow = async () => {
      live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 20))
      live--
    }
    const services = Array.from({ length: 6 }, (_, i) => ({ kind: 'tcp', name: `s${i}`, url: `h${i}.local:80` }))
    const started = Date.now()
    const r = results(await probe({ services }, { tcpConnect: slow }))
    expect(r).toHaveLength(6)
    expect(peak).toBe(6)
    expect(Date.now() - started).toBeLessThan(6 * 20)
  })
  it('lets one slow service fail without taking the others down', async () => {
    const tcpConnect = vi.fn(async (host: string) => { if (host === 'slow.local') throw new Error('timeout') })
    const r = results(await probe({ services: [
      { kind: 'tcp', name: 'Slow', url: 'slow.local:80' },
      { kind: 'tcp', name: 'Fast', url: 'fast.local:80' },
    ] }, { tcpConnect }))
    expect(r.map((x) => x.state)).toEqual(['down', 'up'])
  })
  it('never throws out of probeOne, whatever the probe does', async () => {
    const r = await probeOne({ kind: 'ping', name: 'X', url: '127.0.0.1' }, probes({ ping: vi.fn(async () => { throw 'plain string' }) }))
    expect(r).toMatchObject({ name: 'X', state: 'down' })
  })
  it('publishes nothing: the channel only ever carries commands', async () => {
    expect(await createServiceStatusProvider().poll!()).toEqual({ ok: true })
  })
})
