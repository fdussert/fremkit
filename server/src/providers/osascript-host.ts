import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Runner } from './osascript.js'

/**
 * One `osascript` kept open to answer scripts again and again: what a poll runs.
 *
 * A poll must not start a process. Every `osascript` registers with LaunchServices when it starts,
 * and macOS numbers each registration from a counter that only grows (by 0x1001 a time). Started
 * three times a second by two providers, it passed 32 bits in under four days of uptime, and from
 * that second macOS started no new application until the Mac was rebooted (`loginwindow` logs
 * `Unable to get PID for context …: status -600` for each). The fault is macOS's; the launches
 * were ours. A host registers once, however many scripts it answers.
 *
 * The host is a JXA script that reads one request per line on its standard input, runs it through
 * `NSAppleScript` in its own process and writes one JSON answer per line. A script therefore
 * travels on a pipe, never on a command line. It leaves by itself when the input closes, so a
 * server that dies without a word (SIGKILL, a crash) leaves no host behind.
 *
 * What a script may return: text, a number or a boolean, which come back as `osascript -e` prints
 * them. A record or a list has no text form here and is answered as an error rather than as an
 * empty string: build the text in the script (see `VOLUME_SETTINGS` in volume.ts).
 */

/**
 * The host, as source for `osascript -l JavaScript -e`.
 *
 * Two things here are not what they look like. In JXA an Objective-C property read comes back as
 * a JavaScript *string* (`data.length` is `"0"`), so the end of input is tested through
 * `Number()`: with `=== 0` the loop spun at full CPU for ever once the server was gone. And an
 * error is taken through `$()`, the bridge's own out-parameter; `Ref()` crashed the process on
 * the first failing script.
 *
 * A compiled script is kept and run again: compiling a `tell application` block loads the
 * application's dictionary, which is most of the cost of a poll. One that failed is dropped, so
 * the next attempt starts from the source. The cache is emptied when it fills, which only a
 * caller sending ever-changing sources could bring about.
 */
export const HOST_SCRIPT = String.raw`ObjC.import('Foundation')
var input = $.NSFileHandle.fileHandleWithStandardInput
var output = $.NSFileHandle.fileHandleWithStandardOutput
var TYPE_NULL = 0x6e756c6c
var compiled = {}
var kept = 0
var pending = ''
function answer(o) {
  output.writeData($(JSON.stringify(o) + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}
function execute(line) {
  var space = line.indexOf(' ')
  var id = line.slice(0, space)
  var key = line.slice(space + 1)
  try {
    var script = compiled[key]
    if (!script) {
      var data = $.NSData.alloc.initWithBase64EncodedStringOptions(key, 0)
      var source = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
      script = $.NSAppleScript.alloc.initWithSource(source)
      if (kept >= 32) { compiled = {}; kept = 0 }
      compiled[key] = script
      kept++
    }
    var error = $()
    var result = script.executeAndReturnError(error)
    if (result.isNil()) {
      delete compiled[key]
      kept--
      var message = error.objectForKey('NSAppleScriptErrorMessage')
      var number = error.objectForKey('NSAppleScriptErrorNumber')
      answer({ id: id, ok: false, error: message.isNil() ? 'AppleScript error' : String(message.js), number: number.isNil() ? null : Number(number.js) })
      return
    }
    var text = result.stringValue
    if (!text.isNil()) answer({ id: id, ok: true, out: String(text.js) })
    else if (Number(result.descriptorType) === TYPE_NULL) answer({ id: id, ok: true, out: '' })
    else answer({ id: id, ok: false, error: 'the script returned a value that is not text', number: null })
  } catch (e) {
    answer({ id: id, ok: false, error: String(e), number: null })
  }
}
while (true) {
  var chunk = input.availableData
  if (Number(chunk.length) === 0) break
  pending += $.NSString.alloc.initWithDataEncoding(chunk, $.NSUTF8StringEncoding).js
  var end
  while ((end = pending.indexOf('\n')) >= 0) {
    var line = pending.slice(0, end)
    pending = pending.slice(end + 1)
    if (line) execute(line)
  }
}
`

/** The part of a child process the host needs: what a test replaces. */
export interface HostProcess {
  stdin: Writable
  stdout: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
}

export interface ScriptHostOptions {
  /** Starts the host process. Injectable so tests never start one. */
  spawn?: () => HostProcess
  /** How long one script may take before the host is given up on and replaced. */
  requestTimeoutMs?: number
  /** How long the host is kept with nothing to answer. */
  idleMs?: number
  /** How many scripts one host answers before it is replaced by a new one. */
  recycleAfter?: number
}

export interface ScriptHost {
  /** Runs a script in the host, starting the host first when there is none. */
  run: Runner
  /** Ends the host now. A later `run` starts another. */
  stop(): void
}

/** The same patience as the one-shot runner in osascript.ts. */
export const REQUEST_TIMEOUT_MS = 5000
/**
 * Longer than the registry's longest wait between two polls of a failing provider (60 s): a
 * shorter one would end and restart the host around every retry, which is a launch per retry.
 */
export const IDLE_MS = 120_000
/**
 * The host grows by about 0.4 kB per script answered (measured over 20 000 answers: nothing in a
 * JXA loop ever drains the autorelease pool, and draining it by hand crashes the bridge). 50 000
 * answers is about 20 MB and at least seven hours at two scripts a second: a few planned launches
 * a day, against the 260 000 a day this file replaces.
 */
export const RECYCLE_AFTER = 50_000
/** After a host is lost, the wait before the next one: doubled each time, up to a minute. */
export const RESTART_BASE_MS = 1000
export const RESTART_MAX_MS = 60_000
/** A host that lived this long was a good one: losing it starts the waits again from the base. */
export const STABLE_MS = 60_000

