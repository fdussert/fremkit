/**
 * A Synology NAS, through the DSM Web API.
 *
 * Endpoint provenance, so the next reader knows what is solid:
 *  - `SYNO.API.Auth` v6, `method=login`, `format=sid` — returns a session id. With an `otp_code`
 *    and `enable_device_token=yes` it also returns a `device_id`, which stands in for the code on
 *    every later login. That is the whole reason the one-time code is asked for once: DSM will
 *    not take the same six digits twice, so without the device token a 2FA account would need a
 *    fresh code every restart. `session` and `device_name` are sent too: DSM keys a session on
 *    the name, so a logout under a different name would not end it, and the name is what shows
 *    up in DSM's trusted-devices list.
 *  - `SYNO.API.Auth` v1, `method=logout` — ends a session. Used by the provider when its channel
 *    goes quiet and by anything that fails, so a session does not linger on the NAS.
 *  - `SYNO.Core.System.Utilization` v1, `method=get` — CPU, memory and network counters.
 *  - `SYNO.Core.System` v1, `method=info` — `model`, `firmware_ver` and `up_time`, the only
 *    source of the uptime (checked against a DS918+ on DSM 7.1.1: `up_time` is `"106:42:43"`,
 *    hours first, and the utilization answer's `time` is an epoch, not an uptime).
 *  - `SYNO.Storage.CGI.Storage` v1, `method=load_info` — volumes and disks: size, used, status,
 *    model, temperature, SMART verdict.
 *
 * **Everything is a POST.** DSM accepts the parameters as an `application/x-www-form-urlencoded`
 * body, and that is where the password, the one-time code and the session id belong: a query
 * string lands in the NAS's own access log and in any reverse proxy in front of it. Only `api`,
 * `version` and `method` stay in the URL, because `entry.cgi` routes on them and none of the
 * three is a secret.
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

import type { MessageKey } from '../i18n.js'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { z } from 'zod'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'

/** One request may take this long; a NAS waking a sleeping disk array is slow. */
export const SYNOLOGY_TIMEOUT_MS = 15_000
/** The nominal cadence; a failure retries sooner, as every provider here does. */
export const SYNOLOGY_POLL_MS = 30_000
export const SYNOLOGY_RETRY_MS = 10_000
export const SYNOLOGY_DEFAULT_PORT = 5001
/** An answer bigger than this is not a DSM answer. Sixteen disks of metadata is a few kilobytes. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024
/**
 * The session name DSM keys this session on, sent on login *and* logout.
 *
 * It has to be the same on both, or the logout ends a session that does not exist and ours
 * lingers on the NAS until DSM expires it.
 */
export const SESSION_NAME = 'FremkitDSM'
/** What DSM's trusted-devices list will call this Mac after a two-factor enrolment. */
export const DEVICE_NAME = 'Fremkit'

/**
 * DSM error codes, and what each one means for the next call.
 *
 * `SESSION_GONE` is "log in again and retry once": 106 is a timeout, 107 a session interrupted
 * by a duplicate login, 119 a session id DSM does not know. 105 is *not* one of them — it means
 * the account lacks the privilege for that API, and retrying the login changes nothing; it used
 * to sit here and turned a read-only account without storage rights into a login loop reported
 * as `offline`.
 */
const SESSION_GONE = new Set([106, 107, 119])
/** The account lacks the privilege for this API. Re-logging in will not help. */
const FORBIDDEN = 105
/**
 * Why DSM refused a login, **on the login call only**.
 *
 * `SYNO.API.Auth` has a code per reason and they are not interchangeable: a disabled account, an
 * account forbidden the DSM application, an address the auto-block list caught and an expired
 * password are four different things to go and do, and collapsing them into "account or password
 * refused" sends the user to retype a password that was never the problem. On
 * `SYNO.Core.System.Utilization` the same numbers mean something else entirely, which is why this
 * table is applied in `login()` and nowhere else.
 *
 * The keys are messages for the admin's Test button. The provider's snapshot stays `unauthorized`
 * for all of them — a widget on the wall has one word of room, and it is the same word.
 */
