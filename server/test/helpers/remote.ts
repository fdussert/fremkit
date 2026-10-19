import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_OPENSSL, ensureKey, issueCertificate } from '../../src/devices/certificate.js'
import { FileSecretStore } from '../../src/secrets/file.js'

export const hasOpenssl = spawnSync(DEFAULT_OPENSSL, ['version']).status === 0

/** A key and certificate made the way the app makes them (Task 3), for a listener in a test. */
export async function tlsMaterial(): Promise<{ key: string; cert: string }> {
  const secrets = new FileSecretStore(join(await mkdtemp(join(tmpdir(), 'fremkit-remote-tls-')), 'secrets.json'))
  const key = await ensureKey(secrets)
  const cert = await issueCertificate(key, { host: 'example.local', addresses: ['127.0.0.1'] })
  return { key, cert }
}

export interface RemoteResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

export interface RemoteRequest {
  method?: string
  path: string
  /** The `Host` header; defaults to `127.0.0.1:<port>`. */
  host?: string
  headers?: Record<string, string>
  body?: string
}

/** One HTTPS request to the remote listener on `port`, over a fresh connection. */
export function remote(port: number, req: RemoteRequest): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1',
      port,
      method: req.method ?? 'GET',
      path: req.path,
      headers: { host: req.host ?? `127.0.0.1:${port}`, ...req.headers },
      rejectUnauthorized: false,
      agent: false,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('error', reject)
    })
    r.on('error', reject)
    if (req.body !== undefined) r.end(req.body)
    else r.end()
  })
}

/**
 * A WebSocket handshake on `path` (`/ws` by default). Resolves with the upgraded socket on 101, or with the status
 * and body of the answer that refused it.
 */
export function upgrade(
  port: number,
  headers: Record<string, string>,
  host = `127.0.0.1:${port}`,
  path = '/ws',
): Promise<{ status: 101; socket: Socket; head: Buffer } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
      rejectUnauthorized: false,
      agent: false,
    })
    r.on('upgrade', (_res, socket, head) => resolve({ status: 101, socket, head }))
    r.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    r.on('error', reject)
    r.end()
  })
}

/**
 * A minimal WebSocket client over a socket `upgrade` handed back: enough to send a text message
 * and read the server's text messages as JSON, without a client library the server does not
 * depend on. Client frames are masked, as the protocol requires; server frames are not.
 */
export class TinyWs {
  private buffer: Buffer
  private readonly messages: unknown[] = []
  private waiters: (() => void)[] = []

  constructor(private readonly socket: Socket, head: Buffer) {
    this.buffer = Buffer.from(head)
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.parse()
    })
    this.parse()
  }

  send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    const mask = Buffer.from([1, 2, 3, 4])
    const len = payload.length
    const header = len < 126
      ? Buffer.from([0x81, 0x80 | len])
      : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff])
    const masked = Buffer.alloc(len)
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  /** The first message received (or already received) that `match` accepts. */
  async next(match: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.messages.findIndex(match)
      if (i >= 0) return this.messages.splice(i, 1)[0]
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('no matching WebSocket message')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => { clearTimeout(timer); resolve() })
      })
    }
  }

  close(): void {
    this.socket.destroy()
  }

  private parse(): void {
    for (;;) {
      if (this.buffer.length < 2) return
      const opcode = this.buffer[0] & 0x0f
      let len = this.buffer[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.buffer.length < 4) return
        len = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buffer.length < 10) return
        len = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.buffer.length < offset + len) return
      const payload = this.buffer.subarray(offset, offset + len)
      this.buffer = this.buffer.subarray(offset + len)
      if (opcode === 0x1) {
        try { this.messages.push(JSON.parse(payload.toString('utf8'))) } catch { /* not ours */ }
        const waiters = this.waiters
        this.waiters = []
        for (const w of waiters) w()
      }
    }
  }
}
