import { describe, expect, it, vi } from 'vitest'
import { createAdvertiser, type AdvertiserChild } from '../src/devices/bonjour.js'
import { ciaoHostName, loadCiaoResponder } from '../src/devices/advertise-ciao.js'

function fakeChild(): AdvertiserChild & { kill: ReturnType<typeof vi.fn> } {
  const child = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => {
      child.signalCode = 'SIGTERM'
      return true
    }),
    on: vi.fn(),
  }
  return child
}

function setup(processes = '') {
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const kill = vi.fn()
  const exitHooks = new Set<() => void>()
  const onExit = vi.fn((cb: () => void) => {
    exitHooks.add(cb)
    return () => {
      exitHooks.delete(cb)
    }
  })
  const listProcesses = vi.fn(() => processes)
  const advertise = createAdvertiser({ platform: 'darwin', spawn, kill, onExit, listProcesses })
  return { child, spawn, kill, exitHooks, listProcesses, advertise }
}

describe('the Bonjour advertiser', () => {
  it('runs dns-sd with an argument list and kills it on stop', () => {
    const { child, spawn, exitHooks, advertise } = setup()
    const ad = advertise(4243)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/dns-sd', ['-R', 'Fremkit', '_fremkit._tcp', 'local', '4243'])
    expect(exitHooks.size).toBe(1)
    ad.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
    // The exit hook goes with it, and a second stop does not signal a dead child again.
    expect(exitHooks.size).toBe(0)
    ad.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('carries the address in the TXT record when it has one', () => {
    const { spawn, advertise } = setup()
    advertise(4243, 'Example Mac', '192.0.2.10')
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/dns-sd', ['-R', 'Example Mac', '_fremkit._tcp', 'local', '4243', 'a=192.0.2.10', 'p=4243'])
    advertise(4243, 'Example Mac', 'fe80::1%en0')
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/dns-sd', ['-R', 'Example Mac', '_fremkit._tcp', 'local', '4243', 'a=fe80::1%en0', 'p=4243'])
    advertise(4243, 'Example Mac', null)
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/dns-sd', ['-R', 'Example Mac', '_fremkit._tcp', 'local', '4243'])
    // Never anything that is not an address, even though dns-sd gets an argument list.
    advertise(4243, 'Example Mac', 'x b=1')
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/dns-sd', ['-R', 'Example Mac', '_fremkit._tcp', 'local', '4243'])
  })

  it('kills the child synchronously when the process exits', () => {
    const { child, exitHooks, advertise } = setup()
    advertise(4243)
    for (const hook of exitHooks) hook()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills a stale dns-sd for the same port whatever its name, and nothing else', () => {
    const { kill, spawn, listProcesses, advertise } = setup([
      '101 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
      '102 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4300',
      '103 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 extra',
      '104 /bin/sh -c /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
      '105 /usr/bin/dns-sd -R Other _fremkit._tcp local 4243',
      '106 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 a=192.0.2.10 p=4243',
      '107 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4300 a=192.0.2.10 p=4300',
      '108 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 a=fe80::1%en0 p=4243',
      '109 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 a=192.0.2.10 p=4300',
      '',
    ].join('\n'))
    advertise(4243)
    expect(listProcesses).toHaveBeenCalled()
    expect(kill.mock.calls).toEqual([[101], [105], [106], [108]])
    // Cleaned before the new one is started.
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0])
  })

  it('does nothing off macOS', () => {
    const spawn = vi.fn()
    const listProcesses = vi.fn(() => '')
    const ad = createAdvertiser({ platform: 'linux', spawn, listProcesses })(4243)
    ad.stop()
    expect(spawn).not.toHaveBeenCalled()
    expect(listProcesses).not.toHaveBeenCalled()
  })
})

