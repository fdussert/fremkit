import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import {
  createScriptHost, HOST_SCRIPT, IDLE_MS, REQUEST_TIMEOUT_MS, RESTART_BASE_MS, RESTART_MAX_MS, STABLE_MS,
  type HostProcess,
} from '../src/providers/osascript-host.js'
import { createVolumeProvider, parseVolume, VOLUME_SETTINGS } from '../src/providers/volume.js'
import { createSpotifyProvider } from '../src/providers/spotify.js'

type Answer = { ok: true; out: string } | { ok: false; error: string; number?: number | null }

/** A host process that never was one: it reads the requests and answers what the test says. */
class FakeHost extends EventEmitter implements HostProcess {
  readonly scripts: string[] = []
  readonly signals: string[] = []
  ended = false
  readonly stdout = new PassThrough()
  readonly stdin: Writable
  constructor(private readonly respond: (script: string) => Answer | null) {
    super()
    let buffered = ''
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        buffered += chunk.toString('utf8')
        let end: number
        while ((end = buffered.indexOf('\n')) >= 0) {
          const [id, encoded] = buffered.slice(0, end).split(' ')
          buffered = buffered.slice(end + 1)
          const script = Buffer.from(encoded, 'base64').toString('utf8')
          this.scripts.push(script)
          const answer = this.respond(script)
          if (answer) this.stdout.write(JSON.stringify({ id, ...answer }) + '\n')
        }
        done()
      },
      final: (done) => { this.ended = true; done() },
    })
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.signals.push(signal); return true }
}

/** A `spawn` that hands out fake hosts and remembers each one. */
function fakeSpawn(respond: (script: string) => Answer | null = (script) => ({ ok: true, out: `ran ${script}` })) {
  const hosts: FakeHost[] = []
  const start = (): HostProcess => { const host = new FakeHost(respond); hosts.push(host); return host }
  return { hosts, start }
}