export const LOGIN_REFUSALS: Record<number, MessageKey> = {
  400: 'synology.unauthorized',
  401: 'synology.accountDisabled',
  402: 'synology.dsmNotAllowed',
  404: 'synology.otpRejected',
  407: 'synology.ipBlocked',
  408: 'synology.passwordExpired',
  409: 'synology.passwordExpired',
  410: 'synology.passwordExpired',
}
const AUTH_FAILED = new Set([...Object.keys(LOGIN_REFUSALS).map(Number), 403, 406])
/**
 * DSM's "a one-time code is required", which only arrives once the password was accepted.
 *
 * Two codes, not one: 403 asks for the code, 406 says the account is *required* to use two-factor
 * and has not. Either way the password was accepted and the next step is the same.
 */
export const OTP_REQUIRED = 403
const OTP_REQUIRED_CODES = new Set([OTP_REQUIRED, 406])

/** The message for a refused login, falling back to the catch-all for a code DSM added since. */
export function loginRefusal(code: number | null): MessageKey {
  return (code !== null && LOGIN_REFUSALS[code]) || 'synology.unauthorized'
}

export type SynologyErrorKind = 'auth' | 'otpRequired' | 'forbidden' | 'session' | 'network' | 'answer'

export class SynologyError extends Error {
  constructor(readonly code: number | null, readonly kind: SynologyErrorKind) {
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
  /** From `SYNO.Core.System` `info.up_time`; null until that call has answered once. */
  uptimeSeconds: number | null
  /** `SYNO.Core.System` `info.model`, e.g. `DS923+`. Null until that call has answered once. */
  model: string | null
  /** `SYNO.Core.System` `info.firmware_ver`, DSM's own version string. */
  dsmVersion: string | null
  volumes: SynologyVolume[]
  disks: SynologyDisk[]
  /** The last moment any of this was true, as epoch milliseconds. */
  at: number
  /** `offline`, `unauthorized`, `forbidden`, `unconfigured`, or absent when the poll worked. */
  error?: string
}

export const EMPTY_SNAPSHOT: SynologySnapshot = {
  cpu: null, memory: { usedPercent: null, totalBytes: null }, network: { rx: null, tx: null },
  uptimeSeconds: null, model: null, dsmVersion: null, volumes: [], disks: [], at: 0,
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
  // No `time` here: DSM 7.1 answers `time: <epoch seconds>`, a number, and a schema that read
  // it as `{ uptime }` refused the whole answer as "not a DSM". The uptime comes from
  // `SYNO.Core.System` alone.
})

/**
 * `SYNO.Core.System` `method=info`. `up_time` is a duration DSM formats as text on some
 * versions (`"12 days 3:14:15"`) and as a number of seconds on others, so both are read.
 */
