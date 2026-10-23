import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { HOST_ARGS, HostError, MAX_LINE, PowerShellHost, START_TIMEOUT_MS, encodeLine, type SpawnHost } from '../src/win/powershell-host.js'
import { shippedPaths } from '../src/paths.js'

/** A stand-in for the PowerShell child: what the host writes on stdin, and a way to answer. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  written: string[] = []
  private buffer = ''

  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk
      let at: number
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        this.written.push(this.buffer.slice(0, at))
        this.buffer = this.buffer.slice(at + 1)
      }
    })
  }

  /** The requests, i.e. every line after the bootstrap. */
  requests(): { id: number; op: string; arg?: unknown }[] {
    return this.written.slice(1).map((line) => JSON.parse(line))
  }

  ready(): void { this.stdout.write('{"ready":true}\n') }
  answer(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`) }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

function setup() {
  const children: FakeChild[] = []
  const calls: { file: string; args: string[] }[] = []
  const spawn: SpawnHost = (file, args) => {
    calls.push({ file, args: [...args] })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ReturnType<SpawnHost>
  }
  const host = new PowerShellHost({ spawn, script: 'Write-Output "fixture"', env: { SystemRoot: 'D:\\Win' } })
  return { host, children, calls }
}

/** Lets the stream plumbing (PassThrough, readline) deliver what was written. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => { vi.useRealTimers() })

describe('PowerShellHost', () => {
  it('waits for the script to say it is ready before sending a request', async () => {
    const { host, children } = setup()
    const pending = host.call('volume.get')
    await flush()
    expect(children).toHaveLength(1)
    expect(children[0].written).toHaveLength(1) // the bootstrap only
    children[0].ready()
    await flush()
    expect(children[0].requests()).toEqual([{ id: 1, op: 'volume.get' }])
    children[0].answer({ id: 1, ok: true, value: { level: 30, muted: false } })
    await expect(pending).resolves.toEqual({ level: 30, muted: false })
    host.close()
  })

  it('matches answers to requests by id when they arrive out of order', async () => {
    const { host, children } = setup()
    const first = host.call('battery')
    const second = host.call('clipboard.read')
    children[0].ready()
    await flush()
    children[0].answer({ id: 2, ok: true, value: 'second' })
    children[0].answer({ id: 1, ok: true, value: 'first' })
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(children).toHaveLength(1)
    host.close()
  })

  it('times out, kills the child, and spawns a new one for the next call', async () => {
    vi.useFakeTimers()
    const { host, children } = setup()
    const pending = host.call('battery', undefined, 1000)
    const outcome = pending.catch((error: unknown) => error)
    children[0].ready()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    const error = await outcome
    expect(error).toBeInstanceOf(HostError)
    expect((error as HostError).code).toBe('timeout')
    expect(children[0].killed).toBe(true)

    const next = host.call('volume.get')
    expect(children).toHaveLength(2)
    children[1].ready()
    await vi.advanceTimersByTimeAsync(0)
    children[1].answer({ id: 2, ok: true, value: { level: 1, muted: true } })
    await expect(next).resolves.toEqual({ level: 1, muted: true })
    host.close()
  })

  it('fails the other in-flight calls with host-exited when one times out', async () => {
    vi.useFakeTimers()
    const { host, children } = setup()
    const slow = host.call('battery', undefined, 1000).catch((error: HostError) => error.code)
    const other = host.call('volume.get', undefined, 5000).catch((error: HostError) => error.code)
    children[0].ready()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await slow).toBe('timeout')
    expect(await other).toBe('host-exited')
    host.close()
  })

  it('starts a call timer when the line is written, so a slow start is not a timeout', async () => {
    vi.useFakeTimers()
    const { host, children } = setup()
    const pending = host.call('volume.get', undefined, 1000)
    await vi.advanceTimersByTimeAsync(8000) // spawn plus Add-Type, far past the call's own budget
    expect(children[0].killed).toBe(false)
    expect(children[0].written).toHaveLength(1)
    children[0].ready()
    await vi.advanceTimersByTimeAsync(0)
    children[0].answer({ id: 1, ok: true, value: 5 })
    await expect(pending).resolves.toBe(5)
    expect(children).toHaveLength(1)
    host.close()
  })

  it('gives up on a start that never gets ready, once, without a kill loop', async () => {
    vi.useFakeTimers()
    const { host, children } = setup()
    const a = host.call('volume.get').catch((error: HostError) => error.code)
    const b = host.call('battery').catch((error: HostError) => error.code)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    expect(await a).toBe('host-start-timeout')
    expect(await b).toBe('host-start-timeout')
    expect(children[0].killed).toBe(true)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS * 3)
    expect(children).toHaveLength(1) // nothing respawns until someone calls again
    const next = host.call('volume.get')
    expect(children).toHaveLength(2)
    children[1].ready()
    await vi.advanceTimersByTimeAsync(0)
    children[1].answer({ id: 3, ok: true, value: 9 })
    await expect(next).resolves.toBe(9)
    host.close()
  })

  it('keeps a replaced child out of the new child\'s calls', async () => {
    vi.useFakeTimers()
    const { host, children } = setup()
    const first = host.call('battery', undefined, 1000).catch((error: HostError) => error.code)
    children[0].ready()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe('timeout')
    const next = host.call('volume.get')
    children[1].ready()
    await vi.advanceTimersByTimeAsync(0)
    // The old child answers late with the new call's id, then exits: neither touches the new call.
    children[0].answer({ id: 2, ok: true, value: 'stale' })
    children[0].emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    children[1].answer({ id: 2, ok: true, value: 'fresh' })
    await expect(next).resolves.toBe('fresh')
    host.close()
  })

  it('kills the child and fails its calls when an answer line grows past the cap', async () => {
    const { host, children } = setup()
    const pending = host.call('clipboard.read').catch((error: HostError) => error.code)
    children[0].ready()
    await flush()
    const chunk = 'x'.repeat(1024 * 1024)
    for (let written = 0; written <= MAX_LINE; written += chunk.length) children[0].stdout.write(chunk)
    await flush()
    expect(await pending).toBe('host-exited')
    expect(children[0].killed).toBe(true)
    host.close()
  })

  it('rejects an arg that cannot be encoded without touching the child', async () => {
    const { host, children } = setup()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(host.call('volume.set', cyclic)).rejects.toMatchObject({ code: 'invalid-arg' })
    await expect(host.call('volume.set', { level: 10n })).rejects.toMatchObject({ code: 'invalid-arg' })
    expect(children).toHaveLength(0)
    // and the host still works afterwards
    const next = host.call('volume.get')
    children[0].ready()
    await flush()
    expect(children[0].requests()).toEqual([{ id: 3, op: 'volume.get' }])
    children[0].answer({ id: 3, ok: true, value: 1 })
    await expect(next).resolves.toBe(1)
    host.close()
  })

  it('rejects every pending call with host-exited when the child exits', async () => {
    const { host, children } = setup()
    const a = host.call('battery').catch((error: HostError) => error.code)
    const b = host.call('wsl.list').catch((error: HostError) => error.code)
    children[0].ready()
    await flush()
    children[0].emit('exit', 1, null)
    expect(await a).toBe('host-exited')
    expect(await b).toBe('host-exited')
    // and the next call starts a fresh child
    void host.call('battery').catch(() => {})
    expect(children).toHaveLength(2)
    host.close()
  })

  it('rejects with host-exited when the child cannot be started', async () => {
    const { host, children } = setup()
    const pending = host.call('battery').catch((error: HostError) => error.code)
    children[0].emit('error', new Error('spawn ENOENT'))
    expect(await pending).toBe('host-exited')
    host.close()
  })

  it('passes a well-formed code through and turns anything else into error', async () => {
    const { host, children } = setup()
    const wellFormed = host.call('network.wifi').catch((error: HostError) => error.code)
    const path = host.call('dpapi.unprotect', 'AAAA').catch((error: HostError) => error.code)
    const missing = host.call('sound', 'ding').catch((error: HostError) => error.code)
    children[0].ready()
    await flush()
    children[0].answer({ id: 1, ok: false, code: 'no-wifi' })
    children[0].answer({ id: 2, ok: false, code: 'C:\\Users\\a' })
    children[0].answer({ id: 3, ok: false })
    expect(await wellFormed).toBe('no-wifi')
    expect(await path).toBe('error')
    expect(await missing).toBe('error')
    host.close()
  })

  it('never carries the child text in the error message', async () => {
    const { host, children } = setup()
    const pending = host.call<never>('dpapi.unprotect', 'c2VjcmV0').catch((error: unknown) => error as HostError)
    children[0].ready()
    await flush()
    children[0].answer({ id: 1, ok: false, code: 'Access denied for C:\\Users\\a' })
    const error = await pending
    expect(error.message).toBe('error')
    expect(JSON.stringify(error)).not.toContain('Users')
    host.close()
  })

  it('reassembles a line split across chunks and splits several in one chunk', async () => {
    const { host, children } = setup()
    const a = host.call('clipboard.read')
    const b = host.call('volume.get')
    children[0].ready()
    await flush()
    children[0].stdout.write('{"id":1,"ok":tr')
    children[0].stdout.write('ue,"value":"x"}\r\n{"id":2,')
    children[0].stdout.write('"ok":true,"value":2}\n')
    await expect(a).resolves.toBe('x')
    await expect(b).resolves.toBe(2)
    host.close()
  })

  it('ignores lines that are not answers', async () => {
    const { host, children } = setup()
    const pending = host.call('volume.get')
    children[0].stdout.write('PS C:\\> \n')
    children[0].ready()
    await flush()
    children[0].stdout.write('not json\n{"id":99,"ok":true,"value":1}\n')
    children[0].answer({ id: 1, ok: true, value: 7 })
    await expect(pending).resolves.toBe(7)
    host.close()
  })

  it('puts only the fixed flags on argv, and the script and data on stdin', async () => {
    const { host, children, calls } = setup()
    const secret = 'c2VjcmV0LXZhbHVl'
    const pending = host.call('dpapi.protect', secret)
    children[0].ready()
    await flush()
    expect(calls).toEqual([{
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    }])
    expect(HOST_ARGS).toEqual(calls[0].args)
    // The bootstrap carries the script, base64 encoded, on one line.
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(children[0].written[0])?.[1]
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe('Write-Output "fixture"')
    expect(children[0].requests()).toEqual([{ id: 1, op: 'dpapi.protect', arg: secret }])
    children[0].answer({ id: 1, ok: true, value: 'cHJvdGVjdGVk' })
    await pending
    host.close()
  })

  it('drains stderr without keeping it', async () => {
    const { host, children } = setup()
    const pending = host.call('volume.get')
    // More than a pipe buffer: a child that writes this much must not block on it.
    children[0].stderr.write('x'.repeat(256 * 1024))
    children[0].ready()
    await flush()
    expect(children[0].stderr.readableLength).toBe(0)
    children[0].answer({ id: 1, ok: true, value: 0 })
    await pending
    host.close()
  })

  it('rejects pending calls and kills the child on close', async () => {
    const { host, children } = setup()
    const pending = host.call('battery').catch((error: HostError) => error.code)
    host.close()
    expect(await pending).toBe('host-exited')
    expect(children[0].killed).toBe(true)
  })
})

describe('encodeLine', () => {
  it('writes ASCII only, so any console code page reads non-ASCII text back intact', () => {
    const line = encodeLine({ id: 1, op: 'clipboard.write', arg: { text: 'café — 日本 😀' } })
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true)
    expect(JSON.parse(line)).toEqual({ id: 1, op: 'clipboard.write', arg: { text: 'café — 日本 😀' } })
  })
})

describe('host.ps1', () => {
  const script = readFileSync(shippedPaths({}).winHostScript, 'utf8')

  it('ships beside the server', () => {
    expect(script).toContain("'unknown-op'")
  })

  it('handles every op the TypeScript side can send', () => {
    for (const op of ['clipboard.read', 'clipboard.write', 'clipboard.private', 'volume.get', 'volume.set', 'volume.mute',
      'battery', 'network.wifi', 'sound', 'dpapi.protect', 'dpapi.unprotect', 'wsl.list']) {
      expect(script).toContain(`'${op}'`)
    }
  })

  const code = script.split('\n').filter((line) => !/^\s*(#|\/\/)/.test(line)).join('\n')

  it('keeps the Bluetooth devices when the battery query fails, whatever it throws', () => {
    const power = /public static class Power \{([\s\S]*?)\n  \}\n/.exec(code)?.[1] ?? ''
    expect(power).toContain('Internal()')
    // Both WMI queries swallow any exception, not only a ManagementException.
    expect(power).not.toContain('ManagementException')
    expect(power.match(/catch \(Exception\) \{ \}/g)).toHaveLength(2)
    // The whole of Internal() sits inside the try, so a failing query ends in `return null`.
    const internal = power.slice(power.indexOf('Internal()'), power.indexOf('static bool? Charging()'))
    expect(internal.indexOf('try {')).toBeGreaterThan(-1)
    expect(internal.indexOf('try {')).toBeLessThan(internal.indexOf('ManagementObjectSearcher'))
    expect(internal.trimEnd().endsWith('return null;\n    }')).toBe(true)
  })

  it('answers dpapi-foreign only to an unprotect, for the HRESULTs of a blob that never opens here', () => {
    expect(code).toContain('!protect && IsForeign(e.HResult) ? "dpapi-foreign" : "dpapi-failed"')
    const list = /static readonly int\[\] Foreign = \{([^}]*)\}/.exec(code)?.[1] ?? ''
    expect([...list.matchAll(/0x([0-9A-F]{8})/g)].map((m) => m[1]).sort()).toEqual(['8007000D', '80070057', '80090005', '8009000B'])
  })

  it('runs system tools by absolute path', () => {
    // The only place a tool's name appears is its path under %SystemRoot%.
    const tools = [...code.matchAll(/\b(netsh|wsl)\.exe\b/gi)]
    expect(tools.length).toBeGreaterThan(0)
    for (const match of tools) {
      const start = code.lastIndexOf('\n', match.index) + 1
      const line = code.slice(start, code.indexOf('\n', match.index))
      expect(line).toMatch(/^\s*\$\w+ = Join-Path \$FkSystemRoot 'System32\\(netsh|wsl)\.exe'$/)
    }
    // ...and no bare name a call could resolve through PATH (variables like $netsh aside).
    expect(code).not.toMatch(/(?<![$\w\\])netsh(?![.\w])/i)
    expect(code).not.toMatch(/(?<![$\w\\-])wsl(?![.\w])/i)
    // Every tool runs through FkRunTool with one of those variables; nothing else starts a process.
    const runs = [...code.matchAll(/\bFkRunTool\s+(\S+)/g)].map((m) => m[1])
    expect(runs.sort()).toEqual(['$netsh', '$wsl'])
    expect(code.match(/Process\]::Start\(/g)).toHaveLength(1)
    expect(code).not.toMatch(/Start-Process|Invoke-Expression|\biex\b|cmd\.exe/i)
    expect(code).not.toMatch(/(^|[\s;(=])&\s*[$'"\w(]/m)
  })

  it('hands no request value or secret to a cmdlet', () => {
    // Module Logging records cmdlet parameter bindings: JSON, clipboard and paths go through .NET.
    for (const cmdlet of ['ConvertFrom-Json', 'ConvertTo-Json', 'Set-Clipboard', 'Get-Clipboard', 'Test-Path', 'Write-Output', 'Out-String',
      // a pipeline hands each object to these, device ids and names included
      'Get-PnpDevice', 'Get-CimInstance', 'Where-Object', 'Select-Object', 'ForEach-Object']) {
      expect(code).not.toContain(cmdlet)
    }
    for (const op of ['clipboard.read', 'clipboard.write', 'dpapi.protect', 'dpapi.unprotect']) {
      expect(code).toMatch(new RegExp(`'${op.replace('.', '\\.')}' \\{ \\$value = \\[Fremkit\\.\\w+\\]::`))
    }
  })
})
