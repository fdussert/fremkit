import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SNAPSHOT,
  SYNOLOGY_POLL_MS,
  SYNOLOGY_RETRY_MS,
  SynologyClient,
  SynologyError,
  createSynologyProvider,
  loginRefusal,
  cpuPercent,
  parseHost,
  toSnapshot,
  type SynologySnapshot,
  DEVICE_NAME,
  SESSION_NAME,
  StorageSchema,
  SystemInfoSchema,
  UtilizationSchema,
  upTimeSeconds,
  httpsTransport,
  readCapped,
  MAX_ANSWER_BYTES,
  type SynologyRequest,
  type SynologyTransport,
} from '../src/providers/synology.js'
import { synologyType } from '../src/connections/types/synology.js'

const UTIL = {
  cpu: { user_load: 12, system_load: '3', other_load: 0 },
  memory: { real_usage: 47, memory_size: 8 * 1024 * 1024 },
  network: [
    { device: 'total', rx: 999999, tx: 999999 },
    { device: 'eth0', rx: 1200, tx: 340 },
    { device: 'eth1', rx: 100, tx: 60 },
  ],
  // What a DS918+ on DSM 7.1.1 actually sends: an epoch, not an uptime. It must be ignored,
  // not refused — reading it as `{ uptime }` once turned every real NAS into "not a DSM".
  time: 1789745232,
}

const STORAGE = {
  volumes: [
    { id: 'volume_1', display_name: 'volume 1', size: { total: '1000', used: '400' }, status: 'normal', fs_type: 'btrfs' },
  ],
  disks: [
    { id: 'sata1', name: 'Disk 1', model: ' HAT5300-8T ', temp: 38, smart_status: 'Normal', status: 'normal', container: { str: 'Internal' } },
    { id: 'nvme1', name: 'SSD 1', model: 'SNV3410', smart_status: 'normal', status: 'normal' },
  ],
}

/**
 * A NAS in a function. `answers` maps the `api` parameter to what DSM sends back; every request
 * is recorded whole — url, method, body and TLS choice — so a test can assert what was asked,
 * how, and above all what never went into the URL.
 */
function nas(answers: Record<string, unknown>, opts: { fail?: boolean; status?: number } = {}) {
  const calls: SynologyRequest[] = []
  const transport: SynologyTransport = async (req) => {
    calls.push(req)
    if (opts.fail) throw new Error('ECONNREFUSED 192.0.2.10:5001')
    if (opts.status) return { status: opts.status, body: Buffer.from('') }
    const api = req.url.searchParams.get('api') ?? ''
    const body = answers[api]
    if (body === undefined) return { status: 404, body: Buffer.from('') }
    return { status: 200, body: Buffer.from(JSON.stringify(body)) }
  }
  /** The form body of a recorded call, parsed. */
  const form = (call: SynologyRequest): URLSearchParams => new URLSearchParams(call.body)
  const of = (method: string): SynologyRequest | undefined =>
    calls.find((c) => c.url.searchParams.get('method') === method)
  return { transport, calls, form, of }
}

const INFO = { model: 'DS923+', firmware_ver: 'DSM 7.2.2-72806', up_time: '12 days 3:14:15' }

const OK = {
  'SYNO.API.Auth': { success: true, data: { sid: 'session-xyz' } },
  'SYNO.Core.System.Utilization': { success: true, data: UTIL },
  'SYNO.Core.System': { success: true, data: INFO },
  'SYNO.Storage.CGI.Storage': { success: true, data: STORAGE },
}

/** A DSM that answers one error code to everything but the login. */
function refusing(code: number): SynologyTransport {
  return async (req) => {
    const login = req.url.searchParams.get('method') === 'login'
    const body = login ? OK['SYNO.API.Auth'] : { success: false, error: { code } }
    return { status: 200, body: Buffer.from(JSON.stringify(body)) }
  }
}

/** A DSM that refuses the login itself, which is the only call the refusal table applies to. */
function refusingLogin(code: number): SynologyTransport {
  return async () => ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code } })) })
}

