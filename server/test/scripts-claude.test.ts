import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    expect(typeof body.client.pid).toBe('number')
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