export const SystemInfoSchema = z.object({
  model: z.string().optional(),
  firmware_ver: z.string().optional(),
  up_time: z.union([z.number(), z.string()]).optional(),
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

/** One request, as the transport receives it. `body` is already form-encoded. */
export interface SynologyRequest {
  url: URL
  method: 'POST'
  body: string
  rejectUnauthorized: boolean
  timeoutMs: number
}

export type SynologyTransport = (req: SynologyRequest) => Promise<{ status: number; body: Buffer }>

export class AnswerTooLargeError extends Error {
  constructor() {
    super('answer too large')
    this.name = 'AnswerTooLargeError'
  }
}

/**
 * Reads a response body with a ceiling, and **throws** past it.
 *
 * Throwing is the whole point. The first version destroyed the request and returned, relying on
 * an `error` event Node does not promise — and the provider registry awaits `poll()` with no
 * timeout, so a NAS (or anything answering for its address) streaming past the cap would have
 * stopped the channel for the life of the process. Awaiting the stream rather than juggling
 * `data`/`end`/`error` also means there is only one way out.
 */
export async function readCapped(stream: AsyncIterable<Buffer | Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > max) throw new AnswerTooLargeError()
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** One POST, by hand, so `rejectUnauthorized` can be a per-connection decision. */
export const httpsTransport: SynologyTransport = (req) =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(req.body, 'utf8')
    const options: RequestOptions = {
      method: req.method,
      rejectUnauthorized: req.rejectUnauthorized,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        'content-length': String(body.byteLength),
      },
    }
    const client = httpsRequest(req.url, options, (res) => {
      readCapped(res, MAX_ANSWER_BYTES).then(
        (read) => resolve({ status: res.statusCode ?? 0, body: read }),
        (err: Error) => { client.destroy(); reject(err) },
      )
    })
    client.setTimeout(req.timeoutMs, () => client.destroy(new Error('timeout')))
    client.on('error', reject)
    client.end(body)
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
 * has forgotten (106, 107, 119) is re-established once per call rather than surfacing as an
 * error.
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

  private url(api: string, version: string, method: string): URL {
    const host = this.opts.host.includes(':') ? `[${this.opts.host}]` : this.opts.host
    const url = new URL(`https://${host}:${this.opts.port}/webapi/entry.cgi`)
    // Only the routing triple. Everything else travels in the body — see the note at the top.
    url.searchParams.set('api', api)
    url.searchParams.set('version', version)
    url.searchParams.set('method', method)
    return url
  }

  /**
   * One call. `on` says how to read a DSM error code: the login table only applies to the login.
   */
  private async call(
    route: { api: string; version: string; method: string },
    params: Record<string, string>,
    on: 'login' | 'data',
  ): Promise<unknown> {
    const body = new URLSearchParams({ ...params, api: route.api, version: route.version, method: route.method })
    let answer: { status: number; body: Buffer }
    try {
      answer = await this.transport({
        url: this.url(route.api, route.version, route.method),
        method: 'POST',
        body: body.toString(),
        rejectUnauthorized: !this.opts.allowSelfSigned,
        timeoutMs: this.opts.timeoutMs ?? SYNOLOGY_TIMEOUT_MS,
      })
    } catch {
      // Deliberately swallowed: a TLS or DNS error's message carries the host, and on a LAN the
      // host is the user's own address. The caller says "offline" instead.
      throw new SynologyError(null, 'network')
    }
    // A 3xx is a hop nothing here has checked, and DSM has no reason to redirect its own API.
    if (answer.status < 200 || answer.status >= 300) throw new SynologyError(null, 'network')
    let parsed: z.infer<typeof EnvelopeSchema>
    try { parsed = EnvelopeSchema.parse(JSON.parse(answer.body.toString('utf8'))) }
    catch { throw new SynologyError(null, 'answer') }
    if (parsed.success) return parsed.data
    const code = parsed.error?.code ?? null
    if (code === FORBIDDEN) throw new SynologyError(code, 'forbidden')
    if (code !== null && SESSION_GONE.has(code)) throw new SynologyError(code, 'session')
    if (on === 'login' && code !== null && OTP_REQUIRED_CODES.has(code)) throw new SynologyError(code, 'otpRequired')
    if (on === 'login' && code !== null && AUTH_FAILED.has(code)) throw new SynologyError(code, 'auth')
    throw new SynologyError(code, 'answer')
  }

  /** Logs in, keeping the device token DSM hands back when a one-time code was given. */
  async login(): Promise<void> {
    const params: Record<string, string> = {
      account: this.opts.account,
      passwd: this.opts.password,
      format: 'sid',
      session: SESSION_NAME,
    }
    if (this.opts.otp) {
      params.otp_code = this.opts.otp
      params.enable_device_token = 'yes'
      params.device_name = DEVICE_NAME
    } else if (this.deviceId) {
      params.device_id = this.deviceId
    }
    const data = LoginSchema.safeParse(await this.call({ api: 'SYNO.API.Auth', version: '6', method: 'login' }, params, 'login'))
    if (!data.success) throw new SynologyError(null, 'answer')
    this.sid = data.data.sid
    if (data.data.device_id) this.deviceId = data.data.device_id
  }

  async logout(): Promise<void> {
    if (!this.sid) return
    const sid = this.sid
    this.sid = null
    try {
      await this.call({ api: 'SYNO.API.Auth', version: '1', method: 'logout' }, { session: SESSION_NAME, _sid: sid }, 'data')
    } catch { /* a session the NAS already dropped is the outcome we wanted */ }
  }

  /** A call that logs in first if needed, and once more if DSM says the session is gone. */
  private async authed(route: { api: string; version: string; method: string }, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.sid) await this.login()
    try {
      return await this.call(route, { ...params, _sid: this.sid ?? '' }, 'data')
    } catch (err) {
      if (!(err instanceof SynologyError) || err.kind !== 'session') throw err
      this.sid = null
      await this.login()
      return this.call(route, { ...params, _sid: this.sid ?? '' }, 'data')
    }
  }

  async utilization(): Promise<z.infer<typeof UtilizationSchema>> {
    const raw = await this.authed({ api: 'SYNO.Core.System.Utilization', version: '1', method: 'get' })
    const parsed = UtilizationSchema.safeParse(raw)
    if (!parsed.success) throw new SynologyError(null, 'answer')
    return parsed.data
  }

  async systemInfo(): Promise<z.infer<typeof SystemInfoSchema>> {
    const raw = await this.authed({ api: 'SYNO.Core.System', version: '1', method: 'info' })
    const parsed = SystemInfoSchema.safeParse(raw)
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

/**
 * `up_time` as seconds.
 *
 * DSM writes it as a number of seconds on some versions and as `"12 days 3:14:15"` — or
 * `"3:14:15"` — on others, so both shapes are read and anything else is null rather than a
 * confident zero.
 */
export function upTimeSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const m = /^(?:(\d+)\s*\D+?\s+)?(\d+):(\d{2}):(\d{2})$/.exec(trimmed)
  if (!m) return null
  const days = m[1] ? Number(m[1]) : 0
  return days * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

export function toSnapshot(
  util: z.infer<typeof UtilizationSchema>,
  storage: z.infer<typeof StorageSchema>,
  at: number,
  info: z.infer<typeof SystemInfoSchema> = {},
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
    uptimeSeconds: upTimeSeconds(info.up_time),
    model: info.model?.trim() || null,
    dsmVersion: info.firmware_ver?.trim() || null,
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
  /** What `SYNO.Core.System` last said. Kept so the model survives a poll that only half worked. */
  let info: z.infer<typeof SystemInfoSchema> = {}

  const build = (): SynologyClient | null => {
    if (!parsed || !account || !ctx.secrets.password) return null
    if (!client) {
      client = new SynologyClient({
        host: parsed.host, port: parsed.port, account,
        password: ctx.secrets.password,
        // Only while no device token exists: DSM refuses a code it has already seen, and the
        // token is what replaces it afterwards.
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

  /** Drops the session, logging out first so it does not linger on the NAS until it expires. */
  const drop = (): void => {
    const nas = client
    client = null
    void nas?.logout().catch(() => {})
  }

  return {
    channel: ctx.channel,
    /** A NAS that just failed is worth asking again sooner than one that is answering. */
    get intervalMs() { return failed ? SYNOLOGY_RETRY_MS : SYNOLOGY_POLL_MS },

    async poll(): Promise<SynologySnapshot> {
      const nas = build()
      if (!nas) return fail('unconfigured')
      try {
        const util = await nas.utilization()
        const storage = await nas.storage()
        // One more request per poll, and the only source of the model and the DSM version. Its
        // failure is not the poll's: an account without this privilege still gets its gauges.
        try { info = await nas.systemInfo() } catch { /* keep whatever it said last */ }
        // DSM issued a device token: store it as this connection's secret, so the one-time code
        // is asked for once rather than at every restart, and forget the code itself.
        if (nas.deviceId && nas.deviceId !== storedDeviceId) {
          storedDeviceId = nas.deviceId
          await ctx.saveSecret?.('deviceId', nas.deviceId).catch(() => {
            // Not fatal: the session is open and the poll succeeded. The cost of failing here is
            // that the next restart asks for a code again, which is the situation we were in.
          })
          // The code is spent — DSM will not take it twice — and a spent secret sitting in the
          // store is one more thing that could be sent somewhere.
          await ctx.forgetSecret?.('otp').catch(() => {})
        }
        failed = false
        last = toSnapshot(util, storage, now(), info)
        return last
      } catch (err) {
        // The session is dropped on any failure, so the next poll logs in rather than reusing
        // something the NAS may have forgotten while we were not looking.
        drop()
        if (err instanceof SynologyError && (err.kind === 'auth' || err.kind === 'otpRequired')) return fail('unauthorized')
        if (err instanceof SynologyError && err.kind === 'forbidden') return fail('forbidden')
        return fail('offline')
      }
    },

    stop(): void { drop() },
  }
}
