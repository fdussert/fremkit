/**
 * A process for shutdown.test.ts: listens on a port, installs the real shutdown, and once SIGTERM
 * has been handled holds its main thread for good, as a synchronous child process would. It prints
 * the port it holds, then `closed` when the listener stopped accepting.
 */
import { createServer } from 'node:net'
import { installShutdown } from '../../src/shutdown.js'

const server = createServer()
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(typeof address === 'object' && address ? address.port : 0)
})
installShutdown({
  // Never settles: only the watchdog can end this process.
  close: () => new Promise(() => undefined),
  closeListenersNow: () => {
    server.close()
    console.log('closed')
  },
})
process.on('SIGTERM', () => {
  process.nextTick(() => {
    for (;;) { /* held */ }
  })
})
