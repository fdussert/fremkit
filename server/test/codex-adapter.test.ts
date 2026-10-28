import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { CodexReadClient, methodsFromSchema, safeChildEnv, createStdioTransport, discoverMethods, resolveCodexBinary, createLocalCodexClient } from '../src/codex/adapter.js'
import type { ReadTransport } from '../src/codex/adapter.js'
const methods = ['initialize', 'account/read', 'account/rateLimits/read', 'account/usage/read', 'thread/list']
class Wire implements ReadTransport {
  messages: Record<string, unknown>[] = []
  line: (line: string) => void = () => {}
  ended: () => void = () => {}
  closed = false
  respond = true
  write(line: string) {
    const m = JSON.parse(line); this.messages.push(m)
    if (this.respond && m.id !== undefined) queueMicrotask(() => this.line(JSON.stringify({ id: m.id, result: {} })))
  }
  onLine(fn: (line: string) => void) { this.line = fn }
  onClose(fn: () => void) { this.ended = fn }
  close() { this.closed = true; this.ended() }
}
function client(wire = new Wire(), supported = methods) {
  return { wire, api: new CodexReadClient({ methods: new Set(supported), connect: async () => wire, timeoutMs: 30 }) }
}
describe('Codex read transport', () => {
  it('extracts only schema method enums', () => {
    expect([...methodsFromSchema({ oneOf: [{ properties: { method: { enum: ['account/read'] } } }, { properties: { method: { enum: ['turn/start'] } } }] })]).toEqual(['account/read', 'turn/start'])
    expect([...methodsFromSchema({ properties: { method: { enum: [123] } } })]).toEqual([])
  })
  it('handshakes once and only sends constrained reads', async () => {
    const { api, wire } = client()
    await api.request('account/read', { refreshToken: false }); await api.request('account/usage/read', {})
    expect(wire.messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/usage/read'])
    expect(wire.messages[0]).toMatchObject({ params: { capabilities: { experimentalApi: true, explicitGatewayOauth: true, requestAttestation: false } } })
    api.close()
  })
  it('rejects writes and unsafe parameters before connecting', async () => {
    const { api, wire } = client()
    for (const [method, params] of [['turn/start', {}], ['thread/resume', {}], ['account/rateLimitResetCredit/consume', {}], ['account/read', { refreshToken: true }], ['account/rateLimits/read', { supportsLunaReserve: true }], ['thread/list', { sourceKinds: [], useStateDbOnly: false }]] as const) {
      await expect(api.request(method, params)).rejects.toMatchObject({ reason: 'refused' })
    }
    expect(wire.messages).toEqual([])
  })
  it('reports methods missing in installed schema before connecting', async () => {
    const { api, wire } = client(new Wire(), ['initialize'])
    await expect(api.request('account/usage/read', {})).rejects.toMatchObject({ reason: 'unsupported' }); expect(wire.messages).toEqual([])
  })
  it('marks runtime missing methods unsupported and sanitizes auth errors', async () => {
    const wire = new Wire(); const { api } = client(wire)
    await api.request('account/read', { refreshToken: false })
    wire.write = line => { const m = JSON.parse(line); wire.messages.push(m); queueMicrotask(() => wire.line(JSON.stringify({ id: m.id, error: { code: m.method === 'account/usage/read' ? -32601 : 401, message: 'sensitive response' } }))) }
    await expect(api.request('account/usage/read', {})).rejects.toMatchObject({ reason: 'unsupported' })
    await expect(api.request('account/read', { refreshToken: false })).rejects.toThrow('unauthorized')
    expect(api.supports('account/usage/read')).toBe(false); api.close()
  })
  it('rejects pending reads on disconnect and reconnects with a new handshake', async () => {
    const wire = new Wire(); const { api } = client(wire)
    await api.request('account/read', { refreshToken: false }); wire.respond = false
    const pending = api.request('account/usage/read', {}); await Promise.resolve(); wire.ended()
    await expect(pending).rejects.toMatchObject({ reason: 'offline' })
    wire.respond = true; await expect(api.request('account/usage/read', {})).resolves.toEqual({})
    expect(wire.messages.filter(m => m.method === 'initialize')).toHaveLength(2); api.close()
  })
  it('times out initialization and closes its owned transport', async () => {
    const wire = new Wire(); wire.respond = false; const { api } = client(wire)
    await expect(api.request('account/read', { refreshToken: false })).rejects.toMatchObject({ reason: 'offline' }); expect(wire.closed).toBe(true)
  })
  it('refuses unsolicited auth and approval requests', async () => {
    const { api, wire } = client(); await api.request('account/read', { refreshToken: false })
    wire.line(JSON.stringify({ id: 'server-id', method: 'account/chatgptAuthTokens/refresh', params: {} }))
    expect(wire.messages.at(-1)).toMatchObject({ id: 'server-id', error: { code: -32601 } }); api.close()
  })
  it('allowlists environment without passing credentials or loader injection', () => {
    expect(safeChildEnv({ PATH: '/usr/bin', HOME: '/home/example', CODEX_HOME: '/home/example/.codex', TMPDIR: '/tmp', OPENAI_API_KEY: 'placeholder', CLOUD_ACCESS_KEY: 'placeholder', TOKEN: 'placeholder', NODE_OPTIONS: '--require unsafe', DYLD_INSERT_LIBRARIES: 'unsafe' })).toEqual({ PATH: '/usr/bin', HOME: '/home/example', CODEX_HOME: '/home/example/.codex', TMPDIR: '/tmp' })
  })
  it('spawns a separate child with hooks off and closes only its process', () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
    const spawn = vi.fn(() => child)
    const transport = createStdioTransport({ binary: 'codex', spawn: spawn as never, env: { PATH: '/usr/bin', OPENAI_API_KEY: 'placeholder' } })
    expect(spawn).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://', '-c', 'features.hooks=false', '-c', 'features.codex_hooks=false', '-c', 'analytics.enabled=false'], expect.objectContaining({ shell: false, env: { PATH: '/usr/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }))
    const lines: string[] = []; transport.onLine(line => lines.push(line)); child.stdout.write('{"id":1'); child.stdout.write('}\n'); expect(lines).toEqual(['{"id":1}'])
    transport.close(); expect(child.kill).toHaveBeenCalledWith('SIGTERM'); child.emit('close'); transport.close(); expect(child.kill).toHaveBeenCalledTimes(1)
  })
  it('discovers capabilities using disposable output and filtered environment', async () => {
    let directory = ''; const { writeFile, access } = await import('node:fs/promises'); const { join } = await import('node:path')
    const run = vi.fn(async (_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      directory = args[args.indexOf('--out') + 1]; expect(options.env).toEqual({ PATH: '/usr/bin' })
      await writeFile(join(directory, 'ClientRequest.json'), JSON.stringify({ oneOf: [{ properties: { method: { enum: ['initialize', 'account/read'] } } }] }))
    })
    expect([...await discoverMethods({ run, env: { PATH: '/usr/bin', OPENAI_API_KEY: 'placeholder' } })]).toEqual(['initialize', 'account/read'])
    expect(run.mock.calls[0][1]).toContain('--experimental'); await expect(access(directory)).rejects.toThrow()
  })
  it('refuses inherited object names instead of executing an unallowlisted method', async () => {
    const { api } = client()
    await expect(api.request('toString', {})).rejects.toMatchObject({ reason: 'refused' })
  })
  it('rejects a malformed protocol frame and closes the pending transport', async () => {
    const { api, wire } = client(); await api.request('account/read', { refreshToken: false }); wire.respond = false
    const pending = api.request('account/usage/read', {}); await Promise.resolve(); wire.line('not json')
    await expect(pending).rejects.toMatchObject({ reason: 'offline' }); expect(wire.closed).toBe(true)
  })
  it('terminates the owned child after an input stream error', () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
    const transport = createStdioTransport({ spawn: (() => child) as never })
    transport.onClose(() => transport.close()); child.stdin.emit('error', Error('pipe failure'))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); child.emit('close')
  })
  it('sends the validated parameter copies despite caller mutation during initialization', async () => {
    const wire = new Wire(); wire.respond = false
    const { api } = client(wire)
    const account = { refreshToken: false }
    const history = { sourceKinds: ['appServer'], useStateDbOnly: true, limit: 50, sortKey: 'updated_at', archived: false }
    const accountRead = api.request('account/read', account)
    const historyRead = api.request('thread/list', history)
    await Promise.resolve()
    expect(wire.messages.map(m => m.method)).toEqual(['initialize'])
    account.refreshToken = true
    history.sourceKinds.push('cli'); history.useStateDbOnly = false
    wire.respond = true
    wire.line(JSON.stringify({ id: wire.messages[0].id, result: {} }))
    await Promise.all([accountRead, historyRead])
    expect(wire.messages.find(m => m.method === 'account/read')?.params).toEqual({ refreshToken: false })
    expect(wire.messages.find(m => m.method === 'thread/list')?.params).toEqual({ sourceKinds: ['appServer'], useStateDbOnly: true, limit: 50, sortKey: 'updated_at', archived: false })
    api.close()
  })
  describe('resolveCodexBinary', () => {
    const env = { APPDATA: 'C:\\Users\\Example\\AppData\\Roaming', CODEX_HOME: 'D:\\codex-data' }
    const vendor = (triple: string) => `C:\\Users\\Example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\${triple}\\codex\\codex.exe`
    it('names the vendored native binary on Windows for each architecture', () => {
      expect(resolveCodexBinary(env, 'win32', p => p === vendor('x86_64-pc-windows-msvc'), 'x64')).toBe(vendor('x86_64-pc-windows-msvc'))
      expect(resolveCodexBinary(env, 'win32', p => p === vendor('aarch64-pc-windows-msvc'), 'arm64')).toBe(vendor('aarch64-pc-windows-msvc'))
    })
    it('returns null when only the codex.cmd shim exists, or nothing', () => {
      const shim = 'C:\\Users\\Example\\AppData\\Roaming\\npm\\codex.cmd'
      expect(resolveCodexBinary(env, 'win32', p => p === shim, 'x64')).toBeNull()
      expect(resolveCodexBinary(env, 'win32', () => false, 'x64')).toBeNull()
    })
    it('refuses a missing or relative APPDATA and an unknown architecture', () => {
      expect(resolveCodexBinary({}, 'win32', () => true, 'x64')).toBeNull()
      expect(resolveCodexBinary({ APPDATA: 'relative' }, 'win32', () => true, 'x64')).toBeNull()
      expect(resolveCodexBinary(env, 'win32', () => true, 'ia32')).toBeNull()
    })
    it('keeps the PATH lookup on macOS, whatever CODEX_HOME says', () => {
      expect(resolveCodexBinary({ CODEX_HOME: '/elsewhere' }, 'darwin', () => false)).toBe('codex')
    })
  })
  it('passes the Windows profile folders to the child only on Windows', () => {
    const env = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example', APPDATA: 'C:\\Users\\Example\\AppData\\Roaming', OPENAI_API_KEY: 'placeholder' }
    expect(safeChildEnv(env, 'win32')).toEqual({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example', APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' })
    expect(safeChildEnv(env, 'darwin')).toEqual({ PATH: 'C:\\Windows' })
  })
  it('reads Windows variables case-insensitively from an injected environment', () => {
    const env = { path: 'C:\\Windows', userprofile: 'C:\\Users\\Example', appdata: 'C:\\Users\\Example\\AppData\\Roaming' }
    expect(safeChildEnv(env, 'win32')).toEqual({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example', APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' })
    expect(safeChildEnv(env, 'darwin')).toEqual({})
    const exe = 'C:\\Users\\Example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'
    expect(resolveCodexBinary(env, 'win32', () => true, 'x64')).toBe(exe)
  })
  it('reports a Codex CLI that is not installed as unconfigured, on Windows and on the Mac', async () => {
    await expect(createLocalCodexClient({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' } })).rejects.toMatchObject({ reason: 'unconfigured' })
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    const run = async () => { throw missing }
    await expect(discoverMethods({ run })).rejects.toMatchObject({ reason: 'unconfigured' })
    await expect(discoverMethods({ run: async () => { throw new Error('exit 1') } })).rejects.toMatchObject({ reason: 'unsupported' })
  })
  it.each(['C:\\x\\codex.cmd', 'C:\\x\\CODEX.BAT', 'C:\\x\\codex.Ps1'])('refuses a script wrapper as the configured binary (%s)', async binary => {
    await expect(createLocalCodexClient({ binary, platform: 'win32' })).rejects.toMatchObject({ reason: 'unsupported' })
  })
})
