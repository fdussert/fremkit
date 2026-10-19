import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { ConnectionType } from '../src/connections/types.js'
import { LineRing, LogTail, helperLogPath, readFileTail } from '../src/diagnostics/log-tail.js'
import { buildDiagnostics, compactLog, formatLogLine, renderReport, type DiagnosticsDeps } from '../src/diagnostics/report.js'
import { errorCode } from '../src/providers/registry.js'
import { CONFIG_VERSION, type Config } from '../src/config/schema.js'

const SECRET = 'pat-0123-example-secret'
const ACCESS = 'access-secret-for-the-test-0123456789'

const fakeType: ConnectionType = {
  id: 'fake',
  name: 'Fake',
  description: 'Fake',
  icon: 'layout-grid',
  fields: [
    { key: 'url', label: 'URL', required: true },
    { key: 'pat', label: 'PAT', secret: true, required: true },
  ],
  test: async () => ({ ok: true, detail: 'ok' }),
  createProvider: (ctx) => ({ channel: ctx.channel, intervalMs: 60_000, poll: async () => ({ error: 'unauthorized' }) }),
}

const system = {
  node: 'v22.0.0',
  macos: '15.0',
  darwin: '24.0.0',
  arch: 'arm64',
  home: '/Users/example',
  username: 'example',
  machineNames: ['Example-Mac'],
  install: 'checkout' as const,
  dev: false,
}

function config(): Config {
  return {
    version: CONFIG_VERSION,
    theme: 'fremkit',
    locale: 'en',
    connections: [{ id: 'my-nas', type: 'fake', name: 'Basement NAS', fields: { url: 'https://nas.example.com:5001' } }],
    secrets: { backend: 'file' },
    privacy: {} as Config['privacy'],
    labs: { devices: false, companion: false },
    marketplace: {} as Config['marketplace'],
    widgets: {
      a: { widgetId: 'clock', showTitle: true, settings: { secretNote: 'do-not-show' } },
      b: { widgetId: 'clock', showTitle: true, settings: {} },
      c: { widgetId: 'gone', showTitle: true, settings: {} },
    },
    screens: [
      { id: 'edge', name: 'Edge', kind: 'edge', display: {} as never, nav: [], pages: [{ id: 'p1', name: 'Home', items: [] }, { id: 'p2', name: 'Work', items: [] }] },
      { id: 'dev1', name: 'Example iPad', kind: 'device', display: {} as never, nav: [], pages: [{ id: 'p3', name: 'Home', items: [] }] },
    ],
  }
}

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    config,
    widget: (id) => (id === 'clock' ? { version: '1.2.0', source: 'builtin' } : undefined),
    connectionKind: () => 'coded',
    channelFor: (c) => `${c.type}:${c.id}`,
    secretsFor: async () => ({ pat: SECRET }),
    channels: () => [
      { channel: 'fake:my-nas', watched: true, lastError: 'unauthorized' },
      { channel: 'system', watched: true, lastError: null },
      { channel: 'dock', watched: false },
    ],
    devices: () => [{ name: 'Example iPad' }],
    remoteAccess: () => true,
    accessToken: ACCESS,
    log: async () => ({
      kind: 'memory',
      lines: [
        `{"level":50,"hostname":"Example-Mac","msg":"poll failed for https://nas.example.com:5001 with ${SECRET}"}`,
        `{"level":30,"msg":"read /Users/example/Library/x from 192.0.2.7 as someone@example.com, auth ${ACCESS}"}`,
      ],
    }),
    system,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

