import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifyPort,
  createNetworkProvider,
  NETWORK_HISTORY,
  parseDefaultInterface,
  parseHardwarePorts,
  parseIfaddr,
  parseNetstatBytes,
  parseSsid,
  type NetworkSnapshot,
} from '../src/providers/network.js'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const NETSTAT = fixture('netstat-ib.txt')

const ROUTE = `   route to: default
destination: default
       mask: default
    gateway: 198.51.100.1
  interface: en7
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`

const PORTS = `Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:01

Hardware Port: Thunderbolt Ethernet Slot 1
Device: en7
Ethernet Address: aa:bb:cc:dd:ee:02

VLAN Configurations
===================
`

afterEach(() => vi.useRealTimers())

describe('network parsers', () => {
  it('reads the default route interface, and nothing when there is no route', () => {
    expect(parseDefaultInterface(ROUTE)).toBe('en7')
    expect(parseDefaultInterface('   route to: default\n')).toBeNull()
    expect(parseDefaultInterface('')).toBeNull()
  })

  it('reads the Link row of netstat -ib and ignores the per-address duplicates', () => {
    expect(parseNetstatBytes(NETSTAT, 'en7')).toEqual({ rx: 19835492235, tx: 23925105391 })
    expect(parseNetstatBytes(NETSTAT, 'en0')).toEqual({ rx: 912345678, tx: 512345678 })
    // lo0's Link row has an empty Address column: the counters are still the last seven fields.
    expect(parseNetstatBytes(NETSTAT, 'lo0')).toEqual({ rx: 15326273803, tx: 15326273803 })
    expect(parseNetstatBytes(NETSTAT, 'en99')).toBeNull()
  })

  it('maps devices to hardware ports and classifies them', () => {
    const ports = parseHardwarePorts(PORTS)
    expect(ports).toEqual({ en0: 'Wi-Fi', en7: 'Thunderbolt Ethernet Slot 1' })
    expect(classifyPort(ports.en0)).toBe('wifi')
    expect(classifyPort(ports.en7)).toBe('ethernet')
    expect(classifyPort(undefined)).toBe('other')
    expect(classifyPort('Thunderbolt Bridge')).toBe('other')
  })

  it('reads an SSID from either command and treats a redacted one as absent', () => {
    expect(parseSsid('  SSID : Example Network\n  BSSID : aa:bb\n')).toBe('Example Network')
    expect(parseSsid('     ssid_str : Example Network')).toBe('Example Network')
    expect(parseSsid('Current Wi-Fi Network: Example Network')).toBe('Example Network')
    expect(parseSsid('  SSID : <redacted>')).toBeUndefined()
    expect(parseSsid('You are not associated with an AirPort network.')).toBeUndefined()
  })

  it('accepts only an IPv4 literal as the address', () => {
    expect(parseIfaddr('198.51.100.7\n')).toBe('198.51.100.7')
    expect(parseIfaddr('')).toBeUndefined()
  })
})

/** Replays the commands the provider runs, so a poll can be driven without touching the Mac. */
function fakeExec(counters: { rx: number; tx: number }, extra: Record<string, string> = {}) {
  return vi.fn(async (file: string, args: string[]) => {
    if (file === 'route') return ROUTE
    if (file === 'netstat') {
      return NETSTAT.replace(
        /^en7\s+1500\s+<Link#18>.*$/m,
        `en7        1500  <Link#18>   aa:bb:cc:dd:ee:02  1 0 ${counters.rx} 1 0 ${counters.tx} 0`,
      )
    }
    if (file === 'networksetup' && args[0] === '-listallhardwareports') return PORTS
    if (file === 'ipconfig' && args[0] === 'getifaddr') return '198.51.100.7\n'
    return extra[file] ?? ''
  })
}

describe('network provider', () => {
  it('reports zero on the first poll and a rate on the next', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const exec = fakeExec({ rx: 1_000_000, tx: 500_000 })
    const provider = createNetworkProvider(exec)
    provider.start?.()

    const first = (await provider.poll!()) as NetworkSnapshot
    expect(first).toMatchObject({ iface: 'en7', kind: 'ethernet', ip: '198.51.100.7', downBps: 0, upBps: 0 })
    expect(first.ssid).toBeUndefined()
    expect(first.history).toEqual([[0, 0]])

    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    ;(exec as any).mockImplementation(fakeExec({ rx: 1_200_000, tx: 560_000 }))
    const second = (await provider.poll!()) as NetworkSnapshot
    expect(second.downBps).toBe(100_000)
    expect(second.upBps).toBe(30_000)
    expect(second.history).toEqual([[0, 0], [100_000, 30_000]])
  })

  it('drops a delta when the counters go backwards, and caps the history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const exec = fakeExec({ rx: 5_000_000, tx: 5_000_000 })
    const provider = createNetworkProvider(exec)
    provider.start?.()
    await provider.poll!()

    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    ;(exec as any).mockImplementation(fakeExec({ rx: 10, tx: 10 }))
    expect((await provider.poll!() as NetworkSnapshot).downBps).toBe(0)

    for (let i = 0; i < NETWORK_HISTORY + 10; i++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:0${4}Z`).getTime() + i * 2000)
      ;(exec as any).mockImplementation(fakeExec({ rx: 1000 + i * 2000, tx: 1000 + i * 2000 }))
      await provider.poll!()
    }
    expect(((await provider.poll!()) as NetworkSnapshot).history.length).toBe(NETWORK_HISTORY)
  })

  it('reads the SSID only on a wireless interface', async () => {
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === 'route') return ROUTE.replace('interface: en7', 'interface: en0')
      if (file === 'netstat') return NETSTAT
      if (file === 'networksetup' && args[0] === '-listallhardwareports') return PORTS
      if (file === 'ipconfig' && args[0] === 'getifaddr') return '198.51.100.7'
      if (file === 'ipconfig' && args[0] === 'getsummary') return '  SSID : Example Network'
      return ''
    })
    const snapshot = (await createNetworkProvider(exec).poll!()) as NetworkSnapshot
    expect(snapshot).toMatchObject({ iface: 'en0', kind: 'wifi', ssid: 'Example Network' })
  })

  it('survives a Mac with no default route', async () => {
    const exec = vi.fn(async () => '')
    const snapshot = (await createNetworkProvider(exec).poll!()) as NetworkSnapshot
    expect(snapshot).toEqual({ iface: null, kind: 'other', downBps: 0, upBps: 0, history: [] })
  })
})
