/**
 * A Synology NAS, through the DSM Web API.
 *
 * Endpoint provenance, so the next reader knows what is solid:
 *  - `SYNO.API.Auth` v6, `method=login`, `format=sid` — returns a session id. With an `otp_code`
 *    and `enable_device_token=yes` it also returns a `device_id`, which stands in for the code on
 *    every later login. That is the whole reason the one-time code is asked for once: DSM will
 *    not take the same six digits twice, so without the device token a 2FA account would need a
 *    fresh code every restart.
 *  - `SYNO.API.Auth` v1, `method=logout` — ends a session. Used by `test()`, which must not leave
 *    a session behind on the NAS every time the button is pressed.
 *  - `SYNO.Core.System.Utilization` v1, `method=get` — CPU, memory and network counters.
 *  - `SYNO.Storage.CGI.Storage` v1, `method=load_info` — volumes and disks: size, used, status,
 *    model, temperature, SMART verdict.
 *
 * **Nothing here is logged or quoted.** The session id, the password, the one-time code and the
 * device token never appear in an error, a log line or a snapshot. DSM's own error bodies are
 * read for their numeric code and thrown away; the sentences the user sees are this project's.
 *
 * **Why `node:https` rather than `fetch`.** A NAS on the LAN serves a self-signed certificate,
 * and `allowSelfSigned` has to be a per-connection decision — `fetch` has no way to say so
 * without a dispatcher Node does not export, and the global switch would turn verification off
 * for GitHub too. So the request is made by hand, with `rejectUnauthorized` set per call.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https'
import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'
import { tr } from '../i18n.js'

/** One request may take this long; a NAS waking a sleeping disk array is slow. */
export const SYNOLOGY_TIMEOUT_MS = 15_000
/** The nominal cadence; a failure retries sooner, as every provider here does. */
export const SYNOLOGY_POLL_MS = 30_000
export const SYNOLOGY_RETRY_MS = 10_000
export const SYNOLOGY_DEFAULT_PORT = 5001
/** An answer bigger than this is not a DSM answer. Sixteen disks of metadata is a few kilobytes. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024

/** DSM error codes worth acting on. 119 is a session id it does not know; 105 a session that lost its rights. */
const SESSION_GONE = new Set([105, 119])
/** Wrong account or password. 403/404 are the two-factor codes; 400 is the catch-all. */
const AUTH_FAILED = new Set([400, 401, 402, 403, 404, 406])

export class SynologyError extends Error {
  constructor(readonly code: number | null, readonly kind: 'auth' | 'session' | 'network' | 'answer') {
    super(`synology ${kind}${code === null ? '' : ` ${code}`}`)
    this.name = 'SynologyError'
  }
}

/** The host as a person types it: a name or an address, optionally with a port, never a URL. */
export function parseHost(raw: string): { host: string; port: number } | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  // A URL is accepted and reduced, because it is what half the world will paste.
  const stripped = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  // A bracketed IPv6 literal, or the characters a hostname and an IPv4 address are made of.
  // Nothing looser: a space or a slash in here becomes part of a URL the server then dials.
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(stripped)
  if (!m) return null
  const port = m[2] === undefined ? SYNOLOGY_DEFAULT_PORT : Number(m[2])
  if (port < 1 || port > 65535) return null
  return { host: m[1].replace(/^\[|\]$/g, ''), port }
}

export interface SynologyVolume {
  id: string
  /** Bytes. DSM reports these as decimal strings, which overflow no number at this scale. */
  size: number
  used: number
  status: string
  fsType: string
}

export interface SynologyDisk {
  id: string
  name: string
  model: string
  /** Degrees Celsius, or null when DSM does not report one (an M.2 on some models). */
  temperature: number | null
  /** DSM's own SMART verdict, lower-cased: `normal`, `warning`, `critical`… */
  smart: string
  status: string
  /** Which volume the disk belongs to, when DSM says. */
  container: string
}

