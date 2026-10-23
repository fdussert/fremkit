import { networkInterfaces } from 'node:os'
import type { Advertisement, Advertiser } from './bonjour.js'
import { lanAddresses, localHostName, type InterfaceMap } from './host.js'

/**
 * Windows has no `dns-sd`: the pairing listener is announced by an mDNS responder in the server's
 * own process (`@homebridge/ciao`, pure JavaScript), loaded only here so the Mac never loads it.
 */

/** The part of a ciao service the advertiser uses. */
export interface CiaoServiceLike {
  advertise(): Promise<void>
  destroy(): Promise<void>
  on(event: 'name-change' | 'hostname-change', listener: (name: string) => void): unknown
}

/** The part of a ciao responder the advertiser uses. */
export interface CiaoResponderLike {
  createService(options: {
    name: string
    type: string
    port: number
    hostname?: string
    txt?: Record<string, string>
  }): CiaoServiceLike
  shutdown(): Promise<void>
}

export interface CiaoDeps {
  /** Ciao's `Responder.getResponder`; the default imports the package on first use. */
  getResponder?: (options: { interface: string[] }) => Promise<CiaoResponderLike>
  interfaces?: () => InterfaceMap
  /** The host name (`localHostName`) the SRV target is made from; ciao's default when null. */
  hostName?: () => Promise<string | null>
}

/** An IPv4 or IPv6 literal, possibly with a zone: all a TXT `a=` may carry (as `dnsSdArgs`). */
const TXT_ADDRESS = /^[0-9A-Fa-f.:]+(%[0-9A-Za-z]+)?$/

async function realGetResponder(options: { interface: string[] }): Promise<CiaoResponderLike> {
  // The responder module, not the package's index: that one installs source-map-support for the
  // whole process.
  const { Responder } = await import('@homebridge/ciao/lib/Responder.js')
  return Responder.getResponder(options) as unknown as CiaoResponderLike
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
 * (`PC (2)`). The device app connects to the address the target resolves to or to the TXT `a=`,
 * never by this name, so it need not be in the certificate.
 */
export function ciaoHostName(host: string): string {
  return `${host.slice(0, 63 - '-fremkit'.length)}-fremkit`
}

/**
 * Announces the remote listener as `_fremkit._tcp` with ciao, with the same TXT `a=`/`p=` rule as
 * `dns-sd` on the Mac. Discovery only: a failure to load ciao, bind 5353 or probe costs nothing
 * but discovery, since the QR code carries the address. `stop` withdraws the service (goodbye
 * packets) and lets the responder go; being in process, nothing outlives the server.
 */
export function createCiaoAdvertiser(deps: CiaoDeps = {}): Advertiser {
  const getResponder = deps.getResponder ?? realGetResponder
  const readInterfaces = deps.interfaces ?? networkInterfaces
  const hostName = deps.hostName ?? (() => localHostName())
  return (port, name = 'Fremkit', address = null): Advertisement => {
    let stopped = false
    let teardown: (() => void) | null = null
    void (async () => {
      const names = lanInterfaces(readInterfaces())
      if (names.length === 0) return
      const host = await hostName()
      if (stopped) return
      const responder = await getResponder({ interface: names })
      if (stopped) {
        await responder.shutdown()
        return
      }
      const service = responder.createService({
        name,
        type: 'fremkit',
        port,
        ...(host !== null ? { hostname: ciaoHostName(host) } : {}),
        // `p` repeats the SRV port: a device that cannot resolve the SRV target cannot read it there.
        ...(address !== null && TXT_ADDRESS.test(address) ? { txt: { a: address, p: String(port) } } : {}),
      })
      // A name taken by another machine is renamed by ciao (`Name (2)`), which is all there is to do.
      service.on('name-change', () => undefined)
      service.on('hostname-change', () => undefined)
      teardown = () => {
        void service.destroy().catch(() => undefined).then(() => responder.shutdown()).catch(() => undefined)
      }
      await service.advertise()
    })().catch(() => undefined)
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        teardown?.()
      },
    }
  }
}