describe('the osascript host', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /**
   * The bug this guards: one `osascript` per poll, three a second between Spotify and the volume,
   * used up macOS's LaunchServices registrations in under four days, after which no application
   * started until a reboot. However many scripts are asked, one process answers them.
   */
  it('answers every script from one process', async () => {
    const { hosts, start } = fakeSpawn()
    const host = createScriptHost({ spawn: start })
    for (let i = 0; i < 50; i++) expect(await host.run(`script ${i}`)).toBe(`ran script ${i}`)
    expect(hosts).toHaveLength(1)
    expect(hosts[0].scripts).toHaveLength(50)
  })

  it('starts no process until a script is asked', () => {
    const { hosts, start } = fakeSpawn()
    createScriptHost({ spawn: start })
    expect(hosts).toHaveLength(0)
  })

  it('carries a script of several lines and any text, and trims the answer as the one-shot runner did', async () => {
    const { hosts, start } = fakeSpawn(() => ({ ok: true, out: '  été \x1f ♫\n' }))
    const host = createScriptHost({ spawn: start })
    const script = 'tell application "Example"\n  return "é — ♫"\nend tell'
    expect(await host.run(script)).toBe('été \x1f ♫')
    expect(hosts[0].scripts).toEqual([script])
  })

  it('hands a script error to its caller and keeps the host', async () => {
    const { hosts, start } = fakeSpawn((script) => (script === 'bad' ? { ok: false, error: 'Not authorised to send Apple events', number: -1743 } : { ok: true, out: 'fine' }))
    const host = createScriptHost({ spawn: start })
    await expect(host.run('bad')).rejects.toThrow('Not authorised to send Apple events')
    expect(await host.run('good')).toBe('fine')
    expect(hosts).toHaveLength(1)
    expect(hosts[0].signals).toEqual([])
  })

  it('runs one script at a time, in the order asked', async () => {
    const { hosts, start } = fakeSpawn(() => null)
    const host = createScriptHost({ spawn: start })
    const first = host.run('first')
    const second = host.run('second')
    expect(hosts[0].scripts).toEqual(['first'])
    hosts[0].stdout.write('{"id":"1","ok":true,"out":"one"}\n')
    expect(await first).toBe('one')
    expect(hosts[0].scripts).toEqual(['first', 'second'])
    hosts[0].stdout.write('{"id":"2","ok":true,"out":"two"}\n')
    expect(await second).toBe('two')
  })

  it('gives up on a script that does not answer, ends the host and makes the next one wait', async () => {
    const { hosts, start } = fakeSpawn(() => null)
    const host = createScriptHost({ spawn: start })
    const hung = host.run('hangs')
    const refused = expect(hung).rejects.toThrow('osascript timeout')
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await refused
    expect(hosts[0].signals).toEqual(['SIGKILL'])
    // Inside the wait: refused at once, and above all no new process.
    await expect(host.run('too soon')).rejects.toThrow('osascript host restarting')
    expect(hosts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(RESTART_BASE_MS)
    void host.run('later').catch(() => {})
    expect(hosts).toHaveLength(2)
    host.stop()
  })

  it('fails the script in flight when the host dies, and does not die of the broken pipe', async () => {
    const { hosts, start } = fakeSpawn(() => null)
    const host = createScriptHost({ spawn: start })
    const lost = host.run('never answered')
    hosts[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    hosts[0].emit('exit', null, 'SIGSEGV')
    await expect(lost).rejects.toThrow('osascript host exited')
    await expect(host.run('at once')).rejects.toThrow('osascript host restarting')
    expect(hosts).toHaveLength(1)
  })

  /**
   * What keeps a host that dies on every start from becoming the same bug again: however often a
   * script is asked, a host that keeps dying is started once a minute at most.
   */
  it('doubles the wait while hosts keep dying, up to a minute, and starts again from the base after a good one', async () => {
    const { hosts, start } = fakeSpawn(() => null)
    const host = createScriptHost({ spawn: start })
    const die = async (): Promise<void> => {
      const lost = host.run('dies').catch(() => 'lost')
      hosts[hosts.length - 1].emit('exit', 1, null)
      await lost
    }
    await die()
    for (let loss = 1; loss <= 8; loss++) {
      const wait = Math.min(RESTART_BASE_MS * 2 ** (loss - 1), RESTART_MAX_MS)
      await vi.advanceTimersByTimeAsync(wait - 1)
      await expect(host.run('too soon')).rejects.toThrow('osascript host restarting')
      expect(hosts).toHaveLength(loss)
      await vi.advanceTimersByTimeAsync(1)
      await die()
      expect(hosts).toHaveLength(loss + 1)
    }

    // A host that answers for a minute and then dies is an accident, not a pattern.
    const good = fakeSpawn()
    const steady = createScriptHost({ spawn: good.start })
    await steady.run('fine')
    await vi.advanceTimersByTimeAsync(STABLE_MS)
    good.hosts[0].emit('exit', 1, null)
    await expect(steady.run('at once')).rejects.toThrow('osascript host restarting')
    await vi.advanceTimersByTimeAsync(RESTART_BASE_MS)
    expect(await steady.run('again')).toBe('ran again')
    expect(good.hosts).toHaveLength(2)
  })

  it('replaces a host whose connection to the application went stale, through the same wait', async () => {
    const { hosts, start } = fakeSpawn((script) => (script === 'stale' ? { ok: false, error: 'Connection is invalid.', number: -609 } : { ok: true, out: 'fresh' }))
    const host = createScriptHost({ spawn: start })
    await expect(host.run('stale')).rejects.toThrow('Connection is invalid.')
    expect(hosts[0].signals).toEqual(['SIGKILL'])
    await expect(host.run('at once')).rejects.toThrow('osascript host restarting')
    await vi.advanceTimersByTimeAsync(RESTART_BASE_MS)
    expect(await host.run('next')).toBe('fresh')
    expect(hosts).toHaveLength(2)
  })

  it('lets the host go when nothing has been asked for a while, and starts another without waiting', async () => {
    const { hosts, start } = fakeSpawn()
    const host = createScriptHost({ spawn: start })
    await host.run('one')
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(hosts[0].ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(hosts[0].ended).toBe(true)
    expect(hosts[0].signals).toEqual(['SIGTERM'])
    // The process the host let go reports its exit afterwards: that is not a host lost.
    hosts[0].emit('exit', 0, null)
    expect(await host.run('two')).toBe('ran two')
    expect(hosts).toHaveLength(2)
  })

  it('is not let go while scripts keep coming', async () => {
    const { hosts, start } = fakeSpawn()
    const host = createScriptHost({ spawn: start })
    for (let i = 0; i < 10; i++) {
      await host.run('tick')
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2)
    }
    expect(hosts).toHaveLength(1)
    expect(hosts[0].ended).toBe(false)
  })

  it('replaces the host after the number of scripts it was given, without a wait', async () => {
    const { hosts, start } = fakeSpawn()
    const host = createScriptHost({ spawn: start, recycleAfter: 3 })
    for (let i = 0; i < 7; i++) expect(await host.run(`s${i}`)).toBe(`ran s${i}`)
    expect(hosts.map((h) => h.scripts.length)).toEqual([3, 3, 1])
    expect(hosts[0].ended).toBe(true)
    expect(hosts[1].ended).toBe(true)
    expect(hosts[2].ended).toBe(false)
  })

  it('stops: the host ends, what was asked is refused, and a later script starts another', async () => {
    const { hosts, start } = fakeSpawn((script) => (script === 'slow' ? null : { ok: true, out: 'ok' }))
    const host = createScriptHost({ spawn: start })
    const inFlight = host.run('slow')
    const queued = host.run('behind it')
    host.stop()
    await expect(inFlight).rejects.toThrow('osascript host stopped')
    await expect(queued).rejects.toThrow('osascript host stopped')
    expect(hosts[0].ended).toBe(true)
    expect(await host.run('after')).toBe('ok')
    expect(hosts).toHaveLength(2)
  })

  it('refuses the script, and waits, when the host cannot be started', async () => {
    let attempts = 0
    const host = createScriptHost({ spawn: () => { attempts++; throw new Error('spawn EAGAIN') } })
    await expect(host.run('one')).rejects.toThrow('spawn EAGAIN')
    await expect(host.run('two')).rejects.toThrow('osascript host restarting')
    expect(attempts).toBe(1)
  })
})

describe('what the providers run where', () => {
  it('polls the volume through the poll runner and sends a tap through the command runner', async () => {
    const command = vi.fn(async () => '')
    const poll = vi.fn(async () => 'output volume:45, output muted:true')
    const provider = createVolumeProvider(command, poll)
    expect(await provider.poll!()).toEqual({ level: 45, muted: true })
    expect(poll).toHaveBeenCalledWith(VOLUME_SETTINGS)
    expect(command).not.toHaveBeenCalled()
    await provider.commands!.set({ level: 30 })
    expect(command).toHaveBeenCalledWith('set volume output volume 30')
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('polls Spotify through the poll runner and sends a tap through the command runner', async () => {
    const command = vi.fn(async () => '')
    const poll = vi.fn(async (script: string) => (script.includes('System Events') ? 'true' : 'stopped'))
    const provider = createSpotifyProvider(command, async () => {}, poll)
    expect(await provider.poll!()).toEqual({ available: true, state: 'stopped' })
    expect(poll).toHaveBeenCalledTimes(2)
    expect(command).not.toHaveBeenCalled()
    await provider.commands!.playPause(undefined)
    expect(command).toHaveBeenCalledWith('tell application "Spotify" to playpause')
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('reads an output that has no volume of its own as silent and not muted', () => {
    expect(parseVolume('output volume:missing value, output muted:missing value')).toEqual({ level: 0, muted: false })
  })
})

/**
 * The host script itself, in the real `osascript`: JXA is where this went wrong while it was
 * written (a length that is a string, an error reference that crashed), and no fake shows that.
 * Only scripts that stay inside the process: nothing here sends an Apple event to an application.
 */
describe.skipIf(process.platform !== 'darwin')('the host script in the real osascript', () => {
  const real = () => {
    const started: ReturnType<typeof spawn>[] = []
    const host = createScriptHost({
      spawn: () => {
        const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HOST_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] })
        started.push(child)
        return child
      },
    })
    return { host, started }
  }

  it('answers numbers, booleans and text as osascript prints them, many times, from one process', async () => {
    const { host, started } = real()
    try {
      expect(await host.run('return 1 + 1')).toBe('2')
      expect(await host.run('return (1 = 1)')).toBe('true')
      expect(await host.run('return "é — ♫" & (ASCII character 31) & "x"')).toBe('é — ♫\x1fx')
      expect(await host.run('if false then return 1')).toBe('')
      for (let i = 0; i < 200; i++) expect(await host.run(`return ${i} * 2`)).toBe(String(i * 2))
      expect(started).toHaveLength(1)
    } finally {
      host.stop()
    }
  }, 30_000)

  it('answers an error, a script that does not compile and a record as errors, and goes on', async () => {
    const { host, started } = real()
    try {
      await expect(host.run('error "boom" number 42')).rejects.toThrow('boom')
      await expect(host.run('this is not AppleScript ((')).rejects.toThrow()
      await expect(host.run('return {a:1}')).rejects.toThrow('not text')
      expect(await host.run('return "still here"')).toBe('still here')
      expect(started).toHaveLength(1)
    } finally {
      host.stop()
    }
  }, 30_000)

  it('reads the volume settings in the layout parseVolume expects', async () => {
    const { host } = real()
    try {
      const raw = await host.run(VOLUME_SETTINGS)
      expect(raw).toMatch(/^output volume:(\d+|missing value), output muted:(true|false|missing value)$/)
    } finally {
      host.stop()
    }
  }, 30_000)

  /** With `length === 0` in the script this never ended: it spun at full CPU, orphaned. */
  it('leaves by itself when its input closes', async () => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HOST_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    const answered = new Promise<string>((resolve) => child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))
    child.stdin.write(`1 ${Buffer.from('return "ready"').toString('base64')}\n`)
    expect(JSON.parse(await answered)).toEqual({ id: '1', ok: true, out: 'ready' })
    child.stdin.end()
    expect(await exited).toBe(0)
  }, 30_000)
})