describe('the mDNS advertiser on Windows', () => {
  const v4 = (address: string, internal = false) => ({
    address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal, cidr: null,
  })
  const IFACES = {
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'Wi-Fi': [v4('192.0.2.10')],
    // Link-local: never reachable from the LAN, never announced on.
    'Ethernet 3': [v4('169.254.1.2')],
  }

  /** A fake ciao: every event in `log`, in order, so overlaps show. */
  function ciaoSetup(initial: Record<string, ReturnType<typeof v4>[]> = IFACES) {
    const state = { ifaces: initial }
    const log: string[] = []
    const services: { advertise: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; updateTxt: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[] = []
    const responder = {
      createService: vi.fn((options: { name: string; txt?: Record<string, string> }) => {
        const n = services.length
        const service = {
          advertise: vi.fn(async () => { log.push(`advertise ${n} ${options.txt?.a ?? '-'}`) }),
          // Goodbye packets take a while: a new advertisement that does not wait shows up first.
          destroy: vi.fn(async () => { for (let i = 0; i < 3; i++) await settle(); log.push(`destroy ${n}`) }),
          updateTxt: vi.fn((txt: Record<string, string>) => { log.push(`txt ${n} ${txt.a ?? '-'}`) }),
          on: vi.fn(),
        }
        services.push(service)
        return service
      }),
      shutdown: vi.fn(async () => { log.push('shutdown') }),
    }
    const getResponder = vi.fn(async () => responder)
    const spawn = vi.fn()
    const listProcesses = vi.fn(() => '')
    const advertise = createAdvertiser({ platform: 'win32', spawn, listProcesses, ciao: { getResponder, interfaces: () => state.ifaces } })
    return { state, log, services, responder, getResponder, spawn, listProcesses, advertise }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const drain = async () => { for (let i = 0; i < 20; i++) await settle() }

  it('announces _fremkit._tcp with the TXT address and port, and withdraws it on stop', async () => {
    const { services, responder, getResponder, spawn, listProcesses, advertise } = ciaoSetup()
    const ad = advertise(4243, 'EXAMPLE-PC', '192.0.2.10', { hostName: 'EXAMPLE-PC' })
    await drain()
    // Told its interfaces by name, so ciao never looks for them through a shell.
    expect(getResponder).toHaveBeenCalledWith({ interface: ['Wi-Fi'] })
    expect(responder.createService).toHaveBeenCalledWith({
      name: 'EXAMPLE-PC', type: 'fremkit', port: 4243, hostname: 'EXAMPLE-PC-fremkit', txt: { a: '192.0.2.10', p: '4243' },
    })
    expect(services[0].advertise).toHaveBeenCalledTimes(1)
    // Ciao's own rename on a conflict is heard, so it does not log that nobody listened.
    expect(services[0].on).toHaveBeenCalledWith('name-change', expect.any(Function))
    ad.stop()
    await drain()
    expect(services[0].destroy).toHaveBeenCalledTimes(1)
    expect(responder.shutdown).toHaveBeenCalledTimes(1)
    ad.stop()
    await drain()
    expect(responder.shutdown).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('points the service at a name of its own, never the host name Windows answers for', async () => {
    expect(ciaoHostName('EXAMPLE-PC')).toBe('EXAMPLE-PC-fremkit')
    expect(ciaoHostName('x'.repeat(63))).toBe(`${'x'.repeat(55)}-fremkit`)
    expect(ciaoHostName(null)).toBe('fremkit')
    const { responder, advertise } = ciaoSetup()
    advertise(4243, 'Fremkit', null)
    await drain()
    expect(responder.createService).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'fremkit' }))
  })

  it('leaves a malformed address out of the TXT record, as with dns-sd', async () => {
    const { responder, advertise } = ciaoSetup()
    advertise(4243, 'EXAMPLE-PC', 'x b=1')
    advertise(4243, 'EXAMPLE-PC', null)
    await drain()
    for (const [options] of responder.createService.mock.calls as unknown as [Record<string, unknown>][]) {
      expect(options).not.toHaveProperty('txt')
    }
    expect(responder.createService).toHaveBeenCalledTimes(2)
  })

  it('announces a new advertisement only once the stopped one is withdrawn', async () => {
    const { log, advertise } = ciaoSetup()
    const first = advertise(4243, 'EXAMPLE-PC', '192.0.2.10')
    await drain()
    // The service.ts order on a restart: stop, then advertise at once, without waiting.
    first.stop()
    advertise(4243, 'EXAMPLE-PC', '198.51.100.7')
    await drain()
    expect(log).toEqual(['advertise 0 192.0.2.10', 'destroy 0', 'shutdown', 'advertise 1 198.51.100.7'])
  })

  it('changes the TXT address in place, and starts over only when the interfaces changed', async () => {
    const { state, log, advertise } = ciaoSetup()
    const ad = advertise(4243, 'EXAMPLE-PC', '192.0.2.10')
    await drain()
    ad.update!('192.0.2.11')
    await drain()
    expect(log).toEqual(['advertise 0 192.0.2.10', 'txt 0 192.0.2.11'])
    state.ifaces = { ...IFACES, Ethernet: [v4('198.51.100.7')] }
    ad.update!('198.51.100.7')
    await drain()
    expect(log.slice(2)).toEqual(['destroy 0', 'shutdown', 'advertise 1 198.51.100.7'])
    ad.stop()
    ad.update!('192.0.2.12')
    await drain()
    expect(log.slice(5)).toEqual(['destroy 1', 'shutdown'])
  })

  it('announces nothing with no LAN interface, and nothing after an early stop', async () => {
    const none = ciaoSetup({ 'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)] })
    none.advertise(4243)
    await drain()
    expect(none.getResponder).not.toHaveBeenCalled()

    const early = ciaoSetup()
    early.advertise(4243).stop()
    await drain()
    expect(early.responder.createService).not.toHaveBeenCalled()
  })

  it('reports the first failure once, as a code, and costs only discovery', async () => {
    const warn = vi.fn()
    const { services, advertise } = ciaoSetup()
    const ad = advertise(4243, 'EXAMPLE-PC', '192.0.2.10', { warn })
    await drain()
    services[0].updateTxt.mockImplementation(() => { throw new Error('Cannot update destroyed service!') })
    ad.update!('192.0.2.11')
    await drain()
    expect(warn.mock.calls).toEqual([['update-failed']])

    const bind = ciaoSetup()
    const bindWarn = vi.fn()
    bind.responder.createService.mockImplementationOnce(() => ({
      advertise: vi.fn(async () => { throw Object.assign(new Error('bind 0.0.0.0:5353 failed'), { code: 'EADDRINUSE' }) }),
      destroy: vi.fn(async () => undefined), updateTxt: vi.fn(), on: vi.fn(),
    }))
    const failed = bind.advertise(4243, 'EXAMPLE-PC', '192.0.2.10', { warn: bindWarn })
    await drain()
    expect(bindWarn.mock.calls).toEqual([['EADDRINUSE']])
    failed.stop()
    await drain()
    expect(bind.responder.shutdown).toHaveBeenCalledTimes(1)

    const load = ciaoSetup()
    load.getResponder.mockRejectedValueOnce(new Error('Cannot find module C:\\Users\\someone\\x'))
    const loadWarn = vi.fn()
    load.advertise(4243, 'EXAMPLE-PC', null, { warn: loadWarn })
    await drain()
    expect(loadWarn.mock.calls).toEqual([['load-failed']])
  })

  it('is never used on the Mac', async () => {
    const getResponder = vi.fn()
    const spawn = vi.fn(() => fakeChild())
    createAdvertiser({ platform: 'darwin', spawn, listProcesses: () => '', onExit: () => () => undefined, ciao: { getResponder } })(4243).stop()
    await drain()
    expect(getResponder).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('loads ciao\'s responder module, without starting anything', async () => {
    const Responder = await loadCiaoResponder()
    expect(typeof Responder.getResponder).toBe('function')
  })
})
