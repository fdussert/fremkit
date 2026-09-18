import { execFile } from 'node:child_process'
import { connect as netConnect, type Socket } from 'node:net'
import { z } from 'zod'
import type { CommandContext, Provider } from './types.js'
import { noInstances, type InstanceLookup } from '../config/instances.js'
import { USER_AGENT } from '../version.js'
import { tr } from '../i18n.js'

/** Longest any one probe may take before it is called down. */
export const PROBE_TIMEOUT_MS = 5_000

/** A dashboard is not a monitoring system: a tile that watches twenty things is already too busy. */
const MAX_SERVICES = 20
const MAX_NAME = 80
const MAX_TARGET = 500

/** The absolute path of the only program this provider runs. */
export const PING_BIN = '/sbin/ping'

/**
 * What a host may be made of: letters, digits, dots, hyphens and colons — a name, an IPv4, or an
 * IPv6 literal. Nothing is ever handed to a shell (`execFile` takes an argv), so this is not what
 * keeps the Mac safe; it is what keeps a probe honest, and what stops a leading dash from being
 * read by `ping` as a flag.
 */
const HOST_RE = /^[A-Za-z0-9.:-]+$/

/** The only protocols an `http` probe may carry. No `file:`, no `javascript:`, no custom scheme. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

const NameSchema = z.string().trim().min(1).max(MAX_NAME)

const HostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => HOST_RE.test(v) && !v.startsWith('-'), { error: () => tr(undefined, 'serviceStatus.invalidHost') })

/** `host:port`; the port is split off at the last colon so an IPv6 literal still parses. */
const HostPortSchema = z
  .string()
  .trim()
  .min(3)
  .max(MAX_TARGET)
  .refine((v) => splitHostPort(v) !== null, { error: () => tr(undefined, 'serviceStatus.invalidHostPort') })

const HttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TARGET)
  .refine((v) => {
    let url: URL
    try { url = new URL(v) } catch { return false }
    return ALLOWED_PROTOCOLS.has(url.protocol)
  }, { error: () => tr(undefined, 'provider.refusedUrl') })

export const ServiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), name: NameSchema, url: HttpUrlSchema }),
  z.object({ kind: z.literal('tcp'), name: NameSchema, url: HostPortSchema }),
  z.object({ kind: z.literal('ping'), name: NameSchema, url: HostSchema }),
])
export type Service = z.infer<typeof ServiceSchema>

/** The services list as the user saved it on one widget instance. */
export const ProbePayloadSchema = z.object({
  services: z.array(ServiceSchema).min(1).max(MAX_SERVICES),
})
export type ProbePayload = z.infer<typeof ProbePayloadSchema>

/**
 * What a widget may ask for: a probe of *its own* configured services.
 *
 * It names its instance and nothing else. A probe reaches out from this Mac onto whatever
 * network it sits on, so the list of targets has to be one the user typed into the admin — not
 * one a widget composed. Before this, any widget declaring the `service-status` channel could
 * have this server knock on twenty arbitrary hosts and report which answered.
 */
export const ProbeRequestSchema = z.object({
  instanceId: z.string().min(1).max(200),
})

/** The widget whose saved services this channel probes. */
const SERVICE_STATUS_WIDGET = 'service-status'

/** The services saved on one instance, or a reason there are none to probe. */
export function resolveServices(
  lookup: InstanceLookup,
  instanceId: string,
): { ok: true; services: Service[] } | { ok: false; error: string } {
  const instance = lookup(instanceId)
  if (!instance || instance.widgetId !== SERVICE_STATUS_WIDGET) {
    return { ok: false, error: tr(undefined, 'serviceStatus.unknownInstance') }
  }
  const parsed = ProbePayloadSchema.safeParse({ services: instance.settings.services })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? tr(undefined, 'serviceStatus.noServices') }
  }
  return { ok: true, services: parsed.data.services }
}

export type State = 'up' | 'warn' | 'down'
export interface ServiceResult { name: string; state: State; latencyMs?: number; detail?: string }
export type ProbeResult = { ok: true; results: ServiceResult[] } | { ok: false; error: string }

/** Splits `host:port`, refusing anything that is not a plain host and a real port number. */
export function splitHostPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim()
  const cut = trimmed.lastIndexOf(':')
  if (cut <= 0 || cut === trimmed.length - 1) return null
  const host = trimmed.slice(0, cut)
  const port = Number(trimmed.slice(cut + 1))
  if (!HOST_RE.test(host) || host.startsWith('-')) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/** The three ways this provider reaches the outside world, swapped out wholesale in the tests. */
export interface Probes {
  fetchFn: typeof fetch
  /** Opens a TCP connection and resolves once it is established, or rejects. */
  tcpConnect: (host: string, port: number, timeoutMs: number) => Promise<void>
  /** Runs one ICMP echo and resolves with the program's stdout, or rejects. */
  ping: (host: string, timeoutMs: number) => Promise<string>
}

