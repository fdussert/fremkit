import { networkInterfaces } from 'node:os'
import type { Advertisement, Advertiser } from './bonjour.js'
import { lanAddresses, type InterfaceMap } from './host.js'
import { txtRecord } from './txt.js'

/**
 * Windows has no `dns-sd`: the pairing listener is announced by an mDNS responder in the server's
 * own process (`@homebridge/ciao`, pure JavaScript), loaded only here so the Mac never loads it.
 */

/** The part of a ciao service the advertiser uses. */
export interface CiaoServiceLike {
  advertise(): Promise<void>
  destroy(): Promise<void>
  updateTxt(txt: Record<string, string>): void
  on(event: 'name-change' | 'hostname-change', listener: (name: string) => void): unknown
}

/** The part of a ciao responder the advertiser uses. */
export interface CiaoResponderLike {
  createService(options: {
    name: string
    type: string
    port: number
    hostname: string
    txt?: Record<string, string>
  }): CiaoServiceLike
  shutdown(): Promise<void>
}

export interface CiaoDeps {
  /** Ciao's `Responder.getResponder`; the default imports the package on first use. */
  getResponder?: (options: { interface: string[] }) => Promise<CiaoResponderLike>
  interfaces?: () => InterfaceMap
}

/** Ciao's responder class, imported on first use; exported for a load-only test. */
export async function loadCiaoResponder(): Promise<typeof import('@homebridge/ciao/lib/Responder.js')['Responder']> {
  // The responder module, not the package's index: that one installs source-map-support for the
  // whole process.
  return (await import('@homebridge/ciao/lib/Responder.js')).Responder
}

async function realGetResponder(options: { interface: string[] }): Promise<CiaoResponderLike> {
  return (await loadCiaoResponder()).getResponder(options) as unknown as CiaoResponderLike
}

/**
 * The interfaces holding an address a device on the LAN may reach (`lanAddresses`). Ciao is told
 * them by name: left to find them itself on Windows, it runs `arp -a | findstr` through a shell.
 */
function lanInterfaces(ifaces: InterfaceMap): string[] {
  return Object.entries(ifaces)
    .filter(([name, list]) => lanAddresses({ [name]: list }).length > 0)
    .map(([name]) => name)
}

/**
 * The SRV target ciao publishes A records for. Never the host name itself: Windows answers mDNS for
 * `<host name>.local` on its own, ciao takes that answer for a conflict and renames the service
 * (`PC (2)`). `fremkit` when the host name is unknown. The device app connects to the address the
 * target resolves to or to the TXT `a=`, never by this name, so it need not be in the certificate.
 */
export function ciaoHostName(host: string | null): string {
  return host === null ? 'fremkit' : `${host.slice(0, 63 - '-fremkit'.length)}-fremkit`
}

/** What a failure is logged as: Node's error code when it has one (`EADDRINUSE`), else the stage. */
function failureCode(err: unknown, stage: string): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : stage
}

/**
 * Announces the remote listener as `_fremkit._tcp` with ciao, with the TXT record `dns-sd` gets on
 * the Mac (`txtRecord`). Discovery only: a failure to load ciao, bind 5353 or probe costs nothing
 * but discovery, since the QR code carries the address; the first one is reported through
 * `opts.warn` as a code, nothing else. `stop` withdraws the service (goodbye packets) and lets the
 * responder go.
 *
 * Advertisements made by one advertiser run one after the other: a new one starts only once the
 * previous one's withdrawal is done, so the network never sees both and ciao never takes the old
 * one for a conflict (`PC (2)`). `update` changes the TXT address in place, and starts over, in the
 * same order, only when the LAN interfaces themselves changed.
 */
export function createCiaoAdvertiser(deps: CiaoDeps = {}): Advertiser {
  const getResponder = deps.getResponder ?? realGetResponder
  const readInterfaces = deps.interfaces ?? networkInterfaces
  let queue: Promise<void> = Promise.resolve()
  /** Runs `step` after everything queued so far; a failing step never stops the queue. */
  const enqueue = (step: () => Promise<void>): void => {
    queue = queue.then(step).catch(() => undefined)
  }

  return (port, name = 'Fremkit', address = null, opts = {}): Advertisement => {
    let stopped = false
    let warned = false
    let txtAddress = address
    let current: { service: CiaoServiceLike; responder: CiaoResponderLike; interfaces: string } | null = null
    const warn = (code: string): void => {
      if (warned) return
      warned = true
      opts.warn?.(code)
    }

    const open = async (): Promise<void> => {
      const names = lanInterfaces(readInterfaces())
      if (stopped || names.length === 0) return
      let responder: CiaoResponderLike
      try {
        responder = await getResponder({ interface: names })
      } catch (err) {
        warn(failureCode(err, 'load-failed'))
        return
      }
      const txt = txtRecord(txtAddress, port)
      const service = responder.createService({
        name,
        type: 'fremkit',
        port,
        hostname: ciaoHostName(opts.hostName ?? null),
        ...(txt !== null ? { txt } : {}),
      })
      // A name taken by another machine is renamed by ciao (`Name (2)`), which is all there is to do.
      service.on('name-change', () => undefined)
      service.on('hostname-change', () => undefined)
      current = { service, responder, interfaces: names.join('\n') }
      try {
        await service.advertise()
      } catch (err) {
        warn(failureCode(err, 'advertise-failed'))
      }
    }

    const close = async (): Promise<void> => {
      if (current === null) return
      const { service, responder } = current
      current = null
      await service.destroy().catch(() => undefined)
      await responder.shutdown().catch(() => undefined)
    }

    enqueue(open)
    return {
      update: (next) => {
        txtAddress = next
        enqueue(async () => {
          if (stopped) return
          if (current !== null && current.interfaces === lanInterfaces(readInterfaces()).join('\n')) {
            try {
              current.service.updateTxt(txtRecord(next, port) ?? {})
            } catch (err) {
              warn(failureCode(err, 'update-failed'))
            }
            return
          }
          await close()
          await open()
        })
      },
      stop: () => {
        if (stopped) return
        stopped = true
        enqueue(close)
      },
    }
  }
}
