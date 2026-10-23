import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { shippedPaths } from '../paths.js'
import { windowsTool } from '../platform/windows-tools.js'

/**
 * One long-lived Windows PowerShell child that answers the server's Windows system calls through
 * a closed list of operations (`host.ps1`, beside this file).
 *
 * Starting `powershell.exe` costs about a second, and compiling the Core Audio interop again on
 * every volume read would cost more, so the child is started once and kept. The protocol:
 *
 * - argv holds the fixed flags of `HOST_ARGS` and nothing else: no script path, no data. Any
 *   account on the machine can read every process's command line.
 * - stdin's first line is a bootstrap that decodes the script from base64 and runs it. Windows
 *   PowerShell 5.1 under `-Command -` runs stdin line by line, which breaks a multi-line script
 *   (functions, here-strings); a single line does not have that problem.
 * - The script prints `{"ready":true}` once it has compiled what it needs. Requests are held
 *   until then, so nothing is read by PowerShell's own line reader rather than the script's.
 * - Then one JSON line per request, `{"id":n,"op":"…","arg":…}`, and one per answer,
 *   `{"id":n,"ok":true,"value":…}` or `{"id":n,"ok":false,"code":"…"}`. Both directions are
 *   ASCII: anything else is written as a `\uXXXX` escape, so no console code page can mangle
 *   clipboard text or a distro name.
 * - stderr is drained and dropped, never logged: it may quote a value. A code that is not a
 *   short lowercase token becomes `error` for the same reason.
 * - A call's timer starts when its line is written; start-up (spawn plus the script's Add-Type)
 *   has its own budget, so a slow start never turns into a kill-and-respawn loop.
 * - An answer line longer than `MAX_LINE` kills the child: nothing it could say is that long.
 *
 * DPAPI values travel only on stdin and stdout, and never reach an error or a log line.
 */

/** The operations `host.ps1` answers; anything else answers `unknown-op`. */
export type HostOp =
  | 'clipboard.read' | 'clipboard.write' | 'clipboard.private'
  | 'volume.get' | 'volume.set' | 'volume.mute'
  | 'battery' | 'network.wifi' | 'network.default' | 'sound'
  | 'dpapi.protect' | 'dpapi.unprotect'
  | 'wsl.list'

/** The names `sound` plays, from `%SystemRoot%\Media\<name>.wav`. */
export const HOST_SOUNDS = ['chimes', 'chord', 'ding', 'notify', 'tada'] as const
export type HostSound = (typeof HOST_SOUNDS)[number]

export interface HostVolume { level: number; muted: boolean }
export interface HostInternalBattery { percent: number; charging: boolean; minutesLeft?: number }
export interface HostBluetoothBattery { name: string; percent: number }
export interface HostBattery { internal: HostInternalBattery | null; devices: HostBluetoothBattery[] }
export interface HostWifi { ssid: string | null; signal: number | null }
/** The adapter the IPv4 default route goes out of: its `os.networkInterfaces()` name and byte counters. */
export interface HostDefaultRoute { name: string; kind: 'wifi' | 'ethernet' | 'other'; ip4: string | null; rx: number; tx: number }

/**
 * Each op's argument and value, the same table as the top of `host.ps1`. Failure codes besides
 * the common ones (`invalid-arg`, `failed`, `unknown-op`, `bad-request`, and on this side
 * `timeout`, `host-start-timeout`, `host-exited`, `error`) are listed per op.
 */
export interface HostOpTypes {
  'clipboard.read': { arg: undefined; value: string } // '' when it holds no text; codes: busy, too-large (> 1 MiB chars), private (checked while the clipboard is open; no text returned)
  'clipboard.write': { arg: { text: string }; value: true } // text ≤ 1 MiB chars, '' empties it; codes: busy
  'clipboard.private': { arg: undefined; value: [] | ['private'] } // a clipboard held open elsewhere answers ['private']
  'volume.get': { arg: undefined; value: HostVolume } // codes: no-device
  'volume.set': { arg: { level: number }; value: true } // clamped to 0–100; codes: no-device
  'volume.mute': { arg: { muted: boolean }; value: true } // codes: no-device
  'battery': { arg: undefined; value: HostBattery }
  'network.wifi': { arg: undefined; value: HostWifi } // codes: no-wifi, location-denied, tool-timeout
  'network.default': { arg: undefined; value: HostDefaultRoute | null } // null: no default route
  'sound': { arg: HostSound; value: true } // codes: no-sound
  'dpapi.protect': { arg: string; value: string } // base64 in (≤ 90000 chars), base64 out; codes: dpapi-failed
  'dpapi.unprotect': { arg: string; value: string } // base64 in (≤ 90000 chars), base64 out; codes: dpapi-foreign (never opens here), dpapi-failed (may pass)
  'wsl.list': { arg: undefined; value: string[] } // codes: no-wsl, tool-timeout
}

export const HOST_ARGS: readonly string[] = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']

/** Longest answer line accepted: a 1 MiB-character clipboard, escaped, stays well under it. */
export const MAX_LINE = 8 * 1024 * 1024
/** Time the child gets to start and compile its interop before queued calls give up. */
export const START_TIMEOUT_MS = 20_000

const CODE = /^[a-z][a-z0-9-]{0,39}$/

export class HostError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'HostError'
  }
}

/** JSON on one ASCII line: every character outside printable ASCII becomes a `\uXXXX` escape. */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export type SpawnHost = (file: string, args: readonly string[]) => ChildProcess

const defaultSpawn: SpawnHost = (file, args) =>
  nodeSpawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

