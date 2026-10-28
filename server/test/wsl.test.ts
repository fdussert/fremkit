import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanDistroNames, listDistros, type WslListHost } from '../src/wsl/distros.js'
import { wslRoutes } from '../src/wsl/routes.js'
import { buildApp } from '../src/app.js'
import { generateToken } from '../src/http/access.js'

/** What `wsl.exe --list --quiet` writes: UTF-16LE with a byte-order mark and CRLF line ends. */
const LIST_FIXTURE = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n\r\nbad name\r\n../x\r\n', 'utf16le'),
])

const hostAnswering = (value: unknown) => {
  const call = vi.fn(async () => value)
  return { host: { call } as unknown as WslListHost, call }
}

describe('listDistros', () => {
  it('keeps the valid names of the UTF-16LE list and drops the rest', () => {
    // What the PowerShell host hands back, one decoded line each, residue included.
    const lines = LIST_FIXTURE.toString('utf16le').split('\n').map((l) => `${l}\u0000`)
    expect(cleanDistroNames(lines)).toEqual(['Ubuntu-24.04', 'docker-desktop'])
    expect(cleanDistroNames(['Ubuntu', 'Ubuntu', 'x'.repeat(65)])).toEqual(['Ubuntu'])
    expect(cleanDistroNames('Ubuntu')).toEqual([])
  })

  it('asks the host on Windows', async () => {
    const { host, call } = hostAnswering(['﻿Ubuntu', 'Debian'])
    expect(await listDistros(host, 'win32')).toEqual(['Ubuntu', 'Debian'])
    expect(call).toHaveBeenCalledWith('wsl.list', undefined, expect.any(Number))
  })

  it('answers nothing, and asks nothing, off Windows', async () => {
    const { host, call } = hostAnswering(['Ubuntu'])
    expect(await listDistros(host, 'darwin')).toEqual([])
    expect(await listDistros(host, 'linux')).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('answers nothing when WSL is not there', async () => {
    const host = { call: vi.fn(async () => { throw new Error('no-wsl') }) } as unknown as WslListHost
    expect(await listDistros(host, 'win32')).toEqual([])
  })
})

describe('GET /api/wsl/distros', () => {
  it('answers the platform and the installed names', async () => {
    const app = Fastify()
    await app.register(wslRoutes, { platform: 'win32', list: async () => ['Ubuntu-24.04'] })
    const res = await app.inject({ url: '/api/wsl/distros' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ platform: 'win32', distros: ['Ubuntu-24.04'] })
    await app.close()
  })

  it('answers an empty list off Windows, behind the access secret like every route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-wsl-'))
    await mkdir(join(dir, 'widgets'))
    const token = generateToken()
    try {
      const app = await buildApp({ accessToken: token, port: 4301, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), platform: 'darwin' })
      try {
        const refused = await app.inject({ url: '/api/wsl/distros', headers: { host: '127.0.0.1:4301' } })
        expect(refused.statusCode).toBe(401)
        const res = await app.inject({ url: '/api/wsl/distros', headers: { host: '127.0.0.1:4301', authorization: `Bearer ${token}` } })
        expect(res.json()).toEqual({ platform: 'darwin', distros: [] })
      } finally { await app.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never lists in a demo, even on Windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-wsl-'))
    try {
      await mkdir(join(dir, 'widgets'))
      const list = vi.fn(async () => ['Ubuntu'])
      const app = await buildApp({ accessToken: null, demo: true, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), platform: 'win32', wsl: { list } })
      try {
        const res = await app.inject({ url: '/api/wsl/distros' })
        expect(res.json()).toEqual({ platform: 'win32', distros: [] })
        expect(list).not.toHaveBeenCalled()
      } finally { await app.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

afterEach(() => { vi.useRealTimers() })