export interface SynologySnapshot {
  /** Percent, 0–100, of the whole machine. */
  cpu: number | null
  memory: { usedPercent: number | null; totalBytes: number | null }
  /** Bytes per second, summed over the interfaces DSM reports. */
  network: { rx: number | null; tx: number | null }
  uptimeSeconds: number | null
  volumes: SynologyVolume[]
  disks: SynologyDisk[]
  /** The last moment any of this was true, as epoch milliseconds. */
  at: number
  /** `offline`, `unauthorized`, `unconfigured`, or absent when the last poll worked. */
  error?: string
}

export const EMPTY_SNAPSHOT: SynologySnapshot = {
  cpu: null, memory: { usedPercent: null, totalBytes: null }, network: { rx: null, tx: null },
  uptimeSeconds: null, volumes: [], disks: [], at: 0,
}

/** DSM answers `{ success, data? , error? }` for everything. */
const EnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
})

const LoginSchema = z.object({ sid: z.string().min(1), device_id: z.string().optional() })

/** A number DSM may have written as a string, which it does inconsistently across versions. */
const num = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}).nullable()

export const UtilizationSchema = z.object({
  cpu: z.object({ user_load: num.optional(), system_load: num.optional(), other_load: num.optional() }).optional(),
  memory: z.object({ real_usage: num.optional(), memory_size: num.optional() }).optional(),
  network: z.array(z.object({ device: z.string().optional(), rx: num.optional(), tx: num.optional() })).optional(),
  time: z.object({ uptime: num.optional() }).optional(),
})

export const StorageSchema = z.object({
  volumes: z.array(z.object({
    id: z.string().optional(),
    display_name: z.string().optional(),
    size: z.object({ total: num.optional(), used: num.optional() }).optional(),
    status: z.string().optional(),
    fs_type: z.string().optional(),
  })).optional(),
  disks: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    model: z.string().optional(),
    temp: num.optional(),
    smart_status: z.string().optional(),
    status: z.string().optional(),
    container: z.object({ str: z.string().optional() }).optional(),
  })).optional(),
})

export interface SynologyTransport {
  (url: URL, opts: { rejectUnauthorized: boolean; timeoutMs: number }): Promise<{ status: number; body: Buffer }>
}