export interface PowerShellHostOptions {
  spawn?: SpawnHost
  /** The script's text; read from `shippedPaths().winHostScript` on first use otherwise. */
  script?: string
  env?: Record<string, string | undefined>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: HostError) => void
  /** Set once the line is written; a call waiting for start-up has none. */
  timer?: ReturnType<typeof setTimeout>
  /** The child the request went to: only its exit fails the request. */
  owner: Running
}

interface Queued { id: number; line: string; timeoutMs: number }

interface Running {
  child: ChildProcess
  ready: boolean
  queue: Queued[]
  startTimer?: ReturnType<typeof setTimeout>
}

export class PowerShellHost {
  private readonly spawnHost: SpawnHost
  private readonly env: Record<string, string | undefined>
  private script: string | undefined
  private running: Running | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 0

  constructor(opts: PowerShellHostOptions = {}) {
    this.spawnHost = opts.spawn ?? defaultSpawn
    this.env = opts.env ?? process.env
    this.script = opts.script
  }

  call<T>(op: HostOp, arg?: unknown, timeoutMs = 5000): Promise<T> {
    const id = ++this.nextId
    let line: string
    try {
      line = encodeLine(arg === undefined ? { id, op } : { id, op, arg })
    } catch {
      // A cycle or a BigInt: the caller's mistake, which must not reach the child or its state.
      return Promise.reject(new HostError('invalid-arg'))
    }
    return new Promise<T>((resolve, reject) => {
      let running: Running
      try {
        running = this.running ?? this.start()
      } catch {
        reject(new HostError('host-exited'))
        return
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, owner: running })
      const queued = { id, line, timeoutMs }
      if (running.ready) this.send(running, queued)
      else running.queue.push(queued)
    })
  }

  close(): void {
    if (this.running) this.stop(this.running)
  }

  private start(): Running {
    this.script ??= readFileSync(shippedPaths().winHostScript, 'utf8')
    const child = this.spawnHost(windowsTool('powershell', this.env), HOST_ARGS)
    const running: Running = { child, ready: false, queue: [] }
    this.running = running

    child.on('error', () => this.exited(running))
    child.on('exit', () => this.exited(running))
    child.stdin?.on('error', () => {}) // a closed pipe shows up as 'exit'
    child.stderr?.on('error', () => {})
    child.stderr?.resume() // drained, never kept or logged
    if (child.stdout) this.readLines(running, child.stdout)

    running.startTimer = setTimeout(() => {
      if (running.ready) return
      for (const queued of running.queue.splice(0)) this.settle(queued.id, new HostError('host-start-timeout'))
      this.stop(running)
    }, START_TIMEOUT_MS)

    const encoded = Buffer.from(this.script, 'utf8').toString('base64')
    this.write(running, `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))`)
    return running
  }

  /** Splits stdout into lines, and gives up on a child whose line grows past `MAX_LINE`. */
  private readLines(running: Running, stdout: NodeJS.ReadableStream): void {
    let buffer = ''
    stdout.setEncoding('utf8')
    stdout.on('error', () => {})
    stdout.on('data', (chunk: string) => {
      if (running !== this.running) return
      // Only the new chunk is searched: a long line arriving in many chunks stays linear.
      let from = 0
      let at: number
      while ((at = chunk.indexOf('\n', from)) >= 0) {
        const line = (buffer + chunk.slice(from, at)).replace(/\r$/, '')
        buffer = ''
        from = at + 1
        this.onLine(running, line)
        if (running !== this.running) return
      }
      buffer += chunk.slice(from)
      if (buffer.length > MAX_LINE) {
        buffer = ''
        this.stop(running)
      }
    })
  }

  private send(running: Running, queued: Queued): void {
    const pending = this.pending.get(queued.id)
    if (!pending) return
    pending.timer = setTimeout(() => {
      if (!this.pending.has(queued.id)) return
      this.settle(queued.id, new HostError('timeout'))
      // A child that let one call time out is stuck or gone: replace it.
      this.stop(running)
    }, queued.timeoutMs)
    this.write(running, queued.line)
  }

  private write(running: Running, line: string): void {
    running.child.stdin?.write(`${line}\n`)
  }

  private onLine(running: Running, line: string): void {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (typeof message !== 'object' || message === null) return
    const answer = message as { ready?: unknown; id?: unknown; ok?: unknown; value?: unknown; code?: unknown }
    if (answer.ready === true && !running.ready) {
      running.ready = true
      clearTimeout(running.startTimer)
      for (const queued of running.queue.splice(0)) this.send(running, queued)
      return
    }
    if (typeof answer.id !== 'number') return
    const pending = this.pending.get(answer.id)
    if (!pending || pending.owner !== running) return
    if (answer.ok === true) this.settle(answer.id, undefined, answer.value)
    else this.settle(answer.id, new HostError(typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : 'error'))
  }

  private settle(id: number, error: HostError | undefined, value?: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  private stop(running: Running): void {
    if (this.running === running) this.running = null
    clearTimeout(running.startTimer)
    try { running.child.stdin?.end() } catch { /* already closed */ }
    try { running.child.kill() } catch { /* already gone */ }
    this.rejectAll(running)
  }

  private exited(running: Running): void {
    if (this.running === running) this.running = null
    clearTimeout(running.startTimer)
    this.rejectAll(running)
  }

  private rejectAll(owner: Running): void {
    for (const [id, pending] of this.pending) {
      if (pending.owner === owner) this.settle(id, new HostError('host-exited'))
    }
  }
}

let shared: PowerShellHost | null = null

/** The one host of this process, started on first call and stopped when the process exits. */
export function sharedHost(): PowerShellHost {
  if (!shared) {
    const host = new PowerShellHost()
    shared = host
    process.once('exit', () => host.close())
  }
  return shared
}