/**
 * AppleScript errors that mean the host's connection to the target application is stale: the
 * application quit or was relaunched under a host that had already talked to it (-609 connection
 * invalid, -600 not running). A new process has no such memory, which is what every poll used to
 * get, so the host is replaced, through the same wait as a host that died.
 */
const STALE_TARGET = new Set([-600, -609])

const live = new Set<HostProcess>()
let exitHooked = false

/**
 * By absolute path (see AGENTS.md). The server's own exit ends every host at once; one the exit
 * hook never reached (the server was killed outright) reads the end of its input and leaves.
 */
function spawnOsascript(): HostProcess {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HOST_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] })
  live.add(child)
  child.on('exit', () => { live.delete(child) })
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => { for (const host of live) host.kill('SIGKILL') })
  }
  return child
}

interface Request {
  script: string
  resolve: (out: string) => void
  reject: (err: Error) => void
}

export function createScriptHost(options: ScriptHostOptions = {}): ScriptHost {
  const start = options.spawn ?? spawnOsascript
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const idleMs = options.idleMs ?? IDLE_MS
  const recycleAfter = options.recycleAfter ?? RECYCLE_AFTER

  let child: HostProcess | null = null
  let startedAt = 0
  /** Scripts the current host has answered. */
  let answered = 0
  let buffered = ''
  /** Hosts lost in a row without one of them having lived `STABLE_MS`. */
  let losses = 0
  /** No host is started before this time. */
  let notBefore = 0
  let nextId = 1
  /** One script at a time: the host runs them in order anyway, and a timeout then names its script. */
  let current: (Request & { id: string; timer: NodeJS.Timeout }) | null = null
  const waiting: Request[] = []
  let idleTimer: NodeJS.Timeout | null = null

  const clearIdle = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

  /** Lets go of the current host without counting it as lost: idle, recycled, or stopped. */
  const retire = (): void => {
    clearIdle()
    const host = child
    if (!host) return
    child = null
    host.stdin.end()
    host.kill()
  }

  const failCurrent = (err: Error): void => {
    if (!current) return
    clearTimeout(current.timer)
    const { reject } = current
    current = null
    reject(err)
  }

  /** One more host lost: the next is not started before its turn. */
  const delay = (): void => {
    losses++
    notBefore = Date.now() + Math.min(RESTART_BASE_MS * 2 ** (losses - 1), RESTART_MAX_MS)
  }

  /** The host died, hung or went stale: forget it and make the next one wait. */
  const lose = (host: HostProcess, reason: string): void => {
    if (child !== host) return
    child = null
    clearIdle()
    host.kill('SIGKILL')
    if (Date.now() - startedAt >= STABLE_MS) losses = 0
    delay()
    failCurrent(new Error(reason))
    pump()
  }

  const onLine = (host: HostProcess, line: string): void => {
    if (child !== host || !current) return
    let message: { id?: unknown; ok?: unknown; out?: unknown; error?: unknown; number?: unknown }
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== current.id) return
    clearTimeout(current.timer)
    const { resolve, reject } = current
    current = null
    answered++
    if (message.ok === true) {
      resolve(String(message.out ?? '').trim())
    } else {
      reject(new Error(String(message.error ?? 'AppleScript error')))
      if (typeof message.number === 'number' && STALE_TARGET.has(message.number)) return lose(host, 'osascript host replaced')
    }
    if (answered >= recycleAfter) retire()
    pump()
  }

  const launch = (): HostProcess => {
    const host = start()
    child = host
    startedAt = Date.now()
    answered = 0
    buffered = ''
    host.stdout.setEncoding('utf8')
    host.stdout.on('data', (chunk: string) => {
      if (child !== host) return
      buffered += chunk
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        onLine(host, line)
      }
    })
    // A host that has gone answers a write with EPIPE, as an `error` event on the pipe: unheard,
    // that event would take the server down. The exit that caused it is handled below.
    host.stdin.on('error', () => {})
    host.stdout.on('error', () => {})
    host.on('exit', () => lose(host, 'osascript host exited'))
    host.on('error', () => lose(host, 'osascript host failed to start'))
    return host
  }

  function pump(): void {
    if (current) return
    const next = waiting.shift()
    if (!next) {
      // Not kept from exiting by this timer: a script that only ran one command is not held open.
      if (child && !idleTimer) { idleTimer = setTimeout(retire, idleMs); idleTimer.unref() }
      return
    }
    clearIdle()
    let host = child
    if (!host) {
      if (Date.now() < notBefore) {
        // Refused rather than queued: the caller is a poll, which comes back by itself, and a
        // queue would only hand it answers to questions asked a minute ago.
        next.reject(new Error('osascript host restarting'))
        return pump()
      }
      try {
        host = launch()
      } catch (err) {
        // A host that cannot be started waits its turn like one that died.
        delay()
        next.reject(err instanceof Error ? err : new Error(String(err)))
        return pump()
      }
    }
    const id = String(nextId++)
    const sent = host
    current = { ...next, id, timer: setTimeout(() => lose(sent, 'osascript timeout'), requestTimeoutMs) }
    host.stdin.write(`${id} ${Buffer.from(next.script, 'utf8').toString('base64')}\n`)
  }

  return {
    run: (script) => new Promise<string>((resolve, reject) => {
      waiting.push({ script, resolve, reject })
      pump()
    }),
    stop() {
      retire()
      const stopped = new Error('osascript host stopped')
      failCurrent(stopped)
      for (const request of waiting.splice(0)) request.reject(stopped)
    },
  }
}
