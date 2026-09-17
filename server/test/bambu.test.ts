import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createBambuProvider, mapState, mergePrint, toSnapshot, type BambuSnapshot } from '../src/providers/bambu.js'
import type { MqttClientLike, MqttOptions } from '../src/providers/mqtt.js'
import { bambuType, isValidBambuHost } from '../src/connections/types/bambu.js'

const R = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/bambu-reports.json', import.meta.url)), 'utf8')) as Record<string, any>

/** A fake printer: records what the provider says and lets a test push reports back. */
function fakePrinter() {
  const opened: MqttOptions[] = []
  const subscribed: string[] = []
  const published: { topic: string; payload: string }[] = []
  let handlers: { connect: (() => void)[]; message: ((m: { topic: string; payload: string }) => void)[]; close: ((e?: Error) => void)[] }
  let ended = 0
  handlers = { connect: [], message: [], close: [] }
  const connect = (opts: MqttOptions): MqttClientLike => {
    opened.push(opts)
    handlers = { connect: [], message: [], close: [] }
    return {
      onConnect: (cb) => handlers.connect.push(cb),
      onMessage: (cb) => handlers.message.push(cb),
      onClose: (cb) => handlers.close.push(cb),
      subscribe: (topic) => { subscribed.push(topic) },
      publish: (topic, payload) => { published.push({ topic, payload }) },
      end: () => { ended++ },
    }
  }
  return {
    connect, opened, subscribed, published,
    get ended() { return ended },
    fireConnect: () => handlers.connect.forEach((cb) => cb()),
    send: (topic: string, body: unknown) => handlers.message.forEach((cb) => cb({ topic, payload: JSON.stringify(body) })),
    fireClose: (err?: Error) => handlers.close.forEach((cb) => cb(err)),
  }
}

const ctx = {
  id: 'bambu-a1b2',
  channel: 'bambu:bambu-a1b2',
  fields: { host: '192.0.2.10', serial: 'PLACEHOLDER-SERIAL', model: 'X1C' },
  secrets: { accessCode: '12345678' },
}

describe('mergePrint', () => {
  it('merges a delta into the kept state instead of replacing it', () => {
    const merged = mergePrint(R.pushall.print, R.progress.print)
    expect(merged.mc_percent).toBe(41)
    expect(merged.layer_num).toBe(62)
    expect(merged.total_layer_num).toBe(152)
    expect(merged.subtask_name).toBe('benchy-plate-1')
  })

  it('replaces an array wholesale rather than merging element by element', () => {
    const merged = mergePrint(R.pushall.print, R.amsChange.print) as any
    expect(merged.ams.ams[0].tray).toHaveLength(1)
    expect(merged.ams.ams[0].tray[0].tray_color).toBe('0A7CFFFF')
  })

  it('does not mutate the state it is given', () => {
    const state = JSON.parse(JSON.stringify(R.pushall.print))
    mergePrint(state, R.progress.print)
    expect(state.mc_percent).toBe(12)
  })
})

describe('mapState', () => {
  it('maps every gcode_state the printer sends', () => {
    expect(mapState('IDLE')).toBe('idle')
    expect(mapState('RUNNING')).toBe('running')
    expect(mapState('PREPARE')).toBe('running')
    expect(mapState('SLICING')).toBe('running')
    expect(mapState('PAUSE')).toBe('paused')
    expect(mapState('FINISH')).toBe('finished')
    expect(mapState('FAILED')).toBe('failed')
    expect(mapState(undefined)).toBe('unknown')
    expect(mapState('SOMETHING_NEW')).toBe('unknown')
  })
})