describe('parseHost', () => {
  it('takes a name or an address, with or without a port', () => {
    expect(parseHost('192.0.2.10')).toEqual({ host: '192.0.2.10', port: 5001 })
    expect(parseHost('nas.example.com:5443')).toEqual({ host: 'nas.example.com', port: 5443 })
    expect(parseHost('[2001:db8::1]:5001')).toEqual({ host: '2001:db8::1', port: 5001 })
  })
  it('reduces a URL, which is what half the world will paste', () => {
    expect(parseHost('https://192.0.2.10:5001/')).toEqual({ host: '192.0.2.10', port: 5001 })
    expect(parseHost('http://nas.example.com/webman/index.cgi')).toEqual({ host: 'nas.example.com', port: 5001 })
  })
  it('refuses what it cannot dial', () => {
    for (const raw of ['', '  ', ':5001', '192.0.2.10:0', '192.0.2.10:99999', 'a b']) {
      expect(parseHost(raw), raw).toBeNull()
    }
  })
})

describe('cpuPercent', () => {
  it('adds the three loads DSM reports and clamps the result', () => {
    expect(cpuPercent({ user_load: 12, system_load: 3, other_load: 1 })).toBe(16)
    expect(cpuPercent({ user_load: 90, system_load: 30, other_load: 0 })).toBe(100)
    expect(cpuPercent({})).toBeNull()
    expect(cpuPercent(undefined)).toBeNull()
  })
})

describe('toSnapshot', () => {
  // Through the schemas, because that is how the client hands the data over — and the strings
  // DSM writes some of its numbers as are turned into numbers exactly there.
  const snapshot = toSnapshot(UtilizationSchema.parse(UTIL), StorageSchema.parse(STORAGE), 1000, SystemInfoSchema.parse(INFO))

  it('reads the numbers DSM writes as strings', () => {
    expect(snapshot.cpu).toBe(15)
    expect(snapshot.volumes[0]).toEqual({ id: 'volume 1', size: 1000, used: 400, status: 'normal', fsType: 'btrfs' })
  })

  it('does not count the "total" interface twice', () => {
    expect(snapshot.network).toEqual({ rx: 1300, tx: 400 })
  })

  it('turns DSM\'s kilobytes into bytes', () => {
    expect(snapshot.memory).toEqual({ usedPercent: 47, totalBytes: 8 * 1024 * 1024 * 1024 })
  })

  it('normalises a disk, and leaves a missing temperature null rather than zero', () => {
    expect(snapshot.disks[0]).toEqual({
      id: 'sata1', name: 'Disk 1', model: 'HAT5300-8T', temperature: 38,
      smart: 'normal', status: 'normal', container: 'Internal',
    })
    expect(snapshot.disks[1].temperature).toBeNull()
    expect(snapshot.disks[1].container).toBe('')
  })

  it('answers something usable for a DSM that reported nothing', () => {
    const empty = toSnapshot(UtilizationSchema.parse({}), StorageSchema.parse({}), 5)
    expect(empty).toEqual({ ...EMPTY_SNAPSHOT, at: 5 })
  })
})

