import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { closeAppListenersNow, installShutdown, SHUTDOWN_DEADLINE_MS, WATCHDOG_MS } from '../src/shutdown.js'
import { hasOpenssl } from './helpers/remote.js'

/** Whether a TCP connection to the port is refused. */
const refused = (port: number, host = '127.0.0.1') => new Promise<boolean>((resolve) => {
  const socket = createConnection({ port, host })
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(true))
})

function setup(close: () => Promise<unknown> = async () => undefined) {
  const order: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const handlers = new Map<string, (signal: NodeJS.Signals) => void>()
  const exit = vi.fn((code: number) => { order.push(`exit ${code}`) })
  const watchdog = vi.fn((ms: number) => { order.push(`watchdog ${ms}`) })
  installShutdown({
    close: () => { order.push('close'); return close() },
    closeListenersNow: () => { order.push('listeners') },
    exit,
    watchdog,
    setTimer: (fn, ms) => { timers.push({ fn, ms }) },
    onSignal: (signal, handler) => { handlers.set(signal, handler) },
    log: () => undefined,
  })
  return { order, timers, handlers, exit, watchdog }
}

describe('shutdown', () => {
  it('stops the listeners first, then arms the watchdog and the deadline, then closes the app', async () => {
    const t = setup()
    t.handlers.get('SIGTERM')!('SIGTERM')
    expect(t.order.slice(0, 3)).toEqual(['listeners', `watchdog ${WATCHDOG_MS}`, 'close'])
    expect(t.timers.map((x) => x.ms)).toEqual([SHUTDOWN_DEADLINE_MS])
    await new Promise((resolve) => setImmediate(resolve))
    expect(t.exit).toHaveBeenCalledWith(143)
  })

  it('exits at the deadline when the app never finishes closing, with 130 for SIGINT', () => {
    const t = setup(() => new Promise(() => undefined))
    t.handlers.get('SIGINT')!('SIGINT')
    expect(t.exit).not.toHaveBeenCalled()
    t.timers[0].fn()
    expect(t.exit).toHaveBeenCalledWith(130)
  })

  it('handles the first signal only', () => {
    const t = setup(() => new Promise(() => undefined))
    t.handlers.get('SIGTERM')!('SIGTERM')
    t.handlers.get('SIGINT')!('SIGINT')
    expect(t.order.filter((x) => x === 'listeners')).toHaveLength(1)
  })

  it('a process whose main thread is held after SIGTERM frees its port at once and dies by the watchdog', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'shutdown-blocked.ts')], {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const lines: string[] = []
    child.stdout.on('data', (chunk: Buffer) => { lines.push(...chunk.toString().split('\n').filter(Boolean)) })
    const seen = async (ok: () => boolean): Promise<void> => {
      while (!ok()) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await seen(() => lines.length > 0)
    const port = Number(lines[0])
    expect(port).toBeGreaterThan(0)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    const sentAt = Date.now()
    child.kill('SIGTERM')
    await seen(() => lines.includes('closed'))
    // Nothing answers on the port any more, though the process is still there.
    expect(await refused(port)).toBe(true)
    const { signal } = await exited
    expect(signal).toBe('SIGKILL')
    expect(Date.now() - sentAt).toBeLessThan(WATCHDOG_MS + 1_500)
  }, 15_000)

  it.skipIf(!hasOpenssl)('the server\'s own wiring stops the loopback port and the remote listener at once, and the app still closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fremkit-shutdown-'))
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify({
      version: CONFIG_VERSION, locale: 'en', secrets: { backend: 'file' }, connections: [], widgets: {},
      screens: [{ id: 'edge', name: 'edge', kind: 'edge', display: { cols: 30, rows: 20 }, pages: [{ id: 'home', name: 'Home', items: [] }] }],
    }))
    const exec: Exec = (cmd, args) => (cmd === '/usr/sbin/scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args))
    const app = await buildApp({
      accessToken: null, dataDir: dir, widgetsDir: join(__dirname, '..', '..', 'widgets'), providers: [], devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => ['192.0.2.10'] },
    })
    try {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const local = (app.server.address() as AddressInfo).port
      const status = (await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })).json()
      expect(status.listening).toBe(true)
      const remotePort = status.port as number
      expect(await refused(local)).toBe(false)
      expect(await refused(remotePort)).toBe(false)
      closeAppListenersNow(app)
      expect(await refused(local)).toBe(true)
      expect(await refused(remotePort)).toBe(true)
      // Fastify's close finds its server closed already, and finishes.
      await app.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