describe('toSnapshot', () => {
  const at = (print: Record<string, unknown>) => toSnapshot(print, { connected: true, model: 'X1C' })

  it('reads the job of a running print', () => {
    expect(at(R.pushall.print)).toEqual({
      connected: true, model: 'X1C', state: 'running', file: 'benchy-plate-1',
      percent: 12, remainingMin: 74, layer: 18, totalLayers: 152,
      nozzleTemp: 219.8, nozzleTarget: 220, bedTemp: 59.6, bedTarget: 60,
      speedLevel: 2, stage: 'Impression',
      ams: {
        units: [{ id: 0, trays: [
          { slot: 0, unit: 0, color: '#FF6A13', type: 'PLA', remain: 78 },
          { slot: 1, unit: 0, color: '#1C1C1C', type: 'PETG', remain: 40 },
          { slot: 2, unit: 0 },
          { slot: 3, unit: 0, color: '#FFFFFF', type: 'PLA', remain: 5 },
        ] }],
        trays: [
          { slot: 0, unit: 0, color: '#FF6A13', type: 'PLA', remain: 78 },
          { slot: 1, unit: 0, color: '#1C1C1C', type: 'PETG', remain: 40 },
          { slot: 2, unit: 0 },
          { slot: 3, unit: 0, color: '#FFFFFF', type: 'PLA', remain: 5 },
        ],
      },
    })
  })

  it('exposes every AMS, not just the first, and flattens them in printer order', () => {
    const ams = at(R.multiAms.print).ams
    expect(ams?.units.map((u) => ({ id: u.id, slots: u.trays.length, external: !!u.external }))).toEqual([
      { id: 0, slots: 4, external: false },
      { id: 1, slots: 4, external: false },
      { id: 2, slots: 1, external: false },
      { id: 3, slots: 1, external: false },
      { id: 254, slots: 1, external: true },
    ])
    // The flat list is the concatenation, so anything that only reads `trays` still sees them all.
    expect(ams?.trays).toHaveLength(11)
    expect(ams?.trays.map((t) => t.unit)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 3, 254])
  })

  it('carries each unit’s humidity and temperature', () => {
    const units = at(R.multiAms.print).ams?.units ?? []
    expect(units[0]).toMatchObject({ humidity: 2, temp: 28.5 })
    expect(units[2]).toMatchObject({ humidity: 1, temp: 55 })
    // The external spool has neither, and says so by leaving them out.
    expect(units[4].humidity).toBeUndefined()
  })

  it('marks the slot the printer is drawing from, counting four slots per unit', () => {
    // `tray_now` is 5: unit 1, slot 1.
    const active = (at(R.multiAms.print).ams?.trays ?? []).filter((t) => t.active)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ unit: 1, slot: 1 })
  })

  it('keeps a tray colour only when it is one', () => {
    const colorOf = (tray_color: string) => {
      const merged = mergePrint(R.multiAms.print, { ams: { vt_tray: { id: '254', tray_color, tray_type: 'PLA', remain: 50 } } })
      return toSnapshot(merged, { connected: true }).ams?.units.find((u) => u.external)?.trays[0].color
    }
    // Six hex digits, or eight with the alpha the printer appends and we drop.
    expect(colorOf('0A7CFF')).toBe('#0A7CFF')
    expect(colorOf('0A7CFFFF')).toBe('#0A7CFF')
    // Anything else would end up in a widget's style attribute as two declarations.
    for (const bad of ['red; background: url(https://evil.example/x)', 'zzzzzz', '0A7C', '0A7CFFF', '#0A7CFF']) {
      expect(colorOf(bad), bad).toBeUndefined()
    }
  })

  it('leaves the external spool out when nothing is on it', () => {
    const empty = mergePrint(R.multiAms.print, { ams: { vt_tray: { id: '254', tray_color: '', tray_type: '', remain: -1 } } })
    expect(toSnapshot(empty, { connected: true }).ams?.units.some((u) => u.external)).toBe(false)
  })

  it('exposes a paused print and its current stage', () => {
    const snapshot = at(mergePrint(R.pushall.print, R.paused.print))
    expect(snapshot.state).toBe('paused')
    expect(snapshot.stage).toBe('Changement de filament')
  })

  it('exposes a print error as a code and drops it when it clears', () => {
    expect(at(mergePrint(R.pushall.print, R.failed.print)).error).toBe('50348044')
    expect(at(mergePrint(R.pushall.print, R.finished.print)).error).toBeUndefined()
  })

  it('reports a finished print at 100 %', () => {
    const snapshot = at(mergePrint(R.pushall.print, R.finished.print))
    expect(snapshot).toMatchObject({ state: 'finished', percent: 100, remainingMin: 0, file: 'benchy-plate-1' })
  })

  it('says everything it does not know rather than inventing zeroes', () => {
    expect(toSnapshot({}, { connected: false })).toEqual({ connected: false, state: 'unknown' })
  })
})