describe('SynologyClient', () => {
  const client = (transport: SynologyTransport, over: Record<string, unknown> = {}) =>
    new SynologyClient({ host: '192.0.2.10', port: 5001, account: 'fremkit', password: 'pw', transport, ...over })

  it('logs in once and reuses the session', async () => {
    const { transport, calls, form } = nas(OK)
    const c = client(transport)
    await c.utilization()
    await c.storage()
    expect(calls.filter((u) => u.url.searchParams.get('method') === 'login')).toHaveLength(1)
    expect(form(calls[1]).get('_sid')).toBe('session-xyz')
  })

  it('sends every parameter in a POST body, and only the routing triple in the URL', async () => {
    // A query string lands in the NAS's access log and in any proxy in front of it. The password
    // and the session id have no business being there.
    const { transport, calls, form } = nas(OK)
    await client(transport).utilization()
    const login = calls[0]
    expect(login.method).toBe('POST')
    expect([...login.url.searchParams.keys()].sort()).toEqual(['api', 'method', 'version'])
    expect(login.url.toString()).not.toContain('passwd')
    expect(login.url.toString()).not.toContain('pw')
    expect(form(login).get('passwd')).toBe('pw')
    expect(form(login).get('account')).toBe('fremkit')
    expect(form(login).get('session')).toBe(SESSION_NAME)
    expect(calls[1].url.toString()).not.toContain('_sid')
  })

  it('names the session the same way on login and on logout', async () => {
    // DSM keys a session on the name; mismatched, the logout ends a session that is not ours.
    const { transport, calls, form } = nas(OK)
    const c = client(transport)
    await c.utilization()
    await c.logout()
    const names = calls
      .filter((u) => ['login', 'logout'].includes(u.url.searchParams.get('method') ?? ''))
      .map((u) => form(u).get('session'))
    expect(names).toEqual([SESSION_NAME, SESSION_NAME])
  })

  it('passes rejectUnauthorized through from allowSelfSigned', async () => {
    const lax = nas(OK)
    await client(lax.transport, { allowSelfSigned: true }).utilization()
    expect(lax.calls.every((c) => c.rejectUnauthorized === false)).toBe(true)
    const strict = nas(OK)
    await client(strict.transport).utilization()
    expect(strict.calls.every((c) => c.rejectUnauthorized === true)).toBe(true)
  })

  it('logs in again on every code that means the session is gone', async () => {
    // 106 timeout, 107 interrupted by a duplicate login, 119 a sid DSM does not know.
    for (const code of [106, 107, 119]) {
      let seen = 0
      const transport: SynologyTransport = async (req) => {
        if (req.url.searchParams.get('api') === 'SYNO.API.Auth') {
          return { status: 200, body: Buffer.from(JSON.stringify(OK['SYNO.API.Auth'])) }
        }
        seen++
        const body = seen === 1 ? { success: false, error: { code } } : { success: true, data: UTIL }
        return { status: 200, body: Buffer.from(JSON.stringify(body)) }
      }
      await expect(client(transport).utilization(), String(code)).resolves.toBeTruthy()
      expect(seen, String(code)).toBe(2)
    }
  })

  it('does not re-login on 105: the account lacks the privilege, and a new session will not help', async () => {
    const { transport, calls } = nas({})
    const forbidden: SynologyTransport = async (req) => {
      await transport(req)
      const login = req.url.searchParams.get('method') === 'login'
      const body = login ? OK['SYNO.API.Auth'] : { success: false, error: { code: 105 } }
      return { status: 200, body: Buffer.from(JSON.stringify(body)) }
    }
    await expect(client(forbidden).storage()).rejects.toMatchObject({ kind: 'forbidden' })
    expect(calls.filter((c) => c.url.searchParams.get('method') === 'login')).toHaveLength(1)
  })

  it('gives up rather than looping when the second login does not help', async () => {
    await expect(client(refusing(119)).utilization()).rejects.toMatchObject({ kind: 'session' })
  })

  it('reads the login error table on the login only', async () => {
    // 400–406 mean "wrong credentials" for SYNO.API.Auth. On SYNO.Core.System.Utilization the
    // same numbers mean something else, and calling them a credential failure was wrong.
    await expect(client(refusing(400)).utilization()).rejects.toMatchObject({ kind: 'answer' })
    const badPassword: SynologyTransport = async () =>
      ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 400 } })) })
    await expect(client(badPassword).utilization()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('reports a code request as its own kind, not as a wrong password', async () => {
    const needsOtp: SynologyTransport = async () =>
      ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 403 } })) })
    await expect(client(needsOtp).utilization()).rejects.toMatchObject({ kind: 'otpRequired' })
  })

  it('tells a refused account from an unreachable NAS, and refuses a redirect', async () => {
    const { transport } = nas(OK, { fail: true })
    await expect(client(transport).utilization()).rejects.toMatchObject({ kind: 'network' })
    const redirected = nas(OK, { status: 302 })
    await expect(client(redirected.transport).utilization()).rejects.toMatchObject({ kind: 'network' })
  })

  it('never puts the host in the error it throws', async () => {
    const { transport } = nas(OK, { fail: true })
    // The transport's own message carries the address; a LAN address is the user's own.
    await expect(client(transport).utilization()).rejects.toThrow(/^synology network$/)
  })

  it('asks for a device token with the one-time code, and uses it afterwards', async () => {
    const enrolling = nas(OK)
    const transport: SynologyTransport = async (req) => {
      await enrolling.transport(req)
      if (req.url.searchParams.get('api') !== 'SYNO.API.Auth') {
        return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: UTIL })) }
      }
      return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: { sid: 's', device_id: 'dev-1' } })) }
    }
    const withOtp = client(transport, { otp: '123456' })
    await withOtp.utilization()
    expect(withOtp.deviceId).toBe('dev-1')
    const enrol = enrolling.form(enrolling.of('login')!)
    expect(enrol.get('otp_code')).toBe('123456')
    expect(enrol.get('enable_device_token')).toBe('yes')
    // So the entry in DSM's trusted-devices list is recognisable.
    expect(enrol.get('device_name')).toBe(DEVICE_NAME)

    const again = nas(OK)
    await client(again.transport, { deviceId: 'dev-1' }).utilization()
    const login = again.form(again.of('login')!)
    expect(login.get('device_id')).toBe('dev-1')
    expect(login.get('otp_code')).toBeNull()
    expect(login.get('enable_device_token')).toBeNull()
  })

  it('refuses an answer that is not a DSM answer', async () => {
    const junk: SynologyTransport = async () => ({ status: 200, body: Buffer.from('<html>login page</html>') })
    await expect(client(junk).utilization()).rejects.toMatchObject({ kind: 'answer' })
  })

  it('logs out only when it has a session, and survives the NAS refusing', async () => {
    const { transport, calls } = nas(OK)
    const c = client(transport)
    await c.logout()
    expect(calls).toHaveLength(0)
    await c.utilization()
    await c.logout()
    expect(calls.some((u) => u.url.searchParams.get('method') === 'logout')).toBe(true)
  })
})

