/**
 * How the server goes away on SIGTERM (the helper; SIGKILL three seconds later) or SIGINT (a
 * terminal).
 *
 * Node's default for both is to die on the spot, which skips every `onClose` hook — the remote
 * listener, and the `dns-sd` child advertising it, among them. So the app is closed first, with a
 * deadline under the helper's, and the process exits either way.
 *
 * The deadline cannot be a timer of the main thread alone. A server once outlived its SIGTERM by
 * three minutes, still listening on the remote port, so that the server the helper started next
 * found it taken: the loopback port had closed with the app, then something held the main thread
 * (a provider's synchronous child process — `systeminformation` runs `diskutil list` and `mount`
 * with `execSync` on every `fsSize` — is the kind of thing that can), and a timer on a thread that
 * does not run never fires. Hence, from the signal handler itself:
 *
 * 1. the remote listeners stop accepting at once (`closeRemoteListenersNow`), before anything
 *    else gets to run, so the port is free however long the rest takes;
 * 2. a watchdog on a worker thread, whose event loop the main thread's cannot hold, kills the
 *    process when the deadline passes and the main thread has not exited by then. SIGKILL skips
 *    the `exit` hooks; the next start reaps a `dns-sd` that left behind (`bonjour.ts`).
 *
 * Both run from the JavaScript signal handler, which is on the main thread. A signal that arrives
 * while the thread is already held waits for it like everything else: neither the ports nor the
 * watchdog move until it lets go. Under the helper, its SIGKILL three seconds after the SIGTERM is
 * the backstop for that case; a server started from a terminal has none, and stops when the
 * thread lets go.
 */

import { Worker } from 'node:worker_threads'
import type { FastifyInstance } from 'fastify'
import { closeRemoteListenersNow } from './devices/listener.js'

/** How long the app gets to close before the process exits anyway. */
export const SHUTDOWN_DEADLINE_MS = 2_000
/** When the watchdog kills a process whose main thread did not manage that exit. */
export const WATCHDOG_MS = 2_500

/** The watchdog's code: wait, then kill the process. Plain CommonJS, run with `eval`. */
const WATCHDOG_SOURCE = `
const { workerData } = require('node:worker_threads')
setTimeout(() => { try { process.kill(workerData.pid, 'SIGKILL') } catch {} }, workerData.ms)
`

export interface ShutdownDeps {
  /** Closes the app: the Fastify instance's `close`. */
  close: () => Promise<unknown>
  /** Stops the remote listeners from accepting, synchronously. */
  closeListenersNow: () => void
  exit?: (code: number) => void
  /** Starts the watchdog; returns nothing, it dies with the process. */
  watchdog?: (ms: number) => void
  setTimer?: (fn: () => void, ms: number) => void
  onSignal?: (signal: NodeJS.Signals, handler: (signal: NodeJS.Signals) => void) => void
  log?: (error: unknown) => void
}

/** The real watchdog: a worker thread that SIGKILLs this process after `ms`. */
export function startWatchdog(ms: number): void {
  try {
    const worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { pid: process.pid, ms } })
    // The worker must not keep a process that exits on its own alive.
    worker.unref()
    worker.on('error', () => undefined)
  } catch {
    // No worker threads here: the main thread's own deadline is all there is.
  }
}

/**
 * Stops the app's loopback server and every remote listener from accepting, synchronously: what
 * the server's handler passes as `closeListenersNow`. Fastify's own close then finds its server
 * closed already, which it allows (`ERR_SERVER_NOT_RUNNING` is ignored there).
 */
export function closeAppListenersNow(app: Pick<FastifyInstance, 'server'>): void {
  closeRemoteListenersNow()
  if (app.server.listening) app.server.close()
}

/** Installs the SIGTERM and SIGINT handlers. Returns the handler, for tests. */
export function installShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const watchdog = deps.watchdog ?? startWatchdog
  const setTimer = deps.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref() })
  const onSignal = deps.onSignal ?? ((signal, handler) => { process.on(signal, handler) })
  const log = deps.log ?? ((error: unknown) => console.error(error))
  let closing = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return
    closing = true
    const code = signal === 'SIGINT' ? 130 : 143
    try {
      deps.closeListenersNow()
    } catch (error) {
      log(error)
    }
    watchdog(WATCHDOG_MS)
    setTimer(() => exit(code), SHUTDOWN_DEADLINE_MS)
    deps.close()
      .catch((error: unknown) => log(error))
      .finally(() => exit(code))
  }
  onSignal('SIGTERM', shutdown)
  onSignal('SIGINT', shutdown)
  return shutdown
}
