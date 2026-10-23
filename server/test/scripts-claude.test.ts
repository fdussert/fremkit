import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// @ts-expect-error plain JavaScript beside the shell scripts, no declaration file
import { clientFrom } from '../../scripts/claude-hook.mjs'
// @ts-expect-error plain JavaScript beside the shell scripts, no declaration file
import { isLoopbackUrl } from '../../scripts/lib/access.mjs'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts')
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-statusline-input.json'), 'utf8')

interface Seen { method?: string; headers: Record<string, string | string[] | undefined>; body: string }

function run(script: string, input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scripts, script)], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(input)
  })
}

describe('the Node Claude Code scripts', () => {
  let dir = ''
  let server: Server | undefined
  const seen: Seen[] = []
  afterEach(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
    seen.length = 0
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
  })

  async function stub(token?: string) {
    dir = mkdtempSync(join(tmpdir(), 'fk-claude-'))
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { seen.push({ method: req.method, headers: req.headers, body }); res.writeHead(204).end() })
    })
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    if (token) writeFileSync(join(dir, `access-${port}.token`), `${token}\n`)
    return { FREMKIT_HOOK_URL: `http://127.0.0.1:${port}/api/hooks/claude`, FREMKIT_SUPPORT_DIR: dir }
  }

  it('hook: posts the merged body with the header, exits 0, and sends no env secret', async () => {
    const env = await stub('tok-123')
    const r = await run('claude-hook.mjs', '{"hook_event_name":"Stop","session_id":"s1"}', {
      ...env, TERM_PROGRAM: 'WindowsTerminal', WSL_DISTRO_NAME: 'Ubuntu-24.04',
      ORCA_PANE_KEY: 'p:q', ORCA_AGENT_HOOK_TOKEN: 'must-not-travel', ORCA_AGENT_HOOK_ENDPOINT: 'nor-this',
    })
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].headers.authorization).toBe('Bearer tok-123')
    expect(seen[0].headers['content-type']).toBe('application/json')
    const body = JSON.parse(seen[0].body)
    expect(body).toMatchObject({ hook_event_name: 'Stop', session_id: 's1' })
    expect(body.client).toMatchObject({ program: 'WindowsTerminal', wslDistro: 'Ubuntu-24.04', orca: { pane: 'p:q' } })
    expect(typeof body.client.pid).toBe(process.platform === 'win32' ? 'undefined' : 'number')
    expect(seen[0].body).not.toContain('must-not-travel')
    expect(seen[0].body).not.toContain('nor-this')
    expect(seen[0].body).not.toContain('tok-123')
  })

  it('hook: no token file means no header, and still exit 0', async () => {
    const env = await stub()
    const r = await run('claude-hook.mjs', '{"hook_event_name":"Stop"}', env)
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('hook: leaves out a malformed distro name, forwards a non-object untouched, ignores empty input', async () => {
    const env = await stub()
    await run('claude-hook.mjs', '{"a":1}', { ...env, WSL_DISTRO_NAME: 'bad name', TERM_PROGRAM: 'x' })
    await run('claude-hook.mjs', '[1,2]', { ...env, TERM_PROGRAM: 'x' })
    await run('claude-hook.mjs', '   ', env)
    expect(seen).toHaveLength(2)
    expect(JSON.parse(seen[0].body).client.wslDistro).toBeUndefined()
    expect(seen[1].body).toBe('[1,2]')
  })

  it('hook: leaves the pid out on Windows and keeps it elsewhere', () => {
    expect(clientFrom({ TERM_PROGRAM: 'x' }, 4321, 'win32').pid).toBeUndefined()
    expect(clientFrom({ TERM_PROGRAM: 'x' }, 4321, 'darwin').pid).toBe(4321)
    expect(clientFrom({ TERM_PROGRAM: 'x' }, 4321, 'linux').pid).toBe(4321)
  })

  it('sends the secret to loopback hosts only', () => {
    for (const url of ['http://127.0.0.1:4242/x', 'http://localhost:4242/x', 'http://[::1]:4242/x']) expect(isLoopbackUrl(url)).toBe(true)
    for (const url of ['http://192.0.2.1:4242/x', 'http://example.com/x', 'http://127.0.0.1.example.com/x', 'nonsense', '']) expect(isLoopbackUrl(url)).toBe(false)
  })

  async function redirecting(token: string) {
    const env = await stub(token)
    const hits: string[] = []
    const elsewhere = createServer((req, res) => { hits.push(String(req.headers.authorization)); res.writeHead(204).end() })
    await new Promise<void>((ok) => elsewhere.listen(0, '127.0.0.1', ok))
    const target = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/landed`
    server!.removeAllListeners('request')
    server!.on('request', (req, res) => { seen.push({ method: req.method, headers: req.headers, body: '' }); req.resume(); res.writeHead(307, { location: target }).end() })
    return { env, hits, close: () => new Promise<void>((done) => elsewhere.close(() => done())) }
  }

  it('hook: never follows a redirect with the secret', async () => {
    const r = await redirecting('tok-r')
    expect((await run('claude-hook.mjs', '{"a":1}', r.env)).code).toBe(0)
    await r.close()
    expect(seen).toHaveLength(1)
    expect(r.hits).toEqual([])
  })

  it('status line: never follows a redirect with the secret', async () => {
    const r = await redirecting('tok-r')
    expect((await run('claude-statusline.mjs', fixture, r.env)).code).toBe(0)
    await r.close()
    expect(seen).toHaveLength(1)
    expect(r.hits).toEqual([])
  })

  async function hanging() {
    dir = mkdtempSync(join(tmpdir(), 'fk-claude-'))
    const sockets = new Set<import('node:net').Socket>()
    server = createServer(() => { /* never answers */ })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    server.on('close', () => { for (const s of sockets) s.destroy() })
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    return { FREMKIT_HOOK_URL: `http://127.0.0.1:${port}/api/hooks/claude`, FREMKIT_SUPPORT_DIR: dir, destroy: () => { for (const s of sockets) s.destroy() } }
  }

  it('hook: a server that never answers holds it for about a second at most', async () => {
    const { destroy, ...env } = await hanging()
    const started = Date.now()
    const r = await run('claude-hook.mjs', '{"a":1}', env)
    destroy()
    expect(r.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('status line: a server that never answers does not hold the line up', async () => {
    const { destroy, ...env } = await hanging()
    const started = Date.now()
    const r = await run('claude-statusline.mjs', fixture, env)
    destroy()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Opus 5')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('hook: exits 0 when nothing listens', async () => {
    const r = await run('claude-hook.mjs', '{"a":1}', { FREMKIT_HOOK_URL: 'http://127.0.0.1:1/api/hooks/claude', TERM_PROGRAM: 'x' })
    expect(r.code).toBe(0)
  })

  it('status line: prints the line and forwards the tagged payload with the header', async () => {
    const env = await stub('tok-9')
    const r = await run('claude-statusline.mjs', fixture, { ...env, GIT_CEILING_DIRECTORIES: '/' })
    expect(r.code).toBe(0)
    expect(r.stdout.endsWith('\n')).toBe(true)
    expect(r.stdout).toContain('Opus 5 · server')
    expect(r.stdout).toContain('ctx 17% · $1.25 · 5h 5% · 7d 42%')
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.authorization).toBe('Bearer tok-9')
    expect(JSON.parse(seen[0].body)).toMatchObject({ session_id: 's1', hook_event_name: 'StatusLine', fremkit_branch: expect.any(String) })
  })

  it('status line: bad input gives an empty line and exit 0', async () => {
    const r = await run('claude-statusline.mjs', 'not json', { FREMKIT_HOOK_URL: 'http://127.0.0.1:1/x' })
    expect(r).toEqual({ code: 0, stdout: '\n' })
  })

  // The bash script is the reference: same input, same bytes. Needs bash and jq, so not on Windows.
  const reference = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0
  const inputs: Record<string, string> = {
    full: fixture,
    'no model, no limits': '{"cwd":"/a/b/proj"}',
    'model id only, zero cost': '{"model":{"id":"m-1"},"cost":{"total_cost_usd":0},"workspace":{"current_dir":"/x/"}}',
    'nulls': '{"model":null,"context_window":{"used_percentage":null},"rate_limits":{"five_hour":null},"cwd":null}',
    'rounding': '{"cwd":"/p","cost":{"total_cost_usd":0.005},"context_window":{"used_percentage":99.99}}',
    'model as a string': '{"model":"opus","cwd":"/p"}',
  }
  for (const [name, input] of Object.entries(inputs)) {
    it.skipIf(!reference)(`status line: the same line as claude-statusline.sh (${name})`, async () => {
      const env = { FREMKIT_HOOK_URL: 'http://127.0.0.1:1/x', GIT_CEILING_DIRECTORIES: '/' }
      // cwd values above do not exist, so git finds no branch in either script.
      const bash = spawnSync('bash', [join(scripts, 'claude-statusline.sh')], { input, env: { ...env, PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
      const node = await run('claude-statusline.mjs', input, env)
      expect(node.stdout).toBe(bash.stdout)
    })
  }
})