export const realTcpConnect: Probes['tcpConnect'] = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    let socket: Socket
    try { socket = netConnect({ host, port }) } catch (err) { reject(err as Error); return }
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => done(new Error('timeout')))
    socket.once('connect', () => done())
    socket.once('error', (err) => done(err))
  })

export const realPing: Probes['ping'] = (host, timeoutMs) =>
  new Promise((resolve, reject) => {
    // `-c 1` one echo, `-W 2000` two seconds waiting for the reply; the outer timeout is the
    // backstop for a `ping` that hangs on name resolution instead.
    execFile(PING_BIN, ['-c', '1', '-W', '2000', host], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })

const defaultProbes: Probes = { fetchFn: fetch, tcpConnect: realTcpConnect, ping: realPing }

/** `time=12.3 ms` in `ping`'s output, when there is one. */
function pingLatency(stdout: string): number | undefined {
  const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout)
  if (!m) return undefined
  const value = Number(m[1])
  return Number.isFinite(value) ? Math.round(value) : undefined
}

/** 2xx and 3xx are up, 4xx is worth a look, 5xx is down. */
export function stateForStatus(status: number): State {
  if (status >= 200 && status < 400) return 'up'
  if (status >= 400 && status < 500) return 'warn'
  return 'down'
}

function short(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > 120 ? message.slice(0, 117) + '…' : message
}

/** Runs one service's probe. Never throws: a failure *is* the answer. */
export async function probeOne(service: Service, probes: Probes): Promise<ServiceResult> {
  const started = Date.now()
  const latency = () => Date.now() - started
  try {
    switch (service.kind) {
      case 'http': {
        // HEAD first: nothing here reads the body, and a status is all a probe wants. A server
        // that refuses the method (405, 501) is asked again with GET, so the check still works.
        //
        // `redirect: 'manual'` means no hop is ever followed, so no redirect can lead anywhere
        // else — least of all to a scheme that is not http(s). A 3xx is simply an answer.
        const request = (method: 'HEAD' | 'GET') => probes.fetchFn(service.url, {
          method,
          redirect: 'manual',
          headers: { Accept: '*/*', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        let res = await request('HEAD')
        if (res.status === 405 || res.status === 501) {
          try { await res.body?.cancel() } catch { /* already closed */ }
          res = await request('GET')
        }
        // Nothing reads the body; drop it rather than leave the socket half-consumed.
        try { await res.body?.cancel() } catch { /* already closed */ }
        return { name: service.name, state: stateForStatus(res.status), latencyMs: latency(), detail: `HTTP ${res.status}` }
      }
      case 'tcp': {
        const target = splitHostPort(service.url)
        if (!target) return { name: service.name, state: 'down', detail: tr(undefined, 'serviceStatus.invalidHostPort') }
        await probes.tcpConnect(target.host, target.port, PROBE_TIMEOUT_MS)
        return { name: service.name, state: 'up', latencyMs: latency() }
      }
      case 'ping': {
        const stdout = await probes.ping(service.url, PROBE_TIMEOUT_MS)
        return { name: service.name, state: 'up', latencyMs: pingLatency(stdout) ?? latency() }
      }
    }
  } catch (err) {
    return { name: service.name, state: 'down', detail: short(err) }
  }
}

/**
 * The `service-status` channel: one command, `probe`.
 *
 * The list of services lives in each widget instance's settings — one dashboard may watch a home
 * lab and another a public site — so the widget owns the clock and names its own instance; the
 * host reads the list. There is nothing to publish, so `poll` answers a constant.
 */
export function createServiceStatusProvider(
  probes: Partial<Probes> = {},
  instances: InstanceLookup = noInstances,
): Provider {
  const deps: Probes = { ...defaultProbes, ...probes }
  return {
    channel: 'service-status',
    // Nothing to watch; the registry only polls a channel someone subscribed to, and no widget does.
    intervalMs: 60_000,
    poll: async () => ({ ok: true }),
    commands: {
      probe: async (payload, ctx?: CommandContext): Promise<ProbeResult> => {
        // A probe reaches out from this Mac, onto whatever network it sits on — a home lab a
        // remote caller cannot see. Fail closed: no context means remote.
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        const request = ProbeRequestSchema.safeParse(payload)
        if (!request.success) {
          return { ok: false, error: request.error.issues[0]?.message ?? tr(undefined, 'provider.invalidPayload') }
        }
        // The targets come from the user's saved settings, never from the message.
        const resolved = resolveServices(instances, request.data.instanceId)
        if (!resolved.ok) return { ok: false, error: resolved.error }
        // All at once: twenty services one after the other would take longer than the interval.
        const results = await Promise.all(resolved.services.map((s) => probeOne(s, deps)))
        return { ok: true, results }
      },
    },
  }
}