describe('createBambuProvider', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('connects with the LAN-mode credentials on the first subscriber', async () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    expect(printer.opened[0]).toMatchObject({ host: '192.0.2.10', port: 8883, username: 'bblp', password: '12345678' })
    expect(printer.opened[0].clientId).toMatch(/^fremkit-[a-z0-9]{8}$/)
  })

  it('subscribes to the report topic and asks for a pushall once connected', () => {
    const printer = fakePrinter()
    createBambuProvider(ctx, { connect: printer.connect }).start!()
    printer.fireConnect()
    expect(printer.subscribed).toEqual(['device/PLACEHOLDER-SERIAL/report'])
    expect(printer.published).toEqual([{
      topic: 'device/PLACEHOLDER-SERIAL/request',
      payload: JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }),
    }])
  })

  it('publishes a snapshot built from the merged reports', async () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    printer.fireConnect()
    printer.send('device/PLACEHOLDER-SERIAL/report', R.pushall)
    printer.send('device/PLACEHOLDER-SERIAL/report', R.progress)
    const snapshot = (await provider.poll!()) as BambuSnapshot
    expect(snapshot).toMatchObject({ connected: true, state: 'running', percent: 41, layer: 62, totalLayers: 152, file: 'benchy-plate-1' })
  })

  it('publishes no timestamp, so an unchanged poll is byte-identical', async () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    printer.fireConnect()
    printer.send('device/PLACEHOLDER-SERIAL/report', R.pushall)
    const first = JSON.stringify(await provider.poll!())
    vi.advanceTimersByTime(5000)
    expect(JSON.stringify(await provider.poll!())).toBe(first)
  })

  it('ignores a message that carries no print report', async () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    printer.fireConnect()
    printer.send('device/PLACEHOLDER-SERIAL/report', R.pushall)
    printer.send('device/PLACEHOLDER-SERIAL/report', R.notPrint)
    printer.send('device/PLACEHOLDER-SERIAL/report', { print: 'not-an-object' })
    expect((await provider.poll!() as BambuSnapshot).state).toBe('running')
  })

  it('marks the snapshot disconnected and reconnects with a growing delay', async () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    printer.fireConnect()
    printer.send('device/PLACEHOLDER-SERIAL/report', R.pushall)
    printer.fireClose(new Error('ECONNRESET'))
    expect((await provider.poll!() as BambuSnapshot).connected).toBe(false)
    // The last known job survives the disconnection, so the widget can dim it instead of blanking.
    expect((await provider.poll!() as BambuSnapshot).file).toBe('benchy-plate-1')

    vi.advanceTimersByTime(1000)
    expect(printer.opened).toHaveLength(2)
    printer.fireClose()
    vi.advanceTimersByTime(1999)
    expect(printer.opened).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(printer.opened).toHaveLength(3)
  })

  it('resets the backoff after a successful connection', () => {
    const printer = fakePrinter()
    createBambuProvider(ctx, { connect: printer.connect }).start!()
    printer.fireClose()
    vi.advanceTimersByTime(1000)
    printer.fireClose()
    vi.advanceTimersByTime(2000)
    expect(printer.opened).toHaveLength(3)
    printer.fireConnect()
    printer.fireClose()
    vi.advanceTimersByTime(1000)
    expect(printer.opened).toHaveLength(4)
  })

  it('closes the client and cancels the retry when the last subscriber leaves', () => {
    const printer = fakePrinter()
    const provider = createBambuProvider(ctx, { connect: printer.connect })
    provider.start!()
    printer.fireClose()
    provider.stop!()
    vi.advanceTimersByTime(60_000)
    expect(printer.opened).toHaveLength(1)
    expect(printer.ended).toBe(1)
  })
})

describe('bambuType', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('declares host, serial, access code and model', () => {
    expect(bambuType.fields.map((f) => f.key)).toEqual(['host', 'serial', 'accessCode', 'model'])
    expect(bambuType.fields[2].secret).toBe(true)
    expect(bambuType.fields[3].options).toEqual(['H2C', 'H2D', 'H2S', 'X1C', 'X1E', 'P1S', 'P1P', 'A1', 'A1 mini', 'autre'])
  })

  it('accepts an IP, a hostname and a bracketed IPv6, and refuses anything else', () => {
    for (const host of ['192.0.2.10', 'printer.local', 'bambu-x1c', '[2001:db8::1]']) {
      expect(isValidBambuHost(host)).toBe(true)
    }
    for (const host of ['', 'mqtts://192.0.2.10', '192.0.2.10:8883', 'user@192.0.2.10', '192.0.2.10/x', 'a b']) {
      expect(isValidBambuHost(host)).toBe(false)
    }
  })

  it('refuses a malformed address before opening a socket', async () => {
    const printer = fakePrinter()
    await expect(bambuType.test({ ...ctx.fields, host: 'mqtts://192.0.2.10:8883' }, ctx.secrets, { connect: printer.connect }))
      .resolves.toEqual({ ok: false, error: 'adresse invalide : une IP ou un nom d’hôte est attendu' })
    expect(printer.opened).toHaveLength(0)
  })

  it('succeeds as soon as a print report arrives', async () => {
    const printer = fakePrinter()
    const promise = bambuType.test(ctx.fields, ctx.secrets, { connect: printer.connect })
    printer.fireConnect()
    printer.send('device/PLACEHOLDER-SERIAL/report', R.pushall)
    await expect(promise).resolves.toEqual({ ok: true, detail: 'Imprimante joignable (état : running)' })
    expect(printer.ended).toBe(1)
  })

  it('gives up after ten seconds of silence', async () => {
    const printer = fakePrinter()
    const promise = bambuType.test(ctx.fields, ctx.secrets, { connect: printer.connect })
    printer.fireConnect()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toEqual({ ok: false, error: 'aucune réponse de l’imprimante en 10 s' })
  })

  it('reports a refused connection without echoing the access code', async () => {
    const printer = fakePrinter()
    const promise = bambuType.test(ctx.fields, ctx.secrets, { connect: printer.connect })
    printer.fireClose(new Error('Connection refused: Not authorized 12345678'))
    const result = await promise
    expect(result).toEqual({ ok: false, error: 'connexion refusée par l’imprimante (code d’accès ou IP)' })
    expect(JSON.stringify(result)).not.toContain('12345678')
  })
})