/** One GET, by hand, so `rejectUnauthorized` can be a per-connection decision. */
export const httpsTransport: SynologyTransport = (url, opts) =>
  new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: 'GET',
      rejectUnauthorized: opts.rejectUnauthorized,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    }
    const req = httpsRequest(url, options, (res) => {
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > MAX_ANSWER_BYTES) { req.destroy(); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

export interface SynologyClientOptions {
  host: string
  port: number
  account: string
  password: string
  otp?: string
  /** Written back by the caller after a 2FA login, so the code is asked for once. */
  deviceId?: string
  allowSelfSigned?: boolean
  transport?: SynologyTransport
  timeoutMs?: number
}

/**
 * One NAS, one session.
 *
 * The session id lives in memory and nowhere else: it is not written to the config, not stored
 * as a secret, and not logged. A restart logs in again, which is cheap, and a session that DSM
 * has forgotten (105 or 119) is re-established once per call rather than surfacing as an error.
 */
export class SynologyClient {
  private sid: string | null = null
  private readonly opts: SynologyClientOptions
  private readonly transport: SynologyTransport
  /** Set when DSM hands one back, so the caller can store it and stop asking for a code. */
  deviceId: string | null = null

  constructor(opts: SynologyClientOptions) {
    this.opts = opts
    this.transport = opts.transport ?? httpsTransport
    this.deviceId = opts.deviceId ?? null
  }

  private url(params: Record<string, string>): URL {
    const url = new URL(`https://${this.opts.host.includes(':') ? `[${this.opts.host}]` : this.opts.host}:${this.opts.port}/webapi/entry.cgi`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url
  }

  private async call(params: Record<string, string>): Promise<unknown> {
    let answer: { status: number; body: Buffer }
    try {
      answer = await this.transport(this.url(params), {
        rejectUnauthorized: !this.opts.allowSelfSigned,
        timeoutMs: this.opts.timeoutMs ?? SYNOLOGY_TIMEOUT_MS,
      })
    } catch {
      // Deliberately swallowed: a TLS or DNS error's message carries the host, and on a LAN the
      // host is the user's own address. The caller says "offline" instead.
      throw new SynologyError(null, 'network')
    }
    if (answer.status < 200 || answer.status >= 300) throw new SynologyError(null, 'network')
    let parsed: z.infer<typeof EnvelopeSchema>
    try { parsed = EnvelopeSchema.parse(JSON.parse(answer.body.toString('utf8'))) }
    catch { throw new SynologyError(null, 'answer') }
    if (parsed.success) return parsed.data
    const code = parsed.error?.code ?? null
    if (code !== null && SESSION_GONE.has(code)) throw new SynologyError(code, 'session')
    if (code !== null && AUTH_FAILED.has(code)) throw new SynologyError(code, 'auth')
    throw new SynologyError(code, 'answer')
  }

  /** Logs in, keeping the device token DSM hands back when a one-time code was given. */
  async login(): Promise<void> {
    const params: Record<string, string> = {
      api: 'SYNO.API.Auth', version: '6', method: 'login',
      account: this.opts.account, passwd: this.opts.password, format: 'sid',
    }
    if (this.opts.otp) { params.otp_code = this.opts.otp; params.enable_device_token = 'yes' }
    else if (this.deviceId) params.device_id = this.deviceId
    const data = LoginSchema.safeParse(await this.call(params))
    if (!data.success) throw new SynologyError(null, 'answer')
    this.sid = data.data.sid
    if (data.data.device_id) this.deviceId = data.data.device_id
  }

  async logout(): Promise<void> {
    if (!this.sid) return
    const sid = this.sid
    this.sid = null
    try { await this.call({ api: 'SYNO.API.Auth', version: '1', method: 'logout', session: 'FremkitDSM', _sid: sid }) }
    catch { /* a session the NAS already dropped is the outcome we wanted */ }
  }

  /** A call that logs in first if needed, and once more if DSM says the session is gone. */
  private async authed(params: Record<string, string>): Promise<unknown> {
    if (!this.sid) await this.login()
    try {
      return await this.call({ ...params, _sid: this.sid ?? '' })
    } catch (err) {
      if (!(err instanceof SynologyError) || err.kind !== 'session') throw err
      this.sid = null
      await this.login()
      return this.call({ ...params, _sid: this.sid ?? '' })
    }
  }

  async utilization(): Promise<z.infer<typeof UtilizationSchema>> {
    const raw = await this.authed({ api: 'SYNO.Core.System.Utilization', version: '1', method: 'get' })
    const parsed = UtilizationSchema.safeParse(raw)
    if (!parsed.success) throw new SynologyError(null, 'answer')
    return parsed.data
  }

  async storage(): Promise<z.infer<typeof StorageSchema>> {
    const raw = await this.authed({ api: 'SYNO.Storage.CGI.Storage', version: '1', method: 'load_info' })
    const parsed = StorageSchema.safeParse(raw)
    if (!parsed.success) throw new SynologyError(null, 'answer')
    return parsed.data
  }
}

/** The three CPU loads DSM reports, added up, or null when it reported none. */
export function cpuPercent(cpu: z.infer<typeof UtilizationSchema>['cpu']): number | null {
  const parts = [cpu?.user_load, cpu?.system_load, cpu?.other_load].filter((v): v is number => typeof v === 'number')
  if (!parts.length) return null
  return Math.min(100, Math.max(0, Math.round(parts.reduce((a, b) => a + b, 0))))
}

export function toSnapshot(
  util: z.infer<typeof UtilizationSchema>,
  storage: z.infer<typeof StorageSchema>,
  at: number,
): SynologySnapshot {
  const sum = (key: 'rx' | 'tx'): number | null => {
    const values = (util.network ?? [])
      // DSM lists `total` alongside each interface; counting both would double everything.
      .filter((n) => n.device !== 'total')
      .map((n) => n[key])
      .filter((v): v is number => typeof v === 'number')
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  return {
    cpu: cpuPercent(util.cpu),
    memory: {
      usedPercent: typeof util.memory?.real_usage === 'number' ? util.memory.real_usage : null,
      // DSM reports memory_size in kilobytes.
      totalBytes: typeof util.memory?.memory_size === 'number' ? util.memory.memory_size * 1024 : null,
    },
    network: { rx: sum('rx'), tx: sum('tx') },
    uptimeSeconds: typeof util.time?.uptime === 'number' ? util.time.uptime : null,
    volumes: (storage.volumes ?? []).map((v) => ({
      id: v.display_name || v.id || '',
      size: v.size?.total ?? 0,
      used: v.size?.used ?? 0,
      status: (v.status ?? '').toLowerCase(),
      fsType: (v.fs_type ?? '').toLowerCase(),
    })),
    disks: (storage.disks ?? []).map((d) => ({
      id: d.id ?? '',
      name: d.name ?? d.id ?? '',
      model: (d.model ?? '').trim(),
      temperature: typeof d.temp === 'number' ? d.temp : null,
      smart: (d.smart_status ?? '').toLowerCase(),
      status: (d.status ?? '').toLowerCase(),
      container: d.container?.str ?? '',
    })),
    at,
  }
}

export interface SynologyProviderDeps {
  transport?: SynologyTransport
  now?: () => number
}

/**
 * The poller.
 *
 * Like every provider here it answers with its last good snapshot plus an `error` field rather
 * than with nothing: a widget that went blank on the first hiccup would be worse than one saying
 * the NAS is unreachable while still showing what it last knew. No commands in v1 — this reads.
 */
export function createSynologyProvider(ctx: ConnectionProviderContext, deps: SynologyProviderDeps = {}): Provider {
  const now = deps.now ?? Date.now
  const parsed = parseHost(ctx.fields.host ?? '')
  const account = (ctx.fields.account ?? '').trim()
  const allowSelfSigned = ctx.fields.allowSelfSigned === 'true'

  let last: SynologySnapshot = { ...EMPTY_SNAPSHOT }
  let failed = false
  let client: SynologyClient | null = null
  let storedDeviceId = ctx.secrets.deviceId ?? ''

  const build = (): SynologyClient | null => {
    if (!parsed || !account || !ctx.secrets.password) return null
    if (!client) {
      client = new SynologyClient({
        host: parsed.host, port: parsed.port, account,
        password: ctx.secrets.password,
        // Only on the first login of this process: DSM refuses a code it has already seen, and
        // the device token is what replaces it afterwards.
        ...(ctx.secrets.otp && !storedDeviceId ? { otp: ctx.secrets.otp } : {}),
        ...(storedDeviceId ? { deviceId: storedDeviceId } : {}),
        allowSelfSigned,
        ...(deps.transport ? { transport: deps.transport } : {}),
      })
    }
    return client
  }

  const fail = (error: string): SynologySnapshot => {
    failed = true
    last = { ...last, error, at: last.at }
    return last
  }

  return {
    channel: ctx.channel,
    /** A NAS that just failed is worth asking again sooner than one that is answering. */
    get intervalMs() { return failed ? SYNOLOGY_RETRY_MS : SYNOLOGY_POLL_MS },

    async poll(): Promise<SynologySnapshot> {
      const nas = build()
      if (!nas) return fail('unconfigured')
      try {
        const [util, storage] = [await nas.utilization(), await nas.storage()]
        // DSM issued a device token: store it as this connection's secret, so the one-time code
        // is asked for once rather than at every restart.
        if (nas.deviceId && nas.deviceId !== storedDeviceId) {
          storedDeviceId = nas.deviceId
          await ctx.saveSecret?.('deviceId', nas.deviceId).catch(() => {
            // Not fatal: the session is open and the poll succeeded. The cost of failing here is
            // that the next restart asks for a code again, which is the situation we were in.
          })
        }
        failed = false
        last = toSnapshot(util, storage, now())
        return last
      } catch (err) {
        // The session is dropped on any failure, so the next poll logs in rather than reusing
        // something the NAS may have forgotten while we were not looking.
        client = null
        if (err instanceof SynologyError && err.kind === 'auth') return fail('unauthorized')
        return fail('offline')
      }
    },

    stop(): void {
      const nas = client
      client = null
      void nas?.logout().catch(() => {})
    },
  }
}

/** The one-line answer the connection's Test button shows. */
export function testDetail(snapshot: SynologySnapshot): string {
  return tr(undefined, 'synology.connected', {
    volumes: String(snapshot.volumes.length),
    disks: String(snapshot.disks.length),
  })
}
