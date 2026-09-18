import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SNAPSHOT,
  SYNOLOGY_POLL_MS,
  SYNOLOGY_RETRY_MS,
  SynologyClient,
  SynologyError,
  createSynologyProvider,
  cpuPercent,
  parseHost,
  toSnapshot,
  type SynologySnapshot,
  StorageSchema,
  UtilizationSchema,
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
  time: { uptime: 864000 },
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
 * A NAS in a function. `answers` maps the `api` query parameter to what DSM sends back; every
 * request is recorded, so a test can assert what was asked and — more importantly — what was not
 * put in the URL.
 */
function nas(answers: Record<string, unknown>, opts: { fail?: boolean } = {}) {
  const urls: URL[] = []
  const transport: SynologyTransport = async (url) => {
    urls.push(url)
    if (opts.fail) throw new Error('ECONNREFUSED 192.0.2.10:5001')
    const api = url.searchParams.get('api') ?? ''
    const body = answers[api]
    if (body === undefined) return { status: 404, body: Buffer.from('') }
    return { status: 200, body: Buffer.from(JSON.stringify(body)) }
  }
  return { transport, urls }
}

const OK = {
  'SYNO.API.Auth': { success: true, data: { sid: 'session-xyz' } },
  'SYNO.Core.System.Utilization': { success: true, data: UTIL },
  'SYNO.Storage.CGI.Storage': { success: true, data: STORAGE },
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
  const snapshot = toSnapshot(UtilizationSchema.parse(UTIL), StorageSchema.parse(STORAGE), 1000)

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
    const { transport, urls } = nas(OK)
    const c = client(transport)
    await c.utilization()
    await c.storage()
    expect(urls.filter((u) => u.searchParams.get('method') === 'login')).toHaveLength(1)
    expect(urls[1].searchParams.get('_sid')).toBe('session-xyz')
  })

  it('logs in again when DSM says the session is gone, rather than reporting an error', async () => {
    let seen = 0
    const transport: SynologyTransport = async (url) => {
      const api = url.searchParams.get('api')
      if (api === 'SYNO.API.Auth') return { status: 200, body: Buffer.from(JSON.stringify(OK['SYNO.API.Auth'])) }
      seen++
      // 119: a session id DSM does not know.
      const body = seen === 1 ? { success: false, error: { code: 119 } } : { success: true, data: UTIL }
      return { status: 200, body: Buffer.from(JSON.stringify(body)) }
    }
    await expect(client(transport).utilization()).resolves.toBeTruthy()
    expect(seen).toBe(2)
  })

  it('gives up rather than looping when the second login does not help', async () => {
    const transport: SynologyTransport = async (url) => {
      const api = url.searchParams.get('api')
      const body = api === 'SYNO.API.Auth' ? OK['SYNO.API.Auth'] : { success: false, error: { code: 119 } }
      return { status: 200, body: Buffer.from(JSON.stringify(body)) }
    }
    await expect(client(transport).utilization()).rejects.toMatchObject({ kind: 'session' })
  })

  it('tells a refused account from an unreachable NAS', async () => {
    const refused: SynologyTransport = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ success: false, error: { code: 400 } })) })
    await expect(client(refused).utilization()).rejects.toMatchObject({ kind: 'auth' })
    const { transport } = nas(OK, { fail: true })
    await expect(client(transport).utilization()).rejects.toMatchObject({ kind: 'network' })
  })

  it('never puts the host in the error it throws', async () => {
    const { transport } = nas(OK, { fail: true })
    // The transport's own message carries the address; a LAN address is the user's own.
    await expect(client(transport).utilization()).rejects.toThrow(/^synology network$/)
  })

  it('asks for a device token with the one-time code, and uses it afterwards', async () => {
    const transport: SynologyTransport = async (url) => {
      const api = url.searchParams.get('api')
      if (api !== 'SYNO.API.Auth') return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: UTIL })) }
      return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: { sid: 's', device_id: 'dev-1' } })) }
    }
    const withOtp = client(transport, { otp: '123456' })
    await withOtp.utilization()
    expect(withOtp.deviceId).toBe('dev-1')

    const { transport: t2, urls } = nas(OK)
    await client(t2, { deviceId: 'dev-1' }).utilization()
    const login = urls.find((u) => u.searchParams.get('method') === 'login')!
    expect(login.searchParams.get('device_id')).toBe('dev-1')
    expect(login.searchParams.get('otp_code')).toBeNull()
  })

  it('refuses an answer that is not a DSM answer', async () => {
    const junk: SynologyTransport = async () => ({ status: 200, body: Buffer.from('<html>login page</html>') })
    await expect(client(junk).utilization()).rejects.toMatchObject({ kind: 'answer' })
  })

  it('logs out only when it has a session, and survives the NAS refusing', async () => {
    const { transport, urls } = nas(OK)
    const c = client(transport)
    await c.logout()
    expect(urls).toHaveLength(0)
    await c.utilization()
    await c.logout()
    expect(urls.some((u) => u.searchParams.get('method') === 'logout')).toBe(true)
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
    const transport: SynologyTransport = async (url) => {
      if (broken) throw new Error('ECONNREFUSED')
      return nas(OK).transport(url, { rejectUnauthorized: false, timeoutMs: 1 })
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

  it('stores the device token the NAS issues, under this connection\'s own key', async () => {
    const transport: SynologyTransport = async (url) => {
      const api = url.searchParams.get('api')
      if (api === 'SYNO.API.Auth') return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: { sid: 's', device_id: 'dev-9' } })) }
      if (api === 'SYNO.Storage.CGI.Storage') return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: STORAGE })) }
      return { status: 200, body: Buffer.from(JSON.stringify({ success: true, data: UTIL })) }
    }
    const saveSecret = vi.fn(async () => {})
    const provider = createSynologyProvider(ctx({ secrets: { password: 'pw', otp: '123456' }, saveSecret }), { transport })
    await provider.poll!()
    expect(saveSecret).toHaveBeenCalledWith('deviceId', 'dev-9')
    // Written once, not on every poll.
    await provider.poll!()
    expect(saveSecret).toHaveBeenCalledTimes(1)
  })

  it('does not resend a one-time code once a device token is stored', async () => {
    const { transport, urls } = nas(OK)
    const provider = createSynologyProvider(ctx({ secrets: { password: 'pw', otp: '123456', deviceId: 'dev-1' } }), { transport })
    await provider.poll!()
    const login = urls.find((u) => u.searchParams.get('method') === 'login')!
    expect(login.searchParams.get('otp_code')).toBeNull()
    expect(login.searchParams.get('device_id')).toBe('dev-1')
  })

  it('logs out when the last subscriber leaves', async () => {
    const { transport, urls } = nas(OK)
    const provider = createSynologyProvider(ctx(), { transport })
    await provider.poll!()
    provider.stop!()
    await new Promise((r) => setImmediate(r))
    expect(urls.some((u) => u.searchParams.get('method') === 'logout')).toBe(true)
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
    const { transport, urls } = nas(OK)
    await synologyType.test(fields, { password: 'pw' }, { transport })
    expect(urls.some((u) => u.searchParams.get('method') === 'logout')).toBe(true)
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

  it('never lets a secret reach an error, a detail or the snapshot', async () => {
    const { transport, urls } = nas(OK)
    const result = await synologyType.test(fields, { password: 'hunter2', otp: '123456' }, { transport })
    const said = JSON.stringify(result)
    expect(said).not.toContain('hunter2')
    expect(said).not.toContain('123456')
    // They do travel in the query, which is what DSM's API takes — over HTTPS, to the NAS only.
    expect(urls[0].protocol).toBe('https:')
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