describe('buildDiagnostics', () => {
  it('reports the setup without a name, a host, a setting or a secret', async () => {
    const text = await buildDiagnostics(deps())
    expect(text).toContain('Fremkit: ')
    expect(text).toContain('(checkout)')
    expect(text).toContain('macOS: 15.0 (Darwin 24.0.0), arm64')
    expect(text).toContain(`Config schema: v${CONFIG_VERSION}`)
    expect(text).toContain('Screens: 2 (edge 1, device 1)')
    expect(text).toContain('Pages: 3')
    expect(text).toContain('Widget instances: 3')
    expect(text).toContain('Paired devices: 1 (remote access on)')
    expect(text).toContain('| clock | 1.2.0 | built-in | 2 |')
    expect(text).toContain('| gone | – | missing | 1 |')
    expect(text).toContain('| fake | coded | error: unauthorized |')
    // A connection's channel carries its id: shown as type and rank.
    expect(text).toContain('| fake #1 | yes | error: unauthorized |')
    expect(text).not.toContain('| dock |')
    expect(text).toContain('1 other channels idle, never polled.')
    expect(text).toContain('| system | yes | ok |')
    for (const leak of [SECRET, ACCESS, 'Basement NAS', 'my-nas', 'nas.example.com', 'Example iPad', 'Example-Mac',
      '/Users/example', '192.0.2.7', 'someone@example.com', 'do-not-show', 'secretNote']) {
      expect(text, leak).not.toContain(leak)
    }
    expect(text).toContain('read ~/Library/x')
  })

  it('says when there is no log', async () => {
    const text = await buildDiagnostics(deps({ log: undefined }))
    expect(text).toContain('### Server log\n\nNot available.')
  })

  it('keeps a code fence in a log line from closing the block', () => {
    const text = renderReport({
      generatedAt: 'x', version: '0', install: 'app', dev: false, node: 'v', macos: null, darwin: 'd', arch: 'a',
      configVersion: 4, theme: 't', locale: 'en', secretsBackend: 'file', screens: { edge: 1, device: 0 },
      pages: 1, instances: 0, widgets: [], connections: [], providers: [], idleProviders: 0, devices: { paired: 0, remoteAccess: false },
      log: { kind: 'file', lines: ['before ``` after'] },
    })
    expect(text.match(/```/g)).toHaveLength(2)
    expect(text).toContain('server.log')
  })
})

describe('formatLogLine', () => {
  it('turns pino JSON into one readable line', () => {
    const req = '{"level":30,"time":0,"pid":1,"hostname":"h","reqId":"req-1","req":{"method":"GET","url":"/api/config"},"msg":"incoming request"}'
    expect(formatLogLine(req)).toBe('1970-01-01T00:00:00.000Z INFO req-1 incoming request GET /api/config')
    const res = '{"level":30,"time":0,"reqId":"req-1","res":{"statusCode":200},"responseTime":1.6,"msg":"request completed"}'
    expect(formatLogLine(res)).toBe('1970-01-01T00:00:00.000Z INFO req-1 request completed 200 2ms')
    const err = '{"level":50,"time":0,"err":{"type":"Error","message":"boom","stack":"Error: boom\\n    at a (x.ts:1)\\n    at b (y.ts:2)"},"channel":"system","msg":"failed"}'
    expect(formatLogLine(err)).toBe('1970-01-01T00:00:00.000Z ERROR failed Error: boom (at a (x.ts:1) / at b (y.ts:2)) {"channel":"system"}')
  })

  it('leaves anything else as it is', () => {
    expect(formatLogLine('fremkit: plain text')).toBe('fremkit: plain text')
    expect(formatLogLine('{not json')).toBe('{not json')
    expect(formatLogLine('{"a":1}')).toBe('{"a":1}')
  })
})

describe('compactLog', () => {
  const line = (o: object): string => JSON.stringify({ level: 30, time: 0, ...o })
  it('folds a request pair into one line and drops a quiet static fetch', () => {
    const { lines } = compactLog({ kind: 'file', lines: [
      line({ reqId: 'req-1', req: { method: 'GET', url: '/assets/app.js' }, msg: 'incoming request' }),
      line({ reqId: 'req-1', res: { statusCode: 200 }, responseTime: 1, msg: 'request completed' }),
      line({ reqId: 'req-2', req: { method: 'PUT', url: '/api/config' }, msg: 'incoming request' }),
      line({ reqId: 'req-2', res: { statusCode: 400 }, responseTime: 3, msg: 'request completed' }),
      line({ reqId: 'req-3', req: { method: 'GET', url: '/assets/missing.js' }, msg: 'incoming request' }),
      line({ reqId: 'req-3', res: { statusCode: 404 }, responseTime: 1, msg: 'request completed' }),
      'plain text',
    ] })
    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z INFO req-2 request completed PUT /api/config 400 3ms',
      '1970-01-01T00:00:00.000Z INFO req-3 request completed GET /assets/missing.js 404 1ms',
      'plain text',
    ])
  })

  it('keeps the last 200 lines', () => {
    const { lines } = compactLog({ kind: 'memory', lines: Array.from({ length: 300 }, (_, i) => `l${i}`) })
    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe('l100')
  })
})

describe('errorCode', () => {
  it('passes a code through and reduces anything else to a word', () => {
    expect(errorCode({ ok: 1 }, false)).toBeNull()
    expect(errorCode({ error: 'offline' }, false)).toBe('offline')
    expect(errorCode({ error: 'connect ECONNREFUSED 192.0.2.1:80' }, false)).toBe('error')
    expect(errorCode({ error: 'anything' }, true)).toBe('exception')
    expect(errorCode({ error: null }, false)).toBeNull()
  })
})

describe('log tail', () => {
  it('keeps whole lines, joins chunks, caps the count and the length', () => {
    const ring = new LineRing(3)
    ring.write('one\ntw')
    ring.write('o\nthree\n')
    ring.write('four\n')
    expect(ring.tail(10)).toEqual(['two', 'three', 'four'])
    ring.write(`${'x'.repeat(700)}\n`)
    expect(ring.tail(1)[0]).toHaveLength(601)
  })

  it('reads the end of a file and drops the cut first line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-diag-'))
    const file = join(dir, 'server.log')
    await writeFile(file, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n')
    expect(await readFileTail(file, 3)).toEqual(['line 47', 'line 48', 'line 49'])
    const cut = await readFileTail(file, 100, 20)
    expect(cut[0]).toMatch(/^line \d+$/)
    expect(cut.at(-1)).toBe('line 49')
  })

  it('falls back to its own lines when stdout is not the helper log', async () => {
    const tail = new LogTail('/nonexistent/server.log')
    tail.ring.write('hello\n')
    expect(await tail.recent(5)).toEqual({ kind: 'memory', lines: ['hello'] })
  })

  it('finds the log where the helper writes it', () => {
    expect(helperLogPath({}, '/Users/example')).toBe('/Users/example/Library/Logs/Fremkit/server.log')
    expect(helperLogPath({ FREMKIT_SUPPORT_DIR: '/tmp/bench' }, '/Users/example')).toBe('/tmp/bench/Logs/server.log')
  })
})

describe('GET /api/diagnostics', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fremkit-diag-app-'))
    await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify({
      version: CONFIG_VERSION,
      locale: 'en',
      connections: [{ id: 'nas', type: 'fake', name: 'Basement NAS', fields: { url: 'https://nas.example.com' } }],
      secrets: { backend: 'file' },
      widgets: { w1: { widgetId: 'clock', settings: {} } },
      screens: [{ id: 'edge', name: 'Edge', kind: 'edge', nav: [], pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'w1', x: 0, y: 0, w: 8, h: 4 }] }] }],
    }), 'utf8')
    await writeFile(join(dataDir, 'secrets.json'), JSON.stringify({ 'nas/pat': SECRET }), 'utf8')
    app = await buildApp({ accessToken: null, dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [fakeType] })
  })
  afterEach(async () => { await app.close() })

  it('answers Markdown, uncached, with the widgets in use', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('## Fremkit diagnostics')
    expect(res.body).toMatch(/\| clock \| \d+\.\d+\.\d+ \| built-in \| 1 \|/)
    expect(res.body).toContain('| fake | coded |')
    expect(res.body).not.toContain('Basement NAS')
    expect(res.body).not.toContain('nas.example.com')
  })

  it('refuses a request that is not from this Mac', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics', remoteAddress: '192.0.2.9' })
    expect(res.statusCode).toBe(404)
  })
})