describe('createSynologyProvider', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    id: 'nas-1', channel: 'synology:nas-1',
    fields: { host: '192.0.2.10', account: 'fremkit', allowSelfSigned: 'true' },
    secrets: { password: 'pw' },
    ...over,
  })

  it('publishes a snapshot', async () => {
    const { transport } = nas(OK)
    const provider = createSynologyProvider(ctx(), { transport, now: () => 1000 })
    const snapshot = await provider.poll!() as SynologySnapshot
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.volumes).toHaveLength(1)
    expect(snapshot.disks).toHaveLength(2)
    expect(snapshot.at).toBe(1000)
  })

  it('answers `unconfigured` rather than dialling nothing', async () => {
    for (const fields of [{ host: '', account: 'a' }, { host: '192.0.2.10', account: '' }]) {
      const provider = createSynologyProvider(ctx({ fields }), { transport: nas(OK).transport })
      expect(((await provider.poll!()) as SynologySnapshot).error).toBe('unconfigured')
    }
    const noPassword = createSynologyProvider(ctx({ secrets: {} }), { transport: nas(OK).transport })
    expect(((await noPassword.poll!()) as SynologySnapshot).error).toBe('unconfigured')
  })

  it('keeps the last good snapshot and adds an error, rather than going blank', async () => {
    let broken = false
    const working = nas(OK)
    const transport: SynologyTransport = async (req) => {
      if (broken) throw new Error('ECONNREFUSED')
      return working.transport(req)
    }
    const provider = createSynologyProvider(ctx(), { transport, now: () => 7 })
    await provider.poll!()
    broken = true
    const after = await provider.poll!() as SynologySnapshot
    expect(after.error).toBe('offline')
    expect(after.volumes).toHaveLength(1)
    expect(after.at).toBe(7)
  })

  it('tells a refused account from an unreachable NAS', async () => {
    const refused: SynologyTransport = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 400 } })) })
    const provider = createSynologyProvider(ctx(), { transport: refused })
    expect(((await provider.poll!()) as SynologySnapshot).error).toBe('unauthorized')
  })

  it('asks again sooner after a failure', async () => {
    const { transport } = nas(OK)
    const provider = createSynologyProvider(ctx(), { transport })
    expect(provider.intervalMs).toBe(SYNOLOGY_POLL_MS)
    const broken = createSynologyProvider(ctx(), { transport: nas(OK, { fail: true }).transport })
    await broken.poll!()
    expect(broken.intervalMs).toBe(SYNOLOGY_RETRY_MS)
  })

  it('stores the device token the NAS issues, and forgets the code it spent', async () => {
    const transport: SynologyTransport = async (req) => {
      const api = req.url.searchParams.get('api')
      if (api === 'SYNO.API.Auth') return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: { sid: 's', device_id: 'dev-9' } })) }
      const body = OK[api as keyof typeof OK] ?? { success: true, data: UTIL }
      return { status: 200, body: Buffer.from(JSON.stringify(body)) }
    }
    const saveSecret = vi.fn(async () => {})
    const forgetSecret = vi.fn(async () => {})
    const provider = createSynologyProvider(ctx({ secrets: { password: 'pw', otp: '123456' }, saveSecret, forgetSecret }), { transport })
    await provider.poll!()
    expect(saveSecret).toHaveBeenCalledWith('deviceId', 'dev-9')
    // The six digits work once; leaving them in the store is a dead secret nobody needs.
    expect(forgetSecret).toHaveBeenCalledWith('otp')
    // Written once, not on every poll.
    await provider.poll!()
    expect(saveSecret).toHaveBeenCalledTimes(1)
    expect(forgetSecret).toHaveBeenCalledTimes(1)
  })

  it('does not resend a one-time code once a device token is stored', async () => {
    const { transport, form, of } = nas(OK)
    const provider = createSynologyProvider(ctx({ secrets: { password: 'pw', otp: '123456', deviceId: 'dev-1' } }), { transport })
    await provider.poll!()
    const login = form(of('login')!)
    expect(login.get('otp_code')).toBeNull()
    expect(login.get('device_id')).toBe('dev-1')
  })

  it('reads the model and the DSM version, and the uptime DSM formats as text', async () => {
    const { transport } = nas(OK)
    const provider = createSynologyProvider(ctx(), { transport })
    const snapshot = await provider.poll!() as SynologySnapshot
    expect(snapshot.model).toBe('DS923+')
    expect(snapshot.dsmVersion).toBe('DSM 7.2.2-72806')
    expect(snapshot.uptimeSeconds).toBe(12 * 86400 + 3 * 3600 + 14 * 60 + 15)
  })

  it('still polls when the account cannot read SYNO.Core.System', async () => {
    // One privilege short of the model is not one privilege short of the gauges.
    const transport: SynologyTransport = async (req) => {
      const api = req.url.searchParams.get('api')
      if (api === 'SYNO.Core.System') return { status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 105 } })) }
      const body = OK[api as keyof typeof OK]
      return { status: 200, body: Buffer.from(JSON.stringify(body ?? { success: false, error: { code: 100 } })) }
    }
    const snapshot = await createSynologyProvider(ctx(), { transport }).poll!() as SynologySnapshot
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.model).toBeNull()
    expect(snapshot.cpu).toBe(15)
  })

  it('says `forbidden` when the account lacks the privilege for the storage API', async () => {
    const provider = createSynologyProvider(ctx(), { transport: refusing(105) })
    expect(((await provider.poll!()) as SynologySnapshot).error).toBe('forbidden')
  })

  it('logs out when the last subscriber leaves, and when a poll fails', async () => {
    const ok = nas(OK)
    const provider = createSynologyProvider(ctx(), { transport: ok.transport })
    await provider.poll!()
    provider.stop!()
    await new Promise((r) => setImmediate(r))
    expect(ok.calls.some((u) => u.url.searchParams.get('method') === 'logout')).toBe(true)

    // A failure drops the client; without a logout the session lingers on the NAS until it
    // expires, once per failed poll.
    let broken = false
    const after = nas(OK)
    const flaky: SynologyTransport = async (req) => {
      if (broken && req.url.searchParams.get('api') === 'SYNO.Core.System.Utilization') {
        return { status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 100 } })) }
      }
      return after.transport(req)
    }
    const second = createSynologyProvider(ctx(), { transport: flaky })
    await second.poll!()
    broken = true
    await second.poll!()
    await new Promise((r) => setImmediate(r))
    expect(after.calls.filter((u) => u.url.searchParams.get('method') === 'logout').length).toBeGreaterThan(0)
  })
})

