import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessTokenPath } from '../src/http/access-file.js'
// @ts-expect-error plain JavaScript beside the shell scripts, no declaration file
import { authHeader, authUrl, portOf, tokenFile } from '../../scripts/lib/access.mjs'

describe('scripts/lib/access.mjs token file', () => {
  const cases: { name: string; env: NodeJS.ProcessEnv; home: string; platform: NodeJS.Platform }[] = [
    { name: 'darwin default', env: {}, home: '/Users/sam', platform: 'darwin' },
    { name: 'darwin override', env: { FREMKIT_SUPPORT_DIR: '/tmp/support' }, home: '/Users/sam', platform: 'darwin' },
    { name: 'darwin relative override ignored', env: { FREMKIT_SUPPORT_DIR: 'support' }, home: '/Users/sam', platform: 'darwin' },
    { name: 'linux is treated as darwin', env: {}, home: '/home/sam', platform: 'linux' },
    { name: 'win32 LOCALAPPDATA', env: { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }, home: 'C:\\Users\\Sam', platform: 'win32' },
    { name: 'win32 no LOCALAPPDATA', env: {}, home: 'C:\\Users\\Sam', platform: 'win32' },
    { name: 'win32 relative LOCALAPPDATA ignored', env: { LOCALAPPDATA: '..\\x' }, home: 'C:\\Users\\Sam', platform: 'win32' },
    { name: 'win32 override', env: { FREMKIT_SUPPORT_DIR: 'D:\\fk', LOCALAPPDATA: 'C:\\L' }, home: 'C:\\Users\\Sam', platform: 'win32' },
    { name: 'win32 relative override ignored', env: { FREMKIT_SUPPORT_DIR: 'fk', LOCALAPPDATA: 'C:\\L' }, home: 'C:\\Users\\Sam', platform: 'win32' },
  ]
  for (const c of cases) {
    it(`matches the server: ${c.name}`, () => {
      expect(tokenFile(4242, c.env, c.platform, c.home)).toBe(accessTokenPath(4242, c.env, c.home, c.platform))
      expect(tokenFile(18180, c.env, c.platform, c.home)).toBe(accessTokenPath(18180, c.env, c.home, c.platform))
    })
  }

  it('lets FREMKIT_ACCESS_TOKEN_FILE name the file outright', () => {
    expect(tokenFile(4242, { FREMKIT_ACCESS_TOKEN_FILE: '/x/y.token' }, 'darwin', '/Users/sam')).toBe('/x/y.token')
  })
})

describe('portOf', () => {
  it('reads the port of a URL, or 4242', () => {
    expect(portOf('http://127.0.0.1:18180/api/hooks/claude')).toBe(18180)
    expect(portOf('http://127.0.0.1/api')).toBe(4242)
    expect(portOf('http://localhost:4301')).toBe(4301)
    expect(portOf('http://localhost:abc/x')).toBe(4242)
  })
})

describe('authHeader and authUrl', () => {
  let dir = ''
  let server: Server | undefined
  afterEach(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
  })

  it('sends the secret as a header, and nothing when there is no file', () => {
    dir = mkdtempSync(join(tmpdir(), 'fk-access-'))
    const env = { FREMKIT_SUPPORT_DIR: dir }
    expect(authHeader(18181, env)).toEqual({})
    writeFileSync(join(dir, 'access-18181.token'), 'secret-value\r\n')
    expect(authHeader(18181, env)).toEqual({ Authorization: 'Bearer secret-value' })
    writeFileSync(join(dir, 'access-18181.token'), '\n')
    expect(authHeader(18181, env)).toEqual({})
  })

  it('mints a one-time link, escaping the path, and returns null on a refusal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fk-access-'))
    const seen: (string | undefined)[] = []
    server = createServer((req, res) => {
      seen.push(req.headers.authorization)
      if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"code":"abc_123-X"}')
    })
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    process.env.FREMKIT_SUPPORT_DIR = dir
    try {
      expect(await authUrl(base, '/admin?a=1&b#x')).toBeNull()
      writeFileSync(join(dir, `access-${port}.token`), 'tok\n')
      expect(await authUrl(base, '/admin?a=1&b#x', 'http://localhost:5173/')).toBe('http://localhost:5173/auth?code=abc_123-X&next=%2Fadmin%3Fa%3D1%26b%23x')
      expect(seen).toEqual([undefined, 'Bearer tok'])
      // Another machine never gets the secret, even with a token file for its port.
      writeFileSync(join(dir, 'access-4242.token'), 'tok\n')
      expect(await authUrl('http://192.0.2.10:4242', '/')).toBeNull()
      expect(await authUrl('http://127.0.0.1.example.com:4242', '/')).toBeNull()
      expect(seen).toHaveLength(2)
    } finally {
      delete process.env.FREMKIT_SUPPORT_DIR
    }
  })
})
