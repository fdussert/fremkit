import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
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
 *
 * DPAPI values travel only on stdin and stdout, and never reach an error or a log line.
 */

/** The operations `host.ps1` answers; anything else answers `unknown-op`. */
export type HostOp =
  | 'clipboard.read' | 'clipboard.write' | 'clipboard.private'
  | 'volume.get' | 'volume.set' | 'volume.mute'
  | 'battery' | 'network.wifi' | 'sound'
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

/**
 * Each op's argument and value, the same table as the top of `host.ps1`. Failure codes besides
 * the common ones (`invalid-arg`, `failed`, `unknown-op`, and on this side `timeout`,
 * `host-exited`, `error`) are listed per op.
 */
export interface HostOpTypes {
  'clipboard.read': { arg: undefined; value: string } // '' when it holds no text
  'clipboard.write': { arg: { text: string }; value: true } // text ≤ 1 MiB chars
  'clipboard.private': { arg: undefined; value: [] | ['private'] } // codes: busy
  'volume.get': { arg: undefined; value: HostVolume } // codes: no-device
  'volume.set': { arg: { level: number }; value: true } // level 0–100; codes: no-device
  'volume.mute': { arg: { muted: boolean }; value: true } // codes: no-device
  'battery': { arg: undefined; value: HostBattery }
  'network.wifi': { arg: undefined; value: HostWifi } // codes: no-wifi, location-denied
  'sound': { arg: HostSound; value: true } // codes: no-sound
  'dpapi.protect': { arg: string; value: string } // base64 in, base64 out (≤ 64 KiB); codes: dpapi-failed
  'dpapi.unprotect': { arg: string; value: string } // base64 in, base64 out; codes: dpapi-failed
  'wsl.list': { arg: undefined; value: string[] } // codes: no-wsl
}

export const HOST_ARGS: readonly string[] = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']

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
  timer: ReturnType<typeof setTimeout>
  /** The child the request went to: only its exit fails the request. */
  owner: Running
}

interface Running {
  child: ChildProcess
  ready: boolean
  queue: string[]
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
    return new Promise<T>((resolve, reject) => {
      let running: Running
      try {
        running = this.running ?? this.start()
      } catch {
        reject(new HostError('host-exited'))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.get(id)?.reject(new HostError('timeout'))
        this.pending.delete(id)
        // A child that let one call time out is stuck or gone: replace it.
        this.stop(running)
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, owner: running })
      const line = encodeLine(arg === undefined ? { id, op } : { id, op, arg })
      if (running.ready) this.write(running, line)
      else running.queue.push(line)
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
    if (child.stdout) {
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.onLine(running, line))
    }

    const encoded = Buffer.from(this.script, 'utf8').toString('base64')
    this.write(running, `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))`)
    return running
  }

  private write(running: Running, line: string): void {
    running.child.stdin?.write(`${line}\n`)
  }

  private onLine(running: Running, line: string): void {
    if (running !== this.running) return
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (typeof message !== 'object' || message === null) return
    const answer = message as { ready?: unknown; id?: unknown; ok?: unknown; value?: unknown; code?: unknown }
    if (answer.ready === true && !running.ready) {
      running.ready = true
      for (const queued of running.queue.splice(0)) this.write(running, queued)
      return
    }
    if (typeof answer.id !== 'number') return
    const pending = this.pending.get(answer.id)
    if (!pending) return
    this.pending.delete(answer.id)
    clearTimeout(pending.timer)
    if (answer.ok === true) pending.resolve(answer.value)
    else pending.reject(new HostError(typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : 'error'))
  }

  private stop(running: Running): void {
    if (this.running === running) this.running = null
    try { running.child.stdin?.end() } catch { /* already closed */ }
    try { running.child.kill() } catch { /* already gone */ }
    this.rejectAll(running)
  }

  private exited(running: Running): void {
    if (this.running === running) this.running = null
    this.rejectAll(running)
  }

  private rejectAll(owner: Running): void {
    for (const [id, pending] of this.pending) {
      if (pending.owner !== owner) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new HostError('host-exited'))
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