describe('the synology connection type', () => {
  const fields = { host: '192.0.2.10', account: 'fremkit', allowSelfSigned: 'true' }

  it('connects and says what it found', async () => {
    const { transport } = nas(OK)
    const result = await synologyType.test(fields, { password: 'pw' }, { transport })
    expect(result.ok).toBe(true)
    // The sentence is the repository's own, in whichever language the process runs in; what is
    // asserted here is that it counted what it found.
    if (result.ok) expect(result.detail).toMatch(/1 volume\(s\), 2 dis[kq]/)
  })

  it('logs out afterwards, so pressing Test does not pile up sessions on the NAS', async () => {
    const { transport, calls } = nas(OK)
    await synologyType.test(fields, { password: 'pw' }, { transport })
    expect(calls.some((u) => u.url.searchParams.get('method') === 'logout')).toBe(true)
  })

  it('never spends the one-time code, because it has nowhere to put the token', async () => {
    // A Test that enrolled would consume the six digits and leave the provider to retry them:
    // DSM refuses, and the connection is `unauthorized` for ever.
    const { transport, form, of } = nas(OK)
    await synologyType.test(fields, { password: 'pw', otp: '123456', deviceId: 'dev-1' }, { transport })
    const login = form(of('login')!)
    expect(login.get('otp_code')).toBeNull()
    expect(login.get('enable_device_token')).toBeNull()
    expect(login.get('device_id')).toBeNull()
  })

  it('calls a code request a success: the password was accepted to get that far', async () => {
    const needsOtp: SynologyTransport = async () =>
      ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 403 } })) })
    const result = await synologyType.test(fields, { password: 'pw' }, { transport: needsOtp })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toMatch(/double authentification|two-factor/)
  })

  /**
   * One row per `SYNO.API.Auth` refusal code.
   *
   * The sentences are the repository's own and the process's locale decides which language they
   * come out in, so what is asserted is the thing the user can act on: the word that tells the
   * four refusals apart. Sending somebody to retype a password DSM never objected to is the
   * failure this table exists to prevent.
   */
  const REFUSALS: [number, RegExp][] = [
    [400, /refus|password/i],
    [401, /désactivé|disabled/i],
    [402, /application DSM|DSM application/i],
    [404, /code de vérification|verification code/i],
    [407, /bloqué|blocked/i],
    [408, /expiré|expired/i],
    [409, /expiré|expired/i],
    [410, /expiré|expired/i],
  ]

  it.each(REFUSALS)('says which login refusal DSM gave: %i', async (code, expected) => {
    const result = await synologyType.test(fields, { password: 'pw' }, { transport: refusingLogin(code) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(expected)
  })

  it('takes DSM 406 for what it is: the password was accepted, the code is required', async () => {
    const result = await synologyType.test(fields, { password: 'pw' }, { transport: refusingLogin(406) })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toMatch(/double authentification|two-factor/)
  })

  it('does not pretend to explain a code that is not a login refusal', async () => {
    // 405 is in neither list, so it is not an `auth` error at all: it falls through to `answer`,
    // and "this is not a DSM" is the honest thing to say about a number this file has never seen.
    const result = await synologyType.test(fields, { password: 'pw' }, { transport: refusingLogin(405) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/pas un DSM|not a DSM/)
  })

  it('answers something for a code with no message, which is what the null case is for', () => {
    // Unreachable through `test()` — every `auth` code is in the table by construction — but
    // `SynologyError.code` is typed nullable, so the function has to be total.
    expect(loginRefusal(null)).toBe('synology.unauthorized')
    expect(loginRefusal(999)).toBe('synology.unauthorized')
  })

  it('says so when the account lacks a privilege, rather than blaming the password', async () => {
    const result = await synologyType.test(fields, { password: 'pw' }, { transport: refusing(105) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/permission/)
  })

  it('refuses an address it cannot dial, and a missing account', async () => {
    const { transport } = nas(OK)
    expect(await synologyType.test({ ...fields, host: 'not a host' }, { password: 'pw' }, { transport }))
      .toMatchObject({ ok: false })
    expect(await synologyType.test({ ...fields, account: ' ' }, { password: 'pw' }, { transport }))
      .toMatchObject({ ok: false })
  })

  it('never quotes the address or the exception in its error', async () => {
    const { transport } = nas(OK, { fail: true })
    const result = await synologyType.test(fields, { password: 'pw' }, { transport })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toMatch(/192\.0\.2\.10|ECONNREFUSED|5001/)
    }
  })

  it('never lets a secret reach an error, a detail, the snapshot or a URL', async () => {
    const { transport, calls } = nas(OK)
    const result = await synologyType.test(fields, { password: 'hunter2', otp: '123456' }, { transport })
    const said = JSON.stringify(result)
    expect(said).not.toContain('hunter2')
    expect(said).not.toContain('123456')
    expect(calls[0].url.protocol).toBe('https:')
    // And not in the URL either: that is the NAS's access log, and any proxy in front of it.
    for (const call of calls) expect(call.url.toString()).not.toContain('hunter2')
  })

  it('declares the fields the admin needs, and keeps the written-back token a secret', () => {
    const keys = synologyType.fields.map((f) => f.key)
    expect(keys).toEqual(['host', 'account', 'password', 'otp', 'deviceId', 'allowSelfSigned'])
    for (const key of ['password', 'otp', 'deviceId']) {
      expect(synologyType.fields.find((f) => f.key === key)?.secret, key).toBe(true)
    }
    expect(synologyType.fields.find((f) => f.key === 'allowSelfSigned')?.options).toEqual(['false', 'true'])
    expect(synologyType.secretBindings).toEqual(['host'])
  })
})

describe('SynologyError', () => {
  it('carries the code without putting it in front of the user', () => {
    const err = new SynologyError(119, 'session')
    expect(err.code).toBe(119)
    expect(err.message).toBe('synology session 119')
  })
})

describe('upTimeSeconds', () => {
  it('reads the number of seconds some DSM versions send', () => {
    expect(upTimeSeconds(864000)).toBe(864000)
    expect(upTimeSeconds('864000')).toBe(864000)
  })
  it('reads the text other versions send', () => {
    expect(upTimeSeconds('12 days 3:14:15')).toBe(12 * 86400 + 3 * 3600 + 14 * 60 + 15)
    expect(upTimeSeconds('1 day 0:00:30')).toBe(86430)
    expect(upTimeSeconds('3:14:15')).toBe(3 * 3600 + 14 * 60 + 15)
  })
  it('answers null rather than a confident zero', () => {
    for (const raw of [undefined, null, '', 'up a while', {}, -5, 0]) {
      expect(upTimeSeconds(raw), String(raw)).toBeNull()
    }
  })
})

describe('readCapped', () => {
  /** A body that arrives in pieces, as a response does. */
  async function* stream(...chunks: string[]): AsyncGenerator<Buffer> {
    for (const chunk of chunks) yield Buffer.from(chunk)
  }

  it('reads a body that fits', async () => {
    expect((await readCapped(stream('{"su', 'ccess":true}'), 100)).toString()).toBe('{"success":true}')
  })

  it('throws past the ceiling rather than returning short', async () => {
    // Returning a truncated body would hand half a JSON document to the parser; returning
    // nothing and waiting for an `error` event would hang the poll, and the provider registry
    // awaits it with no timeout.
    await expect(readCapped(stream('a'.repeat(10), 'b'.repeat(10)), 15)).rejects.toThrow(/too large/)
  })

  it('stops reading as soon as the ceiling is passed', async () => {
    let produced = 0
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) { produced++; yield Buffer.alloc(1024) }
    }
    await expect(readCapped(endless(), 4096)).rejects.toThrow(/too large/)
    expect(produced).toBeLessThan(10)
  })

  it('is what the real transport is bounded by', () => {
    expect(typeof httpsTransport).toBe('function')
    expect(MAX_ANSWER_BYTES).toBe(2 * 1024 * 1024)
  })
})
